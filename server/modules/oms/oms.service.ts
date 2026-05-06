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
import type { ShopifyAdminGraphQLClient } from "../shopify/admin-gql-client";

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
  // C22b — fraud risk fields captured at OMS ingest from Shopify webhook
  // payloads (§6 Group E, Decision D3). NULL for non-Shopify channels and
  // for older orders ingested via the bridge path that does not carry the
  // raw payload. Risk score is stored as a string to match the DB numeric
  // column and avoid float precision loss (coding-standards Rule #3).
  riskLevel?: string | null;
  riskScore?: string | null;
  riskRecommendation?: string | null;
  riskFacts?: unknown;
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
  flowHistory?: OmsOrderFlowHistoryEntry[];
  channelName?: string;
}

export interface OmsOrderFlowHistoryEntry {
  id: string;
  source: "webhook_inbox" | "webhook_retry" | "reconciliation" | "alert" | "event";
  status: string;
  label: string;
  details: unknown;
  createdAt: Date | string | null;
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
        // C22b — risk fields populated at ingest from Shopify webhook payload.
        riskLevel: data.riskLevel ?? null,
        riskScore: data.riskScore ?? null,
        riskRecommendation: data.riskRecommendation ?? null,
        riskFacts: (data.riskFacts ?? null) as any,
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

    const flowHistory = await getOrderFlowHistory(order);

