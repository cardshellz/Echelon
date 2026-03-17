/**
 * Fulfillment Push Service
 *
 * Pushes tracking numbers back to the originating channel when an OMS order
 * is marked shipped. Supports eBay (and future channels).
 */

import { eq } from "drizzle-orm";
import { omsOrders, omsOrderLines, omsOrderEvents, channels } from "@shared/schema";
import type { EbayApiClient } from "../channels/adapters/ebay/ebay-api.client";
import type { EbayShippingFulfillmentRequest } from "../channels/adapters/ebay/ebay-types";

// ---------------------------------------------------------------------------
// Carrier code mapping: WMS/internal → eBay carrier codes
// ---------------------------------------------------------------------------

const CARRIER_MAP: Record<string, string> = {
  usps: "USPS",
  "us postal service": "USPS",
  ups: "UPS",
  "united parcel service": "UPS",
  fedex: "FEDEX",
  "federal express": "FEDEX",
  dhl: "DHL",
  // Pass through if already correct
  USPS: "USPS",
  UPS: "UPS",
  FEDEX: "FEDEX",
  DHL: "DHL",
};

function mapCarrierCode(carrier: string): string {
  return CARRIER_MAP[carrier.toLowerCase()] || CARRIER_MAP[carrier] || carrier.toUpperCase();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function createFulfillmentPushService(
  db: any,
  ebayApiClient: EbayApiClient | null,
) {
  /**
   * Push tracking to the originating channel for a shipped OMS order.
   */
  async function pushTracking(orderId: number): Promise<boolean> {
    const [order] = await db
      .select()
      .from(omsOrders)
      .where(eq(omsOrders.id, orderId))
      .limit(1);

    if (!order) {
      console.error(`[FulfillmentPush] Order ${orderId} not found`);
      return false;
    }

    if (!order.trackingNumber || !order.trackingCarrier) {
      console.warn(`[FulfillmentPush] Order ${orderId} has no tracking info`);
      return false;
    }

    // Get channel info
    const [channel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, order.channelId))
      .limit(1);

    if (!channel) {
      console.error(`[FulfillmentPush] Channel ${order.channelId} not found`);
      return false;
    }

    try {
      if (channel.provider === "ebay") {
        return await pushToEbay(order, orderId);
      } else if (channel.provider === "shopify") {
        // Shopify tracking is handled by the existing fulfillment webhook flow
        // No push needed — Shopify already has its own fulfillment system
        console.log(`[FulfillmentPush] Skipping Shopify push for order ${orderId} — handled natively`);
        return true;
      }

      console.warn(`[FulfillmentPush] No push handler for provider: ${channel.provider}`);
      return false;
    } catch (err: any) {
      console.error(`[FulfillmentPush] Failed to push tracking for order ${orderId}: ${err.message}`);

      // Record failure event
      await db.insert(omsOrderEvents).values({
        orderId,
        eventType: "tracking_push_failed",
        details: { error: err.message, provider: channel.provider },
      });

      return false;
    }
  }

  async function pushToEbay(order: any, orderId: number): Promise<boolean> {
    if (!ebayApiClient) {
      console.error(`[FulfillmentPush] eBay API client not available`);
      return false;
    }

    // Get line items for the fulfillment payload
    const lines = await db
      .select()
      .from(omsOrderLines)
      .where(eq(omsOrderLines.orderId, orderId));

    if (lines.length === 0) {
      console.warn(`[FulfillmentPush] No line items for order ${orderId}`);
      return false;
    }

    const fulfillmentPayload: EbayShippingFulfillmentRequest = {
      lineItems: lines
        .filter((l: any) => l.externalLineItemId)
        .map((l: any) => ({
          lineItemId: l.externalLineItemId,
          quantity: l.quantity,
        })),
      shippedDate: (order.shippedAt || new Date()).toISOString(),
      shippingCarrierCode: mapCarrierCode(order.trackingCarrier),
      trackingNumber: order.trackingNumber,
    };

    const result = await ebayApiClient.createShippingFulfillment(
      order.externalOrderId,
      fulfillmentPayload,
    );

    console.log(`[FulfillmentPush] eBay tracking pushed for order ${orderId} → fulfillment ${result.fulfillmentId}`);

    // Record success event
    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "tracking_pushed",
      details: {
        provider: "ebay",
        fulfillmentId: result.fulfillmentId,
        trackingNumber: order.trackingNumber,
        carrier: order.trackingCarrier,
      },
    });

    return true;
  }

  return { pushTracking };
}

export type FulfillmentPushService = ReturnType<typeof createFulfillmentPushService>;
