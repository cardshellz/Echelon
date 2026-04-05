/**
 * Shopify Bridge — writes Shopify orders into OMS for unified view
 *
 * Hooks into the existing order-sync-listener LISTEN/NOTIFY flow.
 * After a shopify_orders row is synced to the WMS `orders` table,
 * this bridge also writes it to `oms_orders` for the unified view.
 *
 * This does NOT modify the existing Shopify flow. It's additive only.
 */

import { sql, ilike } from "drizzle-orm";
import type { OmsService, OrderData, LineItemData } from "./oms.service";
import { getShopifyConfig } from "../integrations/shopify";
import { channelConnections } from "@shared/schema";


import { normalizeShopifyLineItems } from "./shopify-line-item-normalizer";

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
    // Fetch shop_domain and full order row from legacy table
    const rawOrderResult = await db.execute(sql`
      SELECT * FROM shopify_orders WHERE id = ${shopifyOrderId}
    `);
    
    if (rawOrderResult.rows.length === 0) return;
    const raw = rawOrderResult.rows[0];
    const orderDomain = raw.shop_domain;

    // Determine channel dynamically
    let connResult;
    if (orderDomain) {
      connResult = await db.execute(sql`
        SELECT * FROM channel_connections
        WHERE shop_domain ILIKE ${`%${orderDomain}%`}
        LIMIT 1
      `);
    } else {
      // Legacy rows without shop_domain MUST default strictly to the primary US store 
      // because is_default was accidentally pointing to the CA store in the DB
      connResult = await db.execute(sql`
        SELECT cc.* FROM channel_connections cc
        JOIN channels c ON c.id = cc.channel_id
        WHERE cc.shop_domain ILIKE '%card-shellz.myshopify.com%' AND c.provider = 'shopify'
        LIMIT 1
      `);
    }

    if (connResult.rows.length === 0) {
      console.warn(`[Shopify Bridge] Ignoring order ${shopifyOrderId} - unknown channel`);
      return;
    }
    
    const { channel_id: channelId } = connResult.rows[0];

    const orderItemsResult = await db.execute(sql`
      SELECT * FROM shopify_order_items WHERE order_id = ${shopifyOrderId}
    `);
    const orderItems = orderItemsResult.rows;

    const discountCodesArray: string[] = raw.discount_codes || [];

    const lineItems: LineItemData[] = orderItems.map((item: any) => {
      let planDiscountCents = 0;
      let couponDiscountCents = 0;
      const discountAllocations = item.discount_allocations || [];
      
      for (const alloc of discountAllocations) {
        const allocAmount = Math.round(parseFloat(alloc.amount || "0") * 100);
        // Detect rewards
        const isRewards = discountCodesArray.some((code: string) => 
          code.toUpperCase().startsWith("SHELLZ-") || code.toUpperCase().includes("REWARDS")
        );
        
        // Deduce app type
        let appType = alloc.application_type;
        if (!appType && alloc.discount_application_index !== undefined) {
           if (discountCodesArray.length === 0) appType = "manual";
        }

        if (appType === "manual" && !isRewards) {
          planDiscountCents += allocAmount;
        } else {
          couponDiscountCents += allocAmount;
        }
      }

      const totalDiscountCents = planDiscountCents + couponDiscountCents;
      
      // Calculate retail price from legacy table's final totals + legacy discounts
      const oldPlan = item.plan_discount_cents || 0;
      const oldCoupon = item.coupon_discount_cents || 0;
      const qty = item.quantity || 1;
      const retailPriceCents = Math.round(((item.total_price_cents || 0) + oldPlan + oldCoupon) / qty);
      
      const paidPriceCents = Math.round(retailPriceCents - (totalDiscountCents / qty));
      const totalCents = (retailPriceCents * qty) - totalDiscountCents;

      return {
        externalLineItemId: item.shopify_line_item_id || String(item.id),
        sku: item.sku,
        title: item.title,
        quantity: qty,
        paidPriceCents,
        totalCents,
        discountCents: totalDiscountCents,
        planDiscountCents,
        couponDiscountCents,
        taxable: item.taxable !== false,
        requiresShipping: item.requires_shipping !== false,
        fulfillableQuantity: item.fulfillable_quantity ?? null,
        fulfillmentService: item.fulfillment_service ?? null,
        properties: item.properties || null,
        taxLines: item.tax_lines || null,
        discountAllocations: item.discount_allocations || null,
      };
    });

    let financialStatus = raw.financial_status || "paid";
    let fulfillmentStatus = raw.fulfillment_status || "unfulfilled";

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
      customerName: raw.customer_name || raw.shipping_name || "",
      customerEmail: raw.customer_email || "",
      shipToName: raw.shipping_name,
      shipToAddress1: raw.shipping_address1,
      shipToAddress2: raw.shipping_address2,
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
      taxExempt: raw.tax_exempt === true,
      rawPayload: null, // we don't have the raw payload anymore
      notes: raw.note,
      tags: Array.isArray(raw.tags) ? raw.tags : (typeof raw.tags === 'string' ? raw.tags.split(",").map((t: string) => t.trim()) : []),
      shippingMethod: null,
      shippingMethodCode: null,
      orderedAt: raw.created_at ? new Date(raw.created_at) : new Date(),
      lineItems,
    };

    await omsService.ingestOrder(channelId, shopifyOrderId, orderData);
  } catch (err: any) {
    console.error(err);
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
        AND oo.channel_id IN (SELECT id FROM channels WHERE provider = 'shopify')
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
