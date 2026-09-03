import type {
  CanonicalClaimInventoryExecutionResource,
  CanonicalClaimInventoryObservationCostLayer,
  CanonicalClaimInventoryObservedReconciliationResult,
  CanonicalClaimCycleCountAdjustmentResult,
  CanonicalClaimInventoryReleaseResource,
  CanonicalClaimInventoryMutationPort,
  CanonicalClaimInventoryPickResource,
  CanonicalClaimInventoryUnpickResource,
  CanonicalClaimLotAllocation,
  CanonicalClaimProducedLotAllocation,
  CanonicalClaimTransactionClient,
} from "../../inventory-planning/application/canonical-claim-inventory.port";
import { allocateBuildCostLayers } from "../domain/build.domain";
import { buildMillsToRoundedCents, normalizeBuildLotCosts } from "./build.repository";

type CanonicalTransformationExecutionInput =
  | Parameters<CanonicalClaimInventoryMutationPort["executePackageOperation"]>[0]
  | Parameters<CanonicalClaimInventoryMutationPort["executeBuildOperation"]>[0];

function rows(result: { rows: any[] }): any[] {
  return Array.isArray(result.rows) ? result.rows : [];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new CanonicalClaimInventoryMutationError(
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
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_DATABASE_EVIDENCE",
      `${field} must be a nonnegative PostgreSQL integer`,
      { field, value },
    );
  }
  return parsed;
}

function positivePostgresInteger(value: bigint, field: string): number {
  if (value <= BigInt(0) || value > BigInt(2_147_483_647)) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_QUANTITY",
      `${field} must fit a positive PostgreSQL integer`,
      { field, value: value.toString() },
    );
  }
  return Number(value);
}

function positiveBigInt(value: bigint, field: string): bigint {
  if (value <= BigInt(0) || value > BigInt("9223372036854775807")) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_IDENTITY",
      `${field} must fit a positive PostgreSQL bigint`,
      { field, value: value.toString() },
    );
  }
  return value;
}

function postgresBigInt(value: bigint, field: string): bigint {
  if (value < BigInt(0) || value > BigInt("9223372036854775807")) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_COST",
      `${field} must fit a nonnegative PostgreSQL bigint`,
      { field, value: value.toString() },
    );
  }
  return value;
}

function nonblank(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximum) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_IDENTITY",
      `${field} must contain between 1 and ${maximum} characters`,
      { field },
    );
  }
  return normalized;
}

function validateAuditInput(input: {
  claimId: bigint;
  orderId: number;
  actor: string;
  occurredAt: Date;
  reason?: string;
}): void {
  positiveBigInt(input.claimId, "claim.id");
  positiveInteger(input.orderId, "order.id");
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_TIMESTAMP",
      "Canonical inventory mutation time must be a valid Date.",
    );
  }
  if (input.actor.trim() === "" || (input.reason != null && input.reason.trim() === "")) {
    throw new CanonicalClaimInventoryMutationError(
      "INVALID_INVENTORY_AUDIT_ACTOR",
      "Canonical inventory mutations require a nonblank actor and a nonblank reason when the command supplies one.",
    );
  }
}

export class CanonicalClaimInventoryMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CanonicalClaimInventoryMutationError";
  }
}

async function lockLevel(
  client: CanonicalClaimTransactionClient,
  inventoryLevelId: number,
): Promise<any> {
  return rows(await client.query(
    `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty
     FROM inventory.inventory_levels
     WHERE id = $1
     FOR UPDATE`,
    [inventoryLevelId],
  ))[0];
}

