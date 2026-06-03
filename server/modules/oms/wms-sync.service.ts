/**
 * WMS Sync Service — Syncs orders from oms_orders → orders (WMS fulfillment)
 *
 * Provides the missing bridge between OMS ingestion layer and WMS operational layer.
 * After an order is ingested into oms_orders, this service:
 * 1. Maps OMS fields to WMS fields
 * 2. Applies business logic (routing, priority, member enrichment)
 * 3. Reserves inventory
 * 4. Creates WMS order for pick queue
 */

import { db } from "../../db";
import { sql, eq, and, notInArray } from "drizzle-orm";
import { omsOrders, omsOrderLines } from "@shared/schema/oms.schema";
import {
  outboundShipments,
  productLocations,
  productVariants,
  warehouseLocations,
  wmsOrders,
  wmsOrderItems,
} from "@shared/schema";
import type { InsertWmsOrder, InsertWmsOrderItem } from "@shared/schema";
import { omsOrderEvents } from "@shared/schema/oms.schema";
import type { ServiceRegistry } from "../../services";
import { computeSortRank, getShippingBase, resolveSlaDueAt, type ShippingServiceLevel } from "../orders/sort-rank";
import { getSlaCutoffConfig } from "../warehouse/settings.resolver";
import {
  validateOmsOrderFinancials,
  buildWmsOrderFinancialSnapshot,
  buildWmsItemFinancialSnapshot,
} from "./wms-sync-financials";
import {
  createShipmentForOrder,
  linkChildToParentShipment,
  ChildWithoutParentShipmentError,
} from "../wms/create-shipment";
import {
  enqueueShipStationShipmentPushRetry,
  enqueueShipStationSortRankSyncRetry,
} from "./webhook-retry.worker";

type WmsBinLocation = { location: string; zone: string };

async function resolvePrimaryBinLocation(
  database: typeof db,
  variantId: number,
): Promise<WmsBinLocation | null> {
  const [row] = await database
    .select({
      code: warehouseLocations.code,
      warehouseZone: warehouseLocations.zone,
      productZone: productLocations.zone,
    })
    .from(productLocations)
    .innerJoin(
      warehouseLocations,
      eq(productLocations.warehouseLocationId, warehouseLocations.id),
    )
    .where(
      and(
        eq(productLocations.productVariantId, variantId),
        eq(productLocations.isPrimary, 1),
      ),
    )
    .limit(1);

  return row
    ? {
        location: String(row.code),
        zone: row.warehouseZone || row.productZone || "U",
      }
    : null;
}

interface WmsSyncServices {
  inventoryCore: any;
  reservation: any;
  fulfillmentRouter: any;
  shippingEngine?: import("../shipping/engine").ShippingEngine;
  shipStation?: any;
  omsService?: any;
}

const ACTIVE_SORT_RANK_SYNC_STATUSES = new Set([
  "ready",
  "in_progress",
  "partially_shipped",
  "ready_to_ship",
]);

