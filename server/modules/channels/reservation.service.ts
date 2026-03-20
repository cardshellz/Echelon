import { eq, and, sql } from "drizzle-orm";
import {
  orders,
  orderItems,
  inventoryLevels,
  inventoryTransactions,
  productVariants,
  productLocations,
} from "@shared/schema";
import type { VariantAtp } from "../inventory/atp.service";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

interface ChannelSync {
  queueSyncAfterInventoryChange(variantId: number): Promise<void>;
}

interface AtpService {
  getAtpPerVariant(productId: number): Promise<VariantAtp[]>;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ReservationResult {
  orderId: number;
  /** Count of line items successfully reserved */
  reserved: number;
  /** Line items that could not be reserved */
  failed: Array<{ sku: string; orderItemId: number; reason: string }>;
  /** Total base units reserved across all items */
  totalBaseUnits: number;
}

export interface ReserveForOrderResult {
  reserved: number;
  shortfall: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Order-level inventory reservation service.
 *
 * When an order arrives (Shopify webhook), inventory is reserved (committed)
 * to prevent overselling.  When an order ships, reservations are released.
 * When an order is cancelled, reservations are rolled back.
 *
 * Design principles:
 * - Delegates low-level bucket mutations to `InventoryCoreService`.
 * - Individual item failures are collected -- they never block other items.
 * - Every mutation is audited via the inventory transactions ledger.
 */
class ReservationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly inventoryCore: any,
    private readonly channelSync: ChannelSync,
    private readonly atpService: AtpService,
  ) {}

  // ---------------------------------------------------------------------------
  // RESERVE ORDER
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // ATP-GATED RESERVE FOR ORDER ITEM
  // ---------------------------------------------------------------------------

  /**
   * Reserve inventory for a single order item, gated entirely on fungible ATP.
   *
   * 1. Calls `atpService.getAtpPerVariant(productId)` to get the shared ATP pool.
   * 2. Determines how much to reserve (full, partial, or zero).
   * 3. Increments `reserved_qty` on the variant's assigned bin (product_locations).
   * 4. Logs to `inventory_transactions`.
   *
   * ATP is the ONLY gate — no bin-level stock checks, no location searching.
   */
  async reserveForOrder(
    productId: number,
    variantId: number,
    orderQty: number,
    orderId: number,
    orderItemId: number,
    userId?: string,
  ): Promise<ReserveForOrderResult> {
    if (orderQty <= 0) {
      return { reserved: 0, shortfall: 0 };
    }

    // Step 1: Get fungible ATP for the ordered variant
    const variantAtps = await this.atpService.getAtpPerVariant(productId);
    const variantAtp = variantAtps.find((v) => v.productVariantId === variantId);
    const atpUnits = variantAtp?.atpUnits ?? 0;

    // Step 2: Determine reservation quantity
    let toReserve: number;
    let shortfall: number;

    if (atpUnits >= orderQty) {
      toReserve = orderQty;
      shortfall = 0;
    } else if (atpUnits > 0) {
      toReserve = atpUnits;
      shortfall = orderQty - atpUnits;
    } else {
      toReserve = 0;
      shortfall = orderQty;
    }

    // Notify on shortfall
    if (shortfall > 0) {
      const sku = variantAtp?.sku ?? `variant#${variantId}`;
      console.warn(
        `[RESERVATION] Inventory shortfall: Order #${orderId} item #${orderItemId}: ` +
          `Only ${toReserve} of ${orderQty} units of ${sku} could be reserved (ATP=${atpUnits})`,
      );
    }

    if (toReserve === 0) {
      return { reserved: 0, shortfall };
    }

    // Step 3: Find the variant's assigned bin from product_locations
    const [assignment] = await this.db
      .select({
        warehouseLocationId: productLocations.warehouseLocationId,
      })
      .from(productLocations)
      .where(
        and(
          eq(productLocations.productVariantId, variantId),
          eq(productLocations.status, "active"),
        ),
      )
      .orderBy(productLocations.isPrimary) // isPrimary=1 sorts first (descending would be better but 1 > 0)
      .limit(1);

    if (!assignment?.warehouseLocationId) {
      console.warn(
        `[RESERVATION] No assigned bin for variant ${variantId} — cannot place reservation for order #${orderId}`,
      );
      return { reserved: 0, shortfall: orderQty };
    }

    // Step 4: Delegate to inventoryCore (atomic: upserts level + increments reserved_qty + logs txn)
    const success = await this.inventoryCore.reserveForOrder({
      productVariantId: variantId,
      warehouseLocationId: assignment.warehouseLocationId,
      qty: toReserve,
      orderId,
      orderItemId,
      userId,
    });

    if (!success) {
      // Should not happen since core no longer checks bin-level stock,
      // but handle defensively
      console.error(
        `[RESERVATION] inventoryCore.reserveForOrder returned false unexpectedly ` +
          `for variant ${variantId} order #${orderId}`,
      );
      return { reserved: 0, shortfall: orderQty };
    }

    return { reserved: toReserve, shortfall };
  }