export class PostgresCanonicalClaimInventoryRepository implements CanonicalClaimInventoryMutationPort {
  async ensureInventoryLevel(
    input: Parameters<CanonicalClaimInventoryMutationPort["ensureInventoryLevel"]>[0],
  ): Promise<number> {
    const productVariantId = positiveInteger(input.productVariantId, "inventoryLevel.productVariantId");
    const warehouseLocationId = positiveInteger(
      input.warehouseLocationId,
      "inventoryLevel.warehouseLocationId",
    );
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
      throw new CanonicalClaimInventoryMutationError(
        "INVALID_INVENTORY_TIMESTAMP",
        "Inventory-level creation time must be a valid Date.",
      );
    }
    const inserted = rows(await input.client.query(
      `INSERT INTO inventory.inventory_levels (
         product_variant_id, warehouse_location_id, variant_qty, reserved_qty,
         picked_qty, packed_qty, backorder_qty, updated_at
       ) VALUES ($1, $2, 0, 0, 0, 0, 0, $3)
       ON CONFLICT (product_variant_id, warehouse_location_id) DO NOTHING
       RETURNING id`,
      [productVariantId, warehouseLocationId, input.occurredAt],
    ))[0];
    if (inserted) {
      return positiveInteger(inserted.id, "inventoryLevel.id");
    }
    const row = rows(await input.client.query(
      `SELECT id
       FROM inventory.inventory_levels
       WHERE product_variant_id = $1 AND warehouse_location_id = $2`,
      [productVariantId, warehouseLocationId],
    ))[0];
    if (!row) {
      throw new CanonicalClaimInventoryMutationError(
        "INVENTORY_LEVEL_CREATION_CONFLICT",
        "A concurrently created picker-observation target inventory level is not visible in this serializable snapshot.",
        { productVariantId, warehouseLocationId },
      );
    }
    return positiveInteger(row?.id, "inventoryLevel.id");
  }

  async applyCycleCountAdjustment(
    input: Parameters<CanonicalClaimInventoryMutationPort["applyCycleCountAdjustment"]>[0],
  ): Promise<CanonicalClaimCycleCountAdjustmentResult> {
    const inventoryLevelId = positiveInteger(input.inventoryLevelId, "inventoryLevel.id");
    const productVariantId = positiveInteger(input.productVariantId, "productVariant.id");
    const warehouseLocationId = positiveInteger(input.warehouseLocationId, "warehouseLocation.id");
    const quantityBefore = nonnegativeInteger(input.quantityBefore, "cycleCount.quantityBefore");
    const countedQty = nonnegativeInteger(input.countedQty, "cycleCount.countedQty");
    const cycleCountId = positiveInteger(input.cycleCountId, "cycleCount.id");
    const cycleCountItemId = positiveInteger(input.cycleCountItemId, "cycleCountItem.id");
    nonblank(input.actor, "cycleCount.actor", 100);
    nonblank(input.reason, "cycleCount.reason", 1000);
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
      throw new CanonicalClaimInventoryMutationError(
        "INVALID_INVENTORY_TIMESTAMP",
        "Cycle-count inventory mutation time must be a valid Date.",
      );
    }
    if (quantityBefore === countedQty) {
      throw new CanonicalClaimInventoryMutationError(
        "ZERO_CYCLE_COUNT_ADJUSTMENT",
        "A cycle-count inventory adjustment must change the recorded physical quantity.",
        { inventoryLevelId, quantityBefore, countedQty },
      );
    }

    const level = await lockLevel(input.client, inventoryLevelId);
    if (!level
      || positiveInteger(level.product_variant_id, "inventoryLevel.productVariantId") !== productVariantId
      || positiveInteger(level.warehouse_location_id, "inventoryLevel.warehouseLocationId") !== warehouseLocationId
      || nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty") !== quantityBefore) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_LEVEL_CHANGED",
        "The counted inventory level changed before its physical adjustment could be recorded.",
        { inventoryLevelId, productVariantId, warehouseLocationId, quantityBefore },
      );
    }
    const reservedQty = nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty");
    if (reservedQty > countedQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_RESERVATIONS_NOT_RECONCILED",
        "Exact claim ownership must be released before physical stock can be counted below reserved quantity.",
        { inventoryLevelId, reservedQty, countedQty },
      );
    }

    const lotRows = rows(await input.client.query(
      `SELECT id, qty_on_hand, qty_reserved, qty_picked, total_unit_cost_mills
       FROM inventory.inventory_lots
       WHERE product_variant_id = $1
         AND warehouse_location_id = $2
       ORDER BY received_at, id
       FOR UPDATE`,
      [productVariantId, warehouseLocationId],
    ));
    let lotOnHandQty = 0;
    let lotReservedQty = 0;
    for (const lot of lotRows) {
      const qtyOnHand = nonnegativeInteger(lot.qty_on_hand, "inventoryLot.qtyOnHand");
      const qtyReserved = nonnegativeInteger(lot.qty_reserved, "inventoryLot.qtyReserved");
      nonnegativeInteger(lot.qty_picked, "inventoryLot.qtyPicked");
      if (qtyReserved > qtyOnHand) {
        throw new CanonicalClaimInventoryMutationError(
          "CYCLE_COUNT_LOT_OWNERSHIP_INVALID",
          "A FIFO lot reserves more physical stock than it contains.",
          { inventoryLotId: positiveInteger(lot.id, "inventoryLot.id"), qtyOnHand, qtyReserved },
        );
      }
      lotOnHandQty += qtyOnHand;
      lotReservedQty += qtyReserved;
      if (!Number.isSafeInteger(lotOnHandQty) || !Number.isSafeInteger(lotReservedQty)) {
        throw new CanonicalClaimInventoryMutationError(
          "CYCLE_COUNT_LOT_AGGREGATE_OVERFLOW",
          "FIFO lot quantities exceed the supported safe-integer aggregate.",
          { inventoryLevelId },
        );
      }
    }
    if (lotOnHandQty !== quantityBefore || lotReservedQty !== reservedQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_LOT_AGGREGATE_MISMATCH",
        "FIFO lot totals do not equal the locked inventory-level totals.",
        { inventoryLevelId, quantityBefore, reservedQty, lotOnHandQty, lotReservedQty },
      );
    }

    const quantityDelta = countedQty - quantityBefore;
    let consumedQty = BigInt(0);
    let consumedCostMills = BigInt(0);
    const lotEffects: Array<{
      inventoryLotId: number;
      quantityDelta: number;
      unitCostMills: bigint;
      totalCostMills: bigint;
    }> = [];
    if (quantityDelta < 0) {
      let remaining = -quantityDelta;
      for (const lot of lotRows) {
        if (remaining === 0) break;
        const lotId = positiveInteger(lot.id, "inventoryLot.id");
        const qtyOnHand = nonnegativeInteger(lot.qty_on_hand, "inventoryLot.qtyOnHand");
        const qtyReserved = nonnegativeInteger(lot.qty_reserved, "inventoryLot.qtyReserved");
        const qtyPicked = nonnegativeInteger(lot.qty_picked, "inventoryLot.qtyPicked");
        const take = Math.min(Math.max(0, qtyOnHand - qtyReserved), remaining);
        if (take === 0) continue;
        const unitCostMills = postgresBigInt(BigInt(String(lot.total_unit_cost_mills ?? 0)), "inventoryLot.totalUnitCostMills");
        const updated = await input.client.query(
          `UPDATE inventory.inventory_lots
           SET qty_on_hand = qty_on_hand - $1,
               status = CASE
                 WHEN qty_on_hand - $1 = 0 AND qty_reserved = 0 AND qty_picked = 0 THEN 'depleted'
                 ELSE status
               END
           WHERE id = $2 AND qty_on_hand - qty_reserved >= $1`,
          [take, lotId],
        );
        if (updated.rowCount !== 1) {
          throw new CanonicalClaimInventoryMutationError(
            "CYCLE_COUNT_LOT_CHANGED",
            "A FIFO lot changed while the cycle-count shortage was being applied.",
            { inventoryLotId: lotId, take },
          );
        }
        remaining -= take;
        consumedQty += BigInt(take);
        consumedCostMills += BigInt(take) * unitCostMills;
        lotEffects.push({
          inventoryLotId: lotId,
          quantityDelta: -take,
          unitCostMills,
          totalCostMills: BigInt(take) * unitCostMills,
        });
      }
      if (remaining !== 0) {
        throw new CanonicalClaimInventoryMutationError(
          "CYCLE_COUNT_LOT_SHORTFALL",
          "FIFO lot evidence does not contain enough unreserved physical stock for the counted shortage.",
          { inventoryLevelId, requestedQty: -quantityDelta, attributedQty: -quantityDelta - remaining },
        );
      }
    } else {
      const costRow = rows(await input.client.query(
        `SELECT CASE
                  WHEN COALESCE(last_cost_cents, 0) > 0 THEN last_cost_cents
                  WHEN COALESCE(standard_cost_cents, 0) > 0 THEN standard_cost_cents
                  WHEN COALESCE(avg_cost_cents, 0) > 0 THEN avg_cost_cents
                  ELSE 0
                END AS cost_cents,
                CASE
                  WHEN COALESCE(last_cost_cents, 0) > 0 THEN 'last_paid'
                  WHEN COALESCE(standard_cost_cents, 0) > 0 THEN 'standard'
                  WHEN COALESCE(avg_cost_cents, 0) > 0 THEN 'avg'
                  ELSE 'unresolved'
                END AS cost_source
         FROM catalog.product_variants
         WHERE id = $1
         FOR SHARE`,
        [productVariantId],
      ))[0];
      if (!costRow) {
        throw new CanonicalClaimInventoryMutationError(
          "CYCLE_COUNT_VARIANT_MISSING",
          "The counted product variant no longer exists.",
          { productVariantId },
        );
      }
      const unitCostCents = postgresBigInt(BigInt(String(costRow.cost_cents ?? 0)), "productVariant.costCents");
      const unitCostMills = unitCostCents * BigInt(100);
      const lotNumber = `CC-${cycleCountId}-${cycleCountItemId}`;
      const insertedLot = rows(await input.client.query(
        `INSERT INTO inventory.inventory_lots (
           lot_number, product_variant_id, warehouse_location_id,
           unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
           landed_cost_cents, total_unit_cost_cents,
           unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
           landed_cost_mills, total_unit_cost_mills,
           qty_received, qty_on_hand, qty_reserved, qty_picked,
           received_at, status, cost_provisional, cost_source, notes
         ) VALUES (
           $1, $2, $3, $4, $4, 0, 0, $4, $5, $5, 0, 0, $5,
           $6, $6, 0, 0, $7, 'active', $8, $9, $10
         )
         RETURNING id`,
        [
          lotNumber,
          productVariantId,
          warehouseLocationId,
          unitCostCents.toString(),
          unitCostMills.toString(),
          quantityDelta,
          input.occurredAt,
          1,
          String(costRow.cost_source),
          input.reason,
        ],
      ))[0];
      const inventoryLotId = positiveInteger(insertedLot?.id, "inventoryLot.id");
      lotEffects.push({
        inventoryLotId,
        quantityDelta,
        unitCostMills,
        totalCostMills: BigInt(quantityDelta) * unitCostMills,
      });
    }

    const updatedLevel = await input.client.query(
      `UPDATE inventory.inventory_levels
       SET variant_qty = $1, updated_at = $2
       WHERE id = $3 AND variant_qty = $4 AND reserved_qty <= $1`,
      [countedQty, input.occurredAt, inventoryLevelId, quantityBefore],
    );
    if (updatedLevel.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_LEVEL_CHANGED",
        "The counted inventory level changed before its aggregate quantity could be recorded.",
        { inventoryLevelId, quantityBefore, countedQty },
      );
    }
    if (lotEffects.length === 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_LOT_EFFECT_MISSING",
        "A nonzero cycle-count adjustment did not produce exact FIFO lot evidence.",
        { inventoryLevelId, quantityDelta },
      );
    }
    let runningQuantity = quantityBefore;
    let adjustmentTransactionId: number | null = null;
    for (const effect of lotEffects) {
      const nextQuantity = runningQuantity + effect.quantityDelta;
      const transaction = rows(await input.client.query(
        `INSERT INTO inventory.inventory_transactions (
           product_variant_id, from_location_id, to_location_id, transaction_type,
           variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
           source_state, target_state, unit_cost_cents, unit_cost_mills,
           total_cost_mills, inventory_lot_id, cycle_count_id, reference_type,
           reference_id, notes, user_id, created_at
         ) VALUES ($1, $2, $3, 'adjustment', $4, $5, $6, 0, 'on_hand', 'on_hand',
                   $7, $8, $9, $10, $11, 'cycle_count_item', $12, $13, $14, $15)
         RETURNING id`,
        [
          productVariantId,
          effect.quantityDelta < 0 ? warehouseLocationId : null,
          effect.quantityDelta > 0 ? warehouseLocationId : null,
          effect.quantityDelta,
          runningQuantity,
          nextQuantity,
          buildMillsToRoundedCents(effect.unitCostMills).toString(),
          effect.unitCostMills.toString(),
          effect.totalCostMills.toString(),
          effect.inventoryLotId,
          cycleCountId,
          String(cycleCountItemId),
          input.reason,
          input.actor,
          input.occurredAt,
        ],
      ))[0];
      adjustmentTransactionId ??= positiveInteger(transaction?.id, "inventoryTransaction.id");
      runningQuantity = nextQuantity;
    }
    if (runningQuantity !== countedQty || adjustmentTransactionId == null) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_LOT_EFFECT_MISMATCH",
        "Exact FIFO lot evidence does not reconcile to the counted physical quantity.",
        { inventoryLevelId, quantityBefore, countedQty, runningQuantity },
      );
    }
    return {
      adjustmentTransactionId,
      consumedQty,
      consumedCostMills,
    };
  }

  async recordCycleCountNoop(
    input: Parameters<CanonicalClaimInventoryMutationPort["recordCycleCountNoop"]>[0],
  ): Promise<{ adjustmentTransactionId: number }> {
    const productVariantId = positiveInteger(input.productVariantId, "productVariant.id");
    const warehouseLocationId = positiveInteger(input.warehouseLocationId, "warehouseLocation.id");
    const countedQty = nonnegativeInteger(input.countedQty, "cycleCount.countedQty");
    const cycleCountId = positiveInteger(input.cycleCountId, "cycleCount.id");
    const cycleCountItemId = positiveInteger(input.cycleCountItemId, "cycleCountItem.id");
    nonblank(input.actor, "cycleCount.actor", 100);
    nonblank(input.reason, "cycleCount.reason", 1000);
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
      throw new CanonicalClaimInventoryMutationError(
        "INVALID_INVENTORY_TIMESTAMP",
        "Cycle-count inventory reconciliation time must be a valid Date.",
      );
    }
    const transaction = rows(await input.client.query(
      `INSERT INTO inventory.inventory_transactions (
         product_variant_id, from_location_id, to_location_id, transaction_type,
         variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
         source_state, target_state, unit_cost_cents, unit_cost_mills,
         total_cost_mills, cycle_count_id, reference_type, reference_id,
         notes, user_id, created_at
       ) VALUES ($1, $2, $2, 'adjustment', 0, $3, $3, 0, 'on_hand', 'on_hand',
                 0, 0, 0, $4, 'cycle_count_item', $5, $6, $7, $8)
       RETURNING id`,
      [
        productVariantId,
        warehouseLocationId,
        countedQty,
        cycleCountId,
        String(cycleCountItemId),
        input.reason,
        input.actor,
        input.occurredAt,
      ],
    ))[0];
    return { adjustmentTransactionId: positiveInteger(transaction?.id, "inventoryTransaction.id") };
  }

  async approveCycleCountItem(
    input: Parameters<CanonicalClaimInventoryMutationPort["approveCycleCountItem"]>[0],
  ): Promise<void> {
    const cycleCountItemId = positiveInteger(input.cycleCountItemId, "cycleCountItem.id");
    const expectedStatus = nonblank(input.expectedStatus, "cycleCountItem.expectedStatus", 20);
    const actor = nonblank(input.actor, "cycleCountItem.actor", 100);
    const reasonCode = nonblank(input.reasonCode, "cycleCountItem.reasonCode", 50);
    const adjustmentTransactionId = input.adjustmentTransactionId == null
      ? null
      : positiveInteger(input.adjustmentTransactionId, "inventoryTransaction.id");
    if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
      throw new CanonicalClaimInventoryMutationError(
        "INVALID_INVENTORY_TIMESTAMP",
        "Cycle-count approval time must be a valid Date.",
      );
    }
    const updated = await input.client.query(
      `UPDATE inventory.cycle_count_items
       SET status = 'approved', approved_by = $1, approved_at = $2,
           variance_reason = $3, adjustment_transaction_id = $4
       WHERE id = $5 AND status = $6
       RETURNING id`,
      [actor, input.occurredAt, reasonCode, adjustmentTransactionId, cycleCountItemId, expectedStatus],
    );
    if (updated.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CYCLE_COUNT_ITEM_CHANGED",
        "The cycle-count item changed before reconciliation could approve it.",
        { cycleCountItemId, expectedStatus },
      );
    }
  }

  async reserveResource(
    input: Parameters<CanonicalClaimInventoryMutationPort["reserveResource"]>[0],
  ): Promise<readonly CanonicalClaimLotAllocation[]> {
    validateAuditInput(input);
    positiveBigInt(input.claimResourceId, "claimResource.id");
    positiveInteger(input.inventoryLevelId, "inventoryLevel.id");
    positiveInteger(input.warehouseLocationId, "warehouseLocation.id");
    positiveInteger(input.sourceVariantId, "sourceVariant.id");
    positiveInteger(input.orderItemId, "orderItem.id");
    const claimedQty = positiveInteger(input.claimedQty, "claimResource.claimedQty");
    const level = await lockLevel(input.client, input.inventoryLevelId);
    if (!level
      || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== input.warehouseLocationId
      || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== input.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RESOURCE_CHANGED",
        "A planned inventory resource no longer matches its locked level identity.",
        {
          inventoryLevelId: input.inventoryLevelId,
          warehouseLocationId: input.warehouseLocationId,
          sourceVariantId: input.sourceVariantId,
        },
      );
    }
    const variantQty = nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty");
    const reservedQty = nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty");
    if (variantQty - reservedQty < claimedQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RESOURCE_CONFLICT",
        "A locked inventory resource no longer has enough unreserved physical stock.",
        { inventoryLevelId: input.inventoryLevelId, claimedQty, variantQty, reservedQty },
      );
    }

    const lotRows = rows(await input.client.query(
      `SELECT id, qty_on_hand, qty_reserved,
              unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
              landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
              po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
              total_unit_cost_mills
       FROM inventory.inventory_lots
       WHERE product_variant_id = $1
         AND warehouse_location_id = $2
         AND status = 'active'
       ORDER BY received_at, id
       FOR UPDATE`,
      [input.sourceVariantId, input.warehouseLocationId],
    ));
    let remaining = claimedQty;
    const allocations: CanonicalClaimLotAllocation[] = [];
    for (const lot of lotRows) {
      if (remaining === 0) break;
      const lotOnHand = nonnegativeInteger(lot.qty_on_hand, "inventoryLot.qtyOnHand");
      const lotReserved = nonnegativeInteger(lot.qty_reserved, "inventoryLot.qtyReserved");
      const take = Math.min(Math.max(0, lotOnHand - lotReserved), remaining);
      if (take === 0) continue;
      const inventoryLotId = positiveInteger(lot.id, "inventoryLot.id");
      let normalizedCosts: ReturnType<typeof normalizeBuildLotCosts>;
      try {
        normalizedCosts = normalizeBuildLotCosts(lot);
      } catch (cause) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A FIFO lot has invalid cost evidence and cannot be owned by a canonical claim.",
          { inventoryLotId, cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      allocations.push({
        inventoryLotId,
        qty: take,
        unitCostMills: normalizedCosts.totalMills,
        poUnitCostMills: normalizedCosts.poMills,
        packagingUnitCostMills: normalizedCosts.packagingMills,
        landedUnitCostMills: normalizedCosts.landedMills,
      });
      remaining -= take;
    }
    if (remaining !== 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_SHORTFALL",
        "Canonical claiming requires exact FIFO lot ownership for every reserved source unit.",
        {
          inventoryLevelId: input.inventoryLevelId,
          requestedQty: claimedQty,
          attributedQty: claimedQty - remaining,
        },
      );
    }
    for (const allocation of allocations) {
      const updated = await input.client.query(
        `UPDATE inventory.inventory_lots
         SET qty_reserved = qty_reserved + $1
         WHERE id = $2 AND qty_reserved + $1 <= qty_on_hand`,
        [allocation.qty, allocation.inventoryLotId],
      );
      if (updated.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_CONFLICT",
          "A locked FIFO lot changed while the canonical claim was being persisted.",
          { inventoryLotId: allocation.inventoryLotId, take: allocation.qty },
        );
      }
    }

    const updatedLevel = await input.client.query(
      `UPDATE inventory.inventory_levels
       SET reserved_qty = reserved_qty + $1, updated_at = $3
       WHERE id = $2 AND reserved_qty + $1 <= variant_qty`,
      [claimedQty, input.inventoryLevelId, input.occurredAt],
    );
    if (updatedLevel.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LEVEL_CONFLICT",
        "A locked inventory level changed while the canonical claim was being persisted.",
        { inventoryLevelId: input.inventoryLevelId, claimedQty },
      );
    }
    await input.client.query(
      `INSERT INTO inventory.inventory_transactions (
         product_variant_id, to_location_id, transaction_type,
         variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
         source_state, target_state, order_id, order_item_id,
         reference_type, reference_id, user_id, notes, created_at
       ) VALUES ($1, $2, 'reserve', 0, $3, $3, $4, 'on_hand', 'committed',
                 $5, $6, 'availability_claim', $7, $8, $9, $10)`,
      [
        input.sourceVariantId,
        input.warehouseLocationId,
        variantQty,
        claimedQty,
        input.orderId,
        input.orderItemId,
        `claim:${input.claimId}:resource:${input.claimResourceId}`,
        input.actor,
        input.consumerOperationKey == null
          ? "Canonical direct finished allocation"
          : `Canonical source allocation for operation ${input.consumerOperationKey}`,
        input.occurredAt,
      ],
    );
    return allocations;
  }

  async reconcilePickResource(
    input: Parameters<CanonicalClaimInventoryMutationPort["reconcilePickResource"]>[0],
  ): Promise<readonly CanonicalClaimLotAllocation[]> {
    validateAuditInput(input);
    const claimedQty = positiveInteger(input.target.claimedQty, "target.claimedQty");
    positiveBigInt(input.target.claimResourceId, "target.claimResource.id");
    positiveInteger(input.target.inventoryLevelId, "target.inventoryLevel.id");
    positiveInteger(input.target.warehouseLocationId, "target.warehouseLocation.id");
    positiveInteger(input.target.sourceVariantId, "target.sourceVariant.id");
    positiveInteger(input.target.orderItemId, "target.orderItem.id");
    if (input.releases.length === 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RECONCILIATION_SOURCE_MISSING",
        "Pick-location reconciliation requires exact claim-owned source resources.",
      );
    }
    const releaseQty = input.releases.reduce((total, resource) => total + resource.releaseQty, BigInt(0));
    if (releaseQty !== BigInt(claimedQty)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RECONCILIATION_QUANTITY_MISMATCH",
        "The released claim ownership must equal the ownership reserved at the selected pick location.",
        { releaseQty: releaseQty.toString(), claimedQty },
      );
    }
    if (input.releases.some((resource) => resource.inventoryLevelId === input.target.inventoryLevelId)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RECONCILIATION_SELF_MOVE",
        "Pick-location reconciliation cannot release and reserve the same inventory level.",
        { inventoryLevelId: input.target.inventoryLevelId },
      );
    }
    if (input.releases.some((resource) =>
      resource.sourceVariantId !== input.target.sourceVariantId
      || resource.orderItemId !== input.target.orderItemId)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_RECONCILIATION_IDENTITY_MISMATCH",
        "Pick-location reconciliation must preserve target variant and order-line ownership.",
        { sourceVariantId: input.target.sourceVariantId, orderItemId: input.target.orderItemId },
      );
    }

    // Acquire every physical row in the global level-then-lot order before
    // either side of the reservation rebind writes. The public release/reserve
    // methods revalidate these already-held locks and retain their audit logs.
    const levelIds = [...new Set([
      ...input.releases.map((resource) => resource.inventoryLevelId),
      input.target.inventoryLevelId,
    ])];
    await input.client.query(
      `SELECT id
       FROM inventory.inventory_levels
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, id
       FOR UPDATE`,
      [levelIds],
    );
    const sourceLotIds = [...new Set(input.releases.flatMap((resource) =>
      resource.lotAllocations.map((allocation) => allocation.inventoryLotId)))];
    await input.client.query(
      `SELECT id
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
          OR (product_variant_id = $2 AND warehouse_location_id = $3 AND status = 'active')
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [sourceLotIds, input.target.sourceVariantId, input.target.warehouseLocationId],
    );

    await this.releaseResources({
      client: input.client,
      claimId: input.claimId,
      resources: input.releases,
      orderId: input.orderId,
      actor: input.actor,
      reason: input.reason,
      occurredAt: input.occurredAt,
    });
    return this.reserveResource({
      client: input.client,
      claimId: input.claimId,
      claimResourceId: input.target.claimResourceId,
      inventoryLevelId: input.target.inventoryLevelId,
      warehouseLocationId: input.target.warehouseLocationId,
      sourceVariantId: input.target.sourceVariantId,
      claimedQty,
      orderId: input.orderId,
      orderItemId: input.target.orderItemId,
      consumerOperationKey: null,
      actor: input.actor,
      occurredAt: input.occurredAt,
    });
  }

  async reconcileObservedPickResource(
    input: Parameters<CanonicalClaimInventoryMutationPort["reconcileObservedPickResource"]>[0],
  ): Promise<CanonicalClaimInventoryObservedReconciliationResult> {
    validateAuditInput(input);
    const claimedQty = positiveInteger(input.target.claimedQty, "target.claimedQty");
    positiveBigInt(input.target.claimResourceId, "target.claimResource.id");
    positiveInteger(input.target.inventoryLevelId, "target.inventoryLevel.id");
    positiveInteger(input.target.warehouseLocationId, "target.warehouseLocation.id");
    positiveInteger(input.target.sourceVariantId, "target.sourceVariant.id");
    positiveInteger(input.target.orderItemId, "target.orderItem.id");
    const observationReference = nonblank(input.observationReference, "observation.reference", 64);
    if (!/^[a-f0-9]{64}$/i.test(observationReference)) {
      throw new CanonicalClaimInventoryMutationError(
        "INVALID_OBSERVATION_REFERENCE",
        "The picker observation must carry the canonical command request hash.",
      );
    }
    if (input.releases.length === 0 || input.sourceCostLayers.length === 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OBSERVATION_SOURCE_MISSING",
        "A picker observation must rebind exact open claim ownership and its cost evidence.",
      );
    }
    const releaseQty = input.releases.reduce((total, resource) => total + resource.releaseQty, BigInt(0));
    const sourceCostQty = input.sourceCostLayers.reduce((total, layer) => total + layer.quantity, BigInt(0));
    if (releaseQty !== BigInt(claimedQty) || sourceCostQty !== BigInt(claimedQty)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OBSERVATION_QUANTITY_MISMATCH",
        "Released claim ownership and source cost evidence must equal the observed reconciliation quantity.",
        { releaseQty: releaseQty.toString(), sourceCostQty: sourceCostQty.toString(), claimedQty },
      );
    }
    const costsByInventoryLotId = new Map<number, CanonicalClaimInventoryObservationCostLayer>();
    for (const layer of input.sourceCostLayers) {
      const inventoryLotId = positiveInteger(layer.inventoryLotId, "observationCost.inventoryLotId");
      if (costsByInventoryLotId.has(inventoryLotId)) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_COST_DUPLICATED",
          "A source FIFO lot may appear only once in picker-observation cost evidence.",
          { inventoryLotId },
        );
      }
      positivePostgresInteger(layer.quantity, "observationCost.quantity");
      const total = postgresBigInt(layer.unitCostMills, "observationCost.unitCostMills");
      const po = postgresBigInt(layer.poUnitCostMills, "observationCost.poUnitCostMills");
      const packaging = postgresBigInt(
        layer.packagingUnitCostMills,
        "observationCost.packagingUnitCostMills",
      );
      const landed = postgresBigInt(layer.landedUnitCostMills, "observationCost.landedUnitCostMills");
      if (po + packaging + landed !== total) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_COST_MISMATCH",
          "Picker-observation cost components must reconcile to the source claim cost snapshot.",
        );
      }
      costsByInventoryLotId.set(inventoryLotId, layer);
    }
    const releasedByInventoryLotId = new Map<number, bigint>();
    for (const resource of input.releases) {
      if (resource.inventoryLevelId === input.target.inventoryLevelId
        || resource.warehouseLocationId === input.target.warehouseLocationId
        || resource.sourceVariantId !== input.target.sourceVariantId
        || resource.orderItemId !== input.target.orderItemId) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_IDENTITY_MISMATCH",
          "Picker-observation reconciliation must move the same order-line variant from another location.",
          { claimResourceId: resource.claimResourceId.toString() },
        );
      }
      const lotTotal = resource.lotAllocations.reduce((total, allocation) => {
        const inventoryLotId = positiveInteger(allocation.inventoryLotId, "releaseLot.inventoryLotId");
        releasedByInventoryLotId.set(
          inventoryLotId,
          (releasedByInventoryLotId.get(inventoryLotId) ?? BigInt(0)) + allocation.releaseQty,
        );
        return total + allocation.releaseQty;
      }, BigInt(0));
      if (lotTotal !== resource.releaseQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_RELEASE_LINEAGE_MISMATCH",
          "Each source resource must reconcile to its exact source FIFO quantities.",
          { claimResourceId: resource.claimResourceId.toString() },
        );
      }
    }
    if (releasedByInventoryLotId.size !== costsByInventoryLotId.size
      || [...releasedByInventoryLotId].some(([inventoryLotId, quantity]) =>
        costsByInventoryLotId.get(inventoryLotId)?.quantity !== quantity)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OBSERVATION_COST_LINEAGE_MISMATCH",
        "Source claim cost evidence must match every released FIFO lot exactly.",
      );
    }

    const levelIds = [...new Set([
      ...input.releases.map((resource) => resource.inventoryLevelId),
      input.target.inventoryLevelId,
    ])];
    const lockedLevels = rows(await input.client.query(
      `SELECT level.id, level.warehouse_location_id, level.product_variant_id,
              level.variant_qty, level.reserved_qty, location.warehouse_id
       FROM inventory.inventory_levels AS level
       JOIN warehouse.warehouse_locations AS location
         ON location.id = level.warehouse_location_id
       WHERE level.id = ANY($1::integer[])
       ORDER BY level.warehouse_location_id, level.product_variant_id, level.id
       FOR UPDATE OF level`,
      [levelIds],
    ));
    const targetLevel = lockedLevels.find((row) => Number(row.id) === input.target.inventoryLevelId);
    if (!targetLevel
      || positiveInteger(targetLevel.warehouse_location_id, "targetLevel.locationId")
        !== input.target.warehouseLocationId
      || positiveInteger(targetLevel.product_variant_id, "targetLevel.variantId")
        !== input.target.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OBSERVATION_TARGET_CHANGED",
        "The observed pick location no longer matches its inventory level identity.",
        { inventoryLevelId: input.target.inventoryLevelId },
      );
    }
    const targetWarehouseId = positiveInteger(targetLevel.warehouse_id, "targetLevel.warehouseId");
    const sourceLotIds = [...new Set(input.releases.flatMap((resource) =>
      resource.lotAllocations.map((allocation) => allocation.inventoryLotId)))];
    const lockedLots = rows(await input.client.query(
      `SELECT id, product_variant_id, warehouse_location_id, qty_on_hand, qty_reserved,
              qty_picked, status, received_at, receiving_order_id, purchase_order_id,
              inbound_shipment_id, build_order_id, build_run_id, po_line_id,
              cost_provisional, cost_source, unit_cost_cents, po_unit_cost_cents,
              packaging_cost_cents, landed_cost_cents, total_unit_cost_cents,
              unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
              landed_cost_mills, total_unit_cost_mills
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
          OR (product_variant_id = $2 AND warehouse_location_id = $3 AND status = 'active')
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [sourceLotIds, input.target.sourceVariantId, input.target.warehouseLocationId],
    ));
    const systemLevelQuantityBefore = BigInt(nonnegativeInteger(
      targetLevel.variant_qty,
      "targetLevel.variantQty",
    ));
    const targetReservedBefore = BigInt(nonnegativeInteger(
      targetLevel.reserved_qty,
      "targetLevel.reservedQty",
    ));
    const targetLots = lockedLots.filter((lot) =>
      Number(lot.product_variant_id) === input.target.sourceVariantId
      && Number(lot.warehouse_location_id) === input.target.warehouseLocationId
      && String(lot.status) === "active");
    const systemLotQuantityBefore = targetLots.reduce(
      (total, lot) => total + BigInt(nonnegativeInteger(lot.qty_on_hand, "targetLot.qtyOnHand")),
      BigInt(0),
    );
    const targetLotUnreserved = targetLots.reduce((total, lot) => {
      const onHand = nonnegativeInteger(lot.qty_on_hand, "targetLot.qtyOnHand");
      const reserved = nonnegativeInteger(lot.qty_reserved, "targetLot.qtyReserved");
      return total + BigInt(Math.max(0, onHand - reserved));
    }, BigInt(0));
    const targetLevelUnreserved = systemLevelQuantityBefore > targetReservedBefore
      ? systemLevelQuantityBefore - targetReservedBefore
      : BigInt(0);
    const recordedUnreservedQuantityBefore = targetLevelUnreserved < targetLotUnreserved
      ? targetLevelUnreserved
      : targetLotUnreserved;
    const recordedReconciledQuantity = recordedUnreservedQuantityBefore < BigInt(claimedQty)
      ? recordedUnreservedQuantityBefore
      : BigInt(claimedQty);
    const observedRelocatedQuantity = BigInt(claimedQty) - recordedReconciledQuantity;
    if (observedRelocatedQuantity === BigInt(0)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_PICK_OBSERVATION_NOT_REQUIRED",
        "Recorded unreserved stock can cover this rebind; use recorded-stock reconciliation instead.",
        { inventoryLevelId: input.target.inventoryLevelId, claimedQty },
      );
    }

    let recordedRemaining = recordedReconciledQuantity;
    const recordedReleases: CanonicalClaimInventoryReleaseResource[] = [];
    const relocations: Array<{
      resource: CanonicalClaimInventoryReleaseResource;
      inventoryLotId: number;
      quantity: bigint;
      costs: CanonicalClaimInventoryObservationCostLayer;
    }> = [];
    for (const resource of input.releases) {
      const recordedAllocations: Array<{ inventoryLotId: number; releaseQty: bigint }> = [];
      let recordedResourceQty = BigInt(0);
      for (const allocation of resource.lotAllocations) {
        const recordedTake = allocation.releaseQty < recordedRemaining
          ? allocation.releaseQty
          : recordedRemaining;
        if (recordedTake > BigInt(0)) {
          recordedAllocations.push({
            inventoryLotId: allocation.inventoryLotId,
            releaseQty: recordedTake,
          });
          recordedResourceQty += recordedTake;
          recordedRemaining -= recordedTake;
        }
        const relocateQty = allocation.releaseQty - recordedTake;
        if (relocateQty > BigInt(0)) {
          relocations.push({
            resource,
            inventoryLotId: allocation.inventoryLotId,
            quantity: relocateQty,
            costs: costsByInventoryLotId.get(allocation.inventoryLotId)!,
          });
        }
      }
      if (recordedResourceQty > BigInt(0)) {
        recordedReleases.push({
          ...resource,
          releaseQty: recordedResourceQty,
          lotAllocations: recordedAllocations,
        });
      }
    }
    if (recordedRemaining !== BigInt(0)
      || relocations.reduce((total, relocation) => total + relocation.quantity, BigInt(0))
        !== observedRelocatedQuantity) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OBSERVATION_SPLIT_MISMATCH",
        "Recorded rebind and observed relocation could not partition the exact source claim ownership.",
      );
    }

    const levelsById = new Map(lockedLevels.map((level) => [Number(level.id), level] as const));
    const lotsById = new Map(lockedLots.map((lot) => [Number(lot.id), lot] as const));
    const relocationByLevel = new Map<number, bigint>();
    for (const relocation of relocations) {
      const level = levelsById.get(relocation.resource.inventoryLevelId);
      const lot = lotsById.get(relocation.inventoryLotId);
      if (!level || !lot
        || positiveInteger(level.warehouse_id, "sourceLevel.warehouseId") !== targetWarehouseId
        || Number(level.warehouse_location_id) !== relocation.resource.warehouseLocationId
        || Number(level.product_variant_id) !== relocation.resource.sourceVariantId
        || Number(lot.warehouse_location_id) !== relocation.resource.warehouseLocationId
        || Number(lot.product_variant_id) !== relocation.resource.sourceVariantId
        || String(lot.status) !== "active") {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_SOURCE_CHANGED",
          "An exact claim-owned source level or FIFO lot no longer matches the observed relocation.",
          { inventoryLotId: relocation.inventoryLotId },
        );
      }
      const quantity = positivePostgresInteger(relocation.quantity, "observationRelocation.quantity");
      if (nonnegativeInteger(lot.qty_on_hand, "sourceLot.qtyOnHand") < quantity
        || nonnegativeInteger(lot.qty_reserved, "sourceLot.qtyReserved") < quantity) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_SOURCE_SHORTFALL",
          "The exact claim-owned source FIFO lot cannot support the observed relocation.",
          { inventoryLotId: relocation.inventoryLotId, quantity },
        );
      }
      let liveCosts: ReturnType<typeof normalizeBuildLotCosts>;
      try {
        liveCosts = normalizeBuildLotCosts(lot);
      } catch (cause) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A source FIFO lot has invalid cost evidence for observed relocation.",
          { inventoryLotId: relocation.inventoryLotId, cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      if (liveCosts.totalMills !== relocation.costs.unitCostMills
        || liveCosts.poMills !== relocation.costs.poUnitCostMills
        || liveCosts.packagingMills !== relocation.costs.packagingUnitCostMills
        || liveCosts.landedMills !== relocation.costs.landedUnitCostMills) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_SOURCE_COST_CHANGED",
          "A source FIFO lot no longer matches the claim cost snapshot used for observed relocation.",
          { inventoryLotId: relocation.inventoryLotId },
        );
      }
      relocationByLevel.set(
        relocation.resource.inventoryLevelId,
        (relocationByLevel.get(relocation.resource.inventoryLevelId) ?? BigInt(0)) + relocation.quantity,
      );
    }
    for (const [inventoryLevelId, quantity] of relocationByLevel) {
      const level = levelsById.get(inventoryLevelId)!;
      const moveQty = positivePostgresInteger(quantity, "observationLevel.relocationQty");
      if (nonnegativeInteger(level.variant_qty, "sourceLevel.variantQty") < moveQty
        || nonnegativeInteger(level.reserved_qty, "sourceLevel.reservedQty") < moveQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_SOURCE_LEVEL_SHORTFALL",
          "A source inventory level cannot support its exact observed relocation.",
          { inventoryLevelId, moveQty },
        );
      }
    }

    if (recordedReleases.length > 0) {
      await this.releaseResources({
        client: input.client,
        claimId: input.claimId,
        resources: recordedReleases,
        orderId: input.orderId,
        actor: input.actor,
        reason: input.reason,
        occurredAt: input.occurredAt,
      });
    }

    const allocations: CanonicalClaimLotAllocation[] = [];
    if (recordedReconciledQuantity > BigInt(0)) {
      allocations.push(...await this.reserveResource({
        client: input.client,
        claimId: input.claimId,
        claimResourceId: input.target.claimResourceId,
        inventoryLevelId: input.target.inventoryLevelId,
        warehouseLocationId: input.target.warehouseLocationId,
        sourceVariantId: input.target.sourceVariantId,
        claimedQty: Number(recordedReconciledQuantity),
        orderId: input.orderId,
        orderItemId: input.target.orderItemId,
        consumerOperationKey: null,
        actor: input.actor,
        occurredAt: input.occurredAt,
      }));
    }

    const relocatedInventoryLotIds: number[] = [];
    const recordedByLevel = new Map<number, bigint>();
    for (const resource of recordedReleases) {
      recordedByLevel.set(
        resource.inventoryLevelId,
        (recordedByLevel.get(resource.inventoryLevelId) ?? BigInt(0)) + resource.releaseQty,
      );
    }
    const runningSourceLevels = new Map<number, { variantQty: number; reservedQty: number }>();
    for (const [inventoryLevelId] of relocationByLevel) {
      const level = levelsById.get(inventoryLevelId)!;
      runningSourceLevels.set(inventoryLevelId, {
        variantQty: nonnegativeInteger(level.variant_qty, "sourceLevel.variantQty"),
        reservedQty: nonnegativeInteger(level.reserved_qty, "sourceLevel.reservedQty")
          - Number(recordedByLevel.get(inventoryLevelId) ?? BigInt(0)),
      });
    }
    for (const [index, relocation] of relocations.entries()) {
      const layer = relocation.costs;
      const sourceLot = lotsById.get(relocation.inventoryLotId)!;
      const quantity = positivePostgresInteger(relocation.quantity, "observationLot.quantity");
      if (sourceLot.cost_provisional == null) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A source FIFO lot is missing its provisional-cost marker.",
          { inventoryLotId: relocation.inventoryLotId },
        );
      }
      const costProvisional = nonnegativeInteger(sourceLot.cost_provisional, "sourceLot.costProvisional");
      if (costProvisional !== 0 && costProvisional !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A source FIFO lot has an invalid provisional-cost marker.",
          { inventoryLotId: relocation.inventoryLotId, costProvisional },
        );
      }
      const costSource = sourceLot.cost_source == null
        ? null
        : nonblank(String(sourceLot.cost_source), "sourceLot.costSource", 20);
      if (!(sourceLot.received_at instanceof Date) || Number.isNaN(sourceLot.received_at.getTime())) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_RECEIPT_TIME",
          "A source FIFO lot must retain a valid receipt time during observed relocation.",
          { inventoryLotId: relocation.inventoryLotId },
        );
      }
      const lotNumber = `OBS-${input.claimId}-${observationReference.slice(0, 12)}-${String(index + 1).padStart(2, "0")}`;
      if (lotNumber.length > 50) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_LOT_IDENTITY_OVERFLOW",
          "The deterministic picker-observation lot number exceeds its database limit.",
          { lotNumber },
        );
      }
      const totalCostCents = buildMillsToRoundedCents(layer.unitCostMills).toString();
      const updatedSourceLot = await input.client.query(
        `UPDATE inventory.inventory_lots
         SET qty_on_hand = qty_on_hand - $1,
             qty_reserved = qty_reserved - $1,
             status = CASE
               WHEN qty_on_hand - $1 = 0 AND qty_reserved - $1 = 0 AND qty_picked = 0
               THEN 'depleted' ELSE status END
         WHERE id = $2 AND qty_on_hand >= $1 AND qty_reserved >= $1`,
        [quantity, relocation.inventoryLotId],
      );
      if (updatedSourceLot.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_SOURCE_CONFLICT",
          "An exact source FIFO lot changed while observed relocation was posting.",
          { inventoryLotId: relocation.inventoryLotId, quantity },
        );
      }
      const insertedLot = rows(await input.client.query(
        `INSERT INTO inventory.inventory_lots (
           lot_number, product_variant_id, warehouse_location_id, receiving_order_id,
           purchase_order_id, inbound_shipment_id, build_order_id, build_run_id, po_line_id,
           unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
           landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
           po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
           total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
           qty_picked, qty_consumed, received_at, status, cost_provisional,
           cost_source, notes, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                   $10, $11, $12, $13, $10, $14, $15, $16, $17, $14,
                   $18, $18, $18, 0, 0, $19, 'active', $20,
                   $21, $22, $23)
         RETURNING id`,
        [
          lotNumber,
          input.target.sourceVariantId,
          input.target.warehouseLocationId,
          sourceLot.receiving_order_id == null
            ? null : positiveInteger(sourceLot.receiving_order_id, "sourceLot.receivingOrderId"),
          sourceLot.purchase_order_id == null
            ? null : positiveInteger(sourceLot.purchase_order_id, "sourceLot.purchaseOrderId"),
          sourceLot.inbound_shipment_id == null
            ? null : positiveInteger(sourceLot.inbound_shipment_id, "sourceLot.inboundShipmentId"),
          sourceLot.build_order_id == null
            ? null : positiveInteger(sourceLot.build_order_id, "sourceLot.buildOrderId"),
          sourceLot.build_run_id == null
            ? null : positiveInteger(sourceLot.build_run_id, "sourceLot.buildRunId"),
          sourceLot.po_line_id == null
            ? null : positiveInteger(sourceLot.po_line_id, "sourceLot.poLineId"),
          totalCostCents,
          buildMillsToRoundedCents(layer.poUnitCostMills).toString(),
          buildMillsToRoundedCents(layer.packagingUnitCostMills).toString(),
          buildMillsToRoundedCents(layer.landedUnitCostMills).toString(),
          layer.unitCostMills.toString(),
          layer.poUnitCostMills.toString(),
          layer.packagingUnitCostMills.toString(),
          layer.landedUnitCostMills.toString(),
          quantity,
          sourceLot.received_at,
          costProvisional,
          costSource,
          `Relocated by picker observation for claim ${input.claimId} from lot ${relocation.inventoryLotId}`,
          input.occurredAt,
        ],
      ))[0];
      const inventoryLotId = positiveInteger(insertedLot?.id, "observationInventoryLot.id");
      relocatedInventoryLotIds.push(inventoryLotId);
      allocations.push({
        inventoryLotId,
        qty: quantity,
        unitCostMills: layer.unitCostMills,
        poUnitCostMills: layer.poUnitCostMills,
        packagingUnitCostMills: layer.packagingUnitCostMills,
        landedUnitCostMills: layer.landedUnitCostMills,
      });
      const runningSource = runningSourceLevels.get(relocation.resource.inventoryLevelId)!;
      await input.client.query(
        `INSERT INTO inventory.inventory_transactions (
           product_variant_id, from_location_id, to_location_id, transaction_type,
           variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
           source_state, target_state, unit_cost_cents, inventory_lot_id,
           order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
         ) VALUES ($1, $2, $3, 'transfer', $4, $5, $6, 0,
                   'committed', 'committed', $7, $8, $9, $10,
                   'availability_claim_observation', $11, $12, $13, $14)`,
        [
          input.target.sourceVariantId,
          relocation.resource.warehouseLocationId,
          input.target.warehouseLocationId,
          quantity,
          runningSource.variantQty,
          runningSource.variantQty - quantity,
          totalCostCents,
          relocation.inventoryLotId,
          input.orderId,
          input.target.orderItemId,
          `claim:${input.claimId}:resource:${input.target.claimResourceId}:observation:${observationReference}:to-lot:${inventoryLotId}`,
          input.actor,
          input.reason,
          input.occurredAt,
        ],
      );
      await input.client.query(
        `INSERT INTO inventory.inventory_transactions (
           product_variant_id, from_location_id, to_location_id, transaction_type,
           variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
           source_state, target_state, unit_cost_cents, inventory_lot_id,
           order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
         ) VALUES ($1, $2, $3, 'reserve_move', $4, $5, $6, $4,
                   'reserved', 'reserved', $7, $8, $9, $10,
                   'availability_claim_observation', $11, $12, $13, $14)`,
        [
          input.target.sourceVariantId,
          relocation.resource.warehouseLocationId,
          input.target.warehouseLocationId,
          quantity,
          runningSource.reservedQty,
          runningSource.reservedQty - quantity,
          totalCostCents,
          relocation.inventoryLotId,
          input.orderId,
          input.target.orderItemId,
          `claim:${input.claimId}:resource:${input.target.claimResourceId}:observation:${observationReference}:reserved-to-lot:${inventoryLotId}`,
          input.actor,
          input.reason,
          input.occurredAt,
        ],
      );
      runningSource.variantQty -= quantity;
      runningSource.reservedQty -= quantity;
    }
    for (const [inventoryLevelId, quantity] of relocationByLevel) {
      const relocateQty = positivePostgresInteger(quantity, "observationLevel.relocationQty");
      const updatedSourceLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET variant_qty = variant_qty - $1,
             reserved_qty = reserved_qty - $1,
             updated_at = $3
         WHERE id = $2 AND variant_qty >= $1 AND reserved_qty >= $1`,
        [relocateQty, inventoryLevelId, input.occurredAt],
      );
      if (updatedSourceLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OBSERVATION_SOURCE_LEVEL_CONFLICT",
          "A source inventory level changed while observed relocation was posting.",
          { inventoryLevelId, relocateQty },
        );
      }
    }
    const observedQty = positivePostgresInteger(observedRelocatedQuantity, "observation.relocatedQty");
    const updatedLevel = await input.client.query(
      `UPDATE inventory.inventory_levels
       SET variant_qty = variant_qty + $1,
           reserved_qty = reserved_qty + $1,
           updated_at = $3
       WHERE id = $2
         AND variant_qty <= 2147483647 - $1
         AND reserved_qty <= 2147483647 - $1`,
      [observedQty, input.target.inventoryLevelId, input.occurredAt],
    );
    if (updatedLevel.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OBSERVATION_LEVEL_CONFLICT",
        "The observed inventory relocation could not be applied to its locked target level.",
        { inventoryLevelId: input.target.inventoryLevelId, observedQty },
      );
    }

    return {
      allocations,
      recordedReconciledQuantity,
      observedRelocatedQuantity,
      relocatedInventoryLotIds,
      systemLevelQuantityBefore,
      systemLotQuantityBefore,
      recordedUnreservedQuantityBefore,
    };
  }

  async pickResources(
    input: Parameters<CanonicalClaimInventoryMutationPort["pickResources"]>[0],
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["pickResources"]>>> {
    validateAuditInput(input);
    positiveBigInt(input.claimLineId, "claimLine.id");
    positiveInteger(input.orderItemId, "orderItem.id");
    const resources = validatePickResources(input.resources);
    const { levelsById, lotsById } = await lockPickInventory(input.client, resources);
    validatePickInventory(resources, levelsById, lotsById);

    const runningLevels = new Map<number, { variantQty: number; reservedQty: number }>(
      [...levelsById].map(([id, level]) => [id, {
        variantQty: nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty"),
        reservedQty: nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty"),
      }]),
    );
    const movements: Awaited<ReturnType<CanonicalClaimInventoryMutationPort["pickResources"]>>["movements"][number][] = [];
    let totalCostMills = BigInt(0);
    for (const resource of resources) {
      for (const allocation of resource.lotAllocations) {
        const pickQty = positivePostgresInteger(allocation.pickQty, "claimLot.pickQty");
        const totalMills = allocation.unitCostMills * BigInt(pickQty);
        postgresBigInt(totalMills, "claimLot.totalCostMills");
        const updatedLot = await input.client.query(
          `UPDATE inventory.inventory_lots
           SET qty_on_hand = qty_on_hand - $1,
               qty_reserved = qty_reserved - $1,
               qty_picked = qty_picked + $1
           WHERE id = $2 AND qty_on_hand >= $1 AND qty_reserved >= $1
             AND qty_picked <= 2147483647 - $1`,
          [pickQty, allocation.inventoryLotId],
        );
        if (updatedLot.rowCount !== 1) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_LOT_PICK_CONFLICT",
            "An exact claim-owned FIFO lot changed while its pick was posting.",
            { inventoryLotId: allocation.inventoryLotId, pickQty },
          );
        }
        const cogsRow = rows(await input.client.query(
          `INSERT INTO oms.order_item_costs (
             order_id, order_item_id, inventory_lot_id, product_variant_id, qty,
             unit_cost_cents, total_cost_cents, unit_cost_mills, total_cost_mills, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            input.orderId,
            input.orderItemId,
            allocation.inventoryLotId,
            resource.sourceVariantId,
            pickQty,
            buildMillsToRoundedCents(allocation.unitCostMills).toString(),
            buildMillsToRoundedCents(totalMills).toString(),
            allocation.unitCostMills.toString(),
            totalMills.toString(),
            input.occurredAt,
          ],
        ))[0];
        const running = runningLevels.get(resource.inventoryLevelId)!;
        const variantBefore = running.variantQty;
        running.variantQty -= pickQty;
        running.reservedQty -= pickQty;
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, from_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'pick', $3, $4, $5, $3, 'committed', 'picked',
                     $6, $7, $8, $9, 'availability_claim_pick', $10, $11, $12, $13)`,
          [
            resource.sourceVariantId,
            resource.warehouseLocationId,
            -pickQty,
            variantBefore,
            running.variantQty,
            buildMillsToRoundedCents(allocation.unitCostMills).toString(),
            allocation.inventoryLotId,
            input.orderId,
            input.orderItemId,
            `claim:${input.claimId}:line:${input.claimLineId}:resource:${resource.claimResourceId}`,
            input.actor,
            input.reason,
            input.occurredAt,
          ],
        );
        movements.push({
          claimResourceId: resource.claimResourceId,
          claimLotAllocationId: allocation.claimLotAllocationId,
          inventoryLotId: allocation.inventoryLotId,
          quantity: BigInt(pickQty),
          unitCostMills: allocation.unitCostMills,
          totalCostMills: totalMills,
          orderItemCostId: positiveInteger(cogsRow?.id, "orderItemCost.id"),
          reversesPickMovementId: null,
        });
        totalCostMills += totalMills;
        postgresBigInt(totalCostMills, "pick.totalCostMills");
      }
    }
    for (const [levelId, quantities] of [...sumPickByLevel(resources)].sort(([left], [right]) => left - right)) {
      const qty = positivePostgresInteger(quantities, "inventoryLevel.pickQty");
      const updatedLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET variant_qty = variant_qty - $1,
             reserved_qty = reserved_qty - $1,
             picked_qty = picked_qty + $1,
             updated_at = $3
         WHERE id = $2 AND variant_qty >= $1 AND reserved_qty >= $1
           AND picked_qty <= 2147483647 - $1`,
        [qty, levelId, input.occurredAt],
      );
      if (updatedLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_PICK_CONFLICT",
          "An exact claim-owned inventory level changed while its pick was posting.",
          { inventoryLevelId: levelId, pickQty: qty },
        );
      }
    }
    return { movements, totalCostMills };
  }

  async unpickResources(
    input: Parameters<CanonicalClaimInventoryMutationPort["unpickResources"]>[0],
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["unpickResources"]>>> {
    validateAuditInput(input);
    positiveBigInt(input.claimLineId, "claimLine.id");
    positiveInteger(input.orderItemId, "orderItem.id");
    const resources = validateUnpickResources(input.resources);
    const { levelsById, lotsById } = await lockUnpickInventory(input.client, resources);
    validateUnpickInventory(resources, levelsById, lotsById, input.restoreReservation);

    const runningLevels = new Map<number, { variantQty: number; reservedQty: number }>(
      [...levelsById].map(([id, level]) => [id, {
        variantQty: nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty"),
        reservedQty: nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty"),
      }]),
    );
    const movements: Awaited<ReturnType<CanonicalClaimInventoryMutationPort["unpickResources"]>>["movements"][number][] = [];
    let totalCostMills = BigInt(0);
    for (const resource of resources) {
      for (const allocation of resource.lotAllocations) {
        const unpickQty = positivePostgresInteger(allocation.unpickQty, "claimLot.unpickQty");
        const totalMills = allocation.unitCostMills * BigInt(unpickQty);
        postgresBigInt(totalMills, "claimLot.totalCostMills");
        const updatedLot = await input.client.query(
          `UPDATE inventory.inventory_lots
           SET qty_on_hand = qty_on_hand + $1,
               qty_reserved = qty_reserved + $2,
               qty_picked = qty_picked - $1,
               status = 'active'
           WHERE id = $3 AND qty_picked >= $1
             AND qty_on_hand <= 2147483647 - $1
             AND qty_reserved <= 2147483647 - $2`,
          [unpickQty, input.restoreReservation ? unpickQty : 0, allocation.inventoryLotId],
        );
        if (updatedLot.rowCount !== 1) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_LOT_UNPICK_CONFLICT",
            "An exact canonical picked FIFO lot changed while its unpick was posting.",
            { inventoryLotId: allocation.inventoryLotId, unpickQty },
          );
        }
        const cogsRow = rows(await input.client.query(
          `INSERT INTO oms.order_item_costs (
             order_id, order_item_id, inventory_lot_id, product_variant_id, qty,
             unit_cost_cents, total_cost_cents, unit_cost_mills, total_cost_mills, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            input.orderId,
            input.orderItemId,
            allocation.inventoryLotId,
            resource.sourceVariantId,
            -unpickQty,
            buildMillsToRoundedCents(allocation.unitCostMills).toString(),
            (-buildMillsToRoundedCents(totalMills)).toString(),
            allocation.unitCostMills.toString(),
            (-totalMills).toString(),
            input.occurredAt,
          ],
        ))[0];
        const running = runningLevels.get(resource.inventoryLevelId)!;
        const variantBefore = running.variantQty;
        running.variantQty += unpickQty;
        if (input.restoreReservation) running.reservedQty += unpickQty;
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, to_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'unpick', $3, $4, $5, $6, 'picked', $7,
                     $8, $9, $10, $11, 'availability_claim_unpick', $12, $13, $14, $15)`,
          [
            resource.sourceVariantId,
            resource.warehouseLocationId,
            unpickQty,
            variantBefore,
            running.variantQty,
            input.restoreReservation ? unpickQty : 0,
            input.restoreReservation ? "committed" : "on_hand",
            buildMillsToRoundedCents(allocation.unitCostMills).toString(),
            allocation.inventoryLotId,
            input.orderId,
            input.orderItemId,
            `claim:${input.claimId}:line:${input.claimLineId}:pick:${allocation.reversesPickMovementId}`,
            input.actor,
            input.reason,
            input.occurredAt,
          ],
        );
        movements.push({
          claimResourceId: resource.claimResourceId,
          claimLotAllocationId: allocation.claimLotAllocationId,
          inventoryLotId: allocation.inventoryLotId,
          quantity: BigInt(unpickQty),
          unitCostMills: allocation.unitCostMills,
          totalCostMills: totalMills,
          orderItemCostId: positiveInteger(cogsRow?.id, "orderItemCost.id"),
          reversesPickMovementId: allocation.reversesPickMovementId,
        });
        totalCostMills += totalMills;
        postgresBigInt(totalCostMills, "unpick.totalCostMills");
      }
    }
    for (const [levelId, quantity] of [...sumUnpickByLevel(resources)].sort(([left], [right]) => left - right)) {
      const qty = positivePostgresInteger(quantity, "inventoryLevel.unpickQty");
      const reservedRestore = input.restoreReservation ? qty : 0;
      const updatedLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET variant_qty = variant_qty + $1,
             reserved_qty = reserved_qty + $2,
             picked_qty = picked_qty - $1,
             updated_at = $4
         WHERE id = $3 AND picked_qty >= $1
           AND variant_qty <= 2147483647 - $1
           AND reserved_qty <= 2147483647 - $2`,
        [qty, reservedRestore, levelId, input.occurredAt],
      );
      if (updatedLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_UNPICK_CONFLICT",
          "An exact canonical picked inventory level changed while its unpick was posting.",
          { inventoryLevelId: levelId, unpickQty: qty },
        );
      }
    }
    return { movements, totalCostMills };
  }

  async executePackageOperation(
    input: Parameters<CanonicalClaimInventoryMutationPort["executePackageOperation"]>[0],
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executePackageOperation"]>>> {
    return this.executeTransformationOperation(input);
  }

  async executeBuildOperation(
    input: Parameters<CanonicalClaimInventoryMutationPort["executeBuildOperation"]>[0],
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executeBuildOperation"]>>> {
    return this.executeTransformationOperation(input);
  }

  private async executeTransformationOperation(
    input: CanonicalTransformationExecutionInput,
  ): Promise<Awaited<ReturnType<CanonicalClaimInventoryMutationPort["executePackageOperation"]>>> {
    validateAuditInput(input);
    positiveBigInt(input.claimOperationId, "claimOperation.id");
    const operationKey = nonblank(input.operationKey, "operation.key", 300);
    const outputLocationId = positiveInteger(input.outputLocationId, "operation.outputLocationId");
    const destinationVariantId = positiveInteger(input.destinationVariantId, "operation.destinationVariantId");
    const outputQty = positivePostgresInteger(input.outputQty, "operation.outputQty");
    const committedOutputQty = positivePostgresInteger(
      input.committedOutputQty,
      "operation.committedOutputQty",
    );
    if (committedOutputQty > outputQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OPERATION_OUTPUT_OVERCOMMITTED",
        "Committed claim output cannot exceed physical transformation output.",
        { outputQty, committedOutputQty },
      );
    }
    if (input.resources.length === 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OPERATION_INPUTS_MISSING",
        "A transformation requires exact claim-owned source resources.",
      );
    }
    if (input.resources.some((resource) => resource.sourceVariantId === destinationVariantId)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OPERATION_SELF_TRANSFORMATION",
        "A transformation cannot consume and produce the same variant.",
        { destinationVariantId },
      );
    }

    const build = "build" in input ? input.build : null;
    const buildComponentsByVariant = new Map<number, number>();
    if (build) {
      positiveInteger(build.buildOrderId, "buildOrder.id");
      positiveInteger(build.buildRunId, "buildRun.id");
      positiveInteger(build.buildRunNumber, "buildRun.runNumber");
      nonblank(build.buildSystemNumber, "buildOrder.systemNumber", 40);
      for (const component of build.components) {
        const sourceVariantId = positiveInteger(component.sourceVariantId, "buildComponent.sourceVariantId");
        const buildOrderComponentId = positiveInteger(
          component.buildOrderComponentId,
          "buildComponent.id",
        );
        if (buildComponentsByVariant.has(sourceVariantId)) {
          throw new CanonicalClaimInventoryMutationError(
            "DUPLICATE_CLAIM_BUILD_COMPONENT",
            "A claim build may contain only one immutable component snapshot per source variant.",
            { sourceVariantId },
          );
        }
        buildComponentsByVariant.set(sourceVariantId, buildOrderComponentId);
      }
    }

    const resources = [...input.resources].sort(compareExecutionResources);
    const seenResourceIds = new Set<string>();
    const seenLotAllocationIds = new Set<string>();
    const seenInventoryLotIds = new Set<number>();
    for (const resource of resources) {
      const resourceKey = positiveBigInt(resource.claimResourceId, "claimResource.id").toString();
      if (seenResourceIds.has(resourceKey)) {
        throw new CanonicalClaimInventoryMutationError(
          "DUPLICATE_CLAIM_EXECUTION_RESOURCE",
          "A claim resource may be consumed only once in an operation execution.",
          { claimResourceId: resourceKey },
        );
      }
      seenResourceIds.add(resourceKey);
      positiveInteger(resource.inventoryLevelId, "inventoryLevel.id");
      positiveInteger(resource.warehouseLocationId, "warehouseLocation.id");
      positiveInteger(resource.sourceVariantId, "sourceVariant.id");
      positivePostgresInteger(resource.consumeQty, "claimResource.consumeQty");
      let lotTotal = BigInt(0);
      for (const allocation of resource.lotAllocations) {
        const allocationKey = positiveBigInt(
          allocation.claimLotAllocationId,
          "claimLotAllocation.id",
        ).toString();
        const inventoryLotId = positiveInteger(allocation.inventoryLotId, "inventoryLot.id");
        if (seenLotAllocationIds.has(allocationKey) || seenInventoryLotIds.has(inventoryLotId)) {
          throw new CanonicalClaimInventoryMutationError(
            "DUPLICATE_CLAIM_EXECUTION_LOT",
            "An exact claim lot allocation and physical FIFO lot may be consumed only once per operation.",
            { claimLotAllocationId: allocationKey, inventoryLotId },
          );
        }
        seenLotAllocationIds.add(allocationKey);
        seenInventoryLotIds.add(inventoryLotId);
        positivePostgresInteger(allocation.consumeQty, "claimLotAllocation.consumeQty");
        const total = postgresBigInt(allocation.unitCostMills, "claimLotAllocation.unitCostMills");
        const po = postgresBigInt(allocation.poUnitCostMills, "claimLotAllocation.poUnitCostMills");
        const packaging = postgresBigInt(
          allocation.packagingUnitCostMills,
          "claimLotAllocation.packagingUnitCostMills",
        );
        const landed = postgresBigInt(
          allocation.landedUnitCostMills,
          "claimLotAllocation.landedUnitCostMills",
        );
        if (po + packaging + landed !== total) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_LOT_COST_LINEAGE_MISMATCH",
            "Claim-owned lot cost components do not reconcile to their authoritative total.",
            { claimLotAllocationId: allocationKey, inventoryLotId },
          );
        }
        lotTotal += allocation.consumeQty;
      }
      if (lotTotal !== resource.consumeQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_EXECUTION_LINEAGE_MISMATCH",
          "Exact open lot allocations do not reconcile to their claim resource.",
          {
            claimResourceId: resourceKey,
            resourceQty: resource.consumeQty.toString(),
            lotQty: lotTotal.toString(),
          },
        );
      }
    }

    await input.client.query(
      `INSERT INTO inventory.inventory_levels (
         product_variant_id, warehouse_location_id, variant_qty, reserved_qty,
         picked_qty, packed_qty, backorder_qty, updated_at
       ) VALUES ($1, $2, 0, 0, 0, 0, 0, $3)
       ON CONFLICT (product_variant_id, warehouse_location_id) DO NOTHING`,
      [destinationVariantId, outputLocationId, input.occurredAt],
    );

    const inputLevelIds = [...new Set(resources.map((resource) => resource.inventoryLevelId))];
    const levelRows = rows(await input.client.query(
      `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty
       FROM inventory.inventory_levels
       WHERE id = ANY($1::integer[])
          OR (product_variant_id = $2 AND warehouse_location_id = $3)
       ORDER BY warehouse_location_id, product_variant_id, id
       FOR UPDATE`,
      [inputLevelIds, destinationVariantId, outputLocationId],
    ));
    const levelsById = new Map(
      levelRows.map((level) => [positiveInteger(level.id, "inventoryLevel.id"), level] as const),
    );
    const outputLevel = levelRows.find((level) =>
      positiveInteger(level.product_variant_id, "inventoryLevel.variantId") === destinationVariantId
      && positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") === outputLocationId);
    if (!outputLevel) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OUTPUT_LEVEL_MISSING",
        "The transformation output inventory level could not be created and locked.",
        { destinationVariantId, outputLocationId },
      );
    }

    const consumeByLevel = new Map<number, number>();
    for (const resource of resources) {
      const level = levelsById.get(resource.inventoryLevelId);
      if (!level
        || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
        || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_RESOURCE_CHANGED",
          "A claim-owned transformation resource no longer matches its inventory level.",
          { claimResourceId: resource.claimResourceId.toString(), inventoryLevelId: resource.inventoryLevelId },
        );
      }
      const consumeQty = positivePostgresInteger(resource.consumeQty, "claimResource.consumeQty");
      consumeByLevel.set(
        resource.inventoryLevelId,
        (consumeByLevel.get(resource.inventoryLevelId) ?? 0) + consumeQty,
      );
    }
    for (const [levelId, consumeQty] of consumeByLevel) {
      const level = levelsById.get(levelId)!;
      if (nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty") < consumeQty
        || nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty") < consumeQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_EXECUTION_CONFLICT",
          "A claim-owned source level no longer contains its exact physical and reserved quantities.",
          { levelId, consumeQty },
        );
      }
    }

    const allocationEntries = resources.flatMap((resource) => resource.lotAllocations.map((allocation) => ({
      resource,
      allocation,
    }))).sort((left, right) =>
      left.resource.warehouseLocationId - right.resource.warehouseLocationId
      || left.resource.sourceVariantId - right.resource.sourceVariantId
      || left.allocation.inventoryLotId - right.allocation.inventoryLotId);
    const inventoryLotIds = allocationEntries.map(({ allocation }) => allocation.inventoryLotId);
    const lotRows = rows(await input.client.query(
      `SELECT id, product_variant_id, warehouse_location_id, qty_on_hand, qty_reserved,
              qty_picked, status, received_at, unit_cost_cents, po_unit_cost_cents,
              packaging_cost_cents, landed_cost_cents, total_unit_cost_cents,
              unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
              landed_cost_mills, total_unit_cost_mills
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [inventoryLotIds],
    ));
    const lotsById = new Map(
      lotRows.map((lot) => [positiveInteger(lot.id, "inventoryLot.id"), lot] as const),
    );
    if (lotsById.size !== inventoryLotIds.length) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_EXECUTION_LOT_MISSING",
        "One or more exact claim-owned FIFO lots no longer exist.",
        { requestedLotIds: inventoryLotIds, lockedLotIds: [...lotsById.keys()] },
      );
    }

    const totalCosts = { poMills: BigInt(0), packagingMills: BigInt(0), landedMills: BigInt(0) };
    for (const { resource, allocation } of allocationEntries) {
      const lot = lotsById.get(allocation.inventoryLotId)!;
      const consumeQty = positivePostgresInteger(allocation.consumeQty, "claimLotAllocation.consumeQty");
      if (positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId
        || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_EXECUTION_LOT_IDENTITY_CHANGED",
          "An exact claim-owned FIFO lot no longer matches its resource identity.",
          { inventoryLotId: allocation.inventoryLotId, claimResourceId: resource.claimResourceId.toString() },
        );
      }
      if (String(lot.status) !== "active") {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_EXECUTION_LOT_INACTIVE",
          "An exact claim-owned FIFO lot is no longer active.",
          { inventoryLotId: allocation.inventoryLotId, status: lot.status },
        );
      }
      if (nonnegativeInteger(lot.qty_on_hand, "inventoryLot.qtyOnHand") < consumeQty
        || nonnegativeInteger(lot.qty_reserved, "inventoryLot.qtyReserved") < consumeQty) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_EXECUTION_CONFLICT",
          "An exact claim-owned FIFO lot no longer contains its physical and reserved quantities.",
          { inventoryLotId: allocation.inventoryLotId, consumeQty },
        );
      }
      let liveCosts: ReturnType<typeof normalizeBuildLotCosts>;
      try {
        liveCosts = normalizeBuildLotCosts(lot);
      } catch (cause) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_LOT_COST",
          "A claim-owned source lot has invalid current cost evidence.",
          { inventoryLotId: allocation.inventoryLotId, cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      if (liveCosts.totalMills !== allocation.unitCostMills
        || liveCosts.poMills !== allocation.poUnitCostMills
        || liveCosts.packagingMills !== allocation.packagingUnitCostMills
        || liveCosts.landedMills !== allocation.landedUnitCostMills) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_COST_CHANGED",
          "A claim-owned source lot was re-costed after the claim and must be replanned before execution.",
          { inventoryLotId: allocation.inventoryLotId },
        );
      }
      const multiplier = BigInt(consumeQty);
      totalCosts.poMills += allocation.poUnitCostMills * multiplier;
      totalCosts.packagingMills += allocation.packagingUnitCostMills * multiplier;
      totalCosts.landedMills += allocation.landedUnitCostMills * multiplier;
    }

    const runningLevels = new Map<number, { variantQty: number; reservedQty: number }>(
      [...levelsById].map(([id, level]) => [id, {
        variantQty: nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty"),
        reservedQty: nonnegativeInteger(level.reserved_qty, "inventoryLevel.reservedQty"),
      }]),
    );
    const referenceId = `claim:${input.claimId}:operation:${input.claimOperationId}`;
    for (const { resource, allocation } of allocationEntries) {
      const consumeQty = positivePostgresInteger(allocation.consumeQty, "claimLotAllocation.consumeQty");
      const updatedLot = await input.client.query(
        `UPDATE inventory.inventory_lots
         SET qty_on_hand = qty_on_hand - $1,
             qty_reserved = qty_reserved - $1,
             qty_consumed = COALESCE(qty_consumed, 0) + $1,
             status = CASE
               WHEN qty_on_hand - $1 = 0 AND qty_reserved - $1 = 0 AND qty_picked = 0
               THEN 'depleted' ELSE status END
         WHERE id = $2 AND qty_on_hand >= $1 AND qty_reserved >= $1`,
        [consumeQty, allocation.inventoryLotId],
      );
      if (updatedLot.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LOT_EXECUTION_CONFLICT",
          "An exact claim-owned FIFO lot changed while transformation consumption was posting.",
          { inventoryLotId: allocation.inventoryLotId, consumeQty },
        );
      }
      const running = runningLevels.get(resource.inventoryLevelId)!;
      const variantBefore = running.variantQty;
      running.variantQty -= consumeQty;
      running.reservedQty -= consumeQty;
      const transactionValues = [
        resource.sourceVariantId,
        resource.warehouseLocationId,
        -consumeQty,
        variantBefore,
        running.variantQty,
        buildMillsToRoundedCents(allocation.unitCostMills).toString(),
        allocation.inventoryLotId,
        input.orderId,
        input.orderItemId,
        referenceId,
        input.actor,
        input.reason,
        input.occurredAt,
      ];
      if (build) {
        const componentId = buildComponentsByVariant.get(resource.sourceVariantId);
        if (!componentId) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_BUILD_COMPONENT_MISSING",
            "A claim-owned build source has no matching immutable build component.",
            { sourceVariantId: resource.sourceVariantId },
          );
        }
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, from_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id,
             build_order_id, build_order_component_id, build_run_id,
             user_id, notes, created_at
           ) VALUES ($1, $2, 'assemble', $3, $4, $5, $3, 'committed', 'consumed',
                     $6, $7, $8, $9, 'availability_claim_operation', $10,
                     $14, $15, $16, $11, $12, $13)`,
          [...transactionValues, build.buildOrderId, componentId, build.buildRunId],
        );
      } else {
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, from_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'transform', $3, $4, $5, $3, 'committed', 'consumed',
                     $6, $7, $8, $9, 'availability_claim_operation', $10, $11, $12, $13)`,
          transactionValues,
        );
      }
    }
    for (const [levelId, consumeQty] of [...consumeByLevel].sort(([left], [right]) => left - right)) {
      const updatedLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET variant_qty = variant_qty - $1,
             reserved_qty = reserved_qty - $1,
             updated_at = $3
         WHERE id = $2 AND variant_qty >= $1 AND reserved_qty >= $1`,
        [consumeQty, levelId, input.occurredAt],
      );
      if (updatedLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_EXECUTION_CONFLICT",
          "A claim-owned source level changed while transformation consumption was posting.",
          { levelId, consumeQty },
        );
      }
    }

    const updatedOutputLevel = await input.client.query(
      `UPDATE inventory.inventory_levels
       SET variant_qty = variant_qty + $1,
           reserved_qty = reserved_qty + $2,
           updated_at = $4
       WHERE id = $3
         AND variant_qty <= 2147483647 - $1
         AND reserved_qty <= 2147483647 - $2`,
      [outputQty, committedOutputQty, outputLevel.id, input.occurredAt],
    );
    if (updatedOutputLevel.rowCount !== 1) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OUTPUT_LEVEL_OVERFLOW",
        "The transformation output would overflow its inventory level.",
        { outputInventoryLevelId: outputLevel.id, outputQty, committedOutputQty },
      );
    }

    const outputLayers = allocateBuildCostLayers(totalCosts, outputQty);
    const outputSegments: Array<(typeof outputLayers)[number] & { reservedQty: number }> = [];
    let remainingCommitted = committedOutputQty;
    for (const layer of outputLayers) {
      const reservedQty = Math.min(layer.qty, remainingCommitted);
      if (reservedQty > 0) outputSegments.push({ ...layer, qty: reservedQty, reservedQty });
      if (reservedQty < layer.qty) {
        outputSegments.push({ ...layer, qty: layer.qty - reservedQty, reservedQty: 0 });
      }
      remainingCommitted -= reservedQty;
    }
    if (remainingCommitted !== 0) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_OUTPUT_ALLOCATION_MISMATCH",
        "Produced cost layers could not satisfy the committed output quantity.",
        { committedOutputQty, remainingCommitted },
      );
    }

    const committedLotAllocations: CanonicalClaimProducedLotAllocation[] = [];
    let outputVariantBefore = nonnegativeInteger(outputLevel.variant_qty, "outputInventoryLevel.variantQty");
    for (const [index, segment] of outputSegments.entries()) {
      const lotNumber = build
        ? `${build.buildSystemNumber}-R${build.buildRunNumber}-${String(index + 1).padStart(2, "0")}`
        : `CLM-${input.claimId}-${input.claimOperationId}-${String(index + 1).padStart(2, "0")}`;
      if (lotNumber.length > 50) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_OUTPUT_LOT_IDENTITY_OVERFLOW",
          "The deterministic claim output lot number exceeds its database limit.",
          { lotNumber },
        );
      }
      postgresBigInt(segment.totalMills, "outputLot.totalUnitCostMills");
      postgresBigInt(segment.poMills, "outputLot.poUnitCostMills");
      postgresBigInt(segment.packagingMills, "outputLot.packagingUnitCostMills");
      postgresBigInt(segment.landedMills, "outputLot.landedUnitCostMills");
      const totalCostCents = buildMillsToRoundedCents(segment.totalMills).toString();
      const lotValues = [
        lotNumber,
        destinationVariantId,
        outputLocationId,
        totalCostCents,
        buildMillsToRoundedCents(segment.poMills).toString(),
        buildMillsToRoundedCents(segment.packagingMills).toString(),
        buildMillsToRoundedCents(segment.landedMills).toString(),
        segment.totalMills.toString(),
        segment.poMills.toString(),
        segment.packagingMills.toString(),
        segment.landedMills.toString(),
        segment.qty,
        segment.reservedQty,
        input.occurredAt,
        build
          ? `Output from canonical claim build ${build.buildSystemNumber}`
          : `Output from canonical operation ${operationKey}`,
      ];
      const insertedLot = rows(await input.client.query(
        build
          ? `INSERT INTO inventory.inventory_lots (
               lot_number, product_variant_id, warehouse_location_id, build_order_id, build_run_id,
               unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
               landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
               po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
               total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
               qty_picked, qty_consumed, received_at, status, cost_provisional,
               cost_source, notes, created_at
             ) VALUES ($1, $2, $3, $16, $17, $4, $5, $6, $7, $4, $8, $9, $10, $11, $8,
                       $12, $12, $13, 0, 0, $14, 'active', 0, 'build', $15, $14)
             RETURNING id`
          : `INSERT INTO inventory.inventory_lots (
               lot_number, product_variant_id, warehouse_location_id,
               unit_cost_cents, po_unit_cost_cents, packaging_cost_cents,
               landed_cost_cents, total_unit_cost_cents, unit_cost_mills,
               po_unit_cost_mills, packaging_cost_mills, landed_cost_mills,
               total_unit_cost_mills, qty_received, qty_on_hand, qty_reserved,
               qty_picked, qty_consumed, received_at, status, cost_provisional,
               cost_source, notes, created_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $4, $8, $9, $10, $11, $8,
                       $12, $12, $13, 0, 0, $14, 'active', 0, 'transformation', $15, $14)
             RETURNING id`,
        build ? [...lotValues, build.buildOrderId, build.buildRunId] : lotValues,
      ))[0];
      const outputLotId = positiveInteger(insertedLot?.id, "outputInventoryLot.id");
      const outputTransactionValues = [
        destinationVariantId,
        outputLocationId,
        segment.qty,
        outputVariantBefore,
        outputVariantBefore + segment.qty,
        segment.reservedQty,
        segment.reservedQty > 0 ? "committed" : "on_hand",
        totalCostCents,
        outputLotId,
        input.orderId,
        input.orderItemId,
        referenceId,
        input.actor,
        input.reason,
        input.occurredAt,
      ];
      if (build) {
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, to_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id,
             build_order_id, build_run_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'assemble', $3, $4, $5, $6, 'built', $7,
                     $8, $9, $10, $11, 'availability_claim_operation', $12,
                     $16, $17, $13, $14, $15)`,
          [...outputTransactionValues, build.buildOrderId, build.buildRunId],
        );
      } else {
        await input.client.query(
          `INSERT INTO inventory.inventory_transactions (
             product_variant_id, to_location_id, transaction_type,
             variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
             source_state, target_state, unit_cost_cents, inventory_lot_id,
             order_id, order_item_id, reference_type, reference_id, user_id, notes, created_at
           ) VALUES ($1, $2, 'transform', $3, $4, $5, $6, 'transformed', $7,
                     $8, $9, $10, $11, 'availability_claim_operation', $12, $13, $14, $15)`,
          outputTransactionValues,
        );
      }
      outputVariantBefore += segment.qty;
      if (segment.reservedQty > 0) {
        committedLotAllocations.push({
          inventoryLotId: outputLotId,
          qty: segment.reservedQty,
          unitCostMills: segment.totalMills,
          poUnitCostMills: segment.poMills,
          packagingUnitCostMills: segment.packagingMills,
          landedUnitCostMills: segment.landedMills,
        });
      }
    }

    const totalInputCostMills = totalCosts.poMills + totalCosts.packagingMills + totalCosts.landedMills;
    return {
      outputInventoryLevelId: positiveInteger(outputLevel.id, "outputInventoryLevel.id"),
      committedLotAllocations,
      totalInputCostMills,
    };
  }

  async releaseResources(
    input: Parameters<CanonicalClaimInventoryMutationPort["releaseResources"]>[0],
  ): Promise<void> {
    validateAuditInput(input);
    if (input.resources.length === 0) return;
    for (const resource of input.resources) {
      positiveBigInt(resource.claimResourceId, "claimResource.id");
      positiveInteger(resource.inventoryLevelId, "inventoryLevel.id");
      positiveInteger(resource.warehouseLocationId, "warehouseLocation.id");
      positiveInteger(resource.sourceVariantId, "sourceVariant.id");
      positiveInteger(resource.orderItemId, "orderItem.id");
      for (const allocation of resource.lotAllocations) {
        positiveInteger(allocation.inventoryLotId, "inventoryLot.id");
      }
    }
    const orderedResources = [...input.resources].sort(compareReleaseResources);
    assertUniqueReleaseResources(orderedResources);

    const levelIds = [...new Set(orderedResources.map((resource) => resource.inventoryLevelId))];
    const levelRows = rows(await input.client.query(
      `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty
       FROM inventory.inventory_levels
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, id
       FOR UPDATE`,
      [levelIds],
    ));
    const levelsById = new Map(levelRows.map((level) => [positiveInteger(level.id, "inventoryLevel.id"), level] as const));
    if (levelsById.size !== levelIds.length) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LEVEL_RELEASE_MISSING",
        "One or more exact claim-owned inventory levels no longer exist.",
        { requestedLevelIds: levelIds, lockedLevelIds: [...levelsById.keys()] },
      );
    }

    const lotIds = [...new Set(
      orderedResources.flatMap((resource) => resource.lotAllocations.map((allocation) => allocation.inventoryLotId)),
    )];
    const lotRows = lotIds.length === 0 ? [] : rows(await input.client.query(
      `SELECT id, warehouse_location_id, product_variant_id, qty_reserved
       FROM inventory.inventory_lots
       WHERE id = ANY($1::integer[])
       ORDER BY warehouse_location_id, product_variant_id, received_at, id
       FOR UPDATE`,
      [lotIds],
    ));
    const lotsById = new Map(lotRows.map((lot) => [positiveInteger(lot.id, "inventoryLot.id"), lot] as const));
    if (lotsById.size !== lotIds.length) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_RELEASE_MISSING",
        "One or more exact claim-owned FIFO lots no longer exist.",
        { requestedLotIds: lotIds, lockedLotIds: [...lotsById.keys()] },
      );
    }

    const releaseByLevel = new Map<number, bigint>();
    const releaseByLot = new Map<number, bigint>();
    for (const resource of orderedResources) {
      validateReleaseResource(resource, levelsById, lotsById);
      releaseByLevel.set(
        resource.inventoryLevelId,
        (releaseByLevel.get(resource.inventoryLevelId) ?? BigInt(0)) + resource.releaseQty,
      );
      for (const allocation of resource.lotAllocations) {
        releaseByLot.set(
          allocation.inventoryLotId,
          (releaseByLot.get(allocation.inventoryLotId) ?? BigInt(0)) + allocation.releaseQty,
        );
      }
    }
    assertLockedBalances(releaseByLevel, levelsById, "inventoryLevel");
    assertLockedBalances(releaseByLot, lotsById, "inventoryLot");

    for (const resource of orderedResources) {
      for (const allocation of resource.lotAllocations) {
        const releaseQty = positivePostgresInteger(allocation.releaseQty, "claimLot.releaseQty");
        const updatedLot = await input.client.query(
          `UPDATE inventory.inventory_lots
           SET qty_reserved = qty_reserved - $1
           WHERE id = $2 AND qty_reserved >= $1`,
          [releaseQty, allocation.inventoryLotId],
        );
        if (updatedLot.rowCount !== 1) {
          throw new CanonicalClaimInventoryMutationError(
            "CLAIM_LOT_RELEASE_CONFLICT",
            "An exact claim-owned FIFO lot changed while its release was being posted.",
            { inventoryLotId: allocation.inventoryLotId, releaseQty },
          );
        }
      }
      const releaseQty = positivePostgresInteger(resource.releaseQty, "claimResource.releaseQty");
      const updatedLevel = await input.client.query(
        `UPDATE inventory.inventory_levels
         SET reserved_qty = reserved_qty - $1, updated_at = $3
         WHERE id = $2 AND reserved_qty >= $1`,
        [releaseQty, resource.inventoryLevelId, input.occurredAt],
      );
      if (updatedLevel.rowCount !== 1) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_LEVEL_RELEASE_CONFLICT",
          "A claim-owned inventory level changed while its release was being posted.",
          { inventoryLevelId: resource.inventoryLevelId, releaseQty },
        );
      }
      const level = levelsById.get(resource.inventoryLevelId)!;
      const variantQty = nonnegativeInteger(level.variant_qty, "inventoryLevel.variantQty");
      await input.client.query(
        `INSERT INTO inventory.inventory_transactions (
           product_variant_id, from_location_id, transaction_type,
           variant_qty_delta, variant_qty_before, variant_qty_after, reserved_qty_delta,
           source_state, target_state, order_id, order_item_id,
           reference_type, reference_id, user_id, notes, created_at
         ) VALUES ($1, $2, 'unreserve', 0, $3, $3, $4, 'committed', 'on_hand',
                   $5, $6, 'availability_claim_release', $7, $8, $9, $10)`,
        [
          resource.sourceVariantId,
          resource.warehouseLocationId,
          variantQty,
          -releaseQty,
          input.orderId,
          resource.orderItemId,
          `claim:${input.claimId}:resource:${resource.claimResourceId}`,
          input.actor,
          input.reason,
          input.occurredAt,
        ],
      );
    }
  }
}

