import { lockInventoryCostGraph, recordReceiptCostOrigin, recordLotCostContribution } from "../infrastructure/cost-evidence.repository";
import { openOperationalQuantityPosting, type OperationalQuantityPosting } from "../infrastructure/operational-quantity-posting";
import { assertLegacyQuantityImportAllowed } from "./legacy-quantity-import";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { IInventoryStorage } from "../infrastructure/inventory.repository";
import type { InventoryLotService } from "../lots.service";
import type { COGSService } from "../cogs.service";
import { warehouses, warehouseLocations, channelConnections } from "../../../storage/base";
import { eq, and } from "drizzle-orm";
import type { InventoryLevel, InsertInventoryTransaction, InventoryTransaction } from "../../../../shared/schema";
import { AuditLogger } from "../../../infrastructure/auditLogger";
import { AppError, IntegrityError, ValidationError } from "../../../../shared/errors";
import { resolveCost } from "../cost-resolver";
import { centsToMills, millsToCents } from "../../../../shared/utils/money";
import { repointPendingWmsOrderItemsForInventoryTransfer } from "../../wms/order-item-commands";
import { allocateBuildCostLayers } from "../domain/build.domain";
import {
  planReplenishmentExecution,
} from "../domain/replenishment-execution.domain";

export class FreezeViolationError extends Error {
  code = "LOCATION_FROZEN";
  constructor(locationId: number) {
    super(`Location ${locationId} is frozen for cycle counting — mutation blocked`);
  }
}

/**
 * Raised when a receipt reversal cannot post because the lot/location on-hand
 * is already consumed or sold. The caller decides whether to surface this as
 * a block (default) or retry with the audited allowNegative override.
 */
export class InsufficientOnHandForReversalError extends IntegrityError {
  constructor(context: {
    receivingLineId: number;
    qty: number;
    available: number;
  }) {
    super(
      `Insufficient on-hand to reverse ${context.qty} unit(s) for receiving line ` +
        `${context.receivingLineId}: only ${context.available} available (quantity already ` +
        `consumed or sold). Pass allowNegative to override.`,
      { ...context, code: "REVERSAL_INSUFFICIENT_ON_HAND" },
    );
    this.code = "REVERSAL_INSUFFICIENT_ON_HAND";
  }
}

/**
 * A provider-confirmed replacement package cannot be safely posted from the
 * current balance when no unreserved stock remains. Callers must distinguish
 * this from a malformed shipment or a failed inventory write: the package is
 * a physical fact, while the inventory debit needs reconciliation.
 */
export class ReplacementInventoryUnavailableError extends IntegrityError {
  constructor(context: {
    productVariantId: number;
    qty: number;
    warehouseId: number | null;
  }) {
    const warehouseText = context.warehouseId == null
      ? "any eligible warehouse"
      : `warehouse ${context.warehouseId}`;
    super(
      `Replacement inventory unavailable for variant ${context.productVariantId}: ` +
      `no active, pickable, unfrozen location in ${warehouseText} has ${context.qty} unreserved unit(s).`,
      context,
    );
    this.code = "REPLACEMENT_INVENTORY_UNAVAILABLE";
  }
}

export class ReplenishmentInventoryConflictError extends AppError {
  constructor(
    code: "REPLENISHMENT_RESERVED_STOCK_PROTECTED" | "REPLENISHMENT_LOT_SERVICE_UNAVAILABLE",
    message: string,
    context: Record<string, unknown>,
  ) {
    super(message, code, 409, context);
  }
}

function safeMillsNumber(value: bigint, field: string): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new IntegrityError(`${field} is outside the supported integer-mill range.`, {
      field,
      value: value.toString(),
    });
  }
  return Number(value);
}

/** Type wrapper for Drizzle database instance */
type DrizzleDb = {
  select: (...args: any[]) => any;
  update: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  execute: <T = any>(query: any) => Promise<{ rows: T[] }>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

/** The caller owns BEGIN/COMMIT/ROLLBACK and must propagate every failure. */
export type InventoryShipmentTransaction = Pick<NodePgDatabase, "execute" | "select" | "update" | "insert">;

export interface RecordInventoryShipmentInput {
  productVariantId: number;
  warehouseLocationId: number;
  qty: number;
  orderId: number;
  orderItemId?: number;
  shipmentId?: string;
  shipmentItemId?: number;
  userId?: string;
  /** Never-picked lines must not consume another order's shared picked pool. */
  deductFromOnHandOnly?: boolean;
  /** Concessions have no customer reservation to release. */
  releaseReservation?: boolean;
}

export interface RecordReplacementInventoryShipmentInput {
  productVariantId: number;
  qty: number;
  warehouseId: number | null;
  orderId: number;
  orderItemId?: number | null;
  shipmentId: number;
  shipmentItemId: number;
  userId?: string;
}

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const adjustmentReplaySchema = z.object({
  orphanedQty: z.number().int().nonnegative(), adjustmentTransactionId: z.number().int().positive(),
  consumedCostCents: z.number().int().nonnegative().optional(), consumedQty: z.number().int().nonnegative().optional(),
  consumedLots: z.array(z.object({ lotId: z.number().int().positive(), qty: z.number().int().positive() })).optional(),
  consumedPoCostMills: z.string().regex(/^\d+$/).optional(), consumedPackagingCostMills: z.string().regex(/^\d+$/).optional(),
  consumedLandedCostMills: z.string().regex(/^\d+$/).optional(), consumedCostProvisional: z.boolean().optional(),
});

function validateShipmentInteger(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_POSTGRES_INTEGER) {
    throw new ValidationError(`${field} must be a positive PostgreSQL integer`, { field });
  }
}

function validateShipmentText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    throw new ValidationError(`${field} must contain between 1 and 100 characters`, { field });
  }
}

function validateShipmentInput(params: RecordInventoryShipmentInput): void {
  if (!params || typeof params !== "object") throw new ValidationError("Shipment input is required");
  for (const field of ["productVariantId", "warehouseLocationId", "qty", "orderId"] as const) {
    validateShipmentInteger(params[field], field);
  }
  for (const field of ["orderItemId", "shipmentItemId"] as const) {
    if (params[field] !== undefined) validateShipmentInteger(params[field], field);
  }
  for (const field of ["shipmentId", "userId"] as const) {
    if (params[field] !== undefined) validateShipmentText(params[field], field);
  }
  if (params.shipmentId !== undefined && Number.isInteger(Number(params.shipmentId))) {
    validateShipmentInteger(Number(params.shipmentId), "shipmentId");
  }
  for (const field of ["deductFromOnHandOnly", "releaseReservation"] as const) {
    if (params[field] !== undefined && typeof params[field] !== "boolean") {
      throw new ValidationError(`${field} must be a boolean`, { field });
    }
  }
}

/** Pin and validate the persisted decision before source or shipment locks. */
export async function loadAndLockShipmentRuntimeAuthority(
  tx: InventoryShipmentTransaction,
): Promise<"legacy" | "canonical"> {
  const result = await tx.execute<{
    authority: unknown; authority_revision: unknown; activation_run_id: unknown;
  }>(sql`
    SELECT authority, revision::text AS authority_revision, activation_run_id::text AS activation_run_id
    FROM inventory.availability_runtime_authority
    WHERE singleton_key = true
    FOR SHARE
  `);
  const row = result.rows[0];
  const validRevision = typeof row?.authority_revision === "string" && /^[1-9][0-9]*$/.test(row.authority_revision);
  const validAuthority = row?.authority === "legacy" || row?.authority === "canonical";
  const validLineage = row?.authority === "legacy"
    ? row.activation_run_id === null
    : typeof row?.activation_run_id === "string" && /^[1-9][0-9]*$/.test(row.activation_run_id);
  if (result.rows.length !== 1 || !validAuthority || !validRevision || !validLineage) {
    throw new AppError("The persisted shipment runtime authority is missing or invalid.",
      "SHIPMENT_RUNTIME_AUTHORITY_INVALID", 503);
  }
  return row.authority as "legacy" | "canonical";
}

async function requireLegacyShipmentAuthority(tx: InventoryShipmentTransaction): Promise<void> {
  if (await loadAndLockShipmentRuntimeAuthority(tx) !== "legacy") {
    throw new AppError("Legacy shipment posting is disabled under canonical inventory authority.",
      "LEGACY_SHIPMENT_AUTHORITY_DISABLED", 409);
  }
}

export class InventoryUseCases {
  private onChangeCallbacks: ((productVariantId: number, triggeredBy: string) => void)[] = [];

