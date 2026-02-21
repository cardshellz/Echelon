import { eq, and, sql } from "drizzle-orm";
import {
  inventoryLevels,
  inventoryTransactions,
  productLocations,
  productVariants,
  warehouseLocations,
} from "@shared/schema";
import type {
  InventoryLevel,
  InsertInventoryTransaction,
  ProductVariant,
} from "@shared/schema";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

/**
 * Core inventory service for the Echelon WMS.
 *
 * All quantities in `inventory_levels` are stored in **variant units**
 * (e.g., 5 cases, 10 packs). Base-unit equivalents are computed at
 * query time via `qty * product_variants.units_per_variant`.
 *
 * State buckets: variantQty, reservedQty, pickedQty, packedQty, backorderQty
 *
 * Design principles:
 * - Receives `db` via constructor -- no global singletons.
 * - Every write wraps in `db.transaction()`.
 * - Atomic bucket adjustments via `SET col = col + delta` to avoid
 *   read-then-write races.
 * - Tenant-ready: methods can accept a `tenantId` in the future
 *   without structural changes.
 */
export class InventoryCoreService {
  constructor(private readonly db: DrizzleDb) {}

  // ---------------------------------------------------------------------------
  // READ helpers
  // ---------------------------------------------------------------------------

  async getLevel(
    productVariantId: number,
    warehouseLocationId: number,
  ): Promise<InventoryLevel | null> {
    const [row] = await this.db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async getLevelsByVariant(
    productVariantId: number,
  ): Promise<InventoryLevel[]> {
    return this.db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productVariantId, productVariantId));
  }

  async getLevelsByLocation(
    warehouseLocationId: number,
  ): Promise<InventoryLevel[]> {
    return this.db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.warehouseLocationId, warehouseLocationId));
  }

  // ---------------------------------------------------------------------------
  // UPSERT
  // ---------------------------------------------------------------------------

  async upsertLevel(
    productVariantId: number,
    warehouseLocationId: number,
    initial: Partial<InventoryLevel> = {},
  ): Promise<InventoryLevel> {
    return this.db.transaction(async (tx: any) => {
      const existing = await tx
        .select()
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.productVariantId, productVariantId),
            eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return existing[0] as InventoryLevel;
      }

      const [created] = await tx
        .insert(inventoryLevels)
        .values({
          productVariantId,
          warehouseLocationId,
          variantQty: initial.variantQty ?? 0,
          reservedQty: initial.reservedQty ?? 0,
          pickedQty: initial.pickedQty ?? 0,
          packedQty: initial.packedQty ?? 0,
          backorderQty: initial.backorderQty ?? 0,
        })
        .returning();

      return created as InventoryLevel;
    });
  }

  // ---------------------------------------------------------------------------
  // ATOMIC BUCKET ADJUSTMENT
  // ---------------------------------------------------------------------------

  async adjustLevel(
    levelId: number,
    deltas: {
      variantQty?: number;
      reservedQty?: number;
      pickedQty?: number;
      packedQty?: number;
      backorderQty?: number;
    },
  ): Promise<InventoryLevel> {
    return this.db.transaction(async (tx: any) => {
      const setClauses: Record<string, any> = {
        updatedAt: new Date(),
      };

      if (deltas.variantQty !== undefined) {
        setClauses.variantQty = sql`${inventoryLevels.variantQty} + ${deltas.variantQty}`;
      }
      if (deltas.reservedQty !== undefined) {
        setClauses.reservedQty = sql`${inventoryLevels.reservedQty} + ${deltas.reservedQty}`;
      }
      if (deltas.pickedQty !== undefined) {
        setClauses.pickedQty = sql`${inventoryLevels.pickedQty} + ${deltas.pickedQty}`;
      }
      if (deltas.packedQty !== undefined) {
        setClauses.packedQty = sql`${inventoryLevels.packedQty} + ${deltas.packedQty}`;
      }
      if (deltas.backorderQty !== undefined) {
        setClauses.backorderQty = sql`${inventoryLevels.backorderQty} + ${deltas.backorderQty}`;
      }

      const [updated] = await tx
        .update(inventoryLevels)
        .set(setClauses)
        .where(eq(inventoryLevels.id, levelId))
        .returning();

      if (!updated) {
        throw new Error(`Inventory level ${levelId} not found`);
      }

      return updated as InventoryLevel;
    });
  }

  // ---------------------------------------------------------------------------
  // RECEIVE INVENTORY (from PO / receiving dock)
  // ---------------------------------------------------------------------------

  /**
   * Receive stock into a warehouse location. Increments `variantQty` and
   * writes a `receipt` transaction. All quantities are in variant units.
   */
  async receiveInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    referenceId: string;
    notes?: string;
    userId?: string;
  }): Promise<void> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      const level = await svc.upsertLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      await svc.adjustLevel(level.id, {
        variantQty: params.qty,
      });

      await svc.logTransaction({
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
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // PICK ITEM (picker takes item from shelf)
  // ---------------------------------------------------------------------------

  /**
   * Pick a product for an order. Decrements `variantQty`, increments
   * `pickedQty`, and releases any matching reservation by decrementing
   * `reservedQty`. All quantities in variant units.
   */
  async pickItem(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
  }): Promise<boolean> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }

    return this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      // Snapshot current level for the audit log
      const level = await svc.getLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      if (!level) {
        return false;
      }

      // Determine reservation release (capped at current reservedQty)
      const reservationRelease = Math.min(level.reservedQty, params.qty);

      // Atomic guarded UPDATE — WHERE variant_qty >= qty prevents concurrent
      // picks from driving stock negative (optimistic lock).
      const [updated] = await tx
        .update(inventoryLevels)
        .set({
          variantQty: sql`${inventoryLevels.variantQty} - ${params.qty}`,
          pickedQty: sql`${inventoryLevels.pickedQty} + ${params.qty}`,
          ...(reservationRelease > 0
            ? { reservedQty: sql`${inventoryLevels.reservedQty} - ${reservationRelease}` }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryLevels.id, level.id),
            sql`${inventoryLevels.variantQty} >= ${params.qty}`,
          ),
        )
        .returning();

      if (!updated) {
        // Another concurrent pick claimed the stock — insufficient qty
        return false;
      }

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "pick",
        variantQtyDelta: -params.qty,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: updated.variantQty,
        sourceState: "on_hand",
        targetState: "picked",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: String(params.orderId),
        userId: params.userId ?? null,
      });

      return true;
    });
  }

  // ---------------------------------------------------------------------------
  // RECORD SHIPMENT (ship confirmation releases picked stock)
  // ---------------------------------------------------------------------------

  /**
   * Record a shipment confirmation. Releases inventory that has left the
   * building. All quantities in variant units.
   *
   * Happy path (Echelon pick flow): stock was already moved from variantQty
   * into pickedQty during the pick step, so we only decrement pickedQty.
   *
   * Edge case (shipped without picking — e.g. ShipStation direct): stock
   * is still in variantQty (possibly with reservedQty held). We decrement
   * variantQty directly and release any matching reservedQty.
   */
  async recordShipment(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId?: number;
    shipmentId?: string;
    userId?: string;
  }): Promise<void> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      const level = await svc.getLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      if (!level) {
        throw new Error(
          `No inventory level for variant ${params.productVariantId} ` +
            `at location ${params.warehouseLocationId}`,
        );
      }

      // Determine how much comes from picked vs on-hand
      const fromPicked = Math.min(level.pickedQty, params.qty);
      const fromOnHand = params.qty - fromPicked;

      if (fromPicked > 0) {
        await svc.adjustLevel(level.id, {
          pickedQty: -fromPicked,
        });
      }

      if (fromOnHand > 0) {
        // Stock was never picked — decrement variantQty directly
        // Also release any reservedQty that was held for this order
        const reservedToRelease = Math.min(level.reservedQty, fromOnHand);
        await svc.adjustLevel(level.id, {
          variantQty: -fromOnHand,
          ...(reservedToRelease > 0 ? { reservedQty: -reservedToRelease } : {}),
        });
      }

      // Determine source state for audit log
      const sourceState = fromOnHand > 0 ? "on_hand" : "picked";

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "ship",
        variantQtyDelta: -params.qty,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty - fromOnHand,
        sourceState,
        targetState: "shipped",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: params.shipmentId ?? String(params.orderId),
        userId: params.userId ?? null,
        notes: fromOnHand > 0
          ? `Shipped without pick: ${fromPicked} from picked, ${fromOnHand} from on-hand`
          : null,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // MANUAL ADJUSTMENT (cycle count correction, damage write-off, etc.)
  // ---------------------------------------------------------------------------

  /**
   * Apply a manual inventory adjustment to `variantQty`. The delta can be
   * positive or negative. All quantities in variant units.
   */
  async adjustInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qtyDelta: number;
    reason: string;
    reasonId?: number;
    cycleCountId?: number;
    userId?: string;
    allowNegative?: boolean;
  }): Promise<void> {
    if (params.qtyDelta === 0) {
      throw new Error("qtyDelta must be non-zero");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      const level = await svc.upsertLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      // Guard against negative inventory unless explicitly allowed
      if (!params.allowNegative && params.qtyDelta < 0) {
        if (level.variantQty + params.qtyDelta < 0) {
          throw new Error(
            `Adjustment would result in negative inventory: ` +
            `current ${level.variantQty} + delta ${params.qtyDelta} = ${level.variantQty + params.qtyDelta}`,
          );
        }
      }

      await svc.adjustLevel(level.id, {
        variantQty: params.qtyDelta,
      });

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId:
          params.qtyDelta < 0 ? params.warehouseLocationId : null,
        toLocationId:
          params.qtyDelta > 0 ? params.warehouseLocationId : null,
        transactionType: "adjustment",
        reasonId: params.reasonId ?? null,
        variantQtyDelta: params.qtyDelta,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty + params.qtyDelta,
        sourceState: "on_hand",
        targetState: "on_hand",
        cycleCountId: params.cycleCountId ?? null,
        referenceType: params.cycleCountId ? "cycle_count" : "manual",
        referenceId: params.cycleCountId
          ? String(params.cycleCountId)
          : null,
        notes: params.reason,
        userId: params.userId ?? null,
      });

      // Clean up zombie records: if all buckets are zero and the variant
      // is NOT assigned to this bin, delete the inventory_levels row.
      const afterQty = level.variantQty + params.qtyDelta;
      if (afterQty <= 0) {
        const [current] = await tx
          .select()
          .from(inventoryLevels)
          .where(eq(inventoryLevels.id, level.id))
          .limit(1);
        if (
          current &&
          current.variantQty === 0 &&
          current.reservedQty === 0 &&
          current.pickedQty === 0 &&
          (current.packedQty ?? 0) === 0 &&
          (current.backorderQty ?? 0) === 0
        ) {
          const [assignment] = await tx
            .select({ id: productLocations.id })
            .from(productLocations)
            .where(
              and(
                eq(productLocations.productVariantId, params.productVariantId),
                eq(productLocations.warehouseLocationId, params.warehouseLocationId),
              ),
            )
            .limit(1);
          if (!assignment) {
            await tx.delete(inventoryLevels).where(eq(inventoryLevels.id, level.id));
          }
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // RESERVE / RELEASE
  // ---------------------------------------------------------------------------

  /**
   * Reserve inventory for an order by incrementing `reservedQty`.
   * The reservation is a soft hold -- `variantQty` is *not* decremented
   * until the pick step. All quantities in variant units.
   */
  async reserveForOrder(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    userId?: string;
  }): Promise<boolean> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }

    return this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      const level = await svc.getLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      if (!level) {
        return false;
      }

      // Available = onHand - already reserved
      const available = level.variantQty - level.reservedQty;
      if (available < params.qty) {
        return false;
      }

      await svc.adjustLevel(level.id, {
        reservedQty: params.qty,
      });

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        toLocationId: params.warehouseLocationId,
        transactionType: "reserve",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
        sourceState: "on_hand",
        targetState: "committed",
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        referenceType: "order",
        referenceId: String(params.orderId),
        userId: params.userId ?? null,
      });

      return true;
    });
  }

  /**
   * Release a previously placed reservation. Decrements `reservedQty`.
   */
  async releaseReservation(params: {
    productVariantId: number;
    warehouseLocationId: number;
    qty: number;
    orderId: number;
    orderItemId: number;
    reason: string;
    userId?: string;
  }): Promise<void> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      const level = await svc.getLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      if (!level) {
        throw new Error(
          `No inventory level for variant ${params.productVariantId} ` +
            `at location ${params.warehouseLocationId}`,
        );
      }

      if (level.reservedQty < params.qty) {
        throw new Error(
          `Cannot release ${params.qty} reserved units: only ` +
            `${level.reservedQty} currently reserved`,
        );
      }

      await svc.adjustLevel(level.id, {
        reservedQty: -params.qty,
      });

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "unreserve",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
        sourceState: "committed",
        targetState: "on_hand",
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        referenceType: "order",
        referenceId: String(params.orderId),
        notes: params.reason,
        userId: params.userId ?? null,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // TRANSFER (bin-to-bin move)
  // ---------------------------------------------------------------------------

  /**
   * Move inventory from one warehouse location to another. All quantities
   * in variant units.
   */
  async transfer(params: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    qty: number;
    userId?: string;
    notes?: string;
  }): Promise<void> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }
    if (params.fromLocationId === params.toLocationId) {
      throw new Error("Source and destination locations must be different");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      // --- SOURCE (atomic guarded decrement) ---
      const sourceLevel = await svc.getLevel(
        params.productVariantId,
        params.fromLocationId,
      );

      if (!sourceLevel) {
        throw new Error(
          `No inventory level for variant ${params.productVariantId} ` +
            `at source location ${params.fromLocationId}`,
        );
      }

      if (sourceLevel.variantQty < params.qty) {
        throw new Error(
          `Insufficient on-hand at source: need ${params.qty}, ` +
            `have ${sourceLevel.variantQty}`,
        );
      }

      // Atomic WHERE guard prevents concurrent transfers from over-decrementing
      // (same pattern as pickItem optimistic lock).
      const [decremented] = await tx
        .update(inventoryLevels)
        .set({
          variantQty: sql`${inventoryLevels.variantQty} - ${params.qty}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryLevels.id, sourceLevel.id),
            sql`${inventoryLevels.variantQty} >= ${params.qty}`,
          ),
        )
        .returning();

      if (!decremented) {
        throw new Error(
          `Transfer failed: insufficient stock at source (concurrent claim). ` +
          `Needed ${params.qty}, had ${sourceLevel.variantQty} at read time.`,
        );
      }

      // --- DESTINATION ---
      const destLevel = await svc.upsertLevel(
        params.productVariantId,
        params.toLocationId,
      );

      await svc.adjustLevel(destLevel.id, {
        variantQty: params.qty,
      });

      // --- AUDIT (two entries: source decrement + dest increment) ---
      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        transactionType: "transfer",
        variantQtyDelta: -params.qty,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: decremented.variantQty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "manual",
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      });

      const updatedDest = await svc.getLevel(params.productVariantId, params.toLocationId);
      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        transactionType: "transfer",
        variantQtyDelta: params.qty,
        variantQtyBefore: destLevel.variantQty,
        variantQtyAfter: updatedDest?.variantQty ?? destLevel.variantQty + params.qty,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "manual",
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      });
    });
  }

  /**
   * Cross-variant inventory transfer for SKU corrections.
   * Moves qty from sourceVariant to targetVariant at the same location.
   * Creates two audit transactions with a shared batchId.
   */
  async skuCorrectionTransfer(params: {
    sourceVariantId: number;
    targetVariantId: number;
    warehouseLocationId: number;
    qty: number;
    batchId: string;
    userId?: string;
    notes?: string;
  }): Promise<void> {
    if (params.qty <= 0) {
      throw new Error("qty must be a positive integer");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      // --- SOURCE (atomic guarded decrement) ---
      const sourceLevel = await svc.getLevel(
        params.sourceVariantId,
        params.warehouseLocationId,
      );

      if (!sourceLevel) {
        throw new Error(
          `No inventory level for variant ${params.sourceVariantId} ` +
            `at location ${params.warehouseLocationId}`,
        );
      }

      if (sourceLevel.variantQty < params.qty) {
        throw new Error(
          `Insufficient on-hand at source: need ${params.qty}, ` +
            `have ${sourceLevel.variantQty}`,
        );
      }

      if (sourceLevel.reservedQty > 0) {
        throw new Error(
          `Cannot transfer: variant has ${sourceLevel.reservedQty} reserved units at location ${params.warehouseLocationId}`,
        );
      }

      const [decremented] = await tx
        .update(inventoryLevels)
        .set({
          variantQty: sql`${inventoryLevels.variantQty} - ${params.qty}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventoryLevels.id, sourceLevel.id),
            sql`${inventoryLevels.variantQty} >= ${params.qty}`,
          ),
        )
        .returning();

      if (!decremented) {
        throw new Error(
          `SKU correction failed: insufficient stock at source (concurrent claim).`,
        );
      }

      // --- DESTINATION ---
      const destLevel = await svc.upsertLevel(
        params.targetVariantId,
        params.warehouseLocationId,
      );

      await svc.adjustLevel(destLevel.id, {
        variantQty: params.qty,
      });

      // --- AUDIT (two entries: source decrement + dest increment) ---
      await svc.logTransaction({
        productVariantId: params.sourceVariantId,
        fromLocationId: params.warehouseLocationId,
        toLocationId: params.warehouseLocationId,
        transactionType: "sku_correction",
        variantQtyDelta: -params.qty,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: decremented.variantQty,
        batchId: params.batchId,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "sku_correction",
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      });

      const updatedDest = await svc.getLevel(params.targetVariantId, params.warehouseLocationId);
      await svc.logTransaction({
        productVariantId: params.targetVariantId,
        fromLocationId: params.warehouseLocationId,
        toLocationId: params.warehouseLocationId,
        transactionType: "sku_correction",
        variantQtyDelta: params.qty,
        variantQtyBefore: destLevel.variantQty,
        variantQtyAfter: updatedDest?.variantQty ?? destLevel.variantQty + params.qty,
        batchId: params.batchId,
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "sku_correction",
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      });

      // Zombie cleanup: if source level all-zeroes, remove it
      if (decremented.variantQty === 0) {
        const [current] = await tx
          .select()
          .from(inventoryLevels)
          .where(eq(inventoryLevels.id, sourceLevel.id))
          .limit(1);
        if (
          current &&
          current.variantQty === 0 &&
          current.reservedQty === 0 &&
          current.pickedQty === 0 &&
          (current.packedQty ?? 0) === 0 &&
          (current.backorderQty ?? 0) === 0
        ) {
          await tx.delete(inventoryLevels).where(eq(inventoryLevels.id, sourceLevel.id));
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // AUDIT TRAIL
  // ---------------------------------------------------------------------------

  async logTransaction(txn: InsertInventoryTransaction): Promise<void> {
    await this.db.insert(inventoryTransactions).values(txn);
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: transaction-scoped clone
  // ---------------------------------------------------------------------------

  private withTx(tx: any): InventoryCoreService {
    return new InventoryCoreService(tx);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInventoryCoreService(db: any) {
  return new InventoryCoreService(db);
}
