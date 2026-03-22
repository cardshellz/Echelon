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

    // Push to Card Shellz's eBay (or the originating channel)
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

    // ------ VENDOR TRACKING PUSH ------
    // If this is a dropship order (has vendor_id), also push tracking to the VENDOR's eBay
    if (order.vendorId) {
      try {
        await pushTrackingToVendorEbay(order, orderId, fulfillmentPayload);
      } catch (vendorPushErr: any) {
        console.error(`[FulfillmentPush] Vendor eBay tracking push failed for order ${orderId}: ${vendorPushErr.message}`);
        // Record failure but don't fail the overall push
        await db.insert(omsOrderEvents).values({
          orderId,
          eventType: "vendor_tracking_push_failed",
          details: { error: vendorPushErr.message, vendorId: order.vendorId },
        });
      }
    }

    return true;
  }

  /**
   * Push tracking to a vendor's eBay account for a dropship order.
   * Uses the vendor's OAuth token (not Card Shellz's).
   */
  async function pushTrackingToVendorEbay(
    order: any,
    orderId: number,
    fulfillmentPayload: EbayShippingFulfillmentRequest,
  ): Promise<void> {
    const { getVendorEbayToken } = await import("../dropship/vendor-ebay.routes");
    const https = await import("https");

    const vendorId = order.vendorId;
    const accessToken = await getVendorEbayToken(vendorId);
    if (!accessToken) {
      console.warn(`[FulfillmentPush] No valid eBay token for vendor ${vendorId} — skipping vendor tracking push`);
      return;
    }

    // The vendor_order_ref is the eBay order ID on the vendor's account
    const vendorOrderRef = order.vendorOrderRef || order.externalOrderId;

    const environment = process.env.EBAY_ENVIRONMENT || "production";
    const hostname = environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";
    const path = `/sell/fulfillment/v1/order/${encodeURIComponent(vendorOrderRef)}/shipping_fulfillment`;

    const payload = JSON.stringify(fulfillmentPayload);

    const result = await new Promise<any>((resolve, reject) => {
      const options = {
        hostname,
        path,
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Language": "en-US",
          "Accept-Language": "en-US",
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
          } else {
            reject(new Error(`Vendor eBay tracking push failed (${res.statusCode}): ${data.substring(0, 500)}`));
          }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    console.log(`[FulfillmentPush] Vendor eBay tracking pushed for order ${orderId}, vendor ${vendorId} → fulfillment ${result.fulfillmentId || "ok"}`);

    // Record vendor tracking push event
    await db.insert(omsOrderEvents).values({
      orderId,
      eventType: "vendor_tracking_pushed",
      details: {
        provider: "ebay",
        vendorId,
        fulfillmentId: result.fulfillmentId || null,
        trackingNumber: order.trackingNumber,
        carrier: order.trackingCarrier,
      },
    });
  }

  return { pushTracking };
}

export type FulfillmentPushService = ReturnType<typeof createFulfillmentPushService>;
