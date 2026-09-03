import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { pool } from "../../../db";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  canonicalAvailabilityClaimBuildHandoffCommandSchema,
  canonicalAvailabilityClaimBuildHandoffResultSchema,
  canonicalAvailabilityClaimCommandSchema,
  canonicalAvailabilityClaimOperationExecutionCommandSchema,
  canonicalAvailabilityClaimOperationExecutionResultSchema,
  canonicalAvailabilityClaimPickCommandSchema,
  canonicalAvailabilityClaimPickResultSchema,
  canonicalAvailabilityClaimReleaseCommandSchema,
  canonicalAvailabilityClaimReplacementCommandSchema,
  canonicalAvailabilityClaimReplacementResultSchema,
  canonicalAvailabilityClaimResultSchema,
  canonicalAvailabilityClaimUnpickCommandSchema,
  type CanonicalAvailabilityClaimBuildHandoffCommand,
  type CanonicalAvailabilityClaimBuildHandoffResult,
  type CanonicalAvailabilityClaimCommand,
  type CanonicalAvailabilityClaimOperationExecutionCommand,
  type CanonicalAvailabilityClaimOperationExecutionResult,
  type CanonicalAvailabilityClaimPickCommand,
  type CanonicalAvailabilityClaimPickResult,
  type CanonicalAvailabilityClaimReleaseCommand,
  type CanonicalAvailabilityClaimReplacementCommand,
  type CanonicalAvailabilityClaimReplacementResult,
  type CanonicalAvailabilityClaimResult,
  type CanonicalAvailabilityClaimUnpickCommand,
} from "@shared/types/inventory-availability-claims";
import type { CanonicalClaimBuildMutationPort } from "../application/canonical-claim-build.port";
import type { InventoryAvailabilityClaimStore } from "../application/inventory-availability-claim.port";
import type {
  CanonicalClaimPickerObservationReviewMetadata,
  CanonicalClaimPickerObservationReviewPort,
} from "../application/canonical-claim-picker-observation-review.port";
import {
  claimPlanRequestSchema,
  claimPlanSchema,
  type ClaimPlanDto,
  type ClaimPlanRequestDto,
  type ClaimSupplySnapshotDto,
} from "@shared/types/inventory-availability-planner";
import type {
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimInventoryExecutionResource,
  CanonicalClaimInventoryPickResource,
  CanonicalClaimInventoryReleaseResource,
  CanonicalClaimInventoryUnpickResource,
} from "../application/canonical-claim-inventory.port";
import { planCanonicalClaim } from "../domain/inventory-availability-planner";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";

type ClientPool = Pick<Pool, "connect">;
type QueryResult = { rows: any[]; rowCount?: number | null };

const TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422;
const LEGACY_RESERVATION_LOCK_NAMESPACE = 918410;
const MAX_GRAPH_PRODUCTS = 1_000;
const MAX_SERIALIZATION_ATTEMPTS = 3;

type OrderLine = {
  orderItemId: number;
  targetVariantId: number;
  rootProductId: number;
  requestedQty: number;
};

type LockedOrder = {
  orderId: number;
  warehouseId: number | null;
  warehouseStatus: string;
  onHold: boolean;
  lines: OrderLine[];
};

type RuntimeAuthority = {
  activationRunId: bigint;
  revision: bigint;
};

type ClaimAuditCommand = {
  actor: string;
  reason: string;
};

type ClaimLifecycleDisposition = "release" | "cancel" | "supersede";

type PersistedClaim = {
  id: bigint;
  claimKey: string;
  orderId: number;
  revision: number;
  runtimeAuthorityRevision: bigint;
  planHash: string;
  plan: ClaimPlanDto;
};

function rows(result: QueryResult): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

function positiveBigInt(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed <= BigInt(0)) throw new Error("not positive");
    return parsed;
  } catch (cause) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a positive bigint`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function uniqueSorted(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (code === "40001" || code === "40P01" || code === "INVENTORY_LEVEL_CREATION_CONFLICT") return true;
  return code === "23505"
    && String((error as { constraint?: unknown })?.constraint ?? "")
      === "availability_claim_commands_idempotency_uq";
}

function resultFromClaim(orderId: number, claim: PersistedClaim, idempotentReplay: boolean): CanonicalAvailabilityClaimResult {
  return canonicalAvailabilityClaimResultSchema.parse({
    outcome: "claimed",
    claimId: claim.id.toString(),
    claimKey: claim.claimKey,
    orderId,
    revision: claim.revision,
    runtimeAuthorityRevision: claim.runtimeAuthorityRevision.toString(),
    plan: claim.plan,
    idempotentReplay,
  });
}

function replacementResult(
  supersededClaim: PersistedClaim,
  replacementClaim: PersistedClaim,
  released: { releasedResourceQty: bigint; releasedLotQty: bigint },
  idempotentReplay: boolean,
): CanonicalAvailabilityClaimReplacementResult {
  return canonicalAvailabilityClaimReplacementResultSchema.parse({
    outcome: "replaced",
    orderId: supersededClaim.orderId,
    supersededClaimId: supersededClaim.id.toString(),
    supersededClaimKey: supersededClaim.claimKey,
    supersededRevision: supersededClaim.revision,
    replacementClaim: {
      claimId: replacementClaim.id.toString(),
      claimKey: replacementClaim.claimKey,
      revision: replacementClaim.revision,
      runtimeAuthorityRevision: replacementClaim.runtimeAuthorityRevision.toString(),
      plan: replacementClaim.plan,
    },
    releasedResourceQty: released.releasedResourceQty.toString(),
    releasedLotQty: released.releasedLotQty.toString(),
    idempotentReplay,
  });
}

export class InventoryAvailabilityClaimRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityClaimRepositoryError";
  }
}

async function loadCommandReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<CanonicalAvailabilityClaimResult | null> {
  const row = rows(await client.query(
    `SELECT request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical claim idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

async function loadReplacementReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<CanonicalAvailabilityClaimReplacementResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== "replace" || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical claim replacement idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimReplacementResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

async function loadOperationExecutionReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
  expectedCommandType: "execute" | "execute_build",
): Promise<CanonicalAvailabilityClaimOperationExecutionResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== expectedCommandType || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical operation idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimOperationExecutionResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

async function loadBuildHandoffReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<CanonicalAvailabilityClaimBuildHandoffResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== "handoff_build" || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical build-handoff idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimBuildHandoffResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

async function loadPickReplay(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
  expectedCommandType: "pick" | "pick_observation" | "unpick",
): Promise<CanonicalAvailabilityClaimPickResult | null> {
  const row = rows(await client.query(
    `SELECT command_type, request_hash, result_payload
     FROM inventory.availability_claim_commands
     WHERE idempotency_key = $1
     FOR SHARE`,
    [idempotencyKey],
  ))[0];
  if (!row) return null;
  if (String(row.command_type) !== expectedCommandType || String(row.request_hash) !== requestHash) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "IDEMPOTENCY_KEY_REUSED",
      "The canonical fulfillment idempotency key was already used with a different request.",
      { idempotencyKey },
    );
  }
  const replay = canonicalAvailabilityClaimPickResultSchema.parse(row.result_payload);
  return { ...replay, idempotentReplay: true };
}

async function requireCanonicalAuthority(client: PoolClient): Promise<RuntimeAuthority> {
  const row = rows(await client.query(
    `SELECT authority, activation_run_id, revision
     FROM inventory.availability_runtime_authority
     WHERE singleton_key = true
     FOR SHARE`,
  ))[0];
  if (!row || row.authority !== "canonical" || row.activation_run_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CANONICAL_AUTHORITY_NOT_ACTIVE",
      "Canonical claims are unavailable until the atomic inventory authority cutover commits.",
      { authority: row?.authority ?? null },
    );
  }
  return {
    activationRunId: positiveBigInt(row.activation_run_id, "runtimeAuthority.activationRunId"),
    revision: positiveBigInt(row.revision, "runtimeAuthority.revision"),
  };
}

async function loadOrder(client: PoolClient, orderId: number, lock: boolean): Promise<LockedOrder> {
  const orderRow = rows(await client.query(
    `SELECT id AS order_id, warehouse_id, warehouse_status, on_hold
     FROM wms.orders
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [orderId],
  ))[0];
  if (!orderRow) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ORDER_NOT_FOUND",
      "The order requested for canonical claiming does not exist.",
      { orderId },
    );
  }
  const itemRows = rows(await client.query(
     `SELECT item.id AS order_item_id,
             item.sku,
             item.product_id AS stored_product_id,
             item.requires_shipping AS order_item_requires_shipping,
             variant.id AS target_variant_id,
             CASE
               WHEN item.status IN ('cancelled', 'completed', 'short') THEN 0
               ELSE GREATEST(COALESCE(item.quantity, 0) - COALESCE(item.picked_quantity, 0), 0)
             END AS requested_qty,
            variant.product_id AS root_product_id,
            variant.is_active,
            variant.requires_shipping,
            COALESCE(variant.track_inventory, true) AS track_inventory,
            variant.sales_eligibility
     FROM wms.order_items AS item
     LEFT JOIN catalog.product_variants AS variant
       ON variant.is_active = true
      AND upper(variant.sku) = upper(item.sku)
     WHERE item.order_id = $1
     ORDER BY item.id
     ${lock ? "FOR UPDATE OF item" : ""}`,
    [orderId],
  ));
  const lines: OrderLine[] = [];
  for (const row of itemRows) {
    const requestedQty = nonnegativeInteger(row.requested_qty, "orderItem.requestedQty");
    if (requestedQty === 0) continue;
    const orderItemId = positiveInteger(row.order_item_id, "orderItem.id");
    const itemRequiresShipping = nonnegativeInteger(
      row.order_item_requires_shipping,
      "orderItem.requiresShipping",
    );
    if (itemRequiresShipping !== 0 && itemRequiresShipping !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_ORDER_ITEM_FULFILLMENT_IDENTITY",
        "An open order item has an invalid requires-shipping value.",
        { orderId, orderItemId, requiresShipping: row.order_item_requires_shipping },
      );
    }
    if (itemRequiresShipping === 0) continue;
    if (row.target_variant_id == null || row.root_product_id == null) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "ORDER_ITEM_VARIANT_MISSING",
        "A physical open order item SKU does not resolve to one active catalog variant.",
        { orderId, orderItemId, sku: row.sku == null ? null : String(row.sku) },
      );
    }
    const targetVariantId = positiveInteger(row.target_variant_id, "orderItem.targetVariantId");
    const rootProductId = positiveInteger(row.root_product_id, "orderItem.rootProductId");
    if (row.stored_product_id != null) {
      const storedProductId = positiveInteger(row.stored_product_id, "orderItem.storedProductId");
      if (storedProductId !== targetVariantId && storedProductId !== rootProductId) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "ORDER_ITEM_VARIANT_IDENTITY_CONFLICT",
          "The stored order-item product identity conflicts with its active SKU mapping.",
          { orderId, orderItemId, storedProductId, targetVariantId, rootProductId, sku: String(row.sku) },
        );
      }
    }
    if (row.requires_shipping !== true || row.track_inventory !== true) continue;
    if (row.is_active !== true || row.sales_eligibility !== "sellable") {
      throw new InventoryAvailabilityClaimRepositoryError(
        "ORDER_ITEM_NOT_CLAIMABLE",
        "A tracked physical order item does not target an active customer-sellable variant.",
        {
          orderId,
          orderItemId,
          targetVariantId: row.target_variant_id,
          isActive: row.is_active,
          salesEligibility: row.sales_eligibility,
        },
      );
    }
    lines.push({
      orderItemId,
      targetVariantId,
      rootProductId,
      requestedQty,
    });
  }
  const onHold = nonnegativeInteger(orderRow.on_hold ?? 0, "order.onHold");
  if (onHold !== 0 && onHold !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_ORDER_HOLD_STATE",
      "The canonical claim order has an invalid hold state.",
      { orderId, onHold },
    );
  }
  return {
    orderId: positiveInteger(orderRow.order_id, "order.id"),
    warehouseId: orderRow.warehouse_id == null
      ? null
      : positiveInteger(orderRow.warehouse_id, "order.warehouseId"),
    warehouseStatus: String(orderRow.warehouse_status ?? ""),
    onHold: onHold === 1,
    lines,
  };
}

async function discoverActiveGraphProducts(client: PoolClient, rootProductIds: readonly number[]): Promise<number[]> {
  const graphRows = rows(await client.query(
    `WITH RECURSIVE graph(product_id) AS (
       SELECT unnest($1::integer[])
       UNION
       SELECT component.component_product_id
       FROM graph
       JOIN inventory.transformation_model_heads AS head ON head.product_id = graph.product_id
       JOIN inventory.transformation_model_versions AS model ON model.id = head.active_model_id
       JOIN inventory.transformation_recipe_bindings AS binding ON binding.model_id = model.id
       JOIN inventory.transformation_recipe_component_snapshots AS component
         ON component.transformation_recipe_binding_id = binding.id
        AND component.model_id = binding.model_id
     )
     SELECT product_id FROM graph ORDER BY product_id`,
    [uniqueSorted(rootProductIds)],
  ));
  const productIds = graphRows.map((row) => positiveInteger(row.product_id, "graph.productId"));
  if (productIds.length === 0 || productIds.length > MAX_GRAPH_PRODUCTS) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_TRANSFORMATION_GRAPH",
      "The active transformation graph is empty or exceeds the supported product bound.",
      { rootProductIds, productCount: productIds.length, limit: MAX_GRAPH_PRODUCTS },
    );
  }
  return productIds;
}

async function lockGraphProducts(client: PoolClient, productIds: readonly number[]): Promise<void> {
  for (const productId of productIds) {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [TRANSFORMATION_MODEL_LOCK_NAMESPACE, productId]);
  }
  for (const productId of productIds) {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [LEGACY_RESERVATION_LOCK_NAMESPACE, productId]);
  }
  await client.query(
    `SELECT product_id
     FROM inventory.transformation_model_heads
     WHERE product_id = ANY($1::integer[])
     ORDER BY product_id
     FOR SHARE`,
    [productIds],
  );
}

async function lockPlanningPolicyHeads(
  client: PoolClient,
  snapshot: ClaimSupplySnapshotDto,
): Promise<void> {
  const locationIds = uniqueSorted(snapshot.locations.map((location) => location.id));
  if (locationIds.length > 0) {
    await client.query(
      `SELECT warehouse_location_id
       FROM inventory.location_promise_policy_heads
       WHERE warehouse_location_id = ANY($1::integer[])
       ORDER BY warehouse_location_id
       FOR SHARE`,
      [locationIds],
    );
  }
  const variantIds = uniqueSorted(snapshot.variants.map((variant) => variant.id));
  await client.query(
    `SELECT scope_key
     FROM inventory.promise_safety_policy_heads
     WHERE scope_key = 'business'
        OR product_variant_id = ANY($1::integer[])
     ORDER BY scope_key
     FOR SHARE`,
    [variantIds],
  );
}

async function lockSnapshotResources(
  client: PoolClient,
  snapshot: ClaimSupplySnapshotDto,
): Promise<void> {
  const levelIds = uniqueSorted(snapshot.inventoryPositions.map((position) => position.inventoryLevelId));
  if (levelIds.length > 0) {
    await client.query(
      `SELECT id
       FROM inventory.inventory_levels
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, id
       FOR UPDATE`,
      [levelIds],
    );
  }
  const variantIds = uniqueSorted(snapshot.variants.map((variant) => variant.id));
  if (variantIds.length > 0) {
    await client.query(
      `SELECT id
       FROM inventory.inventory_lots
       WHERE product_variant_id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [variantIds],
    );
  }
}

async function loadActiveClaim(
  client: PoolClient,
  orderId: number,
  lock = true,
): Promise<PersistedClaim | null> {
  const row = rows(await client.query(
    `SELECT id, claim_key, order_id, revision, runtime_authority_revision, plan_hash, plan_payload
     FROM inventory.availability_claims
     WHERE order_id = $1 AND status = 'active'
     ${lock ? "FOR UPDATE" : ""}`,
    [orderId],
  ))[0];
  if (!row) return null;
  const plan = claimPlanSchema.parse(row.plan_payload);
  if (hash(plan) !== String(row.plan_hash)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_HASH_MISMATCH",
      "The active claim planner payload no longer matches its persisted hash.",
      { claimId: String(row.id) },
    );
  }
  return {
    id: positiveBigInt(row.id, "claim.id"),
    claimKey: String(row.claim_key),
    orderId: positiveInteger(row.order_id, "claim.orderId"),
    revision: positiveInteger(row.revision, "claim.revision"),
    runtimeAuthorityRevision: positiveBigInt(row.runtime_authority_revision, "claim.runtimeAuthorityRevision"),
    planHash: String(row.plan_hash),
    plan,
  };
}

async function loadActiveClaimById(
  client: PoolClient,
  claimId: bigint,
  lock = true,
): Promise<PersistedClaim | null> {
  const row = rows(await client.query(
    `SELECT id, claim_key, order_id, revision, runtime_authority_revision, plan_hash, plan_payload
     FROM inventory.availability_claims
     WHERE id = $1 AND status = 'active'
     ${lock ? "FOR UPDATE" : ""}`,
    [claimId.toString()],
  ))[0];
  if (!row) return null;
  const plan = claimPlanSchema.parse(row.plan_payload);
  if (hash(plan) !== String(row.plan_hash)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_HASH_MISMATCH",
      "The active claim planner payload no longer matches its persisted hash.",
      { claimId: String(row.id) },
    );
  }
  return {
    id: positiveBigInt(row.id, "claim.id"),
    claimKey: String(row.claim_key),
    orderId: positiveInteger(row.order_id, "claim.orderId"),
    revision: positiveInteger(row.revision, "claim.revision"),
    runtimeAuthorityRevision: positiveBigInt(row.runtime_authority_revision, "claim.runtimeAuthorityRevision"),
    planHash: String(row.plan_hash),
    plan,
  };
}

