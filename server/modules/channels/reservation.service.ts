import { eq, and, sql, isNull } from "drizzle-orm";
import {
  orders,
  orderItems,
  inventoryLevels,
  inventoryTransactions,
  productVariants,
  productLocations,
  warehouseLocations,
} from "@shared/schema";
import type { VariantAtp } from "../inventory/atp.service";

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  execute: (query: any) => Promise<any>;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

// Advisory lock namespace for per-product reservation serialization (P0.1b).
// 918405-918407 are taken by flow-reconciliation / shipment-creation / push.
const RESERVATION_LOCK_NS = 918410;

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

export interface ReleaseOrderItemReservationResult {
  orderId: number;
  orderItemId: number;
  productVariantId: number;
  requestedQuantity: number;
  previouslyReleasedQuantity: number;
  releasedQuantity: number;
  openReservationAfter: number;
  idempotentReplay: boolean;
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
    dbOverride?: any,
  ): Promise<ReserveForOrderResult> {
    if (orderQty <= 0) {
      return { reserved: 0, shortfall: 0 };
    }

    // P0.1b: serialize check→reserve per product. Without this, two
    // concurrent reservations can both read the same ATP and both reserve
    // the last units (over-commit). pg_advisory_xact_lock pins the lock to
    // the transaction's connection and releases automatically on commit /
    // rollback — competing reservers for the SAME product queue here and
    // re-read ATP only after the winner's reserve has committed.
    if (dbOverride) {
      // Caller supplied a transaction — bind the lock to it.
      await dbOverride.execute(
        sql`SELECT pg_advisory_xact_lock(${RESERVATION_LOCK_NS}, ${productId})`,
      );
      return this.reserveForOrderLocked(
        productId, variantId, orderQty, orderId, orderItemId, userId, dbOverride,
      );
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${RESERVATION_LOCK_NS}, ${productId})`,
      );
      return this.reserveForOrderLocked(
        productId, variantId, orderQty, orderId, orderItemId, userId, tx,
      );
    });
  }

  /**
   * Inner body of reserveForOrder — MUST be called while holding the
   * per-product advisory lock on `dbh`'s connection.
   */
  private async reserveForOrderLocked(
    productId: number,
    variantId: number,
    orderQty: number,
    orderId: number,
    orderItemId: number,
    userId: string | undefined,
    dbh: any,
  ): Promise<ReserveForOrderResult> {
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

    // Step 3: Find the variant's assigned bin from product_locations,
    // excluding frozen locations (cycle_count_freeze_id IS NOT NULL).
    const [assignment] = await dbh
      .select({
        warehouseLocationId: productLocations.warehouseLocationId,
      })
      .from(productLocations)
      .innerJoin(
        warehouseLocations,
        eq(warehouseLocations.id, productLocations.warehouseLocationId),
      )
      .where(
        and(
          eq(productLocations.productVariantId, variantId),
          eq(productLocations.status, "active"),
          isNull(warehouseLocations.cycleCountFreezeId),
        ),
      )
      .orderBy(sql`${productLocations.isPrimary} DESC`)
      .limit(1);

    let reserveLocationId = assignment?.warehouseLocationId ?? null;

    // Fallback: if no product_locations row, find an inventory_levels row
    // for this variant at an unfrozen location. ATP confirmed stock exists
    // somewhere (e.g. received but not yet slotted).
    if (!reserveLocationId) {
      const [fallbackLevel] = await dbh
        .select({
          warehouseLocationId: inventoryLevels.warehouseLocationId,
        })
        .from(inventoryLevels)
        .innerJoin(
          warehouseLocations,
          eq(warehouseLocations.id, inventoryLevels.warehouseLocationId),
        )
        .where(
          and(
            eq(inventoryLevels.productVariantId, variantId),
            sql`${inventoryLevels.variantQty} > 0`,
            isNull(warehouseLocations.cycleCountFreezeId),
          ),
        )
        .orderBy(sql`${inventoryLevels.variantQty} DESC`)
        .limit(1);

      if (fallbackLevel?.warehouseLocationId) {
        reserveLocationId = fallbackLevel.warehouseLocationId;
        console.warn(
          `[RESERVATION] No assigned bin (product_locations) for variant ${variantId} — ` +
            `falling back to inventory_levels location ${reserveLocationId} for order #${orderId}`,
        );
      }
    }

    if (!reserveLocationId) {
      console.warn(
        `[RESERVATION] No assigned bin or inventory_levels for variant ${variantId} — ` +
          `cannot place reservation for order #${orderId}`,
      );
      return { reserved: 0, shortfall: orderQty };
    }

    // Step 4: Delegate to inventoryCore (atomic: upserts level + increments reserved_qty + logs txn)
    const success = await this.inventoryCore.reserveForOrder({
      productVariantId: variantId,
      warehouseLocationId: reserveLocationId,
      qty: toReserve,
      orderId,
      orderItemId,
      userId,
    }, dbh);

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
  async reserveOrder(orderId: number, userId?: string, dbOverride?: any): Promise<ReservationResult> {
    const dbh = dbOverride ?? this.db;
    const result: ReservationResult = {
      orderId,
      reserved: 0,
      failed: [],
      totalBaseUnits: 0,
    };

    // Fetch all line items for this order
    const items = await dbh
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    const syncVariantIds = new Set<number>();

    for (const item of items) {
      try {
        // 1. Resolve product variant by SKU
        const [variant] = await dbh
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
          dbOverride,
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
   * Release an order's OPEN reservations — order-scoped and idempotent (P0.1b).
   *
   * The amount to release is derived from the reservation ledger for THIS
   * order item, never from the raw order quantity:
   *
   *   open = SUM(reserved_qty_delta) over reserve/unreserve/pick rows
   *          keyed by (order_id, order_item_id)
   *
   * so a reservation already consumed by a pick, already released, or never
   * placed (shortfall) releases 0. Calling this twice is a no-op — it can
   * never drain other orders' reservations (the pre-P0.1 bug).
   *
   * Legacy fallback: reserve rows written before migration 116 carry no
   * quantity. For those, the open amount is estimated as
   * max(0, item.quantity − ledger picks − qty-carrying unreserves). This can
   * over-release only for a pre-116 order that was shortfall-reserved and is
   * cancelled during the transition window — accepted and bounded; the
   * weekly drift check catches residue.
   *
   * @param orderId  WMS order PK.
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
        // Resolve variant (wms.order_items carries sku, not variant id)
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

        // Open reservation for THIS item, from the ledger.
        const ledger: any = await this.db.execute(sql`
          SELECT
            COALESCE(SUM(reserved_qty_delta), 0)::int AS delta_sum,
            COUNT(*) FILTER (
              WHERE transaction_type = 'reserve' AND reserved_qty_delta IS NULL
            )::int AS legacy_reserves,
            COALESCE(SUM(CASE WHEN transaction_type = 'pick'
                              THEN -variant_qty_delta ELSE 0 END), 0)::int AS picked_units,
            COALESCE(SUM(CASE WHEN transaction_type = 'unreserve'
                                   AND reserved_qty_delta IS NOT NULL
                              THEN -reserved_qty_delta ELSE 0 END), 0)::int AS unreserved_units
          FROM inventory.inventory_transactions
          WHERE order_id = ${orderId}
            AND order_item_id = ${item.id}
            AND transaction_type IN ('reserve', 'unreserve', 'pick')
            AND voided_at IS NULL
        `);
        const row = ledger?.rows?.[0] ?? {};
        let openQty = Math.max(0, Number(row.delta_sum ?? 0));
        if (Number(row.legacy_reserves ?? 0) > 0) {
          // Pre-106 reserve rows have unknown qty — conservative estimate.
          const estimate = Math.max(
            0,
            Number(item.quantity) - Number(row.picked_units ?? 0) - Number(row.unreserved_units ?? 0),
          );
          openQty = Math.max(openQty, estimate);
        }

        if (openQty <= 0) {
          continue; // nothing open for this item — idempotent no-op
        }

        // Release the open amount from levels actually holding reservations.
        const levels = await this.db
          .select()
          .from(inventoryLevels)
          .where(
            and(
              eq(inventoryLevels.productVariantId, variant.id),
              sql`${inventoryLevels.reservedQty} > 0`,
            ),
          )
          .orderBy(sql`${inventoryLevels.reservedQty} DESC`);

        let remaining = openQty;

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
          // Ledger says more is open than the counters hold — counters are
          // already below the attributed amount (historical drift). Not an
          // error: releasing further would over-release someone else.
          console.warn(
            `[RESERVATION] Order ${orderId} item ${item.id} (${item.sku}): ledger shows ` +
              `${remaining} open unit(s) beyond current counters — skipping (drift candidate)`,
          );
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

  /**
   * Release at most `quantity` units attributed to one WMS order item.
   *
   * `sourceEventId` is mandatory and becomes the inventory-ledger reference.
   * The per-product advisory lock serializes reserve/release writers; a retry
   * re-reads how much this exact event already released and only applies the
   * remainder. This makes a refund retry safe even when the prior attempt
   * committed the inventory release but failed later in its workflow.
   */
  async releaseOrderItemReservation(params: {
    orderId: number;
    orderItemId: number;
    quantity: number;
    sourceEventId: string;
    reason: string;
    userId?: string;
  }): Promise<ReleaseOrderItemReservationResult> {
    if (!Number.isInteger(params.orderId) || params.orderId <= 0) {
      throw new Error("orderId must be a positive integer");
    }
    if (!Number.isInteger(params.orderItemId) || params.orderItemId <= 0) {
      throw new Error("orderItemId must be a positive integer");
    }
    if (!Number.isInteger(params.quantity) || params.quantity <= 0) {
      throw new Error("quantity must be a positive integer");
    }
    const sourceEventId = String(params.sourceEventId ?? "").trim();
    if (!sourceEventId) throw new Error("sourceEventId is required");

    const outcome = await this.db.transaction(async (tx: any) => {
      const itemResult: any = await tx.execute(sql`
        SELECT
          oi.id AS order_item_id,
          oi.sku,
          pv.id AS product_variant_id,
          pv.product_id
        FROM wms.order_items oi
        JOIN catalog.product_variants pv ON pv.sku = oi.sku
        WHERE oi.id = ${params.orderItemId}
          AND oi.order_id = ${params.orderId}
        FOR UPDATE OF oi
      `);
      const itemRows = itemResult?.rows ?? [];
      if (itemRows.length !== 1) {
        throw new Error(
          itemRows.length === 0
            ? `WMS order item ${params.orderItemId} does not belong to order ${params.orderId} or has no catalog variant`
            : `WMS order item ${params.orderItemId} SKU resolves to multiple catalog variants`,
        );
      }

      const item = itemRows[0];
      const productVariantId = Number(item.product_variant_id);
      const productId = Number(item.product_id);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RESERVATION_LOCK_NS}, ${productId})`);

      const priorEventResult: any = await tx.execute(sql`
        SELECT COALESCE(SUM(-reserved_qty_delta), 0)::int AS released_quantity
        FROM inventory.inventory_transactions
        WHERE order_id = ${params.orderId}
          AND order_item_id = ${params.orderItemId}
          AND transaction_type = 'unreserve'
          AND reference_type = 'shopify_refund'
          AND reference_id = ${sourceEventId}
          AND COALESCE(reserved_qty_delta, 0) < 0
          AND voided_at IS NULL
      `);
      const previouslyReleasedQuantity = Math.max(
        0,
        Number(priorEventResult?.rows?.[0]?.released_quantity ?? 0),
      );
      const remainingRequest = Math.max(params.quantity - previouslyReleasedQuantity, 0);

      const ledgerResult: any = await tx.execute(sql`
        SELECT
          COALESCE(SUM(reserved_qty_delta), 0)::int AS delta_sum,
          COUNT(*) FILTER (
            WHERE transaction_type = 'reserve' AND reserved_qty_delta IS NULL
          )::int AS legacy_reserves,
          COALESCE(SUM(CASE WHEN transaction_type = 'pick'
                            THEN -variant_qty_delta ELSE 0 END), 0)::int AS picked_units,
          COALESCE(SUM(CASE WHEN transaction_type = 'unreserve'
                                 AND reserved_qty_delta IS NOT NULL
                            THEN -reserved_qty_delta ELSE 0 END), 0)::int AS unreserved_units
        FROM inventory.inventory_transactions
        WHERE order_id = ${params.orderId}
          AND order_item_id = ${params.orderItemId}
          AND transaction_type IN ('reserve', 'unreserve', 'pick')
          AND voided_at IS NULL
      `);
      const ledger = ledgerResult?.rows?.[0] ?? {};
      let openQuantity = Math.max(0, Number(ledger.delta_sum ?? 0));

      if (Number(ledger.legacy_reserves ?? 0) > 0) {
        const quantityResult: any = await tx.execute(sql`
          SELECT quantity
          FROM wms.order_items
          WHERE id = ${params.orderItemId}
            AND order_id = ${params.orderId}
        `);
        const orderedQuantity = Number(quantityResult?.rows?.[0]?.quantity ?? 0);
        const legacyEstimate = Math.max(
          0,
          orderedQuantity - Number(ledger.picked_units ?? 0) - Number(ledger.unreserved_units ?? 0),
        );
        openQuantity = Math.max(openQuantity, legacyEstimate);
      }

      const requiredReleaseQuantity = Math.min(remainingRequest, openQuantity);
      let remainingToRelease = requiredReleaseQuantity;
      let releasedQuantity = 0;

      if (remainingToRelease > 0) {
        const levelsResult: any = await tx.execute(sql`
          WITH location_authority AS (
            SELECT
              COALESCE(to_location_id, from_location_id) AS warehouse_location_id,
              GREATEST(COALESCE(SUM(reserved_qty_delta), 0), 0)::int AS attributed_open_quantity,
              BOOL_OR(
                transaction_type = 'reserve' AND reserved_qty_delta IS NULL
              ) AS has_legacy_reserve
            FROM inventory.inventory_transactions
            WHERE order_id = ${params.orderId}
              AND order_item_id = ${params.orderItemId}
              AND transaction_type IN ('reserve', 'unreserve', 'pick')
              AND voided_at IS NULL
              AND COALESCE(to_location_id, from_location_id) IS NOT NULL
            GROUP BY COALESCE(to_location_id, from_location_id)
          )
          SELECT
            level.id,
            level.warehouse_location_id,
            level.reserved_qty,
            authority.attributed_open_quantity,
            authority.has_legacy_reserve
          FROM location_authority authority
          JOIN inventory.inventory_levels level
            ON level.warehouse_location_id = authority.warehouse_location_id
           AND level.product_variant_id = ${productVariantId}
          WHERE level.reserved_qty > 0
            AND (
              authority.attributed_open_quantity > 0
              OR authority.has_legacy_reserve
            )
          ORDER BY authority.attributed_open_quantity DESC, level.reserved_qty DESC, level.id ASC
          FOR UPDATE OF level
        `);

        for (const level of levelsResult?.rows ?? []) {
          if (remainingToRelease <= 0) break;
          const locationOpenQuantity = Boolean(level.has_legacy_reserve)
            ? remainingToRelease
            : Math.max(0, Number(level.attributed_open_quantity ?? 0));
          const releaseQuantity = Math.min(
            remainingToRelease,
            locationOpenQuantity,
            Math.max(0, Number(level.reserved_qty ?? 0)),
          );
          if (releaseQuantity <= 0) continue;

          await this.inventoryCore.releaseReservation({
            productVariantId,
            warehouseLocationId: Number(level.warehouse_location_id),
            qty: releaseQuantity,
            orderId: params.orderId,
            orderItemId: params.orderItemId,
            reason: params.reason,
            userId: params.userId,
            referenceType: "shopify_refund",
            referenceId: sourceEventId,
          }, tx);
          releasedQuantity += releaseQuantity;
          remainingToRelease -= releaseQuantity;
        }
      }

      if (releasedQuantity !== requiredReleaseQuantity) {
        throw new Error(
          `Could not release ${requiredReleaseQuantity} reserved unit(s) for WMS order item ` +
            `${params.orderItemId}; only ${releasedQuantity} unit(s) were attributable to locked inventory levels`,
        );
      }

      return {
        orderId: params.orderId,
        orderItemId: params.orderItemId,
        productVariantId,
        requestedQuantity: params.quantity,
        previouslyReleasedQuantity,
        releasedQuantity,
        openReservationAfter: Math.max(openQuantity - releasedQuantity, 0),
        idempotentReplay: remainingRequest === 0,
      } satisfies ReleaseOrderItemReservationResult;
    });

    if (outcome.releasedQuantity > 0) {
      await this.channelSync.queueSyncAfterInventoryChange(outcome.productVariantId);
    }
    return outcome;
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
   *  2. Force-releases the excess via trimOrphanedReservation (counter + lots + ledger).
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
    orphanedQty?: number,
  ): Promise<{ released: number; reallocated: number; failed: number }> {
    const result = { released: 0, reallocated: 0, failed: 0 };
    let excess = 0;

    if (orphanedQty !== undefined) {
      // If orphanedQty is provided, it means the caller (e.g. adjustInventory)
      // already performed the DB adjustment to reservedQty, so we just log it.
      excess = orphanedQty;
      if (excess <= 0) return result;
    } else {
      // Fallback: Check the DB for orphaned reservations manually
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

      excess = level.reservedQty - currentQty;
      console.log(
        `[RESERVATION] Orphaned reservation detected (fallback): variant=${productVariantId} ` +
          `loc=${warehouseLocationId} reserved=${level.reservedQty} onHand=${level.variantQty} excess=${excess}`,
      );

      // Force-release the excess (counter + lots + ledger, atomically).
      // Replaces a call to a phantom core method that never existed on
      // InventoryUseCases and threw at runtime (audit F8b).
      const trimmed = await this.inventoryCore.trimOrphanedReservation({
        productVariantId,
        warehouseLocationId,
        qty: excess,
        reason: "Orphaned reservation released: inventory count dropped below reserved amount",
        userId,
      });
      result.released = trimmed;
      excess = trimmed;
    }

    if (orphanedQty !== undefined) {
      result.released = excess;
      // Caller already adjusted the counter — record the ledger row here.
      // unreserve rows never change on-hand: variantQtyDelta must be 0
      // (the old -excess here corrupted on-hand ledger replay).
      await this.db.insert(inventoryTransactions).values({
        productVariantId,
        fromLocationId: warehouseLocationId,
        transactionType: "unreserve",
        variantQtyDelta: 0,
        reservedQtyDelta: -excess,
        notes: `Orphaned reservation released: inventory count dropped below reserved amount`,
        userId: userId || null,
      });
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
            console.error(
              JSON.stringify({
                level: "ERROR",
                action: "reallocate_orphaned_reservation",
                outcome: "requires_review",
                productVariantId,
                orderId,
                orderItemId: item.id,
                sku: item.sku,
                warehouseLocationId,
                message: "No ATP available — order stays partially unreserved and needs manual attention",
              }),
            );
          }
        }
      } catch (err) {
        result.failed++;
        console.error(
          JSON.stringify({
            level: "ERROR",
            action: "reallocate_orphaned_reservation",
            outcome: "requires_review",
            productVariantId,
            orderId,
            warehouseLocationId,
            error: err instanceof Error ? err.message : String(err),
            message: "Re-allocation threw — order needs manual review",
          }),
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
