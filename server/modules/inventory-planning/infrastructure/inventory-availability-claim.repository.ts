import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { pool } from "../../../db";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  canonicalAvailabilityClaimCommandSchema,
  canonicalAvailabilityClaimReleaseCommandSchema,
  canonicalAvailabilityClaimResultSchema,
  type CanonicalAvailabilityClaimCommand,
  type CanonicalAvailabilityClaimReleaseCommand,
  type CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";
import {
  claimPlanRequestSchema,
  claimPlanSchema,
  type ClaimPlanDto,
  type ClaimPlanRequestDto,
  type ClaimSupplySnapshotDto,
} from "@shared/types/inventory-availability-planner";
import type {
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimInventoryReleaseResource,
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
  lines: OrderLine[];
};

type RuntimeAuthority = {
  activationRunId: bigint;
  revision: bigint;
};

type PersistedClaim = {
  id: bigint;
  claimKey: string;
  revision: number;
  runtimeAuthorityRevision: bigint;
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
  if (code === "40001" || code === "40P01") return true;
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

export interface InventoryAvailabilityClaimStore {
  claimOrder(command: CanonicalAvailabilityClaimCommand): Promise<CanonicalAvailabilityClaimResult>;
  releaseOrderClaim(command: CanonicalAvailabilityClaimReleaseCommand): Promise<CanonicalAvailabilityClaimResult>;
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
    `SELECT id AS order_id, warehouse_id, warehouse_status
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
  return {
    orderId: positiveInteger(orderRow.order_id, "order.id"),
    warehouseId: orderRow.warehouse_id == null
      ? null
      : positiveInteger(orderRow.warehouse_id, "order.warehouseId"),
    warehouseStatus: String(orderRow.warehouse_status ?? ""),
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
    `SELECT id, claim_key, revision, runtime_authority_revision, plan_payload
     FROM inventory.availability_claims
     WHERE order_id = $1 AND status = 'active'
     ${lock ? "FOR UPDATE" : ""}`,
    [orderId],
  ))[0];
  if (!row) return null;
  return {
    id: positiveBigInt(row.id, "claim.id"),
    claimKey: String(row.claim_key),
    revision: positiveInteger(row.revision, "claim.revision"),
    runtimeAuthorityRevision: positiveBigInt(row.runtime_authority_revision, "claim.runtimeAuthorityRevision"),
    plan: claimPlanSchema.parse(row.plan_payload),
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

function orderDemandMatchesClaim(order: LockedOrder, claim: PersistedClaim): boolean {
  const currentScope = order.warehouseId == null
    ? { kind: "network" as const }
    : { kind: "warehouse" as const, warehouseId: order.warehouseId };
  if (canonicalJson(currentScope) !== canonicalJson(claim.plan.scope)) return false;
  const current = order.lines.map((line) => ({
    lineKey: `order-item:${line.orderItemId}`,
    targetVariantId: line.targetVariantId,
    requestedQty: String(line.requestedQty),
  }));
  const persisted = claim.plan.lines.map((line) => ({
    lineKey: line.lineKey,
    targetVariantId: line.targetVariantId,
    requestedQty: line.requestedQty,
  }));
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
    command: CanonicalAvailabilityClaimCommand;
    occurredAt: Date;
  },
): Promise<bigint> {
  const inserted = rows(await client.query(
    `INSERT INTO inventory.availability_claims (
       claim_key, order_id, revision, status, plan_status, scope_kind, scope_warehouse_id,
       activation_run_id, runtime_authority_revision, request_hash, plan_hash,
       snapshot_fingerprint, request_payload, plan_payload, model_evidence,
       requested_by, reason, reserved_at
     ) VALUES (
       $1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10, $11,
       $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17
     )
     RETURNING id`,
    [
      input.request.requestKey,
      input.order.orderId,
      input.revision,
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
         output_qty, output_location_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
         claim_id, claim_resource_id, inventory_lot_id, claimed_qty, unit_cost_mills
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        input.claimId.toString(),
        claimResourceId.toString(),
        allocation.inventoryLotId,
        allocation.qty,
        allocation.unitCostMills.toString(),
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
    disposition: "release" | "cancel";
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
             allocation.consumed_qty
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
    const open = claimed - released - consumed;
    if (open < BigInt(0)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "INVALID_CLAIM_RESOURCE_BALANCE",
        "A canonical claim resource has released or consumed more than it claimed.",
        { claimResourceId: String(resource.id), claimed: claimed.toString(), released: released.toString(), consumed: consumed.toString() },
      );
    }

    const openLotAllocations: Array<{ allocationId: bigint; inventoryLotId: number; releaseQty: bigint }> = [];
    let attributedOpen = BigInt(0);
    for (const lot of lotsByResource.get(String(resource.id)) ?? []) {
      const lotClaimed = positiveBigInt(lot.claimed_qty, "claimLot.claimedQty");
      const lotReleased = BigInt(String(lot.released_qty));
      const lotConsumed = BigInt(String(lot.consumed_qty));
      const lotOpen = lotClaimed - lotReleased - lotConsumed;
      if (lotOpen < BigInt(0)) {
        throw new InventoryAvailabilityClaimRepositoryError(
          "INVALID_CLAIM_LOT_BALANCE",
          "A canonical claim lot allocation has released or consumed more than it claimed.",
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
         SET released_qty = released_qty + $1, updated_at = now()
         WHERE id = $2
           AND claimed_qty - released_qty - consumed_qty = $1`,
        [allocation.releaseQty.toString(), allocation.allocationId.toString()],
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
       SET released_qty = released_qty + $1, updated_at = now()
       WHERE id = $2
         AND claimed_qty - released_qty - consumed_qty = $1`,
      [release.inventory.releaseQty.toString(), release.inventory.claimResourceId.toString()],
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
     SET released_target_qty = planned_qty - consumed_target_qty, updated_at = now()
     WHERE claim_id = $1`,
    [input.claim.id.toString()],
  );
  await client.query(
    `UPDATE inventory.availability_claim_operations
     SET released_executions = planned_executions - executed_executions,
         status = CASE WHEN executed_executions = planned_executions THEN status ELSE 'released' END,
         updated_at = now()
     WHERE claim_id = $1`,
    [input.claim.id.toString()],
  );
  const status = input.disposition === "cancel" ? "cancelled" : "released";
  const timestampColumn = input.disposition === "cancel" ? "cancelled_at" : "released_at";
  await client.query(
    `UPDATE inventory.availability_claims
     SET status = $1, ${timestampColumn} = $2, updated_at = now()
     WHERE id = $3 AND status = 'active'`,
    [status, input.occurredAt, input.claim.id.toString()],
  );
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
          if (!orderDemandMatchesClaim(lockedOrder, activeClaim)) {
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
          revision,
          runtimeAuthorityRevision: authority.revision,
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
