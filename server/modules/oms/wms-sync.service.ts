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
import { sql, eq, and } from "drizzle-orm";
import { omsOrders, omsOrderLines } from "@shared/schema/oms.schema";
import { wmsOrders, wmsOrderItems } from "@shared/schema";
import type { InsertWmsOrder, InsertWmsOrderItem } from "@shared/schema";
import type { ServiceRegistry } from "../../services";
import { computeSortRank, getShippingBase, type ShippingServiceLevel } from "../orders/sort-rank";
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

// Feature flag: gates §6 Commit 7 behavior (financial snapshot at
// OMS→WMS sync). Default false; new wms.orders / wms.order_items cents
// columns stay at schema defaults (0 / 'USD') until flipped on.
const WMS_FINANCIAL_SNAPSHOT = process.env.WMS_FINANCIAL_SNAPSHOT === "true";

// Feature flag: gates §6 Commit 8 (creation of a wms.outbound_shipments
// row + per-item wms.outbound_shipment_items rows at sync time). Default
// false — when off, no shipment rows are written by the sync path and
// downstream Group C/D/E handlers continue to use whatever legacy
// creation path they relied on. Flip on once Group C is wired.
const WMS_SHIPMENT_AT_SYNC = process.env.WMS_SHIPMENT_AT_SYNC === "true";

// Feature flag: gates §6 Commit 12 (route WMS sync's ShipStation push
// through pushShipment(shipmentId) which reads WMS only + validates).
// Default false. Requires WMS_SHIPMENT_AT_SYNC=true to work, because
// pushShipment needs a shipment row to exist.
const PUSH_FROM_WMS = process.env.PUSH_FROM_WMS === "true";

interface WmsSyncServices {
  inventoryCore: any;
  reservation: any;
  fulfillmentRouter: any;
  shipStation?: any;
  omsService?: any;
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
      // 1. Check if already synced (orders.source_table_id points to oms_orders.id)
      const existingWmsOrder = await db
        .select({ id: wmsOrders.id })
        .from(wmsOrders)
        .where(
          and(
            eq(wmsOrders.omsFulfillmentOrderId, String(omsOrderId)),
            eq(wmsOrders.source, 'oms') // Distinguish from legacy shopify orders
          )
        )
        .limit(1);

      if (existingWmsOrder.length > 0) {
        console.log(`[WMS Sync] Order ${omsOrderId} already synced to WMS (id ${existingWmsOrder[0].id})`);
        return existingWmsOrder[0].id;
      }

      // 2. Fetch OMS order + line items
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