function dateTimeKey(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function slaStatusFor(dueAt: Date | null, now = new Date()): string | null {
  if (!dueAt) return null;
  if (dueAt.getTime() < now.getTime()) return "overdue";
  if (dueAt.getTime() - now.getTime() <= 24 * 60 * 60 * 1000) return "at_risk";
  return "on_time";
}

export class WmsSyncService {
  private services: WmsSyncServices;

  constructor(services: WmsSyncServices) {
    this.services = services;
  }

  /**
   * Sync an OMS order to WMS for fulfillment.
   * Idempotent - safe to call multiple times (checks if already synced).
   *
   * @param omsOrderId - The oms_orders.id to sync
   * @returns The WMS order ID, or null if already synced or failed
   */
  async syncOmsOrderToWms(omsOrderId: number): Promise<number | null> {
    try {
      const omsOrderResult = await db
        .select()
        .from(omsOrders)
        .where(eq(omsOrders.id, omsOrderId))
        .limit(1);

      if (omsOrderResult.length === 0) {
        console.error(`[WMS Sync] OMS order ${omsOrderId} not found`);
        return null;
      }

      const omsOrder = omsOrderResult[0];

      if (this.isFinalOrCancelledOmsOrder(omsOrder)) {
        await this.cancelExistingWmsOrderForFinalOmsOrder(omsOrderId);
        console.log(
          `[WMS Sync] OMS order ${omsOrderId} is ${omsOrder.status}/${omsOrder.financialStatus}; skipped WMS sync`,
        );
        return null;
      }

      // 1. Check if already synced (orders.source_table_id points to oms_orders.id)
      const existingWmsOrder = await db
        .select({
          id: wmsOrders.id,
          warehouseStatus: wmsOrders.warehouseStatus,
        })
        .from(wmsOrders)
        .where(
          and(
            eq(wmsOrders.omsFulfillmentOrderId, String(omsOrderId)),
            eq(wmsOrders.source, 'oms') // Distinguish from legacy shopify orders
          )
        )
        .orderBy(sql`
          CASE
            WHEN ${wmsOrders.warehouseStatus} = 'cancelled' THEN 2
            WHEN ${wmsOrders.warehouseStatus} = 'shipped' THEN 1
            ELSE 0
          END,
          ${wmsOrders.id}
        `)
        .limit(1);

      if (existingWmsOrder.length > 0) {
        const wmsOrderId = existingWmsOrder[0].id;
        const headerRefresh = await this.refreshExistingWmsOrderHeaderFromOms(omsOrder, wmsOrderId);
        const reconciled = await this.reconcileExistingWmsOrderLines(omsOrderId, wmsOrderId);
        console.log(
          `[WMS Sync] Order ${omsOrderId} already synced to WMS (id ${wmsOrderId}); ` +
            `headerRefreshed=${headerRefresh.updated}; promoted=${headerRefresh.promoted}; reconciled ${reconciled.insertedItems} missing item(s)`,
        );

        if (headerRefresh.promoted) {
          try {
            const reserveResult = await this.services.reservation.reserveOrder(wmsOrderId);
            if (reserveResult.failed.length > 0) {
              console.warn(`[WMS Sync] Reservation partial failure after promotion for order ${wmsOrderId}: ${reserveResult.failed.map((f: { sku: string; reason: string }) => `${f.sku}: ${f.reason}`).join(", ")}`);
            }
          } catch (err: any) {
            console.error(`[WMS Sync] Reservation error after promotion for order ${wmsOrderId}: ${err.message}`);
          }
        }

        return wmsOrderId;
      }

      // Defense-in-depth: no WMS order exists for this OMS order. If the OMS
      // order is ALREADY shipped/fulfilled, it was fulfilled outside this WMS
      // (manual/Shopify fulfillment or pre-WMS history). Creating a WMS order
      // now would create a planned shipment and push a DUPLICATE order to the
      // shipping engine for something already shipped. `isFinalOrCancelledOmsOrder`
      // deliberately does NOT include `shipped` (shipped is a success state and
      // must not cancel a legitimately-synced WMS order), so this guard lives
      // only on the create path. Callers (bridge enqueue, backfillUnsynced)
      // already exclude shipped orders; this is the last line of defense if one
      // slips through.
      const omsStatusLower = String(omsOrder.status ?? "").toLowerCase();
      const omsFulfillmentLower = String(omsOrder.fulfillmentStatus ?? "").toLowerCase();
      if (omsStatusLower === "shipped" || omsFulfillmentLower === "fulfilled") {
        console.warn(
          `[WMS Sync] OMS order ${omsOrderId} is ${omsStatusLower}/${omsFulfillmentLower} with no existing WMS order — fulfilled out-of-band; skipping WMS create to avoid a duplicate shipping-engine push`,
        );
        return null;
      }

      // 2. Fetch OMS line items
      const omsLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, omsOrderId));

      if (omsLines.length === 0) {
        console.warn(`[WMS Sync] OMS order ${omsOrderId} has no line items — skipping`);
        return null;
      }

      // Snapshot financials into the WMS row so pushShipment reads cents
      // from wms.orders (WMS-owned push).
      validateOmsOrderFinancials(
        {
          id: omsOrder.id,
          subtotalCents: omsOrder.subtotalCents ?? 0,
          shippingCents: omsOrder.shippingCents ?? 0,
          taxCents: omsOrder.taxCents ?? 0,
          discountCents: omsOrder.discountCents ?? 0,
          totalCents: omsOrder.totalCents ?? 0,
          currency: omsOrder.currency ?? "USD",
        },
        omsLines.map((l) => ({
          id: l.id,
          quantity: l.quantity ?? 0,
          paidPriceCents: (l as any).paidPriceCents ?? 0,
          totalPriceCents: (l as any).totalPriceCents ?? 0,
        })),
      );
      const orderFinancialSnapshot = buildWmsOrderFinancialSnapshot({
        id: omsOrder.id,
        subtotalCents: omsOrder.subtotalCents ?? 0,
        shippingCents: omsOrder.shippingCents ?? 0,
        taxCents: omsOrder.taxCents ?? 0,
        discountCents: omsOrder.discountCents ?? 0,
        totalCents: omsOrder.totalCents ?? 0,
        currency: omsOrder.currency ?? "USD",
      });

      // 3. Check if order has any shippable items
      const hasShippableItems = omsLines.some(line => line.requiresShipping !== false);

      // 4. Map OMS → WMS order fields
      const warehouseStatus = hasShippableItems
        ? this.determineWarehouseStatus(omsOrder)
        : "completed"; // Pure digital/donation/membership → skip pick queue
      const { priority, memberPlanName, memberPlanColor } = await this.determinePriority(omsOrder);
      // Compute SLA due date at sync time so sort_rank includes urgency
      // from the start. Priority: platform ship-by-date -> channel SLA ->
      // partner-profile SLA -> global default.
      const channelShipBy = (omsOrder as any).channelShipByDate as Date | string | null | undefined;
      // No warehouse is assigned at sync time, so this resolves the DEFAULT-row
      // cutoff/tz. Reassignment later triggers a recompute with the real one.
      const syncCutoffConfig = await getSlaCutoffConfig((omsOrder as any).warehouseId ?? null, db);
      const slaDueAt = await resolveSlaDueAt({
        channelId: omsOrder.channelId,
        channelShipByDate: channelShipBy,
        explicitSlaDueAt: (omsOrder as any).slaDueAt ?? null,
        orderPlacedAt: omsOrder.orderedAt,
        createdAt: (omsOrder as any).createdAt,
        timezone: syncCutoffConfig.timezone,
        cutoffLocal: syncCutoffConfig.cutoffLocal,
      }, db);
      const sortRank = computeSortRank({
        priority,
        onHold: false,
        slaDueAt,
        orderPlacedAt: omsOrder.orderedAt,
      });

      const wmsOrderData: InsertWmsOrder = {
        channelId: omsOrder.channelId,
        source: "oms", // Mark as coming from OMS layer
        omsFulfillmentOrderId: String(omsOrderId), // Link back to oms_orders for dedup
        externalOrderId: omsOrder.externalOrderId,
        orderNumber: omsOrder.externalOrderNumber || `OMS-${omsOrderId}`,
        customerName: omsOrder.customerName || omsOrder.shipToName || `Order ${omsOrderId}`,
        customerEmail: omsOrder.customerEmail || null,
        shippingName: omsOrder.shipToName || omsOrder.customerName || null,
        shippingCompany: (omsOrder as any).shipToCompany || null,
        shippingAddress: omsOrder.shipToAddress1 || null,
        shippingAddress2: omsOrder.shipToAddress2 || null,
        shippingCity: omsOrder.shipToCity || null,
        shippingState: omsOrder.shipToState || null,
        shippingPostalCode: omsOrder.shipToZip || null,
        shippingCountry: omsOrder.shipToCountry || "US",
        priority,
        shippingServiceLevel: ((omsOrder as any).shippingServiceLevel as string | null) || "standard",
        memberPlanName,
        memberPlanColor,
        channelShipByDate: channelShipBy ? new Date(channelShipBy as any) : null,
        slaDueAt,
        slaStatus: "on_time",
        sortRank,
        warehouseStatus,
        itemCount: omsLines.length,
        unitCount: omsLines.reduce((sum, line) => sum + (line.quantity || 0), 0),
        orderPlacedAt: omsOrder.orderedAt,
        ...orderFinancialSnapshot,
      };

      // 4. Map line items
      const wmsLineItems: InsertWmsOrderItem[] = [];

      for (const line of omsLines) {
        // Resolve product_variant_id and bin location from catalog
        const variantId = line.productVariantId || null;
        let binLocation: { location: string; zone: string } | null = null;

        if (variantId) {
          try {
            binLocation = await resolvePrimaryBinLocation(db, variantId);
          } catch (err: any) {
            console.warn(`[WMS Sync] Could not resolve bin for variant ${variantId}: ${err?.message ?? err}`);
          }
        }

        // Propagate requiresShipping from OMS (false = donation/membership/digital)
        const itemRequiresShipping = line.requiresShipping !== false;

        // Per-line financial snapshot for WMS-owned push.
        const itemSnapshot = buildWmsItemFinancialSnapshot({
          id: line.id,
          quantity: line.quantity ?? 0,
          paidPriceCents: (line as any).paidPriceCents ?? 0,
          totalPriceCents: (line as any).totalPriceCents ?? 0,
        });

        wmsLineItems.push({
          orderId: 0, // Will be set by createOrderWithItems
          omsOrderLineId: line.id,
          sku: line.sku || "UNKNOWN",
          name: line.title || "Unknown Item",
          quantity: line.quantity || 0,
          pickedQuantity: itemRequiresShipping ? 0 : (line.quantity || 0),
          fulfilledQuantity: itemRequiresShipping ? 0 : (line.quantity || 0),
          status: itemRequiresShipping ? "pending" : "completed",
          location: binLocation?.location || "UNASSIGNED",
          zone: binLocation?.zone || "U",
          productId: variantId, // Temporary mapping to satisfy schema
          requiresShipping: itemRequiresShipping ? 1 : 0,
          ...itemSnapshot,
        });
      }

      // ── C2 Atomic pipeline: steps 5 + 5b + 6 run in one transaction ──
      // Order creation, shipment creation, and inventory reservation are
      // wrapped in a single DB transaction so a crash mid-pipeline never
      // leaves the order in a partially-written state (e.g. order created
      // but no shipment, or shipment created but inventory not reserved).
      // External calls (routing, ShipStation push) happen AFTER the tx
      // commits — they are idempotent and retried by the reconcile sweep.
      const { ordersStorage } = await import("../orders");

      const txResult = await db.transaction(async (tx: any) => {
        // ── C2.0 Concurrency guard (per-OMS-order serialization) ──────
        // Without this, two concurrent invocations of syncOmsOrderToWms
        // for the SAME OMS order (duplicate Shopify webhook, or webhook
        // racing the reconcile sweep) BOTH pass the step-1 "already
        // synced?" check above, BOTH insert a wms.orders row, each gets
        // its own outbound_shipments row, and each pushes its own
        // ShipStation order with a distinct echelon-wms-shp-<id> key →
        // duplicate (or triplicate) SS orders. There is no unique
        // constraint on oms_fulfillment_order_id to catch this at the DB.
        //
        // The advisory xact lock (key space 918407 = OMS→WMS order sync,
        // distinct from 918406 used by createShipmentForOrder) makes the
        // losing caller block here until the winner commits, then the
        // recheck below finds the winner's row and returns it WITHOUT
        // creating a duplicate. Auto-released on commit/rollback.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(918407, ${omsOrderId})`);

        // Authoritative existence recheck under the lock. Mirrors the
        // step-1 fast-path query; this is the one that actually prevents
        // the duplicate when two syncs race.
        const racedWmsOrder = await tx
          .select({ id: wmsOrders.id })
          .from(wmsOrders)
          .where(
            and(
              eq(wmsOrders.omsFulfillmentOrderId, String(omsOrderId)),
              eq(wmsOrders.source, 'oms'),
            ),
          )
          .orderBy(sql`
            CASE
              WHEN ${wmsOrders.warehouseStatus} = 'cancelled' THEN 2
              WHEN ${wmsOrders.warehouseStatus} = 'shipped' THEN 1
              ELSE 0
            END,
            ${wmsOrders.id}
          `)
          .limit(1);
        if (racedWmsOrder.length > 0) {
          return { racedExistingWmsOrderId: Number(racedWmsOrder[0].id) };
        }

        // 5. Create WMS order (writes to orders + order_items)
        const newWmsOrder = await ordersStorage.createOrderWithItems(wmsOrderData, wmsLineItems, tx);

        console.log(`[WMS Sync] Synced OMS order ${omsOrderId} → WMS order ${newWmsOrder.id} (${omsOrder.externalOrderNumber})`);

        // 5b. Create a planned wms.outbound_shipments row with per-item
        // rows. Failure is non-fatal so a broken shipment insert never
        // blocks order sync (the hourly reconcile sweep will retry).
        let shipmentIdForPush: number | null = null;
        if (hasShippableItems) {
          // §6 Commit 14: routing by combined_role.
          const combinedRole =
            (newWmsOrder as any).combinedRole ?? null;
          const combinedGroupId =
            (newWmsOrder as any).combinedGroupId ?? null;

          if (combinedRole === "child" && combinedGroupId != null) {
            // ── Combined child: link to parent's shipment ─────────────
            try {
              const parentResult = await tx.execute(sql`
                SELECT id
                  FROM wms.orders
                 WHERE combined_group_id = ${combinedGroupId}
                   AND combined_role = 'parent'
                 LIMIT 1
              `);
              const parentWmsOrderId = parentResult.rows?.[0]?.id
                ? Number(parentResult.rows[0].id)
                : null;

              if (!parentWmsOrderId) {
                console.warn(
                  `[WMS Sync] Combined child order ${newWmsOrder.id} (group ${combinedGroupId}) has no parent WMS order yet — skipping shipment link (reconcile will retry)`,
                );
              } else {
                const childItems = (await tx
                  .select({
                    id: wmsOrderItems.id,
                    quantity: wmsOrderItems.quantity,
                    productVariantId: wmsOrderItems.productId,
                    requiresShipping: wmsOrderItems.requiresShipping,
                  })
                  .from(wmsOrderItems)
                  .where(eq(wmsOrderItems.orderId, newWmsOrder.id)))
                  .filter((i: any) => i.requiresShipping !== 0);

                const { shipmentId, created } =
                  await linkChildToParentShipment(
                    tx as any,
                    newWmsOrder.id,
                    parentWmsOrderId,
                    omsOrder.channelId ?? null,
                    childItems.map((i: any) => ({
                      id: i.id,
                      quantity: i.quantity ?? 0,
                      productVariantId: i.productVariantId ?? null,
                    })),
                  );
                console.log(
                  `[WMS Sync] Linked combined-child order ${newWmsOrder.id} to parent ${parentWmsOrderId}'s shipment ${shipmentId} (created=${created}); parent owns the SS push`,
                );
              }
            } catch (err: any) {
              if (err instanceof ChildWithoutParentShipmentError) {
                console.warn(
                  `[WMS Sync] Combined child order ${newWmsOrder.id} parent (${err.parentWmsOrderId}) has no shipment yet — reconcile will retry: ${err.message}`,
                );
              } else {
                console.error(
                  `[WMS Sync] Failed to link combined-child order ${newWmsOrder.id} to parent shipment: ${err.message}`,
                );
              }
            }
            shipmentIdForPush = null;
          } else {
            // ── Parent or standalone: create own shipment (C8 path) ──
            try {
              const insertedItems = await tx
                .select({
                  id: wmsOrderItems.id,
                  omsOrderLineId: wmsOrderItems.omsOrderLineId,
                  productVariantId: wmsOrderItems.productId,
                })
                .from(wmsOrderItems)
                .where(eq(wmsOrderItems.orderId, newWmsOrder.id));

              const itemsByOmsLineId = new Map<number, { id: number; productVariantId: number | null }>();
              for (const row of insertedItems) {
                if (row.omsOrderLineId != null) {
                  itemsByOmsLineId.set(row.omsOrderLineId, {
                    id: row.id,
                    productVariantId: row.productVariantId ?? null,
                  });
                }
              }

              const shipmentItemInputs = omsLines
                .filter((line) => line.requiresShipping !== false)
                .map((line) => {
                  const item = itemsByOmsLineId.get(line.id);
                  return item != null
                    ? {
                        id: item.id,
                        quantity: line.quantity ?? 0,
                        productVariantId: item.productVariantId,
                      }
                    : null;
                })
                .filter((x): x is { id: number; quantity: number; productVariantId: number | null } => x !== null);

              const { shipmentId, created } = await createShipmentForOrder(
                tx as any,
                newWmsOrder.id,
                omsOrder.channelId,
                shipmentItemInputs,
                { useXactLock: true },
              );
              shipmentIdForPush = shipmentId;
              console.log(
                `[WMS Sync] ${created ? "Created" : "Reused"} shipment ${shipmentId} for WMS order ${newWmsOrder.id}`,
              );
            } catch (err: any) {
              console.error(
                `[WMS Sync] Failed to create shipment for WMS order ${newWmsOrder.id}: ${err.message}`,
              );
            }
          }
        }

        // 6. Reserve inventory
        if (warehouseStatus === "ready") {
          try {
            const reserveResult = await this.services.reservation.reserveOrder(newWmsOrder.id, undefined, tx);
            if (reserveResult.failed.length > 0) {
              console.warn(`[WMS Sync] Inventory reservation partial failure for order ${newWmsOrder.id}: ${reserveResult.failed.map((f: { sku: string; reason: string }) => `${f.sku}: ${f.reason}`).join(", ")}`);
            }
          } catch (err: any) {
            console.error(`[WMS Sync] Inventory reservation error for order ${newWmsOrder.id}: ${err.message}`);
          }
        }

        return { newWmsOrder, shipmentIdForPush };
      });

      // Concurrency guard tripped: another sync of this same OMS order
      // won the race and already created the WMS order. Reconcile any
      // missing lines against the winner's row and return it — do NOT
      // create a second order or push a second ShipStation order.
      if ((txResult as any).racedExistingWmsOrderId) {
        const racedId = Number((txResult as any).racedExistingWmsOrderId);
        console.warn(
          `[WMS Sync] Concurrent sync race for OMS order ${omsOrderId} — WMS order ${racedId} already created by a parallel sync; reconciling instead of creating a duplicate`,
        );
        try {
          await this.reconcileExistingWmsOrderLines(omsOrderId, racedId);
        } catch (err: any) {
          console.error(
            `[WMS Sync] Reconcile after race for OMS order ${omsOrderId} (WMS ${racedId}) failed: ${err.message}`,
          );
        }
        return racedId;
      }

      // Past the race guard: txResult is the create-path variant.
      const { newWmsOrder, shipmentIdForPush } = txResult as {
        newWmsOrder: { id: number };
        shipmentIdForPush: number | null;
      };

      // 7. Route to warehouse (if routing service exists)
      try {
        await this.services.fulfillmentRouter.routeOrder(newWmsOrder.id);
      } catch (err: any) {
        console.warn(`[WMS Sync] Warehouse routing skipped for order ${newWmsOrder.id}: ${err.message}`);
      }

      // 8. Push to ShipStation via WMS-owned pushShipment path.
      // Push failures never block the sync — reconcile retries.
      // Recheck OMS status: a cancellation webhook may have arrived
      // between step 5 (WMS order creation) and now.
      const engine = this.services.shippingEngine ?? this.services.shipStation;
      if (engine?.isConfigured?.()) {
        if (shipmentIdForPush !== null) {
          const [recheckOms] = await db.select().from(omsOrders).where(eq(omsOrders.id, omsOrderId)).limit(1);
          if (recheckOms && this.isFinalOrCancelledOmsOrder(recheckOms)) {
            console.warn(`[WMS Sync] OMS order ${omsOrderId} cancelled/refunded after WMS creation — skipping engine push, cancelling WMS`);
            await this.cancelExistingWmsOrderForFinalOmsOrder(omsOrderId);
            return newWmsOrder.id;
          }
          try {
            if (this.services.shippingEngine) {
              await this.services.shippingEngine.upsertShipment({ shipmentId: shipmentIdForPush } as any);
            } else {
              await this.services.shipStation.pushShipment(shipmentIdForPush);
            }
            console.log(
              `[WMS Sync] Pushed shipment ${shipmentIdForPush} to ShipStation via pushShipment`,
            );
          } catch (err: any) {
            // Don't block the sync, but do persist a retry immediately.
            // Health/reconciliation is the safety net; this retry row is
            // the hot-path guarantee for transient ShipStation/API/data
            // failures after the WMS shipment row already exists.
            console.error(
              `[WMS Sync] pushShipment failed for shipment ${shipmentIdForPush} (OMS order ${omsOrderId}): ${err.message}`,
            );
            try {
              await enqueueShipStationShipmentPushRetry(
                db,
                shipmentIdForPush,
                err,
              );
            } catch (retryErr: any) {
              console.error(
                `[WMS Sync] failed to enqueue ShipStation retry for shipment ${shipmentIdForPush}: ${retryErr?.message ?? String(retryErr)}`,
              );
            }
          }
        } else {
          console.error(
            `[WMS Sync] No shipment available for OMS order ${omsOrderId} — expected a shipment row to exist for WMS push`,
          );
        }
      }

      return newWmsOrder.id;
    } catch (err: any) {
      console.error(`[WMS Sync] Failed to sync OMS order ${omsOrderId} to WMS: ${err.message}`);
      return null;
    }
  }

  /**
   * Determine WMS warehouse_status based on OMS order state
   */
  private determineWarehouseStatus(omsOrder: typeof omsOrders.$inferSelect): string {
    if (omsOrder.status === "cancelled") return "cancelled";
    if (omsOrder.status === "shipped") return "shipped";
    if (omsOrder.fulfillmentStatus === "fulfilled") return "shipped";
    if (omsOrder.financialStatus === "paid") return "ready";
    return "pending";
  }

  private isFinalOrCancelledOmsOrder(omsOrder: typeof omsOrders.$inferSelect): boolean {
    const status = String(omsOrder.status ?? "").toLowerCase();
    const financialStatus = String(omsOrder.financialStatus ?? "").toLowerCase();
    return (
      status === "cancelled" ||
      status === "refunded" ||
      financialStatus === "refunded" ||
      financialStatus === "voided"
    );
  }

  private hasOpenShippableOmsDemand(lines: Array<typeof omsOrderLines.$inferSelect>): boolean {
    return lines.some((line) => {
      if (line.requiresShipping === false) return false;
      if ((line.quantity ?? 0) <= 0) return false;
      const lineFulfillmentStatus = String(line.fulfillmentStatus ?? "").toLowerCase();
      if (lineFulfillmentStatus === "fulfilled") return false;
      const fulfillableQuantity = line.fulfillableQuantity;
      return fulfillableQuantity == null || fulfillableQuantity > 0;
    });
  }

  private async cancelExistingWmsOrderForFinalOmsOrder(omsOrderId: number): Promise<void> {
    const { cancelOrder: cancelWmsOrder } = await import("../orders/order-status-core");
    const rows: any = await db.execute(sql`
      SELECT id FROM wms.orders
       WHERE (
               (source IN ('oms', 'ebay') AND oms_fulfillment_order_id = ${String(omsOrderId)})
            OR (source = 'shopify'        AND source_table_id        = ${String(omsOrderId)})
             )
         AND warehouse_status NOT IN ('cancelled', 'shipped')
    `);
    for (const row of rows?.rows ?? []) {
      // D-SYNCANCEL: Release inventory reservation before transitioning
      // to cancelled. Without this, reserved units leak permanently.
      try {
        await this.services.reservation.releaseOrderReservation(
          row.id,
          "oms_final_state_cancel",
        );
      } catch (releaseErr: any) {
        console.error(
          `[WMS Sync] Failed to release reservation for WMS order ${row.id} during OMS cancel: ${releaseErr?.message}`,
        );
        try {
          await db.insert(omsOrderEvents).values({
            orderId: omsOrderId,
            eventType: "cancel_release_failed",
            details: {
              wmsOrderId: row.id,
              error: releaseErr?.message ?? String(releaseErr),
              requiresReview: true,
            },
          });
        } catch (_dlErr) {
          // Structured log above is our trace
        }
      }
      await cancelWmsOrder(db, row.id, "oms_final_state_cancel");
    }
  }

  private async refreshExistingWmsOrderHeaderFromOms(
    omsOrder: typeof omsOrders.$inferSelect,
    wmsOrderId: number,
  ): Promise<{ updated: boolean; sortRankChanged: boolean; promoted: boolean }> {
    const [wmsOrder] = await db
      .select({
        id: wmsOrders.id,
        warehouseStatus: wmsOrders.warehouseStatus,
        priority: wmsOrders.priority,
        onHold: wmsOrders.onHold,
        channelShipByDate: wmsOrders.channelShipByDate,
        slaDueAt: wmsOrders.slaDueAt,
        sortRank: wmsOrders.sortRank,
        orderPlacedAt: wmsOrders.orderPlacedAt,
        createdAt: wmsOrders.createdAt,
      })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, wmsOrderId))
      .limit(1);

    if (!wmsOrder || wmsOrder.warehouseStatus === "cancelled") {
      return { updated: false, sortRankChanged: false, promoted: false };
    }

    // Promote pending → ready when OMS order is now paid
    const nextWarehouseStatus = this.determineWarehouseStatus(omsOrder);
    const promoted =
      wmsOrder.warehouseStatus === "pending" && nextWarehouseStatus === "ready";

    const channelShipByDate = (omsOrder as any).channelShipByDate as Date | string | null | undefined;
    const reconcileCutoffConfig = await getSlaCutoffConfig((wmsOrder as any).warehouseId ?? null, db);
    const nextSlaDueAt = await resolveSlaDueAt({
      channelId: omsOrder.channelId,
      channelShipByDate,
      explicitSlaDueAt: null,
      orderPlacedAt: wmsOrder.orderPlacedAt ?? omsOrder.orderedAt,
      createdAt: wmsOrder.createdAt,
      timezone: reconcileCutoffConfig.timezone,
      cutoffLocal: reconcileCutoffConfig.cutoffLocal,
    }, db);
    const nextSortRank = computeSortRank({
      priority: wmsOrder.priority,
      onHold: wmsOrder.onHold,
      slaDueAt: nextSlaDueAt,
      orderPlacedAt: wmsOrder.orderPlacedAt ?? omsOrder.orderedAt ?? wmsOrder.createdAt,
    });
    const nextChannelShipByDate = channelShipByDate ? new Date(channelShipByDate as any) : null;
    const sortRankChanged = wmsOrder.sortRank !== nextSortRank;
    const changed =
      promoted ||
      dateTimeKey(wmsOrder.channelShipByDate) !== dateTimeKey(nextChannelShipByDate) ||
      dateTimeKey(wmsOrder.slaDueAt) !== dateTimeKey(nextSlaDueAt) ||
      sortRankChanged;

    if (!changed) {
      return { updated: false, sortRankChanged: false, promoted: false };
    }

    await db
      .update(wmsOrders)
      .set({
        ...(promoted ? { warehouseStatus: "ready" } : {}),
        channelShipByDate: nextChannelShipByDate,
        slaDueAt: nextSlaDueAt,
        slaStatus: slaStatusFor(nextSlaDueAt),
        sortRank: nextSortRank,
        updatedAt: new Date(),
      })
      .where(eq(wmsOrders.id, wmsOrderId));

    if (promoted) {
      console.log(
        `[WMS Sync] Promoted WMS order ${wmsOrderId} from pending → ready (OMS financial_status=${omsOrder.financialStatus})`,
      );
    }

    if (sortRankChanged && ACTIVE_SORT_RANK_SYNC_STATUSES.has(promoted ? "ready" : String(wmsOrder.warehouseStatus))) {
      await enqueueShipStationSortRankSyncRetry(
        db,
        wmsOrderId,
        "OMS/WMS sync refreshed SLA sort_rank from source order",
      );
    }

    return { updated: true, sortRankChanged, promoted };
  }

  private async reconcileExistingWmsOrderLines(
    omsOrderId: number,
    wmsOrderId: number,
  ): Promise<{ insertedItems: number; updatedShipments: number }> {
    const [omsOrder] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.id, omsOrderId))
      .limit(1);

    if (!omsOrder || this.isFinalOrCancelledOmsOrder(omsOrder)) {
      await this.cancelExistingWmsOrderForFinalOmsOrder(omsOrderId);
      return { insertedItems: 0, updatedShipments: 0 };
    }

    const omsLines = await db.select().from(omsOrderLines).where(eq(omsOrderLines.orderId, omsOrderId));
    if (omsLines.length === 0) return { insertedItems: 0, updatedShipments: 0 };

    const [wmsOrderState] = await db
      .select({
        warehouseStatus: wmsOrders.warehouseStatus,
        channelId: wmsOrders.channelId,
      })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, wmsOrderId))
      .limit(1);

    if (wmsOrderState?.warehouseStatus === "cancelled") {
      return { insertedItems: 0, updatedShipments: 0 };
    }

    if (
      wmsOrderState?.warehouseStatus === "shipped" &&
      !this.hasOpenShippableOmsDemand(omsLines)
    ) {
      return { insertedItems: 0, updatedShipments: 0 };
    }

    const existingItems = await db
      .select({
        id: wmsOrderItems.id,
        omsOrderLineId: wmsOrderItems.omsOrderLineId,
        sku: wmsOrderItems.sku,
        quantity: wmsOrderItems.quantity,
        pickedQuantity: wmsOrderItems.pickedQuantity,
        status: wmsOrderItems.status,
      })
      .from(wmsOrderItems)
      .where(eq(wmsOrderItems.orderId, wmsOrderId));
    const existingOmsLineIds = new Set(
      existingItems.map((item) => item.omsOrderLineId).filter((id): id is number => id != null),
    );
    const missingLines = omsLines.filter((line) => !existingOmsLineIds.has(line.id));

    // Sync cancellations and quantity changes from OMS → WMS.
    // If an OMS line was removed (quantity zeroed) or edited, update the
    // WMS item to match — but only if it hasn't been picked yet.
    const omsLineById = new Map(omsLines.map((line) => [line.id, line]));
    for (const wmsItem of existingItems) {
      if (!wmsItem.omsOrderLineId) continue;
      if (wmsItem.status === "cancelled") continue;

      const omsLine = omsLineById.get(wmsItem.omsOrderLineId);
      const omsQty = omsLine?.quantity ?? 0;
      const wmsQty = wmsItem.quantity ?? 0;

      if (omsQty === wmsQty) continue;

      if (wmsItem.status === "pending" || (wmsItem.pickedQuantity ?? 0) === 0) {
        const updates: Record<string, any> = { quantity: omsQty };
        if (omsQty <= 0) updates.status = "cancelled";
        await db
          .update(wmsOrderItems)
          .set(updates)
          .where(eq(wmsOrderItems.id, wmsItem.id));
        console.log(
          `[WMS Sync] Reconciled item ${wmsItem.sku} (id ${wmsItem.id}): qty ${wmsQty} → ${omsQty}${omsQty <= 0 ? " (cancelled)" : ""}`,
        );
      } else if ((wmsItem.pickedQuantity ?? 0) > 0 && omsQty < (wmsItem.pickedQuantity ?? 0)) {
        console.warn(
          `[WMS Sync] Item ${wmsItem.sku} (id ${wmsItem.id}): OMS qty reduced to ${omsQty} but ${wmsItem.pickedQuantity} already picked — needs manual review`,
        );
      } else if (omsQty !== wmsQty) {
        await db
          .update(wmsOrderItems)
          .set({ quantity: omsQty })
          .where(eq(wmsOrderItems.id, wmsItem.id));
        console.log(
          `[WMS Sync] Reconciled item ${wmsItem.sku} (id ${wmsItem.id}): qty ${wmsQty} → ${omsQty}`,
        );
      }
    }

    const insertedItems: {
      id: number;
      omsOrderLineId: number | null;
      productId: number | null;
      quantity: number;
      requiresShipping: boolean;
    }[] = [];

    for (const line of missingLines) {
      const variantId = line.productVariantId || null;
      let binLocation: { location: string; zone: string } | null = null;
      if (variantId) {
        try {
          binLocation = await resolvePrimaryBinLocation(db, variantId);
        } catch (err: any) {
          console.warn(`[WMS Sync] Could not resolve bin for variant ${variantId}: ${err?.message ?? err}`);
        }
      }

      const itemRequiresShipping = line.requiresShipping !== false;
      const [inserted] = await db
        .insert(wmsOrderItems)
        .values({
          orderId: wmsOrderId,
          omsOrderLineId: line.id,
          sku: line.sku || "UNKNOWN",
          name: line.title || "Unknown Item",
          quantity: line.quantity || 0,
          pickedQuantity: itemRequiresShipping ? 0 : (line.quantity || 0),
          fulfilledQuantity: itemRequiresShipping ? 0 : (line.quantity || 0),
          status: itemRequiresShipping ? "pending" : "completed",
          location: binLocation?.location || "UNASSIGNED",
          zone: binLocation?.zone || "U",
          productId: variantId,
          requiresShipping: itemRequiresShipping ? 1 : 0,
          unitPriceCents: (line as any).paidPriceCents ?? 0,
          paidPriceCents: (line as any).paidPriceCents ?? 0,
          totalPriceCents: (line as any).totalPriceCents ?? 0,
        } as any)
        .returning({
          id: wmsOrderItems.id,
          omsOrderLineId: wmsOrderItems.omsOrderLineId,
          productId: wmsOrderItems.productId,
          quantity: wmsOrderItems.quantity,
          requiresShipping: wmsOrderItems.requiresShipping,
        });
      if (inserted) {
        insertedItems.push({
          ...inserted,
          requiresShipping: Number((inserted as any).requiresShipping ?? 0) !== 0,
        });
      }
    }

    await db.execute(sql`
      UPDATE wms.order_items oi
         SET unit_price_cents = COALESCE(ol.paid_price_cents, 0),
             paid_price_cents = COALESCE(ol.paid_price_cents, 0),
             total_price_cents = COALESCE(ol.total_price_cents, 0)
        FROM oms.oms_order_lines ol
       WHERE oi.order_id = ${wmsOrderId}
         AND oi.oms_order_line_id = ol.id
         AND ol.order_id = ${omsOrderId}
    `);

    const orphanItemResult = await db.execute<{
      id: number;
      oms_order_line_id: number | null;
      product_id: number | null;
      quantity: number;
    }>(sql`
      WITH active_shipment_qty AS (
        SELECT
          osi.order_item_id,
          COALESCE(SUM(osi.qty), 0)::int AS qty
        FROM wms.outbound_shipment_items osi
        JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
        WHERE os.order_id = ${wmsOrderId}
          AND os.status NOT IN ('voided', 'cancelled')
        GROUP BY osi.order_item_id
      )
      SELECT
        oi.id,
        oi.oms_order_line_id,
        oi.product_id,
        GREATEST(
          COALESCE(oi.quantity, 0)
          - GREATEST(
              COALESCE(oi.fulfilled_quantity, 0),
              COALESCE(asq.qty, 0)
            ),
          0
        )::int AS quantity
      FROM wms.order_items oi
      LEFT JOIN active_shipment_qty asq
        ON asq.order_item_id = oi.id
      WHERE oi.order_id = ${wmsOrderId}
        AND COALESCE(oi.requires_shipping, 1) <> 0
        AND oi.status NOT IN ('cancelled')
        AND GREATEST(
          COALESCE(oi.quantity, 0)
          - GREATEST(
              COALESCE(oi.fulfilled_quantity, 0),
              COALESCE(asq.qty, 0)
            ),
          0
        ) > 0
    `);
    const shippableShipmentItems = (orphanItemResult.rows ?? [])
      .map((row) => ({
        id: Number(row.id),
        omsOrderLineId: row.oms_order_line_id == null ? null : Number(row.oms_order_line_id),
        productId: row.product_id == null ? null : Number(row.product_id),
        quantity: Number(row.quantity ?? 0),
      }))
      .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.quantity > 0);

    await db.execute(sql`
      UPDATE wms.orders w
         SET warehouse_status = CASE
               WHEN w.warehouse_status IN ('cancelled', 'shipped') THEN w.warehouse_status
               WHEN EXISTS (
                 SELECT 1
                 FROM wms.order_items pending_items
                 WHERE pending_items.order_id = w.id
                   AND COALESCE(pending_items.requires_shipping, 1) <> 0
                   AND COALESCE(pending_items.quantity, 0) > 0
                   AND COALESCE(pending_items.quantity, 0) > COALESCE(pending_items.fulfilled_quantity, 0)
                   AND pending_items.status NOT IN ('cancelled', 'completed')
               ) THEN 'ready'
               WHEN (
                 SELECT COUNT(*) FROM wms.order_items all_items
                 WHERE all_items.order_id = w.id
               ) = 0 THEN 'cancelled'
               ELSE 'completed'
             END,
             item_count = agg.item_count,
             unit_count = agg.unit_count,
             picked_count = agg.picked_count,
             updated_at = NOW()
        FROM (
          SELECT
            order_id,
            COUNT(*)::int AS item_count,
            COALESCE(SUM(quantity), 0)::int AS unit_count,
            COALESCE(SUM(picked_quantity), 0)::int AS picked_count
          FROM wms.order_items
          WHERE order_id = ${wmsOrderId}
          GROUP BY order_id
        ) agg
       WHERE w.id = agg.order_id
    `);

    if (shippableShipmentItems.length === 0) {
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }

    // Re-check: never create or push shipments for terminal orders.
    const [freshWmsState] = await db
      .select({ warehouseStatus: wmsOrders.warehouseStatus })
      .from(wmsOrders)
      .where(eq(wmsOrders.id, wmsOrderId))
      .limit(1);
    if (freshWmsState?.warehouseStatus === "shipped" || freshWmsState?.warehouseStatus === "cancelled") {
      return { insertedItems: insertedItems.length, updatedShipments: 0 };
    }

    // Shipment reconciliation: three cases based on what already exists.
    const activeShipments = await db
      .select({ id: outboundShipments.id, status: outboundShipments.status })
      .from(outboundShipments)
      .where(and(
        eq(outboundShipments.orderId, wmsOrderId),
        notInArray(outboundShipments.status, ["voided", "cancelled"]),
      ));

    let updatedShipments = 0;

    if (activeShipments.length === 0) {
      // Case A: No shipment exists at all — initial sync must have crashed
      // before creating one. Create a new shipment and push it.
      const created = await createShipmentForOrder(
        db,
        wmsOrderId,
        wmsOrderState?.channelId ?? null,
        shippableShipmentItems.map((item) => ({
          id: item.id,
          quantity: item.quantity ?? 0,
          productVariantId: item.productId,
        })),
      );
      updatedShipments += shippableShipmentItems.length;
      try {
        await enqueueShipStationShipmentPushRetry(
          db,
          created.shipmentId,
          new Error("WMS line reconciliation created shipment (no prior shipment existed)"),
        );
      } catch (err: any) {
        console.error(
          `[WMS Sync] failed to enqueue ShipStation retry for new shipment ${created.shipmentId}: ${err?.message ?? String(err)}`,
        );
      }
    } else {
      // Case B/C: Shipment(s) already exist. Add any missing items to
      // planned shipments (Case B) and re-push. If the shipment is already
      // queued/labeled/shipped (Case C), it's already in ShipStation — no
      // duplicate creation needed.
      const plannedShipments = activeShipments.filter((s) => s.status === "planned");
      for (const shipment of plannedShipments) {
        for (const item of shippableShipmentItems) {
          const line = omsLines.find((candidate) => candidate.id === item.omsOrderLineId);
          if (!line || line.requiresShipping === false) continue;
          const inserted: any = await db.execute(sql`
            INSERT INTO wms.outbound_shipment_items (
              shipment_id,
              order_item_id,
              product_variant_id,
              qty
            )
            SELECT
              ${shipment.id},
              ${item.id},
              ${item.productId},
              ${item.quantity ?? 0}
            WHERE NOT EXISTS (
              SELECT 1
              FROM wms.outbound_shipment_items
              WHERE shipment_id = ${shipment.id}
                AND order_item_id = ${item.id}
            )
            RETURNING id
          `);
          updatedShipments += inserted?.rows?.length ?? 0;
        }
        try {
          await enqueueShipStationShipmentPushRetry(
            db,
            shipment.id,
            new Error("WMS line reconciliation added missing shipment item"),
          );
        } catch (err: any) {
          console.error(
            `[WMS Sync] failed to enqueue ShipStation retry for reconciled shipment ${shipment.id}: ${err?.message ?? String(err)}`,
          );
        }
      }
    }

    return { insertedItems: insertedItems.length, updatedShipments };
  }

  /**
   * Propagate order edits from OMS to WMS after an orders/updated webhook.
   * Diffs OMS line items against WMS order items and applies changes
   * based on the WMS item's pick status.
   */
  async propagateOmsEditsToWms(
    omsOrderId: number,
    shopifyLineItems?: any[],
  ): Promise<{
    updated: number;
    added: number;
    removed: number;
    flaggedForReview: string[];
  }> {
    const LOG = "[WMS Edit Propagation]";
    const result = { updated: 0, added: 0, removed: 0, flaggedForReview: [] as string[] };

    // 1. Find WMS order
    const wmsOrderResult = await db.execute<{
      id: number;
      warehouse_status: string;
    }>(sql`
      SELECT id, warehouse_status FROM wms.orders
      WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(omsOrderId)})
         OR (source = 'shopify' AND source_table_id = ${String(omsOrderId)})
      LIMIT 1
    `);
    if (wmsOrderResult.rows.length === 0) return result;

    const wmsOrderId = wmsOrderResult.rows[0].id;
    const warehouseStatus = wmsOrderResult.rows[0].warehouse_status;

    if (["shipped", "cancelled", "completed"].includes(warehouseStatus)) {
      console.log(`${LOG} Skipping order ${wmsOrderId} — terminal state '${warehouseStatus}'`);
      return result;
    }

    // 2. Current OMS lines (already updated by webhook handler)
    const omsLines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, omsOrderId));

    // 3. Current WMS items
    const wmsItems = await db
      .select()
      .from(wmsOrderItems)
      .where(eq(wmsOrderItems.orderId, wmsOrderId));

    const wmsItemByOmsLineId = new Map(
      wmsItems
        .filter((item) => item.omsOrderLineId != null)
        .map((item) => [item.omsOrderLineId!, item]),
    );
    const omsLineById = new Map(omsLines.map((line) => [line.id, line]));

    // Shopify external line IDs still in the webhook payload
    const shopifyLineIdSet = shopifyLineItems
      ? new Set(shopifyLineItems.map((item: any) => String(item.id)))
      : null;

    const changes: string[] = [];

    // 4. Process existing WMS items — detect qty changes and removals
    for (const wmsItem of wmsItems) {
      if (!wmsItem.omsOrderLineId) continue;
      if (wmsItem.status === "cancelled") continue;

      const omsLine = omsLineById.get(wmsItem.omsOrderLineId);

      // Check if item was removed from Shopify order
      const wasRemoved =
        shopifyLineIdSet &&
        omsLine?.externalLineItemId &&
        !shopifyLineIdSet.has(omsLine.externalLineItemId);

      if (wasRemoved) {
        if (wmsItem.status === "pending") {
          await db
            .update(wmsOrderItems)
            .set({ status: "cancelled" as any, quantity: 0 })
            .where(eq(wmsOrderItems.id, wmsItem.id));
          changes.push(`Cancelled pending item ${wmsItem.sku} (removed from order)`);
          result.removed++;
        } else if (wmsItem.status === "completed" || wmsItem.pickedQuantity > 0) {
          result.flaggedForReview.push(
            `Item ${wmsItem.sku} (id ${wmsItem.id}) removed from order but ${wmsItem.pickedQuantity} already picked — needs manual reversal`,
          );
        }
        continue;
      }

      if (!omsLine) continue;

      const omsQty = omsLine.quantity || 0;
      const wmsQty = wmsItem.quantity;

      if (omsQty === wmsQty) {
        // Qty unchanged — check for SKU/name/variant updates
        const updates: Record<string, any> = {};
        if (omsLine.sku && omsLine.sku !== wmsItem.sku) updates.sku = omsLine.sku;
        if (omsLine.title && omsLine.title !== wmsItem.name)
          updates.name = omsLine.title;
        if (
          omsLine.productVariantId &&
          omsLine.productVariantId !== wmsItem.productId
        ) {
          updates.productId = omsLine.productVariantId;
          const bin = await resolvePrimaryBinLocation(db, omsLine.productVariantId);
          if (bin) {
            updates.location = bin.location;
            updates.zone = bin.zone;
          }
        }

        if (Object.keys(updates).length > 0) {
          await db
            .update(wmsOrderItems)
            .set(updates)
            .where(eq(wmsOrderItems.id, wmsItem.id));
          changes.push(`Updated fields for ${wmsItem.sku}: ${Object.keys(updates).join(", ")}`);
          result.updated++;
        }
        continue;
      }

      // Qty changed
      if (wmsItem.status === "pending" || wmsItem.pickedQuantity === 0) {
        // Not yet picked — safe to update
        const updates: Record<string, any> = { quantity: omsQty };
        if (omsLine.sku && omsLine.sku !== wmsItem.sku) updates.sku = omsLine.sku;
        if (omsLine.title && omsLine.title !== wmsItem.name)
          updates.name = omsLine.title;
        if (
          omsLine.productVariantId &&
          omsLine.productVariantId !== wmsItem.productId
        ) {
          updates.productId = omsLine.productVariantId;
          const bin = await resolvePrimaryBinLocation(db, omsLine.productVariantId);
          if (bin) {
            updates.location = bin.location;
            updates.zone = bin.zone;
          }
        }

        if (omsQty <= 0) {
          updates.status = "cancelled";
        }

        await db
          .update(wmsOrderItems)
          .set(updates)
          .where(eq(wmsOrderItems.id, wmsItem.id));
        changes.push(
          `${wmsItem.sku}: qty ${wmsQty} → ${omsQty}${omsQty <= 0 ? " (cancelled)" : ""}`,
        );
        result.updated++;
      } else if (wmsItem.pickedQuantity > 0) {
        if (omsQty < wmsItem.pickedQuantity) {
          // Qty reduced below what was already picked
          result.flaggedForReview.push(
            `Item ${wmsItem.sku} (id ${wmsItem.id}): qty reduced ${wmsQty} → ${omsQty} but ${wmsItem.pickedQuantity} already picked`,
          );
        } else if (omsQty > wmsQty) {
          // Qty increased — update qty, mark pending so picker picks the rest
          await db
            .update(wmsOrderItems)
            .set({ quantity: omsQty, status: "pending" as any })
            .where(eq(wmsOrderItems.id, wmsItem.id));
          changes.push(
            `${wmsItem.sku}: qty ${wmsQty} → ${omsQty} (${wmsItem.pickedQuantity} already picked, more picks needed)`,
          );
          result.updated++;
        } else {
          // Qty decreased but still >= picked — update qty
          await db
            .update(wmsOrderItems)
            .set({ quantity: omsQty })
            .where(eq(wmsOrderItems.id, wmsItem.id));
          changes.push(`${wmsItem.sku}: qty ${wmsQty} → ${omsQty}`);
          result.updated++;
        }
      }
    }

    // 5. Add new items (OMS lines not yet in WMS)
    for (const omsLine of omsLines) {
      if (wmsItemByOmsLineId.has(omsLine.id)) continue;
      if (!omsLine.quantity || omsLine.quantity <= 0) continue;

      // Skip items already removed from Shopify
      if (
        shopifyLineIdSet &&
        omsLine.externalLineItemId &&
        !shopifyLineIdSet.has(omsLine.externalLineItemId)
      ) {
        continue;
      }

      const variantId = omsLine.productVariantId || null;
      let binLocation: WmsBinLocation | null = null;
      if (variantId) {
        try {
          binLocation = await resolvePrimaryBinLocation(db, variantId);
        } catch (e: any) {
          console.warn(
            `${LOG} Could not resolve bin for variant ${variantId}: ${e.message}`,
          );
        }
      }

      const itemRequiresShipping = omsLine.requiresShipping !== false;
      await db.insert(wmsOrderItems).values({
        orderId: wmsOrderId,
        omsOrderLineId: omsLine.id,
        sku: omsLine.sku || "UNKNOWN",
        name: omsLine.title || "Unknown Item",
        quantity: omsLine.quantity || 0,
        pickedQuantity: itemRequiresShipping ? 0 : (omsLine.quantity || 0),
        fulfilledQuantity: itemRequiresShipping ? 0 : (omsLine.quantity || 0),
        status: itemRequiresShipping ? "pending" : "completed",
        location: binLocation?.location || "UNASSIGNED",
        zone: binLocation?.zone || "U",
        productId: variantId,
        requiresShipping: itemRequiresShipping ? 1 : 0,
        unitPriceCents: (omsLine as any).paidPriceCents ?? 0,
        paidPriceCents: (omsLine as any).paidPriceCents ?? 0,
        totalPriceCents: (omsLine as any).totalPriceCents ?? 0,
      } as any);

      changes.push(`Added new item ${omsLine.sku} (qty ${omsLine.quantity})`);
      result.added++;
    }

    // 6. Recalculate order-level counts
    if (result.updated > 0 || result.added > 0 || result.removed > 0) {
      const updatedItems = await db
        .select()
        .from(wmsOrderItems)
        .where(eq(wmsOrderItems.orderId, wmsOrderId));
      const activeItems = updatedItems.filter(
        (item) => (item.status as string) !== "cancelled",
      );
      const newItemCount = activeItems.filter((i) => i.requiresShipping === 1).length;
      const newUnitCount = activeItems
        .filter((i) => i.requiresShipping === 1)
        .reduce((sum, item) => sum + (item.quantity || 0), 0);
      const newPickedCount = activeItems.reduce(
        (sum, item) => sum + (item.pickedQuantity || 0),
        0,
      );

      await db.execute(sql`
        UPDATE wms.orders SET
          item_count = ${newItemCount},
          unit_count = ${newUnitCount},
          picked_count = ${newPickedCount},
          updated_at = NOW()
        WHERE id = ${wmsOrderId}
      `);

      // Re-reserve inventory (release all then re-reserve for updated items)
      try {
        await this.services.reservation.releaseOrderReservation(
          wmsOrderId,
          "Order edited — re-reserving for updated items",
        );
        await this.services.reservation.reserveOrder(wmsOrderId);
      } catch (e: any) {
        console.warn(`${LOG} Reservation rebalance failed for order ${wmsOrderId}: ${e.message}`);
      }

      // Re-push planned shipments to ShipStation so SS reflects updated items.
      // Only push 'planned' — 'queued'/'labeled' shipments are already in SS
      // and re-pushing would overwrite the SS order (undoing any SS-side
      // splits the operator made).
      const repushEngine = this.services.shippingEngine ?? this.services.shipStation;
      if (repushEngine?.isConfigured?.()) {
        try {
          const activeShipments = await db.execute<{ id: number }>(sql`
            SELECT id FROM wms.outbound_shipments
            WHERE order_id = ${wmsOrderId}
              AND status = 'planned'
            ORDER BY id
          `);
          for (const shipment of activeShipments.rows ?? []) {
            try {
              if (this.services.shippingEngine) {
                await this.services.shippingEngine.upsertShipment({ shipmentId: shipment.id } as any);
              } else {
                await this.services.shipStation.pushShipment(shipment.id);
              }
              console.log(`${LOG} Re-pushed shipment ${shipment.id} to engine after item edit`);
            } catch (pushErr: any) {
              await enqueueShipStationShipmentPushRetry(
                db,
                shipment.id,
                pushErr instanceof Error ? pushErr : new Error(pushErr?.message ?? String(pushErr)),
              );
            }
          }
        } catch (e: any) {
          console.error(`${LOG} Failed to re-push shipments to ShipStation for order ${wmsOrderId}: ${e.message}`);
        }
      }
    }

    // 7. Audit event
    if (result.updated > 0 || result.added > 0 || result.removed > 0 || result.flaggedForReview.length > 0) {
      await db.insert(omsOrderEvents).values({
        orderId: omsOrderId,
        eventType: "wms_edit_propagated",
        details: {
          wmsOrderId,
          warehouseStatus,
          changes,
          flaggedForReview: result.flaggedForReview,
          counts: { updated: result.updated, added: result.added, removed: result.removed },
        },
      });
    }

    if (result.flaggedForReview.length > 0) {
      console.warn(`${LOG} Order ${wmsOrderId} has items requiring review:`, result.flaggedForReview);
    }

    if (warehouseStatus === "picking") {
      console.warn(
        `${LOG} Order ${wmsOrderId} modified while picker is active — picker may have stale data`,
      );
    }

    console.log(
      `${LOG} Order ${wmsOrderId}: ${result.updated} updated, ${result.added} added, ${result.removed} removed, ${result.flaggedForReview.length} flagged`,
    );

    return result;
  }

  /**
   * Determine WMS priority via Composite Score:
   * WMS Priority = (Shipping Speed Base) + (Plan Tier Modifier)
   * Higher score = higher priority in the pick queue.
   * WMS "Bump" override uses 9999; "Hold" uses -1.
   */
  private async determinePriority(omsOrder: typeof omsOrders.$inferSelect): Promise<{
    priority: number;
    memberPlanName: string | null;
    memberPlanColor: string | null;
  }> {
    // 1. Shipping Service Level Base — higher base = picked sooner.
    //    Reads the normalized service_level field, NOT the customer-facing
    //    shipping_method string. The method label is zone-dependent and
    //    unreliable (e.g. "USPS Priority Mail" is a carrier service class,
    //    not a customer-paid expedite).
    //    Base scores are admin-configurable via /pick-priority (warehouse.echelon_settings).
    const level = (((omsOrder as any).shippingServiceLevel as string | null) || "standard") as ShippingServiceLevel;
    const base = await getShippingBase(level, db);

    // 2. Dynamic Tier Modifier + plan metadata snapshot.
    //    Fetches priority_modifier for sort math AND plan name/primary_color
    //    so the picker can render the membership badge without re-joining
    //    on every render. Snapshot is frozen at sync time.
    let modifier = 0;
    let memberPlanName: string | null = null;
    let memberPlanColor: string | null = null;

    try {
      // A member is still entitled to their CURRENT plan's priority modifier
      // until the billing cycle ends. A scheduled downgrade
      // (pending_downgrade) or cancellation (pending_cancellation) does NOT
      // revoke the plan immediately — it applies at cycle end. Matching only
      // status='active' previously dropped these members to a 0 modifier
      // (retail-tier pick priority) the moment they scheduled a change.
      //
      // This is the same entitled-status set used by the membership
      // member_current_membership view and shellz-club's
      // getActiveMemberSubscription(). ORDER BY created_at DESC mirrors the
      // view's "most recent subscription wins" rule so a member with both an
      // active and a pending row resolves deterministically to the latest.
      const result = await db.execute(sql`
        SELECT p.priority_modifier, p.name, p.primary_color
        FROM membership.plans p
        INNER JOIN membership.member_subscriptions ms ON p.id = ms.plan_id
        INNER JOIN membership.members m ON ms.member_id = m.id
        WHERE (m.email = ${omsOrder.customerEmail} OR m.shopify_customer_id = ${omsOrder.rawPayload ? (omsOrder.rawPayload as any).customer?.id : null})
          AND ms.status IN ('active', 'pending_downgrade', 'pending_cancellation')
        ORDER BY ms.created_at DESC
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        modifier = Number(result.rows[0].priority_modifier);
        memberPlanName = (result.rows[0].name as string) || null;
        memberPlanColor = (result.rows[0].primary_color as string) || null;
      } else if (omsOrder.memberTier) {
        const planResult = await db.execute(sql`
          SELECT priority_modifier, name, primary_color FROM membership.plans
          WHERE LOWER(name) = LOWER(${omsOrder.memberTier})
             OR id = ${omsOrder.memberTier}
          LIMIT 1
        `);
        if (planResult.rows.length > 0) {
          modifier = Number(planResult.rows[0].priority_modifier);
          memberPlanName = (planResult.rows[0].name as string) || null;
          memberPlanColor = (planResult.rows[0].primary_color as string) || null;
        }
      }
    } catch (err) {
      console.warn(`[WMS Sync] Failed to fetch priority modifier for order ${omsOrder.id}:`, err);
    }

    // Higher = Better: base + modifier. Leads can manually set 9999 (Bump) or -1 (Hold).
    return {
      priority: base + modifier,
      memberPlanName,
      memberPlanColor,
    };
  }

  /**
   * Batch sync multiple OMS orders to WMS
   */
  async syncBatch(omsOrderIds: number[]): Promise<{ synced: number; failed: number }> {
    let synced = 0;
    let failed = 0;

    for (const id of omsOrderIds) {
      const result = await this.syncOmsOrderToWms(id);
      if (result) {
        synced++;
      } else {
        failed++;
      }
    }

    console.log(`[WMS Sync] Batch sync: ${synced} synced, ${failed} failed`);
    return { synced, failed };
  }

  /**
   * Backfill: Find OMS orders not yet synced to WMS and sync them
   */
  async backfillUnsynced(limit: number = 100): Promise<number> {
    // Existence check MUST mirror the canonical OMS→WMS link used everywhere
    // else (syncOmsOrderToWms:142-162, cancelExistingWmsOrderForFinalOmsOrder:650-651,
    // propagateOmsEditsToWms:1137-1138): the live link is
    // `source='oms' AND oms_fulfillment_order_id = <oms id>`, with the
    // `source='shopify' AND source_table_id = <oms id>` legacy fallback.
    //
    // The previous query checked ONLY `source_table_id = oms id AND source='oms'`,
    // but source_table_id is always NULL for source='oms' rows — so NOT EXISTS
    // was always true, every order looked "unsynced", and `ORDER BY ordered_at
    // DESC LIMIT 100` only ever re-touched the 100 newest (already-synced, no-op).
    // Genuinely-stuck older orders were never reached. (Bug: dead safety net.)
    //
    // Terminal/externally-fulfilled orders are excluded: an order that is
    // already shipped/fulfilled but has NO WMS order was fulfilled outside this
    // WMS (manual/Shopify fulfillment or pre-WMS history). Creating a WMS order
    // for it now would push a DUPLICATE order to the shipping engine.
    const unsynced = await db.execute<{ id: number }>(sql`
      SELECT oo.id
      FROM oms.oms_orders oo
      WHERE NOT EXISTS (
        SELECT 1 FROM wms.orders o
        WHERE (o.source = 'oms'     AND o.oms_fulfillment_order_id = oo.id::text)
           OR (o.source = 'shopify' AND o.source_table_id          = oo.id::text)
      )
      AND oo.status            NOT IN ('cancelled', 'refunded', 'shipped')
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(oo.financial_status, '')   NOT IN ('refunded', 'voided')
      ORDER BY oo.ordered_at ASC
      LIMIT ${limit}
    `);

    const ids = unsynced.rows.map((r) => r.id);
    if (ids.length === 0) {
      console.log(`[WMS Sync] No unsynced orders found`);
      return 0;
    }

    const result = await this.syncBatch(ids);
    return result.synced;
  }

  /**
   * Resync items for an existing WMS order from its OMS source.
   * Use when a WMS order has 0 items or stale/wrong items.
   * WARNING: deletes all existing order_items for the WMS order, re-creates from OMS.
   */
  async resyncOrderItems(wmsOrderId: number): Promise<{ success: boolean; message: string; itemCount?: number }> {
    try {
      // 1. Find the WMS order
      const [wmsOrder] = await db.select().from(wmsOrders).where(eq(wmsOrders.id, wmsOrderId)).limit(1);
      if (!wmsOrder) return { success: false, message: `WMS order ${wmsOrderId} not found` };

      const omsOrderId = wmsOrder.omsFulfillmentOrderId ? parseInt(wmsOrder.omsFulfillmentOrderId, 10) : null;
      if (!omsOrderId) return { success: false, message: `WMS order ${wmsOrderId} has no OMS source link` };

      // 2. Fetch fresh OMS lines
      const omsLines = await db.select().from(omsOrderLines).where(eq(omsOrderLines.orderId, omsOrderId));
      if (omsLines.length === 0) return { success: false, message: `OMS order ${omsOrderId} has no line items` };

      // 3. Delete existing WMS order items
      await db.delete(wmsOrderItems).where(eq(wmsOrderItems.orderId, wmsOrderId));

      // 4. Re-create items from OMS
      const newItems: InsertWmsOrderItem[] = [];
      for (const line of omsLines) {
        const variantId = line.productVariantId || null;
        let binLocation: { location: string; zone: string } | null = null;
        if (variantId) {
          try {
            binLocation = await resolvePrimaryBinLocation(db, variantId);
          } catch (err: any) {
            console.warn(`[WMS Resync] Could not resolve bin for variant ${variantId}: ${err?.message ?? err}`);
          }
        }
        const itemRequiresShipping = line.requiresShipping !== false;
        newItems.push({
          orderId: wmsOrderId,
          omsOrderLineId: line.id,
          sku: line.sku || 'UNKNOWN',
          name: line.title || 'Unknown Item',
          quantity: line.quantity || 0,
          pickedQuantity: itemRequiresShipping ? 0 : (line.quantity || 0),
          fulfilledQuantity: itemRequiresShipping ? 0 : (line.quantity || 0),
          status: itemRequiresShipping ? 'pending' : 'completed',
          location: binLocation?.location || 'UNASSIGNED',
          zone: binLocation?.zone || 'U',
          productId: variantId,
          requiresShipping: itemRequiresShipping ? 1 : 0,
        });
      }

      if (newItems.length > 0) {
        await db.insert(wmsOrderItems).values(newItems);
      }

      // 5. Recalculate order counts
      const { ordersStorage } = await import('../orders');
      await ordersStorage.updateOrderProgress(wmsOrderId);

      console.log(`[WMS Resync] Resynced ${newItems.length} items for WMS order ${wmsOrderId} (OMS ${omsOrderId})`);
      return { success: true, message: `Resynced ${newItems.length} items`, itemCount: newItems.length };
    } catch (err: any) {
      console.error(`[WMS Resync] Failed for WMS order ${wmsOrderId}: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * Find and repair WMS orders with broken items (0 items, or mismatch with OMS)
   */
  async repairBrokenOrders(dryRun = true): Promise<{ ordersFixed: number; ordersFailed: number; details: any[] }> {
    // Find WMS orders linked to OMS where item counts don't match
    const broken = await db.execute<{ wms_id: number; wms_order_number: string; wms_item_count: number; oms_line_count: number; oms_order_id: number }>(sql`
      SELECT 
        o.id as wms_id,
        o.order_number as wms_order_number,
        COUNT(oi.id) as wms_item_count,
        oms_counts.line_count as oms_line_count,
        oms_counts.oms_id as oms_order_id
      FROM wms.orders o
      LEFT JOIN wms.order_items oi ON oi.order_id = o.id
      JOIN (
        SELECT oo.id as oms_id, oo.external_order_number, COUNT(ol.id) as line_count
        FROM oms.oms_orders oo
        LEFT JOIN oms_order_lines ol ON ol.order_id = oo.id
        GROUP BY oo.id, oo.external_order_number
      ) oms_counts ON oms_counts.external_order_number = o.order_number
      WHERE o.source = 'oms'
        AND o.warehouse_status NOT IN ('shipped', 'cancelled')
      GROUP BY o.id, o.order_number, oms_counts.line_count, oms_counts.oms_id
      HAVING COUNT(oi.id) != oms_counts.line_count
      ORDER BY o.id DESC
    `);

    const details: any[] = [];
    let ordersFixed = 0;
    let ordersFailed = 0;

    for (const row of broken.rows) {
      const detail: any = {
        wmsOrderId: row.wms_id,
        orderNumber: row.wms_order_number,
        wmsItemCount: Number(row.wms_item_count),
        omsLineCount: Number(row.oms_line_count),
        action: dryRun ? 'dry_run' : 'pending',
      };

      if (!dryRun) {
        const result = await this.resyncOrderItems(row.wms_id);
        detail.action = result.success ? 'fixed' : 'failed';
        detail.message = result.message;
        if (result.success) ordersFixed++; else ordersFailed++;
      }
      details.push(detail);
    }

    return { ordersFixed, ordersFailed, details };
  }

}