async function nextClaimRevision(client: PoolClient, orderId: number): Promise<number> {
  const row = rows(await client.query(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
     FROM inventory.availability_claims
     WHERE order_id = $1`,
    [orderId],
  ))[0];
  return positiveInteger(row?.revision, "claim.revision");
}

function buildPlanRequest(order: LockedOrder, revision: number): ClaimPlanRequestDto {
  return claimPlanRequestSchema.parse({
    requestKey: `order:${order.orderId}:availability:revision:${revision}`,
    scope: order.warehouseId == null
      ? { kind: "network" }
      : { kind: "warehouse", warehouseId: order.warehouseId },
    lines: order.lines.map((line) => ({
      lineKey: `order-item:${line.orderItemId}`,
      targetVariantId: line.targetVariantId,
      requestedQty: String(line.requestedQty),
    })),
  });
}

async function orderDemandMatchesClaim(
  client: PoolClient,
  order: LockedOrder,
  claim: PersistedClaim,
): Promise<boolean> {
  const currentScope = order.warehouseId == null
    ? { kind: "network" as const }
    : { kind: "warehouse" as const, warehouseId: order.warehouseId };
  if (canonicalJson(currentScope) !== canonicalJson(claim.plan.scope)) return false;

  const lineRows = rows(await client.query(
    `SELECT line_key, target_variant_id, requested_qty, planned_qty, shortfall_qty,
            released_target_qty, consumed_target_qty, picked_target_qty
     FROM inventory.availability_claim_lines
     WHERE claim_id = $1
     ORDER BY line_key
     FOR SHARE`,
    [claim.id.toString()],
  ));
  if (lineRows.length !== claim.plan.lines.length) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_DEMAND_LINEAGE_MISMATCH",
      "The active claim's relational line evidence no longer matches its hashed planner payload.",
      { claimId: claim.id.toString(), planLineCount: claim.plan.lines.length, persistedLineCount: lineRows.length },
    );
  }

  const planLineByKey = new Map(claim.plan.lines.map((line) => [line.lineKey, line] as const));
  const persisted = lineRows.flatMap((row) => {
    const lineKey = String(row.line_key);
    const planLine = planLineByKey.get(lineKey);
    const targetVariantId = positiveInteger(row.target_variant_id, "claimLine.targetVariantId");
    const requestedQty = positiveBigInt(row.requested_qty, "claimLine.requestedQty");
    const plannedQty = nonnegativeBigInt(row.planned_qty, "claimLine.plannedQty");
    const shortfallQty = nonnegativeBigInt(row.shortfall_qty, "claimLine.shortfallQty");
    const releasedTargetQty = nonnegativeBigInt(row.released_target_qty, "claimLine.releasedTargetQty");
    const consumedTargetQty = nonnegativeBigInt(row.consumed_target_qty, "claimLine.consumedTargetQty");
    const pickedTargetQty = nonnegativeBigInt(row.picked_target_qty, "claimLine.pickedTargetQty");
    if (!planLine
      || planLine.targetVariantId !== targetVariantId
      || BigInt(planLine.requestedQty) !== requestedQty
      || BigInt(planLine.plannedQty) !== plannedQty
      || BigInt(planLine.shortfallQty) !== shortfallQty
      || requestedQty !== plannedQty + shortfallQty
      || releasedTargetQty + consumedTargetQty + pickedTargetQty > plannedQty) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_DEMAND_LINEAGE_MISMATCH",
        "The active claim's relational line evidence no longer matches its hashed planner payload.",
        { claimId: claim.id.toString(), lineKey },
      );
    }
    const remainingQty = requestedQty - releasedTargetQty - consumedTargetQty - pickedTargetQty;
    return remainingQty === BigInt(0)
      ? []
      : [{ lineKey, targetVariantId, requestedQty: remainingQty.toString() }];
  });
  const current = order.lines.map((line) => ({
    lineKey: `order-item:${line.orderItemId}`,
    targetVariantId: line.targetVariantId,
    requestedQty: String(line.requestedQty),
  })).sort((left, right) => left.lineKey.localeCompare(right.lineKey));
  return canonicalJson(current) === canonicalJson(persisted);
}

function claimVariantIds(claim: PersistedClaim): number[] {
  return uniqueSorted([
    ...claim.plan.lines.map((line) => line.targetVariantId),
    ...claim.plan.resourceClaims.map((resource) => resource.sourceVariantId),
    ...claim.plan.operations.flatMap((operation) => [
      operation.destinationVariantId,
      ...operation.sourceVariantIds,
      ...operation.inputs.map((input) => input.sourceVariantId),
    ]),
  ]);
}

async function loadClaimProductIds(client: PoolClient, claim: PersistedClaim): Promise<number[]> {
  const variantIds = claimVariantIds(claim);
  if (variantIds.length === 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLAIM_VARIANT_EVIDENCE",
      "The active claim does not contain any variant identity evidence.",
      { claimId: claim.id.toString() },
    );
  }
  const variantRows = rows(await client.query(
    `SELECT id, product_id
     FROM catalog.product_variants
     WHERE id = ANY($1::integer[])
     ORDER BY id`,
    [variantIds],
  ));
  const resolvedVariantIds = variantRows.map((row) => positiveInteger(row.id, "claimVariant.id"));
  if (canonicalJson(resolvedVariantIds) !== canonicalJson(variantIds)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_VARIANT_EVIDENCE_MISSING",
      "One or more variants referenced by the active claim no longer exist.",
      { claimId: claim.id.toString(), variantIds, resolvedVariantIds },
    );
  }
  return uniqueSorted([
    ...claim.plan.modelEvidence.map((model) => model.productId),
    ...variantRows.map((row) => positiveInteger(row.product_id, "claimVariant.productId")),
  ]);
}

async function persistNoopCommand(
  client: PoolClient,
  command: CanonicalAvailabilityClaimCommand | CanonicalAvailabilityClaimReleaseCommand,
  commandType: "claim" | "release" | "cancel",
  requestHash: string,
  occurredAt: Date,
): Promise<CanonicalAvailabilityClaimResult> {
  const result = canonicalAvailabilityClaimResultSchema.parse({
    outcome: "no_claim_required",
    orderId: command.orderId,
    idempotentReplay: false,
  });
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES (NULL, $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      command.orderId,
      commandType,
      command.idempotencyKey,
      requestHash,
      hash(result),
      JSON.stringify(command),
      JSON.stringify(result),
      command.actor,
      command.reason,
      occurredAt,
    ],
  );
  return result;
}

async function insertClaimHeader(
  client: PoolClient,
  input: {
    order: LockedOrder;
    revision: number;
    authority: RuntimeAuthority;
    request: ClaimPlanRequestDto;
    plan: ClaimPlanDto;
    command: ClaimAuditCommand;
    supersedesClaimId?: bigint;
    occurredAt: Date;
  },
): Promise<bigint> {
  const inserted = rows(await client.query(
    `INSERT INTO inventory.availability_claims (
       claim_key, order_id, revision, supersedes_claim_id,
       status, plan_status, scope_kind, scope_warehouse_id,
       activation_run_id, runtime_authority_revision, request_hash, plan_hash,
       snapshot_fingerprint, request_payload, plan_payload, model_evidence,
       requested_by, reason, reserved_at
     ) VALUES (
       $1, $2, $3, $4, 'active', $5, $6, $7, $8, $9, $10, $11, $12,
       $13::jsonb, $14::jsonb, $15::jsonb, $16, $17, $18
     )
     RETURNING id`,
    [
      input.request.requestKey,
      input.order.orderId,
      input.revision,
      input.supersedesClaimId?.toString() ?? null,
      input.plan.status,
      input.request.scope.kind,
      input.request.scope.kind === "warehouse" ? input.request.scope.warehouseId : null,
      input.authority.activationRunId.toString(),
      input.authority.revision.toString(),
      hash(input.request),
      hash(input.plan),
      input.plan.snapshotFingerprint,
      JSON.stringify(input.request),
      JSON.stringify(input.plan),
      JSON.stringify(input.plan.modelEvidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  ))[0];
  return positiveBigInt(inserted?.id, "claim.id");
}

async function insertClaimLines(
  client: PoolClient,
  claimId: bigint,
  order: LockedOrder,
  plan: ClaimPlanDto,
): Promise<Map<string, { claimLineId: bigint; orderItemId: number }>> {
  const orderLineByKey = new Map<string, OrderLine>(
    order.lines.map((line) => [`order-item:${line.orderItemId}`, line]),
  );
  const lineIds = new Map<string, { claimLineId: bigint; orderItemId: number }>();
  for (const line of plan.lines) {
    const orderLine = orderLineByKey.get(line.lineKey);
    if (!orderLine) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PLAN_LINE_MISMATCH",
        "The planner returned a line that does not belong to the locked order.",
        { claimId: claimId.toString(), lineKey: line.lineKey },
      );
    }
    const inserted = rows(await client.query(
      `INSERT INTO inventory.availability_claim_lines (
         claim_id, line_key, order_item_id, target_variant_id,
         requested_qty, planned_qty, shortfall_qty
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        claimId.toString(),
        line.lineKey,
        orderLine.orderItemId,
        line.targetVariantId,
        line.requestedQty,
        line.plannedQty,
        line.shortfallQty,
      ],
    ))[0];
    lineIds.set(line.lineKey, {
      claimLineId: positiveBigInt(inserted?.id, "claimLine.id"),
      orderItemId: orderLine.orderItemId,
    });
  }
  return lineIds;
}

