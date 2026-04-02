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
import { orders as wmsOrders, orderItems } from "@shared/schema";
import type { InsertOrder, InsertOrderItem } from "@shared/schema";
import type { ServiceRegistry } from "../../services";

interface WmsSyncServices {
  inventoryCore: any;
  reservation: any;
  fulfillmentRouter: any;
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
            eq(wmsOrders.sourceTableId, String(omsOrderId)),
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

      // 3. Check if order has any shippable items
      const hasShippableItems = omsLines.some(line => line.requiresShipping !== false);

      // 4. Map OMS → WMS order fields
      const warehouseStatus = hasShippableItems
        ? this.determineWarehouseStatus(omsOrder)
        : "completed"; // Pure digital/donation/membership → skip pick queue
      const priority = await this.determinePriority(omsOrder);

      const wmsOrderData: InsertOrder = {
        channelId: omsOrder.channelId,
        source: "oms", // Mark as coming from OMS layer
        sourceTableId: String(omsOrderId), // Link back to oms_orders for dedup
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
        financialStatus: omsOrder.financialStatus || "paid",
        priority,
        warehouseStatus,
        itemCount: omsLines.length,
        unitCount: omsLines.reduce((sum, line) => sum + (line.quantity || 0), 0),
        totalAmount: omsOrder.totalCents ? String(omsOrder.totalCents / 100) : null,
        currency: omsOrder.currency || "USD",
        orderPlacedAt: omsOrder.orderedAt,
        shopifyCreatedAt: omsOrder.orderedAt, // Legacy field, use ordered_at
      };

      // 4. Map line items
      const wmsLineItems: InsertOrderItem[] = [];

      for (const line of omsLines) {
        // Resolve product_variant_id and bin location from catalog
        const variantId = line.productVariantId || null;
        let binLocation: { location: string; zone: string } | null = null;

        if (variantId) {
          try {
            binLocation = await this.services.inventoryCore.getPrimaryBinLocation(variantId);
          } catch (err) {
            console.warn(`[WMS Sync] Could not resolve bin for variant ${variantId}`);
          }
        }

        // Propagate requiresShipping from OMS (false = donation/membership/digital)
        const itemRequiresShipping = line.requiresShipping !== false;

        wmsLineItems.push({
          orderId: 0, // Will be set by createOrderWithItems
          sourceItemId: line.externalLineItemId || null,
          sku: line.sku || "UNKNOWN",
          name: line.title || "Unknown Item",
          quantity: line.quantity || 0,
          pickedQuantity: 0,
          fulfilledQuantity: 0,
          status: itemRequiresShipping ? "pending" : "completed",
          location: binLocation?.location || "UNASSIGNED",
          zone: binLocation?.zone || "U",
          productId: variantId, // Temporary mapping to satisfy schema
          requiresShipping: itemRequiresShipping ? 1 : 0,
          priceCents: line.paidPriceCents || null,
          discountCents: line.totalDiscountCents || 0,
          totalPriceCents: line.totalPriceCents || null,
        });
      }

      // 5. Create WMS order (writes to orders + order_items)
      const { ordersStorage } = await import("../orders");
      const newWmsOrder = await ordersStorage.createOrderWithItems(wmsOrderData, wmsLineItems);

      console.log(`[WMS Sync] Synced OMS order ${omsOrderId} → WMS order ${newWmsOrder.id} (${omsOrder.externalOrderNumber})`);

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
  private async determinePriority(omsOrder: typeof omsOrders.$inferSelect): Promise<number> {
    // 1. Shipping Speed Base — higher base = picked sooner
    let base = 100; // Standard shipping
    if (omsOrder.shippingMethod) {
      const shippingStr = omsOrder.shippingMethod.toLowerCase();
      if (
        shippingStr.includes("overnight") ||
        shippingStr.includes("next day")
      ) {
        base = 500; // Overnight: very urgent
      } else if (
        shippingStr.includes("express") ||
        shippingStr.includes("2-day") ||
        shippingStr.includes("priority")
      ) {
        base = 300; // Express: elevated
      }
    }

    // 2. Dynamic Tier Modifier from Hub's Plans Table (additive boost)
    let modifier = 0; // Default: no membership boost

    try {
      const result = await db.execute(sql`
        SELECT p.priority_modifier
        FROM membership.plans p
        INNER JOIN membership.member_subscriptions ms ON p.id = ms.plan_id
        INNER JOIN membership.members m ON ms.member_id = m.id
        WHERE (m.email = ${omsOrder.customerEmail} OR m.shopify_customer_id = ${omsOrder.rawPayload ? (omsOrder.rawPayload as any).customer?.id : null})
          AND ms.status = 'active'
        LIMIT 1
      `);

      if (result.rows.length > 0) {
        modifier = Number(result.rows[0].priority_modifier);
      } else if (omsOrder.memberTier) {
        const planResult = await db.execute(sql`
          SELECT priority_modifier FROM membership.plans
          WHERE LOWER(name) = LOWER(${omsOrder.memberTier})
             OR id = ${omsOrder.memberTier}
          LIMIT 1
        `);
        if (planResult.rows.length > 0) {
          modifier = Number(planResult.rows[0].priority_modifier);
        }
      }
    } catch (err) {
      console.warn(`[WMS Sync] Failed to fetch priority modifier for order ${omsOrder.id}:`, err);
    }

    // Higher = Better: base + modifier. Leads can manually set 9999 (Bump) or -1 (Hold).
    return base + modifier;
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
      FROM oms_orders oo
      WHERE NOT EXISTS (
        SELECT 1 FROM orders o
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
}
