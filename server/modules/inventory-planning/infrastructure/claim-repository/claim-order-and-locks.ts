import type { PoolClient } from "pg";

import {
  claimPlanRequestSchema,
  claimPlanSchema,
  type ClaimPlanRequestDto,
  type ClaimSupplySnapshotDto,
} from "@shared/types/inventory-availability-planner";
import { isUnmappedOrderLine } from "@shared/unmapped-order-line";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { ClaimLineBalance, ClaimSupplyRefreshRejection } from "../../domain/claim-supply-refresh";
import {
  hash,
  InventoryAvailabilityClaimRepositoryError,
  LEGACY_RESERVATION_LOCK_NAMESPACE,
  MAX_GRAPH_PRODUCTS,
  nonnegativeBigInt,
  nonnegativeInteger,
  positiveBigInt,
  positiveInteger,
  rows,
  TRANSFORMATION_MODEL_LOCK_NAMESPACE,
  uniqueSorted,
  type FulfillmentClaim,
  type LockedOrder,
  type OrderLine,
  type PersistedClaim,
  type RuntimeAuthority,
} from "./claim-primitives";

export async function requireCanonicalAuthority(client: PoolClient): Promise<RuntimeAuthority> {
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

export async function loadOrder(client: PoolClient, orderId: number, lock: boolean): Promise<LockedOrder> {
  const orderRow = rows(await client.query(
    `SELECT id AS order_id, warehouse_id, warehouse_status, on_hold,
            to_jsonb(orders)->>'order_edit_operation_id' AS order_edit_operation_id
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
            item.sku, item.inventory_tracking, item.catalog_product_id,
            item.product_id AS stored_product_id,
            item.requires_shipping AS order_item_requires_shipping,
            item.short_reason AS short_reason,
            variant.id AS target_variant_id,
            CASE
              WHEN item.status = 'cancelled' THEN 0
              -- A shipped order cannot ship more: it owes only units the provider
              -- shipped that were never recorded as picked (a pick correction).
              -- The shipment may already have closed the line as completed
              -- (#64254: completed, 20 shipped, 8 recorded), so completed still
              -- owes those units here.
              WHEN $2::boolean THEN GREATEST(
                LEAST(COALESCE(item.quantity, 0), COALESCE(item.fulfilled_quantity, 0))
                - COALESCE(item.picked_quantity, 0), 0)
              WHEN item.status = 'completed' THEN 0
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
      AND ((item.catalog_product_id IS NOT NULL AND variant.id = item.product_id)
        OR (item.catalog_product_id IS NULL AND upper(variant.sku) = upper(item.sku)))
     WHERE item.order_id = $1
     ORDER BY item.id
     ${lock ? "FOR UPDATE OF item" : ""}`,
    [orderId, orderRow.warehouse_status === "shipped"],
  ));
  const lines: OrderLine[] = [];
  for (const row of itemRows) {
    // A warehouse shortage is still accepted demand. Refund-after-pick uses the
    // same UI status but explicitly preserves historic quantity, so it cannot be
    // reconstructed as newly authorized customer demand without refund review.
    if (row.short_reason === "refund_after_pick") {
      throw new InventoryAvailabilityClaimRepositoryError(
        "ORDER_REFUND_CUSTODY_REVIEW_REQUIRED",
        "Refund-after-pick custody must be reconciled before canonical order claiming.",
        { orderId, orderItemId: row.order_item_id },
      );
    }
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
    if (itemRequiresShipping === 0 || (row.inventory_tracking === false && row.catalog_product_id != null)) continue;
    // No catalog identity at all: Echelon tracks no stock for this line, so it is
    // neither reserved nor allowed to block the order's other lines. It is picked
    // as a confirmation (see isUnmappedOrderLine) and surfaced for mapping.
    if (isUnmappedOrderLine({ sku: row.sku == null ? null : String(row.sku),
      catalogProductId: row.catalog_product_id == null ? null : Number(row.catalog_product_id),
      productId: row.stored_product_id == null ? null : Number(row.stored_product_id) })) continue;
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
    if (row.inventory_tracking === true && (Number(row.catalog_product_id) !== rootProductId
      || Number(row.stored_product_id) !== targetVariantId || row.requires_shipping !== true || row.track_inventory !== true)) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "ORDER_ITEM_INVENTORY_POLICY_CONFLICT",
        "Order inventory policy conflicts with its catalog identity; review the mapping before claiming.",
        { orderId, orderItemId, targetVariantId, rootProductId },
      );
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
    onHold: onHold === 1 || orderRow.order_edit_operation_id != null,
    lines,
  };
}

