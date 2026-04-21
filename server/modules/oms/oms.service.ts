/**
 * OMS Service — Unified Order Management
 *
 * Channel-agnostic order ingestion, inventory reservation, warehouse routing,
 * and fulfillment tracking. All channel orders normalize through this service.
 */

import { eq, and, sql, desc, asc, gte, lte, or, ilike, count } from "drizzle-orm";
import {
  omsOrders, omsOrderLines, omsOrderEvents,
  type InsertOmsOrder, type InsertOmsOrderLine, type OmsOrder, type OmsOrderLine,
  productVariants,
  channels,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrderData {
  externalOrderNumber?: string;
  status?: string;
  financialStatus?: string;
  fulfillmentStatus?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  shipToName?: string;
  shipToAddress1?: string;
  shipToAddress2?: string;
  shipToCity?: string;
  shipToState?: string;
  shipToZip?: string;
  shipToCountry?: string;
  shippingMethod?: string | null;
  shippingMethodCode?: string | null;
  shippingServiceLevel?: "standard" | "expedited" | "overnight";
  channelShipByDate?: Date | string | null;
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
  discountCents?: number;
  totalCents?: number;
  currency?: string;
  taxExempt?: boolean;
  rawPayload?: unknown;
  notes?: string;
  tags?: string[];
  orderedAt: Date;
  lineItems: LineItemData[];
}

export interface LineItemData {
  externalLineItemId?: string;
  externalProductId?: string | null;
  sku?: string | null;
  title?: string;
  variantTitle?: string | null;
  quantity: number;
  paidPriceCents?: number;
  totalCents?: number;
  taxCents?: number;
  discountCents?: number;
  planDiscountCents?: number;
  couponDiscountCents?: number;
  taxable?: boolean;
  requiresShipping?: boolean;
  fulfillableQuantity?: number | null;
  fulfillmentService?: string | null;
  properties?: any | null;
  compareAtPriceCents?: number | null;
  taxLines?: any | null;
  discountAllocations?: any | null;
}

export interface OmsOrderWithLines extends OmsOrder {
  lines: OmsOrderLine[];
  events?: Array<{ id: number; eventType: string; details: unknown; createdAt: Date }>;
  channelName?: string;
}

// ---------------------------------------------------------------------------
// Service Factory
// ---------------------------------------------------------------------------

export function createOmsService(db: any, reservationService?: any) {
  /**
   * Ingest an order from any channel — idempotent by (channel_id, external_order_id).
   * Returns existing order if already ingested.
   */
  async function ingestOrder(
    channelId: number,
    externalOrderId: string,
    data: OrderData,
  ): Promise<OmsOrder> {
    // App-layer race protection (P1-1 / P1-2): Insert natively resolving any potential conflict seamlessly
    const [order] = await db
      .insert(omsOrders)
      .values({
        channelId,
        externalOrderId,
        externalOrderNumber: data.externalOrderNumber || externalOrderId,
        status: data.status || "pending",
        financialStatus: data.financialStatus || "paid",
        fulfillmentStatus: data.fulfillmentStatus || "unfulfilled",
        customerName: data.customerName,
        customerEmail: data.customerEmail,
        customerPhone: data.customerPhone,
        shipToName: data.shipToName,
        shipToAddress1: data.shipToAddress1,
        shipToAddress2: data.shipToAddress2,
        shipToCity: data.shipToCity,
        shipToState: data.shipToState,
        shipToZip: data.shipToZip,
        shipToCountry: data.shipToCountry,
        subtotalCents: data.subtotalCents || 0,
        shippingCents: data.shippingCents || 0,
        taxCents: data.taxCents || 0,
        discountCents: data.discountCents || 0,
        totalCents: data.totalCents || 0,
        currency: data.currency || "USD",
        taxExempt: data.taxExempt || false,
        rawPayload: data.rawPayload as any,
        notes: data.notes,
        tags: data.tags ? JSON.stringify(data.tags) : null,
        shippingMethod: data.shippingMethod || null,
        shippingMethodCode: data.shippingMethodCode || null,
        shippingServiceLevel: data.shippingServiceLevel || "standard",
        channelShipByDate: data.channelShipByDate
          ? (data.channelShipByDate instanceof Date
              ? data.channelShipByDate
              : new Date(data.channelShipByDate))
          : null,
        orderedAt: data.orderedAt,
      } satisfies InsertOmsOrder)
      .onConflictDoNothing({ target: [omsOrders.channelId, omsOrders.externalOrderId] })
      .returning();

    // Conflict hit - ingestion avoided (double ingestion dedup guard). Safely route dynamically back to retrieving existing.
    if (!order) {
      console.log(`[METRIC] oms.duplicate_ingest_avoided_total=1 (channel_id=${channelId}, external_order_id=${externalOrderId})`);

      const existing = await db
        .select()
        .from(omsOrders)
        .where(
          and(
            eq(omsOrders.channelId, channelId),
            eq(omsOrders.externalOrderId, externalOrderId),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        throw new Error(`[OMS] Unresolved race condition hit avoiding duplicate for ${externalOrderId}. Order not found after conflict.`);
      }

      // Check if line items exist for this order
      const existingLines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, existing[0].id))
        .limit(1);

      // If no line items, create them (handles partial ingestion recovery)
      if (existingLines.length === 0 && data.lineItems.length > 0) {
        for (const item of data.lineItems) {
          let productVariantId: number | null = null;
          let variantCompareAtPrice = null;

          if (item.sku) {
            const [variant] = await db
              .select({ id: productVariants.id, compareAtPriceCents: productVariants.compareAtPriceCents })
              .from(productVariants)
              .where(eq(productVariants.sku, item.sku.toUpperCase()))
              .limit(1);
            if (variant) {
              productVariantId = variant.id;
              variantCompareAtPrice = variant.compareAtPriceCents;
            }
          }

          await db.insert(omsOrderLines).values({
            orderId: existing[0].id,
            productVariantId,
            externalLineItemId: item.externalLineItemId,
            externalProductId: item.externalProductId || null,
            sku: item.sku,
            title: item.title,
            variantTitle: item.variantTitle,
            quantity: item.quantity,
            paidPriceCents: item.paidPriceCents || 0,
            totalPriceCents: item.totalCents || 0,
            totalDiscountCents: item.discountCents || 0,
            planDiscountCents: item.planDiscountCents || 0,
            couponDiscountCents: item.couponDiscountCents || 0,
            taxable: item.taxable ?? true,
            requiresShipping: item.requiresShipping ?? true,
            fulfillableQuantity: item.fulfillableQuantity ?? null,
            fulfillmentService: item.fulfillmentService ?? null,
            properties: item.properties ?? null,
            compareAtPriceCents: item.compareAtPriceCents ?? variantCompareAtPrice,            
            taxLines: item.taxLines ?? null,
            discountAllocations: item.discountAllocations ?? null,
            orderNumber: data.externalOrderNumber || null,
          } satisfies InsertOmsOrderLine);
        }
        console.log(`[OMS] Backfilled ${data.lineItems.length} missing line items for order ${existing[0].id}`);
      }

      return existing[0];
    }

    // Insert line items with SKU → product_variant lookup
    for (const item of data.lineItems) {
      let productVariantId: number | null = null;
      let variantCompareAtPrice = null;

      if (item.sku) {
        const [variant] = await db
          .select({ id: productVariants.id, compareAtPriceCents: productVariants.compareAtPriceCents })
          .from(productVariants)
          .where(eq(productVariants.sku, item.sku.toUpperCase()))
          .limit(1);
        if (variant) {
          productVariantId = variant.id;
          variantCompareAtPrice = variant.compareAtPriceCents;
        }
      }

      await db.insert(omsOrderLines).values({
        orderId: order.id,
        productVariantId,
        externalLineItemId: item.externalLineItemId,
        externalProductId: item.externalProductId || null,
        sku: item.sku,
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        paidPriceCents: item.paidPriceCents || 0,
        totalPriceCents: item.totalCents || 0,
        totalDiscountCents: item.discountCents || 0,
        planDiscountCents: item.planDiscountCents || 0,
        couponDiscountCents: item.couponDiscountCents || 0,
        taxable: item.taxable ?? true,
        requiresShipping: item.requiresShipping ?? true,
        fulfillableQuantity: item.fulfillableQuantity ?? null,
        fulfillmentService: item.fulfillmentService ?? null,
        properties: item.properties ?? null,
        compareAtPriceCents: item.compareAtPriceCents ?? variantCompareAtPrice,            
        taxLines: item.taxLines ?? null,
        discountAllocations: item.discountAllocations ?? null,
        orderNumber: data.externalOrderNumber || null,
      } satisfies InsertOmsOrderLine);
    }

    // Record created event
    await db.insert(omsOrderEvents).values({
      orderId: order.id,
      eventType: "created",
      details: { channelId, externalOrderId, lineItemCount: data.lineItems.length },
    });

    console.log(`[OMS] Ingested order ${data.externalOrderNumber || externalOrderId} from channel ${channelId}`);
    return order;
  }

  /**
   * Reserve inventory for an OMS order's line items.
   * Delegates to the WMS ReservationService which gates on fungible ATP,
   * writes audit trail, tracks lots, and triggers channel sync.
   * Idempotent — checks for prior reservation event.
   */
  async function reserveInventory(orderId: number): Promise<{ reserved: number; failed: string[] }> {
    // Idempotency: check if already reserved
    const priorEvent = await db
      .select()
      .from(omsOrderEvents)
      .where(
        and(
          eq(omsOrderEvents.orderId, orderId),
          eq(omsOrderEvents.eventType, "inventory_reserved"),
        ),
      )
      .limit(1);

    if (priorEvent.length > 0) {
      return { reserved: 0, failed: [] };
    }

    const lines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, orderId));

    let reserved = 0;
    const failed: string[] = [];
    const skipped: string[] = [];

    for (const line of lines) {
      if (!line.requiresShipping) {
        skipped.push(line.sku || "UNSHIPPABLE");
        continue;
      }

      if (!line.productVariantId) {
        skipped.push(line.sku || "UNMAPPED");
        continue;
      }

      if (!reservationService) {
        // Fallback: no reservation service wired — log warning
        console.error(`[OMS] reserveInventory called but no ReservationService wired. Order ${orderId} line ${line.sku} not reserved.`);
        failed.push(line.sku || "UNKNOWN");
        continue;
      }

      try {
        // Look up the variant to get its productId (needed by reservation service)
        const [variant] = await db
          .select({ id: productVariants.id, productId: productVariants.productId })
          .from(productVariants)
          .where(eq(productVariants.id, line.productVariantId))
          .limit(1);

        if (!variant) {
          failed.push(line.sku || "UNKNOWN");
          continue;
        }

        // Delegate to WMS ReservationService — gates on fungible ATP,
        // finds assigned bin, writes audit trail, triggers channel sync
        const result = await reservationService.reserveForOrder(
          variant.productId,
          variant.id,
          line.quantity,
          orderId,
          line.id,
        );

        if (result.reserved > 0) {
          reserved++;
        }
        if (result.shortfall > 0) {
          failed.push(line.sku || "UNKNOWN");
        }
      } catch (err: any) {
        console.error(`[OMS] Reservation failed for order ${orderId} line ${line.sku}: ${err.message}`);
        failed.push(line.sku || "UNKNOWN");
      }
    }

    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "inventory_reserved",
      details: { reserved, failed, skipped },
    });

    return { reserved, failed };
  }

  /**
   * Assign a warehouse to fulfill the order.
   * For now: assigns warehouse_id=1 (LEON) by default.
   */
  async function assignWarehouse(orderId: number, warehouseId: number = 1): Promise<void> {
    await db
      .update(omsOrders)
      .set({ warehouseId, status: "confirmed", updatedAt: new Date() })
      .where(eq(omsOrders.id, orderId));

    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "assigned_warehouse",
      details: { warehouseId },
    });
  }

  /**
   * Mark an order as shipped with tracking info.
   */
  async function markShipped(
    orderId: number,
    trackingNumber: string,
    carrier: string,
  ): Promise<OmsOrder> {
    const now = new Date();

    const [updated] = await db
      .update(omsOrders)
      .set({
        status: "shipped",
        fulfillmentStatus: "fulfilled",
        trackingNumber,
        trackingCarrier: carrier,
        shippedAt: now,
        updatedAt: now,
      })
      .where(eq(omsOrders.id, orderId))
      .returning();

    // Update all line items to fulfilled
    await db
      .update(omsOrderLines)
      .set({ fulfillmentStatus: "fulfilled" })
      .where(eq(omsOrderLines.orderId, orderId));

    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "shipped",
      details: { trackingNumber, carrier },
    });

    return updated;
  }

  /**
   * Get a single order with lines and events.
   */
  async function getOrderById(orderId: number): Promise<OmsOrderWithLines | null> {
    const [order] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.id, orderId))
      .limit(1);

    if (!order) return null;

    const lines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, orderId));

    const events = await db
      .select()
      .from(omsOrderEvents)
      .where(eq(omsOrderEvents.orderId, orderId))
      .orderBy(asc(omsOrderEvents.createdAt));

    // Get channel name
    const [channel] = await db
      .select({ name: channels.name })
      .from(channels)
      .where(eq(channels.id, order.channelId))
      .limit(1);

    return { ...order, lines, events, channelName: channel?.name };
  }

  /**
   * List orders with filters and pagination.
   */
  async function listOrders(params: {
    channelId?: number;
    status?: string;
    search?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
  }): Promise<{ orders: OmsOrderWithLines[]; total: number }> {
    const page = params.page || 1;
    const limit = params.limit || 50;
    const offset = (page - 1) * limit;

    const conditions: any[] = [];

    if (params.channelId) {
      conditions.push(eq(omsOrders.channelId, params.channelId));
    }
    if (params.status) {
      conditions.push(eq(omsOrders.status, params.status));
    }
    if (params.startDate) {
      conditions.push(gte(omsOrders.orderedAt, new Date(params.startDate)));
    }
    if (params.endDate) {
      conditions.push(lte(omsOrders.orderedAt, new Date(params.endDate)));
    }
    if (params.search) {
      const term = `%${params.search}%`;
      conditions.push(
        or(
          ilike(omsOrders.externalOrderNumber, term),
          ilike(omsOrders.customerName, term),
          ilike(omsOrders.externalOrderId, term),
        ),
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const [{ value: total }] = await db
      .select({ value: count() })
      .from(omsOrders)
      .where(whereClause);

    // Get orders
    const orders = await db
      .select()
      .from(omsOrders)
      .where(whereClause)
      .orderBy(desc(omsOrders.orderedAt))
      .limit(limit)
      .offset(offset);

    // Hydrate with lines and channel names
    const result: OmsOrderWithLines[] = [];
    for (const order of orders) {
      const lines = await db
        .select()
        .from(omsOrderLines)
        .where(eq(omsOrderLines.orderId, order.id));

      const [channel] = await db
        .select({ name: channels.name })
        .from(channels)
        .where(eq(channels.id, order.channelId))
        .limit(1);

      result.push({ ...order, lines, channelName: channel?.name });
    }

    return { orders: result, total: Number(total) };
  }

  /**
   * Get order stats summary.
   */
  async function getStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byChannel: Record<string, number>;
    todayCount: number;
  }> {
    // Total
    const [{ value: total }] = await db.select({ value: count() }).from(omsOrders);

    // By status
    const statusRows = await db
      .select({ status: omsOrders.status, cnt: count() })
      .from(omsOrders)
      .groupBy(omsOrders.status);
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) {
      byStatus[r.status] = Number(r.cnt);
    }

    // By channel
    const channelRows = await db.execute(sql`
      SELECT c.name, COUNT(o.id) as cnt
      FROM oms.oms_orders o
      JOIN channels c ON o.channel_id = c.id
      GROUP BY c.name
    `);
    const byChannel: Record<string, number> = {};
    for (const r of channelRows.rows) {
      byChannel[(r as any).name] = Number((r as any).cnt);
    }

    // Today
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const [{ value: todayCount }] = await db
      .select({ value: count() })
      .from(omsOrders)
      .where(gte(omsOrders.orderedAt, todayStart));

    return {
      total: Number(total),
      byStatus,
      byChannel,
      todayCount: Number(todayCount),
    };
  }

  /**
   * Mark an order as shipped by its external (Shopify/eBay) order ID.
   * Finds the matching oms_orders row and delegates to markShipped().
   * No-op if order not found or already shipped.
   */
  async function markShippedByExternalId(
    externalOrderId: string,
    trackingNumber: string,
    carrier: string,
  ): Promise<OmsOrder | null> {
    const [order] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.externalOrderId, externalOrderId))
      .limit(1);

    if (!order) {
      return null; // Order not in OMS yet (possible if bridge hasn't run)
    }

    // Skip if already shipped or cancelled
    if (order.status === "shipped" || order.status === "cancelled") {
      return order;
    }

    return markShipped(order.id, trackingNumber, carrier);
  }

  return {
    ingestOrder,
    reserveInventory,
    assignWarehouse,
    markShipped,
    markShippedByExternalId,
    getOrderById,
    listOrders,
    getStats,
  };
}

export type OmsService = ReturnType<typeof createOmsService>;
