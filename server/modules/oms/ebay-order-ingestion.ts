/**
 * eBay Order Ingestion
 *
 * Polling-based order ingestion from eBay Fulfillment API.
 * Runs every 5 minutes as a NON-NEGOTIABLE safety net.
 * Also handles webhook notifications for real-time order capture.
 *
 * All ingestion flows through OMS ingestOrder() which is idempotent.
 */

import type { Request, Response } from "express";
import type { OmsService, OrderData, LineItemData } from "./oms.service";
import type { ShipStationService } from "./shipstation.service";
import type { EbayApiClient } from "../channels/adapters/ebay/ebay-api.client";
import type { EbayAuthService } from "../channels/adapters/ebay/ebay-auth.service";
import type { EbayOrder, EbayNotificationPayload } from "../channels/adapters/ebay/ebay-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EBAY_CHANNEL_ID = 67;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — NON-NEGOTIABLE
const POLL_WINDOW_MINUTES = 30; // Look back 30 minutes each poll

// ---------------------------------------------------------------------------
// eBay Order → OMS OrderData mapping
// ---------------------------------------------------------------------------

function dollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

function mapEbayOrderToOrderData(ebayOrder: EbayOrder): OrderData {
  const shipTo = ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
  const address = shipTo?.contactAddress;
  const pricingSummary = ebayOrder.pricingSummary;

  const lineItems: LineItemData[] = (ebayOrder.lineItems || []).map((item) => {
    // lineItemCost = total product cost for this line (unit price × qty)
    // item.total = lineItemCost + shipping + tax (NOT what we want for line total)
    // For unit price: lineItemCost / quantity
    const lineItemCostCents = dollarsToCents(item.lineItemCost?.value);
    const qty = item.quantity || 1;
    const unitPriceCents = Math.round(lineItemCostCents / qty);

    // Tax: can be at line item level or in the tax field
    const taxCents = dollarsToCents(item.tax?.amount?.value);

    return {
      externalLineItemId: item.lineItemId,
      sku: item.sku,
      title: item.title,
      quantity: qty,
      unitPriceCents,
      totalCents: lineItemCostCents, // product cost only, no shipping/tax
      taxCents,
      discountCents: item.discountedLineItemCost
        ? lineItemCostCents - dollarsToCents(item.discountedLineItemCost?.value)
        : 0,
    };
  });

  // Map eBay payment status → financial_status
  let financialStatus = "paid";
  if (ebayOrder.orderPaymentStatus === "PENDING") financialStatus = "pending";
  else if (ebayOrder.orderPaymentStatus === "FAILED") financialStatus = "failed";
  else if (ebayOrder.orderPaymentStatus === "FULLY_REFUNDED") financialStatus = "refunded";
  else if (ebayOrder.orderPaymentStatus === "PARTIALLY_REFUNDED") financialStatus = "partially_refunded";

  // Map eBay fulfillment status
  let fulfillmentStatus = "unfulfilled";
  if (ebayOrder.orderFulfillmentStatus === "FULFILLED") fulfillmentStatus = "fulfilled";
  else if (ebayOrder.orderFulfillmentStatus === "IN_PROGRESS") fulfillmentStatus = "partially_fulfilled";

  // Determine initial status
  let status = "pending";
  if (ebayOrder.cancelStatus?.cancelState === "CANCELED") {
    status = "cancelled";
  } else if (financialStatus === "paid") {
    status = "confirmed";
  }

  return {
    externalOrderNumber: ebayOrder.salesRecordReference || ebayOrder.orderId,
    status,
    financialStatus,
    fulfillmentStatus,
    customerName: shipTo?.fullName || ebayOrder.buyer?.username,
    customerEmail: shipTo?.email,
    customerPhone: shipTo?.primaryPhone?.phoneNumber,
    shipToName: shipTo?.fullName,
    shipToAddress1: address?.addressLine1,
    shipToAddress2: address?.addressLine2,
    shipToCity: address?.city,
    shipToState: address?.stateOrProvince,
    shipToZip: address?.postalCode,
    shipToCountry: address?.countryCode,
    // Subtotal = sum of product costs (no shipping/tax)
    subtotalCents: dollarsToCents(pricingSummary?.priceSubtotal?.value),
    // Shipping = deliveryCost - deliveryDiscount (net shipping the buyer paid)
    shippingCents: Math.max(0,
      dollarsToCents(pricingSummary?.deliveryCost?.value) +
      dollarsToCents(pricingSummary?.deliveryDiscount?.value) // deliveryDiscount is negative
    ),
    // Tax: pricingSummary.tax OR sum from line items (eBay often omits order-level tax)
    taxCents: dollarsToCents(pricingSummary?.tax?.value) ||
      lineItems.reduce((sum, li) => sum + li.taxCents, 0),
    // Discounts: product discounts + delivery discount
    discountCents: dollarsToCents(pricingSummary?.priceDiscount?.value) +
      Math.abs(dollarsToCents(pricingSummary?.deliveryDiscount?.value)),
    // Total: recalculate = subtotal + net shipping + tax
    totalCents: dollarsToCents(pricingSummary?.priceSubtotal?.value) +
      Math.max(0, dollarsToCents(pricingSummary?.deliveryCost?.value) + dollarsToCents(pricingSummary?.deliveryDiscount?.value)) +
      (dollarsToCents(pricingSummary?.tax?.value) || lineItems.reduce((sum, li) => sum + li.taxCents, 0)),
    currency: pricingSummary?.total?.currency || "USD",
    rawPayload: ebayOrder as unknown,
    orderedAt: new Date(ebayOrder.creationDate),
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let pollInterval: ReturnType<typeof setInterval> | null = null;
let _shipStationService: ShipStationService | null = null;

export function setShipStationService(svc: ShipStationService) {
  _shipStationService = svc;
}

export function startEbayOrderPolling(
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
) {
  if (pollInterval) {
    clearInterval(pollInterval);
  }

  async function poll() {
    try {
      await pollEbayOrders(omsService, ebayApiClient);
    } catch (err: any) {
      console.error(`[eBay Orders] Poll error: ${err.message}`);
    }
  }

  // Run initial poll after 30 seconds (let server startup complete)
  setTimeout(poll, 30_000);

  // Then every 5 minutes
  pollInterval = setInterval(poll, POLL_INTERVAL_MS);
  console.log(`[eBay Orders] Polling started — every ${POLL_INTERVAL_MS / 1000}s`);
}

export function stopEbayOrderPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

/**
 * Poll eBay Fulfillment API for recent orders.
 * Looks back POLL_WINDOW_MINUTES to catch any missed orders.
 * Idempotent — duplicates are safely ignored by ingestOrder().
 */
export async function pollEbayOrders(
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
): Promise<number> {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - POLL_WINDOW_MINUTES * 60 * 1000);

  const filter = `creationdate:[${startDate.toISOString()}..${endDate.toISOString()}]`;

  let totalIngested = 0;
  let offset = 0;
  const limit = 50;

  while (true) {
    const response = await ebayApiClient.getOrders({ filter, limit, offset });

    if (!response.orders || response.orders.length === 0) break;

    for (const ebayOrder of response.orders) {
      try {
        const orderData = mapEbayOrderToOrderData(ebayOrder);
        const result = await omsService.ingestOrder(EBAY_CHANNEL_ID, ebayOrder.orderId, orderData);

        // If this was a new order (not a duplicate), do reservation + routing + ShipStation push
        if (result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000) {
          try {
            await omsService.reserveInventory(result.id);
            await omsService.assignWarehouse(result.id);
          } catch (e: any) {
            console.error(`[eBay Orders] Post-ingest processing failed for ${ebayOrder.orderId}: ${e.message}`);
          }

          // Auto-push to ShipStation
          if (_shipStationService?.isConfigured()) {
            try {
              const fullOrder = await omsService.getOrderById(result.id);
              if (fullOrder) {
                await _shipStationService.pushOrder(fullOrder);
              }
            } catch (e: any) {
              console.error(`[eBay Orders] ShipStation push failed for ${ebayOrder.orderId}: ${e.message}`);
            }
          }

          totalIngested++;
        }
      } catch (err: any) {
        console.error(`[eBay Orders] Failed to ingest order ${ebayOrder.orderId}: ${err.message}`);
      }
    }

    // Paginate
    if (response.orders.length < limit || offset + limit >= response.total) break;
    offset += limit;
  }

  if (totalIngested > 0) {
    console.log(`[eBay Orders] Poll complete — ${totalIngested} new order(s) ingested`);
  }

  return totalIngested;
}

// ---------------------------------------------------------------------------
// Webhook Handler
// ---------------------------------------------------------------------------

/**
 * eBay webhook endpoint for order notifications.
 *
 * Handles:
 * - Challenge validation (GET with challenge_code)
 * - ORDER_CONFIRMATION notifications (POST)
 */
export function createEbayOrderWebhookHandler(
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
) {
  return async function handleEbayOrderWebhook(req: Request, res: Response) {
    // eBay challenge validation — they send a GET with challenge_code
    if (req.method === "GET" && req.query.challenge_code) {
      const verificationToken = process.env.EBAY_VERIFICATION_TOKEN || "";
      const endpoint = process.env.EBAY_WEBHOOK_ENDPOINT || "";
      const challengeCode = req.query.challenge_code as string;

      // eBay expects: SHA-256(challengeCode + verificationToken + endpoint)
      const crypto = await import("crypto");
      const hash = crypto
        .createHash("sha256")
        .update(challengeCode + verificationToken + endpoint)
        .digest("hex");

      return res.status(200).json({ challengeResponse: hash });
    }

    // POST — order notification
    try {
      const payload = req.body as EbayNotificationPayload;

      if (!payload?.notification?.data) {
        return res.status(400).json({ error: "Invalid notification payload" });
      }

      const topic = payload.metadata?.topic;
      console.log(`[eBay Webhook] Received notification: ${topic}`);

      // Only process order-related topics
      if (topic?.includes("ORDER") || topic?.includes("order")) {
        const orderId = (payload.notification.data as any)?.orderId;
        if (orderId) {
          try {
            // Fetch the full order from eBay API
            const ebayOrder = await ebayApiClient.getOrder(orderId);
            const orderData = mapEbayOrderToOrderData(ebayOrder);
            const result = await omsService.ingestOrder(EBAY_CHANNEL_ID, orderId, orderData);

            // Post-ingest if newly created
            if (result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000) {
              await omsService.reserveInventory(result.id);
              await omsService.assignWarehouse(result.id);

              // Auto-push to ShipStation
              if (_shipStationService?.isConfigured()) {
                try {
                  const fullOrder = await omsService.getOrderById(result.id);
                  if (fullOrder) {
                    await _shipStationService.pushOrder(fullOrder);
                  }
                } catch (e: any) {
                  console.error(`[eBay Webhook] ShipStation push failed for ${orderId}: ${e.message}`);
                }
              }
            }

            console.log(`[eBay Webhook] Processed order ${orderId}`);
          } catch (err: any) {
            console.error(`[eBay Webhook] Failed to process order ${orderId}: ${err.message}`);
          }
        }
      }

      // Always acknowledge the webhook
      res.status(200).json({ status: "ok" });
    } catch (err: any) {
      console.error(`[eBay Webhook] Error: ${err.message}`);
      res.status(500).json({ error: "Internal error" });
    }
  };
}