function compareExecutionResources(
  left: CanonicalClaimInventoryExecutionResource,
  right: CanonicalClaimInventoryExecutionResource,
): number {
  return left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || (left.claimResourceId < right.claimResourceId ? -1 : left.claimResourceId > right.claimResourceId ? 1 : 0);
}

function validatePickResources(
  resources: readonly CanonicalClaimInventoryPickResource[],
): CanonicalClaimInventoryPickResource[] {
  if (resources.length === 0) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_PICK_RESOURCES_MISSING",
      "A canonical pick requires exact claim-owned resources.",
    );
  }
  const ordered = [...resources].sort((left, right) =>
    left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || (left.claimResourceId < right.claimResourceId ? -1 : left.claimResourceId > right.claimResourceId ? 1 : 0));
  const resourceIds = new Set<string>();
  const allocationIds = new Set<string>();
  for (const resource of ordered) {
    const resourceId = positiveBigInt(resource.claimResourceId, "claimResource.id").toString();
    if (resourceIds.has(resourceId)) {
      throw new CanonicalClaimInventoryMutationError(
        "DUPLICATE_CLAIM_PICK_RESOURCE",
        "A claim resource may appear only once in a canonical pick.",
        { claimResourceId: resourceId },
      );
    }
    resourceIds.add(resourceId);
    positiveInteger(resource.inventoryLevelId, "inventoryLevel.id");
    positiveInteger(resource.warehouseLocationId, "warehouseLocation.id");
    positiveInteger(resource.sourceVariantId, "sourceVariant.id");
    positivePostgresInteger(resource.pickQty, "claimResource.pickQty");
    let lotTotal = BigInt(0);
    for (const allocation of resource.lotAllocations) {
      const allocationId = positiveBigInt(allocation.claimLotAllocationId, "claimLotAllocation.id").toString();
      if (allocationIds.has(allocationId)) {
        throw new CanonicalClaimInventoryMutationError(
          "DUPLICATE_CLAIM_PICK_ALLOCATION",
          "A claim lot allocation may appear only once in a canonical pick.",
          { claimLotAllocationId: allocationId },
        );
      }
      allocationIds.add(allocationId);
      positiveInteger(allocation.inventoryLotId, "inventoryLot.id");
      positivePostgresInteger(allocation.pickQty, "claimLot.pickQty");
      const total = postgresBigInt(allocation.unitCostMills, "claimLot.unitCostMills");
      const po = postgresBigInt(allocation.poUnitCostMills, "claimLot.poUnitCostMills");
      const packaging = postgresBigInt(allocation.packagingUnitCostMills, "claimLot.packagingUnitCostMills");
      const landed = postgresBigInt(allocation.landedUnitCostMills, "claimLot.landedUnitCostMills");
      if (po + packaging + landed !== total) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_PICK_COST_LINEAGE_MISMATCH",
          "Claim pick cost components do not reconcile to their authoritative total.",
          { claimLotAllocationId: allocationId },
        );
      }
      lotTotal += allocation.pickQty;
    }
    if (lotTotal !== resource.pickQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_PICK_LINEAGE_MISMATCH",
        "Exact claim lot pick quantities do not reconcile to their resource.",
        { claimResourceId: resourceId, resourceQty: resource.pickQty.toString(), lotQty: lotTotal.toString() },
      );
    }
  }
  return ordered;
}