  constructor(
    private readonly db: DrizzleDb,
    private readonly storage: IInventoryStorage,
    private readonly lotService: InventoryLotService | null = null,
    private readonly cogsService: COGSService | null = null,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async assertNotFrozen(locationId: number, dbh?: any): Promise<void> {
    const db = dbh ?? this.db;
    const [loc] = await db
      .select({ cycleCountFreezeId: warehouseLocations.cycleCountFreezeId })
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, locationId))
      .limit(1);
    if (loc?.cycleCountFreezeId) {
      throw new FreezeViolationError(locationId);
    }
  }

  onInventoryChange(cb: (productVariantId: number, triggeredBy: string) => void): void {
    this.onChangeCallbacks.push(cb);
  }

  triggerNotifyChange(productVariantId: number, triggeredBy: string): void {
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(productVariantId, triggeredBy);
      } catch (err: any) {
        console.warn(`[InventoryUseCases] onChange callback error: ${err.message}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // RECEIVE
  // ---------------------------------------------------------------------------

  async receiveInventory(params: {
    commandKey?: string;
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
    unitCostCents?: number;
    productCostCents?: number;
    packagingCostCents?: number;
    // Mills (1/100 cent), already scaled to the lot's variant unit — authoritative when
    // provided. The receive close passes these; cents params remain for legacy callers.
    unitCostMills?: number;
    packagingCostMills?: number;
    landedCostMills?: number;
    unitsPerVariantSnapshot?: number;
    inboundShipmentLineId?: number;
    costRecordedAt?: Date;
    receivingOrderId?: number;
    receivingLineId?: number;
    purchaseOrderId?: number;
    purchaseOrderLineId?: number;
    inboundShipmentId?: number;
    costProvisional?: number;
  }, externalTx?: any): Promise<void> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) throw new Error("qty must be a positive safe integer");

    let replayed = false;
    const doWork = async (tx: any) => {
      const quantityPosting = await openOperationalQuantityPosting(tx);
      if (quantityPosting && !this.lotService) throw new IntegrityError("Ledger receiving requires exact FIFO lot ownership");
      const quantityKey = params.commandKey ?? (params.receivingLineId ? `receiving_line:${params.receivingLineId}`
        : params.receivingOrderId ? `receiving_order:${params.receivingOrderId}:${params.productVariantId}:${params.warehouseLocationId}` : undefined);
      if (quantityPosting && await quantityPosting.beginOperation(quantityKey, { operation: "receive", ...params,
        costRecordedAt: params.costRecordedAt?.toISOString() ?? null })) { replayed = true; return; }
      await this.assertNotFrozen(params.warehouseLocationId, tx);
      await lockInventoryCostGraph(tx);

      // Serialize and replay-check the exact receiving line before any balance
      // or lot mutation. Legacy callers without a line identity retain the
      // order+variant+location replay key.
      if (params.receivingLineId) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtext('inventory.receive_inventory.receiving_line'),
            ${params.receivingLineId}
          )
        `);
        const existing = await tx.execute(sql`
          SELECT id
          FROM inventory.inventory_transactions
          WHERE transaction_type = 'receipt'
            AND receiving_line_id = ${params.receivingLineId}
            AND voided_at IS NULL
          LIMIT 1
        `);
        if (existing.rows.length > 0) {
          return;
        }
      } else if (params.receivingOrderId) {
        const existing = await tx.execute(sql`
          SELECT id
          FROM inventory.inventory_transactions
          WHERE transaction_type = 'receipt'
            AND receiving_order_id = ${params.receivingOrderId}
            AND product_variant_id = ${params.productVariantId}
            AND to_location_id = ${params.warehouseLocationId}
            AND voided_at IS NULL
          LIMIT 1
        `);
        if (existing.rows.length > 0) {
          return;
        }
      }

      // 1. Upsert Location Level
      const level = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
      }, tx);

      // 2. Adjust Balance
      if (!quantityPosting) await this.storage.adjustInventoryLevel(level.id, { variantQty: params.qty }, tx);

      // 3. FIFO Lot Generation — resolve cost via waterfall when not provided
      let lotId: number | undefined;
      let resolvedCostCents: number | undefined;
      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        const resolved = await resolveCost(tx, params.productVariantId, params.unitCostCents);
        // Mills are the cost source of truth. The caller passes the lot-unit mills
        // directly (receive path); when cost instead came from the resolveCost fallback
        // waterfall, lift the resolved cents → mills exactly (× 100).
        const lotUnitCostMills = params.unitCostMills ?? centsToMills(resolved.costCents);
        const lot = await lotSvc.createLot({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
          unitCostCents: resolved.costCents,
          unitCostMills: lotUnitCostMills,
          productCostCents: params.productCostCents,
          packagingCostCents: params.packagingCostCents ?? 0,
          packagingCostMills: params.packagingCostMills,
          landedCostMills: params.landedCostMills,
          receivingOrderId: params.receivingOrderId,
          purchaseOrderId: params.purchaseOrderId,
          poLineId: params.purchaseOrderLineId,
          inboundShipmentId: params.inboundShipmentId,
          costProvisional: params.costProvisional ?? (resolved.provisional ? 1 : 0),
          notes: params.notes,
          quantityPosting,
        });
        lotId = lot.id;
        resolvedCostCents = resolved.costCents;
        if (params.receivingLineId && params.purchaseOrderLineId && params.unitsPerVariantSnapshot && params.costRecordedAt) {
          await recordReceiptCostOrigin(tx, {
            inventoryLotId: lot.id, receivingLineId: params.receivingLineId, purchaseOrderLineId: params.purchaseOrderLineId,
            inboundShipmentLineId: params.inboundShipmentLineId ?? null,
            unitsPerVariantSnapshot: params.unitsPerVariantSnapshot, receivedVariantQty: params.qty,
          }, params.userId || "system:receiving", params.costRecordedAt);
        }

        if (!quantityPosting && resolved.costCents > 0) {
          await lotSvc.updateVariantCosts(params.productVariantId, resolved.costCents);
        }
      }

      // 4. Record Audit
      try {
        const receipt = await this.storage.createInventoryTransaction({
          productVariantId: params.productVariantId,
          toLocationId: params.warehouseLocationId,
          transactionType: "receipt",
          variantQtyDelta: params.qty,
          variantQtyBefore: level.variantQty,
          variantQtyAfter: level.variantQty + params.qty,
          sourceState: "external",
          targetState: "on_hand",
          referenceType: "receiving",
          referenceId: params.referenceId,
          receivingOrderId: params.receivingOrderId ?? null,
          receivingLineId: params.receivingLineId ?? null,
          notes: params.notes ?? null,
          userId: params.userId ?? null,
          unitCostCents: params.unitCostCents ?? null,
          inventoryLotId: lotId ?? null,
        }, tx);
        if (quantityPosting) {
          await quantityPosting.post({
            idempotencyKey: quantityKey!, kind: "receive",
            actor: params.userId || "system:receiving", reason: params.notes || "Posted warehouse receipt",
            reference: { type: "inventory_transaction", id: String(receipt.id) }, occurredAt: this.clock().toISOString(),
          });
          if (resolvedCostCents !== undefined && resolvedCostCents > 0) {
            await this.lotService!.withTx(tx).updateVariantCosts(params.productVariantId, resolvedCostCents);
          }
          await quantityPosting.finishOperation({ completed: true });
        }
      } catch (err: any) {
        // Inventory balance and lot writes already occurred in this transaction.
        // Never convert a ledger uniqueness failure into a successful receive.
        throw err;
      }
    };

    if (externalTx) {
      await doWork(externalTx);
    } else {
      await this.db.transaction(doWork);
    }

    if (!replayed) this.triggerNotifyChange(params.productVariantId, "receive");
  }

  // ---------------------------------------------------------------------------
  // REVERSE RECEIPT (Spec D — compensating decrement for a posted receipt)
  // ---------------------------------------------------------------------------

  /**
   * Reverse the inventory effects of a posted receiving line:
   *   1. Decrement the lot(s) created by that line at their ORIGINAL cost
   *      (exact mills round-trip — never re-costed).
   *   2. Decrement the location level by the variant qty.
   *   3. Write a 'receipt_reversal' ledger row referencing the reversal.
   *
   * Ownership: this is the ONLY writer path for receipt reversals into
   * inventory.inventory_lots / inventory_levels / inventory_transactions
   * (writer-ratchet P2.1 — procurement calls this public API, never the
   * tables directly).
   *
   * Insufficient on-hand throws InsufficientOnHandForReversalError unless
   * allowNegative is set (elevated-permission override; the caller audits it
   * on the reversal row).
   *
   * Returns the original lot unit cost (mills, per variant unit) so the
   * caller can snapshot it on the reversal record, or null when no lot was
   * found (legacy receipts predating lot tracking).
   */
  async reverseReceiptInventory(params: {
    receivingLineId: number;
    receivingOrderId: number;
    productVariantId: number;
    warehouseLocationId: number | null;
    qty: number;
    reversalId: number;
    reason: string;
    userId?: string | null;
    allowNegative?: boolean;
  }, externalTx?: any): Promise<{ lotUnitCostMills: number | null }> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) {
      throw new ValidationError("qty must be a positive integer");
    }
    const allowNegative = params.allowNegative === true;

    const doWork = async (tx: any): Promise<{ lotUnitCostMills: number | null }> => {
      const quantityPosting = await openOperationalQuantityPosting(tx);
      const quantityKey = `receipt_reversal:${params.reversalId}`;
      const replay = quantityPosting && await quantityPosting.beginOperation(quantityKey, { operation: "receipt_reversal", ...params });
      if (replay) return z.object({ lotUnitCostMills: z.number().int().nonnegative().nullable() }).parse(replay.result);
      // An override cannot make negative physical custody truthful in the new
      // ledger. The caller must resolve the missing stock instead.
      if (quantityPosting && allowNegative) throw new ValidationError("Negative receipt reversal is unavailable after quantity-ledger activation");
      if (params.warehouseLocationId !== null) {
        await this.assertNotFrozen(params.warehouseLocationId, tx);
      }
      const activeLevel = quantityPosting && params.warehouseLocationId !== null
        ? await this.storage.lockInventoryLevel(params.warehouseLocationId, params.productVariantId, tx) : null;
      if (quantityPosting && !activeLevel) throw new IntegrityError("Receipt reversal requires the exact receipt SKU/location level");

      // 1. Lots created by this receiving line (resolved through the ledger —
      //    the receipt transaction row carries the exact lot linkage).
      const lotRows = await tx.execute(sql`
        SELECT l.id, l.qty_on_hand, l.qty_reserved, l.unit_cost_mills
        FROM inventory.inventory_lots l
        JOIN inventory.inventory_transactions t
          ON t.inventory_lot_id = l.id
        WHERE t.receiving_line_id = ${params.receivingLineId}
          AND t.transaction_type = 'receipt'
          AND t.voided_at IS NULL
        ORDER BY l.id
        FOR UPDATE OF l
      `);

      let lotUnitCostMills: number | null = null;
      if (lotRows.rows.length > 0) {
        // Pre-check total availability BEFORE any mutation (Rule #7: the
        // transaction would roll back anyway, but failing fast keeps the
        // error deterministic and avoids lock churn).
        if (!allowNegative) {
          const totalOnHand = lotRows.rows.reduce(
            (sum: number, lot: any) => sum + Math.max(0, Number(lot.qty_on_hand) || 0),
            0,
          );
          if (totalOnHand < params.qty) {
            throw new InsufficientOnHandForReversalError({
              receivingLineId: params.receivingLineId,
              qty: params.qty,
              available: totalOnHand,
            });
          }
        }

        let remainingToReverse = params.qty;
        for (const lot of lotRows.rows) {
          if (remainingToReverse <= 0) break;
          const lotId = Number(lot.id);
          const onHand = Number(lot.qty_on_hand) || 0;
          const available = quantityPosting ? onHand - Number(lot.qty_reserved) : onHand;
          const decrement = Math.min(
            remainingToReverse,
            allowNegative ? remainingToReverse : available,
          );
          if (decrement <= 0) continue;

          if (lotUnitCostMills === null && lot.unit_cost_mills !== null) {
            lotUnitCostMills = Number(lot.unit_cost_mills);
          }

          if (quantityPosting) {
            await quantityPosting.addLot(lotId, { onHand: -decrement, reserved: 0, picked: 0, packed: 0 });
          } else {
          const updated = await tx.execute(sql`
            UPDATE inventory.inventory_lots
            SET qty_on_hand = qty_on_hand - ${decrement},
                status = CASE
                  WHEN qty_on_hand - ${decrement} <= 0 THEN 'depleted'::varchar
                  ELSE status
                END
            WHERE id = ${lotId}
            RETURNING qty_on_hand
          `);
          const newOnHand = Number(updated.rows?.[0]?.qty_on_hand);
          if (newOnHand < 0 && !allowNegative) {
            throw new InsufficientOnHandForReversalError({
              receivingLineId: params.receivingLineId,
              qty: params.qty,
              available: onHand,
            });
          }
          }
          remainingToReverse -= decrement;
        }
        if (quantityPosting && remainingToReverse !== 0) throw new InsufficientOnHandForReversalError({
          receivingLineId: params.receivingLineId, qty: params.qty, available: params.qty - remainingToReverse,
        });
      }
      if (quantityPosting && lotRows.rows.length === 0) throw new IntegrityError("Receipt reversal requires exact original lot evidence");

      // 2. Location level decrement.
      let qtyBefore: number | null = activeLevel?.variantQty ?? null;
      if (!quantityPosting && params.warehouseLocationId !== null) {
        const levelRows = await tx.execute(sql`
          SELECT id, variant_qty
          FROM inventory.inventory_levels
          WHERE product_variant_id = ${params.productVariantId}
            AND warehouse_location_id = ${params.warehouseLocationId}
          FOR UPDATE
        `);
        const level = levelRows.rows?.[0];
        if (level) {
          const currentQty = Number(level.variant_qty) || 0;
          if (currentQty < params.qty && !allowNegative) {
            throw new InsufficientOnHandForReversalError({
              receivingLineId: params.receivingLineId,
              qty: params.qty,
              available: currentQty,
            });
          }
          qtyBefore = currentQty;
          await tx.execute(sql`
            UPDATE inventory.inventory_levels
            SET variant_qty = variant_qty - ${params.qty},
                updated_at = NOW()
            WHERE id = ${level.id}
          `);
        }
      }

      // 3. Ledger audit row (Rule #8).
      await tx.execute(sql`
        INSERT INTO inventory.inventory_transactions
          (product_variant_id, from_location_id, transaction_type, variant_qty_delta,
           variant_qty_before, variant_qty_after,
           source_state, target_state, reference_type, reference_id,
           receiving_order_id, receiving_line_id, notes, user_id, unit_cost_cents)
        VALUES (
          ${params.productVariantId},
          ${params.warehouseLocationId},
          'receipt_reversal',
          ${-params.qty},
          ${qtyBefore},
          ${qtyBefore === null ? null : qtyBefore - params.qty},
          'on_hand',
          'external',
          'receipt_reversal',
          ${`REV-${params.reversalId}`},
          ${params.receivingOrderId},
          ${params.receivingLineId},
          ${params.reason},
          ${params.userId ?? null},
          ${lotUnitCostMills === null ? null : millsToCents(lotUnitCostMills)}
        )
      `);

      if (quantityPosting) await quantityPosting.post({
        idempotencyKey: quantityKey, kind: "receipt_reversal",
        actor: params.userId || "system:receiving", reason: params.reason,
        reference: { type: "receipt_reversal", id: String(params.reversalId) }, occurredAt: this.clock().toISOString(),
      });
      if (quantityPosting) await quantityPosting.finishOperation({ lotUnitCostMills });

      return { lotUnitCostMills };
    };

    const result = externalTx ? await doWork(externalTx) : await this.db.transaction(doWork);
    this.triggerNotifyChange(params.productVariantId, "receipt_reversal");
    return result;
  }

  // ---------------------------------------------------------------------------
  // PICK
  // ---------------------------------------------------------------------------

  async pickItem(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) throw new Error("qty must be a positive safe integer");

    const result = await this.db.transaction(async (tx) => {
      const level = await this.storage.lockInventoryLevel(
        params.warehouseLocationId,
        params.productVariantId,
        tx
      );

      if (!level) return false;

      // Ensure enough stock exists (optimistic application-layer lock)
      if (level.variantQty < params.qty) {
        return false;
      }

      const reservationRelease = Math.min(level.reservedQty, params.qty);

      // Adjust Buckets (Storage level enforces non-negative natively usually, but we check here)
      await this.storage.adjustInventoryLevel(level.id, {
        variantQty: -params.qty,
        pickedQty: params.qty,
        ...(reservationRelease > 0 ? { reservedQty: -reservationRelease } : {})
      }, tx);

      // COGS / FIFO Pick
      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.pickFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
          orderId: params.orderId,
          orderItemId: params.orderItemId,
        });
      }

      // Audit log
      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "pick",
        variantQtyDelta: -params.qty,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty - params.qty,
        // A pick consumes reservation up to the level's reserved counter —
        // recorded so order-scoped release can compute open reservations.
        reservedQtyDelta: reservationRelease > 0 ? -reservationRelease : 0,
        sourceState: "on_hand",
        targetState: "picked",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: String(params.orderId),
        userId: params.userId ?? null,
      }, tx);

      return true;
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // UNPICK (reverse a pick — returns inventory from picked back to on-hand)
  // ---------------------------------------------------------------------------

  async unpickItem(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
    reason?: string;
  }): Promise<boolean> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) throw new Error("qty must be a positive safe integer");

    const result = await this.db.transaction(async (tx) => {
      const level = await this.storage.lockInventoryLevel(
        params.warehouseLocationId,
        params.productVariantId,
        tx
      );

      if (!level) return false;

      const actualUnpick = Math.min(level.pickedQty, params.qty);
      if (actualUnpick <= 0) return false;

      await this.storage.adjustInventoryLevel(level.id, {
        variantQty: actualUnpick,
        pickedQty: -actualUnpick,
      }, tx);

      // Reverse COGS: restore lot quantities and delete order_item_costs rows
      if (this.lotService && params.orderItemId) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.unpickFromLots({
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          productVariantId: params.productVariantId,
          qty: actualUnpick,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "unpick",
        variantQtyDelta: actualUnpick,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty + actualUnpick,
        sourceState: "picked",
        targetState: "on_hand",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: String(params.orderId),
        userId: params.userId ?? null,
        notes: params.reason || "Order edit: reversed pick",
      }, tx);

      return true;
    });

    if (result) {
      this.triggerNotifyChange(params.productVariantId, "unpick");
    }

    return result;
  }

  async getLevelsByVariant(productVariantId: number): Promise<InventoryLevel[]> {
    return this.storage.getInventoryLevelsByProductVariantId(productVariantId);
  }

  async getLevel(productVariantId: number, warehouseLocationId: number): Promise<InventoryLevel | null> {
    const level = await this.storage.getInventoryLevelByLocationAndVariant(warehouseLocationId, productVariantId);
    return level || null;
  }

  // ---------------------------------------------------------------------------
  // SHIP
  // ---------------------------------------------------------------------------

  async recordShipment(params: RecordInventoryShipmentInput): Promise<void> {
    validateShipmentInput(params);
    await this.db.transaction((tx) => this.recordShipmentInsideTransaction(params, tx));
  }

  /**
   * Participate in the caller's transaction without starting or committing one.
   * The authority SHARE lock survives until that caller commits or rolls back.
   */
  async recordShipmentInsideTransaction(
    params: RecordInventoryShipmentInput,
    tx: InventoryShipmentTransaction,
  ): Promise<void> {
    validateShipmentInput(params);
    await requireLegacyShipmentAuthority(tx);
    if (params.shipmentId && (params.shipmentItemId || params.orderItemId)) {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          918407,
          ${params.shipmentItemId ?? params.orderItemId}
        )
      `);
      const existingShipmentTx = await tx.execute(sql`
        SELECT id
        FROM inventory.inventory_transactions
        WHERE transaction_type = 'ship'
          AND reference_id = ${params.shipmentId}
          AND ${params.shipmentItemId
            ? sql`shipment_item_id = ${params.shipmentItemId}`
            : sql`order_item_id = ${params.orderItemId}`}
        LIMIT 1
      `);
      if (existingShipmentTx.rows.length > 0) {
        return;
      }
    }

    const level = await this.storage.lockInventoryLevel(
      params.warehouseLocationId,
      params.productVariantId,
      tx
    );

    if (!level) {
      throw new Error(`No inventory level for variant ${params.productVariantId} at location ${params.warehouseLocationId}`);
    }

    const fromPicked = params.deductFromOnHandOnly
      ? 0
      : Math.min(level.pickedQty, params.qty);
    const fromOnHand = params.qty - fromPicked;
    const reservedToRelease = params.releaseReservation === false
      ? 0 : Math.min(level.reservedQty, fromOnHand);

    if (fromOnHand > level.variantQty) {
      throw new IntegrityError(
        `Negative Inventory Guard: Cannot record shipment of ${params.qty}. Picked: ${fromPicked}, On-hand: ${level.variantQty}, Required from on-hand: ${fromOnHand}.`
      );
    }
    if (
      params.releaseReservation === false
      && fromOnHand > level.variantQty - level.reservedQty
    ) {
      throw new IntegrityError(
        `Insufficient unreserved inventory: Cannot record shipment of ${params.qty}. ` +
        `On-hand: ${level.variantQty}, Reserved: ${level.reservedQty}, Required: ${fromOnHand}.`
      );
    }

    if (fromPicked > 0) {
      await this.storage.adjustInventoryLevel(level.id, { pickedQty: -fromPicked }, tx);
    }

    if (fromOnHand > 0) {
      await this.storage.adjustInventoryLevel(level.id, {
        variantQty: -fromOnHand,
        ...(reservedToRelease > 0 ? { reservedQty: -reservedToRelease } : {}),
      }, tx);
    }

    if (this.lotService) {
      const lotSvc = this.lotService.withTx(tx);
      await lotSvc.shipFromLots({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
        qty: params.qty,
        fromPicked,
        fromOnHand,
        reservedToRelease,
      });
    }

    // COGS is recorded authoritatively at PICK time (pickFromLots →
    // oms.order_item_costs), not at ship. The old recordShipmentCOGS path
    // here wrote to the retired inventory.order_line_costs ledger AND
    // re-decremented lot.qty_consumed — a double-consume hazard that, in
    // practice, recorded nothing because consumeLotsFIFO only sees
    // un-picked on-hand (already zero by ship time). Removed in COGS Phase 1.

    // The pre-write advisory fence handles ordinary replay. A late unique
    // violation must propagate: PostgreSQL has aborted this transaction, and
    // pretending success could hide rolled-back balances or caller effects.
    await this.storage.createInventoryTransaction({
      productVariantId: params.productVariantId,
      fromLocationId: params.warehouseLocationId,
      transactionType: "ship",
      variantQtyDelta: -params.qty,
      variantQtyBefore: level.variantQty,
      variantQtyAfter: level.variantQty - fromOnHand,
      reservedQtyDelta: -reservedToRelease,
      sourceState: fromOnHand > 0 ? "on_hand" : "picked",
      targetState: "shipped",
      orderId: params.orderId,
      orderItemId: params.orderItemId ?? null,
      shipmentId:
        params.shipmentId && Number.isInteger(Number(params.shipmentId))
          ? Number(params.shipmentId)
          : null,
      shipmentItemId: params.shipmentItemId ?? null,
      referenceType: "order",
      referenceId: params.shipmentId ?? String(params.orderId),
      userId: params.userId ?? null,
      notes: fromOnHand > 0 ? `Shipped without pick: ${fromPicked} from picked, ${fromOnHand} from on-hand` : null,
    }, tx);
  }

  /**
   * Materialize a physical replacement package from current warehouse stock.
   *
   * A replacement is a second inventory consumption, but not a second customer
   * fulfillment or customer-order COGS event. The provider callback supplies
   * evidence that the package shipped; this writer selects live, unreserved
   * stock and records the temporary pick plus the shipment atomically.
   */
  async recordReplacementShipmentFromAvailableInventory(
    params: RecordReplacementInventoryShipmentInput,
  ): Promise<{ warehouseLocationId: number; alreadyRecorded: boolean }> {
    if (!params || typeof params !== "object") throw new ValidationError("Shipment input is required");
    for (const field of ["productVariantId", "qty", "orderId", "shipmentId", "shipmentItemId"] as const) {
      validateShipmentInteger(params[field], field);
    }
    if (params.warehouseId !== null) validateShipmentInteger(params.warehouseId, "warehouseId");
    if (params.orderItemId !== undefined && params.orderItemId !== null) {
      validateShipmentInteger(params.orderItemId, "orderItemId");
    }
    if (params.userId !== undefined) validateShipmentText(params.userId, "userId");

    const result = await this.db.transaction(async (tx) => {
      await requireLegacyShipmentAuthority(tx);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(918407, ${params.shipmentItemId})
      `);

      const existing = await tx.execute(sql`
        SELECT from_location_id
        FROM inventory.inventory_transactions
        WHERE transaction_type = 'ship'
          AND shipment_item_id = ${params.shipmentItemId}
          AND reference_id = ${String(params.shipmentId)}
        LIMIT 1
      `);
      if (existing.rows.length > 0) {
        const locationId = Number((existing.rows[0] as any).from_location_id);
        if (!Number.isInteger(locationId) || locationId <= 0) {
          throw new IntegrityError(
            `Replacement shipment item ${params.shipmentItemId} has an idempotent ship ledger row without a source location.`,
          );
        }
        return { warehouseLocationId: locationId, alreadyRecorded: true };
      }

      // Read only current, usable inventory. Historic shipment source bins are
      // deliberately excluded: a reship must never debit the location used by
      // the original package merely because its row still references that bin.
      const candidates = await tx.execute(sql`
        SELECT il.warehouse_location_id
        FROM inventory.inventory_levels il
        JOIN warehouse.warehouse_locations wl
          ON wl.id = il.warehouse_location_id
        WHERE il.product_variant_id = ${params.productVariantId}
          AND il.variant_qty > il.reserved_qty
          AND wl.is_active = 1
          AND wl.is_pickable = 1
          AND wl.cycle_count_freeze_id IS NULL
          AND (${params.warehouseId}::int IS NULL OR wl.warehouse_id = ${params.warehouseId})
        ORDER BY
          CASE wl.location_type
            WHEN 'pick' THEN 0
            WHEN 'pallet' THEN 1
            ELSE 2
          END,
          wl.pick_sequence NULLS LAST,
          wl.id
      `);

      let selectedLevel: InventoryLevel | undefined;
      for (const candidate of candidates.rows as Array<{ warehouse_location_id: number }>) {
        const locationId = Number(candidate.warehouse_location_id);
        if (!Number.isInteger(locationId) || locationId <= 0) continue;

        const level = await this.storage.lockInventoryLevel(
          locationId,
          params.productVariantId,
          tx,
        );
        if (!level || level.variantQty - level.reservedQty < params.qty) continue;

        // Recheck after locking the balance. A cycle count that starts between
        // the candidate read and this lock must block the shipment rather than
        // allowing a system callback to mutate a frozen bin.
        await this.assertNotFrozen(locationId, tx);
        selectedLevel = level;
        break;
      }

      if (!selectedLevel) {
        throw new ReplacementInventoryUnavailableError({
          productVariantId: params.productVariantId,
          qty: params.qty,
          warehouseId: params.warehouseId,
        });
      }

      const locationId = selectedLevel.warehouseLocationId;
      // Mirror the regular pick writer: on-hand becomes picked first, then the
      // exact picked quantity is consumed by the shipment in this same SQL tx.
      await this.storage.adjustInventoryLevel(selectedLevel.id, {
        variantQty: -params.qty,
        pickedQty: params.qty,
      }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.pickFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: locationId,
          qty: params.qty,
          orderId: params.orderId,
          orderItemId: params.orderItemId ?? undefined,
          recordOrderItemCosts: false,
          allowReservedStock: false,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: locationId,
        transactionType: "pick",
        variantQtyDelta: -params.qty,
        variantQtyBefore: selectedLevel.variantQty,
        variantQtyAfter: selectedLevel.variantQty - params.qty,
        reservedQtyDelta: 0,
        sourceState: "on_hand",
        targetState: "picked",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        shipmentId: params.shipmentId,
        shipmentItemId: params.shipmentItemId,
        referenceType: "shipment",
        referenceId: String(params.shipmentId),
        userId: params.userId ?? null,
        isImplicit: 1,
        notes: "System replacement allocation from current unreserved inventory",
      }, tx);

      await this.storage.adjustInventoryLevel(selectedLevel.id, { pickedQty: -params.qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.shipFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: locationId,
          qty: params.qty,
          fromPicked: params.qty,
          fromOnHand: 0,
          reservedToRelease: 0,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: locationId,
        transactionType: "ship",
        variantQtyDelta: -params.qty,
        variantQtyBefore: selectedLevel.variantQty - params.qty,
        variantQtyAfter: selectedLevel.variantQty - params.qty,
        sourceState: "picked",
        reservedQtyDelta: 0,
        targetState: "shipped",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        shipmentId: params.shipmentId,
        shipmentItemId: params.shipmentItemId,
        referenceType: "shipment",
        referenceId: String(params.shipmentId),
        userId: params.userId ?? null,
        isImplicit: 1,
        notes: "System replacement shipment after current-stock allocation",
      }, tx);

      return { warehouseLocationId: locationId, alreadyRecorded: false };
    });

    if (!result.alreadyRecorded) {
      this.triggerNotifyChange(params.productVariantId, "replacement-shipment");
    }
    return result;
  }
  // ---------------------------------------------------------------------------
  // ADJUSTMENT
  // ---------------------------------------------------------------------------

  async adjustInventory(params: {
    commandKey?: string;
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    reasonId?: number;
    cycleCountId?: number;
    cycleCountItemId?: number;
    userId?: string;
    allowNegative?: boolean;
    unitCostCents?: number;
    /** Internal conversion owner requests exact evidence in JSON-safe decimal strings. */
    includeConsumedCostEvidence?: boolean;
    /** Internal conversion output only; supplied from the consumed FIFO owner result. */
    conversion?: { sourceLots: Array<{ lotId: number; qty: number }>; productMills: bigint; packagingMills: bigint; landedMills: bigint; provisional: boolean; operationKey: string; occurredAt: Date };
    /** Internal transaction orchestration hook; effects run only after the caller commits. */
    deferUntilCommit?: (effect: () => Promise<void>) => void;
  }, sharedPosting?: OperationalQuantityPosting): Promise<{
    orphanedQty: number;
    adjustmentTransactionId: number;
    consumedCostCents?: number;
    consumedQty?: number;
    consumedLots?: Array<{ lotId: number; qty: number }>;
    consumedPoCostMills?: string;
    consumedPackagingCostMills?: string;
    consumedLandedCostMills?: string;
    consumedCostProvisional?: boolean;
  }> {
    if (!Number.isSafeInteger(params.qtyDelta) || params.qtyDelta === 0) throw new Error("qtyDelta must be a non-zero safe integer");

    let orphanedQty = 0;
    let consumedCostCents: number | undefined;
    let consumedQty: number | undefined;
    let consumedDetail: { consumedLots: Array<{ lotId: number; qty: number }>; consumedPoCostMills: bigint; consumedPackagingCostMills: bigint; consumedLandedCostMills: bigint; consumedCostProvisional: boolean } | undefined;
    let adjustmentTransactionId: number | null = null;
    let replayedResult: z.infer<typeof adjustmentReplaySchema> | undefined;

    await this.db.transaction(async (tx) => {
      const quantityPosting = sharedPosting ?? await openOperationalQuantityPosting(tx);
      if (quantityPosting && !this.lotService) throw new IntegrityError("Ledger adjustments require exact FIFO lot ownership");
      const quantityKey = params.commandKey ?? (params.cycleCountItemId ? `cycle_count_item:${params.cycleCountItemId}`
        : params.conversion ? `${params.conversion.operationKey}:output:${params.productVariantId}:${params.warehouseLocationId}` : undefined);
      const replay = quantityPosting && !sharedPosting && await quantityPosting.beginOperation(quantityKey, { operation: "adjust", ...params,
        conversion: params.conversion ? { ...params.conversion, productMills: params.conversion.productMills.toString(),
          packagingMills: params.conversion.packagingMills.toString(), landedMills: params.conversion.landedMills.toString() } : null });
      if (replay) { replayedResult = adjustmentReplaySchema.parse(replay.result); return; }
      if (quantityPosting || params.conversion || params.includeConsumedCostEvidence) await lockInventoryCostGraph(tx);
      // Cycle-count adjustments are the ONE mutation allowed on frozen bins
      if (!params.cycleCountId) {
        await this.assertNotFrozen(params.warehouseLocationId, tx);
      }

      const level = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
      }, tx);

      if (!params.allowNegative && params.qtyDelta < 0) {
        if (level.variantQty + params.qtyDelta < 0) {
          throw new Error(`Adjustment would result in negative inventory`);
        }
      }

      // Handle the case where the adjustment reduces on-hand below reserved.
      // This violates the chk_reserved_lte_onhand database constraint, so we must
      // explicitly reduce reservedQty and return the orphaned amount for reallocation.
      const expectedNewQty = level.variantQty + params.qtyDelta;
      let adjustReserved = 0;
      if (params.qtyDelta < 0 && expectedNewQty < level.reservedQty) {
        orphanedQty = level.reservedQty - expectedNewQty;
        adjustReserved = -orphanedQty;
      }
      if (quantityPosting && adjustReserved !== 0) throw new IntegrityError("This adjustment would consume claimed inventory; use the claim-aware discrepancy command");

      if (!quantityPosting) await this.storage.adjustInventoryLevel(level.id, {
        variantQty: params.qtyDelta,
        reservedQty: adjustReserved !== 0 ? adjustReserved : undefined
      }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        if (params.conversion) {
          if (params.qtyDelta <= 0 || params.conversion.sourceLots.length === 0) throw new IntegrityError("A conversion output requires positive quantity and exact source lots");
          const layers = allocateBuildCostLayers({ poMills: params.conversion.productMills, packagingMills: params.conversion.packagingMills, landedMills: params.conversion.landedMills }, params.qtyDelta);
          let outputStartQty = 0;
          for (const layer of layers) {
            const totalMills = safeMillsNumber(layer.totalMills, "conversion.totalMills");
            const output = await lotSvc.createLot({ productVariantId: params.productVariantId, warehouseLocationId: params.warehouseLocationId,
              qty: layer.qty, unitCostCents: millsToCents(totalMills), unitCostMills: totalMills,
              packagingCostMills: safeMillsNumber(layer.packagingMills, "conversion.packagingMills"),
              landedCostMills: safeMillsNumber(layer.landedMills, "conversion.landedMills"), costSource: "transformation",
              costProvisional: params.conversion.provisional ? 1 : 0, receivedAt: params.conversion.occurredAt, notes: params.reason, quantityPosting });
            for (const source of params.conversion.sourceLots) await recordLotCostContribution(tx, { sourceLotId: source.lotId, outputLotId: output.id,
              sourceQty: source.qty, outputQty: params.qtyDelta, outputStartQty, operationKind: "conversion", operationKey: params.conversion.operationKey }, params.userId || "system:conversion", params.conversion.occurredAt);
            outputStartQty += layer.qty;
          }
        } else {
        const lotResult = await lotSvc.adjustLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qtyDelta: params.qtyDelta,
          reservedQtyDelta: adjustReserved !== 0 ? adjustReserved : undefined,
          unitCostCents: params.unitCostCents,
          notes: params.reason,
          quantityPosting,
        });
        consumedCostCents = lotResult.consumedCostCents;
        consumedQty = lotResult.consumedQty;
        consumedDetail = lotResult;
        }
      }

      const transaction = await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.qtyDelta < 0 ? params.warehouseLocationId : null,
        toLocationId: params.qtyDelta > 0 ? params.warehouseLocationId : null,
        transactionType: "adjustment",
        reasonId: params.reasonId ?? null,
        variantQtyDelta: params.qtyDelta,
        // A composed transform posts atomically only once. Its exact before/
        // after evidence belongs to quantity_entries, not child audit counters.
        variantQtyBefore: sharedPosting ? null : level.variantQty,
        variantQtyAfter: sharedPosting ? null : level.variantQty + params.qtyDelta,
        sourceState: "on_hand",
        targetState: "on_hand",
        cycleCountId: params.cycleCountId ?? null,
        referenceType: params.cycleCountItemId
          ? "cycle_count_item"
          : params.cycleCountId ? "cycle_count" : "manual",
        referenceId: params.cycleCountItemId
          ? String(params.cycleCountItemId)
          : params.cycleCountId ? String(params.cycleCountId) : null,
        notes: params.reason,
        userId: params.userId ?? null,
      }, tx);
      adjustmentTransactionId = transaction.id;
      if (quantityPosting && !sharedPosting) await quantityPosting.post({
        idempotencyKey: quantityKey!, kind: params.conversion ? "transform" : "adjust",
        actor: params.userId || "system:inventory_adjustment", reason: params.reason,
        reference: { type: "inventory_transaction", id: String(transaction.id) },
        occurredAt: (params.conversion?.occurredAt ?? this.clock()).toISOString(),
      });
      if (quantityPosting && !sharedPosting) await quantityPosting.finishOperation({ orphanedQty, adjustmentTransactionId, consumedCostCents, consumedQty,
        consumedLots: params.includeConsumedCostEvidence ? consumedDetail?.consumedLots : undefined,
        consumedPoCostMills: params.includeConsumedCostEvidence ? consumedDetail?.consumedPoCostMills.toString() : undefined,
        consumedPackagingCostMills: params.includeConsumedCostEvidence ? consumedDetail?.consumedPackagingCostMills.toString() : undefined,
        consumedLandedCostMills: params.includeConsumedCostEvidence ? consumedDetail?.consumedLandedCostMills.toString() : undefined,
        consumedCostProvisional: params.includeConsumedCostEvidence ? consumedDetail?.consumedCostProvisional : undefined,
      });
    });

    if (replayedResult) return replayedResult;
    if (adjustmentTransactionId == null) throw new Error("Inventory adjustment transaction was not recorded");
    const notifyAfterCommit = async () => this.triggerNotifyChange(params.productVariantId, "adjustment");
    if (params.deferUntilCommit) params.deferUntilCommit(notifyAfterCommit);
    else this.triggerNotifyChange(params.productVariantId, "adjustment");
    return { orphanedQty, adjustmentTransactionId, consumedCostCents, consumedQty,
      consumedLots: params.includeConsumedCostEvidence ? consumedDetail?.consumedLots : undefined,
      consumedPoCostMills: params.includeConsumedCostEvidence ? consumedDetail?.consumedPoCostMills.toString() : undefined,
      consumedPackagingCostMills: params.includeConsumedCostEvidence ? consumedDetail?.consumedPackagingCostMills.toString() : undefined,
      consumedLandedCostMills: params.includeConsumedCostEvidence ? consumedDetail?.consumedLandedCostMills.toString() : undefined,
      consumedCostProvisional: params.includeConsumedCostEvidence ? consumedDetail?.consumedCostProvisional : undefined,
    };
  }

  async approveCycleCountItemReconciliation(params: {
    cycleCountItemId: number;
    expectedStatus: string;
    actor: string;
    reasonCode: string;
    adjustmentTransactionId: number | null;
    occurredAt: Date;
  }): Promise<void> {
    if (!Number.isSafeInteger(params.cycleCountItemId) || params.cycleCountItemId <= 0) {
      throw new Error("cycleCountItemId must be a positive integer");
    }
    const expectedStatus = params.expectedStatus.trim();
    if (!["counted", "variance", "investigate"].includes(expectedStatus)) {
      throw new Error(`Cycle count item status ${expectedStatus || "<blank>"} is not approvable`);
    }
    const actor = params.actor.trim();
    if (!actor || actor.length > 100) throw new Error("actor must contain between 1 and 100 characters");
    const reasonCode = params.reasonCode.trim();
    if (!reasonCode || reasonCode.length > 50) {
      throw new Error("reasonCode must contain between 1 and 50 characters");
    }
    if (params.adjustmentTransactionId != null
      && (!Number.isSafeInteger(params.adjustmentTransactionId) || params.adjustmentTransactionId <= 0)) {
      throw new Error("adjustmentTransactionId must be a positive integer when provided");
    }
    if (!(params.occurredAt instanceof Date) || Number.isNaN(params.occurredAt.getTime())) {
      throw new Error("occurredAt must be a valid Date");
    }
    await this.db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE inventory.cycle_count_items
        SET status = 'approved', approved_by = ${actor}, approved_at = ${params.occurredAt},
            variance_reason = ${reasonCode}, adjustment_transaction_id = ${params.adjustmentTransactionId}
        WHERE id = ${params.cycleCountItemId} AND status = ${expectedStatus}
        RETURNING id
      `);
      if (result.rows.length !== 1) {
        throw new Error(
          `Cycle count item ${params.cycleCountItemId} changed before reconciliation could approve it`,
        );
      }
    });
  }

  async recordCycleCountReconciliationNoop(params: {
    productVariantId: number;
    warehouseLocationId: number;
    countedQty: number;
    cycleCountId: number;
    cycleCountItemId: number;
    actor: string;
    reason: string;
  }): Promise<{ adjustmentTransactionId: number }> {
    for (const [field, value] of Object.entries({
      productVariantId: params.productVariantId,
      warehouseLocationId: params.warehouseLocationId,
      cycleCountId: params.cycleCountId,
      cycleCountItemId: params.cycleCountItemId,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
    }
    if (!Number.isSafeInteger(params.countedQty) || params.countedQty < 0) {
      throw new Error("countedQty must be a nonnegative integer");
    }
    const actor = params.actor.trim();
    const reason = params.reason.trim();
    if (!actor || actor.length > 100) throw new Error("actor must contain between 1 and 100 characters");
    if (!reason || reason.length > 1000) throw new Error("reason must contain between 1 and 1000 characters");
    return this.db.transaction(async (tx) => {
      const transaction = await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        toLocationId: params.warehouseLocationId,
        transactionType: "adjustment",
        variantQtyDelta: 0,
        variantQtyBefore: params.countedQty,
        variantQtyAfter: params.countedQty,
        reservedQtyDelta: 0,
        sourceState: "on_hand",
        targetState: "on_hand",
        cycleCountId: params.cycleCountId,
        referenceType: "cycle_count_item",
        referenceId: String(params.cycleCountItemId),
        notes: reason,
        userId: actor,
      }, tx);
      return { adjustmentTransactionId: transaction.id };
    });
  }

  // ---------------------------------------------------------------------------
  // RESERVE
  // ---------------------------------------------------------------------------

  async reserveForOrder(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    userId?: string;
    referenceType?: string;
    referenceId?: string;
  }, txOverride?: any): Promise<boolean> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) {
      throw new Error("qty must be a positive safe integer");
    }
    const referenceType = String(params.referenceType ?? "order").trim();
    const referenceId = String(params.referenceId ?? params.orderId).trim();
    if (!referenceType || referenceType.length > 30) {
      throw new Error("referenceType must contain 1 to 30 characters");
    }
    if (!referenceId || referenceId.length > 100) {
      throw new Error("referenceId must contain 1 to 100 characters");
    }

    const doWork = async (tx: any) => {
      // One order item may have multiple supply segments (finished stock and
      // recipe-built shortfall). Each segment remains independently idempotent.
      const existingReserve = await tx.execute(sql`
        SELECT id
        FROM inventory.inventory_transactions
        WHERE transaction_type = 'reserve'
          AND order_id = ${params.orderId}
          AND order_item_id = ${params.orderItemId}
          AND COALESCE(reference_type, 'order') = ${referenceType}
          AND COALESCE(reference_id, order_id::text) = ${referenceId}
          AND voided_at IS NULL
        LIMIT 1
      `);
      if (existingReserve.rows.length > 0) {
        return true;
      }

      const level = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
      }, tx);

      await this.storage.adjustInventoryLevel(level.id, { reservedQty: params.qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.reserveFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
        });
      }

      try {
        await this.storage.createInventoryTransaction({
          productVariantId: params.productVariantId,
          toLocationId: params.warehouseLocationId,
          transactionType: "reserve",
          variantQtyDelta: 0,
          variantQtyBefore: level.variantQty,
          variantQtyAfter: level.variantQty,
          reservedQtyDelta: params.qty,
          sourceState: "on_hand",
          targetState: "committed",
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          referenceType,
          referenceId,
          userId: params.userId ?? null,
        }, tx);
      } catch (err: any) {
        // Belt-and-suspenders: if the unique index catches a race, treat as success
        if (err?.code === "23505" && String(err?.constraint ?? "").includes("reserve_dedup")) {
          return true;
        }
        throw err;
      }

      return true;
    };

    const result = txOverride
      ? await doWork(txOverride)
      : await this.db.transaction(doWork);

    this.triggerNotifyChange(params.productVariantId, "reserve");
    return result;
  }

  async releaseReservation(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    reason: string;
    userId?: string;
    referenceType?: string;
    referenceId?: string;
  }, txOverride?: any): Promise<void> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) throw new Error("qty must be a positive safe integer");

    const doWork = async (tx: any) => {
      const level = await this.storage.lockInventoryLevel(
        params.warehouseLocationId,
        params.productVariantId,
        tx
      );

      if (!level) throw new Error(`No inventory level`);
      if (level.reservedQty < params.qty) throw new Error(`Cannot release ${params.qty} reserved units`);

      await this.storage.adjustInventoryLevel(level.id, { reservedQty: -params.qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.releaseFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty: params.qty,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "unreserve",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
        reservedQtyDelta: -params.qty,
        sourceState: "committed",
        targetState: "on_hand",
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        referenceType: params.referenceType ?? "order",
        referenceId: params.referenceId ?? String(params.orderId),
        notes: params.reason,
        userId: params.userId ?? null,
      }, tx);
    };

    if (txOverride) {
      await doWork(txOverride);
    } else {
      await this.db.transaction(doWork);
    }

    // A caller-owned transaction has not committed yet. Its application
    // service must emit the post-commit channel sync after that transaction
    // succeeds; firing here could publish stale ATP.
    if (!txOverride) {
      this.triggerNotifyChange(params.productVariantId, "unreserve");
    }
  }

  /**
   * Force-release orphaned reservation quantity at a level with no owning
   * order (e.g. a cycle count zeroed stock out from under a reservation).
   * Clamps to the level's current reserved counter, releases matching lot
   * reservations, and writes the ledgered unreserve — all in one transaction.
   *
   * Replaces the phantom `adjustLevel` call this path used to make (P0.1b).
   *
   * @returns units actually trimmed (0 if nothing reserved).
   */
  async trimOrphanedReservation(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    reason: string;
    userId?: string;
  }, txOverride?: any): Promise<number> {
    if (params.qty <= 0) return 0;

    const trimWithinTransaction = async (tx: any) => {
      const level = await this.storage.lockInventoryLevel(
        params.warehouseLocationId,
        params.productVariantId,
        tx
      );
      if (!level || level.reservedQty <= 0) return 0;

      const qty = Math.min(params.qty, level.reservedQty);
      await this.storage.adjustInventoryLevel(level.id, { reservedQty: -qty }, tx);

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.releaseFromLots({
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          qty,
        });
      }

      await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "unreserve",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
        reservedQtyDelta: -qty,
        sourceState: "committed",
        targetState: "on_hand",
        referenceType: "orphan_reallocation",
        notes: params.reason,
        userId: params.userId ?? null,
      }, tx);

      return qty;
    };
    const trimmed = txOverride
      ? await trimWithinTransaction(txOverride)
      : await this.db.transaction(trimWithinTransaction);

    if (trimmed > 0) {
      this.triggerNotifyChange(params.productVariantId, "unreserve");
    }
    return trimmed;
  }

  // ---------------------------------------------------------------------------
  // REPLENISHMENT MOVEMENT
  // ---------------------------------------------------------------------------

  /**
   * Moves only unreserved physical stock for a frozen replenishment task.
   * Canonical claims own `reservedQty` and exact reserved FIFO quantities, so
   * this boundary must never trim, relocate, or consume either one.
   */
  async executeReplenishmentMove(params: {
    taskId: number;
    replenMethod: string;
    sourceVariant: {
      id: number;
      productId: number | null;
      unitsPerVariant: number;
    };
    pickVariant: {
      id: number;
      productId: number | null;
      unitsPerVariant: number;
    };
    fromLocationId: number;
    toLocationId: number;
    qtySourceUnits: number;
    qtyTargetUnits: number;
    userId?: string;
    notes?: string;
    occurredAt?: Date;
    deferUntilCommit?: (effect: () => Promise<void>) => void;
  }): Promise<{ movedBaseUnits: number; qtyPickUnits: number }> {
    const plan = planReplenishmentExecution({
      replenMethod: params.replenMethod,
      sourceVariantId: params.sourceVariant.id,
      sourceProductId: params.sourceVariant.productId,
      sourceUnitsPerVariant: params.sourceVariant.unitsPerVariant,
      pickVariantId: params.pickVariant.id,
      pickProductId: params.pickVariant.productId,
      pickUnitsPerVariant: params.pickVariant.unitsPerVariant,
      qtySourceUnits: params.qtySourceUnits,
      qtyTargetUnits: params.qtyTargetUnits,
    });

    if (!this.lotService) {
      throw new ReplenishmentInventoryConflictError(
        "REPLENISHMENT_LOT_SERVICE_UNAVAILABLE",
        "Replenishment requires exact FIFO lot accounting.",
        { taskId: params.taskId, replenMethod: params.replenMethod },
      );
    }

    if (plan.method === "direct_transfer") {
      await this.transfer({
        productVariantId: plan.sourceVariantId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        qty: plan.qtySourceUnits,
        userId: params.userId,
        notes: params.notes ?? `Replen task #${params.taskId}`,
        referenceType: "replenishment_task",
        referenceId: String(params.taskId),
        deferUntilCommit: params.deferUntilCommit,
      });
      return { movedBaseUnits: plan.movedBaseUnits, qtyPickUnits: plan.qtyPickUnits };
    }

    const occurredAt = params.occurredAt ?? this.clock();
    if (Number.isNaN(occurredAt.getTime())) {
      throw new ValidationError("Replenishment occurrence time must be valid", { taskId: params.taskId });
    }

    await this.db.transaction(async (tx) => {
      const quantityPosting = await openOperationalQuantityPosting(tx);
      const quantityKey = `replenishment_transform:${params.taskId}`;
      if (quantityPosting && await quantityPosting.beginOperation(quantityKey, { operation: "replenishment_transform",
        taskId: params.taskId, sourceVariant: params.sourceVariant, pickVariant: params.pickVariant,
        fromLocationId: params.fromLocationId, toLocationId: params.toLocationId, qtySourceUnits: params.qtySourceUnits,
        qtyTargetUnits: params.qtyTargetUnits, userId: params.userId, notes: params.notes, replenMethod: params.replenMethod })) return;
      await lockInventoryCostGraph(tx);
      const [fromLoc] = await tx
        .select()
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, params.fromLocationId))
        .limit(1);
      const [toLoc] = await tx
        .select()
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, params.toLocationId))
        .limit(1);
      if (!fromLoc || !toLoc) {
        throw new IntegrityError("Replenishment source and destination locations must both exist", {
          taskId: params.taskId,
          fromLocationId: params.fromLocationId,
          toLocationId: params.toLocationId,
        });
      }
      if (fromLoc.isActive !== 1 || toLoc.isActive !== 1) {
        throw new IntegrityError("Replenishment source and destination locations must both be active", {
          taskId: params.taskId,
          fromLocationCode: fromLoc.code,
          toLocationCode: toLoc.code,
        });
      }
      if (fromLoc.cycleCountFreezeId || toLoc.cycleCountFreezeId) {
        throw new FreezeViolationError(fromLoc.cycleCountFreezeId ? params.fromLocationId : params.toLocationId);
      }
      if (fromLoc.warehouseId == null || fromLoc.warehouseId !== toLoc.warehouseId) {
        throw new IntegrityError("Replenishment movement must remain inside one warehouse", {
          taskId: params.taskId,
          fromWarehouseId: fromLoc.warehouseId ?? null,
          toWarehouseId: toLoc.warehouseId ?? null,
        });
      }

      if (quantityPosting) await tx.execute(sql`SELECT id FROM inventory.inventory_levels
        WHERE (product_variant_id = ${plan.sourceVariantId} AND warehouse_location_id = ${params.fromLocationId})
          OR (product_variant_id = ${plan.pickVariantId} AND warehouse_location_id = ${params.toLocationId})
        ORDER BY warehouse_location_id, product_variant_id, id FOR UPDATE`);
      const sourceLevel = await this.storage.lockInventoryLevel(
        params.fromLocationId,
        plan.sourceVariantId,
        tx,
      );
      const available = (sourceLevel?.variantQty ?? 0) - (sourceLevel?.reservedQty ?? 0);
      if (!sourceLevel || available < plan.qtySourceUnits) {
        throw new ReplenishmentInventoryConflictError(
          "REPLENISHMENT_RESERVED_STOCK_PROTECTED",
          "Replenishment cannot consume inventory owned by an order claim.",
          {
            taskId: params.taskId,
            productVariantId: plan.sourceVariantId,
            fromLocationId: params.fromLocationId,
            requestedQty: plan.qtySourceUnits,
            onHandQty: sourceLevel?.variantQty ?? 0,
            reservedQty: sourceLevel?.reservedQty ?? 0,
            availableQty: Math.max(0, available),
          },
        );
      }

      const targetLevel = await this.storage.upsertInventoryLevel({
        productVariantId: plan.pickVariantId,
        warehouseLocationId: params.toLocationId,
      }, tx);
      const lotService = this.lotService!.withTx(tx);
      const consumed = await lotService.adjustLots({
        productVariantId: plan.sourceVariantId,
        warehouseLocationId: params.fromLocationId,
        qtyDelta: -plan.qtySourceUnits,
        notes: params.notes ?? `Replen task #${params.taskId} case break`,
        quantityPosting,
      });
      if (consumed.consumedQty !== plan.qtySourceUnits) {
        throw new IntegrityError("Case-break FIFO consumption did not match its frozen task quantity", {
          taskId: params.taskId,
          expectedQty: plan.qtySourceUnits,
          consumedQty: consumed.consumedQty,
        });
      }

      if (!quantityPosting) {
        await this.storage.adjustInventoryLevel(sourceLevel.id, { variantQty: -plan.qtySourceUnits }, tx);
        await this.storage.adjustInventoryLevel(targetLevel.id, { variantQty: plan.qtyPickUnits }, tx);
      }

      const outputLayers = allocateBuildCostLayers({
        poMills: consumed.consumedPoCostMills,
        packagingMills: consumed.consumedPackagingCostMills,
        landedMills: consumed.consumedLandedCostMills,
      }, plan.qtyPickUnits);
      let outputStartQty = 0;
      for (const layer of outputLayers) {
        const totalMills = safeMillsNumber(layer.totalMills, "replenishment.output.totalMills");
        const outputLot = await lotService.createLot({
          productVariantId: plan.pickVariantId,
          warehouseLocationId: params.toLocationId,
          qty: layer.qty,
          unitCostCents: millsToCents(totalMills),
          unitCostMills: totalMills,
          packagingCostMills: safeMillsNumber(
            layer.packagingMills,
            "replenishment.output.packagingMills",
          ),
          landedCostMills: safeMillsNumber(layer.landedMills, "replenishment.output.landedMills"),
          costSource: "transformation",
          costProvisional: consumed.consumedCostProvisional ? 1 : 0,
          receivedAt: occurredAt,
          notes: params.notes ?? `Output from replen task #${params.taskId}`,
          quantityPosting,
        });
        for (const source of consumed.consumedLots) await recordLotCostContribution(tx, {
          sourceLotId: source.lotId, outputLotId: outputLot.id, sourceQty: source.qty,
          outputQty: plan.qtyPickUnits, outputStartQty, operationKind: "conversion", operationKey: `replenishment:${params.taskId}`,
        }, params.userId || "system:replenishment", occurredAt);
        outputStartQty += layer.qty;
      }

      const referenceId = String(params.taskId);
      const notes = params.notes ?? `Replen task #${params.taskId} case break`;
      await this.storage.createInventoryTransaction({
        productVariantId: plan.sourceVariantId,
        fromLocationId: params.fromLocationId,
        transactionType: "break",
        variantQtyDelta: -plan.qtySourceUnits,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: sourceLevel.variantQty - plan.qtySourceUnits,
        sourceState: "on_hand",
        targetState: "transformed",
        referenceType: "replenishment_task",
        referenceId,
        userId: params.userId ?? null,
        notes,
      }, tx);
      await this.storage.createInventoryTransaction({
        productVariantId: plan.pickVariantId,
        toLocationId: params.toLocationId,
        transactionType: "break",
        variantQtyDelta: plan.qtyPickUnits,
        variantQtyBefore: targetLevel.variantQty,
        variantQtyAfter: targetLevel.variantQty + plan.qtyPickUnits,
        sourceState: "transformed",
        targetState: "on_hand",
        referenceType: "replenishment_task",
        referenceId,
        userId: params.userId ?? null,
        notes,
      }, tx);
      if (quantityPosting) await quantityPosting.post({
        idempotencyKey: quantityKey, kind: "transform",
        actor: params.userId || "system:replenishment", reason: notes,
        reference: { type: "replenishment_task", id: String(params.taskId) }, occurredAt: occurredAt.toISOString(),
      });
      if (quantityPosting) await quantityPosting.finishOperation({ movedBaseUnits: plan.movedBaseUnits, qtyPickUnits: plan.qtyPickUnits });
    });

    const notifyAfterCommit = async () => {
      this.triggerNotifyChange(plan.sourceVariantId, "replenishment-case-break-out");
      this.triggerNotifyChange(plan.pickVariantId, "replenishment-case-break-in");
    };
    if (params.deferUntilCommit) params.deferUntilCommit(notifyAfterCommit);
    else await notifyAfterCommit();
    return { movedBaseUnits: plan.movedBaseUnits, qtyPickUnits: plan.qtyPickUnits };
  }

  // ---------------------------------------------------------------------------
  // TRANSFER
  // ---------------------------------------------------------------------------

  async transfer(params: {
    commandKey?: string;
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    qty: number;
    userId?: string;
    notes?: string;
    /** Audit reference for the owning workflow. Generic transfers retain the legacy internal reference. */
    referenceType?: string;
    referenceId?: string;
    /** Internal transaction orchestration hook; effects run only after the caller commits. */
    deferUntilCommit?: (effect: () => Promise<void>) => void;
    /**
     * When true, allow the transfer to also move the spillover reserved
     * allocation (and re-point eligible pending order lines) from source to
     * destination. Default false: a transfer that would consume reserved stock
     * is rejected with a TRANSFER_BLOCKED_BY_RESERVATION error so reservations
     * never silently follow stock around.
     */
    moveReserved?: boolean;
  }): Promise<{ reservedMoved: number; orderItemsRepointed: number }> {
    if (!Number.isSafeInteger(params.qty) || params.qty <= 0) throw new Error("qty must be a positive safe integer");
    if (params.fromLocationId === params.toLocationId) throw new Error("Source and destination must differ");

    let reservedMoved = 0;
    let orderItemsRepointed = 0;
    let replayed = false;

    await this.db.transaction(async (tx) => {
      const quantityPosting = await openOperationalQuantityPosting(tx);
      if (quantityPosting && !this.lotService) throw new IntegrityError("Ledger transfers require exact FIFO lot ownership");
      const quantityKey = params.commandKey ?? (params.referenceId ? `${params.referenceType ?? "internal"}:${params.referenceId}` : undefined);
      const replay = quantityPosting && await quantityPosting.beginOperation(quantityKey, { operation: "transfer", ...params });
      if (replay) {
        const result = z.object({ reservedMoved: z.number().int().nonnegative(), orderItemsRepointed: z.number().int().nonnegative() }).parse(replay.result);
        reservedMoved = result.reservedMoved; orderItemsRepointed = result.orderItemsRepointed; replayed = true; return;
      }
      await lockInventoryCostGraph(tx);
      const [fromLoc] = await tx
        .select()
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, params.fromLocationId))
        .limit(1);
      const [toLoc] = await tx
        .select()
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, params.toLocationId))
        .limit(1);

      if (!fromLoc) throw new Error(`Source location ${params.fromLocationId} not found`);
      if (!toLoc) throw new Error(`Destination location ${params.toLocationId} not found`);
      if (fromLoc.cycleCountFreezeId) throw new FreezeViolationError(params.fromLocationId);
      if (toLoc.cycleCountFreezeId) throw new FreezeViolationError(params.toLocationId);
      if (fromLoc.isActive !== 1) throw new Error(`Source location ${fromLoc.code} is inactive`);
      if (toLoc.isActive !== 1) throw new Error(`Destination location ${toLoc.code} is inactive`);
      if (fromLoc.warehouseId == null) throw new Error(`Source location ${fromLoc.code} is not assigned to a warehouse`);
      if (toLoc.warehouseId == null) throw new Error(`Destination location ${toLoc.code} is not assigned to a warehouse`);
      if (fromLoc.warehouseId !== toLoc.warehouseId) {
        throw new Error(
          `Inventory transfer must stay within one warehouse (${fromLoc.code} warehouse ${fromLoc.warehouseId}, ${toLoc.code} warehouse ${toLoc.warehouseId})`,
        );
      }

      if (quantityPosting) await tx.execute(sql`SELECT id FROM inventory.inventory_levels
        WHERE product_variant_id = ${params.productVariantId}
          AND warehouse_location_id IN (${params.fromLocationId}, ${params.toLocationId})
        ORDER BY warehouse_location_id, product_variant_id, id FOR UPDATE`);
      const sourceLevel = await this.storage.lockInventoryLevel(
        params.fromLocationId,
        params.productVariantId,
        tx
      );

      if (!sourceLevel || sourceLevel.variantQty < params.qty) {
        throw new Error(`Insufficient on-hand at source: need ${params.qty}, have ${sourceLevel?.variantQty || 0}`);
      }

      // Available = on-hand minus reserved. Moving more than `available` would
      // strand the reservation (reserved_qty > on-hand at the source), which both
      // violates the check_reserved_lte_on_hand constraint and would send the
      // picker to an empty bin. Allowed only when the caller explicitly opts in
      // to moving the reservation with the stock.
      const reserved = sourceLevel.reservedQty || 0;
      const available = sourceLevel.variantQty - reserved;

      let reservedToMove = 0;
      if (available < params.qty) {
        if (!params.moveReserved) {
          const err: any = new Error(
            `Insufficient available at source: need ${params.qty}, have ${available} available (${reserved} reserved)`,
          );
          err.code = "TRANSFER_BLOCKED_BY_RESERVATION";
          err.context = {
            needed: params.qty,
            onHandAtSource: sourceLevel.variantQty,
            availableAtSource: available,
            reservedAtSource: reserved,
            sourceCode: fromLoc.code,
            destCode: toLoc.code,
          };
          throw err;
        }
        // Spillover reserved that must follow the stock. Bounded by `reserved`
        // because qty <= on-hand (checked above): qty - available <= reserved.
        reservedToMove = params.qty - available;
      }

      // Concurrency guard (§9): never pull reserved stock out from under an
      // in-progress pick. If any live order line for this variant is mid-pick or
      // already picked at the source bin, refuse and ask the user to finish or
      // cancel that pick first.
      if (reservedToMove > 0) {
        if (quantityPosting) throw new IntegrityError("A transfer cannot relocate canonical claim ownership; release and replan the claim first");
        // order_items has no variant FK; it links to a variant by SKU
        // (catalog.product_variants.sku). Match through that.
        const conflict = await tx.execute(sql`
          SELECT oi.id
          FROM wms.order_items oi
          JOIN wms.orders o ON o.id = oi.order_id
          JOIN catalog.product_variants pv ON UPPER(pv.sku) = UPPER(oi.sku)
          WHERE pv.id = ${params.productVariantId}
            AND UPPER(oi.location) = UPPER(${fromLoc.code})
            AND oi.requires_shipping = 1
            AND (oi.picked_quantity > 0 OR oi.status = 'picked')
            -- 'completed' = warehouse work done; no pick can still be active
            AND o.warehouse_status NOT IN ('shipped', 'cancelled', 'completed')
          LIMIT 1
        `);
        if (conflict.rows.length > 0) {
          const err: any = new Error(
            `Cannot move reserved stock from ${fromLoc.code}: an order at this bin is mid-pick. Complete or cancel that pick before transferring.`,
          );
          err.code = "TRANSFER_BLOCKED_BY_ACTIVE_PICK";
          err.context = { sourceCode: fromLoc.code, variantId: params.productVariantId };
          throw err;
        }
      }

      // Source: decrement on-hand and (if moving) reserved in a SINGLE update so
      // the row never transiently violates check_reserved_lte_on_hand.
      if (!quantityPosting) await this.storage.adjustInventoryLevel(
        sourceLevel.id,
        {
          variantQty: -params.qty,
          ...(reservedToMove > 0 ? { reservedQty: -reservedToMove } : {}),
        },
        tx,
      );

      const targetLevel = await this.storage.upsertInventoryLevel({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.toLocationId,
      }, tx);

      // Destination: increment on-hand and (if moving) reserved together. on-hand
      // rises by qty >= reservedToMove, so reserved <= on-hand holds.
      if (!quantityPosting) await this.storage.adjustInventoryLevel(
        targetLevel.id,
        {
          variantQty: params.qty,
          ...(reservedToMove > 0 ? { reservedQty: reservedToMove } : {}),
        },
        tx,
      );

      // Re-point eligible pending order lines so the picker is sent to the new
      // bin. Only fully un-started lines (picked_quantity = 0, status 'pending')
      // on live orders are moved; mid-pick lines were rejected above.
      if (reservedToMove > 0) {
        orderItemsRepointed = await repointPendingWmsOrderItemsForInventoryTransfer(tx, {
          productVariantId: params.productVariantId,
          fromLocationCode: fromLoc.code,
          toLocationCode: toLoc.code,
          toZone: toLoc.zone ?? "U",
        });
      }

      if (this.lotService) {
        const lotSvc = this.lotService.withTx(tx);
        await lotSvc.transferLots({
          productVariantId: params.productVariantId,
          fromLocationId: params.fromLocationId,
          toLocationId: params.toLocationId,
          qty: params.qty,
          notes: params.notes,
          actorId: params.userId || "system:inventory_transfer",
          occurredAt: this.clock(),
          operationKey: params.referenceId ? `${params.referenceType ?? "internal"}:${params.referenceId}` : undefined,
          quantityPosting,
        });
      }

      const transferReceipt = await this.storage.createInventoryTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        transactionType: "transfer",
        variantQtyDelta: params.qty,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: sourceLevel.variantQty - params.qty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: params.referenceType ?? "internal",
        referenceId: params.referenceId ?? null,
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      }, tx);
      if (quantityPosting) await quantityPosting.post({
        idempotencyKey: quantityKey!, kind: "transfer",
        actor: params.userId || "system:inventory_transfer", reason: params.notes || "Warehouse stock transfer",
        reference: { type: "inventory_transaction", id: String(transferReceipt.id) }, occurredAt: this.clock().toISOString(),
      });

      // Separate ledger row for the reserved movement so a single order's audit
      // trail explains why its reservation hopped bins.
      if (reservedToMove > 0) {
        await this.storage.createInventoryTransaction({
          productVariantId: params.productVariantId,
          fromLocationId: params.fromLocationId,
          toLocationId: params.toLocationId,
          transactionType: "reserve_move",
          variantQtyDelta: reservedToMove,
          variantQtyBefore: reserved,
          variantQtyAfter: reserved - reservedToMove,
          sourceState: "reserved",
          targetState: "reserved",
          referenceType: params.referenceType ?? "internal",
          referenceId: params.referenceId ?? null,
          notes:
            `Moved ${reservedToMove} reserved unit(s) with stock transfer; ` +
            `re-pointed ${orderItemsRepointed} pending order line(s)` +
            (params.notes ? `. ${params.notes}` : ""),
          userId: params.userId ?? null,
        }, tx);
        reservedMoved = reservedToMove;
      }
      if (quantityPosting) await quantityPosting.finishOperation({ reservedMoved, orderItemsRepointed });
    });

    const notifyAfterCommit = async () => this.triggerNotifyChange(params.productVariantId, "transfer");
    if (!replayed) {
      if (params.deferUntilCommit) params.deferUntilCommit(notifyAfterCommit);
      else await notifyAfterCommit();
    }
    return { reservedMoved, orderItemsRepointed };
  }

  // ---------------------------------------------------------------------------
  // SKU CONVERSION
  // ---------------------------------------------------------------------------

  async convertSku(params: {
    commandKey?: string;
    fromVariantId: number;
    toVariantId: number;
    locationId?: number;
    quantity?: number;
    notes?: string;
    userId?: string;
    deferUntilCommit?: (effect: () => Promise<void>) => void;
  }, sharedPosting?: OperationalQuantityPosting): Promise<{ totalConverted: number; conversions: { locationCode: string; qty: number }[]; batchId: string }> {
    if (params.fromVariantId === params.toVariantId) {
      throw new ValidationError("Source and destination variants must be different");
    }

    const convertQty = params.quantity ?? null;
    if (convertQty !== null && convertQty <= 0) {
      throw new ValidationError("Quantity must be a positive integer");
    }

    const batchId = params.commandKey ? `skuconv-${createHash("sha256").update(params.commandKey).digest("hex").slice(0, 32)}` : `skuconv-${Date.now()}`;
    const conversions: { locationCode: string; qty: number }[] = [];

    const result = await this.db.transaction(async (tx) => {
      const quantityPosting = sharedPosting ?? await openOperationalQuantityPosting(tx);
      const replay = quantityPosting && !sharedPosting && await quantityPosting.beginOperation(params.commandKey, { operation: "sku_correction", ...params });
      if (replay) return z.object({ totalConverted: z.number().int().nonnegative(), batchId: z.string(),
        conversions: z.array(z.object({ locationCode: z.string(), qty: z.number().int().positive() })) }).parse(replay.result);
      if (quantityPosting) {
        if (!this.lotService) throw new IntegrityError("SKU correction requires exact FIFO lot ownership");
        await lockInventoryCostGraph(tx);
        await tx.execute(sql`SELECT id FROM inventory.inventory_levels
          WHERE product_variant_id IN (${params.fromVariantId}, ${params.toVariantId})
            ${params.locationId ? sql`AND warehouse_location_id = ${params.locationId}` : sql``}
          ORDER BY warehouse_location_id, product_variant_id, id FOR UPDATE`);
      }
      // Find all inventory for the source variant
      const sourceInventoryResp = await tx.execute(sql`
        SELECT
          il.warehouse_location_id as warehouse_location_id,
          il.variant_qty as variant_qty,
          wl.code as location_code
        FROM inventory.inventory_levels il
        JOIN warehouse.warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.product_variant_id = ${params.fromVariantId}
          ${params.locationId ? sql`AND il.warehouse_location_id = ${params.locationId}` : sql``}
          AND il.variant_qty > 0
        ORDER BY il.warehouse_location_id, il.product_variant_id, il.id
        FOR UPDATE OF il
      `);
      
      const sourceInventory = sourceInventoryResp.rows;
      if (sourceInventory.length === 0) {
        throw new IntegrityError("No inventory found for source variant");
      }

      const totalAvailable = sourceInventory.reduce((s: number, l: any) => s + Number(l.variant_qty), 0);
      if (convertQty !== null && convertQty > totalAvailable) {
        throw new IntegrityError(`Requested ${convertQty} but only ${totalAvailable} available`);
      }

      let remaining = convertQty ?? totalAvailable;

      for (const inv of sourceInventory) {
        if (remaining <= 0) break;
        const qtyToConvert = Math.min(Number(inv.variant_qty), remaining);

        // Adjust-out from old variant
        const sourceLevel = await this.storage.upsertInventoryLevel({
          productVariantId: params.fromVariantId,
          warehouseLocationId: inv.warehouse_location_id,
        }, tx);
        if (quantityPosting) await this.assertNotFrozen(inv.warehouse_location_id, tx);
        
        if (!quantityPosting) await this.storage.adjustInventoryLevel(sourceLevel.id, { variantQty: -qtyToConvert }, tx);
        
        await this.storage.createInventoryTransaction({
          productVariantId: params.fromVariantId,
          fromLocationId: inv.warehouse_location_id,
          transactionType: "sku_correction",
          variantQtyDelta: -qtyToConvert,
          variantQtyBefore: sharedPosting ? null : sourceLevel.variantQty,
          variantQtyAfter: sharedPosting ? null : sourceLevel.variantQty - qtyToConvert,
          sourceState: "on_hand",
          targetState: "on_hand",
          batchId,
          referenceType: "sku_conversion",
          referenceId: `${params.fromVariantId}→${params.toVariantId}`,
          notes: params.notes ?? null,
          userId: params.userId ?? null,
        }, tx);

        // Adjust-in to new variant
        const destLevel = await this.storage.upsertInventoryLevel({
          productVariantId: params.toVariantId,
          warehouseLocationId: inv.warehouse_location_id,
        }, tx);
        
        if (quantityPosting) {
          const lotService = this.lotService!.withTx(tx);
          const consumed = await lotService.adjustLots({ productVariantId: params.fromVariantId,
            warehouseLocationId: inv.warehouse_location_id, qtyDelta: -qtyToConvert, quantityPosting, notes: params.notes });
          const layers = allocateBuildCostLayers({ poMills: consumed.consumedPoCostMills,
            packagingMills: consumed.consumedPackagingCostMills, landedMills: consumed.consumedLandedCostMills }, qtyToConvert);
          let outputStartQty = 0;
          const occurredAt = this.clock();
          for (const layer of layers) {
            const total = safeMillsNumber(layer.totalMills, "sku_correction.totalMills");
            const lot = await lotService.createLot({ productVariantId: params.toVariantId, warehouseLocationId: inv.warehouse_location_id,
              qty: layer.qty, unitCostCents: millsToCents(total), unitCostMills: total,
              packagingCostMills: safeMillsNumber(layer.packagingMills, "sku_correction.packagingMills"),
              landedCostMills: safeMillsNumber(layer.landedMills, "sku_correction.landedMills"),
              costSource: "sku_correction", costProvisional: consumed.consumedCostProvisional ? 1 : 0,
              notes: params.notes, receivedAt: occurredAt, quantityPosting });
            for (const source of consumed.consumedLots) await recordLotCostContribution(tx, {
              sourceLotId: source.lotId, outputLotId: lot.id, sourceQty: source.qty, outputQty: qtyToConvert,
              outputStartQty, operationKind: "conversion", operationKey: batchId,
            }, params.userId || "system:sku_correction", occurredAt);
            outputStartQty += layer.qty;
          }
        } else await this.storage.adjustInventoryLevel(destLevel.id, { variantQty: qtyToConvert }, tx);
        
        await this.storage.createInventoryTransaction({
          productVariantId: params.toVariantId,
          toLocationId: inv.warehouse_location_id,
          transactionType: "sku_correction",
          variantQtyDelta: qtyToConvert,
          // Shared batches may accumulate several cost layers at this target;
          // only the final quantity entry/projection owns balance transitions.
          variantQtyBefore: sharedPosting ? null : destLevel.variantQty,
          variantQtyAfter: sharedPosting ? null : destLevel.variantQty + qtyToConvert,
          sourceState: "on_hand",
          targetState: "on_hand",
          batchId,
          referenceType: "sku_conversion",
          referenceId: `${params.fromVariantId}→${params.toVariantId}`,
          notes: params.notes ?? null,
          userId: params.userId ?? null,
        }, tx);

        // Cleanup empty source
        if (!quantityPosting && sourceLevel.variantQty - qtyToConvert <= 0) {
          const hasAssignment = await tx.execute(sql`
            SELECT 1 FROM product_locations
            WHERE product_variant_id = ${params.fromVariantId}
              AND warehouse_location_id = ${inv.warehouse_location_id}
            LIMIT 1
          `);
          if (hasAssignment.rows.length === 0) {
            await tx.execute(sql`DELETE FROM inventory_levels WHERE id = ${sourceLevel.id}`);
          }
        }

        conversions.push({ locationCode: inv.location_code, qty: qtyToConvert });
        remaining -= qtyToConvert;
      }
      
      const result = { totalConverted: conversions.reduce((s, c) => s + c.qty, 0), conversions, batchId };
      if (quantityPosting && !sharedPosting) {
        await quantityPosting.post({ idempotencyKey: params.commandKey!, kind: "transform",
          actor: params.userId || "system:sku_correction", reason: params.notes || "Explicit SKU inventory correction",
          reference: { type: "sku_correction", id: batchId }, occurredAt: this.clock().toISOString() });
        await quantityPosting.finishOperation(result);
      }
      return result;
    });

    const notifyAfterCommit = async () => {
    AuditLogger.log({
      actor: params.userId || "system",
      action: "convert_sku",
      target: `variant_${params.fromVariantId}_to_${params.toVariantId}`,
      changes: {
        before: { variant_id: params.fromVariantId },
        after: { variant_id: params.toVariantId, amount_converted: result.totalConverted }
      }
    });

    this.triggerNotifyChange(params.fromVariantId, "convert-sku-out");
    this.triggerNotifyChange(params.toVariantId, "convert-sku-in");
    };
    if (params.deferUntilCommit) params.deferUntilCommit(notifyAfterCommit);
    else await notifyAfterCommit();

    return result;
  }

  // ---------------------------------------------------------------------------
  // EXTERNAL SOURCE SYNC
  // ---------------------------------------------------------------------------

  async syncWarehouse(warehouseId: number): Promise<any> {
    // Provider availability is not an exact physical-lot receipt. External
    // observations must not be converted into local stock by this legacy path.
    await assertLegacyQuantityImportAllowed(this.db, "Legacy external inventory sync");
    const [wh] = await this.db.select().from(warehouses).where(eq(warehouses.id, warehouseId)).limit(1);
    if (!wh) throw new Error(`Warehouse ${warehouseId} not found`);

    const result = {
      warehouseId: wh.id,
      warehouseCode: wh.code,
      synced: 0,
      skipped: 0,
      errors: [] as string[],
    };

    if (wh.inventorySourceType === "internal" || wh.inventorySourceType === "manual") {
      result.errors.push(`Warehouse ${wh.code} has source type '${wh.inventorySourceType}'`);
      return result;
    }

    if (wh.inventorySourceType !== "channel") {
      result.errors.push(`Only channel is supported currently (Shopify).`);
      return result;
    }

    try {
      await this.db.update(warehouses)
        .set({ inventorySyncStatus: "syncing", updatedAt: new Date() })
        .where(eq(warehouses.id, warehouseId));

      const config = (wh.inventorySourceConfig as Record<string, any>) || {};
      const channelId = config?.channelId;
      if (!channelId) throw new Error(`No channelId configured for warehouse ${warehouseId}`);

      const [conn] = await this.db.select()
        .from(channelConnections)
        .where(eq(channelConnections.channelId, channelId)).limit(1);

      if (!conn?.shopDomain || !conn?.accessToken) {
        throw new Error(`Shopify credentials missing for channel ${channelId}`);
      }

      const shopifyLocationId = wh.shopifyLocationId;
      const apiVersion = conn.apiVersion || "2024-01";
      const items = new Map<string, number>();
      let pageInfo: string | null = null;
      let hasMore = true;

      while (hasMore) {
        const url: string = pageInfo
          ? `https://${conn.shopDomain}/admin/api/${apiVersion}/inventory_levels.json?page_info=${pageInfo}&limit=250`
          : `https://${conn.shopDomain}/admin/api/${apiVersion}/inventory_levels.json?location_ids=${shopifyLocationId}&limit=250`;

        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": conn.accessToken,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) throw new Error(`Shopify API error: ${response.status} ${response.statusText}`);

        const data = await response.json();
        const levels = data.inventory_levels || [];

        for (const level of levels) {
          items.set(String(level.inventory_item_id), level.available ?? 0);
        }

        const linkHeader: string | null = response.headers.get("Link");
        if (linkHeader?.includes('rel="next"')) {
          const match: RegExpMatchArray | null = linkHeader.match(/<[^>]*page_info=([^>&]*).*?>;\s*rel="next"/);
          pageInfo = match?.[1] || null;
          hasMore = !!pageInfo;
        } else {
          hasMore = false;
        }
      }

      // Ensure a virtual location
      const virtualCode = `${wh.code}-VIRTUAL`;
      const [existingLoc] = await this.db.select()
        .from(warehouseLocations)
        .where(and(eq(warehouseLocations.warehouseId, warehouseId), eq(warehouseLocations.locationType, "3pl_virtual")))
        .limit(1);

      let virtualLocationId = existingLoc?.id;
      if (!virtualLocationId) {
        const [createdLoc] = await this.db.insert(warehouseLocations).values({
          warehouseId,
          code: virtualCode,
          name: `${wh.code} Virtual Inventory`,
          locationType: "3pl_virtual",
          binType: "floor",
          isPickable: 0,
        }).returning();
        virtualLocationId = createdLoc.id;
      }

      const inventoryItemIds = Array.from(items.keys());
      if (inventoryItemIds.length > 0) {
        const variants = await this.db.execute<{ id: number; shopify_inventory_item_id: string; }>(sql`
          SELECT id, shopify_inventory_item_id FROM product_variants
          WHERE shopify_inventory_item_id IN (${sql.join(inventoryItemIds.map(id => sql`${id}`), sql`, `)})
        `);

        const variantMap = new Map(variants.rows.map(v => [v.shopify_inventory_item_id, v.id]));

        for (const [inventoryItemId, qty] of items) {
          const variantId = variantMap.get(inventoryItemId);
          if (!variantId) {
            result.skipped++;
            continue;
          }

          try {
            const currentLevel = await this.storage.getInventoryLevelByLocationAndVariant(virtualLocationId, variantId);
            const oldQty = currentLevel?.variantQty ?? 0;
            const delta = qty - oldQty;

            if (delta !== 0) {
              await this.adjustInventory({
                productVariantId: variantId,
                warehouseLocationId: virtualLocationId,
                qtyDelta: delta,
                reason: `3PL sync (set to ${qty}, delta ${delta > 0 ? "+" : ""}${delta})`,
                allowNegative: true,
              });
            }
            result.synced++;
          } catch (err: any) {
            result.errors.push(`Variant ${variantId}: ${err.message}`);
          }
        }
      }

      await this.db.update(warehouses)
        .set({ inventorySyncStatus: "ok", lastInventorySyncAt: new Date(), updatedAt: new Date() })
        .where(eq(warehouses.id, warehouseId));

    } catch (err: any) {
      await this.db.update(warehouses)
        .set({ inventorySyncStatus: "error", updatedAt: new Date() })
        .where(eq(warehouses.id, warehouseId));
      result.errors.push(err.message);
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // LEDGER — direct transaction logging
  // ---------------------------------------------------------------------------

  async logTransaction(txn: InsertInventoryTransaction): Promise<InventoryTransaction> {
    return this.storage.createInventoryTransaction(txn);
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: transaction-scoped clone
  // ---------------------------------------------------------------------------

  withTx(tx: any): InventoryUseCases {
    // Drizzle transaction handles do not expose their own `.transaction()`
    // method. Inventory operations are intentionally written to always enter
    // `this.db.transaction(...)`, so a transaction-scoped clone needs a small
    // adapter that reuses the caller's open transaction instead of opening a
    // nested/independent one. This keeps compound flows such as replenishment
    // task completion and shipment confirmation atomic with their inventory
    // movement and ledger rows.
    const txDb: DrizzleDb = {
      select: (...args: any[]) => tx.select(...args),
      update: (...args: any[]) => tx.update(...args),
      insert: (...args: any[]) => tx.insert(...args),
      execute: (query: any) => tx.execute(query),
      transaction: async <T>(fn: (innerTx: any) => Promise<T>) => fn(tx),
    };

    const scoped = new InventoryUseCases(
      txDb,
      this.storage,
      this.lotService,
      this.cogsService,
      this.clock
    );
    // Transaction-scoped clones must publish through the same dispatcher as
    // the root service. In particular, deferred post-commit adjustment effects
    // are registered on the clone but the dependency-aware publisher callback
    // is wired onto the root instance during service construction.
    scoped.onChangeCallbacks = this.onChangeCallbacks;
    return scoped;
  }
}