async function insertClaimOperations(
  client: PoolClient,
  claimId: bigint,
  lineIds: ReadonlyMap<string, { claimLineId: bigint }>,
  plan: ClaimPlanDto,
): Promise<void> {
  for (const operation of plan.operations) {
    const line = lineIds.get(operation.lineKey);
    if (!line) throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_OPERATION_LINE_MISMATCH",
      "A planner operation does not reference a persisted claim line.",
      { operationKey: operation.operationKey, lineKey: operation.lineKey },
    );
    if (operation.inputs.length === 0) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OPERATION_INPUTS_MISSING",
        "A live canonical operation must identify every required source input.",
        { operationKey: operation.operationKey },
      );
    }
    const inserted = rows(await client.query(
      `INSERT INTO inventory.availability_claim_operations (
         claim_id, claim_line_id, operation_key, parent_operation_key, warehouse_id,
         operation_type, authority_id, destination_variant_id, planned_executions,
         output_qty, committed_output_qty, output_location_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        claimId.toString(),
        line.claimLineId.toString(),
        operation.operationKey,
        operation.parentOperationKey,
        operation.warehouseId,
        operation.operationType,
        operation.authorityId,
        operation.destinationVariantId,
        operation.plannedExecutions,
        operation.outputQty,
        operation.committedOutputQty,
        operation.outputLocationId,
      ],
    ))[0];
    const operationId = positiveBigInt(inserted?.id, "claimOperation.id");
    for (const [inputOrdinal, input] of operation.inputs.entries()) {
      await client.query(
        `INSERT INTO inventory.availability_claim_operation_inputs (
           claim_operation_id, claim_id, source_variant_id, required_qty, input_ordinal
         ) VALUES ($1, $2, $3, $4, $5)`,
        [operationId.toString(), claimId.toString(), input.sourceVariantId, input.requiredQty, inputOrdinal],
      );
    }
  }
}

async function reserveClaimResource(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  input: {
    claimId: bigint;
    claimLineId: bigint;
    orderId: number;
    orderItemId: number;
    resource: ClaimPlanDto["resourceClaims"][number];
    actor: string;
    occurredAt: Date;
  },
): Promise<void> {
  const claimedQty = positiveInteger(input.resource.claimedQty, "claimResource.claimedQty");
  const insertedResource = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, warehouse_id,
       warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.claimId.toString(),
      input.claimLineId.toString(),
      input.resource.consumerOperationKey,
      input.resource.warehouseId,
      input.resource.warehouseLocationId,
      input.resource.inventoryLevelId,
      input.resource.sourceVariantId,
      claimedQty,
    ],
  ))[0];
  const claimResourceId = positiveBigInt(insertedResource?.id, "claimResource.id");
  const lotAllocations = await inventoryWriter.reserveResource({
    client,
    claimId: input.claimId,
    claimResourceId,
    inventoryLevelId: input.resource.inventoryLevelId,
    warehouseLocationId: input.resource.warehouseLocationId,
    sourceVariantId: input.resource.sourceVariantId,
    claimedQty,
    orderId: input.orderId,
    orderItemId: input.orderItemId,
    consumerOperationKey: input.resource.consumerOperationKey,
    actor: input.actor,
    occurredAt: input.occurredAt,
  });
  for (const allocation of lotAllocations) {
    await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.claimId.toString(),
        claimResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
      ],
    );
  }
}

async function reserveClaimResources(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  claimId: bigint,
  order: LockedOrder,
  lineIds: ReadonlyMap<string, { claimLineId: bigint; orderItemId: number }>,
  plan: ClaimPlanDto,
  actor: string,
  occurredAt: Date,
): Promise<void> {
  const orderedResources = [...plan.resourceClaims].sort((left, right) =>
    left.warehouseId - right.warehouseId
    || left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || String(left.consumerOperationKey ?? "").localeCompare(String(right.consumerOperationKey ?? ""))
    || left.lineKey.localeCompare(right.lineKey));
  for (const resource of orderedResources) {
    const line = lineIds.get(resource.lineKey);
    if (!line) throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_RESOURCE_LINE_MISMATCH",
      "A planner resource does not reference a persisted claim line.",
      { lineKey: resource.lineKey, inventoryLevelId: resource.inventoryLevelId },
    );
    await reserveClaimResource(client, inventoryWriter, {
      claimId,
      claimLineId: line.claimLineId,
      orderId: order.orderId,
      orderItemId: line.orderItemId,
      resource,
      actor,
      occurredAt,
    });
  }
}

async function persistCommandAndEvent(
  client: PoolClient,
  input: {
    claimId: bigint;
    command: CanonicalAvailabilityClaimCommand;
    requestHash: string;
    result: CanonicalAvailabilityClaimResult;
    occurredAt: Date;
    eventType: "claim_reserved" | "claim_replayed";
  },
): Promise<void> {
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, 'claim', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.claimId.toString(),
      input.command.orderId,
      input.command.idempotencyKey,
      input.requestHash,
      hash(input.result),
      JSON.stringify(input.command),
      JSON.stringify(input.result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const evidence = {
    schemaVersion: "inventory_availability_claim_event_v1",
    eventType: input.eventType,
    claimId: input.claimId.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, 'active', $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claimId.toString(),
      input.eventType,
      input.eventType === "claim_replayed" ? "active" : null,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
}

async function releaseClaimResources(
  client: PoolClient,
  input: {
    inventoryWriter: CanonicalClaimInventoryMutationPort;
    claim: PersistedClaim;
    orderId: number;
    actor: string;
    reason: string;
    disposition: ClaimLifecycleDisposition;
    occurredAt: Date;
  },
): Promise<{ releasedResourceQty: bigint; releasedLotQty: bigint }> {
  const resourceRows = rows(await client.query(
    `SELECT resource.id,
            resource.claim_line_id,
            resource.inventory_level_id,
            resource.warehouse_location_id,
            resource.source_variant_id,
            resource.claimed_qty,
             resource.released_qty,
             resource.consumed_qty,
             resource.picked_qty,
             line.order_item_id
     FROM inventory.availability_claim_resources AS resource
     JOIN inventory.availability_claim_lines AS line
       ON line.id = resource.claim_line_id AND line.claim_id = resource.claim_id
     WHERE resource.claim_id = $1
     ORDER BY resource.warehouse_id, resource.warehouse_location_id,
              resource.source_variant_id, resource.inventory_level_id, resource.id
     FOR UPDATE OF resource`,
    [input.claim.id.toString()],
  ));
  const lotRows = rows(await client.query(
    `SELECT allocation.id,
            allocation.claim_resource_id,
            allocation.inventory_lot_id,
             allocation.claimed_qty,
             allocation.released_qty,
             allocation.consumed_qty,
             allocation.picked_qty
     FROM inventory.availability_claim_lot_allocations AS allocation
     WHERE allocation.claim_id = $1
     ORDER BY allocation.claim_resource_id, allocation.inventory_lot_id, allocation.id
     FOR UPDATE OF allocation`,
    [input.claim.id.toString()],
  ));
  const lotsByResource = new Map<string, any[]>();
  for (const lot of lotRows) {
    const key = String(lot.claim_resource_id);
    const candidates = lotsByResource.get(key) ?? [];
    candidates.push(lot);
    lotsByResource.set(key, candidates);
  }

  let releasedResourceQty = BigInt(0);
  let releasedLotQty = BigInt(0);
  const pendingReleases: Array<{
    inventory: CanonicalClaimInventoryReleaseResource;
    claimLotAllocations: Array<{ allocationId: bigint; releaseQty: bigint }>;
  }> = [];
  for (const resource of resourceRows) {
    const claimed = positiveBigInt(resource.claimed_qty, "claimResource.claimedQty");
    const released = BigInt(String(resource.released_qty));
    const consumed = BigInt(String(resource.consumed_qty));
    const picked = BigInt(String(resource.picked_qty ?? 0));
    const open = claimed - released - consumed - picked;
    if (open < BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLAIM_RESOURCE_BALANCE",
        "A canonical claim resource has released, consumed, or picked more than it claimed.",
        {
          claimResourceId: String(resource.id),
          claimed: claimed.toString(),
          released: released.toString(),
          consumed: consumed.toString(),
          picked: picked.toString(),
        },
      );
    }

    const openLotAllocations: Array<{ allocationId: bigint; inventoryLotId: number; releaseQty: bigint }> = [];
    let attributedOpen = BigInt(0);
    for (const lot of lotsByResource.get(String(resource.id)) ?? []) {
      const lotClaimed = positiveBigInt(lot.claimed_qty, "claimLot.claimedQty");
      const lotReleased = BigInt(String(lot.released_qty));
      const lotConsumed = BigInt(String(lot.consumed_qty));
      const lotPicked = BigInt(String(lot.picked_qty ?? 0));
      const lotOpen = lotClaimed - lotReleased - lotConsumed - lotPicked;
      if (lotOpen < BigInt(0)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_LOT_BALANCE",
          "A canonical claim lot allocation has released, consumed, or picked more than it claimed.",
          { claimLotAllocationId: String(lot.id) },
        );
      }
      if (lotOpen === BigInt(0)) continue;
      openLotAllocations.push({
        allocationId: positiveBigInt(lot.id, "claimLot.id"),
        inventoryLotId: positiveInteger(lot.inventory_lot_id, "claimLot.inventoryLotId"),
        releaseQty: lotOpen,
      });
      attributedOpen += lotOpen;
    }
    if (attributedOpen !== open) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RELEASE_LINEAGE_MISMATCH",
        "The exact open lot allocation does not reconcile to its claim resource.",
        {
          claimResourceId: String(resource.id),
          resourceOpenQty: open.toString(),
          lotOpenQty: attributedOpen.toString(),
        },
      );
    }
    if (open === BigInt(0)) continue;
    const claimResourceId = positiveBigInt(resource.id, "claimResource.id");
    pendingReleases.push({
      inventory: {
        claimResourceId,
        inventoryLevelId: positiveInteger(resource.inventory_level_id, "claimResource.inventoryLevelId"),
        warehouseLocationId: positiveInteger(resource.warehouse_location_id, "claimResource.warehouseLocationId"),
        sourceVariantId: positiveInteger(resource.source_variant_id, "claimResource.sourceVariantId"),
        releaseQty: open,
        lotAllocations: openLotAllocations.map(({ inventoryLotId, releaseQty }) => ({ inventoryLotId, releaseQty })),
        orderItemId: positiveInteger(resource.order_item_id, "claimLine.orderItemId"),
      },
      claimLotAllocations: openLotAllocations.map(({ allocationId, releaseQty }) => ({ allocationId, releaseQty })),
    });
  }

  await input.inventoryWriter.releaseResources({
    client,
    claimId: input.claim.id,
    resources: pendingReleases.map((release) => release.inventory),
    orderId: input.orderId,
    actor: input.actor,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of pendingReleases) {
    for (const allocation of release.claimLotAllocations) {
      const updatedAllocation = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updatedAllocation.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_LOT_RELEASE_STATE_CHANGED",
          "A locked claim lot allocation changed before its release was recorded.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
      releasedLotQty += allocation.releaseQty;
    }
    const updatedResource = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updatedResource.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RESOURCE_RELEASE_STATE_CHANGED",
        "A locked claim resource changed before its release was recorded.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
    releasedResourceQty += release.inventory.releaseQty;
  }

  await client.query(
    `UPDATE inventory.availability_claim_lines
     SET released_target_qty = planned_qty - consumed_target_qty - picked_target_qty, updated_at = $2
     WHERE claim_id = $1`,
    [input.claim.id.toString(), input.occurredAt],
  );
  await client.query(
    `UPDATE inventory.availability_claim_operations
     SET released_executions = planned_executions - executed_executions,
         status = CASE WHEN executed_executions = planned_executions THEN status ELSE 'released' END,
         updated_at = $2
     WHERE claim_id = $1`,
    [input.claim.id.toString(), input.occurredAt],
  );
  const status = input.disposition === "cancel"
    ? "cancelled"
    : input.disposition === "supersede"
      ? "superseded"
      : "released";
  const timestampColumn = input.disposition === "cancel"
    ? "cancelled_at"
    : input.disposition === "supersede"
      ? "superseded_at"
      : "released_at";
  const updatedClaim = await client.query(
    `UPDATE inventory.availability_claims
     SET status = $1, ${timestampColumn} = $2, updated_at = $2
     WHERE id = $3 AND status = 'active'`,
    [status, input.occurredAt, input.claim.id.toString()],
  );
  if (updatedClaim.rowCount !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "ACTIVE_CLAIM_STATE_CHANGED",
      "The locked canonical claim changed before its terminal state was recorded.",
      { claimId: input.claim.id.toString(), status },
    );
  }
  return { releasedResourceQty, releasedLotQty };
}

async function persistReleaseCommandAndEvent(
  client: PoolClient,
  input: {
    claim: PersistedClaim;
    command: CanonicalAvailabilityClaimReleaseCommand;
    requestHash: string;
    result: CanonicalAvailabilityClaimResult;
    occurredAt: Date;
  },
): Promise<void> {
  const commandType = input.command.disposition === "cancel" ? "cancel" : "release";
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      input.claim.id.toString(),
      input.command.orderId,
      commandType,
      input.command.idempotencyKey,
      input.requestHash,
      hash(input.result),
      JSON.stringify(input.command),
      JSON.stringify(input.result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const toStatus = input.command.disposition === "cancel" ? "cancelled" : "released";
  const evidence = {
    schemaVersion: "inventory_availability_claim_event_v1",
    eventType: `claim_${toStatus}`,
    claimId: input.claim.id.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, 'active', $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claim.id.toString(),
      `claim_${toStatus}`,
      toStatus,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
}

async function persistReplacementCommandAndEvents(
  client: PoolClient,
  input: {
    supersededClaim: PersistedClaim;
    replacementClaimId: bigint;
    command: CanonicalAvailabilityClaimReplacementCommand;
    requestHash: string;
    result: CanonicalAvailabilityClaimReplacementResult;
    occurredAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, 'replace', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.replacementClaimId.toString(),
      input.command.orderId,
      input.command.idempotencyKey,
      input.requestHash,
      hash(input.result),
      JSON.stringify(input.command),
      JSON.stringify(input.result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const supersededEvidence = {
    schemaVersion: "inventory_availability_claim_replacement_event_v1",
    eventType: "claim_superseded",
    supersededClaimId: input.supersededClaim.id.toString(),
    replacementClaimId: input.replacementClaimId.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_superseded', 'active', 'superseded', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.supersededClaim.id.toString(),
      JSON.stringify(supersededEvidence),
      hash(supersededEvidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const replacementEvidence = {
    schemaVersion: "inventory_availability_claim_replacement_event_v1",
    eventType: "claim_reserved",
    supersededClaimId: input.supersededClaim.id.toString(),
    replacementClaimId: input.replacementClaimId.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_reserved', NULL, 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.replacementClaimId.toString(),
      JSON.stringify(replacementEvidence),
      hash(replacementEvidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
}

type LockedClaimOperation = {
  id: bigint;
  claimLineId: bigint;
  orderItemId: number;
  operationKey: string;
  parentOperationKey: string | null;
  warehouseId: number;
  operationType: "break_pack" | "assemble_pack" | "directed_conversion" | "component_build";
  authorityId: number;
  destinationVariantId: number;
  plannedExecutions: bigint;
  outputQty: bigint;
  committedOutputQty: bigint;
  outputLocationId: number;
  status: string;
};

type LockedClaimPackageOperation = LockedClaimOperation & {
  operationType: "break_pack" | "assemble_pack" | "directed_conversion";
};

type LockedClaimBuildOperation = LockedClaimOperation & {
  operationType: "component_build";
};

async function lockPackageOperation(
  client: PoolClient,
  claimId: bigint,
  operationKey: string,
): Promise<LockedClaimPackageOperation> {
  const row = rows(await client.query(
    `SELECT operation.id, operation.claim_line_id, line.order_item_id,
            operation.operation_key, operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id, operation.destination_variant_id,
            operation.planned_executions, operation.output_qty,
            operation.committed_output_qty, operation.output_location_id,
            operation.status, operation.executed_executions, operation.released_executions
     FROM inventory.availability_claim_operations AS operation
     JOIN inventory.availability_claim_lines AS line
       ON line.id = operation.claim_line_id AND line.claim_id = operation.claim_id
     WHERE operation.claim_id = $1 AND operation.operation_key = $2
     FOR UPDATE OF operation`,
    [claimId.toString(), operationKey],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_FOUND",
      "The requested operation does not belong to the active canonical claim.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (row.operation_type === "component_build") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_REQUIRES_BUILD_HANDOFF",
      "Component-build operations must use the claim-to-build handoff contract.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (!["break_pack", "assemble_pack", "directed_conversion"].includes(String(row.operation_type))) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLAIM_OPERATION_TYPE",
      "The claim operation has an unsupported package-transformation type.",
      { claimId: claimId.toString(), operationKey, operationType: row.operation_type },
    );
  }
  if (row.committed_output_qty == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_EXECUTION_EVIDENCE_MISSING",
      "This operation predates the exact committed-output contract and must be replanned.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (row.output_location_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_OUTPUT_LOCATION_MISSING",
      "A package transformation cannot execute without its planned output location.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (String(row.status) !== "pending" && String(row.status) !== "ready") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_EXECUTABLE",
      "The package transformation is not in an executable state.",
      { claimId: claimId.toString(), operationKey, status: row.status },
    );
  }
  if (BigInt(String(row.executed_executions)) !== BigInt(0)
    || BigInt(String(row.released_executions)) !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PROGRESS_CONFLICT",
      "A pending package transformation already contains execution or release progress.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  return {
    id: positiveBigInt(row.id, "claimOperation.id"),
    claimLineId: positiveBigInt(row.claim_line_id, "claimOperation.claimLineId"),
    orderItemId: positiveInteger(row.order_item_id, "claimLine.orderItemId"),
    operationKey: String(row.operation_key),
    parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
    warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
    operationType: row.operation_type,
    authorityId: positiveInteger(row.authority_id, "claimOperation.authorityId"),
    destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
    plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
    outputQty: positiveBigInt(row.output_qty, "claimOperation.outputQty"),
    committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
    outputLocationId: positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
    status: String(row.status),
  } as LockedClaimPackageOperation;
}

async function lockBuildOperation(
  client: PoolClient,
  claimId: bigint,
  operationKey: string,
): Promise<LockedClaimBuildOperation> {
  const row = rows(await client.query(
    `SELECT operation.id, operation.claim_line_id, line.order_item_id,
            operation.operation_key, operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id, operation.destination_variant_id,
            operation.planned_executions, operation.output_qty,
            operation.committed_output_qty, operation.output_location_id,
            operation.status, operation.executed_executions, operation.released_executions
     FROM inventory.availability_claim_operations AS operation
     JOIN inventory.availability_claim_lines AS line
       ON line.id = operation.claim_line_id AND line.claim_id = operation.claim_id
     WHERE operation.claim_id = $1 AND operation.operation_key = $2
     FOR UPDATE OF operation`,
    [claimId.toString(), operationKey],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_FOUND",
      "The requested operation does not belong to the active canonical claim.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (String(row.operation_type) !== "component_build") {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_NOT_COMPONENT_BUILD",
      "Only component-build operations may use the claim-to-build handoff contract.",
      { claimId: claimId.toString(), operationKey, operationType: row.operation_type },
    );
  }
  if (row.committed_output_qty == null || row.output_location_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_EVIDENCE_MISSING",
      "The component build lacks exact committed-output or output-location evidence and must be replanned.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (!['pending', 'ready'].includes(String(row.status))
    || BigInt(String(row.executed_executions)) !== BigInt(0)
    || BigInt(String(row.released_executions)) !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_OPERATION_NOT_HANDOFF_READY",
      "The component build is not in a clean handoff-ready state.",
      { claimId: claimId.toString(), operationKey, status: row.status },
    );
  }
  return {
    id: positiveBigInt(row.id, "claimOperation.id"),
    claimLineId: positiveBigInt(row.claim_line_id, "claimOperation.claimLineId"),
    orderItemId: positiveInteger(row.order_item_id, "claimLine.orderItemId"),
    operationKey: String(row.operation_key),
    parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
    warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
    operationType: "component_build",
    authorityId: positiveInteger(row.authority_id, "claimOperation.authorityId"),
    destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
    plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
    outputQty: positiveBigInt(row.output_qty, "claimOperation.outputQty"),
    committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
    outputLocationId: positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
    status: String(row.status),
  };
}

type LockedClaimBuildHandoff = {
  id: bigint;
  buildOrderId: number;
  adoptedReservationQty: bigint;
};

async function lockHandedOffBuildOperation(
  client: PoolClient,
  claimId: bigint,
  operationKey: string,
): Promise<{ operation: LockedClaimBuildOperation; handoff: LockedClaimBuildHandoff }> {
  const row = rows(await client.query(
    `SELECT operation.id, operation.claim_line_id, line.order_item_id,
            operation.operation_key, operation.parent_operation_key, operation.warehouse_id,
            operation.operation_type, operation.authority_id, operation.destination_variant_id,
            operation.planned_executions, operation.output_qty,
            operation.committed_output_qty, operation.output_location_id,
            operation.status, operation.executed_executions, operation.released_executions,
            handoff.id AS handoff_id, handoff.build_order_id,
            handoff.adopted_reservation_qty, handoff.status AS handoff_status
     FROM inventory.availability_claim_operations AS operation
     JOIN inventory.availability_claim_lines AS line
       ON line.id = operation.claim_line_id AND line.claim_id = operation.claim_id
     JOIN inventory.availability_claim_build_handoffs AS handoff
       ON handoff.claim_id = operation.claim_id AND handoff.claim_operation_id = operation.id
     WHERE operation.claim_id = $1 AND operation.operation_key = $2
     FOR UPDATE OF operation, handoff`,
    [claimId.toString(), operationKey],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_NOT_FOUND",
      "The requested component build has no active claim handoff.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  if (String(row.operation_type) !== "component_build"
    || String(row.status) !== "executing"
    || String(row.handoff_status) !== "handed_off"
    || BigInt(String(row.executed_executions)) !== BigInt(0)
    || BigInt(String(row.released_executions)) !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_OPERATION_NOT_EXECUTABLE",
      "The claim build is not in an exact handed-off execution state.",
      {
        claimId: claimId.toString(),
        operationKey,
        operationStatus: row.status,
        handoffStatus: row.handoff_status,
      },
    );
  }
  if (row.committed_output_qty == null || row.output_location_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_EXECUTION_EVIDENCE_MISSING",
      "The handed-off build lacks exact committed-output or output-location evidence and must be replanned.",
      { claimId: claimId.toString(), operationKey },
    );
  }
  return {
    operation: {
      id: positiveBigInt(row.id, "claimOperation.id"),
      claimLineId: positiveBigInt(row.claim_line_id, "claimOperation.claimLineId"),
      orderItemId: positiveInteger(row.order_item_id, "claimLine.orderItemId"),
      operationKey: String(row.operation_key),
      parentOperationKey: row.parent_operation_key == null ? null : String(row.parent_operation_key),
      warehouseId: positiveInteger(row.warehouse_id, "claimOperation.warehouseId"),
      operationType: "component_build",
      authorityId: positiveInteger(row.authority_id, "claimOperation.authorityId"),
      destinationVariantId: positiveInteger(row.destination_variant_id, "claimOperation.destinationVariantId"),
      plannedExecutions: positiveBigInt(row.planned_executions, "claimOperation.plannedExecutions"),
      outputQty: positiveBigInt(row.output_qty, "claimOperation.outputQty"),
      committedOutputQty: positiveBigInt(row.committed_output_qty, "claimOperation.committedOutputQty"),
      outputLocationId: positiveInteger(row.output_location_id, "claimOperation.outputLocationId"),
      status: "executing",
    },
    handoff: {
      id: positiveBigInt(row.handoff_id, "claimBuildHandoff.id"),
      buildOrderId: positiveInteger(row.build_order_id, "claimBuildHandoff.buildOrderId"),
      adoptedReservationQty: positiveBigInt(
        row.adopted_reservation_qty,
        "claimBuildHandoff.adoptedReservationQty",
      ),
    },
  };
}

function assertOperationMatchesPlan(
  claim: PersistedClaim,
  operation: LockedClaimOperation,
): ClaimPlanDto["operations"][number] {
  const planned = claim.plan.operations.find((candidate) => candidate.operationKey === operation.operationKey);
  if (!planned) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PLAN_EVIDENCE_MISSING",
      "The relational operation is absent from the claim's hashed planner payload.",
      { claimId: claim.id.toString(), operationKey: operation.operationKey },
    );
  }
  const persistedEvidence = {
    lineKey: `order-item:${operation.orderItemId}`,
    warehouseId: operation.warehouseId,
    operationKey: operation.operationKey,
    parentOperationKey: operation.parentOperationKey,
    operationType: operation.operationType,
    authorityId: operation.authorityId,
    destinationVariantId: operation.destinationVariantId,
    plannedExecutions: operation.plannedExecutions.toString(),
    outputQty: operation.outputQty.toString(),
    committedOutputQty: operation.committedOutputQty.toString(),
    outputLocationId: operation.outputLocationId,
  };
  const plannedEvidence = {
    lineKey: planned.lineKey,
    warehouseId: planned.warehouseId,
    operationKey: planned.operationKey,
    parentOperationKey: planned.parentOperationKey,
    operationType: planned.operationType,
    authorityId: planned.authorityId,
    destinationVariantId: planned.destinationVariantId,
    plannedExecutions: planned.plannedExecutions,
    outputQty: planned.outputQty,
    committedOutputQty: planned.committedOutputQty,
    outputLocationId: planned.outputLocationId,
  };
  if (canonicalJson(persistedEvidence) !== canonicalJson(plannedEvidence)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PLAN_EVIDENCE_MISMATCH",
      "The relational operation differs from the claim's hashed planner payload.",
      { claimId: claim.id.toString(), operationKey: operation.operationKey, persistedEvidence, plannedEvidence },
    );
  }
  return planned;
}

async function loadOperationExecutionResources(
  client: PoolClient,
  claimId: bigint,
  operation: LockedClaimOperation,
  plannedOperation: ClaimPlanDto["operations"][number],
): Promise<CanonicalClaimInventoryExecutionResource[]> {
  const prerequisiteRows = rows(await client.query(
    `SELECT operation_key, status
     FROM inventory.availability_claim_operations
     WHERE claim_id = $1 AND parent_operation_key = $2
     ORDER BY operation_key
     FOR SHARE`,
    [claimId.toString(), operation.operationKey],
  ));
  const incompletePrerequisites = prerequisiteRows
    .filter((row) => String(row.status) !== "completed")
    .map((row) => ({ operationKey: String(row.operation_key), status: String(row.status) }));
  if (incompletePrerequisites.length > 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_PREREQUISITE_INCOMPLETE",
      "Every child operation must complete before its parent can consume the produced output.",
      { claimId: claimId.toString(), operationKey: operation.operationKey, incompletePrerequisites },
    );
  }

  const inputRows = rows(await client.query(
    `SELECT source_variant_id, required_qty
     FROM inventory.availability_claim_operation_inputs
     WHERE claim_operation_id = $1 AND claim_id = $2
     ORDER BY input_ordinal, source_variant_id
     FOR SHARE`,
    [operation.id.toString(), claimId.toString()],
  ));
  if (inputRows.length === 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_INPUTS_MISSING",
      "The package transformation has no persisted input contract.",
      { claimId: claimId.toString(), operationKey: operation.operationKey },
    );
  }
  const expectedByVariant = new Map<number, bigint>();
  for (const row of inputRows) {
    expectedByVariant.set(
      positiveInteger(row.source_variant_id, "claimOperationInput.sourceVariantId"),
      positiveBigInt(row.required_qty, "claimOperationInput.requiredQty"),
    );
  }
  const plannedInputs = [...plannedOperation.inputs]
    .sort((left, right) => left.sourceVariantId - right.sourceVariantId)
    .map((input) => [input.sourceVariantId, input.requiredQty]);
  const persistedInputs = [...expectedByVariant]
    .sort(([left], [right]) => left - right)
    .map(([variantId, quantity]) => [variantId, quantity.toString()]);
  if (canonicalJson(persistedInputs) !== canonicalJson(plannedInputs)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_INPUT_PLAN_MISMATCH",
      "The relational operation inputs differ from the claim's hashed planner payload.",
      { operationKey: operation.operationKey, plannedInputs, persistedInputs },
    );
  }

  const resourceRows = rows(await client.query(
    `SELECT id, claim_line_id, warehouse_id, warehouse_location_id,
            inventory_level_id, source_variant_id, claimed_qty, released_qty, consumed_qty, picked_qty
     FROM inventory.availability_claim_resources
     WHERE claim_id = $1 AND consumer_operation_key = $2
     ORDER BY warehouse_id, warehouse_location_id, source_variant_id, inventory_level_id, id
     FOR UPDATE`,
    [claimId.toString(), operation.operationKey],
  ));
  if (resourceRows.length === 0) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_RESOURCES_MISSING",
      "The package transformation has no claim-owned source resources.",
      { claimId: claimId.toString(), operationKey: operation.operationKey },
    );
  }
  const resourceIds = resourceRows.map((row) => positiveBigInt(row.id, "claimResource.id").toString());
  const allocationRows = rows(await client.query(
    `SELECT id, claim_resource_id, inventory_lot_id, claimed_qty, released_qty, consumed_qty, picked_qty,
            unit_cost_mills, po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
     FROM inventory.availability_claim_lot_allocations
     WHERE claim_id = $1 AND claim_resource_id = ANY($2::bigint[])
     ORDER BY claim_resource_id, inventory_lot_id, id
     FOR UPDATE`,
    [claimId.toString(), resourceIds],
  ));
  const allocationsByResource = new Map<string, any[]>();
  for (const allocation of allocationRows) {
    const key = String(allocation.claim_resource_id);
    const candidates = allocationsByResource.get(key) ?? [];
    candidates.push(allocation);
    allocationsByResource.set(key, candidates);
  }

  const actualByVariant = new Map<number, bigint>();
  const executionResources: CanonicalClaimInventoryExecutionResource[] = [];
  for (const row of resourceRows) {
    const claimResourceId = positiveBigInt(row.id, "claimResource.id");
    if (positiveBigInt(row.claim_line_id, "claimResource.claimLineId") !== operation.claimLineId
      || positiveInteger(row.warehouse_id, "claimResource.warehouseId") !== operation.warehouseId) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OPERATION_RESOURCE_SCOPE_MISMATCH",
        "A claim-owned source resource is outside the operation line or warehouse.",
        { claimId: claimId.toString(), operationKey: operation.operationKey, claimResourceId: claimResourceId.toString() },
      );
    }
    const claimed = positiveBigInt(row.claimed_qty, "claimResource.claimedQty");
    const released = BigInt(String(row.released_qty));
    const consumed = BigInt(String(row.consumed_qty));
    const picked = BigInt(String(row.picked_qty ?? 0));
    const open = claimed - released - consumed - picked;
    if (open <= BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OPERATION_RESOURCE_NOT_OPEN",
        "Every source resource must remain open until its operation executes.",
        { claimResourceId: claimResourceId.toString(), openQty: open.toString() },
      );
    }
    const sourceVariantId = positiveInteger(row.source_variant_id, "claimResource.sourceVariantId");
    const lotAllocations: CanonicalClaimInventoryExecutionResource["lotAllocations"][number][] = [];
    let lotOpenTotal = BigInt(0);
    for (const allocation of allocationsByResource.get(claimResourceId.toString()) ?? []) {
      if (allocation.po_unit_cost_mills == null
        || allocation.packaging_unit_cost_mills == null
        || allocation.landed_unit_cost_mills == null) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_OPERATION_COST_EVIDENCE_MISSING",
          "This claim lot predates the exact cost-breakdown contract and must be replanned.",
          { claimLotAllocationId: String(allocation.id) },
        );
      }
      const lotOpen = positiveBigInt(allocation.claimed_qty, "claimLot.claimedQty")
        - BigInt(String(allocation.released_qty))
        - BigInt(String(allocation.consumed_qty))
        - BigInt(String(allocation.picked_qty ?? 0));
      if (lotOpen <= BigInt(0)) continue;
      lotAllocations.push({
        claimLotAllocationId: positiveBigInt(allocation.id, "claimLot.id"),
        inventoryLotId: positiveInteger(allocation.inventory_lot_id, "claimLot.inventoryLotId"),
        consumeQty: lotOpen,
        unitCostMills: BigInt(String(allocation.unit_cost_mills)),
        poUnitCostMills: BigInt(String(allocation.po_unit_cost_mills)),
        packagingUnitCostMills: BigInt(String(allocation.packaging_unit_cost_mills)),
        landedUnitCostMills: BigInt(String(allocation.landed_unit_cost_mills)),
      });
      lotOpenTotal += lotOpen;
    }
    if (lotOpenTotal !== open) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_EXECUTION_LINEAGE_MISMATCH",
        "Exact open lot allocations do not reconcile to their claim resource.",
        { claimResourceId: claimResourceId.toString(), resourceQty: open.toString(), lotQty: lotOpenTotal.toString() },
      );
    }
    actualByVariant.set(sourceVariantId, (actualByVariant.get(sourceVariantId) ?? BigInt(0)) + open);
    executionResources.push({
      claimResourceId,
      inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
      warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
      sourceVariantId,
      consumeQty: open,
      lotAllocations,
    });
  }
  const expected = [...expectedByVariant]
    .sort(([left], [right]) => left - right)
    .map(([variantId, quantity]) => [variantId, quantity.toString()]);
  const actual = [...actualByVariant]
    .sort(([left], [right]) => left - right)
    .map(([variantId, quantity]) => [variantId, quantity.toString()]);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_INPUT_MISMATCH",
      "Claim-owned source resources do not equal the operation input contract.",
      { operationKey: operation.operationKey, expected, actual },
    );
  }
  return executionResources;
}

async function recordOperationExecution(
  client: PoolClient,
  input: {
    claim: PersistedClaim;
    operation: LockedClaimOperation;
    resources: readonly CanonicalClaimInventoryExecutionResource[];
    command: CanonicalAvailabilityClaimOperationExecutionCommand;
    requestHash: string;
    outputInventoryLevelId: number;
    committedLotAllocations: Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executePackageOperation"]>>["committedLotAllocations"];
    totalInputCostMills: bigint;
    occurredAt: Date;
    commandType: "execute" | "execute_build";
    eventType: "claim_operation_executed" | "claim_build_executed";
    buildHandoffId?: bigint;
  },
): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
  for (const resource of input.resources) {
    for (const allocation of resource.lotAllocations) {
      const updatedAllocation = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET consumed_qty = consumed_qty + $1, updated_at = $3
         WHERE id = $2 AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
        [allocation.consumeQty.toString(), allocation.claimLotAllocationId.toString(), input.occurredAt],
      );
      if (updatedAllocation.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_LOT_EXECUTION_STATE_CHANGED",
          "A locked claim lot allocation changed before its consumption was recorded.",
          { claimLotAllocationId: allocation.claimLotAllocationId.toString() },
        );
      }
    }
    const updatedResource = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET consumed_qty = consumed_qty + $1, updated_at = $3
       WHERE id = $2 AND claimed_qty - released_qty - consumed_qty - picked_qty = $1`,
      [resource.consumeQty.toString(), resource.claimResourceId.toString(), input.occurredAt],
    );
    if (updatedResource.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RESOURCE_EXECUTION_STATE_CHANGED",
        "A locked claim resource changed before its consumption was recorded.",
        { claimResourceId: resource.claimResourceId.toString() },
      );
    }
  }

  const outputResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.operation.claimLineId.toString(),
      input.operation.parentOperationKey,
      input.operation.operationKey,
      input.operation.warehouseId,
      input.operation.outputLocationId,
      input.outputInventoryLevelId,
      input.operation.destinationVariantId,
      input.operation.committedOutputQty.toString(),
    ],
  ))[0];
  const outputResourceId = positiveBigInt(outputResourceRow?.id, "outputClaimResource.id");
  for (const allocation of input.committedLotAllocations) {
    await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.claim.id.toString(),
        outputResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
      ],
    );
  }
  const committedLotQty = input.committedLotAllocations.reduce(
    (total, allocation) => total + BigInt(allocation.qty),
    BigInt(0),
  );
  if (committedLotQty !== input.operation.committedOutputQty) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OUTPUT_LINEAGE_MISMATCH",
      "Produced claim-owned lots do not reconcile to committed operation output.",
      {
        operationKey: input.operation.operationKey,
        committedQty: input.operation.committedOutputQty.toString(),
        lotQty: committedLotQty.toString(),
      },
    );
  }
  const updatedOperation = await client.query(
    `UPDATE inventory.availability_claim_operations
     SET status = 'completed', executed_executions = planned_executions, updated_at = $3
     WHERE id = $1 AND claim_id = $2
       AND status = $4
       AND executed_executions = 0 AND released_executions = 0`,
    [input.operation.id.toString(), input.claim.id.toString(), input.occurredAt, input.operation.status],
  );
  if (updatedOperation.rowCount !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_OPERATION_STATE_CHANGED",
      "The locked claim operation changed before completion was recorded.",
      { operationKey: input.operation.operationKey },
    );
  }
  if (input.buildHandoffId != null) {
    const updatedHandoff = await client.query(
      `UPDATE inventory.availability_claim_build_handoffs
       SET status = 'completed', completed_at = $3, updated_at = $3
       WHERE id = $1 AND claim_id = $2 AND status = 'handed_off'`,
      [input.buildHandoffId.toString(), input.claim.id.toString(), input.occurredAt],
    );
    if (updatedHandoff.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_BUILD_HANDOFF_STATE_CHANGED",
        "The claim build handoff changed before completion was recorded.",
        { operationKey: input.operation.operationKey, buildHandoffId: input.buildHandoffId.toString() },
      );
    }
  }

  const result = canonicalAvailabilityClaimOperationExecutionResultSchema.parse({
    outcome: "executed",
    claimId: input.claim.id.toString(),
    claimOperationId: input.operation.id.toString(),
    operationKey: input.operation.operationKey,
    outputResourceId: outputResourceId.toString(),
    producedQty: input.operation.outputQty.toString(),
    committedQty: input.operation.committedOutputQty.toString(),
    surplusQty: (input.operation.outputQty - input.operation.committedOutputQty).toString(),
    totalInputCostMills: input.totalInputCostMills.toString(),
    idempotentReplay: false,
  });
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)`,
    [
      input.claim.id.toString(),
      input.claim.orderId,
      input.commandType,
      input.command.idempotencyKey,
      input.requestHash,
      hash(result),
      JSON.stringify(input.command),
      JSON.stringify(result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const evidence = {
    schemaVersion: "inventory_availability_claim_operation_event_v1",
    eventType: input.eventType,
    claimId: input.claim.id.toString(),
    operationKey: input.operation.operationKey,
    result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, 'completed', $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claim.id.toString(),
      input.eventType,
      input.operation.status,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  return result;
}

async function recordBuildHandoff(
  client: PoolClient,
  input: {
    claim: PersistedClaim;
    operation: LockedClaimBuildOperation;
    command: CanonicalAvailabilityClaimBuildHandoffCommand;
    requestHash: string;
    buildOrderId: number;
    buildSystemNumber: string;
    adoptedReservationQty: bigint;
    occurredAt: Date;
  },
): Promise<CanonicalAvailabilityClaimBuildHandoffResult> {
  await client.query(
    `INSERT INTO inventory.availability_claim_build_handoffs (
       claim_id, claim_operation_id, build_order_id, status,
       adopted_reservation_qty, created_by, created_at
     ) VALUES ($1, $2, $3, 'handed_off', $4, $5, $6)`,
    [
      input.claim.id.toString(),
      input.operation.id.toString(),
      input.buildOrderId,
      input.adoptedReservationQty.toString(),
      input.command.actor,
      input.occurredAt,
    ],
  );
  const operationUpdate = await client.query(
    `UPDATE inventory.availability_claim_operations
     SET status = 'executing', updated_at = $3
     WHERE id = $1 AND claim_id = $2 AND status IN ('pending', 'ready')
     RETURNING id`,
    [input.operation.id.toString(), input.claim.id.toString(), input.occurredAt],
  );
  if (operationUpdate.rowCount !== 1) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_STATE_CONFLICT",
      "The component-build operation changed before ownership could be handed off.",
      { claimId: input.claim.id.toString(), operationKey: input.operation.operationKey },
    );
  }
  const result = canonicalAvailabilityClaimBuildHandoffResultSchema.parse({
    outcome: "build_handed_off",
    claimId: input.claim.id.toString(),
    claimOperationId: input.operation.id.toString(),
    operationKey: input.operation.operationKey,
    buildOrderId: input.buildOrderId,
    buildSystemNumber: input.buildSystemNumber,
    adoptedReservationQty: input.adoptedReservationQty.toString(),
    idempotentReplay: false,
  });
  await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key,
       request_hash, result_hash, request_payload, result_payload,
       actor, reason, occurred_at
     ) VALUES ($1, $2, 'handoff_build', $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)`,
    [
      input.claim.id.toString(),
      input.claim.orderId,
      input.command.idempotencyKey,
      input.requestHash,
      hash(result),
      JSON.stringify(input.command),
      JSON.stringify(result),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  const evidence = {
    eventType: "claim_build_handed_off",
    claimId: input.claim.id.toString(),
    claimOperationId: input.operation.id.toString(),
    operationKey: input.operation.operationKey,
    buildOrderId: input.buildOrderId,
    buildSystemNumber: input.buildSystemNumber,
    adoptedReservationQty: input.adoptedReservationQty.toString(),
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_build_handed_off', $2, 'executing', $3::jsonb, $4, $5, $6, $7)`,
    [
      input.claim.id.toString(),
      input.operation.status,
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  return result;
}

async function cancelOpenBuildHandoffs(
  client: PoolClient,
  buildWriter: CanonicalClaimBuildMutationPort | undefined,
  claim: PersistedClaim,
  command: ClaimAuditCommand & { disposition: ClaimLifecycleDisposition },
  occurredAt: Date,
): Promise<void> {
  const openHandoffs = rows(await client.query(
    `SELECT handoff.id, handoff.claim_operation_id, handoff.build_order_id,
            handoff.adopted_reservation_qty, handoff.status,
            operation.operation_key, operation.status AS operation_status,
            operation.executed_executions, operation.released_executions
     FROM inventory.availability_claim_build_handoffs AS handoff
     JOIN inventory.availability_claim_operations AS operation
       ON operation.id = handoff.claim_operation_id AND operation.claim_id = handoff.claim_id
     WHERE handoff.claim_id = $1 AND handoff.status = 'handed_off'
     ORDER BY handoff.id
     FOR UPDATE OF handoff, operation`,
    [claim.id.toString()],
  ));
  if (openHandoffs.length === 0) return;
  if (!buildWriter) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_CANCELLATION_NOT_CONFIGURED",
      "The claim owns active build handoffs, but its cancellation port is not configured.",
      {
        claimId: claim.id.toString(),
        buildOrderIds: openHandoffs.map((row) => positiveInteger(row.build_order_id, "buildHandoff.buildOrderId")),
      },
    );
  }
  for (const handoff of openHandoffs) {
    if (String(handoff.operation_status) !== "executing"
      || BigInt(String(handoff.executed_executions)) !== BigInt(0)
      || BigInt(String(handoff.released_executions)) !== BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_BUILD_CANCELLATION_STATE_DRIFT",
        "An open build handoff is not in an unexecuted canonical operation state.",
        {
          claimId: claim.id.toString(),
          claimOperationId: String(handoff.claim_operation_id),
          operationStatus: handoff.operation_status,
        },
      );
    }
    const cancellation = await buildWriter.cancelOperation({
      client,
      claimId: claim.id,
      claimOperationId: positiveBigInt(handoff.claim_operation_id, "claimOperation.id"),
      buildOrderId: positiveInteger(handoff.build_order_id, "buildHandoff.buildOrderId"),
      expectedReservationQty: positiveBigInt(
        handoff.adopted_reservation_qty,
        "buildHandoff.adoptedReservationQty",
      ),
      actor: command.actor,
      reason: command.reason,
      occurredAt,
    });
    const updatedHandoff = await client.query(
      `UPDATE inventory.availability_claim_build_handoffs
       SET status = 'cancelled', cancelled_at = $3, updated_at = $3
       WHERE id = $1 AND claim_id = $2 AND status = 'handed_off'`,
      [String(handoff.id), claim.id.toString(), occurredAt],
    );
    if (updatedHandoff.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_BUILD_HANDOFF_STATE_CHANGED",
        "The build handoff changed while claim cancellation was being recorded.",
        { claimId: claim.id.toString(), buildOrderId: cancellation.buildOrderId },
      );
    }
    const evidence = {
      schemaVersion: "inventory_availability_claim_build_cancellation_event_v1",
      eventType: "claim_build_cancelled",
      claimId: claim.id.toString(),
      claimOperationId: String(handoff.claim_operation_id),
      operationKey: String(handoff.operation_key),
      buildOrderId: cancellation.buildOrderId,
      buildSystemNumber: cancellation.buildSystemNumber,
      releasedReservationQty: cancellation.releasedReservationQty.toString(),
      disposition: command.disposition,
    };
    await client.query(
      `INSERT INTO inventory.availability_claim_events (
         claim_id, event_type, from_status, to_status, evidence_payload,
         evidence_hash, actor, reason, occurred_at
       ) VALUES ($1, 'claim_build_cancelled', 'executing', 'released', $2::jsonb, $3, $4, $5, $6)`,
      [
        claim.id.toString(),
        JSON.stringify(evidence),
        hash(evidence),
        command.actor,
        command.reason,
        occurredAt,
      ],
    );
  }
}