function validateUnpickResources(
  resources: readonly CanonicalClaimInventoryUnpickResource[],
): CanonicalClaimInventoryUnpickResource[] {
  if (resources.length === 0) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_UNPICK_RESOURCES_MISSING",
      "A canonical unpick requires exact prior pick movements.",
    );
  }
  const ordered = [...resources].sort((left, right) =>
    left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || (left.claimResourceId < right.claimResourceId ? -1 : left.claimResourceId > right.claimResourceId ? 1 : 0));
  const resourceIds = new Set<string>();
  const movementIds = new Set<string>();
  for (const resource of ordered) {
    const resourceId = positiveBigInt(resource.claimResourceId, "claimResource.id").toString();
    if (resourceIds.has(resourceId)) {
      throw new CanonicalClaimInventoryMutationError(
        "DUPLICATE_CLAIM_UNPICK_RESOURCE",
        "A claim resource may appear only once in a canonical unpick.",
        { claimResourceId: resourceId },
      );
    }
    resourceIds.add(resourceId);
    positiveInteger(resource.inventoryLevelId, "inventoryLevel.id");
    positiveInteger(resource.warehouseLocationId, "warehouseLocation.id");
    positiveInteger(resource.sourceVariantId, "sourceVariant.id");
    positivePostgresInteger(resource.unpickQty, "claimResource.unpickQty");
    let lotTotal = BigInt(0);
    for (const allocation of resource.lotAllocations) {
      positiveBigInt(allocation.claimLotAllocationId, "claimLotAllocation.id");
      positiveInteger(allocation.inventoryLotId, "inventoryLot.id");
      positivePostgresInteger(allocation.unpickQty, "claimLot.unpickQty");
      const movementId = positiveBigInt(allocation.reversesPickMovementId, "pickMovement.id").toString();
      if (movementIds.has(movementId)) {
        throw new CanonicalClaimInventoryMutationError(
          "DUPLICATE_CLAIM_UNPICK_MOVEMENT",
          "A canonical unpick may reverse each prior pick movement only once per command.",
          { pickMovementId: movementId },
        );
      }
      movementIds.add(movementId);
      postgresBigInt(allocation.unitCostMills, "pickMovement.unitCostMills");
      lotTotal += allocation.unpickQty;
    }
    if (lotTotal !== resource.unpickQty) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_UNPICK_LINEAGE_MISMATCH",
        "Exact canonical unpick quantities do not reconcile to their resource.",
        { claimResourceId: resource.claimResourceId.toString() },
      );
    }
  }
  return ordered;
}

