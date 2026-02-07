import { eq, and, sql } from "drizzle-orm";
import {
  inventoryLevels,
  inventoryTransactions,
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
 * Manages `inventory_levels` state buckets (onHandBase, reservedBase,
 * pickedBase, packedBase, backorderBase, variantQty) and writes an
 * `inventory_transactions` record for every mutation so the ledger
 * is always auditable.
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

  /**
   * Look up a single inventory level for a specific variant at a specific
   * warehouse location.
   *
   * @returns The level row, or `null` if none exists.
   */
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

  /**
   * Return every inventory level row for a given product variant, across
   * all warehouse locations.
   */
  async getLevelsByVariant(
    productVariantId: number,
  ): Promise<InventoryLevel[]> {
    return this.db
      .select()
      .from(inventoryLevels)
      .where(eq(inventoryLevels.productVariantId, productVariantId));
  }

  /**
   * Return every inventory level row at a given warehouse location, across
   * all product variants stored there.
   */
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

  /**
   * Create an inventory level row if one does not already exist for the given
   * variant + location pair.  If a row already exists it is returned as-is
   * (the `initial` values are *not* merged into an existing row).
   *
   * @param initial  Optional seed values for the new row (onHandBase, etc.).
   *                 If omitted every bucket defaults to 0.
   */
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
          onHandBase: initial.onHandBase ?? 0,
          reservedBase: initial.reservedBase ?? 0,
          pickedBase: initial.pickedBase ?? 0,
          packedBase: initial.packedBase ?? 0,
          backorderBase: initial.backorderBase ?? 0,
          variantQty: initial.variantQty ?? 0,
        })
        .returning();

      return created as InventoryLevel;
    });
  }

  // ---------------------------------------------------------------------------
  // ATOMIC BUCKET ADJUSTMENT
  // ---------------------------------------------------------------------------

  /**
   * Atomically adjust one or more state buckets on an existing inventory
   * level row using `SET col = col + delta`.  This avoids read-then-write
   * race conditions when multiple workers touch the same row concurrently.
   *
   * @param levelId  Primary key of the `inventory_levels` row.
   * @param deltas   Map of bucket name to signed delta value.  Only
   *                 non-undefined keys are applied.
   * @returns The updated row.
   * @throws If no row exists with the given `levelId`.
   */
  async adjustLevel(
    levelId: number,
    deltas: {
      onHandBase?: number;
      reservedBase?: number;
      pickedBase?: number;
      packedBase?: number;
      backorderBase?: number;
      variantQty?: number;
    },
  ): Promise<InventoryLevel> {
    return this.db.transaction(async (tx: any) => {
      const setClauses: Record<string, any> = {
        updatedAt: new Date(),
      };

      if (deltas.onHandBase !== undefined) {
        setClauses.onHandBase = sql`${inventoryLevels.onHandBase} + ${deltas.onHandBase}`;
      }
      if (deltas.reservedBase !== undefined) {
        setClauses.reservedBase = sql`${inventoryLevels.reservedBase} + ${deltas.reservedBase}`;
      }
      if (deltas.pickedBase !== undefined) {
        setClauses.pickedBase = sql`${inventoryLevels.pickedBase} + ${deltas.pickedBase}`;
      }
      if (deltas.packedBase !== undefined) {
        setClauses.packedBase = sql`${inventoryLevels.packedBase} + ${deltas.packedBase}`;
      }
      if (deltas.backorderBase !== undefined) {
        setClauses.backorderBase = sql`${inventoryLevels.backorderBase} + ${deltas.backorderBase}`;
      }
      if (deltas.variantQty !== undefined) {
        setClauses.variantQty = sql`${inventoryLevels.variantQty} + ${deltas.variantQty}`;
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
   * Receive stock into a warehouse location -- typically from a purchase
   * order.  Increments `onHandBase` (and optionally `variantQty`) then
   * writes a `receipt` transaction.
   */
  async receiveInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnits: number;
    variantQty?: number;
    referenceId: string;
    notes?: string;
    userId?: string;
  }): Promise<void> {
    if (params.baseUnits <= 0) {
      throw new Error("baseUnits must be a positive integer");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      // Ensure a level row exists
      const level = await svc.upsertLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      // Atomically increment
      await svc.adjustLevel(level.id, {
        onHandBase: params.baseUnits,
        variantQty: params.variantQty,
      });

      // Audit
      await svc.logTransaction({
        productVariantId: params.productVariantId,
        toLocationId: params.warehouseLocationId,
        transactionType: "receipt",
        variantQtyDelta: params.variantQty ?? 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty + (params.variantQty ?? 0),
        sourceState: null,
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
   * Pick a product for an order.  Decrements `onHandBase`, increments
   * `pickedBase`, and releases any matching reservation by decrementing
   * `reservedBase`.
   *
   * @returns `true` if the pick succeeded, `false` if there was
   *          insufficient on-hand inventory.
   */
  async pickItem(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnits: number;
    orderId: number;
    orderItemId?: number;
    userId?: string;
  }): Promise<boolean> {
    if (params.baseUnits <= 0) {
      throw new Error("baseUnits must be a positive integer");
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

      // Guard: enough on-hand stock?
      if (level.onHandBase < params.baseUnits) {
        return false;
      }

      // Determine if there is a reservation to release
      const reservationRelease = Math.min(level.reservedBase, params.baseUnits);

      await svc.adjustLevel(level.id, {
        onHandBase: -params.baseUnits,
        pickedBase: params.baseUnits,
        reservedBase: reservationRelease > 0 ? -reservationRelease : undefined,
      });

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "pick",
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
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
   * Record a shipment confirmation.  Decrements `pickedBase` (the stock
   * has left the building) and writes a `ship` transaction.
   */
  async recordShipment(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnits: number;
    orderId: number;
    orderItemId?: number;
    shipmentId?: string;
    userId?: string;
  }): Promise<void> {
    if (params.baseUnits <= 0) {
      throw new Error("baseUnits must be a positive integer");
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

      if (level.pickedBase < params.baseUnits) {
        throw new Error(
          `Cannot ship ${params.baseUnits} base units: only ` +
            `${level.pickedBase} in picked state`,
        );
      }

      // Compute the variantQty delta -- derive from baseUnits and variant's
      // unitsPerVariant if we can, otherwise leave at 0.
      const [variant] = await tx
        .select()
        .from(productVariants)
        .where(eq(productVariants.id, params.productVariantId))
        .limit(1);

      const unitsPerVariant = (variant as ProductVariant | undefined)?.unitsPerVariant ?? 1;
      const variantQtyDelta = Math.floor(params.baseUnits / unitsPerVariant);

      await svc.adjustLevel(level.id, {
        pickedBase: -params.baseUnits,
        variantQty: variantQtyDelta > 0 ? -variantQtyDelta : undefined,
      });

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.warehouseLocationId,
        transactionType: "ship",
        variantQtyDelta: variantQtyDelta > 0 ? -variantQtyDelta : 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty - variantQtyDelta,
        sourceState: "picked",
        targetState: "shipped",
        orderId: params.orderId,
        orderItemId: params.orderItemId ?? null,
        referenceType: "order",
        referenceId: params.shipmentId ?? String(params.orderId),
        userId: params.userId ?? null,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // MANUAL ADJUSTMENT (cycle count correction, damage write-off, etc.)
  // ---------------------------------------------------------------------------

  /**
   * Apply a manual inventory adjustment.  The delta can be positive or
   * negative.  Adjusts `onHandBase` and writes an `adjustment` transaction
   * with the supplied reason.
   */
  async adjustInventory(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnitsDelta: number;
    reason: string;
    reasonId?: number;
    cycleCountId?: number;
    userId?: string;
  }): Promise<void> {
    if (params.baseUnitsDelta === 0) {
      throw new Error("baseUnitsDelta must be non-zero");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      const level = await svc.upsertLevel(
        params.productVariantId,
        params.warehouseLocationId,
      );

      await svc.adjustLevel(level.id, {
        onHandBase: params.baseUnitsDelta,
      });

      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId:
          params.baseUnitsDelta < 0 ? params.warehouseLocationId : null,
        toLocationId:
          params.baseUnitsDelta > 0 ? params.warehouseLocationId : null,
        transactionType: "adjustment",
        reasonId: params.reasonId ?? null,
        variantQtyDelta: 0,
        variantQtyBefore: level.variantQty,
        variantQtyAfter: level.variantQty,
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
    });
  }

  // ---------------------------------------------------------------------------
  // RESERVE / RELEASE
  // ---------------------------------------------------------------------------

  /**
   * Reserve inventory for an order by incrementing `reservedBase`.
   * The reservation is a soft hold -- `onHandBase` is *not* decremented
   * until the pick step.
   *
   * @returns `true` if the reservation succeeded (enough available),
   *          `false` otherwise.
   */
  async reserveForOrder(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnits: number;
    orderId: number;
    orderItemId: number;
    userId?: string;
  }): Promise<boolean> {
    if (params.baseUnits <= 0) {
      throw new Error("baseUnits must be a positive integer");
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
      const available = level.onHandBase - level.reservedBase;
      if (available < params.baseUnits) {
        return false;
      }

      await svc.adjustLevel(level.id, {
        reservedBase: params.baseUnits,
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
   * Release a previously placed reservation (e.g. order cancelled,
   * item shorted).  Decrements `reservedBase`.
   */
  async releaseReservation(params: {
    productVariantId: number;
    warehouseLocationId: number;
    baseUnits: number;
    orderId: number;
    orderItemId: number;
    reason: string;
    userId?: string;
  }): Promise<void> {
    if (params.baseUnits <= 0) {
      throw new Error("baseUnits must be a positive integer");
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

      if (level.reservedBase < params.baseUnits) {
        throw new Error(
          `Cannot release ${params.baseUnits} reserved units: only ` +
            `${level.reservedBase} currently reserved`,
        );
      }

      await svc.adjustLevel(level.id, {
        reservedBase: -params.baseUnits,
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
   * Move inventory from one warehouse location to another.  Both the
   * source decrement and destination increment happen in a single
   * transaction.  Two transaction records are written (one per location).
   */
  async transfer(params: {
    productVariantId: number;
    fromLocationId: number;
    toLocationId: number;
    baseUnits: number;
    variantQty?: number;
    userId?: string;
    notes?: string;
  }): Promise<void> {
    if (params.baseUnits <= 0) {
      throw new Error("baseUnits must be a positive integer");
    }
    if (params.fromLocationId === params.toLocationId) {
      throw new Error("Source and destination locations must be different");
    }

    await this.db.transaction(async (tx: any) => {
      const svc = this.withTx(tx);

      // --- SOURCE ---
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

      if (sourceLevel.onHandBase < params.baseUnits) {
        throw new Error(
          `Insufficient on-hand at source: need ${params.baseUnits}, ` +
            `have ${sourceLevel.onHandBase}`,
        );
      }

      await svc.adjustLevel(sourceLevel.id, {
        onHandBase: -params.baseUnits,
        variantQty: params.variantQty != null ? -params.variantQty : undefined,
      });

      // --- DESTINATION ---
      const destLevel = await svc.upsertLevel(
        params.productVariantId,
        params.toLocationId,
      );

      await svc.adjustLevel(destLevel.id, {
        onHandBase: params.baseUnits,
        variantQty: params.variantQty,
      });

      // --- AUDIT: single transfer record with both locations ---
      await svc.logTransaction({
        productVariantId: params.productVariantId,
        fromLocationId: params.fromLocationId,
        toLocationId: params.toLocationId,
        transactionType: "transfer",
        variantQtyDelta: params.variantQty ?? 0,
        variantQtyBefore: sourceLevel.variantQty,
        variantQtyAfter: sourceLevel.variantQty - (params.variantQty ?? 0),
        sourceState: "on_hand",
        targetState: "on_hand",
        referenceType: "manual",
        notes: params.notes ?? null,
        userId: params.userId ?? null,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // AUDIT TRAIL
  // ---------------------------------------------------------------------------

  /**
   * Write a single row to the `inventory_transactions` audit ledger.
   * This is the low-level writer; all mutation methods above call this
   * internally so every state change is recorded.
   */
  async logTransaction(txn: InsertInventoryTransaction): Promise<void> {
    await this.db.insert(inventoryTransactions).values(txn);
  }

  // ---------------------------------------------------------------------------
  // INTERNAL: transaction-scoped clone
  // ---------------------------------------------------------------------------

  /**
   * Return a lightweight copy of this service bound to the given
   * Drizzle transaction handle.  Used internally so that compound
   * operations (e.g. `receiveInventory`) can call helpers like
   * `upsertLevel` and `adjustLevel` within the same transaction.
   */
  private withTx(tx: any): InventoryCoreService {
    return new InventoryCoreService(tx);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `InventoryCoreService` bound to the supplied Drizzle
 * database instance.
 *
 * ```ts
 * import { db } from "../db";
 * import { createInventoryCoreService } from "./services/inventory-core";
 *
 * const inventory = createInventoryCoreService(db);
 * await inventory.receiveInventory({ ... });
 * ```
 */
export function createInventoryCoreService(db: any) {
  return new InventoryCoreService(db);
}