type FulfillmentClaim = PersistedClaim & {
  status: "active" | "released" | "cancelled" | "superseded" | "failed";
};

type FulfillmentClaimLot = {
  id: bigint;
  inventoryLotId: number;
  claimedQty: bigint;
  releasedQty: bigint;
  consumedQty: bigint;
  pickedQty: bigint;
  unitCostMills: bigint;
  poUnitCostMills: bigint;
  packagingUnitCostMills: bigint;
  landedUnitCostMills: bigint;
};

type FulfillmentClaimResource = {
  id: bigint;
  inventoryLevelId: number;
  warehouseId: number;
  warehouseLocationId: number;
  sourceVariantId: number;
  claimedQty: bigint;
  releasedQty: bigint;
  consumedQty: bigint;
  pickedQty: bigint;
  lots: FulfillmentClaimLot[];
};

type FulfillmentClaimLine = {
  id: bigint;
  orderItemId: number;
  targetVariantId: number;
  plannedQty: bigint;
  releasedTargetQty: bigint;
  consumedTargetQty: bigint;
  pickedTargetQty: bigint;
  resources: FulfillmentClaimResource[];
};

function nonnegativeBigInt(value: unknown, field: string): bigint {
  try {
    const parsed = BigInt(String(value));
    if (parsed < BigInt(0)) throw new Error("negative");
    return parsed;
  } catch (cause) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative bigint`,
      { field, value, cause: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function openResourceQty(resource: FulfillmentClaimResource): bigint {
  return resource.claimedQty - resource.releasedQty - resource.consumedQty - resource.pickedQty;
}

function openLotQty(lot: FulfillmentClaimLot): bigint {
  return lot.claimedQty - lot.releasedQty - lot.consumedQty - lot.pickedQty;
}

async function loadClaimById(
  client: PoolClient,
  claimId: bigint,
  lock: boolean,
): Promise<FulfillmentClaim | null> {
  const row = rows(await client.query(
    `SELECT id, claim_key, order_id, revision, status,
            runtime_authority_revision, plan_hash, plan_payload
     FROM inventory.availability_claims
     WHERE id = $1
     ${lock ? "FOR UPDATE" : ""}`,
    [claimId.toString()],
  ))[0];
  if (!row) return null;
  const plan = claimPlanSchema.parse(row.plan_payload);
  if (hash(plan) !== String(row.plan_hash)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PLAN_HASH_MISMATCH",
      "The claim planner payload no longer matches its persisted hash.",
      { claimId: String(row.id) },
    );
  }
  const status = String(row.status);
  if (!["active", "released", "cancelled", "superseded", "failed"].includes(status)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLAIM_STATUS",
      "The canonical claim has an unsupported persisted status.",
      { claimId: String(row.id), status },
    );
  }
  return {
    id: positiveBigInt(row.id, "claim.id"),
    claimKey: String(row.claim_key),
    orderId: positiveInteger(row.order_id, "claim.orderId"),
    revision: positiveInteger(row.revision, "claim.revision"),
    status: status as FulfillmentClaim["status"],
    runtimeAuthorityRevision: positiveBigInt(row.runtime_authority_revision, "claim.runtimeAuthorityRevision"),
    planHash: String(row.plan_hash),
    plan,
  };
}

async function loadFulfillmentClaimLine(
  client: PoolClient,
  claimId: bigint,
  orderItemId: number,
): Promise<FulfillmentClaimLine> {
  const lineRow = rows(await client.query(
    `SELECT id, order_item_id, target_variant_id, planned_qty,
            released_target_qty, consumed_target_qty, picked_target_qty
     FROM inventory.availability_claim_lines
     WHERE claim_id = $1 AND order_item_id = $2
     FOR UPDATE`,
    [claimId.toString(), orderItemId],
  ))[0];
  if (!lineRow) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_LINE_NOT_FOUND",
      "The requested order item does not belong to this canonical claim.",
      { claimId: claimId.toString(), orderItemId },
    );
  }
  const lineId = positiveBigInt(lineRow.id, "claimLine.id");
  const targetVariantId = positiveInteger(lineRow.target_variant_id, "claimLine.targetVariantId");
  const resourceRows = rows(await client.query(
    `SELECT id, inventory_level_id, warehouse_id, warehouse_location_id,
            source_variant_id, claimed_qty, released_qty, consumed_qty, picked_qty
     FROM inventory.availability_claim_resources
     WHERE claim_id = $1 AND claim_line_id = $2
       AND consumer_operation_key IS NULL
       AND source_variant_id = $3
     ORDER BY warehouse_id, warehouse_location_id, inventory_level_id, id
     FOR UPDATE`,
    [claimId.toString(), lineId.toString(), targetVariantId],
  ));
  const resourceIds = resourceRows.map((row) => positiveBigInt(row.id, "claimResource.id"));
  const lotRows = resourceIds.length === 0 ? [] : rows(await client.query(
    `SELECT id, claim_resource_id, inventory_lot_id, claimed_qty, released_qty,
            consumed_qty, picked_qty, unit_cost_mills, po_unit_cost_mills,
            packaging_unit_cost_mills, landed_unit_cost_mills
     FROM inventory.availability_claim_lot_allocations
     WHERE claim_resource_id = ANY($1::bigint[])
     ORDER BY claim_resource_id, inventory_lot_id, id
     FOR UPDATE`,
    [resourceIds.map(String)],
  ));
  const lotsByResource = new Map<string, FulfillmentClaimLot[]>();
  for (const row of lotRows) {
    if (row.po_unit_cost_mills == null
      || row.packaging_unit_cost_mills == null
      || row.landed_unit_cost_mills == null) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_COST_EVIDENCE_MISSING",
        "This claim lot predates exact cost lineage and must be replanned before fulfillment.",
        { claimLotAllocationId: String(row.id) },
      );
    }
    const lot: FulfillmentClaimLot = {
      id: positiveBigInt(row.id, "claimLot.id"),
      inventoryLotId: positiveInteger(row.inventory_lot_id, "claimLot.inventoryLotId"),
      claimedQty: positiveBigInt(row.claimed_qty, "claimLot.claimedQty"),
      releasedQty: nonnegativeBigInt(row.released_qty, "claimLot.releasedQty"),
      consumedQty: nonnegativeBigInt(row.consumed_qty, "claimLot.consumedQty"),
      pickedQty: nonnegativeBigInt(row.picked_qty, "claimLot.pickedQty"),
      unitCostMills: nonnegativeBigInt(row.unit_cost_mills, "claimLot.unitCostMills"),
      poUnitCostMills: nonnegativeBigInt(row.po_unit_cost_mills, "claimLot.poUnitCostMills"),
      packagingUnitCostMills: nonnegativeBigInt(row.packaging_unit_cost_mills, "claimLot.packagingUnitCostMills"),
      landedUnitCostMills: nonnegativeBigInt(row.landed_unit_cost_mills, "claimLot.landedUnitCostMills"),
    };
    const resourceKey = String(row.claim_resource_id);
    const existing = lotsByResource.get(resourceKey) ?? [];
    existing.push(lot);
    lotsByResource.set(resourceKey, existing);
  }
  const resources = resourceRows.map((row): FulfillmentClaimResource => {
    const resourceId = positiveBigInt(row.id, "claimResource.id");
    const resource: FulfillmentClaimResource = {
      id: resourceId,
      inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
      warehouseId: positiveInteger(row.warehouse_id, "claimResource.warehouseId"),
      warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
      sourceVariantId: positiveInteger(row.source_variant_id, "claimResource.sourceVariantId"),
      claimedQty: positiveBigInt(row.claimed_qty, "claimResource.claimedQty"),
      releasedQty: nonnegativeBigInt(row.released_qty, "claimResource.releasedQty"),
      consumedQty: nonnegativeBigInt(row.consumed_qty, "claimResource.consumedQty"),
      pickedQty: nonnegativeBigInt(row.picked_qty, "claimResource.pickedQty"),
      lots: lotsByResource.get(resourceId.toString()) ?? [],
    };
    const resourceOpen = openResourceQty(resource);
    const lotOpen = resource.lots.reduce((total, lot) => total + openLotQty(lot), BigInt(0));
    if (resourceOpen < BigInt(0) || resource.lots.some((lot) => openLotQty(lot) < BigInt(0))
      || resourceOpen !== lotOpen) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_LINEAGE_MISMATCH",
        "Open claim resource and lot balances do not reconcile before fulfillment.",
        { claimResourceId: resourceId.toString(), resourceOpen: resourceOpen.toString(), lotOpen: lotOpen.toString() },
      );
    }
    return resource;
  });
  const plannedQty = nonnegativeBigInt(lineRow.planned_qty, "claimLine.plannedQty");
  const releasedTargetQty = nonnegativeBigInt(lineRow.released_target_qty, "claimLine.releasedTargetQty");
  const consumedTargetQty = nonnegativeBigInt(lineRow.consumed_target_qty, "claimLine.consumedTargetQty");
  const pickedTargetQty = nonnegativeBigInt(lineRow.picked_target_qty, "claimLine.pickedTargetQty");
  if (releasedTargetQty + consumedTargetQty + pickedTargetQty > plannedQty) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "INVALID_CLAIM_LINE_BALANCE",
      "The canonical claim line has released, consumed, or picked more than it planned.",
      { claimLineId: lineId.toString() },
    );
  }
  return {
    id: lineId,
    orderItemId: positiveInteger(lineRow.order_item_id, "claimLine.orderItemId"),
    targetVariantId,
    plannedQty,
    releasedTargetQty,
    consumedTargetQty,
    pickedTargetQty,
    resources,
  };
}

function selectPickResources(
  line: FulfillmentClaimLine,
  warehouseLocationId: number,
  quantity: bigint,
): CanonicalClaimInventoryPickResource[] {
  let remaining = quantity;
  const selected: CanonicalClaimInventoryPickResource[] = [];
  for (const resource of line.resources.filter((entry) => entry.warehouseLocationId === warehouseLocationId)) {
    if (remaining === BigInt(0)) break;
    const resourceTake = openResourceQty(resource) < remaining ? openResourceQty(resource) : remaining;
    if (resourceTake <= BigInt(0)) continue;
    let lotRemaining = resourceTake;
    const lotAllocations: CanonicalClaimInventoryPickResource["lotAllocations"][number][] = [];
    for (const lot of resource.lots) {
      if (lotRemaining === BigInt(0)) break;
      const available = openLotQty(lot);
      const take = available < lotRemaining ? available : lotRemaining;
      if (take <= BigInt(0)) continue;
      lotAllocations.push({
        claimLotAllocationId: lot.id,
        inventoryLotId: lot.inventoryLotId,
        pickQty: take,
        unitCostMills: lot.unitCostMills,
        poUnitCostMills: lot.poUnitCostMills,
        packagingUnitCostMills: lot.packagingUnitCostMills,
        landedUnitCostMills: lot.landedUnitCostMills,
      });
      lotRemaining -= take;
    }
    if (lotRemaining !== BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_PICK_LINEAGE_MISMATCH",
        "The selected claim resource has insufficient exact open lot ownership.",
        { claimResourceId: resource.id.toString() },
      );
    }
    selected.push({
      claimResourceId: resource.id,
      inventoryLevelId: resource.inventoryLevelId,
      warehouseLocationId: resource.warehouseLocationId,
      sourceVariantId: resource.sourceVariantId,
      pickQty: resourceTake,
      lotAllocations,
    });
    remaining -= resourceTake;
  }
  if (remaining !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_SHORTFALL",
      "The selected location does not own enough open claim inventory for this pick.",
      { claimLineId: line.id.toString(), warehouseLocationId, requestedQty: quantity.toString(), shortfallQty: remaining.toString() },
    );
  }
  return selected;
}

function selectReconciliationReleases(
  line: FulfillmentClaimLine,
  selectedLocationId: number,
  quantity: bigint,
  sourceWarehouseId?: number,
): Array<{
  inventory: CanonicalClaimInventoryReleaseResource;
  allocations: readonly {
    allocationId: bigint;
    inventoryLotId: number;
    releaseQty: bigint;
    unitCostMills: bigint;
    poUnitCostMills: bigint;
    packagingUnitCostMills: bigint;
    landedUnitCostMills: bigint;
  }[];
}> {
  let remaining = quantity;
  const releases: Array<{
    inventory: CanonicalClaimInventoryReleaseResource;
    allocations: readonly {
      allocationId: bigint;
      inventoryLotId: number;
      releaseQty: bigint;
      unitCostMills: bigint;
      poUnitCostMills: bigint;
      packagingUnitCostMills: bigint;
      landedUnitCostMills: bigint;
    }[];
  }> = [];
  for (const resource of line.resources.filter((entry) =>
    entry.warehouseLocationId !== selectedLocationId
    && (sourceWarehouseId == null || entry.warehouseId === sourceWarehouseId))) {
    if (remaining === BigInt(0)) break;
    const take = openResourceQty(resource) < remaining ? openResourceQty(resource) : remaining;
    if (take <= BigInt(0)) continue;
    let lotRemaining = take;
    const allocations: Array<{
      allocationId: bigint;
      inventoryLotId: number;
      releaseQty: bigint;
      unitCostMills: bigint;
      poUnitCostMills: bigint;
      packagingUnitCostMills: bigint;
      landedUnitCostMills: bigint;
    }> = [];
    for (const lot of resource.lots) {
      if (lotRemaining === BigInt(0)) break;
      const available = openLotQty(lot);
      const lotTake = available < lotRemaining ? available : lotRemaining;
      if (lotTake <= BigInt(0)) continue;
      allocations.push({
        allocationId: lot.id,
        inventoryLotId: lot.inventoryLotId,
        releaseQty: lotTake,
        unitCostMills: lot.unitCostMills,
        poUnitCostMills: lot.poUnitCostMills,
        packagingUnitCostMills: lot.packagingUnitCostMills,
        landedUnitCostMills: lot.landedUnitCostMills,
      });
      lotRemaining -= lotTake;
    }
    if (lotRemaining !== BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_LINEAGE_MISMATCH",
        "The source claim resource has insufficient exact lot ownership for reconciliation.",
        { claimResourceId: resource.id.toString() },
      );
    }
    releases.push({
      inventory: {
        claimResourceId: resource.id,
        inventoryLevelId: resource.inventoryLevelId,
        warehouseLocationId: resource.warehouseLocationId,
        sourceVariantId: resource.sourceVariantId,
        releaseQty: take,
        lotAllocations: allocations.map(({ inventoryLotId, releaseQty }) => ({ inventoryLotId, releaseQty })),
        orderItemId: line.orderItemId,
      },
      allocations: allocations.map((allocation) => ({
        allocationId: allocation.allocationId,
        inventoryLotId: allocation.inventoryLotId,
        releaseQty: allocation.releaseQty,
        unitCostMills: allocation.unitCostMills,
        poUnitCostMills: allocation.poUnitCostMills,
        packagingUnitCostMills: allocation.packagingUnitCostMills,
        landedUnitCostMills: allocation.landedUnitCostMills,
      })),
    });
    remaining -= take;
  }
  if (remaining !== BigInt(0)) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_RECONCILIATION_SOURCE_SHORTFALL",
      "The claim does not own enough open inventory at other locations to rebind this pick.",
      { claimLineId: line.id.toString(), requestedQty: quantity.toString(), shortfallQty: remaining.toString() },
    );
  }
  return releases;
}

async function requirePickableLocation(
  client: PoolClient,
  warehouseLocationId: number,
  orderWarehouseId: number | null,
): Promise<number> {
  const row = rows(await client.query(
    `SELECT warehouse_id, is_active, is_pickable, cycle_count_freeze_id
     FROM warehouse.warehouse_locations
     WHERE id = $1
     FOR SHARE`,
    [warehouseLocationId],
  ))[0];
  if (!row) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_NOT_FOUND",
      "The selected pick location does not exist.",
      { warehouseLocationId },
    );
  }
  const warehouseId = positiveInteger(row.warehouse_id, "warehouseLocation.warehouseId");
  if (orderWarehouseId != null && warehouseId !== orderWarehouseId) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_WRONG_WAREHOUSE",
      "The selected pick location does not belong to the order warehouse.",
      { warehouseLocationId, targetWarehouseId: warehouseId, orderWarehouseId },
    );
  }
  if (Number(row.is_active) !== 1 || Number(row.is_pickable) !== 1 || row.cycle_count_freeze_id != null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_UNAVAILABLE",
      "The selected location is inactive, non-pickable, or frozen for cycle count.",
      { warehouseLocationId },
    );
  }
  return warehouseId;
}

async function reconcilePickLocation(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  input: {
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    orderWarehouseId: number | null;
    warehouseLocationId: number;
    quantity: bigint;
    actor: string;
    reason: string;
    occurredAt: Date;
  },
): Promise<void> {
  const targetRow = rows(await client.query(
    `SELECT level.id AS inventory_level_id, location.warehouse_id,
            location.is_active, location.is_pickable, location.cycle_count_freeze_id
     FROM warehouse.warehouse_locations AS location
     LEFT JOIN inventory.inventory_levels AS level
       ON level.warehouse_location_id = location.id
      AND level.product_variant_id = $2
     WHERE location.id = $1`,
    [input.warehouseLocationId, input.line.targetVariantId],
  ))[0];
  if (!targetRow || targetRow.inventory_level_id == null) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_INVENTORY_MISSING",
      "The selected pick location has no recorded inventory level for the claim target variant.",
      { warehouseLocationId: input.warehouseLocationId, targetVariantId: input.line.targetVariantId },
    );
  }
  const targetWarehouseId = await requirePickableLocation(
    client,
    input.warehouseLocationId,
    input.orderWarehouseId,
  );
  const releases = selectReconciliationReleases(input.line, input.warehouseLocationId, input.quantity);
  const targetResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7)
     ON CONFLICT (
       claim_line_id, warehouse_id, warehouse_location_id, inventory_level_id,
       source_variant_id, COALESCE(consumer_operation_key, ''), COALESCE(producer_operation_key, '')
     ) DO UPDATE
       SET claimed_qty = inventory.availability_claim_resources.claimed_qty + EXCLUDED.claimed_qty,
           updated_at = $8
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.line.id.toString(),
      targetWarehouseId,
      input.warehouseLocationId,
      positiveInteger(targetRow.inventory_level_id, "inventoryLevel.id"),
      input.line.targetVariantId,
      input.quantity.toString(),
      input.occurredAt,
    ],
  ))[0];
  const targetResourceId = positiveBigInt(targetResourceRow?.id, "targetClaimResource.id");
  const allocations = await inventoryWriter.reconcilePickResource({
    client,
    claimId: input.claim.id,
    releases: releases.map((release) => release.inventory),
    target: {
      claimResourceId: targetResourceId,
      inventoryLevelId: positiveInteger(targetRow.inventory_level_id, "inventoryLevel.id"),
      warehouseLocationId: input.warehouseLocationId,
      sourceVariantId: input.line.targetVariantId,
      claimedQty: Number(input.quantity),
      orderItemId: input.line.orderItemId,
    },
    orderId: input.claim.orderId,
    actor: input.actor,
    reason: input.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of releases) {
    for (const allocation of release.allocations) {
      const updated = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updated.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_RECONCILIATION_STATE_CHANGED",
          "A source claim lot changed while pick-location reconciliation was recorded.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
    }
    const updated = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updated.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_STATE_CHANGED",
        "A source claim resource changed while pick-location reconciliation was recorded.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
  }
  for (const allocation of allocations) {
    const inserted = await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_resource_id, inventory_lot_id) DO UPDATE
         SET claimed_qty = inventory.availability_claim_lot_allocations.claimed_qty + EXCLUDED.claimed_qty,
             updated_at = $9
         WHERE inventory.availability_claim_lot_allocations.unit_cost_mills = EXCLUDED.unit_cost_mills
           AND inventory.availability_claim_lot_allocations.po_unit_cost_mills = EXCLUDED.po_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.packaging_unit_cost_mills = EXCLUDED.packaging_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.landed_unit_cost_mills = EXCLUDED.landed_unit_cost_mills
       RETURNING id`,
      [
        input.claim.id.toString(), targetResourceId.toString(), allocation.inventoryLotId, allocation.qty,
        allocation.unitCostMills.toString(), allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(), allocation.landedUnitCostMills.toString(), input.occurredAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_RECONCILIATION_COST_CHANGED",
        "The target FIFO lot cost no longer matches existing claim lineage.",
        { inventoryLotId: allocation.inventoryLotId },
      );
    }
  }
  const evidence = {
    schemaVersion: "inventory_availability_claim_pick_reconciliation_event_v1",
    eventType: "claim_pick_location_reconciled",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    orderItemId: input.line.orderItemId,
    targetWarehouseLocationId: input.warehouseLocationId,
    targetClaimResourceId: targetResourceId.toString(),
    quantity: input.quantity.toString(),
    releasedClaimResourceIds: releases.map((release) => release.inventory.claimResourceId.toString()),
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_pick_location_reconciled', 'active', 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.claim.id.toString(), JSON.stringify(evidence), hash(evidence), input.actor,
      input.reason, input.occurredAt,
    ],
  );
}

