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
 * Both updated atomically within the same transaction.
 *
 * All quantities in variant units.
 */

import { eq, and, sql, asc, gt, inArray } from "drizzle-orm";
import {
  inventoryLots,
  orderItemCosts,
  productVariants,
  inventoryLevels,
} from "@shared/schema";
import type { InventoryLot, InsertInventoryLot } from "@shared/schema";
import { resolveCost } from "./cost-resolver";
import { millsToCents, centsToMills } from "@shared/utils/money";

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
    notes?: string;
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
    const poUnitCostMills = Math.max(0, totalUnitCostMills - packagingCostMills - landedCostMills);
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
        qtyOnHand: params.qty,
        qtyReserved: 0,
        qtyPicked: 0,
        receivedAt: new Date(),
        receivingOrderId: params.receivingOrderId ?? null,
        purchaseOrderId: params.purchaseOrderId ?? null,
        inboundShipmentId: params.inboundShipmentId ?? null,
        costProvisional: params.costProvisional ?? 0,
        status: "active",
        notes: params.notes ?? null,
      } as any)
      .returning();

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
      .orderBy(asc(inventoryLots.receivedAt));
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

      const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
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
  }): Promise<Array<{ lotId: number; qty: number; unitCostCents: number }>> {
    // Idempotency: if COGS rows already exist for this order item, this is a
    // retry — return the existing allocations without double-writing.
    if (params.orderItemId) {
      const existing = await this.db
        .select({
          inventoryLotId: orderItemCosts.inventoryLotId,
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

      if (existing.length > 0) {
        return existing.map((e: any) => ({
          lotId: e.inventoryLotId,
          qty: e.qty,
          unitCostCents: e.unitCostCents,
        }));
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

    let remaining = params.qty;
    const costAllocations: Array<{ lotId: number; qty: number; unitCostCents: number }> = [];
    const pickUpdates: Array<{ lotId: number; take: number; fromReserved: number }> = [];
    const newCosts: Array<any> = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      // Prefer reserved qty, then unreserved on-hand
      const reservedAvailable = lot.qtyReserved;
      const unreservedAvailable = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
      const totalPickable = reservedAvailable + Math.max(0, unreservedAvailable);
      if (totalPickable <= 0) continue;

      const take = Math.min(totalPickable, remaining);
      const fromReserved = Math.min(reservedAvailable, take);

      pickUpdates.push({ lotId: lot.id, take, fromReserved });

      // Record cost for this lot allocation
      if (params.orderItemId) {
        // COGS in MILLS (lot.unitCostMills mirrors the lot's total per-variant-unit
        // cost). cents columns are derived mirrors (half-up), so the period COGS stays
        // exact when summed in mills (take × per-unit-mills, rounded once at display).
        const lotUnitMills = Number((lot as any).unitCostMills) || centsToMills(lot.unitCostCents);
        const totalCostMills = take * lotUnitMills;
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
    qty: number;
  }): Promise<{ reversedCostCents: number }> {
    // Find the COGS rows written by the original pick
    const cogsRows = await this.db
      .select()
      .from(orderItemCosts)
      .where(
        and(
          eq(orderItemCosts.orderId, params.orderId),
          eq(orderItemCosts.orderItemId, params.orderItemId),
        ),
      );

    if (cogsRows.length === 0) {
      return { reversedCostCents: 0 };
    }

    let reversedCostCents = 0;
    const restoreUpdates: Array<{ lotId: number; restore: number }> = [];

    // Figure out how much to reverse from each lot (may be partial unpick)
    let remaining = params.qty;
    for (const row of cogsRows) {
      if (remaining <= 0) break;
      const restore = Math.min(row.qty, remaining);
      restoreUpdates.push({ lotId: row.inventoryLotId, restore });
      reversedCostCents += restore * row.unitCostCents;
      remaining -= restore;
    }

    // Restore lot quantities: move units from picked back to on-hand
    if (restoreUpdates.length > 0) {
      await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(restoreUpdates)}::jsonb) AS x("lotId" int, restore int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_on_hand = il.qty_on_hand + u.restore,
            qty_picked = GREATEST(il.qty_picked - u.restore, 0),
            status = 'active'
        FROM updates u
        WHERE il.id = u."lotId"
      `);
    }

    // Delete COGS rows. For a full unpick, delete all; for partial, delete
    // proportionally (simplification: delete all and re-pick will re-create).
    if (remaining <= 0) {
      // Full unpick — delete all COGS rows for this order item
      await this.db
        .delete(orderItemCosts)
        .where(
          and(
            eq(orderItemCosts.orderId, params.orderId),
            eq(orderItemCosts.orderItemId, params.orderItemId),
          ),
        );
    } else {
      // Partial unpick — delete the rows we restored from
      const restoredLotIds = restoreUpdates.map(u => u.lotId);
      if (restoredLotIds.length > 0) {
        await this.db
          .delete(orderItemCosts)
          .where(
            and(
              eq(orderItemCosts.orderId, params.orderId),
              eq(orderItemCosts.orderItemId, params.orderItemId),
              inArray(orderItemCosts.inventoryLotId, restoredLotIds),
            ),
          );
      }
    }

    return { reversedCostCents };
  }

  // ---------------------------------------------------------------------------
  // SHIP (deplete picked lots)
  // ---------------------------------------------------------------------------

  /**
   * Record shipment against lots. Decrements qtyPicked.
   * Lots with all quantities at 0 → status = 'depleted'.
   */
  async shipFromLots(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
  }): Promise<void> {
    // Find lots with picked qty, FIFO order
    const lots = await this.db
      .select()
      .from(inventoryLots)
      .where(
        and(
          eq(inventoryLots.productVariantId, params.productVariantId),
          eq(inventoryLots.warehouseLocationId, params.warehouseLocationId),
          gt(inventoryLots.qtyPicked, 0),
        ),
      )
      .orderBy(asc(inventoryLots.receivedAt));

    let remaining = params.qty;
    const pickedUpdates: Array<{ lotId: number; take: number }> = [];
    for (const lot of lots) {
      if (remaining <= 0) break;

      const take = Math.min(lot.qtyPicked, remaining);
      pickedUpdates.push({ lotId: lot.id, take });
      remaining -= take;
    }

    if (pickedUpdates.length > 0) {
      await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(pickedUpdates)}::jsonb) AS x("lotId" int, take int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_picked = il.qty_picked - u.take,
            status = CASE WHEN il.qty_on_hand = 0 AND il.qty_reserved = 0 AND (il.qty_picked - u.take) = 0 THEN 'depleted' ELSE il.status END
        FROM updates u
        WHERE il.id = u."lotId"
      `);
    }

    // If shipped without pick (direct ship), consume from on-hand lots
    if (remaining > 0) {
      const onHandLots = await this.db
        .select()
        .from(inventoryLots)
        .where(
          and(
            eq(inventoryLots.productVariantId, params.productVariantId),
            eq(inventoryLots.warehouseLocationId, params.warehouseLocationId),
            eq(inventoryLots.status, "active"),
            gt(inventoryLots.qtyOnHand, 0),
          ),
        )
        .orderBy(asc(inventoryLots.receivedAt));

      const onHandUpdates: Array<{ lotId: number; take: number; reservedRelease: number }> = [];

      for (const lot of onHandLots) {
        if (remaining <= 0) break;
        const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
        if (available <= 0) continue;

        const take = Math.min(available, remaining);
        const reservedRelease = Math.min(lot.qtyReserved, take);

        onHandUpdates.push({ lotId: lot.id, take, reservedRelease });
        remaining -= take;
      }

      if (onHandUpdates.length > 0) {
        await this.db.execute(sql`
          WITH updates AS (
            SELECT * FROM jsonb_to_recordset(${JSON.stringify(onHandUpdates)}::jsonb) AS x("lotId" int, take int, "reservedRelease" int)
          )
          UPDATE inventory.inventory_lots AS il
          SET qty_on_hand = il.qty_on_hand - u.take,
              qty_reserved = il.qty_reserved - u."reservedRelease",
              status = CASE WHEN (il.qty_on_hand - u.take) = 0 AND (il.qty_reserved - u."reservedRelease") = 0 AND il.qty_picked = 0 THEN 'depleted' ELSE il.status END
          FROM updates u
          WHERE il.id = u."lotId"
        `);
      }
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
  }): Promise<{ consumedCostCents: number; consumedQty: number }> {
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
      });
      return { consumedCostCents: 0, consumedQty: 0 };
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
    const adjustUpdates: Array<{ lotId: number; take: number; reservedRelease: number }> = [];
    for (const lot of lots) {
      if (remaining <= 0) break;

      const unreservedAvailable = Math.max(0, lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked);
      const unreservedTake = Math.min(unreservedAvailable, remaining);
      const reservedTake = Math.min(
        Math.max(0, lot.qtyReserved),
        remaining - unreservedTake,
        reservedReleaseRemaining,
      );
      const take = unreservedTake + reservedTake;
      if (take <= 0) continue;

      adjustUpdates.push({ lotId: lot.id, take, reservedRelease: reservedTake });
      consumedCostCents += take * lot.unitCostCents;
      consumedQty += take;
      remaining -= take;
      reservedReleaseRemaining -= reservedTake;
    }

    if (adjustUpdates.length > 0) {
      await this.db.execute(sql`
        WITH updates AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(adjustUpdates)}::jsonb) AS x("lotId" int, take int, "reservedRelease" int)
        )
        UPDATE inventory.inventory_lots AS il
        SET qty_on_hand = il.qty_on_hand - u.take,
            qty_reserved = il.qty_reserved - u."reservedRelease",
            status = CASE WHEN (il.qty_on_hand - u.take) = 0 AND (il.qty_reserved - u."reservedRelease") = 0 AND il.qty_picked = 0 THEN 'depleted' ELSE il.status END
        FROM updates u
        WHERE il.id = u."lotId"
      `);
    }

    return { consumedCostCents, consumedQty };
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
  }): Promise<void> {
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
    }> = [];

    for (const lot of lots) {
      if (remaining <= 0) break;

      const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
      if (available <= 0) continue;

      const take = Math.min(available, remaining);
      layers.push({
        lotId: lot.id,
        take,
        unitCostCents: lot.unitCostCents,
        receivedAt: lot.receivedAt,
        purchaseOrderId: lot.purchaseOrderId ?? null,
        receivingOrderId: lot.receivingOrderId ?? null,
        inboundShipmentId: lot.inboundShipmentId ?? null,
        costProvisional: (lot as any).costProvisional ?? 0,
      });
      remaining -= take;
    }

    if (layers.length === 0) return;

    // Decrement source lots
    const transferUpdates = layers.map(l => ({ lotId: l.lotId, take: l.take }));
    await this.db.execute(sql`
      WITH updates AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(transferUpdates)}::jsonb) AS x("lotId" int, take int)
      )
      UPDATE inventory.inventory_lots AS il
      SET qty_on_hand = il.qty_on_hand - u.take,
          status = CASE WHEN (il.qty_on_hand - u.take) = 0 AND il.qty_reserved = 0 AND il.qty_picked = 0 THEN 'depleted' ELSE il.status END
      FROM updates u
      WHERE il.id = u."lotId"
    `);

    // Create one destination lot per source layer — cost identity preserved
    for (const layer of layers) {
      await this.createLot({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.toLocationId,
        qty: layer.take,
        unitCostCents: layer.unitCostCents,
        purchaseOrderId: layer.purchaseOrderId ?? undefined,
        receivingOrderId: layer.receivingOrderId ?? undefined,
        inboundShipmentId: layer.inboundShipmentId ?? undefined,
        costProvisional: layer.costProvisional,
        notes: params.notes ?? "Transfer",
      });
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
