/**
 * Shopify Bridge — writes Shopify orders into OMS for unified view
 *
 * Hooks into the existing order-sync-listener LISTEN/NOTIFY flow.
 * After a shopify_orders row is synced to the WMS `orders` table,
 * this bridge also writes it to `oms_orders` for the unified view.
 *
 * This does NOT modify the existing Shopify flow. It's additive only.
 */

import { sql } from "drizzle-orm";
import type { OmsService, OrderData, LineItemData } from "./oms.service";

// Channel IDs for Shopify
const SHOPIFY_US_CHANNEL_ID = 36;
const SHOPIFY_CA_CHANNEL_ID = 37;

/**
 * Bridge a Shopify order into the OMS.
 * Call this after the existing order sync creates the WMS order.
 *
 * @param db - Drizzle database instance
 * @param omsService - OMS service for ingestion
 * @param shopifyOrderId - The shopify_orders.id value
 */
export async function bridgeShopifyOrderToOms(
  db: any,
  omsService: OmsService,
  shopifyOrderId: string,
): Promise<void> {
  try {
    // Fetch from shopify_orders
    const rawOrderResult = await db.execute(sql`
      SELECT
        id, order_number, customer_name, customer_email,
        shipping_name, shipping_address1, shipping_city,
        shipping_state, shipping_postal_code, shipping_country,
        total_price_cents, subtotal_price_cents, total_shipping_cents,
        total_tax_cents, total_discounts_cents,
        currency, order_date, financial_status, fulfillment_status,
        cancelled_at, shop_domain
      FROM shopify_orders
      WHERE id = ${shopifyOrderId}
    `);

    if (rawOrderResult.rows.length === 0) return;

    const raw = rawOrderResult.rows[0] as any;

    // Determine channel based on shop_domain
    let channelId = SHOPIFY_US_CHANNEL_ID;
    if (raw.shop_domain && raw.shop_domain.includes("-ca")) {
      channelId = SHOPIFY_CA_CHANNEL_ID;
    }

    // Fetch line items
    const rawItems = await db.execute(sql`
      SELECT
        id, shopify_line_item_id, sku, name, title,
        quantity, paid_price_cents, total_price_cents,
        total_discount_cents, fulfillment_status
      FROM shopify_order_items
      WHERE order_id = ${shopifyOrderId}
    `);

    const lineItems: LineItemData[] = (rawItems.rows as any[]).map((item: any) => ({
      externalLineItemId: item.shopify_line_item_id,
      sku: item.sku,
      title: item.name || item.title,
      quantity: item.quantity,
      unitPriceCents: item.paid_price_cents || 0,
      totalCents: item.total_price_cents || 0,
      discountCents: item.total_discount_cents || 0,
    }));

    // Map financial_status
    let financialStatus = raw.financial_status || "paid";
    let fulfillmentStatus = raw.fulfillment_status || "unfulfilled";

    // Determine OMS status
    let status = "pending";
    if (raw.cancelled_at) {
      status = "cancelled";
    } else if (fulfillmentStatus === "fulfilled") {
      status = "shipped";
    } else if (financialStatus === "paid") {
      status = "confirmed";
    }

    const orderData: OrderData = {
      externalOrderNumber: raw.order_number,
      status,
      financialStatus,
      fulfillmentStatus,
      customerName: raw.customer_name || raw.shipping_name,
      customerEmail: raw.customer_email,
      shipToName: raw.shipping_name,
      shipToAddress1: raw.shipping_address1,
      shipToCity: raw.shipping_city,
      shipToState: raw.shipping_state,
      shipToZip: raw.shipping_postal_code,
      shipToCountry: raw.shipping_country,
      subtotalCents: raw.subtotal_price_cents || 0,
      shippingCents: raw.total_shipping_cents || 0,
      taxCents: raw.total_tax_cents || 0,
      discountCents: raw.total_discounts_cents || 0,
      totalCents: raw.total_price_cents || 0,
      currency: raw.currency || "USD",
      orderedAt: raw.order_date ? new Date(raw.order_date) : new Date(),
      lineItems,
    };

    await omsService.ingestOrder(channelId, shopifyOrderId, orderData);
  } catch (err: any) {
    // Non-fatal: the WMS order is already created, this is supplementary
    console.error(`[Shopify Bridge] Failed to bridge order ${shopifyOrderId} to OMS: ${err.message}`);
  }
}

/**
 * Batch-backfill existing Shopify orders into the OMS.
 * Finds orders in shopify_orders that aren't yet in oms_orders and ingests them.
 */
export async function backfillShopifyOrders(
  db: any,
  omsService: OmsService,
  limit: number = 100,
): Promise<number> {
  const unsynced = await db.execute(sql`
    SELECT so.id FROM shopify_orders so
    WHERE NOT EXISTS (
      SELECT 1 FROM oms_orders oo
      WHERE oo.external_order_id = so.id
        AND oo.channel_id IN (${SHOPIFY_US_CHANNEL_ID}, ${SHOPIFY_CA_CHANNEL_ID})
    )
    ORDER BY so.created_at DESC
    LIMIT ${limit}
  `);

  let bridged = 0;
  for (const row of unsynced.rows as any[]) {
    await bridgeShopifyOrderToOms(db, omsService, row.id);
    bridged++;
  }

  if (bridged > 0) {
    console.log(`[Shopify Bridge] Backfilled ${bridged} orders to OMS`);
  }

  return bridged;
}