type PickerObservationCommand = Extract<
  CanonicalAvailabilityClaimPickCommand,
  { locationStrategy: "reconcile_picker_observation" }
>;

async function reconcileObservedPickLocation(
  client: PoolClient,
  inventoryWriter: CanonicalClaimInventoryMutationPort,
  observationReviewWriter: CanonicalClaimPickerObservationReviewPort,
  input: {
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    orderWarehouseId: number | null;
    quantity: bigint;
    command: PickerObservationCommand;
    requestHash: string;
    occurredAt: Date;
  },
): Promise<{
  inventoryReviewId: number;
  recordedReconciledQuantity: bigint;
  observedRelocatedQuantity: bigint;
}> {
  const targetRow = rows(await client.query(
    `SELECT location.warehouse_id, location.code,
            location.is_active, location.is_pickable, location.cycle_count_freeze_id
     FROM warehouse.warehouse_locations AS location
     WHERE location.id = $1`,
    [input.command.warehouseLocationId],
  ))[0];
  if (!targetRow) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_LOCATION_NOT_FOUND",
      "The observed pick location does not exist.",
      {
        warehouseLocationId: input.command.warehouseLocationId,
        targetVariantId: input.line.targetVariantId,
      },
    );
  }
  const targetLocationCode = String(targetRow.code ?? "").trim();
  if (targetLocationCode === ""
    || targetLocationCode.toUpperCase() !== input.command.observation.locationCode.trim().toUpperCase()) {
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_OBSERVATION_LOCATION_MISMATCH",
      "The observed location code does not match the selected warehouse location.",
      {
        warehouseLocationId: input.command.warehouseLocationId,
        observedLocationCode: input.command.observation.locationCode,
        actualLocationCode: targetLocationCode || null,
      },
    );
  }
  const targetWarehouseId = await requirePickableLocation(
    client,
    input.command.warehouseLocationId,
    input.orderWarehouseId,
  );
  const targetInventoryLevelId = await inventoryWriter.ensureInventoryLevel({
    client,
    productVariantId: input.line.targetVariantId,
    warehouseLocationId: input.command.warehouseLocationId,
    occurredAt: input.occurredAt,
  });
  const releases = selectReconciliationReleases(
    input.line,
    input.command.warehouseLocationId,
    input.quantity,
    targetWarehouseId,
  );
  const targetResourceRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_resources (
       claim_id, claim_line_id, consumer_operation_key, producer_operation_key,
       warehouse_id, warehouse_location_id, inventory_level_id, source_variant_id, claimed_qty
     ) VALUES ($1, $2, NULL, NULL, $3, $4, $5, $6, $7)
     ON CONFLICT (
       claim_line_id, warehouse_id, warehouse_location_id, inventory_level_id,
       source_variant_id, COALESCE(consumer_operation_key, ''), COALESCE(producer_operation_key, '')
     ) DO UPDATE
       SET claimed_qty = inventory.availability_claim_resources.claimed_qty + EXCLUDED.claimed_qty,
           updated_at = $8
     RETURNING id`,
    [
      input.claim.id.toString(),
      input.line.id.toString(),
      targetWarehouseId,
      input.command.warehouseLocationId,
      targetInventoryLevelId,
      input.line.targetVariantId,
      input.quantity.toString(),
      input.occurredAt,
    ],
  ))[0];
  const targetResourceId = positiveBigInt(targetResourceRow?.id, "targetClaimResource.id");
  const reconciled = await inventoryWriter.reconcileObservedPickResource({
    client,
    claimId: input.claim.id,
    releases: releases.map((release) => release.inventory),
    sourceCostLayers: releases.flatMap((release) => release.allocations.map((allocation) => ({
      inventoryLotId: allocation.inventoryLotId,
      quantity: allocation.releaseQty,
      unitCostMills: allocation.unitCostMills,
      poUnitCostMills: allocation.poUnitCostMills,
      packagingUnitCostMills: allocation.packagingUnitCostMills,
      landedUnitCostMills: allocation.landedUnitCostMills,
    }))),
    target: {
      claimResourceId: targetResourceId,
      inventoryLevelId: targetInventoryLevelId,
      warehouseLocationId: input.command.warehouseLocationId,
      sourceVariantId: input.line.targetVariantId,
      claimedQty: Number(input.quantity),
      orderItemId: input.line.orderItemId,
    },
    observationReference: input.requestHash,
    orderId: input.claim.orderId,
    actor: input.command.actor,
    reason: input.command.reason,
    occurredAt: input.occurredAt,
  });
  for (const release of releases) {
    for (const allocation of release.allocations) {
      const updated = await client.query(
        `UPDATE inventory.availability_claim_lot_allocations
         SET released_qty = released_qty + $1, updated_at = $3
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString(), input.occurredAt],
      );
      if (updated.rowCount !== 1) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "CLAIM_OBSERVATION_STATE_CHANGED",
          "A source claim lot changed while picker-observation reconciliation was recorded.",
          { claimLotAllocationId: allocation.allocationId.toString() },
        );
      }
    }
    const updated = await client.query(
      `UPDATE inventory.availability_claim_resources
       SET released_qty = released_qty + $1, updated_at = $3
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString(), input.occurredAt],
    );
    if (updated.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OBSERVATION_STATE_CHANGED",
        "A source claim resource changed while picker-observation reconciliation was recorded.",
        { claimResourceId: release.inventory.claimResourceId.toString() },
      );
    }
  }
  for (const allocation of reconciled.allocations) {
    const inserted = await client.query(
      `INSERT INTO inventory.availability_claim_lot_allocations (
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills,
         po_unit_cost_mills, packaging_unit_cost_mills, landed_unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (claim_resource_id, inventory_lot_id) DO UPDATE
         SET claimed_qty = inventory.availability_claim_lot_allocations.claimed_qty + EXCLUDED.claimed_qty,
             updated_at = $9
         WHERE inventory.availability_claim_lot_allocations.unit_cost_mills = EXCLUDED.unit_cost_mills
           AND inventory.availability_claim_lot_allocations.po_unit_cost_mills = EXCLUDED.po_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.packaging_unit_cost_mills = EXCLUDED.packaging_unit_cost_mills
           AND inventory.availability_claim_lot_allocations.landed_unit_cost_mills = EXCLUDED.landed_unit_cost_mills
       RETURNING id`,
      [
        input.claim.id.toString(),
        targetResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
        allocation.poUnitCostMills.toString(),
        allocation.packagingUnitCostMills.toString(),
        allocation.landedUnitCostMills.toString(),
        input.occurredAt,
      ],
    );
    if (inserted.rowCount !== 1) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_OBSERVATION_COST_CHANGED",
        "The reconciled FIFO lot cost no longer matches existing claim lineage.",
        { inventoryLotId: allocation.inventoryLotId },
      );
    }
  }
  const exceptionMetadata = {
    schemaVersion: "inventory_availability_claim_picker_observation_v1",
    pickerNonBlocking: true,
    shipmentBlocking: false,
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    observationKind: input.command.observation.kind,
    observedPhysicalQty: input.command.observation.observedPhysicalQty,
    systemLevelQtyBefore: reconciled.systemLevelQuantityBefore.toString(),
    systemLotQtyBefore: reconciled.systemLotQuantityBefore.toString(),
    recordedUnreservedQtyBefore: reconciled.recordedUnreservedQuantityBefore.toString(),
    recordedReconciledQty: reconciled.recordedReconciledQuantity.toString(),
    observedRelocatedQty: reconciled.observedRelocatedQuantity.toString(),
    relocatedInventoryLotIds: reconciled.relocatedInventoryLotIds,
    releasedClaimResourceIds: releases.map((release) => release.inventory.claimResourceId.toString()),
    deviceType: input.command.observation.deviceType ?? null,
    sessionId: input.command.observation.sessionId ?? null,
    actor: input.command.actor,
  } satisfies CanonicalClaimPickerObservationReviewMetadata;
  const inventoryReviewId = await observationReviewWriter.recordReview({
    client,
    orderId: input.claim.orderId,
    orderItemId: input.line.orderItemId,
    targetVariantId: input.line.targetVariantId,
    requestedQty: Number(input.command.quantity),
    selectedLocationId: input.command.warehouseLocationId,
    resolution: input.command.observation.kind === "validated_item_scan"
      ? "picker_scan_count_correction"
      : "picker_confirmed_count_correction",
    reviewReason: input.command.reason,
    metadata: exceptionMetadata,
    occurredAt: input.occurredAt,
  });
  const evidence = {
    schemaVersion: "inventory_availability_claim_picker_observation_event_v1",
    eventType: "claim_pick_observation_reconciled",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    orderItemId: input.line.orderItemId,
    targetWarehouseLocationId: input.command.warehouseLocationId,
    targetLocationCode,
    targetClaimResourceId: targetResourceId.toString(),
    quantity: input.quantity.toString(),
    inventoryReviewId,
    observation: exceptionMetadata,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, 'claim_pick_observation_reconciled', 'active', 'active', $2::jsonb, $3, $4, $5, $6)`,
    [
      input.claim.id.toString(),
      JSON.stringify(evidence),
      hash(evidence),
      input.command.actor,
      input.command.reason,
      input.occurredAt,
    ],
  );
  return {
    inventoryReviewId,
    recordedReconciledQuantity: reconciled.recordedReconciledQuantity,
    observedRelocatedQuantity: reconciled.observedRelocatedQuantity,
  };
}

