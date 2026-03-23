/**
 * Push order events from Echelon OMS to Mission Control.
 * Fire-and-forget — non-blocking, non-fatal if MC is down.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { omsOrders, omsOrderLines } from "@shared/schema";
import { channels } from "@shared/schema";

const MC_URL = process.env.MC_WEBHOOK_URL || "https://archon-os-20aa790cd70d.herokuapp.com";
const MC_WEBHOOK_SECRET = process.env.MC_WEBHOOK_SECRET || "echelon-to-mc-sync-2026";

const LOG_PREFIX = "[MC Push]";

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

    const lineItems = lines.map((l) => ({
      sku: l.sku || null,
      title: l.title || null,
      quantity: l.quantity,
      price_cents: l.unitPriceCents || 0,
      product_id: l.productVariantId || null,
    }));

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
        total_cents: order.totalCents,
        subtotal_cents: order.subtotalCents,
        shipping_cents: order.shippingCents,
        tax_cents: order.taxCents,
        discount_cents: order.discountCents,
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