      const omsLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, omsOrderId));

      if (omsLines.length === 0) {
        console.warn(`[WMS Sync] OMS order ${omsOrderId} has no line items — skipping`);
        return null;
      }

      // §6 Commit 7: optionally snapshot financials into the WMS row.
      // Flag-gated so existing behavior is preserved until we flip it on.
      let orderFinancialSnapshot:
        | ReturnType<typeof buildWmsOrderFinancialSnapshot>
        | undefined;
      if (WMS_FINANCIAL_SNAPSHOT) {
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
        orderFinancialSnapshot = buildWmsOrderFinancialSnapshot({
          id: omsOrder.id,
          subtotalCents: omsOrder.subtotalCents ?? 0,
          shippingCents: omsOrder.shippingCents ?? 0,
          taxCents: omsOrder.taxCents ?? 0,
          discountCents: omsOrder.discountCents ?? 0,
          totalCents: omsOrder.totalCents ?? 0,
          currency: omsOrder.currency ?? "USD",
        });
      }

      // 3. Check if order has any shippable items
      const hasShippableItems = omsLines.some(line => line.requiresShipping !== false);

      // 4. Map OMS → WMS order fields
      const warehouseStatus = hasShippableItems
        ? this.determineWarehouseStatus(omsOrder)
        : "completed"; // Pure digital/donation/membership → skip pick queue
      const { priority, memberPlanName, memberPlanColor } = await this.determinePriority(omsOrder);
      // Prefer platform ship-by-date over any channel-default SLA for the
      // sort_rank SLA slot. sla-monitor will also set sla_due_at later,
      // but we compute sort_rank now so new orders are ranked correctly
      // the moment they land in WMS.
      const channelShipBy = (omsOrder as any).channelShipByDate as Date | string | null | undefined;
      const sortRank = computeSortRank({
        priority,
        onHold: false,
        slaDueAt: channelShipBy ?? (omsOrder as any).slaDueAt ?? null,
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
        shippingAddress: omsOrder.shipToAddress1 || null,
        shippingCity: omsOrder.shipToCity || null,
        shippingState: omsOrder.shipToState || null,
        shippingPostalCode: omsOrder.shipToZip || null,
        shippingCountry: omsOrder.shipToCountry || "US",
        priority,
        shippingServiceLevel: ((omsOrder as any).shippingServiceLevel as string | null) || "standard",
        memberPlanName,
        memberPlanColor,
        channelShipByDate: channelShipBy ? new Date(channelShipBy as any) : null,
        sortRank,
        warehouseStatus,
        itemCount: omsLines.length,
        unitCount: omsLines.reduce((sum, line) => sum + (line.quantity || 0), 0),
        orderPlacedAt: omsOrder.orderedAt,
        ...(orderFinancialSnapshot ?? {}),
      };

      // 4. Map line items
      const wmsLineItems: InsertWmsOrderItem[] = [];

      for (const line of omsLines) {
        // Resolve product_variant_id and bin location from catalog
        const variantId = line.productVariantId || null;
        let binLocation: { location: string; zone: string } | null = null;

        if (variantId) {
          try {
            const res = await db.execute<{ code: string; zone_id: number | null }>(sql`
              SELECT wl.code, wl.zone_id
              FROM product_locations pl
              JOIN warehouse_locations wl ON pl.warehouse_location_id = wl.id
              WHERE pl.product_variant_id = ${variantId} AND pl.is_primary = 1
              LIMIT 1
            `);
            if (res.rows.length > 0) {
              binLocation = { location: String(res.rows[0].code), zone: res.rows[0].zone_id ? String(res.rows[0].zone_id) : "U" };
            }
          } catch (err) {
            console.warn(`[WMS Sync] Could not resolve bin for variant ${variantId}`);
          }
        }

        // Propagate requiresShipping from OMS (false = donation/membership/digital)
        const itemRequiresShipping = line.requiresShipping !== false;

        // §6 Commit 7: optional per-line financial snapshot. When flag is
        // off the spread is a no-op and schema defaults (0) take effect.
        const itemSnapshot = WMS_FINANCIAL_SNAPSHOT
          ? buildWmsItemFinancialSnapshot({
              id: line.id,
              quantity: line.quantity ?? 0,
              paidPriceCents: (line as any).paidPriceCents ?? 0,
              totalPriceCents: (line as any).totalPriceCents ?? 0,
            })
          : undefined;

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
          ...(itemSnapshot ?? {}),
        });
      }

      // 5. Create WMS order (writes to orders + order_items)
      const { ordersStorage } = await import("../orders");
      const newWmsOrder = await ordersStorage.createOrderWithItems(wmsOrderData, wmsLineItems);

      console.log(`[WMS Sync] Synced OMS order ${omsOrderId} → WMS order ${newWmsOrder.id} (${omsOrder.externalOrderNumber})`);

      // 5b. §6 Commit 8 — create a planned wms.outbound_shipments row
      // with per-item rows. Flag-gated; failure is non-fatal so a
      // broken shipment insert never blocks order sync (the hourly
      // reconcile sweep in Group H will retry).
      // Captured outside the try/catch so step 8 (push) can pass it to
      // pushShipment when PUSH_FROM_WMS is on. Stays null if the flag is
      // off or shipment creation failed — in either case step 8 falls
      // back to the legacy pushOrder path.
      let shipmentIdForPush: number | null = null;
      if (WMS_SHIPMENT_AT_SYNC) {
        // §6 Commit 14: routing by combined_role.
        //
        // `combined_group_id` + `combined_role` live on the WMS
        // `orders` row (not on oms_orders). In the normal first-sync
        // flow they're NULL and we fall through to the
        // parent/standalone branch — behavior matches C8. They're
        // only non-null here if combining ran before this sync
        // re-fired (rare but legal: retries, backfill sweeps, manual
        // re-syncs), in which case we must NOT create a second
        // SS-facing shipment for the child and must link to the
        // parent instead.
        const combinedRole =
          (newWmsOrder as any).combinedRole ?? null;
        const combinedGroupId =
          (newWmsOrder as any).combinedGroupId ?? null;

        if (combinedRole === "child" && combinedGroupId != null) {
          // ── Combined child: link to parent's shipment ─────────────
          // Per plan §6 C14, children do NOT push independently —
          // parent's push covers the physical shipment. So we leave
          // `shipmentIdForPush = null` regardless of outcome; Group
          // H reconcile keeps the child's state in lockstep with the
          // parent's.
          try {
            const parentResult = await db.execute<{ id: number }>(sql`
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
              // Race: the parent WMS row isn't there yet. Not fatal
              // — reconcile (Group H / C15) retries once the parent
              // lands. Log loudly so ops can spot runaway groups.
              console.warn(
                `[WMS Sync] Combined child order ${newWmsOrder.id} (group ${combinedGroupId}) has no parent WMS order yet — skipping shipment link (reconcile will retry)`,
              );
            } else {
              // Fetch the child's own wms.order_items (not the
              // parent's) — per-order finance / Shopify fulfillment
              // semantics require the child's own items on the
              // child's shipment row.
              const childItems = await db
                .select({
                  id: wmsOrderItems.id,
                  quantity: wmsOrderItems.quantity,
                })
                .from(wmsOrderItems)
                .where(eq(wmsOrderItems.orderId, newWmsOrder.id));

              const { shipmentId, created } =
                await linkChildToParentShipment(
                  db as any,
                  newWmsOrder.id,
                  parentWmsOrderId,
                  omsOrder.channelId ?? null,
                  childItems.map((i) => ({
                    id: i.id,
                    quantity: i.quantity ?? 0,
                  })),
                );
              console.log(
                `[WMS Sync] Linked combined-child order ${newWmsOrder.id} to parent ${parentWmsOrderId}'s shipment ${shipmentId} (created=${created}); PUSH_FROM_WMS skipped — parent owns the SS push`,
              );
            }
          } catch (err: any) {
            if (err instanceof ChildWithoutParentShipmentError) {
              // Parent WMS row exists but has no shipment yet —
              // another race window. Let reconcile retry.
              console.warn(
                `[WMS Sync] Combined child order ${newWmsOrder.id} parent (${err.parentWmsOrderId}) has no shipment yet — reconcile will retry: ${err.message}`,
              );
            } else {
              console.error(
                `[WMS Sync] Failed to link combined-child order ${newWmsOrder.id} to parent shipment: ${err.message}`,
              );
            }
            // Non-fatal in either case.
          }
          // Explicit: children never drive an independent SS push.
          // Parent's push is the one that creates the SS order; pushing
          // the child would duplicate it.
          shipmentIdForPush = null;
        } else {
          // ── Parent or standalone: create own shipment (C8 path) ──
          try {
            // createOrderWithItems does not return per-item ids, so we
            // query them back keyed on oms_order_line_id — the sync
            // path guarantees a 1:1 pairing between omsLines and the
            // just-inserted wms.order_items rows.
            const insertedItems = await db
              .select({ id: wmsOrderItems.id, omsOrderLineId: wmsOrderItems.omsOrderLineId })
              .from(wmsOrderItems)
              .where(eq(wmsOrderItems.orderId, newWmsOrder.id));

            const itemsByOmsLineId = new Map<number, number>();
            for (const row of insertedItems) {
              if (row.omsOrderLineId != null) itemsByOmsLineId.set(row.omsOrderLineId, row.id);
            }

            const shipmentItemInputs = omsLines
              .map((line) => {
                const id = itemsByOmsLineId.get(line.id);
                return id != null
                  ? { id, quantity: line.quantity ?? 0 }
                  : null;
              })
              .filter((x): x is { id: number; quantity: number } => x !== null);

            const { shipmentId, created } = await createShipmentForOrder(
              db as any,
              newWmsOrder.id,
              omsOrder.channelId,
              shipmentItemInputs,
            );
            shipmentIdForPush = shipmentId;
            console.log(
              `[WMS Sync] ${created ? "Created" : "Reused"} shipment ${shipmentId} for WMS order ${newWmsOrder.id}`,
            );
          } catch (err: any) {
            console.error(
              `[WMS Sync] Failed to create shipment for WMS order ${newWmsOrder.id}: ${err.message}`,
            );
            // Non-fatal: order synced, shipment creation can be retried
            // by the reconcile sweep (Group H). Don't block the sync.
          }
        }
      }

      // 6. Reserve inventory
      if (warehouseStatus === "ready") {
        try {
          const reserveResult = await this.services.reservation.reserveForOrder(newWmsOrder.id);
          if (!reserveResult.success) {
            console.warn(`[WMS Sync] Inventory reservation failed for order ${newWmsOrder.id}: ${reserveResult.issues?.join(", ")}`);
          }
        } catch (err: any) {
          console.error(`[WMS Sync] Inventory reservation error for order ${newWmsOrder.id}: ${err.message}`);
        }
      }

      // 7. Route to warehouse (if routing service exists)
      try {
        await this.services.fulfillmentRouter.routeOrder(newWmsOrder.id);
      } catch (err: any) {
        console.warn(`[WMS Sync] Warehouse routing skipped for order ${newWmsOrder.id}: ${err.message}`);
      }

      // 8. Push to ShipStation (originates from WMS, not OMS)
      // Plan §6 Commit 12: when PUSH_FROM_WMS is on AND a shipment row
      // was created in step 5b, push via the new pushShipment(shipmentId)
      // path which reads WMS only and validates. Otherwise fall back to
      // the legacy pushOrder(omsOrder) path. Push failures never block
      // the sync — Group H reconcile retries.
      if (this.services.shipStation?.isConfigured()) {
        if (PUSH_FROM_WMS && shipmentIdForPush !== null) {
          // New path (plan §6 C12): push via WMS-only pushShipment.
          try {
            await this.services.shipStation.pushShipment(shipmentIdForPush);
            console.log(
              `[WMS Sync] Pushed shipment ${shipmentIdForPush} to ShipStation via pushShipment (PUSH_FROM_WMS=true)`,
            );
          } catch (err: any) {
            // Don't block the sync — reconcile will retry the push.
            console.error(
              `[WMS Sync] pushShipment failed for shipment ${shipmentIdForPush} (OMS order ${omsOrderId}): ${err.message}`,
            );
          }
        } else {
          // Legacy path: push via pushOrder reading OMS.
          if (PUSH_FROM_WMS && shipmentIdForPush === null) {
            console.log(
              `[WMS Sync] PUSH_FROM_WMS enabled but no shipmentId available for OMS order ${omsOrderId} — using legacy path`,
            );
          }
          try {
            // Fetch full OMS order with lines for ShipStation payload
            const omsService = this.services.omsService;
            if (omsService) {
              const fullOmsOrder = await omsService.getOrderById(omsOrderId);
              if (fullOmsOrder) {
                await this.services.shipStation.pushOrder(fullOmsOrder);
                console.log(`[WMS Sync] Pushed OMS order ${omsOrderId} to ShipStation (legacy pushOrder)`);
              } else {
                console.warn(`[WMS Sync] Could not fetch OMS order ${omsOrderId} for ShipStation push`);
              }
            }
          } catch (err: any) {
            console.error(`[WMS Sync] ShipStation push failed for OMS order ${omsOrderId}: ${err.message}`);
          }
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
      const result = await db.execute(sql`
        SELECT p.priority_modifier, p.name, p.primary_color
        FROM membership.plans p
        INNER JOIN membership.member_subscriptions ms ON p.id = ms.plan_id
        INNER JOIN membership.members m ON ms.member_id = m.id
        WHERE (m.email = ${omsOrder.customerEmail} OR m.shopify_customer_id = ${omsOrder.rawPayload ? (omsOrder.rawPayload as any).customer?.id : null})
          AND ms.status = 'active'
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
    const unsynced = await db.execute<{ id: number }>(sql`
      SELECT oo.id 
      FROM oms.oms_orders oo
      WHERE NOT EXISTS (
        SELECT 1 FROM wms.orders o
        WHERE o.source_table_id = oo.id::text
          AND o.source = 'oms'
      )
      AND oo.status NOT IN ('cancelled')
      ORDER BY oo.ordered_at DESC
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
            const res = await db.execute<{ code: string; zone_id: number | null }>(sql`
              SELECT wl.code, wl.zone_id
              FROM product_locations pl
              JOIN warehouse_locations wl ON pl.warehouse_location_id = wl.id
              WHERE pl.product_variant_id = ${variantId} AND pl.is_primary = 1
              LIMIT 1
            `);
            if (res.rows.length > 0) {
              binLocation = { location: String(res.rows[0].code), zone: res.rows[0].zone_id ? String(res.rows[0].zone_id) : "U" };
            }
          } catch {}
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