/**
 * Cancelled orders and orders with nothing left to reserve are never claimable.
 * A shipped order is claimable only to record units that already shipped
 * without a pick record; loadOrder limits its demand to exactly those units.
 */
export function orderClaimable(order: LockedOrder, recordingConfirmedShipment: boolean): boolean {
  if (order.lines.length === 0 || order.warehouseStatus === "cancelled") return false;
  return order.warehouseStatus !== "shipped" || recordingConfirmedShipment;
}

export async function discoverActiveGraphProducts(
  client: PoolClient,
  rootProductIds: readonly number[],
): Promise<number[]> {
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

export async function lockGraphProducts(client: PoolClient, productIds: readonly number[]): Promise<void> {
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

export async function lockPlanningPolicyHeads(
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
    // Match captureActiveClaimSupplySnapshotInsideTransaction: scope ownership
    // belongs to immutable versions, not heads. Include every active warehouse
    // and network policy the snapshot reads, in the same stable scope order.
    `SELECT head.scope_key
     FROM inventory.promise_safety_policy_heads AS head
     JOIN inventory.promise_safety_policy_versions AS policy
       ON policy.id = head.active_policy_id AND policy.scope_key = head.scope_key
     WHERE policy.scope_key = 'business'
        OR policy.product_variant_id = ANY($1::integer[])
     ORDER BY head.scope_key
     FOR SHARE OF head`,
    [variantIds],
  );
}

export async function lockSnapshotResources(
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

export async function loadActiveClaim(
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

export async function loadActiveClaimById(
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

export async function loadClaimById(
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

export async function nextClaimRevision(client: PoolClient, orderId: number): Promise<number> {
  const row = rows(await client.query(
    `SELECT COALESCE(MAX(revision), 0) + 1 AS revision
     FROM inventory.availability_claims
     WHERE order_id = $1`,
    [orderId],
  ))[0];
  return positiveInteger(row?.revision, "claim.revision");
}

export function buildPlanRequest(order: LockedOrder, revision: number): ClaimPlanRequestDto {
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

export async function orderDemandMatchesClaim(
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

/** Caller holds the claim lock; balances come from the relational lines. */
export async function loadClaimLineBalances(client: PoolClient, claim: PersistedClaim): Promise<ClaimLineBalance[]> {
  const lineRows = rows(await client.query(
    `SELECT line_key, requested_qty, planned_qty, released_target_qty, consumed_target_qty, picked_target_qty
     FROM inventory.availability_claim_lines
     WHERE claim_id = $1
     ORDER BY line_key`,
    [claim.id.toString()],
  ));
  return lineRows.map((row) => {
    const requested = positiveBigInt(row.requested_qty, "claimLine.requestedQty");
    const planned = nonnegativeBigInt(row.planned_qty, "claimLine.plannedQty");
    const settled = nonnegativeBigInt(row.released_target_qty, "claimLine.releasedTargetQty")
      + nonnegativeBigInt(row.consumed_target_qty, "claimLine.consumedTargetQty")
      + nonnegativeBigInt(row.picked_target_qty, "claimLine.pickedTargetQty");
    if (settled > planned) {
      throw new InventoryAvailabilityClaimRepositoryError(
        "CLAIM_DEMAND_LINEAGE_MISMATCH",
        "The active claim's line custody exceeds its planned quantity.",
        { claimId: claim.id.toString(), lineKey: String(row.line_key) },
      );
    }
    return {
      lineKey: String(row.line_key),
      remainingRequestedQty: requested - settled,
      remainingPlannedQty: planned - settled,
      pickedTargetQty: nonnegativeBigInt(row.picked_target_qty, "claimLine.pickedTargetQty"),
    };
  });
}

export function supplyRefreshError(
  rejection: ClaimSupplyRefreshRejection,
  orderId: number,
  claim: PersistedClaim,
): InventoryAvailabilityClaimRepositoryError {
  const { code, message, ...detail } = rejection;
  return new InventoryAvailabilityClaimRepositoryError(code, message,
    { orderId, claimId: claim.id.toString(), ...detail });
}

export function claimVariantIds(claim: PersistedClaim): number[] {
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

export async function loadClaimProductIds(client: PoolClient, claim: PersistedClaim): Promise<number[]> {
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

export async function requirePickableLocation(
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