async function persistPickCommandAndEvent(
  client: PoolClient,
  input: {
    claim: FulfillmentClaim;
    line: FulfillmentClaimLine;
    command: CanonicalAvailabilityClaimPickCommand | CanonicalAvailabilityClaimUnpickCommand;
    commandType: "pick" | "pick_observation" | "unpick";
    movementType: "pick" | "unpick";
    requestHash: string;
    result: CanonicalAvailabilityClaimPickResult;
    movements: Awaited<ReturnType<CanonicalClaimInventoryMutationPort["pickResources"]>>["movements"];
    occurredAt: Date;
  },
): Promise<void> {
  const commandRow = rows(await client.query(
    `INSERT INTO inventory.availability_claim_commands (
       claim_id, order_id, command_type, idempotency_key, request_hash, result_hash,
       request_payload, result_payload, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
     RETURNING id`,
    [
      input.claim.id.toString(), input.claim.orderId, input.commandType,
      input.command.idempotencyKey, input.requestHash, hash(input.result),
      JSON.stringify(input.command), JSON.stringify(input.result), input.command.actor,
      input.command.reason, input.occurredAt,
    ],
  ))[0];
  const commandId = positiveBigInt(commandRow?.id, "claimCommand.id");
  for (const movement of input.movements) {
    await client.query(
      `INSERT INTO inventory.availability_claim_pick_movements (
         claim_id, claim_line_id, claim_resource_id, claim_lot_allocation_id,
         inventory_lot_id, command_id, order_item_cost_id, movement_type, quantity,
         reverses_pick_movement_id, unit_cost_mills, total_cost_mills, occurred_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.claim.id.toString(), input.line.id.toString(), movement.claimResourceId.toString(),
        movement.claimLotAllocationId.toString(), movement.inventoryLotId, commandId.toString(),
        movement.orderItemCostId, input.movementType, movement.quantity.toString(),
        movement.reversesPickMovementId?.toString() ?? null, movement.unitCostMills.toString(),
        movement.totalCostMills.toString(), input.occurredAt,
      ],
    );
  }
  const evidence = {
    schemaVersion: "inventory_availability_claim_pick_event_v1",
    eventType: input.commandType === "unpick" ? "claim_line_unpicked" : "claim_line_picked",
    claimId: input.claim.id.toString(),
    claimLineId: input.line.id.toString(),
    result: input.result,
  };
  await client.query(
    `INSERT INTO inventory.availability_claim_events (
       claim_id, event_type, from_status, to_status, evidence_payload,
       evidence_hash, actor, reason, occurred_at
     ) VALUES ($1, $2, $3, $3, $4::jsonb, $5, $6, $7, $8)`,
    [
      input.claim.id.toString(), evidence.eventType, input.claim.status, JSON.stringify(evidence),
      hash(evidence), input.command.actor, input.command.reason, input.occurredAt,
    ],
  );
}

async function rollback(client: PoolClient, originalError: unknown): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Canonical claim transaction and rollback both failed.",
    );
  }
  throw originalError;
}

export class PostgresInventoryAvailabilityClaimRepository implements InventoryAvailabilityClaimStore {
  constructor(
    private readonly inventoryWriter: CanonicalClaimInventoryMutationPort,
    private readonly connectionPool: ClientPool = pool,
    private readonly clock: () => Date = () => new Date(),
    private readonly buildWriter?: CanonicalClaimBuildMutationPort,
    private readonly observationReviewWriter?: CanonicalClaimPickerObservationReviewPort,
  ) {}

  async claimOrder(rawCommand: CanonicalAvailabilityClaimCommand): Promise<CanonicalAvailabilityClaimResult> {
    const command = canonicalAvailabilityClaimCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical claim clock returned an invalid time.");
    }

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadCommandReplay(client, command.idempotencyKey, requestHash);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }

        const authority = await requireCanonicalAuthority(client);
        const preliminaryOrder = await loadOrder(client, command.orderId, false);
        if (["cancelled", "shipped"].includes(preliminaryOrder.warehouseStatus)
          || preliminaryOrder.lines.length === 0) {
          const result = await persistNoopCommand(client, command, "claim", requestHash, occurredAt);
          await client.query("COMMIT");
          return result;
        }

        const initialGraphProducts = await discoverActiveGraphProducts(
          client,
          preliminaryOrder.lines.map((line) => line.rootProductId),
        );
        await lockGraphProducts(client, initialGraphProducts);
        const preliminarySnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
          client,
          preliminaryOrder.lines.map((line) => line.targetVariantId),
        );
        await lockPlanningPolicyHeads(client, preliminarySnapshot);
        const lockedOrder = await loadOrder(client, command.orderId, true);
        if (["cancelled", "shipped"].includes(lockedOrder.warehouseStatus)
          || lockedOrder.lines.length === 0) {
          const result = await persistNoopCommand(client, command, "claim", requestHash, occurredAt);
          await client.query("COMMIT");
          return result;
        }
        const lockedGraphProducts = await discoverActiveGraphProducts(
          client,
          lockedOrder.lines.map((line) => line.rootProductId),
        );
        if (canonicalJson(initialGraphProducts) !== canonicalJson(lockedGraphProducts)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "TRANSFORMATION_GRAPH_CHANGED",
            "The active transformation graph changed while canonical claim locks were being acquired.",
            { initialGraphProducts, lockedGraphProducts },
          );
        }

        const activeClaim = await loadActiveClaim(client, command.orderId);
        if (activeClaim) {
          if (!await orderDemandMatchesClaim(client, lockedOrder, activeClaim)) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "ACTIVE_CLAIM_REPLACEMENT_REQUIRED",
              "The locked order demand differs from its active canonical claim and must be replaced atomically.",
              { orderId: command.orderId, claimId: activeClaim.id.toString() },
            );
          }
          const result = resultFromClaim(command.orderId, activeClaim, false);
          await persistCommandAndEvent(client, {
            claimId: activeClaim.id,
            command,
            requestHash,
            result,
            occurredAt,
            eventType: "claim_replayed",
          });
          await client.query("COMMIT");
          return result;
        }

        await lockSnapshotResources(client, preliminarySnapshot);
        const snapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
          client,
          lockedOrder.lines.map((line) => line.targetVariantId),
        );
        const revision = await nextClaimRevision(client, command.orderId);
        const request = buildPlanRequest(lockedOrder, revision);
        const plan = planCanonicalClaim(snapshot, request);
        if (plan.status === "blocked") {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CANONICAL_CLAIM_BLOCKED",
            "The active canonical planner blocked the whole-order claim.",
            { orderId: command.orderId, blockers: plan.blockers },
          );
        }

        const claimId = await insertClaimHeader(client, {
          order: lockedOrder,
          revision,
          authority,
          request,
          plan,
          command,
          occurredAt,
        });
        const lineIds = await insertClaimLines(client, claimId, lockedOrder, plan);
        await insertClaimOperations(client, claimId, lineIds, plan);
        await reserveClaimResources(
          client,
          this.inventoryWriter,
          claimId,
          lockedOrder,
          lineIds,
          plan,
          command.actor,
          occurredAt,
        );
        const result = resultFromClaim(command.orderId, {
          id: claimId,
          claimKey: request.requestKey,
          orderId: command.orderId,
          revision,
          runtimeAuthorityRevision: authority.revision,
          planHash: hash(plan),
          plan,
        }, false);
        await persistCommandAndEvent(client, {
          claimId,
          command,
          requestHash,
          result,
          occurredAt,
          eventType: "claim_reserved",
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_TRANSACTION_RETRY_EXHAUSTED",
      "Canonical claim transaction could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async replaceOrderClaim(
    rawCommand: CanonicalAvailabilityClaimReplacementCommand,
  ): Promise<CanonicalAvailabilityClaimReplacementResult> {
    const command = canonicalAvailabilityClaimReplacementCommandSchema.parse(rawCommand);
    const expectedClaimId = positiveBigInt(command.expectedClaimId, "replacement.expectedClaimId");
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLOCK",
        "Canonical claim replacement clock returned an invalid time.",
      );
    }

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadReplacementReplay(client, command.idempotencyKey, requestHash);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }

        const authority = await requireCanonicalAuthority(client);
        const preliminaryClaim = await loadActiveClaim(client, command.orderId, false);
        if (!preliminaryClaim) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_NOT_FOUND",
            "The order does not have an active canonical claim to replace.",
            { orderId: command.orderId, expectedClaimId: command.expectedClaimId },
          );
        }
        if (preliminaryClaim.id !== expectedClaimId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The order's active canonical claim does not match the expected replacement predecessor.",
            {
              orderId: command.orderId,
              expectedClaimId: command.expectedClaimId,
              activeClaimId: preliminaryClaim.id.toString(),
            },
          );
        }

        const preliminaryOrder = await loadOrder(client, command.orderId, false);
        if (["cancelled", "shipped"].includes(preliminaryOrder.warehouseStatus)
          || preliminaryOrder.lines.length === 0) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "REPLACEMENT_ORDER_NOT_CLAIMABLE",
            "A terminal order or an order without remaining claimable demand must use canonical release or cancellation.",
            { orderId: command.orderId, warehouseStatus: preliminaryOrder.warehouseStatus },
          );
        }
        const preliminaryClaimProducts = await loadClaimProductIds(client, preliminaryClaim);
        const preliminaryOrderProducts = await discoverActiveGraphProducts(
          client,
          preliminaryOrder.lines.map((line) => line.rootProductId),
        );
        const preliminaryGraphProducts = uniqueSorted([
          ...preliminaryClaimProducts,
          ...preliminaryOrderProducts,
        ]);
        if (preliminaryGraphProducts.length === 0 || preliminaryGraphProducts.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The replacement claim graph is empty or exceeds the bounded product limit.",
            { orderId: command.orderId, productCount: preliminaryGraphProducts.length },
          );
        }
        await lockGraphProducts(client, preliminaryGraphProducts);

        const preliminaryTargetVariantIds = uniqueSorted([
          ...preliminaryClaim.plan.lines.map((line) => line.targetVariantId),
          ...preliminaryOrder.lines.map((line) => line.targetVariantId),
        ]);
        const preliminarySnapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
          client,
          preliminaryTargetVariantIds,
        );
        await lockPlanningPolicyHeads(client, preliminarySnapshot);

        const lockedOrder = await loadOrder(client, command.orderId, true);
        if (["cancelled", "shipped"].includes(lockedOrder.warehouseStatus)
          || lockedOrder.lines.length === 0) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "REPLACEMENT_ORDER_NOT_CLAIMABLE",
            "The order became terminal or lost all claimable demand while replacement locks were being acquired.",
            { orderId: command.orderId, warehouseStatus: lockedOrder.warehouseStatus },
          );
        }
        const claim = await loadActiveClaim(client, command.orderId, true);
        if (!claim || claim.id !== preliminaryClaim.id || claim.id !== expectedClaimId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The active canonical claim changed while replacement locks were being acquired.",
            {
              orderId: command.orderId,
              expectedClaimId: command.expectedClaimId,
              preliminaryClaimId: preliminaryClaim.id.toString(),
              lockedClaimId: claim?.id.toString() ?? null,
            },
          );
        }
        const lockedTargetVariantIds = uniqueSorted([
          ...claim.plan.lines.map((line) => line.targetVariantId),
          ...lockedOrder.lines.map((line) => line.targetVariantId),
        ]);
        if (canonicalJson(preliminaryTargetVariantIds) !== canonicalJson(lockedTargetVariantIds)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ORDER_DEMAND_IDENTITY_CHANGED",
            "The order's target variant identities changed while replacement locks were being acquired.",
            { orderId: command.orderId, preliminaryTargetVariantIds, lockedTargetVariantIds },
          );
        }
        if (await orderDemandMatchesClaim(client, lockedOrder, claim)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ORDER_DEMAND_UNCHANGED",
            "The locked order demand still matches its active canonical claim.",
            { orderId: command.orderId, claimId: claim.id.toString() },
          );
        }

        const lockedClaimProducts = await loadClaimProductIds(client, claim);
        const lockedOrderProducts = await discoverActiveGraphProducts(
          client,
          lockedOrder.lines.map((line) => line.rootProductId),
        );
        const lockedGraphProducts = uniqueSorted([...lockedClaimProducts, ...lockedOrderProducts]);
        if (canonicalJson(preliminaryGraphProducts) !== canonicalJson(lockedGraphProducts)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "TRANSFORMATION_GRAPH_CHANGED",
            "The active transformation graph changed while replacement locks were being acquired.",
            { preliminaryGraphProducts, lockedGraphProducts },
          );
        }

        await lockSnapshotResources(client, preliminarySnapshot);
        const lifecycleCommand = { ...command, disposition: "supersede" as const };
        await cancelOpenBuildHandoffs(client, this.buildWriter, claim, lifecycleCommand, occurredAt);
        const released = await releaseClaimResources(client, {
          inventoryWriter: this.inventoryWriter,
          claim,
          orderId: command.orderId,
          actor: command.actor,
          reason: command.reason,
          disposition: "supersede",
          occurredAt,
        });

        const snapshot = await captureActiveClaimSupplySnapshotInsideTransaction(
          client,
          lockedOrder.lines.map((line) => line.targetVariantId),
        );
        const revision = await nextClaimRevision(client, command.orderId);
        const request = buildPlanRequest(lockedOrder, revision);
        const plan = planCanonicalClaim(snapshot, request);
        if (plan.status === "blocked") {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CANONICAL_CLAIM_REPLACEMENT_BLOCKED",
            "The active canonical planner blocked the whole-order replacement claim.",
            { orderId: command.orderId, supersededClaimId: claim.id.toString(), blockers: plan.blockers },
          );
        }

        const replacementClaimId = await insertClaimHeader(client, {
          order: lockedOrder,
          revision,
          authority,
          request,
          plan,
          command,
          supersedesClaimId: claim.id,
          occurredAt,
        });
        const lineIds = await insertClaimLines(client, replacementClaimId, lockedOrder, plan);
        await insertClaimOperations(client, replacementClaimId, lineIds, plan);
        await reserveClaimResources(
          client,
          this.inventoryWriter,
          replacementClaimId,
          lockedOrder,
          lineIds,
          plan,
          command.actor,
          occurredAt,
        );
        const replacementClaim: PersistedClaim = {
          id: replacementClaimId,
          claimKey: request.requestKey,
          orderId: command.orderId,
          revision,
          runtimeAuthorityRevision: authority.revision,
          planHash: hash(plan),
          plan,
        };
        const result = replacementResult(claim, replacementClaim, released, false);
        await persistReplacementCommandAndEvents(client, {
          supersededClaim: claim,
          replacementClaimId,
          command,
          requestHash,
          result,
          occurredAt,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_REPLACEMENT_RETRY_EXHAUSTED",
      "Canonical claim replacement could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async pickClaimLine(
    rawCommand: CanonicalAvailabilityClaimPickCommand,
  ): Promise<CanonicalAvailabilityClaimPickResult> {
    const command = canonicalAvailabilityClaimPickCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical pick clock returned an invalid time.");
    }
    const claimId = positiveBigInt(command.claimId, "claim.id");
    const quantity = BigInt(positiveInteger(command.quantity, "pick.quantity"));
    const commandType = command.locationStrategy === "reconcile_picker_observation"
      ? "pick_observation" as const
      : "pick" as const;

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadPickReplay(client, command.idempotencyKey, requestHash, commandType);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        await requireCanonicalAuthority(client);
        const preliminaryClaim = await loadClaimById(client, claimId, false);
        if (!preliminaryClaim || preliminaryClaim.status !== "active") {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_NOT_FOUND",
            "The requested canonical claim is not active.",
            { claimId: claimId.toString() },
          );
        }
        const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
        if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The active claim does not contain a bounded model-evidence graph.",
            { claimId: claimId.toString(), productCount: graphProductIds.length },
          );
        }
        await lockGraphProducts(client, graphProductIds);
        const order = await loadOrder(client, preliminaryClaim.orderId, true);
        if (["cancelled", "shipped"].includes(order.warehouseStatus) || order.onHold) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_ORDER_NOT_PICKABLE",
            "A cancelled, shipped, or held order cannot consume a canonical claim pick.",
            {
              claimId: claimId.toString(),
              orderId: order.orderId,
              warehouseStatus: order.warehouseStatus,
              onHold: order.onHold,
            },
          );
        }
        const claim = await loadClaimById(client, claimId, true);
        if (!claim || claim.status !== "active" || claim.orderId !== preliminaryClaim.orderId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The active canonical claim changed while fulfillment locks were being acquired.",
            { claimId: claimId.toString() },
          );
        }
        await requirePickableLocation(client, command.warehouseLocationId, order.warehouseId);
        let line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
        const openTarget = line.plannedQty - line.releasedTargetQty - line.consumedTargetQty - line.pickedTargetQty;
        if (openTarget < quantity) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_LINE_PICK_OVERAGE",
            "The pick exceeds the claim line's remaining planned target quantity.",
            { claimLineId: line.id.toString(), requestedQty: quantity.toString(), openQty: openTarget.toString() },
          );
        }
        const selectedOpen = line.resources
          .filter((resource) => resource.warehouseLocationId === command.warehouseLocationId)
          .reduce((total, resource) => total + openResourceQty(resource), BigInt(0));
        let reconciledQuantity = BigInt(0);
        let observationReconciliation: Awaited<ReturnType<typeof reconcileObservedPickLocation>> | null = null;
        if (selectedOpen >= quantity && command.locationStrategy === "reconcile_picker_observation") {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_OBSERVATION_NOT_REQUIRED",
            "The selected location already owns enough open claim inventory; use a normal strict pick.",
            {
              claimLineId: line.id.toString(),
              warehouseLocationId: command.warehouseLocationId,
              requestedQty: quantity.toString(),
              selectedOpenQty: selectedOpen.toString(),
            },
          );
        }
        if (selectedOpen < quantity) {
          reconciledQuantity = quantity - selectedOpen;
          if (command.locationStrategy === "strict") {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_PICK_LOCATION_SHORTFALL",
              "The selected location does not own enough open claim inventory and strict location mode forbids reallocation.",
              {
                claimLineId: line.id.toString(),
                warehouseLocationId: command.warehouseLocationId,
                requestedQty: quantity.toString(),
                selectedOpenQty: selectedOpen.toString(),
              },
            );
          }
          if (command.locationStrategy === "reconcile_picker_observation") {
            if (!this.observationReviewWriter) {
              throw new InventoryAvailabilityClaimRepositoryError(
                "CLAIM_PICK_OBSERVATION_REVIEW_WRITER_MISSING",
                "Picker-observation reconciliation requires an atomic warehouse-review writer.",
              );
            }
            observationReconciliation = await reconcileObservedPickLocation(
              client,
              this.inventoryWriter,
              this.observationReviewWriter,
              {
                claim,
                line,
                orderWarehouseId: order.warehouseId,
                quantity: reconciledQuantity,
                command,
                requestHash,
                occurredAt,
              },
            );
          } else {
            await reconcilePickLocation(client, this.inventoryWriter, {
              claim,
              line,
              orderWarehouseId: order.warehouseId,
              warehouseLocationId: command.warehouseLocationId,
              quantity: reconciledQuantity,
              actor: command.actor,
              reason: command.reason,
              occurredAt,
            });
          }
          line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
        }
        const pickResources = selectPickResources(line, command.warehouseLocationId, quantity);
        const picked = await this.inventoryWriter.pickResources({
          client,
          claimId: claim.id,
          claimLineId: line.id,
          resources: pickResources,
          orderId: claim.orderId,
          orderItemId: line.orderItemId,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        });
        for (const resource of pickResources) {
          for (const allocation of resource.lotAllocations) {
            const updated = await client.query(
              `UPDATE inventory.availability_claim_lot_allocations
               SET picked_qty = picked_qty + $1, updated_at = $3
               WHERE id = $2
                 AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
              [allocation.pickQty.toString(), allocation.claimLotAllocationId.toString(), occurredAt],
            );
            if (updated.rowCount !== 1) {
              throw new InventoryAvailabilityClaimRepositoryError(
                "CLAIM_PICK_STATE_CHANGED",
                "A claim lot allocation changed while its pick was recorded.",
                { claimLotAllocationId: allocation.claimLotAllocationId.toString() },
              );
            }
          }
          const updated = await client.query(
            `UPDATE inventory.availability_claim_resources
             SET picked_qty = picked_qty + $1, updated_at = $3
             WHERE id = $2
               AND claimed_qty - released_qty - consumed_qty - picked_qty >= $1`,
            [resource.pickQty.toString(), resource.claimResourceId.toString(), occurredAt],
          );
          if (updated.rowCount !== 1) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_PICK_STATE_CHANGED",
              "A claim resource changed while its pick was recorded.",
              { claimResourceId: resource.claimResourceId.toString() },
            );
          }
        }
        const updatedLine = await client.query(
          `UPDATE inventory.availability_claim_lines
           SET picked_target_qty = picked_target_qty + $1, updated_at = $3
           WHERE id = $2
             AND planned_qty - released_target_qty - consumed_target_qty - picked_target_qty >= $1`,
          [quantity.toString(), line.id.toString(), occurredAt],
        );
        if (updatedLine.rowCount !== 1) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_PICK_STATE_CHANGED",
            "The claim line changed while its pick was recorded.",
            { claimLineId: line.id.toString() },
          );
        }
        const commonResult = {
          claimId: claim.id.toString(),
          claimLineId: line.id.toString(),
          orderId: claim.orderId,
          orderItemId: line.orderItemId,
          warehouseLocationIds: [command.warehouseLocationId],
          quantity: quantity.toString(),
          reconciledQuantity: reconciledQuantity.toString(),
          totalCostMills: picked.totalCostMills.toString(),
          idempotentReplay: false,
        };
        const result = canonicalAvailabilityClaimPickResultSchema.parse(
          command.locationStrategy === "reconcile_picker_observation" && observationReconciliation
            ? {
                outcome: "picked_with_observation",
                ...commonResult,
                recordedReconciledQuantity: observationReconciliation.recordedReconciledQuantity.toString(),
                observedRelocatedQuantity: observationReconciliation.observedRelocatedQuantity.toString(),
                inventoryReviewId: observationReconciliation.inventoryReviewId,
                observationKind: command.observation.kind,
              }
            : { outcome: "picked", ...commonResult },
        );
        await persistPickCommandAndEvent(client, {
          claim,
          line,
          command,
          commandType,
          movementType: "pick",
          requestHash,
          result,
          movements: picked.movements,
          occurredAt,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_PICK_RETRY_EXHAUSTED",
      "Canonical claim pick could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async unpickClaimLine(
    rawCommand: CanonicalAvailabilityClaimUnpickCommand,
  ): Promise<CanonicalAvailabilityClaimPickResult> {
    const command = canonicalAvailabilityClaimUnpickCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical unpick clock returned an invalid time.");
    }
    const claimId = positiveBigInt(command.claimId, "claim.id");
    const quantity = BigInt(positiveInteger(command.quantity, "unpick.quantity"));

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadPickReplay(client, command.idempotencyKey, requestHash, "unpick");
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        await requireCanonicalAuthority(client);
        const preliminaryClaim = await loadClaimById(client, claimId, false);
        if (!preliminaryClaim) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_NOT_FOUND",
            "The requested canonical claim does not exist.",
            { claimId: claimId.toString() },
          );
        }
        const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
        if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The claim does not contain a bounded model-evidence graph.",
            { claimId: claimId.toString(), productCount: graphProductIds.length },
          );
        }
        await lockGraphProducts(client, graphProductIds);
        const order = await loadOrder(client, preliminaryClaim.orderId, true);
        if (["packing", "packed", "shipped"].includes(order.warehouseStatus) || order.onHold) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_ORDER_NOT_UNPICKABLE",
            "A held, packing, packed, or shipped order cannot reverse a canonical pick.",
            { orderId: order.orderId, warehouseStatus: order.warehouseStatus, onHold: order.onHold },
          );
        }
        const claim = await loadClaimById(client, claimId, true);
        if (!claim || claim.orderId !== preliminaryClaim.orderId || claim.status !== preliminaryClaim.status) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_CHANGED",
            "The canonical claim changed while unpick locks were being acquired.",
            { claimId: claimId.toString() },
          );
        }
        const line = await loadFulfillmentClaimLine(client, claim.id, command.orderItemId);
        if (line.pickedTargetQty < quantity) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_LINE_UNPICK_OVERAGE",
            "The unpick exceeds the claim line's currently picked quantity.",
            { claimLineId: line.id.toString(), requestedQty: quantity.toString(), pickedQty: line.pickedTargetQty.toString() },
          );
        }
        const movementRows = rows(await client.query(
          `SELECT movement.id, movement.claim_resource_id, movement.claim_lot_allocation_id,
                  movement.inventory_lot_id, movement.movement_type, movement.quantity,
                  movement.reverses_pick_movement_id,
                  resource.inventory_level_id, resource.warehouse_location_id,
                  resource.source_variant_id,
                  cost.order_id AS cost_order_id, cost.order_item_id AS cost_order_item_id,
                  cost.inventory_lot_id AS cost_inventory_lot_id,
                  cost.product_variant_id AS cost_product_variant_id,
                  cost.qty AS cost_qty, cost.unit_cost_mills, cost.total_cost_mills
           FROM inventory.availability_claim_pick_movements AS movement
           JOIN inventory.availability_claim_resources AS resource
             ON resource.id = movement.claim_resource_id AND resource.claim_id = movement.claim_id
           JOIN oms.order_item_costs AS cost ON cost.id = movement.order_item_cost_id
           WHERE movement.claim_id = $1 AND movement.claim_line_id = $2
           ORDER BY movement.id
           FOR UPDATE OF movement, cost`,
          [claim.id.toString(), line.id.toString()],
        ));
        const reversedByPick = new Map<string, bigint>();
        for (const row of movementRows) {
          if (String(row.movement_type) !== "unpick") continue;
          const reverseId = positiveBigInt(row.reverses_pick_movement_id, "unpickMovement.reversesPickMovementId").toString();
          reversedByPick.set(reverseId, (reversedByPick.get(reverseId) ?? BigInt(0))
            + positiveBigInt(row.quantity, "unpickMovement.quantity"));
        }
        let remaining = quantity;
        const selectedRows: Array<{ row: any; quantity: bigint }> = [];
        for (const row of [...movementRows].reverse()) {
          if (remaining === BigInt(0)) break;
          if (String(row.movement_type) !== "pick") continue;
          const movementId = positiveBigInt(row.id, "pickMovement.id");
          const pickedQty = positiveBigInt(row.quantity, "pickMovement.quantity");
          const available = pickedQty - (reversedByPick.get(movementId.toString()) ?? BigInt(0));
          if (available < BigInt(0)) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_UNPICK_LINEAGE_MISMATCH",
              "Compensating unpick movements exceed their original pick movement.",
              { pickMovementId: movementId.toString() },
            );
          }
          const take = available < remaining ? available : remaining;
          if (take > BigInt(0)) selectedRows.push({ row, quantity: take });
          remaining -= take;
        }
        if (remaining !== BigInt(0)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_UNPICK_MOVEMENT_SHORTFALL",
            "Append-only pick movements do not contain enough unreversed quantity.",
            { claimLineId: line.id.toString(), shortfallQty: remaining.toString() },
          );
        }
        const byResource = new Map<string, CanonicalClaimInventoryUnpickResource>();
        for (const selected of selectedRows) {
          const row = selected.row;
          const movementQty = positiveBigInt(row.quantity, "pickMovement.quantity");
          const costQty = positiveBigInt(row.cost_qty, "orderItemCost.qty");
          const unitCostMills = nonnegativeBigInt(row.unit_cost_mills, "orderItemCost.unitCostMills");
          const totalCostMills = nonnegativeBigInt(row.total_cost_mills, "orderItemCost.totalCostMills");
          if (positiveInteger(row.cost_order_id, "orderItemCost.orderId") !== claim.orderId
            || positiveInteger(row.cost_order_item_id, "orderItemCost.orderItemId") !== line.orderItemId
            || positiveInteger(row.cost_inventory_lot_id, "orderItemCost.inventoryLotId")
              !== positiveInteger(row.inventory_lot_id, "pickMovement.inventoryLotId")
            || positiveInteger(row.cost_product_variant_id, "orderItemCost.productVariantId")
              !== positiveInteger(row.source_variant_id, "claimResource.sourceVariantId")
            || costQty !== movementQty
            || totalCostMills !== unitCostMills * costQty) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_PICK_COGS_EVIDENCE_INVALID",
              "The original canonical pick COGS row does not match its immutable movement identity or cost.",
              { pickMovementId: String(row.id) },
            );
          }
          const resourceId = positiveBigInt(row.claim_resource_id, "claimResource.id");
          const key = resourceId.toString();
          const existing = byResource.get(key) ?? {
            claimResourceId: resourceId,
            inventoryLevelId: positiveInteger(row.inventory_level_id, "claimResource.inventoryLevelId"),
            warehouseLocationId: positiveInteger(row.warehouse_location_id, "claimResource.warehouseLocationId"),
            sourceVariantId: positiveInteger(row.source_variant_id, "claimResource.sourceVariantId"),
            unpickQty: BigInt(0),
            lotAllocations: [],
          };
          const allocation = {
            claimLotAllocationId: positiveBigInt(row.claim_lot_allocation_id, "claimLotAllocation.id"),
            inventoryLotId: positiveInteger(row.inventory_lot_id, "inventoryLot.id"),
            unpickQty: selected.quantity,
            reversesPickMovementId: positiveBigInt(row.id, "pickMovement.id"),
            unitCostMills,
          };
          byResource.set(key, {
            ...existing,
            unpickQty: existing.unpickQty + selected.quantity,
            lotAllocations: [...existing.lotAllocations, allocation],
          });
        }
        const restoreReservation = claim.status === "active";
        const unpicked = await this.inventoryWriter.unpickResources({
          client,
          claimId: claim.id,
          claimLineId: line.id,
          resources: [...byResource.values()],
          orderId: claim.orderId,
          orderItemId: line.orderItemId,
          restoreReservation,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        });
        for (const resource of byResource.values()) {
          for (const allocation of resource.lotAllocations) {
            const updated = await client.query(
              `UPDATE inventory.availability_claim_lot_allocations
               SET picked_qty = picked_qty - $1,
                   released_qty = released_qty + $2,
                   updated_at = $4
               WHERE id = $3 AND picked_qty >= $1`,
              [
                allocation.unpickQty.toString(),
                restoreReservation ? "0" : allocation.unpickQty.toString(),
                allocation.claimLotAllocationId.toString(),
                occurredAt,
              ],
            );
            if (updated.rowCount !== 1) {
              throw new InventoryAvailabilityClaimRepositoryError(
                "CLAIM_UNPICK_STATE_CHANGED",
                "A claim lot allocation changed while its unpick was recorded.",
                { claimLotAllocationId: allocation.claimLotAllocationId.toString() },
              );
            }
          }
          const updated = await client.query(
            `UPDATE inventory.availability_claim_resources
             SET picked_qty = picked_qty - $1,
                 released_qty = released_qty + $2,
                 updated_at = $4
             WHERE id = $3 AND picked_qty >= $1`,
            [
              resource.unpickQty.toString(),
              restoreReservation ? "0" : resource.unpickQty.toString(),
              resource.claimResourceId.toString(),
              occurredAt,
            ],
          );
          if (updated.rowCount !== 1) {
            throw new InventoryAvailabilityClaimRepositoryError(
              "CLAIM_UNPICK_STATE_CHANGED",
              "A claim resource changed while its unpick was recorded.",
              { claimResourceId: resource.claimResourceId.toString() },
            );
          }
        }
        const updatedLine = await client.query(
          `UPDATE inventory.availability_claim_lines
           SET picked_target_qty = picked_target_qty - $1,
               released_target_qty = released_target_qty + $2,
               updated_at = $4
           WHERE id = $3 AND picked_target_qty >= $1`,
          [quantity.toString(), restoreReservation ? "0" : quantity.toString(), line.id.toString(), occurredAt],
        );
        if (updatedLine.rowCount !== 1) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_UNPICK_STATE_CHANGED",
            "The claim line changed while its unpick was recorded.",
            { claimLineId: line.id.toString() },
          );
        }
        const locationIds = uniqueSorted([...byResource.values()].map((resource) => resource.warehouseLocationId));
        const result = canonicalAvailabilityClaimPickResultSchema.parse({
          outcome: "unpicked",
          claimId: claim.id.toString(),
          claimLineId: line.id.toString(),
          orderId: claim.orderId,
          orderItemId: line.orderItemId,
          warehouseLocationIds: locationIds,
          quantity: quantity.toString(),
          reservationRestored: restoreReservation,
          totalCostMills: unpicked.totalCostMills.toString(),
          idempotentReplay: false,
        });
        await persistPickCommandAndEvent(client, {
          claim,
          line,
          command,
          commandType: "unpick",
          movementType: "unpick",
          requestHash,
          result,
          movements: unpicked.movements,
          occurredAt,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_UNPICK_RETRY_EXHAUSTED",
      "Canonical claim unpick could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async handoffBuildOperation(
    rawCommand: CanonicalAvailabilityClaimBuildHandoffCommand,
  ): Promise<CanonicalAvailabilityClaimBuildHandoffResult> {
    const command = canonicalAvailabilityClaimBuildHandoffCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLOCK",
        "Canonical build-handoff clock returned an invalid time.",
      );
    }
    const claimId = positiveBigInt(command.claimId, "claim.id");

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadBuildHandoffReplay(client, command.idempotencyKey, requestHash);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        await requireCanonicalAuthority(client);
        if (!this.buildWriter) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_BUILD_HANDOFF_NOT_CONFIGURED",
            "The canonical build handoff port is not configured.",
          );
        }
        const preliminaryClaim = await loadActiveClaimById(client, claimId, false);
        if (!preliminaryClaim) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_NOT_FOUND",
            "The requested canonical claim is not active.",
            { claimId: claimId.toString() },
          );
        }
        const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
        if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The active claim does not contain a bounded model-evidence graph.",
            { claimId: claimId.toString(), productCount: graphProductIds.length },
          );
        }
        await lockGraphProducts(client, graphProductIds);
        const order = await loadOrder(client, preliminaryClaim.orderId, true);
        if (["cancelled", "shipped"].includes(order.warehouseStatus)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_ORDER_NOT_EXECUTABLE",
            "A cancelled or shipped order cannot hand off a claim build.",
            { claimId: claimId.toString(), orderId: order.orderId, warehouseStatus: order.warehouseStatus },
          );
        }
        const claim = await loadActiveClaimById(client, claimId, true);
        if (!claim || claim.id !== preliminaryClaim.id || claim.orderId !== preliminaryClaim.orderId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The active canonical claim changed while build-handoff locks were being acquired.",
            { claimId: claimId.toString() },
          );
        }
        const operation = await lockBuildOperation(client, claim.id, command.operationKey);
        const plannedOperation = assertOperationMatchesPlan(claim, operation);
        const resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
        const handoff = await this.buildWriter.handoffOperation({
          client,
          claimId: claim.id,
          claimOperationId: operation.id,
          operationKey: operation.operationKey,
          transformationRecipeBindingId: operation.authorityId,
          warehouseId: operation.warehouseId,
          plannedBuilds: operation.plannedExecutions,
          destinationVariantId: operation.destinationVariantId,
          outputLocationId: operation.outputLocationId,
          outputQty: operation.outputQty,
          inputs: plannedOperation.inputs.map((input) => ({
            sourceVariantId: input.sourceVariantId,
            requiredQty: positiveBigInt(input.requiredQty, "plannedOperation.input.requiredQty"),
          })),
          resources,
          actor: command.actor,
          occurredAt,
        });
        const result = await recordBuildHandoff(client, {
          claim,
          operation,
          command,
          requestHash,
          buildOrderId: handoff.buildOrderId,
          buildSystemNumber: handoff.buildSystemNumber,
          adoptedReservationQty: handoff.adoptedReservationQty,
          occurredAt,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_HANDOFF_RETRY_EXHAUSTED",
      "Canonical build handoff could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async executeBuildOperation(
    rawCommand: CanonicalAvailabilityClaimOperationExecutionCommand,
  ): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
    const command = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLOCK",
        "Canonical build-execution clock returned an invalid time.",
      );
    }
    const claimId = positiveBigInt(command.claimId, "claim.id");

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadOperationExecutionReplay(
          client,
          command.idempotencyKey,
          requestHash,
          "execute_build",
        );
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        await requireCanonicalAuthority(client);
        if (!this.buildWriter) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_BUILD_EXECUTION_NOT_CONFIGURED",
            "The canonical build execution port is not configured.",
          );
        }
        const preliminaryClaim = await loadActiveClaimById(client, claimId, false);
        if (!preliminaryClaim) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_NOT_FOUND",
            "The requested canonical claim is not active.",
            { claimId: claimId.toString() },
          );
        }
        const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
        if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The active claim does not contain a bounded model-evidence graph.",
            { claimId: claimId.toString(), productCount: graphProductIds.length },
          );
        }
        await lockGraphProducts(client, graphProductIds);
        const order = await loadOrder(client, preliminaryClaim.orderId, true);
        if (["cancelled", "shipped"].includes(order.warehouseStatus)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_ORDER_NOT_EXECUTABLE",
            "A cancelled or shipped order cannot execute a claim build.",
            { claimId: claimId.toString(), orderId: order.orderId, warehouseStatus: order.warehouseStatus },
          );
        }
        const claim = await loadActiveClaimById(client, claimId, true);
        if (!claim || claim.id !== preliminaryClaim.id || claim.orderId !== preliminaryClaim.orderId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The active canonical claim changed while build-execution locks were being acquired.",
            { claimId: claimId.toString() },
          );
        }
        const locked = await lockHandedOffBuildOperation(client, claim.id, command.operationKey);
        const plannedOperation = assertOperationMatchesPlan(claim, locked.operation);
        const resources = await loadOperationExecutionResources(
          client,
          claim.id,
          locked.operation,
          plannedOperation,
        );
        const execution = await this.buildWriter.executeOperation({
          client,
          claimId: claim.id,
          claimOperationId: locked.operation.id,
          operationKey: locked.operation.operationKey,
          buildOrderId: locked.handoff.buildOrderId,
          warehouseId: locked.operation.warehouseId,
          plannedBuilds: locked.operation.plannedExecutions,
          destinationVariantId: locked.operation.destinationVariantId,
          outputLocationId: locked.operation.outputLocationId,
          outputQty: locked.operation.outputQty,
          committedOutputQty: locked.operation.committedOutputQty,
          inputs: plannedOperation.inputs.map((entry) => ({
            sourceVariantId: entry.sourceVariantId,
            requiredQty: positiveBigInt(entry.requiredQty, "plannedOperation.input.requiredQty"),
          })),
          resources,
          orderId: claim.orderId,
          orderItemId: locked.operation.orderItemId,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        });
        const result = await recordOperationExecution(client, {
          claim,
          operation: locked.operation,
          resources,
          command,
          requestHash,
          outputInventoryLevelId: execution.outputInventoryLevelId,
          committedLotAllocations: execution.committedLotAllocations,
          totalInputCostMills: execution.totalInputCostMills,
          occurredAt,
          commandType: "execute_build",
          eventType: "claim_build_executed",
          buildHandoffId: locked.handoff.id,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_BUILD_EXECUTION_RETRY_EXHAUSTED",
      "Canonical build execution could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async executePackageOperation(
    rawCommand: CanonicalAvailabilityClaimOperationExecutionCommand,
  ): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
    const command = canonicalAvailabilityClaimOperationExecutionCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLOCK",
        "Canonical operation clock returned an invalid time.",
      );
    }
    const claimId = positiveBigInt(command.claimId, "claim.id");

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadOperationExecutionReplay(
          client,
          command.idempotencyKey,
          requestHash,
          "execute",
        );
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        await requireCanonicalAuthority(client);
        const preliminaryClaim = await loadActiveClaimById(client, claimId, false);
        if (!preliminaryClaim) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_NOT_FOUND",
            "The requested canonical claim is not active.",
            { claimId: claimId.toString() },
          );
        }
        const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
        if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The active claim does not contain a bounded model-evidence graph.",
            { claimId: claimId.toString(), productCount: graphProductIds.length },
          );
        }
        await lockGraphProducts(client, graphProductIds);
        const order = await loadOrder(client, preliminaryClaim.orderId, true);
        if (["cancelled", "shipped"].includes(order.warehouseStatus)) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "CLAIM_ORDER_NOT_EXECUTABLE",
            "A cancelled or shipped order cannot execute a claim transformation.",
            { claimId: claimId.toString(), orderId: order.orderId, warehouseStatus: order.warehouseStatus },
          );
        }
        const claim = await loadActiveClaimById(client, claimId, true);
        if (!claim || claim.id !== preliminaryClaim.id || claim.orderId !== preliminaryClaim.orderId) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The active canonical claim changed while operation locks were being acquired.",
            { claimId: claimId.toString() },
          );
        }
        const operation = await lockPackageOperation(client, claim.id, command.operationKey);
        const plannedOperation = assertOperationMatchesPlan(claim, operation);
        const resources = await loadOperationExecutionResources(client, claim.id, operation, plannedOperation);
        const execution = await this.inventoryWriter.executePackageOperation({
          client,
          claimId: claim.id,
          claimOperationId: operation.id,
          operationKey: operation.operationKey,
          operationType: operation.operationType,
          resources,
          destinationVariantId: operation.destinationVariantId,
          outputLocationId: operation.outputLocationId,
          outputQty: operation.outputQty,
          committedOutputQty: operation.committedOutputQty,
          orderId: claim.orderId,
          orderItemId: operation.orderItemId,
          actor: command.actor,
          reason: command.reason,
          occurredAt,
        });
        const result = await recordOperationExecution(client, {
          claim,
          operation,
          resources,
          command,
          requestHash,
          outputInventoryLevelId: execution.outputInventoryLevelId,
          committedLotAllocations: execution.committedLotAllocations,
          totalInputCostMills: execution.totalInputCostMills,
          occurredAt,
          commandType: "execute",
          eventType: "claim_operation_executed",
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_TRANSACTION_RETRY_EXHAUSTED",
      "Canonical operation execution could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }

  async releaseOrderClaim(
    rawCommand: CanonicalAvailabilityClaimReleaseCommand,
  ): Promise<CanonicalAvailabilityClaimResult> {
    const command = canonicalAvailabilityClaimReleaseCommandSchema.parse(rawCommand);
    const requestHash = hash(command);
    const occurredAt = this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new InventoryAvailabilityClaimRepositoryError("INVALID_CLOCK", "Canonical claim clock returned an invalid time.");
    }

    let lastRetryableError: unknown;
    for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
      const client = await this.connectionPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
        const replay = await loadCommandReplay(client, command.idempotencyKey, requestHash);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }
        await requireCanonicalAuthority(client);

        const preliminaryClaim = await loadActiveClaim(client, command.orderId, false);
        if (!preliminaryClaim) {
          await loadOrder(client, command.orderId, true);
          const result = await persistNoopCommand(
            client,
            command,
            command.disposition === "cancel" ? "cancel" : "release",
            requestHash,
            occurredAt,
          );
          await client.query("COMMIT");
          return result;
        }
        const graphProductIds = await loadClaimProductIds(client, preliminaryClaim);
        if (graphProductIds.length === 0 || graphProductIds.length > MAX_GRAPH_PRODUCTS) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "INVALID_CLAIM_MODEL_EVIDENCE",
            "The active claim does not contain a bounded model-evidence graph.",
            { claimId: preliminaryClaim.id.toString(), productCount: graphProductIds.length },
          );
        }
        await lockGraphProducts(client, graphProductIds);
        await loadOrder(client, command.orderId, true);
        const claim = await loadActiveClaim(client, command.orderId, true);
        if (!claim || claim.id !== preliminaryClaim.id) {
          throw new InventoryAvailabilityClaimRepositoryError(
            "ACTIVE_CLAIM_CHANGED",
            "The active canonical claim changed while release locks were being acquired.",
            { orderId: command.orderId, preliminaryClaimId: preliminaryClaim.id.toString() },
          );
        }
        await cancelOpenBuildHandoffs(client, this.buildWriter, claim, command, occurredAt);
        const released = await releaseClaimResources(client, {
          inventoryWriter: this.inventoryWriter,
          claim,
          orderId: command.orderId,
          actor: command.actor,
          reason: command.reason,
          disposition: command.disposition,
          occurredAt,
        });
        const result = canonicalAvailabilityClaimResultSchema.parse({
          outcome: "released",
          claimId: claim.id.toString(),
          claimKey: claim.claimKey,
          orderId: command.orderId,
          status: command.disposition === "cancel" ? "cancelled" : "released",
          releasedResourceQty: released.releasedResourceQty.toString(),
          releasedLotQty: released.releasedLotQty.toString(),
          idempotentReplay: false,
        });
        await persistReleaseCommandAndEvent(client, {
          claim,
          command,
          requestHash,
          result,
          occurredAt,
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await rollback(client, error);
        } catch (rolledBackError) {
          if (isRetryableTransactionError(rolledBackError) && attempt < MAX_SERIALIZATION_ATTEMPTS) {
            lastRetryableError = rolledBackError;
            continue;
          }
          if (isRetryableTransactionError(rolledBackError)) {
            lastRetryableError = rolledBackError;
            break;
          }
          throw rolledBackError;
        }
      } finally {
        client.release();
      }
    }
    throw new InventoryAvailabilityClaimRepositoryError(
      "CLAIM_RELEASE_RETRY_EXHAUSTED",
      "Canonical claim release could not serialize after bounded retries.",
      { attempts: MAX_SERIALIZATION_ATTEMPTS },
      { cause: lastRetryableError },
    );
  }
}