async function lockPickInventory(
  client: CanonicalClaimTransactionClient,
  resources: readonly CanonicalClaimInventoryPickResource[],
): Promise<{ levelsById: Map<number, any>; lotsById: Map<number, any> }> {
  const levelIds = [...new Set(resources.map((resource) => resource.inventoryLevelId))];
  const levelRows = rows(await client.query(
    `SELECT id, warehouse_location_id, product_variant_id, variant_qty, reserved_qty, picked_qty
     FROM inventory.inventory_levels
     WHERE id = ANY($1::integer[])
     ORDER BY warehouse_location_id, product_variant_id, id
     FOR UPDATE`,
    [levelIds],
  ));
  const lots = resources.flatMap((resource) => resource.lotAllocations.map((allocation) => allocation.inventoryLotId));
  const lotIds = [...new Set(lots)];
  const lotRows = rows(await client.query(
    `SELECT id, product_variant_id, warehouse_location_id, qty_on_hand, qty_reserved,
            qty_picked, status, received_at, unit_cost_cents, po_unit_cost_cents,
            packaging_cost_cents, landed_cost_cents, total_unit_cost_cents,
            unit_cost_mills, po_unit_cost_mills, packaging_cost_mills,
            landed_cost_mills, total_unit_cost_mills
     FROM inventory.inventory_lots
     WHERE id = ANY($1::integer[])
     ORDER BY warehouse_location_id, product_variant_id, received_at, id
     FOR UPDATE`,
    [lotIds],
  ));
  const levelsById = new Map(levelRows.map((level) => [positiveInteger(level.id, "inventoryLevel.id"), level] as const));
  const lotsById = new Map(lotRows.map((lot) => [positiveInteger(lot.id, "inventoryLot.id"), lot] as const));
  if (levelsById.size !== levelIds.length || lotsById.size !== lotIds.length) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_PICK_INVENTORY_MISSING",
      "One or more exact claim-owned levels or FIFO lots no longer exist.",
      { levelIds, lockedLevelIds: [...levelsById.keys()], lotIds, lockedLotIds: [...lotsById.keys()] },
    );
  }
  return { levelsById, lotsById };
}

