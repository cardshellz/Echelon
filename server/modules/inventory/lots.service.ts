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

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
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
    receivingOrderId?: number;
    purchaseOrderId?: number;
    inboundShipmentId?: number;
    costProvisional?: number;
    notes?: string;
  }): Promise<InventoryLot> {
    const lotNumber = await this.generateLotNumber();

    const [lot] = await this.db
      .insert(inventoryLots)
      .values({
        lotNumber,
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
        unitCostCents: params.unitCostCents,
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

      await this.db
        .update(inventoryLots)
        .set({
          qtyReserved: sql`${inventoryLots.qtyReserved} + ${take}`,
        })
        .where(eq(inventoryLots.id, lot.id));

      allocations.push({ lotId: lot.id, qty: take, unitCostCents: lot.unitCostCents });
      remaining -= take;
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
    for (const lot of lots) {
      if (remaining <= 0) break;

      const release = Math.min(lot.qtyReserved, remaining);

      await this.db
        .update(inventoryLots)
        .set({
          qtyReserved: sql`${inventoryLots.qtyReserved} - ${release}`,
        })
        .where(eq(inventoryLots.id, lot.id));

      remaining -= release;
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

    for (const lot of lots) {
      if (remaining <= 0) break;

      // Prefer reserved qty, then unreserved on-hand
      const reservedAvailable = lot.qtyReserved;
      const unreservedAvailable = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
      const totalPickable = reservedAvailable + Math.max(0, unreservedAvailable);
      if (totalPickable <= 0) continue;

      const take = Math.min(totalPickable, remaining);
      const fromReserved = Math.min(reservedAvailable, take);

      // Decrement on-hand + reserved, increment picked
      await this.db
        .update(inventoryLots)
        .set({
          qtyOnHand: sql`${inventoryLots.qtyOnHand} - ${take}`,
          qtyReserved: sql`${inventoryLots.qtyReserved} - ${fromReserved}`,
          qtyPicked: sql`${inventoryLots.qtyPicked} + ${take}`,
        })
        .where(eq(inventoryLots.id, lot.id));

      // Record cost for this lot allocation
      if (params.orderItemId) {
        await this.db.insert(orderItemCosts).values({
          orderId: params.orderId,
          orderItemId: params.orderItemId,
          inventoryLotId: lot.id,
          productVariantId: params.productVariantId,
          qty: take,
          unitCostCents: lot.unitCostCents,
          totalCostCents: take * lot.unitCostCents,
        } as any);
      }

      costAllocations.push({ lotId: lot.id, qty: take, unitCostCents: lot.unitCostCents });
      remaining -= take;
    }

    return costAllocations;
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
    for (const lot of lots) {
      if (remaining <= 0) break;

      const take = Math.min(lot.qtyPicked, remaining);

      const [updated] = await this.db
        .update(inventoryLots)
        .set({
          qtyPicked: sql`${inventoryLots.qtyPicked} - ${take}`,
        })
        .where(eq(inventoryLots.id, lot.id))
        .returning();

      // Check for depletion
      if (updated && updated.qtyOnHand === 0 && updated.qtyReserved === 0 && updated.qtyPicked === 0) {
        await this.db
          .update(inventoryLots)
          .set({ status: "depleted" })
          .where(eq(inventoryLots.id, lot.id));
      }

      remaining -= take;
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

      for (const lot of onHandLots) {
        if (remaining <= 0) break;
        const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
        if (available <= 0) continue;

        const take = Math.min(available, remaining);
        const reservedRelease = Math.min(lot.qtyReserved, take);

        const [updated] = await this.db
          .update(inventoryLots)
          .set({
            qtyOnHand: sql`${inventoryLots.qtyOnHand} - ${take}`,
            ...(reservedRelease > 0 ? { qtyReserved: sql`${inventoryLots.qtyReserved} - ${reservedRelease}` } : {}),
          })
          .where(eq(inventoryLots.id, lot.id))
          .returning();

        if (updated && updated.qtyOnHand === 0 && updated.qtyReserved === 0 && updated.qtyPicked === 0) {
          await this.db
            .update(inventoryLots)
            .set({ status: "depleted" })
            .where(eq(inventoryLots.id, lot.id));
        }

        remaining -= take;
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
    notes?: string;
  }): Promise<void> {
    if (params.qtyDelta > 0) {
      // Positive adjustment: create a new lot with zero cost (unknown source)
      await this.createLot({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.warehouseLocationId,
        qty: params.qtyDelta,
        unitCostCents: 0,
        notes: params.notes ?? "Manual adjustment",
      });
    } else {
      // Negative adjustment: consume from oldest lots first
      const lots = await this.getLotsAtLocation(
        params.productVariantId,
        params.warehouseLocationId,
      );

      let remaining = Math.abs(params.qtyDelta);
      for (const lot of lots) {
        if (remaining <= 0) break;

        const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
        if (available <= 0) continue;

        const take = Math.min(available, remaining);

        const [updated] = await this.db
          .update(inventoryLots)
          .set({
            qtyOnHand: sql`${inventoryLots.qtyOnHand} - ${take}`,
          })
          .where(eq(inventoryLots.id, lot.id))
          .returning();

        if (updated && updated.qtyOnHand === 0 && updated.qtyReserved === 0 && updated.qtyPicked === 0) {
          await this.db
            .update(inventoryLots)
            .set({ status: "depleted" })
            .where(eq(inventoryLots.id, lot.id));
        }

        remaining -= take;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TRANSFER (move lot to new location)
  // ---------------------------------------------------------------------------

  /**
   * Transfer qty from lots at source to a new lot at destination.
   * Source lots are consumed FIFO. A new lot is created at dest with
   * a weighted average cost of consumed lots.
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
    let totalCostCents = 0;
    let totalQty = 0;

    for (const lot of lots) {
      if (remaining <= 0) break;

      const available = lot.qtyOnHand - lot.qtyReserved - lot.qtyPicked;
      if (available <= 0) continue;

      const take = Math.min(available, remaining);

      const [updated] = await this.db
        .update(inventoryLots)
        .set({
          qtyOnHand: sql`${inventoryLots.qtyOnHand} - ${take}`,
        })
        .where(eq(inventoryLots.id, lot.id))
        .returning();

      if (updated && updated.qtyOnHand === 0 && updated.qtyReserved === 0 && updated.qtyPicked === 0) {
        await this.db
          .update(inventoryLots)
          .set({ status: "depleted" })
          .where(eq(inventoryLots.id, lot.id));
      }

      totalCostCents += take * lot.unitCostCents;
      totalQty += take;
      remaining -= take;
    }

    // Create a new lot at the destination with weighted average cost
    if (totalQty > 0) {
      const avgCost = Math.round(totalCostCents / totalQty);
      await this.createLot({
        productVariantId: params.productVariantId,
        warehouseLocationId: params.toLocationId,
        qty: totalQty,
        unitCostCents: avgCost,
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
    total: { qty: number; valueCents: number };
    byVariant: Array<{
      productVariantId: number;
      sku: string | null;
      qty: number;
      avgCostCents: number;
      valueCents: number;
    }>;
  }> {
    const rows = await this.db
      .select({
        productVariantId: inventoryLots.productVariantId,
        sku: productVariants.sku,
        qty: sql<number>`SUM(${inventoryLots.qtyOnHand})`,
        totalCost: sql<number>`SUM(${inventoryLots.qtyOnHand} * ${inventoryLots.unitCostCents})`,
      })
      .from(inventoryLots)
      .innerJoin(productVariants, eq(productVariants.id, inventoryLots.productVariantId))
      .where(eq(inventoryLots.status, "active"))
      .groupBy(inventoryLots.productVariantId, productVariants.sku);

    let totalQty = 0;
    let totalValue = 0;

    const byVariant = rows.map((r: any) => {
      const qty = Number(r.qty) || 0;
      const valueCents = Number(r.totalCost) || 0;
      totalQty += qty;
      totalValue += valueCents;
      return {
        productVariantId: r.productVariantId,
        sku: r.sku,
        qty,
        avgCostCents: qty > 0 ? Math.round(valueCents / qty) : 0,
        valueCents,
      };
    });

    return {
      total: { qty: totalQty, valueCents: totalValue },
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
