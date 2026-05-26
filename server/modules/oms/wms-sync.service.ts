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
import { computeSortRank, getShippingBase, getSlaDefaultDays, type ShippingServiceLevel } from "../orders/sort-rank";
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
import { enqueueShipStationShipmentPushRetry } from "./webhook-retry.worker";

type WmsBinLocation = { location: string; zone: string };

function addBusinessDays(date: Date, days: number): Date {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (result.getDay() !== 0 && result.getDay() !== 6) added++;
  }
  result.setHours(17, 0, 0, 0);
  return result;
}

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
        const reconciled = await this.reconcileExistingWmsOrderLines(omsOrderId, wmsOrderId);
        console.log(
          `[WMS Sync] Order ${omsOrderId} already synced to WMS (id ${wmsOrderId}); reconciled ${reconciled.insertedItems} missing item(s)`,
        );
        return wmsOrderId;
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
      // from the start. Priority: platform ship-by-date → channel partner
      // profile sla_days → global sla_default_days.
      const channelShipBy = (omsOrder as any).channelShipByDate as Date | string | null | undefined;
      let slaDueAt: Date | string | null = channelShipBy ?? (omsOrder as any).slaDueAt ?? null;
      if (!slaDueAt) {
        let slaDays = await getSlaDefaultDays(db).catch(() => 3);
        if (omsOrder.channelId) {
          try {
            const profileResult: any = await db.execute(sql`
              SELECT sla_days FROM channels.partner_profiles
              WHERE channel_id = ${omsOrder.channelId}
              LIMIT 1
            `);
            const profileSlaDays = Number(profileResult?.rows?.[0]?.sla_days);
            if (Number.isFinite(profileSlaDays) && profileSlaDays > 0) {
              slaDays = profileSlaDays;
            }
          } catch {}
        }
        const placedAt = omsOrder.orderedAt ? new Date(omsOrder.orderedAt) : new Date();
        slaDueAt = addBusinessDays(placedAt, slaDays);
      }
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
        slaDueAt: slaDueAt instanceof Date ? slaDueAt : slaDueAt ? new Date(slaDueAt) : null,
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

      // 5. Create WMS order (writes to orders + order_items)
      const { ordersStorage } = await import("../orders");
      const newWmsOrder = await ordersStorage.createOrderWithItems(wmsOrderData, wmsLineItems);

      console.log(`[WMS Sync] Synced OMS order ${omsOrderId} → WMS order ${newWmsOrder.id} (${omsOrder.externalOrderNumber})`);

      // 5b. Create a planned wms.outbound_shipments row with per-item
      // rows. Failure is non-fatal so a broken shipment insert never
      // blocks order sync (the hourly reconcile sweep will retry).
      let shipmentIdForPush: number | null = null;
      if (hasShippableItems) {
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
              const childItems = (await db
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
                  db as any,
                  newWmsOrder.id,
                  parentWmsOrderId,
                  omsOrder.channelId ?? null,
                  childItems.map((i) => ({
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

      // 8. Push to ShipStation via WMS-owned pushShipment path.
      // Push failures never block the sync — reconcile retries.
      if (this.services.shipStation?.isConfigured()) {
        if (shipmentIdForPush !== null) {
          try {
            await this.services.shipStation.pushShipment(shipmentIdForPush);
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
    await db.execute(sql`
      UPDATE wms.orders
         SET warehouse_status = 'cancelled',
             cancelled_at = COALESCE(cancelled_at, NOW()),
             updated_at = NOW()
       WHERE source = 'oms'
         AND oms_fulfillment_order_id = ${String(omsOrderId)}
         AND warehouse_status NOT IN ('cancelled', 'shipped')
    `);
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
      .select({ omsOrderLineId: wmsOrderItems.omsOrderLineId })
      .from(wmsOrderItems)
      .where(eq(wmsOrderItems.orderId, wmsOrderId));
    const existingOmsLineIds = new Set(
      existingItems.map((item) => item.omsOrderLineId).filter((id): id is number => id != null),
    );
    const missingLines = omsLines.filter((line) => !existingOmsLineIds.has(line.id));

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
               WHEN w.warehouse_status IN ('cancelled') THEN w.warehouse_status
               WHEN EXISTS (
                 SELECT 1
                 FROM wms.order_items pending_items
                 WHERE pending_items.order_id = w.id
                   AND COALESCE(pending_items.requires_shipping, 1) <> 0
                   AND COALESCE(pending_items.quantity, 0) > COALESCE(pending_items.fulfilled_quantity, 0)
                   AND pending_items.status NOT IN ('cancelled', 'completed')
               ) THEN 'ready'
               ELSE w.warehouse_status
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

    const plannedShipments = await db
      .select({ id: outboundShipments.id })
      .from(outboundShipments)
      .where(and(eq(outboundShipments.orderId, wmsOrderId), eq(outboundShipments.status, "planned")));
    let updatedShipments = 0;
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

    if (updatedShipments === 0) {
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
          new Error("WMS line reconciliation created shipment for added order item"),
        );
      } catch (err: any) {
        console.error(
          `[WMS Sync] failed to enqueue ShipStation retry for reconciled shipment ${created.shipmentId}: ${err?.message ?? String(err)}`,
        );
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
      if (this.services.shipStation?.isConfigured()) {
        try {
          const activeShipments = await db.execute<{ id: number }>(sql`
            SELECT id FROM wms.outbound_shipments
            WHERE order_id = ${wmsOrderId}
              AND status = 'planned'
            ORDER BY id
          `);
          for (const shipment of activeShipments.rows ?? []) {
            try {
              await this.services.shipStation.pushShipment(shipment.id);
              console.log(`${LOG} Re-pushed shipment ${shipment.id} to ShipStation after item edit`);
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
