import { eq, and, sql } from "drizzle-orm";
import {
  orders,
  orderItems,
  inventoryLevels,
  productVariants,
  warehouseLocations,
} from "@shared/schema";
type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

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
  ) {}

  // ---------------------------------------------------------------------------
  // RESERVE ORDER
  // ---------------------------------------------------------------------------

  /**
   * Reserve inventory for every line item on an order.
   *
   * For each `order_item`:
   *   1. Resolve the `product_variant` by SKU.
   *   2. Calculate base units: `item.quantity * variant.unitsPerVariant`.
   *   3. Find the best warehouse location (prefer forward-pick locations with
   *      sufficient available stock, ordered by `pick_sequence`).
   *   4. Call `inventoryCore.reserveForOrder()`.
   *
   * Items that cannot be reserved (variant not found, insufficient stock) are
   * recorded in the `failed` array -- they never block other items.
   *
   * @param orderId  Internal order PK.
   * @param userId   Optional user performing the reservation (audit trail).
   * @returns Summary of what was reserved and what failed.
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

        // 2. Calculate variant units needed (order qty IS variant units)
        const unitsNeeded = item.quantity;

        // 3. Find the best location to reserve from
        //    Prefer forward_pick locations with sufficient available stock,
        //    ordered by pick_sequence for walk-path efficiency.
        const levels = await this.db
          .select()
          .from(inventoryLevels)
          .innerJoin(
            warehouseLocations,
            eq(inventoryLevels.warehouseLocationId, warehouseLocations.id),
          )
          .where(
            and(
              eq(inventoryLevels.productVariantId, variant.id),
              // Available = onHand - reserved - picked > 0
              sql`${inventoryLevels.variantQty} - ${inventoryLevels.reservedQty} - ${inventoryLevels.pickedQty} > 0`,
            ),
          )
          .orderBy(warehouseLocations.pickSequence);

        if (levels.length === 0) {
          result.failed.push({
            sku: item.sku,
            orderItemId: item.id,
            reason: `No available inventory for SKU "${item.sku}" (need ${unitsNeeded} units)`,
          });
          continue;
        }

        // Pick the first location that has enough stock; fall back to the
        // first location with any stock if none has sufficient quantity.
        let chosenLevel = levels.find((row: any) => {
          const available =
            row.inventory_levels.variantQty -
            row.inventory_levels.reservedQty -
            row.inventory_levels.pickedQty;
          return available >= unitsNeeded;
        });

        if (!chosenLevel) {
          // No single location has enough -- use the one with the most
          // available stock (partial reservation is better than none).
          chosenLevel = levels[0];
        }

        const available =
          chosenLevel.inventory_levels.variantQty -
          chosenLevel.inventory_levels.reservedQty -
          chosenLevel.inventory_levels.pickedQty;

        const unitsToReserve = Math.min(unitsNeeded, available);
        const baseUnitsReserved = unitsToReserve * (variant.unitsPerVariant ?? 1);

        // 4. Reserve via inventory core (now in variant units)
        const reserved = await this.inventoryCore.reserveForOrder({
          productVariantId: variant.id,
          warehouseLocationId: chosenLevel.inventory_levels.warehouseLocationId,
          qty: unitsToReserve,
          orderId,
          orderItemId: item.id,
          userId,
        });

        if (reserved) {
          result.reserved++;
          result.totalBaseUnits += baseUnitsReserved;

          // If we could not fully reserve, note the shortfall
          if (unitsToReserve < unitsNeeded) {
            result.failed.push({
              sku: item.sku,
              orderItemId: item.id,
              reason: `Partial reservation: reserved ${unitsToReserve} of ${unitsNeeded} variant units`,
            });
          }
        } else {
          result.failed.push({
            sku: item.sku,
            orderItemId: item.id,
            reason: `Reservation rejected by inventory core (insufficient available stock)`,
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
  ): Promise<void> {
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
          console.warn(
            `[RESERVATION] Cannot release reservation for SKU "${item.sku}": variant not found`,
          );
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
          } catch (releaseErr) {
            console.error(
              `[RESERVATION] Failed to release ${releaseQty} units for SKU "${item.sku}" ` +
                `at location ${level.warehouseLocationId}:`,
              releaseErr,
            );
          }
        }

        if (remaining > 0) {
          console.warn(
            `[RESERVATION] Could not fully release reservation for SKU "${item.sku}": ` +
              `${remaining} base units unaccounted for`,
          );
        }
      } catch (err) {
        console.error(
          `[RESERVATION] Error releasing reservation for order item ${item.id}:`,
          err,
        );
      }
    }
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

    // Quick check: look for any existing reserve transactions for this order
    // by checking if any variant for these items has reserved stock.
    // A more precise check would query inventory_transactions, but this
    // heuristic avoids an extra table scan for the common case.
    for (const item of items) {
      const [variant] = await this.db
        .select()
        .from(productVariants)
        .where(eq(productVariants.sku, item.sku))
        .limit(1);

      if (!variant) continue;

      // Check inventory_transactions for existing reserve entries for this order
      const { inventoryTransactions } = await import("@shared/schema");
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

      if (existing) {
        // Already reserved
        return null;
      }
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
export function createReservationService(db: any, inventoryCore: any) {
  return new ReservationService(db, inventoryCore);
}
