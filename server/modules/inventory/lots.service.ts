import { CostEvidenceError, lockInventoryCostGraph, recordLotCostContribution } from "./infrastructure/cost-evidence.repository";
import type { OperationalQuantityPosting } from "./infrastructure/operational-quantity-posting";
/**
 * Inventory Lot Service for Echelon WMS.
 *
 * Manages FIFO cost layers (inventory_lots). Each receiving event creates
 * one lot per (variant, location). Lots track individual cost layers for
 * FIFO costing — oldest lots are consumed first on reserve/pick.
 *
 * Relationship to inventory_levels:
 *   inventory_levels = fast aggregate (sum of all lots).
 *   inventory_lots   = per-layer cost detail.
 * Before quantity-ledger activation both are legacy transactional counters.
 * After activation, FIFO owners choose exact lots and the ledger alone derives
 * both projections. Explicit posting contexts below never write either counter.
 *
 * All quantities in variant units.
 */

import { eq, and, sql, asc, desc, gt, inArray } from "drizzle-orm";
import {
  inventoryLots,
  orderItemCosts,
  productVariants,
  inventoryLevels,
} from "@shared/schema";
import type { InventoryLot, InsertInventoryLot } from "@shared/schema";
import { resolveCost } from "./cost-resolver";
import {
  calculateLotPickableOnHand,
  calculateUnreservedLotOnHand,
} from "./domain/inventory.domain";
import { millsToCents, centsToMills } from "@shared/utils/money";
import { AppError, IntegrityError, ValidationError } from "../../../shared/errors";
import { normalizeBuildLotCosts } from "./infrastructure/build.repository";
import { planShipmentLotDepletion, ShipmentLotConflictError, shipmentLotDepletionRequestSchema,
  type ShipmentLotDepletionRequest } from "./domain/shipment-lot-depletion";