async function lockUnpickInventory(
  client: CanonicalClaimTransactionClient,
  resources: readonly CanonicalClaimInventoryUnpickResource[],
): Promise<{ levelsById: Map<number, any>; lotsById: Map<number, any> }> {
  return lockPickInventory(client, resources.map((resource) => ({
    claimResourceId: resource.claimResourceId,
    inventoryLevelId: resource.inventoryLevelId,
    warehouseLocationId: resource.warehouseLocationId,
    sourceVariantId: resource.sourceVariantId,
    pickQty: resource.unpickQty,
    lotAllocations: resource.lotAllocations.map((allocation) => ({
      claimLotAllocationId: allocation.claimLotAllocationId,
      inventoryLotId: allocation.inventoryLotId,
      pickQty: allocation.unpickQty,
      unitCostMills: allocation.unitCostMills,
      poUnitCostMills: BigInt(0),
      packagingUnitCostMills: BigInt(0),
      landedUnitCostMills: allocation.unitCostMills,
    })),
  })));
}

function validatePickInventory(
  resources: readonly CanonicalClaimInventoryPickResource[],
  levelsById: ReadonlyMap<number, any>,
  lotsById: ReadonlyMap<number, any>,
): void {
  const byLevel = sumPickByLevel(resources);
  const byLot = new Map<number, bigint>();
  for (const resource of resources) {
    const level = levelsById.get(resource.inventoryLevelId);
    if (!level
      || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
      || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_PICK_LEVEL_IDENTITY_CHANGED",
        "A claim-owned pick resource no longer matches its inventory level.",
        { claimResourceId: resource.claimResourceId.toString() },
      );
    }
    for (const allocation of resource.lotAllocations) {
      const lot = lotsById.get(allocation.inventoryLotId);
      if (!lot
        || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId
        || positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId
        || String(lot.status) !== "active") {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_PICK_LOT_IDENTITY_CHANGED",
          "A claim-owned pick allocation no longer matches an active FIFO lot.",
          { claimLotAllocationId: allocation.claimLotAllocationId.toString(), inventoryLotId: allocation.inventoryLotId },
        );
      }
      let liveCosts: ReturnType<typeof normalizeBuildLotCosts>;
      try {
        liveCosts = normalizeBuildLotCosts(lot);
      } catch (cause) {
        throw new CanonicalClaimInventoryMutationError(
          "INVALID_CLAIM_PICK_LOT_COST",
          "A claim-owned FIFO lot has invalid current cost evidence.",
          { inventoryLotId: allocation.inventoryLotId, cause: cause instanceof Error ? cause.message : String(cause) },
        );
      }
      if (liveCosts.totalMills !== allocation.unitCostMills
        || liveCosts.poMills !== allocation.poUnitCostMills
        || liveCosts.packagingMills !== allocation.packagingUnitCostMills
        || liveCosts.landedMills !== allocation.landedUnitCostMills) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_PICK_LOT_COST_CHANGED",
          "A claim-owned FIFO lot was re-costed after claiming and must be replanned before pick.",
          { inventoryLotId: allocation.inventoryLotId },
        );
      }
      byLot.set(allocation.inventoryLotId, (byLot.get(allocation.inventoryLotId) ?? BigInt(0)) + allocation.pickQty);
    }
  }
  for (const [levelId, quantity] of byLevel) {
    const level = levelsById.get(levelId);
    const variantQty = BigInt(nonnegativeInteger(level?.variant_qty, "inventoryLevel.variantQty"));
    const reservedQty = BigInt(nonnegativeInteger(level?.reserved_qty, "inventoryLevel.reservedQty"));
    const pickedQty = BigInt(nonnegativeInteger(level?.picked_qty, "inventoryLevel.pickedQty"));
    if (variantQty < quantity || reservedQty < quantity || pickedQty + quantity > BigInt(2_147_483_647)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LEVEL_PICK_CONFLICT",
        "A claim-owned level does not contain the exact physical and reserved pick quantity.",
        { inventoryLevelId: levelId, quantity: quantity.toString() },
      );
    }
  }
  for (const [lotId, quantity] of byLot) {
    const lot = lotsById.get(lotId);
    const onHand = BigInt(nonnegativeInteger(lot?.qty_on_hand, "inventoryLot.qtyOnHand"));
    const reserved = BigInt(nonnegativeInteger(lot?.qty_reserved, "inventoryLot.qtyReserved"));
    const picked = BigInt(nonnegativeInteger(lot?.qty_picked, "inventoryLot.qtyPicked"));
    if (onHand < quantity || reserved < quantity || picked + quantity > BigInt(2_147_483_647)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_PICK_CONFLICT",
        "A claim-owned FIFO lot does not contain the exact physical and reserved pick quantity.",
        { inventoryLotId: lotId, quantity: quantity.toString() },
      );
    }
  }
}