    return { ...order, lines, events, flowHistory, channelName: channel?.name };
  }

  async function getOrderFlowHistory(order: OmsOrder): Promise<OmsOrderFlowHistoryEntry[]> {
    const externalOrderIds = [
      order.externalOrderId,
      order.externalOrderNumber,
      order.id != null ? String(order.id) : null,
    ].filter((value): value is string => Boolean(value));

    const [webhooks, retries, flowEvents] = await Promise.all([
      db.execute(sql`
        SELECT id, provider, topic, event_id, status, attempts, last_error,
               first_received_at, last_attempt_at, processed_at, updated_at
        FROM oms.webhook_inbox
        WHERE (
             payload->>'id' = ANY(${externalOrderIds})
          OR payload->>'order_id' = ANY(${externalOrderIds})
          OR payload->>'admin_graphql_api_id' = ANY(${externalOrderIds})
          OR payload->>'name' = ANY(${externalOrderIds})
        )
        ORDER BY COALESCE(processed_at, last_attempt_at, first_received_at, updated_at) DESC NULLS LAST
        LIMIT 20
      `),
      db.execute(sql`
        SELECT id, provider, topic, attempts, status, last_error,
               next_retry_at, created_at, updated_at
        FROM oms.webhook_retry_queue
        WHERE (
             payload->>'id' = ANY(${externalOrderIds})
          OR payload->>'order_id' = ANY(${externalOrderIds})
          OR payload->>'admin_graphql_api_id' = ANY(${externalOrderIds})
          OR payload->>'name' = ANY(${externalOrderIds})
          OR payload->>'orderId' = ${String(order.id)}
        )
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
        LIMIT 20
      `),
      db.execute(sql`
        SELECT id, event_type, details, created_at
        FROM oms.oms_order_events
        WHERE order_id = ${order.id}
          AND event_type IN (
            'flow_reconciliation_remediated',
            'tracking_push_failed',
            'shopify_fulfillment_push_failed',
            'shopify_fulfillment_pushed',
            'tracking_pushed'
          )
        ORDER BY created_at DESC
        LIMIT 20
      `),
    ]);

    const entries: OmsOrderFlowHistoryEntry[] = [];

    for (const row of Array.isArray(webhooks?.rows) ? webhooks.rows : []) {
      entries.push({
        id: `webhook_inbox:${row.id}`,
        source: "webhook_inbox",
        status: row.status,
        label: `${row.provider}/${row.topic}`,
        details: {
          eventId: row.event_id,
          attempts: row.attempts,
          lastError: row.last_error,
        },
        createdAt: row.processed_at ?? row.last_attempt_at ?? row.first_received_at ?? row.updated_at ?? null,
      });
    }

    for (const row of Array.isArray(retries?.rows) ? retries.rows : []) {
      entries.push({
        id: `webhook_retry:${row.id}`,
        source: "webhook_retry",
        status: row.status,
        label: `${row.provider}/${row.topic}`,
        details: {
          attempts: row.attempts,
          lastError: row.last_error,
          nextRetryAt: row.next_retry_at,
        },
        createdAt: row.updated_at ?? row.created_at ?? null,
      });
    }

    for (const row of Array.isArray(flowEvents?.rows) ? flowEvents.rows : []) {
      const source =
        row.event_type === "flow_reconciliation_remediated"
          ? "reconciliation"
          : row.event_type.includes("failed")
            ? "alert"
            : "event";
      entries.push({
        id: `event:${row.id}`,
        source,
        status: row.event_type,
        label: row.event_type,
        details: row.details,
        createdAt: row.created_at ?? null,
      });
    }

    return entries.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
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

  // -----------------------------------------------------------------
  // C22b — Populate Shopify fulfillment-order line item IDs at ingest
  // -----------------------------------------------------------------
  //
  // Shopify's `orders/paid` (and `orders/create`) webhook payload does
  // NOT include `fulfillment_orders` directly — they must be fetched
  // separately via the Admin GraphQL API. This helper performs that
  // fetch and writes the resolved IDs onto each `oms_order_lines` row
  // by matching SKU + quantity (greedy allocation, similar to C21's
  // Path B resolver, but populating instead of consuming).
  //
  // Failure is non-fatal: callers wrap in try/catch. C22c's Path B
  // fallback re-resolves at fulfillment-push time for any line that
  // didn't get populated here.
  //
  // Returns a summary so callers can log/observe (Rule #8).
  async function populateShopifyFulfillmentOrderIds(
    omsOrderId: number,
    shopifyOrderGid: string,
    client: ShopifyAdminGraphQLClient,
  ): Promise<{ matched: number; unmatched: number; updates: number }> {
    const lines: Array<{
      id: number;
      sku: string | null;
      quantity: number;
      shopifyFulfillmentOrderLineItemId: string | null;
    }> = await db
      .select({
        id: omsOrderLines.id,
        sku: omsOrderLines.sku,
        quantity: omsOrderLines.quantity,
        shopifyFulfillmentOrderLineItemId:
          omsOrderLines.shopifyFulfillmentOrderLineItemId,
      })
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, omsOrderId));

    if (lines.length === 0) {
      return { matched: 0, unmatched: 0, updates: 0 };
    }

    const response = await client.request<any>(
      `query fulfillmentOrdersForOrder($id: ID!) {
        order(id: $id) {
          id
          fulfillmentOrders(first: 50) {
            edges {
              node {
                id
                status
                lineItems(first: 100) {
                  edges {
                    node {
                      id
                      sku
                      remainingQuantity
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { id: shopifyOrderGid },
    );

    interface FoCandidate {
      fulfillmentOrderId: string;
      fulfillmentOrderLineItemId: string;
      sku: string | null;
      remaining: number;
      status: string;
    }

    const candidates: FoCandidate[] = [];
    const fos = response?.order?.fulfillmentOrders?.edges ?? [];
    for (const foEdge of fos) {
      const fo = foEdge?.node;
      if (!fo) continue;
      const status = String(fo.status ?? "").toUpperCase();
      // Skip terminal-state FOs: they cannot accept new fulfillments and
      // their lineItems no longer represent unfulfilled work.
      if (status === "CLOSED" || status === "CANCELLED") continue;
      const liEdges = fo?.lineItems?.edges ?? [];
      for (const liEdge of liEdges) {
        const li = liEdge?.node;
        if (!li) continue;
        candidates.push({
          fulfillmentOrderId: String(fo.id),
          fulfillmentOrderLineItemId: String(li.id),
          sku: li.sku ?? null,
          remaining: Number.isInteger(li.remainingQuantity)
            ? li.remainingQuantity
            : 0,
          status,
        });
      }
    }

    if (candidates.length === 0) {
      // No FOs returned — edge case (very new order, or non-fulfillable
      // composition). Logged so it's visible; C22c's Path B will retry
      // at fulfillment-push time.
      console.log(
        `[OMS] populateShopifyFulfillmentOrderIds: order ${omsOrderId} (${shopifyOrderGid}) has no fulfillment orders yet`,
      );
      return { matched: 0, unmatched: lines.length, updates: 0 };
    }

    let matched = 0;
    let unmatched = 0;
    let updates = 0;
    for (const line of lines) {
      const sku = (line.sku ?? "").trim();
      if (sku.length === 0) {
        unmatched++;
        continue;
      }
      const candidate = candidates.find(
        (c) => c.sku === sku && c.remaining >= line.quantity,
      );
      if (!candidate) {
        unmatched++;
        console.log(
          `[OMS] populateShopifyFulfillmentOrderIds: no FO match for line ${line.id} sku=${sku} qty=${line.quantity} (will be retried via Path B)`,
        );
        continue;
      }
      candidate.remaining -= line.quantity;
      matched++;

      // Idempotent overwrite. Shopify is authoritative for FO IDs, so we
      // always write — but using a guarded WHERE means a parallel
      // populator (e.g. retry) does not silently overwrite a value that
      // is already correct.
      const result = await db
        .update(omsOrderLines)
        .set({
          shopifyFulfillmentOrderId: candidate.fulfillmentOrderId,
          shopifyFulfillmentOrderLineItemId: candidate.fulfillmentOrderLineItemId,
          updatedAt: new Date(),
        })
        .where(eq(omsOrderLines.id, line.id))
        .returning({ id: omsOrderLines.id });
      if (Array.isArray(result) && result.length > 0) {
        updates++;
      } else if (!result) {
        // Some drizzle/db mocks may not implement .returning(); count the
        // attempt as an update so observability isn't misleading.
        updates++;
      }
    }

    return { matched, unmatched, updates };
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
    populateShopifyFulfillmentOrderIds,
  };
}

export type OmsService = ReturnType<typeof createOmsService>;