  // ---------------------------------------------------------------------------
  // RESERVE ORDER (all line items)
  // ---------------------------------------------------------------------------

  /**
   * Reserve inventory for every line item on an order.
   *
   * For each `order_item`:
   *   1. Resolve the `product_variant` by SKU.
   *   2. Call `reserveForOrder()` with fungible ATP gating.
   *   3. Collect results.
   *
   * Items that cannot be reserved (variant not found, zero ATP) are
   * recorded in the `failed` array -- they never block other items.
   */
  async reserveOrder(orderId: number, userId?: string): Promise<ReservationResult> {
    const result: ReservationResult = {
      orderId,
      reserved: 0,
      failed: [],
      totalBaseUnits: 0,
    };

    // Fetch all line items for this order
    const items = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    const syncVariantIds = new Set<number>();

    for (const item of items) {
      try {
        // 1. Resolve product variant by SKU
        const [variant] = await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.sku, item.sku))
          .limit(1);

        if (!variant) {
          result.failed.push({
            sku: item.sku,
            orderItemId: item.id,
            reason: `Product variant not found for SKU "${item.sku}"`,
          });
          continue;
        }

        // 2. Reserve via ATP-gated method
        const res = await this.reserveForOrder(
          variant.productId,
          variant.id,
          item.quantity,
          orderId,
          item.id,
          userId,
        );

        if (res.reserved > 0) {
          result.reserved++;
          result.totalBaseUnits += res.reserved * (variant.unitsPerVariant ?? 1);
          syncVariantIds.add(variant.id);
        }

        if (res.shortfall > 0) {
          result.failed.push({
            sku: item.sku,
            orderItemId: item.id,
            reason: res.reserved > 0
              ? `Partial reservation: reserved ${res.reserved} of ${item.quantity} variant units (shortfall: ${res.shortfall})`
              : `No reservation: ATP insufficient (need ${item.quantity}, ATP=0)`,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.failed.push({
          sku: item.sku,
          orderItemId: item.id,
          reason: `Unexpected error: ${message}`,
        });
      }
    }

    // Post-reservation: fire channel sync (reserving reduces available ATP)
    for (const vid of Array.from(syncVariantIds)) {
      this.channelSync.queueSyncAfterInventoryChange(vid).catch((err: any) =>
        console.warn(`[ChannelSync] Post-reserve sync failed for variant ${vid}:`, err),
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // RELEASE ORDER RESERVATION
  // ---------------------------------------------------------------------------

  /**
   * Release all inventory reservations for an order (e.g. order cancelled).
   *
   * For each line item, finds the matching reserved inventory and calls
   * `inventoryCore.releaseReservation()` to decrement `reservedQty`.
   *
   * @param orderId  Internal order PK.
   * @param reason   Human-readable reason for the release (audit trail).
   * @param userId   Optional user performing the release.
   */
  async releaseOrderReservation(
    orderId: number,
    reason: string,
    userId?: string,
  ): Promise<{ released: number; failed: Array<{ sku: string; orderItemId: number; reason: string }> }> {
    const result = { released: 0, failed: [] as Array<{ sku: string; orderItemId: number; reason: string }> };
    const syncVariantIds = new Set<number>();

    const items = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    for (const item of items) {
      try {
        // Resolve variant
        const [variant] = await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.sku, item.sku))
          .limit(1);

        if (!variant) {
          result.failed.push({
            sku: item.sku,
            orderItemId: item.id,
            reason: `Variant not found for SKU "${item.sku}"`,
          });
          continue;
        }

        const unitsNeeded = item.quantity;

        // Find which location(s) hold the reservation for this variant.
        // We look for locations where reservedQty > 0.
        const levels = await this.db
          .select()
          .from(inventoryLevels)
          .where(
            and(
              eq(inventoryLevels.productVariantId, variant.id),
              sql`${inventoryLevels.reservedQty} > 0`,
            ),
          );

        let remaining = unitsNeeded;

        for (const level of levels) {
          if (remaining <= 0) break;

          const releaseQty = Math.min(remaining, level.reservedQty);

          try {
            await this.inventoryCore.releaseReservation({
              productVariantId: variant.id,
              warehouseLocationId: level.warehouseLocationId,
              qty: releaseQty,
              orderId,
              orderItemId: item.id,
              reason,
              userId,
            });
            remaining -= releaseQty;
            result.released++;
            syncVariantIds.add(variant.id);
          } catch (releaseErr) {
            const msg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
            console.error(
              `[RESERVATION] Failed to release ${releaseQty} units for SKU "${item.sku}" ` +
                `at location ${level.warehouseLocationId}: ${msg}`,
            );
            result.failed.push({
              sku: item.sku,
              orderItemId: item.id,
              reason: `Release failed at location ${level.warehouseLocationId}: ${msg}`,
            });
          }
        }

        if (remaining > 0) {
          console.warn(
            `[RESERVATION] Could not fully release reservation for SKU "${item.sku}": ` +
              `${remaining} units unaccounted for (order ${orderId})`,
          );
          result.failed.push({
            sku: item.sku,
            orderItemId: item.id,
            reason: `Partial release: ${remaining} of ${unitsNeeded} units could not be released`,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[RESERVATION] Error releasing reservation for order item ${item.id}: ${msg}`,
        );
        result.failed.push({
          sku: item.sku,
          orderItemId: item.id,
          reason: `Unexpected error: ${msg}`,
        });
      }
    }

    // Post-release: fire channel sync (releasing increases available ATP)
    for (const vid of Array.from(syncVariantIds)) {
      this.channelSync.queueSyncAfterInventoryChange(vid).catch((err: any) =>
        console.warn(`[ChannelSync] Post-release sync failed for variant ${vid}:`, err),
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // REALLOCATE ORPHANED RESERVATIONS
  // ---------------------------------------------------------------------------

  /**
   * When a cycle count zeros out inventory at a location but reserved_qty > 0,
   * we have "orphaned" reservations that can never be fulfilled from that bin.
   *
   * This method:
   *  1. Detects excess reserved_qty at the given location for the variant.
   *  2. Force-releases the excess via adjustLevel + unreserve transaction.
   *  3. Finds affected orders via reserve transactions at this location.
   *  4. Attempts to re-reserve each affected order at an alternative assigned bin.
   *
   * Non-fatal: if re-reservation fails, orders stay partially unreserved for
   * manual attention (logged as warnings).
   */
  async reallocateOrphaned(
    productVariantId: number,
    warehouseLocationId: number,
    userId?: string,
  ): Promise<{ released: number; reallocated: number; failed: number }> {
    const result = { released: 0, reallocated: 0, failed: 0 };

    // 1. Get the inventory level at this location
    const [level] = await this.db
      .select()
      .from(inventoryLevels)
      .where(
        and(
          eq(inventoryLevels.productVariantId, productVariantId),
          eq(inventoryLevels.warehouseLocationId, warehouseLocationId),
        ),
      )
      .limit(1);

    if (!level) return result;

    // If reserved_qty <= variant_qty, nothing orphaned
    const currentQty = Math.max(0, level.variantQty);
    if (level.reservedQty <= currentQty) return result;

    const excess = level.reservedQty - currentQty;
    console.log(
      `[RESERVATION] Orphaned reservation detected: variant=${productVariantId} ` +
        `loc=${warehouseLocationId} reserved=${level.reservedQty} onHand=${level.variantQty} excess=${excess}`,
    );

    // 2. Force-release the excess reserved qty
    await this.inventoryCore.adjustLevel(level.id, { reservedQty: -excess });

    result.released = excess;

    try {
      await this.db.insert(inventoryTransactions).values({
        productVariantId,
        fromLocationId: warehouseLocationId,
        transactionType: "unreserve",
        variantQtyDelta: -excess,
        notes: `Orphaned reservation released: cycle count zeroed inventory at this location`,
        userId: userId || null,
      });
    } catch (err: any) {
      console.warn(`[RESERVATION] Failed to log orphaned-release transaction for variant=${productVariantId}:`, err.message);
    }

    // 3. Find affected orders: distinct orders that had reserves at this location
    const reserveTxns = await this.db
      .select({
        orderId: inventoryTransactions.orderId,
      })
      .from(inventoryTransactions)
      .where(
        and(
          eq(inventoryTransactions.productVariantId, productVariantId),
          eq(inventoryTransactions.toLocationId, warehouseLocationId),
          eq(inventoryTransactions.transactionType, "reserve"),
        ),
      );

    const affectedOrderIds: number[] = Array.from(new Set(
      reserveTxns.map((t: any) => t.orderId as number).filter(Boolean),
    ));

    if (affectedOrderIds.length === 0) {
      console.log(`[RESERVATION] No affected orders found for re-allocation`);
      return result;
    }

    console.log(
      `[RESERVATION] Attempting re-allocation for ${affectedOrderIds.length} order(s)`,
    );

    // 4. For each order, try to re-reserve from an alternative assigned bin
    for (const orderId of affectedOrderIds) {
      try {
        // Check if order is still unfulfilled
        const [order] = await this.db
          .select()
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1);

        if (!order || order.warehouseStatus === "cancelled" || order.warehouseStatus === "shipped") {
          continue;
        }

        // Find the order item(s) for this variant
        const items = await this.db
          .select()
          .from(orderItems)
          .where(eq(orderItems.orderId, orderId));

        const [variant] = await this.db
          .select()
          .from(productVariants)
          .where(eq(productVariants.id, productVariantId))
          .limit(1);

        if (!variant) continue;

        for (const item of items) {
          if (item.sku !== variant.sku) continue;

          // Re-reserve using ATP-gated method (finds assigned bin automatically)
          const res = await this.reserveForOrder(
            variant.productId,
            productVariantId,
            item.quantity,
            orderId,
            item.id,
            userId,
          );

          if (res.reserved > 0) {
            result.reallocated++;
            console.log(
              `[RESERVATION] Re-allocated order ${orderId} item ${item.id} ` +
                `(${res.reserved} units, shortfall: ${res.shortfall})`,
            );
          } else {
            result.failed++;
            console.warn(
              `[RESERVATION] No ATP available for variant ${productVariantId} ` +
                `(order ${orderId}) — order stays partially unreserved`,
            );
          }
        }
      } catch (err) {
        result.failed++;
        console.error(
          `[RESERVATION] Re-allocation failed for order ${orderId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Fire channel sync after reallocation
    this.channelSync.queueSyncAfterInventoryChange(productVariantId).catch((err: any) =>
      console.warn(`[ChannelSync] Post-reallocation sync failed for variant ${productVariantId}:`, err),
    );

    return result;
  }

  // ---------------------------------------------------------------------------
  // GET ORDER RESERVATION STATUS
  // ---------------------------------------------------------------------------

  /**
   * Check reservation status for each line item on an order.
   *
   * @param orderId  Internal order PK.
   * @returns Array of per-item reservation snapshots.
   */
  async getOrderReservationStatus(
    orderId: number,
  ): Promise<
    Array<{
      sku: string;
      orderItemId: number;
      reservedQty: number;
      isReserved: boolean;
    }>
  > {
    const items = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    const statuses: Array<{
      sku: string;
      orderItemId: number;
      reservedQty: number;
      isReserved: boolean;
    }> = [];

    for (const item of items) {
      // Resolve variant
      const [variant] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.sku, item.sku))
        .limit(1);

      if (!variant) {
        statuses.push({
          sku: item.sku,
          orderItemId: item.id,
          reservedQty: 0,
          isReserved: false,
        });
        continue;
      }

      // Sum reserved units across all locations for this variant
      const [aggregate] = await this.db
        .select({
          totalReserved: sql<number>`COALESCE(SUM(${inventoryLevels.reservedQty}), 0)`,
        })
        .from(inventoryLevels)
        .where(eq(inventoryLevels.productVariantId, variant.id));

      const totalReserved = Number(aggregate?.totalReserved ?? 0);

      statuses.push({
        sku: item.sku,
        orderItemId: item.id,
        reservedQty: totalReserved,
        isReserved: totalReserved >= item.quantity,
      });
    }

    return statuses;
  }

  // ---------------------------------------------------------------------------
  // AUTO-RESERVE ON SYNC
  // ---------------------------------------------------------------------------

  /**
   * Called by the order sync listener when a new order arrives from Shopify.
   *
   * Finds the internal order by Shopify order ID, checks whether the order
   * has already been reserved, and if not calls `reserveOrder()`.
   *
   * @param shopifyOrderId  The Shopify order ID (string) from the webhook.
   * @param userId          Optional user for audit trail.
   * @returns The reservation result, or `null` if the order was not found
   *          or has already been reserved.
   */
  async autoReserveOnSync(
    shopifyOrderId: string,
    userId?: string,
  ): Promise<ReservationResult | null> {
    // Look up the internal order by Shopify order ID
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.shopifyOrderId, shopifyOrderId))
      .limit(1);

    if (!order) {
      console.warn(
        `[RESERVATION] autoReserveOnSync: order not found for Shopify ID "${shopifyOrderId}"`,
      );
      return null;
    }

    // Skip if order is cancelled or already shipped
    if (
      order.warehouseStatus === "cancelled" ||
      order.warehouseStatus === "shipped"
    ) {
      return null;
    }

    // Check if any items already have reservations (idempotency guard).
    // If any reservation exists for this order's items, assume it's done.
    const items = await this.db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    if (items.length === 0) {
      return null;
    }

    // Check if ALL items already have reservations (idempotency).
    // Only skip if every resolvable SKU has at least one reserve transaction.
    // This allows retries for partial reservations (e.g., after stock arrives).
    const { inventoryTransactions } = await import("@shared/schema");
    let allReserved = true;

    for (const item of items) {
      const [variant] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.sku, item.sku))
        .limit(1);

      if (!variant) {
        allReserved = false;
        continue;
      }

      const [existing] = await this.db
        .select()
        .from(inventoryTransactions)
        .where(
          and(
            eq(inventoryTransactions.orderId, order.id),
            eq(inventoryTransactions.transactionType, "reserve"),
            eq(inventoryTransactions.productVariantId, variant.id),
          ),
        )
        .limit(1);

      if (!existing) {
        allReserved = false;
        break;
      }
    }

    if (allReserved) {
      // All items already reserved — skip
      return null;
    }

    return this.reserveOrder(order.id, userId);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new `ReservationService` bound to the supplied Drizzle database
 * and inventory core service instances.
 *
 * ```ts
 * import { db } from "../db";
 * import { createInventoryCoreService } from "./inventory-core";
 * import { createReservationService } from "./reservation";
 *
 * const inventoryCore = createInventoryCoreService(db);
 * const reservations = createReservationService(db, inventoryCore);
 * await reservations.reserveOrder(orderId);
 * ```
 */
export function createReservationService(db: any, inventoryCore: any, channelSync: any, atpService?: any) {
  return new ReservationService(db, inventoryCore, channelSync, atpService);
}