function validateUnpickInventory(
  resources: readonly CanonicalClaimInventoryUnpickResource[],
  levelsById: ReadonlyMap<number, any>,
  lotsById: ReadonlyMap<number, any>,
  restoreReservation: boolean,
): void {
  const byLevel = sumUnpickByLevel(resources);
  const byLot = new Map<number, bigint>();
  for (const resource of resources) {
    const level = levelsById.get(resource.inventoryLevelId);
    if (!level
      || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
      || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_UNPICK_LEVEL_IDENTITY_CHANGED",
        "A canonical picked resource no longer matches its inventory level.",
        { claimResourceId: resource.claimResourceId.toString() },
      );
    }
    for (const allocation of resource.lotAllocations) {
      const lot = lotsById.get(allocation.inventoryLotId);
      if (!lot
        || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId
        || positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId) {
        throw new CanonicalClaimInventoryMutationError(
          "CLAIM_UNPICK_LOT_IDENTITY_CHANGED",
          "A canonical picked movement no longer matches its FIFO lot.",
          { pickMovementId: allocation.reversesPickMovementId.toString() },
        );
      }
      byLot.set(allocation.inventoryLotId, (byLot.get(allocation.inventoryLotId) ?? BigInt(0)) + allocation.unpickQty);
    }
  }
  for (const [levelId, quantity] of byLevel) {
    const level = levelsById.get(levelId);
    const variant = BigInt(nonnegativeInteger(level?.variant_qty, "inventoryLevel.variantQty"));
    const reserved = BigInt(nonnegativeInteger(level?.reserved_qty, "inventoryLevel.reservedQty"));
    const picked = BigInt(nonnegativeInteger(level?.picked_qty, "inventoryLevel.pickedQty"));
    if (picked < quantity || variant + quantity > BigInt(2_147_483_647)
      || (restoreReservation && reserved + quantity > variant + quantity)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LEVEL_UNPICK_CONFLICT",
        "A canonical picked level cannot restore the exact requested quantity.",
        { inventoryLevelId: levelId, quantity: quantity.toString() },
      );
    }
  }
  for (const [lotId, quantity] of byLot) {
    const lot = lotsById.get(lotId);
    const onHand = BigInt(nonnegativeInteger(lot?.qty_on_hand, "inventoryLot.qtyOnHand"));
    const reserved = BigInt(nonnegativeInteger(lot?.qty_reserved, "inventoryLot.qtyReserved"));
    const picked = BigInt(nonnegativeInteger(lot?.qty_picked, "inventoryLot.qtyPicked"));
    if (picked < quantity || onHand + quantity > BigInt(2_147_483_647)
      || (restoreReservation && reserved + quantity > onHand + quantity)) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_UNPICK_CONFLICT",
        "A canonical picked FIFO lot cannot restore the exact requested quantity.",
        { inventoryLotId: lotId, quantity: quantity.toString() },
      );
    }
  }
}

