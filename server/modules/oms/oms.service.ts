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
  inventoryLevels,
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
  subtotalCents?: number;
  shippingCents?: number;
  taxCents?: number;
  discountCents?: number;
  totalCents?: number;
  currency?: string;
  rawPayload?: unknown;
  notes?: string;
  tags?: string[];
  orderedAt: Date;
  lineItems: LineItemData[];
}

export interface LineItemData {
  externalLineItemId?: string;
  sku?: string;
  title?: string;
  variantTitle?: string;
  quantity: number;
  unitPriceCents?: number;
  totalCents?: number;
  taxCents?: number;
  discountCents?: number;
}

export interface OmsOrderWithLines extends OmsOrder {
  lines: OmsOrderLine[];
  events?: Array<{ id: number; eventType: string; details: unknown; createdAt: Date }>;
  channelName?: string;
}

// ---------------------------------------------------------------------------
// Service Factory
// ---------------------------------------------------------------------------

export function createOmsService(db: any) {
  /**
   * Ingest an order from any channel — idempotent by (channel_id, external_order_id).
   * Returns existing order if already ingested.
   */
  async function ingestOrder(
    channelId: number,
    externalOrderId: string,
    data: OrderData,
  ): Promise<OmsOrder> {
    // Check for existing (idempotent dedup)
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

    if (existing.length > 0) {
      return existing[0];
    }

    // Insert order
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
        rawPayload: data.rawPayload as any,
        notes: data.notes,
        tags: data.tags ? JSON.stringify(data.tags) : null,
        orderedAt: data.orderedAt,
      } satisfies InsertOmsOrder)
      .returning();

    // Insert line items with SKU → product_variant lookup
    for (const item of data.lineItems) {
      let productVariantId: number | null = null;

      if (item.sku) {
        const [variant] = await db
          .select({ id: productVariants.id })
          .from(productVariants)
          .where(eq(productVariants.sku, item.sku.toUpperCase()))
          .limit(1);
        if (variant) productVariantId = variant.id;
      }

      await db.insert(omsOrderLines).values({
        orderId: order.id,
        productVariantId,
        externalLineItemId: item.externalLineItemId,
        sku: item.sku,
        title: item.title,
        variantTitle: item.variantTitle,
        quantity: item.quantity,
        unitPriceCents: item.unitPriceCents || 0,
        totalCents: item.totalCents || 0,
        taxCents: item.taxCents || 0,
        discountCents: item.discountCents || 0,
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
   * Increments reserved_qty on inventory_levels. Idempotent — checks for prior reservation event.
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

    for (const line of lines) {
      if (!line.productVariantId) {
        failed.push(line.sku || "UNKNOWN");
        continue;
      }

      // Find inventory level with stock and increment reserved_qty
      const result = await db.execute(sql`
        UPDATE inventory_levels
        SET reserved_qty = reserved_qty + ${line.quantity},
            updated_at = NOW()
        WHERE product_variant_id = ${line.productVariantId}
          AND variant_qty >= ${line.quantity}
        RETURNING id
      `);

      if (result.rows.length > 0) {
        reserved++;
      } else {
        failed.push(line.sku || "UNKNOWN");
      }
    }

    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "inventory_reserved",
      details: { reserved, failed },
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
      FROM oms_orders o
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

  return {
    ingestOrder,
    reserveInventory,
    assignWarehouse,
    markShipped,
    getOrderById,
    listOrders,
    getStats,
  };
}

export type OmsService = ReturnType<typeof createOmsService>;
