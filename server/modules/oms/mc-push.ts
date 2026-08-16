/**
 * Push order events from Echelon OMS to Mission Control.
 * Fire-and-forget — non-blocking, non-fatal if MC is down.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { omsOrders, omsOrderLines } from "@shared/schema";
import { channels } from "@shared/schema";
import { extractMarketingConsent } from "./marketing-consent";

const MC_URL = process.env.MC_WEBHOOK_URL || "https://archon-os-20aa790cd70d.herokuapp.com";
const MC_WEBHOOK_SECRET = process.env.MC_WEBHOOK_SECRET || "echelon-to-mc-sync-2026";

const LOG_PREFIX = "[MC Push]";

export interface ChannelDiscountCode {
  code: string;
  amount: string;
  type: string;
}

/**
 * Discount codes live only in the original channel payload (Shopify format:
 * [{code, amount, type}] with amount as a dollar string — MC consumes it
 * as-is). Exported so the backfill script can decide which historical orders
 * are worth re-pushing without duplicating the shape knowledge.
 *
 * Pure: no IO, no mutation of the input.
 */
export function extractDiscountCodes(rawPayload: unknown): ChannelDiscountCode[] {
  const raw = (rawPayload as any)?.discount_codes;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((dc: any) => dc && typeof dc.code === "string" && dc.code.trim() !== "")
    .map((dc: any) => ({ code: dc.code, amount: dc.amount, type: dc.type }));
}

export async function pushToMissionControl(orderId: number, eventType: string): Promise<void> {
  try {
    // 1. Read the oms_orders row
    const [order] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.id, orderId))
      .limit(1);

    if (!order) {
      console.warn(`${LOG_PREFIX} Order ${orderId} not found, skipping push`);
      return;
    }

    // 2. Look up channel name
    let channelName = "Unknown";
    try {
      const [channel] = await db
        .select({ name: channels.name })
        .from(channels)
        .where(eq(channels.id, order.channelId))
        .limit(1);
      if (channel) channelName = channel.name;
    } catch (e: any) {
      console.warn(`${LOG_PREFIX} Could not look up channel ${order.channelId}: ${e.message}`);
    }

    // 3. Read line items
    const lines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, orderId));

    // product_id must be the CHANNEL's product id (externalProductId), not our
    // internal variant id — MC's recommendations mining joins on Shopify product ids.
    // price_cents is the pre-discount unit price (mirrors Shopify line_items[].price).
    const lineItems = lines.map((l) => ({
      sku: l.sku || null,
      title: l.title || null,
      variant_title: l.variantTitle || null,
      quantity: l.quantity,
      price_cents: l.retailPriceCents || 0,
      discount_cents: l.totalDiscountCents || 0,
      gift_card: l.giftCard ?? false,
      requires_shipping: l.requiresShipping ?? true,
      fulfillment_status: l.fulfillmentStatus || null,
      product_id: l.externalProductId ? Number(l.externalProductId) || null : null,
    }));

    // tags column holds a JSON array string; MC stores Shopify's comma-separated form
    let tags: string | null = null;
    if (order.tags) {
      try {
        const parsed = JSON.parse(order.tags);
        tags = Array.isArray(parsed) ? parsed.join(", ") : String(order.tags);
      } catch {
        tags = String(order.tags);
      }
    }

    const codes = extractDiscountCodes(order.rawPayload);
    const discountCodes = codes.length > 0 ? codes : null;

    // Marketing consent lives only in the raw checkout payload — no
    // oms_orders column carries it. MC needs it to decide whether a
    // purchaser is mailable; without it every buyer lands in the CRM as an
    // unmailable profile. Pass-through only: we extract, MC decides.
    const marketingConsent = extractMarketingConsent(order.rawPayload);

    // 4. Build payload
    const payload = {
      event: eventType,
      order: {
        external_order_id: order.externalOrderId,
        order_number: order.externalOrderNumber || null,
        channel_id: order.channelId,
        channel_name: channelName,
        customer_name: order.customerName || null,
        customer_email: order.customerEmail || null,
        customer_phone: order.customerPhone || null,
        // Channel-scoped customer id (Shopify customer id for Shopify orders)
        // — MC uses it as a CRM identity so a buyer who changes email still
        // resolves to one profile.
        external_customer_id: order.externalCustomerId || null,
        marketing_consent: marketingConsent,
        total_cents: order.totalCents,
        subtotal_cents: order.subtotalCents,
        shipping_cents: order.shippingCents,
        tax_cents: order.taxCents,
        discount_cents: order.discountCents,
        refund_cents: order.refundAmountCents || 0,
        discount_codes: discountCodes,
        tags,
        currency: order.currency || "USD",
        financial_status: order.financialStatus || "paid",
        fulfillment_status: order.fulfillmentStatus || "unfulfilled",
        status: order.status,
        ordered_at: order.orderedAt?.toISOString() || null,
        line_items: lineItems,
        tracking_number: order.trackingNumber || null,
        tracking_carrier: order.trackingCarrier || null,
      },
    };

    // 5. POST to MC — fire-and-forget
    const resp = await fetch(`${MC_URL}/api/orders/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": MC_WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      const body = await resp.json().catch(() => ({}));
      console.log(`${LOG_PREFIX} ✅ Pushed ${eventType} for order ${orderId} to MC (action: ${(body as any).action || "ok"})`);
    } else {
      console.warn(`${LOG_PREFIX} ⚠️ MC returned ${resp.status} for ${eventType} order ${orderId}`);
    }
  } catch (err: any) {
    console.error(`${LOG_PREFIX} ❌ Failed to push ${eventType} for order ${orderId}: ${err.message}`);
    // Never throw — fire-and-forget
  }
}