function sumPickByLevel(
  resources: readonly CanonicalClaimInventoryPickResource[],
): Map<number, bigint> {
  const result = new Map<number, bigint>();
  for (const resource of resources) {
    result.set(resource.inventoryLevelId, (result.get(resource.inventoryLevelId) ?? BigInt(0)) + resource.pickQty);
  }
  return result;
}

function sumUnpickByLevel(
  resources: readonly CanonicalClaimInventoryUnpickResource[],
): Map<number, bigint> {
  const result = new Map<number, bigint>();
  for (const resource of resources) {
    result.set(resource.inventoryLevelId, (result.get(resource.inventoryLevelId) ?? BigInt(0)) + resource.unpickQty);
  }
  return result;
}

function compareReleaseResources(
  left: CanonicalClaimInventoryReleaseResource,
  right: CanonicalClaimInventoryReleaseResource,
): number {
  return left.warehouseLocationId - right.warehouseLocationId
    || left.sourceVariantId - right.sourceVariantId
    || left.inventoryLevelId - right.inventoryLevelId
    || (left.claimResourceId < right.claimResourceId ? -1 : left.claimResourceId > right.claimResourceId ? 1 : 0);
}

function assertUniqueReleaseResources(resources: readonly CanonicalClaimInventoryReleaseResource[]): void {
  const claimResourceIds = new Set<string>();
  for (const resource of resources) {
    const key = resource.claimResourceId.toString();
    if (claimResourceIds.has(key)) {
      throw new CanonicalClaimInventoryMutationError(
        "DUPLICATE_CLAIM_RESOURCE_RELEASE",
        "A canonical claim resource may appear only once in a release batch.",
        { claimResourceId: key },
      );
    }
    claimResourceIds.add(key);
  }
}

function validateReleaseResource(
  resource: CanonicalClaimInventoryReleaseResource,
  levelsById: ReadonlyMap<number, any>,
  lotsById: ReadonlyMap<number, any>,
): void {
  positivePostgresInteger(resource.releaseQty, "claimResource.releaseQty");
  const level = levelsById.get(resource.inventoryLevelId);
  if (!level
    || positiveInteger(level.warehouse_location_id, "inventoryLevel.locationId") !== resource.warehouseLocationId
    || positiveInteger(level.product_variant_id, "inventoryLevel.variantId") !== resource.sourceVariantId) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_RESOURCE_CHANGED",
      "A claim-owned inventory resource no longer matches its level identity.",
      { claimResourceId: resource.claimResourceId.toString(), inventoryLevelId: resource.inventoryLevelId },
    );
  }
  const seenLotIds = new Set<number>();
  let lotReleaseTotal = BigInt(0);
  for (const allocation of resource.lotAllocations) {
    positivePostgresInteger(allocation.releaseQty, "claimLot.releaseQty");
    if (seenLotIds.has(allocation.inventoryLotId)) {
      throw new CanonicalClaimInventoryMutationError(
        "DUPLICATE_CLAIM_LOT_RELEASE",
        "A FIFO lot may appear only once for a claim resource release.",
        { claimResourceId: resource.claimResourceId.toString(), inventoryLotId: allocation.inventoryLotId },
      );
    }
    seenLotIds.add(allocation.inventoryLotId);
    const lot = lotsById.get(allocation.inventoryLotId);
    if (!lot
      || positiveInteger(lot.warehouse_location_id, "inventoryLot.locationId") !== resource.warehouseLocationId
      || positiveInteger(lot.product_variant_id, "inventoryLot.variantId") !== resource.sourceVariantId) {
      throw new CanonicalClaimInventoryMutationError(
        "CLAIM_LOT_RELEASE_IDENTITY_CHANGED",
        "An exact claim-owned FIFO lot no longer matches its resource identity.",
        { claimResourceId: resource.claimResourceId.toString(), inventoryLotId: allocation.inventoryLotId },
      );
    }
    lotReleaseTotal += allocation.releaseQty;
  }
  if (lotReleaseTotal !== resource.releaseQty) {
    throw new CanonicalClaimInventoryMutationError(
      "CLAIM_RELEASE_LINEAGE_MISMATCH",
      "The exact open lot allocation does not reconcile to its claim resource.",
      {
        claimResourceId: resource.claimResourceId.toString(),
        resourceOpenQty: resource.releaseQty.toString(),
        lotOpenQty: lotReleaseTotal.toString(),
      },
    );
  }
}

function assertLockedBalances(
  releases: ReadonlyMap<number, bigint>,
  rowsById: ReadonlyMap<number, any>,
  entity: "inventoryLevel" | "inventoryLot",
): void {
  for (const [id, releaseQty] of releases) {
    const row = rowsById.get(id);
    const reservedQty = BigInt(nonnegativeInteger(
      entity === "inventoryLevel" ? row?.reserved_qty : row?.qty_reserved,
      `${entity}.reservedQty`,
    ));
    if (reservedQty < releaseQty) {
      throw new CanonicalClaimInventoryMutationError(
        entity === "inventoryLevel" ? "CLAIM_LEVEL_RELEASE_CONFLICT" : "CLAIM_LOT_RELEASE_CONFLICT",
        `A claim-owned ${entity === "inventoryLevel" ? "inventory level" : "FIFO lot"} does not contain the aggregate reserved quantity being released.`,
        { id, releaseQty: releaseQty.toString(), reservedQty: reservedQty.toString() },
      );
    }
  }
}