export class LotInventoryConflictError extends AppError {
  constructor(code: "LOT_ADJUSTMENT_SHORTFALL" | "LOT_ADJUSTMENT_CONFLICT" | "LOT_TRANSFER_SHORTFALL" | "LOT_TRANSFER_CONFLICT", message: string, context: Record<string, unknown>) {
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

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive safe integer`);
  }
}

function storedUnitCostMills(
  row: { unitCostCents: unknown; unitCostMills?: unknown },
  context: Record<string, unknown>,
): number {
  const unitCostCents = Number(row.unitCostCents);
  if (!Number.isSafeInteger(unitCostCents) || unitCostCents < 0) {
    throw new IntegrityError("Stored order-item unit cost cents are invalid", {
      reason: "order_item_cost_value_invalid",
      ...context,
      unitCostCents: row.unitCostCents,
    });
  }

  if (row.unitCostMills == null) return centsToMills(unitCostCents);
  const unitCostMills = Number(row.unitCostMills);
  if (!Number.isSafeInteger(unitCostMills) || unitCostMills < 0) {
    throw new IntegrityError("Stored order-item unit cost mills are invalid", {
      reason: "order_item_cost_value_invalid",
      ...context,
      unitCostMills: row.unitCostMills,
    });
  }

  // Historical rows were backfilled through a zero default before mills
  // became authoritative. Retain their exact cent value rather than treating
  // a positive cent cost as free inventory.
  return unitCostMills === 0 && unitCostCents > 0
    ? centsToMills(unitCostCents)
    : unitCostMills;
}

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (sql: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

export class InventoryLotService {
  constructor(private readonly db: DrizzleDb) {}

  // ---------------------------------------------------------------------------
  // LOT NUMBER GENERATION
  // ---------------------------------------------------------------------------

  async generateLotNumber(): Promise<string> {
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, "");
    const prefix = `LOT-${datePart}-`;

    // Find the highest existing lot number for today
    const [latest] = await this.db
      .select({ lotNumber: inventoryLots.lotNumber })
      .from(inventoryLots)
      .where(sql`${inventoryLots.lotNumber} LIKE ${prefix + "%"}`)
      .orderBy(sql`${inventoryLots.lotNumber} DESC`)
      .limit(1);

    let seq = 1;
    if (latest) {
      const parts = latest.lotNumber.split("-");
      const lastSeq = parseInt(parts[parts.length - 1], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }

    return `${prefix}${String(seq).padStart(3, "0")}`;
  }

  // ---------------------------------------------------------------------------
  // CREATE LOT (called during receiving)
  // ---------------------------------------------------------------------------

  async createLot(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    unitCostCents: number;
    productCostCents?: number;
    packagingCostCents?: number;
    // Mills (1/100 cent) — authoritative when provided (the receive path passes these,
    // already scaled to the lot's variant unit). Cents inputs are lifted to mills (×100)
    // when mills are absent (manual / case-break callers).
    unitCostMills?: number;
    packagingCostMills?: number;
    landedCostMills?: number;
    receivingOrderId?: number;
    purchaseOrderId?: number;
    inboundShipmentId?: number;
    costProvisional?: number;
    poLineId?: number;
    costSource?: string;
    receivedAt?: Date;
    notes?: string;
    quantityPosting?: OperationalQuantityPosting | null;
  }): Promise<InventoryLot> {
    const lotNumber = await this.generateLotNumber();

    // Cost is tracked in MILLS (1/100 cent) as the source of truth: total = product
    // (po) + packaging + landed. Carrying mills means per-unit × qty (FIFO/valuation)
    // never amplifies cent rounding. The *_cents columns are derived display mirrors
    // (millsToCents, half-up) for UI / GL. Callers pass mills directly (the receive
    // path) or only cents (manual / case-break), in which case we lift cents → mills
    // exactly (× 100).
    const totalUnitCostMills = params.unitCostMills ?? centsToMills(params.unitCostCents);
    const packagingCostMills = params.packagingCostMills ?? centsToMills(params.packagingCostCents ?? 0);
    const landedCostMills = params.landedCostMills ?? 0;
    // PO (product) cost = remainder, so the breakdown always reconciles to total. This
    // also fixes the old double-count: landed used to be derived as (unitCost − product),
    // which counted packaging twice whenever unitCost was the product+packaging blend.
    for (const [name, value] of Object.entries({ totalUnitCostMills, packagingCostMills, landedCostMills })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be nonnegative safe integer mills`);
    }
    const exactProduct = BigInt(totalUnitCostMills) - BigInt(packagingCostMills) - BigInt(landedCostMills);
    if (exactProduct < BigInt(0)) throw new Error("Lot packaging and landed components exceed its all-in total");
    const poUnitCostMills = Number(exactProduct);
    // Derived cent mirrors (display / GL / legacy readers until the COGS/valuation reads move to mills).
    const totalUnitCostCents = millsToCents(totalUnitCostMills);
    const poUnitCostCents = millsToCents(poUnitCostMills);
    const packagingCostCents = millsToCents(packagingCostMills);
    const landedCostCents = millsToCents(landedCostMills);

    const [lot] = await this.db
      .insert(inventoryLots)
      .values({
        lotNumber,
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
        // Cost-layer breakdown: total = product + packaging + landed (all-in), and
        // unit_cost_cents mirrors total so valuation + COGS read the same all-in cost.
        unitCostCents: totalUnitCostCents,
        poUnitCostCents,
        packagingCostCents,
        landedCostCents,
        totalUnitCostCents,
        unitCostMills: totalUnitCostMills,
        poUnitCostMills,
        packagingCostMills,
        landedCostMills,
        totalUnitCostMills,
        qtyReceived: params.qty,
        costSource: params.costSource ?? ((params.poLineId || params.purchaseOrderId) ? "po" : "manual"),
        poLineId: params.poLineId ?? null,
        qtyOnHand: params.quantityPosting ? 0 : params.qty,
        qtyReserved: 0,
        qtyPicked: 0,
        receivedAt: params.receivedAt ?? new Date(),
        receivingOrderId: params.receivingOrderId ?? null,
        purchaseOrderId: params.purchaseOrderId ?? null,
        inboundShipmentId: params.inboundShipmentId ?? null,
        costProvisional: params.costProvisional ?? 0,
        status: "active",
        notes: params.notes ?? null,
      } as any)
      .returning();

    if (params.quantityPosting) await params.quantityPosting.addLot(lot.id, {
      onHand: params.qty, reserved: 0, picked: 0, packed: 0,
    });

    return lot as InventoryLot;
  }

  // ---------------------------------------------------------------------------
  // READ HELPERS
  // ---------------------------------------------------------------------------

  /** All active lots across all variants/locations, ordered FIFO. */
  async getActiveLots(limit: number = 500): Promise<InventoryLot[]> {
    return this.db
      .select()
      .from(inventoryLots)
      .where(eq(inventoryLots.status, "active"))
      .orderBy(asc(inventoryLots.receivedAt))
      .limit(limit);
  }

  /** Active lots at a specific location for a variant, ordered FIFO. */
  async getLotsAtLocation(
    productVariantId: number,
    warehouseLocationId: number,
  ): Promise<InventoryLot[]> {
    return this.db
      .select()
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, productVariantId),
          eq(inventoryLots.warehouseLocationId, warehouseLocationId),
          eq(inventoryLots.status, "active"),
        ),
      )
      .orderBy(asc(inventoryLots.receivedAt), asc(inventoryLots.id));
  }

  /** All active lots for a variant across all locations, ordered FIFO. */
  async getLotsByVariant(productVariantId: number): Promise<InventoryLot[]> {
    return this.db
      .select()
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, productVariantId),
          eq(inventoryLots.status, "active"),
        ),
      )
      .orderBy(asc(inventoryLots.receivedAt));
  }

  /** Get a single lot by ID. */
  async getLot(lotId: number): Promise<InventoryLot | null> {
    const [row] = await this.db
      .select()
      .from(inventoryLots)
      .where(eq(inventoryLots.id, lotId))
      .limit(1);
    return row ?? null;
  }

  // ---------------------------------------------------------------------------
  // FIFO RESERVE (order allocation)
  // ---------------------------------------------------------------------------

  /**
   * Reserve qty from lots at a location, consuming oldest first (FIFO).
   * Increments qtyReserved on lots. Does NOT touch qtyOnHand.
   * Returns the lots touched and quantities reserved from each.
   */
  async reserveFromLots(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
  }): Promise<Array<{ lotId: number; qty: number; unitCostCents: number }>> {
    const lots = await this.getLotsAtLocation(
      params.productVariantId,
      params.warehouseLocationId,
    );

    let remaining = params.qty;
    const allocations: Array<{ lotId: number; qty: number; unitCostCents: number }> = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      const available = calculateUnreservedLotOnHand(lot);
      if (available <= 0) continue;

      const take = Math.min(available, remaining);
      allocations.push({ lotId: lot.id, qty: take, unitCostCents: lot.unitCostCents });
      remaining -= take;
    }

    if (allocations.length > 0) {
      const updates = allocations.map(a => ({ lotId: a.lotId, qty: a.qty }));
      await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(updates)}::jsonb) AS x("lotId" int, qty int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_reserved = il.qty_reserved + u.qty
        FROM updates u
        WHERE il.id = u."lotId"
      `);
    }

    if (remaining > 0) {
      // Partial reserve — caller may handle (inventoryCore already checks aggregate availability)
    }

    return allocations;
  }

  // ---------------------------------------------------------------------------
  // FIFO RELEASE (cancel/unreserve)
  // ---------------------------------------------------------------------------

  /**
   * Release reserved qty from lots at a location, releasing from newest first
   * (reverse FIFO — release the most recently reserved lots first).
   */
  async releaseFromLots(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
  }): Promise<void> {
    // Get lots with reservations, newest first for release
    const lots = await this.db
      .select()
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, params.productVariantId),
          eq(inventoryLots.warehouseLocationId, params.warehouseLocationId),
          eq(inventoryLots.status, "active"),
          gt(inventoryLots.qtyReserved, 0),
        ),
      )
      .orderBy(sql`${inventoryLots.receivedAt} DESC`); // Newest first for release

    let remaining = params.qty;
    const releases: Array<{ lotId: number; qty: number }> = [];
    for (const lot of lots) {
      if (remaining <= 0) break;

      const release = Math.min(lot.qtyReserved, remaining);
      releases.push({ lotId: lot.id, qty: release });
      remaining -= release;
    }

    if (releases.length > 0) {
      await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(releases)}::jsonb) AS x("lotId" int, qty int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_reserved = il.qty_reserved - u.qty
        FROM updates u
        WHERE il.id = u."lotId"
      `);
    }
  }

  // ---------------------------------------------------------------------------
  // FIFO PICK (consume from reserved lots, create order_item_costs)
  // ---------------------------------------------------------------------------

  async getOrderItemPickedCostQuantity(params: {
    orderId: number;
    orderItemId: number;
    productVariantId: number;
  }): Promise<number> {
    assertPositiveSafeInteger(params.orderId, "orderId");
    assertPositiveSafeInteger(params.orderItemId, "orderItemId");
    assertPositiveSafeInteger(params.productVariantId, "productVariantId");
    const rows = await this.db
      .select({ qty: orderItemCosts.qty, productVariantId: orderItemCosts.productVariantId })
      .from(orderItemCosts)
      .where(and(
        eq(orderItemCosts.orderId, params.orderId),
        eq(orderItemCosts.orderItemId, params.orderItemId),
      ));
    return rows.reduce((sum: number, row: any) => {
      const quantity = Number(row.qty);
      const productVariantId = Number(row.productVariantId);
      if (!Number.isSafeInteger(quantity) || quantity <= 0
        || productVariantId !== params.productVariantId) {
        throw new IntegrityError("Order-item cost custody is invalid", {
          reason: "order_item_pick_cost_custody_invalid",
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          expectedProductVariantId: params.productVariantId,
          actualProductVariantId: row.productVariantId,
          quantity: row.qty,
        });
      }
      const next = sum + quantity;
      if (!Number.isSafeInteger(next)) {
        throw new IntegrityError("Order-item cost custody exceeds the supported quantity range", {
          orderId: params.orderId,
          orderItemId: params.orderItemId,
        });
      }
      return next;
    }, 0);
  }

  /**
   * Pick qty from reserved lots at a location (FIFO).
   * Decrements qtyOnHand + qtyReserved, increments qtyPicked.
   * Creates order_item_costs for COGS tracking.
   * Returns cost allocations for the pick.
   */
  async pickFromLots(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    /**
     * When supplied by the picker transaction, existing COGS must exactly
     * match the WMS quantity that was already picked. A matching value permits
     * this call to append the next physical pick delta.
     */
    expectedExistingCostQuantity?: number;
    // Replacement packages consume a second physical unit but must not write a
    // second customer-order COGS row. They also may not consume another order's
    // reservation while finding live stock.
    recordOrderItemCosts?: boolean;
    allowReservedStock?: boolean;
  }): Promise<Array<{ lotId: number; qty: number; unitCostCents: number }>> {
    assertPositiveSafeInteger(params.productVariantId, "productVariantId");
    assertPositiveSafeInteger(params.warehouseLocationId, "warehouseLocationId");
    assertPositiveSafeInteger(params.qty, "qty");
    assertPositiveSafeInteger(params.orderId, "orderId");
    if (params.orderItemId !== undefined) {
      assertPositiveSafeInteger(params.orderItemId, "orderItemId");
    }
    if (params.expectedExistingCostQuantity !== undefined
      && (!Number.isSafeInteger(params.expectedExistingCostQuantity)
        || params.expectedExistingCostQuantity < 0)) {
      throw new ValidationError("expectedExistingCostQuantity must be a non-negative safe integer");
    }

    let existingCostLotIds: number[] = [];

    // Legacy callers without an expected quantity retain the original retry
    // behavior. Picker progress supplies the expected cumulative COGS quantity,
    // which proves prior custody before appending the next delta.
    if (params.recordOrderItemCosts !== false && params.orderItemId) {
      const existing = await this.db
        .select({
          inventoryLotId: orderItemCosts.inventoryLotId,
          productVariantId: orderItemCosts.productVariantId,
          qty: orderItemCosts.qty,
          unitCostCents: orderItemCosts.unitCostCents,
        })
        .from(orderItemCosts)
        .where(
          and(
            eq(orderItemCosts.orderId, params.orderId),
            eq(orderItemCosts.orderItemId, params.orderItemId),
          ),
        );

      if (params.expectedExistingCostQuantity === undefined && existing.length > 0) {
        return existing.map((e: any) => ({
          lotId: e.inventoryLotId,
          qty: e.qty,
          unitCostCents: e.unitCostCents,
        }));
      }
      if (params.expectedExistingCostQuantity !== undefined) {
        const existingQuantity = existing.reduce((sum: number, row: any) => {
          const quantity = Number(row.qty);
          const inventoryLotId = Number(row.inventoryLotId);
          if (!Number.isSafeInteger(quantity) || quantity <= 0
            || !Number.isSafeInteger(inventoryLotId) || inventoryLotId <= 0
            || Number(row.productVariantId) !== params.productVariantId) {
            throw new IntegrityError("Existing order-item cost quantity is invalid", {
              orderId: params.orderId,
              orderItemId: params.orderItemId,
              quantity: row.qty,
              inventoryLotId: row.inventoryLotId,
              expectedProductVariantId: params.productVariantId,
              actualProductVariantId: row.productVariantId,
            });
          }
          return sum + quantity;
        }, 0);
        if (!Number.isSafeInteger(existingQuantity)
          || existingQuantity !== params.expectedExistingCostQuantity) {
          throw new IntegrityError("WMS pick progress does not match its existing lot-cost custody", {
            reason: "order_item_pick_cost_custody_mismatch",
            orderId: params.orderId,
            orderItemId: params.orderItemId,
            expectedExistingCostQuantity: params.expectedExistingCostQuantity,
            actualExistingCostQuantity: existingQuantity,
          });
        }
        existingCostLotIds = existing.map((row: any) => Number(row.inventoryLotId));
      }
    }

    const lots = await this.db
      .select()
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, params.productVariantId),
          eq(inventoryLots.warehouseLocationId, params.warehouseLocationId),
          eq(inventoryLots.status, "active"),
        ),
      )
      .orderBy(asc(inventoryLots.receivedAt)); // FIFO

    if (existingCostLotIds.length > 0) {
      const targetLotIds = new Set(lots.map((lot: InventoryLot) => Number(lot.id)));
      const mismatchedLotIds = [...new Set(existingCostLotIds.filter((lotId) => !targetLotIds.has(lotId)))];
      if (mismatchedLotIds.length > 0) {
        throw new IntegrityError("Existing order-item cost custody belongs to a different inventory location", {
          reason: "order_item_pick_cost_location_mismatch",
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          mismatchedInventoryLotIds: mismatchedLotIds,
        });
      }
    }

    let remaining = params.qty;
    const costAllocations: Array<{ lotId: number; qty: number; unitCostCents: number }> = [];
    const pickUpdates: Array<{ lotId: number; take: number; fromReserved: number }> = [];
    const newCosts: Array<any> = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      // Normal picks consume this order's reservation first. System replacement
      // picks have no reservation of their own, so they may use unreserved stock
      // only and can never steal a reservation held by another order.
      const totalPickable = calculateLotPickableOnHand(
        lot,
        params.allowReservedStock !== false,
      );
      if (totalPickable <= 0) continue;

      const take = Math.min(totalPickable, remaining);
      const fromReserved = params.allowReservedStock === false
        ? 0
        : Math.min(Math.max(0, lot.qtyReserved), take);

      pickUpdates.push({ lotId: lot.id, take, fromReserved });

      // Record cost for this lot allocation
      if (params.recordOrderItemCosts !== false && params.orderItemId) {
        // COGS in MILLS (lot.unitCostMills mirrors the lot's total per-variant-unit
        // cost). cents columns are derived mirrors (half-up), so the period COGS stays
        // exact when summed in mills (take × per-unit-mills, rounded once at display).
        const lotUnitMills = storedUnitCostMills(lot as any, {
          inventoryLotId: lot.id,
          productVariantId: params.productVariantId,
        });
        const totalCostMills = safeMillsNumber(
          BigInt(take) * BigInt(lotUnitMills),
          "orderItemCost.totalCostMills",
        );
        newCosts.push({
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          inventoryLotId: lot.id,
          productVariantId: params.productVariantId,
          qty: take,
          unitCostCents: millsToCents(lotUnitMills),
          totalCostCents: millsToCents(totalCostMills),
          unitCostMills: lotUnitMills,
          totalCostMills,
        });
      }

      costAllocations.push({ lotId: lot.id, qty: take, unitCostCents: lot.unitCostCents });
      remaining -= take;
    }

    if (remaining > 0) {
      throw new IntegrityError(
        `Insufficient FIFO lot inventory for variant ${params.productVariantId} at location ${params.warehouseLocationId}: ` +
        `required ${params.qty}, available ${params.qty - remaining}.`,
      );
    }

    if (pickUpdates.length > 0) {
      await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(pickUpdates)}::jsonb) AS x("lotId" int, take int, "fromReserved" int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_on_hand = il.qty_on_hand - u.take,
            qty_reserved = il.qty_reserved - u."fromReserved",
            qty_picked = il.qty_picked + u.take
        FROM updates u
        WHERE il.id = u."lotId"
      `);
    }

    if (newCosts.length > 0) {
      await this.db.insert(orderItemCosts).values(newCosts);
    }

    return costAllocations;
  }

  // ---------------------------------------------------------------------------
  // UNPICK (reverse a pick — restore lot qty, delete COGS rows)
  // ---------------------------------------------------------------------------

  /**
   * Reverse a pick for an order item. Restores qtyOnHand / qtyPicked on the
   * lots that were consumed, and deletes the corresponding order_item_costs
   * rows so COGS is not double-counted.
   *
   * Returns the total cost cents that were reversed (for audit).
   */
  async unpickFromLots(params: {
    orderId: number;
    orderItemId: number;
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
  }): Promise<{ reversedCostCents: number }> {
    assertPositiveSafeInteger(params.orderId, "orderId");
    assertPositiveSafeInteger(params.orderItemId, "orderItemId");
    assertPositiveSafeInteger(params.productVariantId, "productVariantId");
    assertPositiveSafeInteger(params.warehouseLocationId, "warehouseLocationId");
    assertPositiveSafeInteger(params.qty, "qty");

    // Find the COGS rows written by the original pick
    const cogsRows = await this.db
      .select()
      .from(orderItemCosts)
      .where(
        and(
          eq(orderItemCosts.orderId, params.orderId),
          eq(orderItemCosts.orderItemId, params.orderItemId),
        ),
      )
      .orderBy(desc(orderItemCosts.id))
      .for("update");

    if (cogsRows.length === 0) {
      return { reversedCostCents: 0 };
    }

    let reversedCostMills = BigInt(0);
    const restoreByLot = new Map<number, number>();
    const fullCostIds: number[] = [];
    let partialCost:
      | { id: number; originalQty: number; remainingQty: number; unitCostMills: number }
      | null = null;

    // Reverse the newest pick allocations first. This preserves FIFO ownership
    // for the quantity that remains picked and supports repeated incremental
    // picks against the same order item and lot.
    let remaining = params.qty;
    for (const row of cogsRows) {
      if (remaining <= 0) break;
      const rowQuantity = Number(row.qty);
      const costId = Number(row.id);
      const lotId = Number(row.inventoryLotId);
      const productVariantId = Number(row.productVariantId);
      if (!Number.isSafeInteger(rowQuantity) || rowQuantity <= 0
        || !Number.isSafeInteger(costId) || costId <= 0
        || !Number.isSafeInteger(lotId) || lotId <= 0
        || productVariantId !== params.productVariantId) {
        throw new IntegrityError("Order-item cost custody is invalid for unpick", {
          reason: "order_item_unpick_cost_custody_invalid",
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          orderItemCostId: row.id,
          rowQuantity: row.qty,
          inventoryLotId: row.inventoryLotId,
          expectedProductVariantId: params.productVariantId,
          actualProductVariantId: row.productVariantId,
        });
      }
      const restore = Math.min(rowQuantity, remaining);
      restoreByLot.set(lotId, (restoreByLot.get(lotId) ?? 0) + restore);
      const unitCostMills = storedUnitCostMills(row, {
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        orderItemCostId: costId,
      });
      reversedCostMills += BigInt(restore) * BigInt(unitCostMills);
      if (restore === rowQuantity) {
        fullCostIds.push(costId);
      } else {
        partialCost = {
          id: costId,
          originalQty: rowQuantity,
          remainingQty: rowQuantity - restore,
          unitCostMills,
        };
      }
      remaining -= restore;
    }
    if (remaining > 0) {
      throw new IntegrityError("Order item does not have enough exact lot-cost custody to unpick", {
        reason: "order_item_unpick_cost_custody_shortfall",
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        requestedQuantity: params.qty,
        availableQuantity: params.qty - remaining,
      });
    }

    const restoreUpdates = [...restoreByLot.entries()].map(([lotId, restore]) => ({ lotId, restore }));

    // Restore lot quantities: move units from picked back to on-hand
    if (restoreUpdates.length > 0) {
      const restored = await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(restoreUpdates)}::jsonb) AS x("lotId" int, restore int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_on_hand = il.qty_on_hand + u.restore,
            qty_picked = il.qty_picked - u.restore,
            status = 'active'
        FROM updates u
        WHERE il.id = u."lotId"
          AND il.product_variant_id = ${params.productVariantId}
          AND il.warehouse_location_id = ${params.warehouseLocationId}
          AND il.qty_picked >= u.restore
        RETURNING il.id
      `);
      if (!Array.isArray(restored?.rows) || restored.rows.length !== restoreUpdates.length) {
        throw new IntegrityError("Exact picked lot custody changed while the unpick was applied", {
          reason: "order_item_unpick_lot_custody_conflict",
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          expectedLots: restoreUpdates.length,
          updatedLots: Array.isArray(restored?.rows) ? restored.rows.length : null,
        });
      }
    }

    if (fullCostIds.length > 0) {
      await this.db
        .delete(orderItemCosts)
        .where(inArray(orderItemCosts.id, fullCostIds));
    }
    if (partialCost) {
      const totalCostMills = safeMillsNumber(
        BigInt(partialCost.remainingQty) * BigInt(partialCost.unitCostMills),
        "orderItemCost.totalCostMills",
      );
      const updated = await this.db
        .update(orderItemCosts)
        .set({
          qty: partialCost.remainingQty,
          totalCostMills,
          totalCostCents: millsToCents(totalCostMills),
        })
        .where(and(
          eq(orderItemCosts.id, partialCost.id),
          eq(orderItemCosts.qty, partialCost.originalQty),
        ))
        .returning({ id: orderItemCosts.id });
      if (updated.length !== 1) {
        throw new IntegrityError("Order-item cost custody changed while the unpick was applied", {
          reason: "order_item_unpick_cost_custody_conflict",
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          orderItemCostId: partialCost.id,
        });
      }
    }

    const reversedCostCents = millsToCents(
      safeMillsNumber(reversedCostMills, "unpick.reversedCostMills"),
    );
    return { reversedCostCents };
  }

  // ---------------------------------------------------------------------------
  // SHIP (apply the aggregate owner's exact picked/on-hand bucket split)
  // ---------------------------------------------------------------------------

  /** Caller owns the transaction and locked level; failures MUST roll it back. */
  async shipFromLots(input: ShipmentLotDepletionRequest): Promise<void> {
    const parsed = shipmentLotDepletionRequestSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError("Invalid shipment bucket request.");
    const params = parsed.data;
    const maxLots = 10_000;
    // Lock by primary key, then plan FIFO in memory. Never infer a second bucket
    // split from lot counters after the aggregate owner has selected its split.
    const lots = await this.db
      .select({ id: inventoryLots.id, qtyOnHand: inventoryLots.qtyOnHand,
        qtyReserved: inventoryLots.qtyReserved, qtyPicked: inventoryLots.qtyPicked,
        receivedAt: inventoryLots.receivedAt, status: inventoryLots.status })
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, params.productVariantId),
          eq(inventoryLots.warehouseLocationId, params.warehouseLocationId),
          // Empty historical lots cannot supply any bucket. Keep negative rows
          // in the census so invalid current balances fail validation.
          sql`(${inventoryLots.qtyOnHand} <> 0 OR ${inventoryLots.qtyReserved} <> 0 OR ${inventoryLots.qtyPicked} <> 0)`,
        ),
      )
      .orderBy(asc(inventoryLots.id))
      .limit(maxLots + 1)
      .for("update");
    if (lots.length > maxLots) {
      throw new ShipmentLotConflictError("LOT_SHIPMENT_CENSUS_LIMIT",
        "Shipment lot position exceeds its complete bounded census.", {
          productVariantId: params.productVariantId, warehouseLocationId: params.warehouseLocationId,
        });
    }
    const plan = planShipmentLotDepletion(params, lots);
    const updated = await this.db.execute(sql`
      WITH updates AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(plan)}::jsonb)
          AS x("lotId" int, "fromPicked" int, "fromOnHand" int, "reservedToRelease" int,
            "expectedOnHand" int, "expectedReserved" int, "expectedPicked" int, "expectedStatus" text)
      )
      UPDATE inventory.inventory_lots AS il
      SET qty_on_hand = il.qty_on_hand - u."fromOnHand",
          qty_reserved = il.qty_reserved - u."reservedToRelease",
          qty_picked = il.qty_picked - u."fromPicked",
          status = CASE WHEN il.qty_on_hand - u."fromOnHand" = 0
            AND il.qty_reserved - u."reservedToRelease" = 0
            AND il.qty_picked - u."fromPicked" = 0 THEN 'depleted' ELSE il.status END
      FROM updates u
      WHERE il.id = u."lotId" AND il.product_variant_id = ${params.productVariantId}
        AND il.warehouse_location_id = ${params.warehouseLocationId}
        AND il.qty_on_hand = u."expectedOnHand" AND il.qty_reserved = u."expectedReserved"
        AND il.qty_picked = u."expectedPicked" AND il.status = u."expectedStatus"
      RETURNING il.id
    `);
    if (updated.rows.length !== plan.length) {
      throw new ShipmentLotConflictError("LOT_SHIPMENT_CONFLICT",
        "A lot changed during shipment posting; the complete shipment must roll back.", {
          productVariantId: params.productVariantId, warehouseLocationId: params.warehouseLocationId,
        });
    }
  }

  // ---------------------------------------------------------------------------
  // ADJUST (cycle count, manual — oldest first)
  // ---------------------------------------------------------------------------

  /**
   * Adjust lot quantities. For negative adjustments, consumes from oldest lots
   * first. For positive adjustments, creates a new adjustment lot.
   */
  async adjustLots(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reservedQtyDelta?: number;
    unitCostCents?: number;
    notes?: string;
    quantityPosting?: OperationalQuantityPosting | null;
  }): Promise<{
    consumedLots: Array<{ lotId: number; qty: number }>;
    consumedCostCents: number;
    consumedQty: number;
    consumedPoCostMills: bigint;
    consumedPackagingCostMills: bigint;
    consumedLandedCostMills: bigint;
    consumedCostProvisional: boolean;
  }> {
    if (params.reservedQtyDelta !== undefined && params.reservedQtyDelta > 0) {
      throw new Error("adjustLots only supports releasing reserved quantity during adjustments");
    }

    if (params.qtyDelta > 0) {
      const resolved = await resolveCost(
        this.db,
        params.productVariantId,
        params.unitCostCents,
      );
      await this.createLot({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
        qty: params.qtyDelta,
        unitCostCents: resolved.costCents,
        costProvisional: resolved.provisional ? 1 : 0,
        notes: params.notes ?? "Manual adjustment",
        quantityPosting: params.quantityPosting,
      });
      return {
        consumedLots: [],
        consumedCostCents: 0,
        consumedQty: 0,
        consumedPoCostMills: BigInt(0),
        consumedPackagingCostMills: BigInt(0),
        consumedLandedCostMills: BigInt(0),
        consumedCostProvisional: false,
      };
    }

    // Negative adjustment: consume from oldest lots first, tracking total cost
    const lots = await this.getLotsAtLocation(
      params.productVariantId,
      params.warehouseLocationId,
    );

    let remaining = Math.abs(params.qtyDelta);
    let reservedReleaseRemaining = Math.abs(params.reservedQtyDelta ?? 0);
    let consumedCostCents = 0;
    let consumedQty = 0;
    let consumedPoCostMills = BigInt(0);
    let consumedPackagingCostMills = BigInt(0);
    let consumedLandedCostMills = BigInt(0);
    let consumedCostProvisional = false;
    const adjustUpdates: Array<{ lotId: number; take: number; reservedRelease: number }> = [];
    for (const lot of lots) {
      if (remaining <= 0) break;

      const unreservedAvailable = calculateUnreservedLotOnHand(lot);
      const unreservedTake = Math.min(unreservedAvailable, remaining);
      const reservedTake = Math.min(
        Math.max(0, lot.qtyReserved),
        remaining - unreservedTake,
        reservedReleaseRemaining,
      );
      const take = unreservedTake + reservedTake;
      if (take <= 0) continue;

      const normalizedCosts = normalizeBuildLotCosts({
        total_unit_cost_mills: lot.totalUnitCostMills,
        unit_cost_mills: lot.unitCostMills,
        total_unit_cost_cents: lot.totalUnitCostCents,
        unit_cost_cents: lot.unitCostCents,
        po_unit_cost_mills: lot.poUnitCostMills,
        po_unit_cost_cents: lot.poUnitCostCents,
        packaging_cost_mills: lot.packagingCostMills,
        packaging_cost_cents: lot.packagingCostCents,
        landed_cost_mills: lot.landedCostMills,
        landed_cost_cents: lot.landedCostCents,
      });
      adjustUpdates.push({ lotId: lot.id, take, reservedRelease: reservedTake });
      consumedCostCents += take * lot.unitCostCents;
      consumedQty += take;
      consumedPoCostMills += normalizedCosts.poMills * BigInt(take);
      consumedPackagingCostMills += normalizedCosts.packagingMills * BigInt(take);
      consumedLandedCostMills += normalizedCosts.landedMills * BigInt(take);
      consumedCostProvisional ||= lot.costProvisional === 1;
      remaining -= take;
      reservedReleaseRemaining -= reservedTake;
    }

    if (remaining !== 0 || reservedReleaseRemaining !== 0) {
      throw new LotInventoryConflictError(
        "LOT_ADJUSTMENT_SHORTFALL",
        `FIFO lot inventory cannot satisfy adjustment of ${Math.abs(params.qtyDelta)} unit(s).`,
        {
          productVariantId: params.productVariantId,
          warehouseLocationId: params.warehouseLocationId,
          requestedQty: Math.abs(params.qtyDelta),
          attributableQty: Math.abs(params.qtyDelta) - remaining,
          requestedReservedRelease: Math.abs(params.reservedQtyDelta ?? 0),
          attributableReservedRelease: Math.abs(params.reservedQtyDelta ?? 0) - reservedReleaseRemaining,
        },
      );
    }

    if (params.quantityPosting) {
      for (const update of adjustUpdates) await params.quantityPosting.addLot(update.lotId, {
        onHand: -update.take, reserved: -update.reservedRelease, picked: 0, packed: 0,
      });
    } else if (adjustUpdates.length > 0) {
      const updated = await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(adjustUpdates)}::jsonb) AS x("lotId" int, take int, "reservedRelease" int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_on_hand = il.qty_on_hand - u.take,
            qty_reserved = il.qty_reserved - u."reservedRelease",
            status = CASE WHEN (il.qty_on_hand - u.take) = 0 AND (il.qty_reserved - u."reservedRelease") = 0 AND il.qty_picked = 0 THEN 'depleted' ELSE il.status END
        FROM updates u
        WHERE il.id = u."lotId"
          AND il.qty_on_hand >= u.take
          AND il.qty_reserved >= u."reservedRelease"
          AND il.qty_on_hand - il.qty_reserved >= u.take - u."reservedRelease"
        RETURNING il.id
      `);
      if ((updated.rows ?? []).length !== adjustUpdates.length) {
        throw new LotInventoryConflictError(
          "LOT_ADJUSTMENT_CONFLICT",
          "A FIFO lot changed while its inventory adjustment was being applied.",
          {
            productVariantId: params.productVariantId,
            warehouseLocationId: params.warehouseLocationId,
          },
        );
      }
    }

    return {
      consumedLots: adjustUpdates.map((update) => ({ lotId: update.lotId, qty: update.take })),
      consumedCostCents,
      consumedQty,
      consumedPoCostMills,
      consumedPackagingCostMills,
      consumedLandedCostMills,
      consumedCostProvisional,
    };
  }

  // ---------------------------------------------------------------------------
  // TRANSFER (move lot to new location)
  // ---------------------------------------------------------------------------

  /**
   * Transfer qty from lots at source to destination, preserving individual
   * FIFO cost layers. Each consumed source lot produces a separate destination
   * lot with the same cost and receivedAt (FIFO identity preserved).
   */
  async transferLots(params: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    qty: number;
    notes?: string;
    actorId?: string;
    occurredAt?: Date;
    operationKey?: string;
    quantityPosting?: OperationalQuantityPosting | null;
  }): Promise<void> {
    for (const field of ["productVariantId", "fromLocationId", "toLocationId", "qty"] as const) {
      if (!Number.isInteger(params[field]) || params[field] <= 0 || params[field] > 2_147_483_647) {
        throw new CostEvidenceError("COST_TRANSFER_INPUT_INVALID", `${field} must be a positive PostgreSQL integer.`, { field });
      }
    }
    if (!params.actorId?.trim() || !(params.occurredAt instanceof Date) || !Number.isFinite(params.occurredAt.getTime())) {
      throw new CostEvidenceError("COST_TRANSFER_AUDIT_REQUIRED", "A lot transfer requires its owning actor and operation time.");
    }
    if (params.fromLocationId === params.toLocationId || (params.operationKey !== undefined && !params.operationKey.trim())) {
      throw new CostEvidenceError("COST_TRANSFER_INPUT_INVALID", "A lot transfer requires distinct locations and a nonblank operation key when supplied.");
    }
    // The physical use-case takes the same graph lock before location locks;
    // repeat it here to protect direct transactional callers before cost reads.
    await lockInventoryCostGraph(this.db);
    const lots = await this.getLotsAtLocation(
      params.productVariantId,
      params.fromLocationId,
    );

    let remaining = params.qty;
    const layers: Array<{
      lotId: number;
      take: number;
      unitCostCents: number;
      receivedAt: Date;
      purchaseOrderId: number | null;
      receivingOrderId: number | null;
      inboundShipmentId: number | null;
      costProvisional: number;
      poLineId: number | null;
      costSource: string | null;
      totalUnitCostMills: number;
      packagingCostMills: number;
      landedCostMills: number;
    }> = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      const available = calculateUnreservedLotOnHand(lot);
      if (available <= 0) continue;

      const take = Math.min(available, remaining);
      const normalizedCosts = normalizeBuildLotCosts({
        total_unit_cost_mills: lot.totalUnitCostMills,
        unit_cost_mills: lot.unitCostMills,
        total_unit_cost_cents: lot.totalUnitCostCents,
        unit_cost_cents: lot.unitCostCents,
        po_unit_cost_mills: lot.poUnitCostMills,
        po_unit_cost_cents: lot.poUnitCostCents,
        packaging_cost_mills: lot.packagingCostMills,
        packaging_cost_cents: lot.packagingCostCents,
        landed_cost_mills: lot.landedCostMills,
        landed_cost_cents: lot.landedCostCents,
      });
      layers.push({
        lotId: lot.id,
        take,
        unitCostCents: lot.unitCostCents,
        receivedAt: lot.receivedAt,
        purchaseOrderId: lot.purchaseOrderId ?? null,
        receivingOrderId: lot.receivingOrderId ?? null,
        inboundShipmentId: lot.inboundShipmentId ?? null,
        costProvisional: (lot as any).costProvisional ?? 0,
        poLineId: lot.poLineId ?? null,
        costSource: lot.costSource ?? null,
        totalUnitCostMills: safeMillsNumber(normalizedCosts.totalMills, "transfer.totalUnitCostMills"),
        packagingCostMills: safeMillsNumber(normalizedCosts.packagingMills, "transfer.packagingCostMills"),
        landedCostMills: safeMillsNumber(normalizedCosts.landedMills, "transfer.landedCostMills"),
      });
      remaining -= take;
    }

    if (remaining !== 0) {
      throw new LotInventoryConflictError(
        "LOT_TRANSFER_SHORTFALL",
        `FIFO lot inventory cannot satisfy transfer of ${params.qty} unreserved unit(s).`,
        {
          productVariantId: params.productVariantId,
          fromLocationId: params.fromLocationId,
          toLocationId: params.toLocationId,
          requestedQty: params.qty,
          attributableQty: params.qty - remaining,
        },
      );
    }

    // Decrement source lots
    const transferUpdates = layers.map(l => ({ lotId: l.lotId, take: l.take }));
    if (params.quantityPosting) {
      for (const update of transferUpdates) await params.quantityPosting.addLot(update.lotId, {
        onHand: -update.take, reserved: 0, picked: 0, packed: 0,
      });
    } else {
    const updated = await this.db.execute(sql`
      WITH updates AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(transferUpdates)}::jsonb) AS x("lotId" int, take int)
      )
      UPDATE inventory.inventory_lots AS il
      SET qty_on_hand = il.qty_on_hand - u.take,
          status = CASE WHEN (il.qty_on_hand - u.take) = 0 AND il.qty_reserved = 0 AND il.qty_picked = 0 THEN 'depleted' ELSE il.status END
      FROM updates u
      WHERE il.id = u."lotId"
        AND il.qty_on_hand - il.qty_reserved >= u.take
      RETURNING il.id
    `);
    if ((updated.rows ?? []).length !== transferUpdates.length) {
      throw new LotInventoryConflictError(
        "LOT_TRANSFER_CONFLICT",
        "A FIFO lot changed while its unreserved stock was being transferred.",
        {
          productVariantId: params.productVariantId,
          fromLocationId: params.fromLocationId,
          toLocationId: params.toLocationId,
        },
      );
    }
    }

    // Create one destination lot per source layer — cost identity preserved
    for (const layer of layers) {
      const outputLot = await this.createLot({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.toLocationId,
        qty: layer.take,
        unitCostCents: layer.unitCostCents,
        unitCostMills: layer.totalUnitCostMills,
        packagingCostMills: layer.packagingCostMills,
        landedCostMills: layer.landedCostMills,
        purchaseOrderId: layer.purchaseOrderId ?? undefined,
        receivingOrderId: layer.receivingOrderId ?? undefined,
        inboundShipmentId: layer.inboundShipmentId ?? undefined,
        poLineId: layer.poLineId ?? undefined,
        costSource: layer.costSource ?? undefined,
        costProvisional: layer.costProvisional,
        receivedAt: layer.receivedAt,
        notes: params.notes ?? "Transfer",
        quantityPosting: params.quantityPosting,
      });
      await recordLotCostContribution(this.db, {
        sourceLotId: layer.lotId,
        outputLotId: outputLot.id,
        sourceQty: layer.take,
        outputQty: layer.take,
        operationKind: "transfer",
        operationKey: params.operationKey ?? `inventory_transfer:${layer.lotId}:${outputLot.id}`,
      }, params.actorId, params.occurredAt);
    }
  }

  // ---------------------------------------------------------------------------
  // VARIANT COST UPDATES
  // ---------------------------------------------------------------------------

  /**
   * Update product variant cost fields after a receipt.
   * - lastCostCents: from the receipt
   * - avgCostCents: weighted average across all active lots
   */
  async updateVariantCosts(
    productVariantId: number,
    receiptCostCents: number,
  ): Promise<void> {
    // Compute weighted average from all active lots for this variant
    const [agg] = await this.db
      .select({
        totalQty: sql<number>`COALESCE(SUM(${inventoryLots.qtyOnHand}), 0)`,
        totalCost: sql<number>`COALESCE(SUM(${inventoryLots.qtyOnHand} * ${inventoryLots.unitCostCents}), 0)`,
      })
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, productVariantId),
          eq(inventoryLots.status, "active"),
        ),
      );

    const avgCost = agg.totalQty > 0 ? Math.round(agg.totalCost / agg.totalQty) : receiptCostCents;

    await this.db
      .update(productVariants)
      .set({
        lastCostCents: receiptCostCents,
        avgCostCents: avgCost,
        updatedAt: new Date(),
      })
      .where(eq(productVariants.id, productVariantId));
  }

  // ---------------------------------------------------------------------------
  // INVENTORY VALUATION
  // ---------------------------------------------------------------------------

  /**
   * Compute inventory valuation across all active lots.
   * Returns per-variant totals and grand total.
   */
  async getInventoryValuation(): Promise<{
    total: { qty: number; valueCents: number; zeroCostQty: number; provisionalQty: number };
    byVariant: Array<{
      productVariantId: number;
      sku: string | null;
      qty: number;
      avgCostCents: number;
      valueCents: number;
      zeroCostQty: number;
      provisionalQty: number;
    }>;
  }> {
    const rows = await this.db
      .select({
        productVariantId: inventoryLots.productVariantId,
        sku: productVariants.sku,
        qty: sql<number>`SUM(${inventoryLots.qtyOnHand})`,
        totalCost: sql<number>`SUM(${inventoryLots.qtyOnHand} * COALESCE(NULLIF(${inventoryLots.totalUnitCostCents}, 0), ${inventoryLots.unitCostCents}, 0))`,
        zeroCostQty: sql<number>`SUM(CASE WHEN COALESCE(NULLIF(${inventoryLots.totalUnitCostCents}, 0), ${inventoryLots.unitCostCents}, 0) = 0 THEN ${inventoryLots.qtyOnHand} ELSE 0 END)`,
        provisionalQty: sql<number>`SUM(CASE WHEN ${inventoryLots.costProvisional} = 1 THEN ${inventoryLots.qtyOnHand} ELSE 0 END)`,
      })
      .from(inventoryLots)
      .innerJoin(productVariants, eq(productVariants.id, inventoryLots.productVariantId))
      .where(and(eq(inventoryLots.status, "active"), gt(inventoryLots.qtyOnHand, 0)))
      .groupBy(inventoryLots.productVariantId, productVariants.sku);

    let totalQty = 0;
    let totalValue = 0;
    let totalZeroCostQty = 0;
    let totalProvisionalQty = 0;

    const byVariant = rows.map((r: any) => {
      const qty = Number(r.qty) || 0;
      const valueCents = Number(r.totalCost) || 0;
      const zeroCostQty = Number(r.zeroCostQty) || 0;
      const provisionalQty = Number(r.provisionalQty) || 0;
      totalQty += qty;
      totalValue += valueCents;
      totalZeroCostQty += zeroCostQty;
      totalProvisionalQty += provisionalQty;
      return {
        productVariantId: r.productVariantId,
        sku: r.sku,
        qty,
        avgCostCents: qty > 0 ? Math.round(valueCents / qty) : 0,
        valueCents,
        zeroCostQty,
        provisionalQty,
      };
    });

    return {
      total: { qty: totalQty, valueCents: totalValue, zeroCostQty: totalZeroCostQty, provisionalQty: totalProvisionalQty },
      byVariant,
    };
  }

  // ---------------------------------------------------------------------------
  // LEGACY LOT MIGRATION
  // ---------------------------------------------------------------------------

  /**
   * Create "legacy" lots for pre-existing inventory that doesn't have lots.
   * One lot per (variant, location) with unitCostCents = 0.
   * Call once during migration. Idempotent — skips if lots already exist.
   */
  async createLegacyLots(): Promise<{ created: number; skipped: number }> {
    // Find inventory_levels that have no corresponding active lots
    const levels = await this.db
      .select({
        productVariantId: inventoryLevels.productVariantId,
        warehouseLocationId: inventoryLevels.warehouseLocationId,
        variantQty: inventoryLevels.variantQty,
        reservedQty: inventoryLevels.reservedQty,
        pickedQty: inventoryLevels.pickedQty,
      })
      .from(inventoryLevels)
      .where(gt(inventoryLevels.variantQty, 0));

    let created = 0;
    let skipped = 0;

    for (const level of levels) {
      // Check if lots already exist for this variant+location
      const [existing] = await this.db
        .select({ id: inventoryLots.id })
        .from(inventoryLots)
        .where(
          and(
            eq(inventoryLots.productVariantId, level.productVariantId),
            eq(inventoryLots.warehouseLocationId, level.warehouseLocationId),
            eq(inventoryLots.status, "active"),
          ),
        )
        .limit(1);

      if (existing) {
        skipped++;
        continue;
      }

      await this.createLot({
        productVariantId: level.productVariantId,
        warehouseLocationId: level.warehouseLocationId,
        qty: level.variantQty,
        unitCostCents: 0,
        notes: "Legacy lot — pre-existing inventory, cost unknown",
      });

      // If there were reservations, mirror them on the lot
      if (level.reservedQty > 0) {
        const [lot] = await this.db
          .select()
          .from(inventoryLots)
          .where(
            and(
              eq(inventoryLots.productVariantId, level.productVariantId),
              eq(inventoryLots.warehouseLocationId, level.warehouseLocationId),
              eq(inventoryLots.status, "active"),
            ),
          )
          .orderBy(sql`${inventoryLots.id} DESC`)
          .limit(1);

        if (lot) {
          await this.db
            .update(inventoryLots)
            .set({
              qtyReserved: Math.min(level.reservedQty, level.variantQty),
              qtyPicked: Math.min(level.pickedQty || 0, level.variantQty - Math.min(level.reservedQty, level.variantQty)),
            })
            .where(eq(inventoryLots.id, lot.id));
        }
      }

      created++;
    }

    return { created, skipped };
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: transaction-scoped clone
  // ---------------------------------------------------------------------------

  withTx(tx: any): InventoryLotService {
    return new InventoryLotService(tx);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInventoryLotService(db: any) {
  return new InventoryLotService(db);
}
