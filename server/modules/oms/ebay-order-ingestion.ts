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
import type { WmsSyncService } from "./wms-sync.service";
import type { EbayApiClient } from "../channels/adapters/ebay/ebay-api.client";
import type { EbayAuthService } from "../channels/adapters/ebay/ebay-auth.service";
import type { EbayOrder, EbayNotificationPayload } from "../channels/adapters/ebay/ebay-types";
import type { ReservationResult } from "../../services";
import { db } from "../../db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EBAY_CHANNEL_ID = 67;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — NON-NEGOTIABLE
const POLL_WINDOW_MINUTES = 240; // Look back 4 hours each poll (deploys/restarts shouldn't drop orders)

// ---------------------------------------------------------------------------
// eBay Order → OMS OrderData mapping
// ---------------------------------------------------------------------------

function dollarsToCents(value: string | undefined | null): number {
  if (!value) return 0;
  return Math.round(parseFloat(value) * 100);
}

function mapEbayOrderToOrderData(ebayOrder: EbayOrder): OrderData {
  const shippingStep = ebayOrder.fulfillmentStartInstructions?.[0]?.shippingStep;
  const shipTo = shippingStep?.shipTo;
  const address = shipTo?.contactAddress;
  const pricingSummary = ebayOrder.pricingSummary;

  // eBay's per-order ship-by deadline — the platform's hard commitment for
  // this order. Feeds the SLA slot of sort_rank so urgent ship-by orders
  // outrank generic 3-day-default orders.
  const channelShipByRaw = (shippingStep as any)?.shipByDate;
  const channelShipByDate = channelShipByRaw ? new Date(channelShipByRaw) : null;

  const lineItems: LineItemData[] = (ebayOrder.lineItems || []).map((item) => {
    // lineItemCost = total product cost for this line (unit price × qty)
    // item.total = lineItemCost + shipping + tax (NOT what we want for line total)
    // For unit price: lineItemCost / quantity
    const lineItemCostCents = dollarsToCents(item.lineItemCost?.value);
    const qty = item.quantity || 1;
    const paidPriceCents = Math.round(lineItemCostCents / qty);
    const discountCents = item.discountedLineItemCost
      ? lineItemCostCents - dollarsToCents(item.discountedLineItemCost?.value)
      : 0;

    // Tax: eBay collects and remits — omit from line items
    const taxCents = 0;

    return {
      externalLineItemId: item.lineItemId,
      externalProductId: item.legacyItemId || null, // eBay product ID
      sku: item.sku,
      title: item.title,
      quantity: qty,
      paidPriceCents,
      totalCents: lineItemCostCents, // product cost only, no shipping/tax
      taxCents,
      discountCents,
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
    externalOrderNumber: ebayOrder.orderId,
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
    shippingCents: dollarsToCents(pricingSummary?.deliveryCost?.value),
    // Tax: eBay collects and remits — we never see this money. Omit from OMS totals.
    // Raw tax data preserved in raw_payload for reference.
    taxCents: 0,
    // Discounts: product discounts
    discountCents: dollarsToCents(pricingSummary?.priceDiscount?.value),
    // Total: subtotal + net shipping (no tax — eBay handles it)
    totalCents: dollarsToCents(pricingSummary?.priceSubtotal?.value) +
      dollarsToCents(pricingSummary?.deliveryCost?.value),
    currency: pricingSummary?.total?.currency || "USD",
    rawPayload: ebayOrder as unknown,
    orderedAt: new Date(ebayOrder.creationDate),
    channelShipByDate,
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

let pollInterval: ReturnType<typeof setInterval> | null = null;
let _shipStationService: ShipStationService | null = null;
let _wmsSyncService: WmsSyncService | null = null;
let _wmsServices: {
  reservation: { reserveOrder: (orderId: number) => Promise<ReservationResult> };
  fulfillmentRouter: { routeOrder: (ctx: any) => Promise<any>; assignWarehouseToOrder: (orderId: number, routing: any) => Promise<void> };
  slaMonitor: { setSLAForOrder: (orderId: number) => Promise<void> };
} | null = null;

export function setShipStationService(svc: ShipStationService) {
  _shipStationService = svc;
}

export function setWmsServices(svc: typeof _wmsServices) {
  _wmsServices = svc;
}

export function setWmsSyncService(wmsSyncService: WmsSyncService) {
  _wmsSyncService = wmsSyncService;
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

        // Check if existing order needs status update (cancelled, refunded)
        const isNew = result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000;
        if (!isNew && result.id) {
          const existing = await omsService.getOrderById(result.id);
          if (existing && existing.status !== orderData.status) {
            // Status changed on eBay — update OMS
            if (orderData.status === "cancelled" && existing.status !== "cancelled") {
              console.log(`[eBay Orders] Order ${ebayOrder.orderId} cancelled on eBay — updating OMS`);
              await db.execute(sql`
                UPDATE oms_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                WHERE id = ${result.id} AND status != 'cancelled'
              `);
              // Release WMS reservation
              try {
                const wmsOrder = await db.execute(sql`
                  SELECT id FROM wms.orders
                  WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(result.id)})
                     OR source_table_id = ${String(result.id)}
                  LIMIT 1
                `);
                if (wmsOrder.rows.length > 0) {
                  await db.execute(sql`
                    UPDATE wms.orders SET warehouse_status = 'cancelled', cancelled_at = NOW()
                    WHERE id = ${wmsOrder.rows[0].id} AND warehouse_status NOT IN ('in_progress', 'ready_to_ship', 'shipped', 'cancelled')
                  `);
                }
              } catch (e: any) {
                console.error(`[eBay Orders] Failed to cancel WMS order for ${ebayOrder.orderId}: ${e.message}`);
              }
            }
            if ((orderData.financialStatus === "refunded" || orderData.financialStatus === "partially_refunded") 
                && existing.financialStatus !== orderData.financialStatus) {
              console.log(`[eBay Orders] Order ${ebayOrder.orderId} ${orderData.financialStatus} on eBay — updating OMS`);
              await db.execute(sql`
                UPDATE oms_orders SET financial_status = ${orderData.financialStatus}, refunded_at = NOW(), updated_at = NOW()
                WHERE id = ${result.id}
              `);
            }
          }
        }

        // If this was a new order (not a duplicate), sync to WMS for fulfillment
        if (isNew) {
          // Sync OMS → WMS (single path — plan §6 C10)
          if (!_wmsSyncService) {
            throw new Error(
              "[eBay Orders] _wmsSyncService must be initialized; legacy createWmsOrderFromEbay fallback removed (plan §6 C10)",
            );
          }
          try {
            await _wmsSyncService.syncOmsOrderToWms(result.id);
          } catch (e: any) {
            console.error(`[eBay Orders] WMS sync failed for ${ebayOrder.orderId}: ${e.message}`);
          }

          // OMS-level reservation (delegates to WMS reservation service)
          try {
            await omsService.reserveInventory(result.id);
            await omsService.assignWarehouse(result.id);
          } catch (e: any) {
            console.error(`[eBay Orders] Post-ingest processing failed for ${ebayOrder.orderId}: ${e.message}`);
          }

          // ShipStation push handled by wmsSyncService.syncOmsOrderToWms()

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
/**
 * Manually re-ingest a single eBay order by orderId. Used when the poll
 * window missed it (e.g. deploy took the app down past the lookback) or
 * when debugging. Fetches the live order from eBay and pipes it through
 * the same ingestion path webhooks use.
 */
export async function reingestEbayOrder(
  orderId: string,
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
): Promise<{ status: "ingested" | "already_existed"; omsOrderId: number }> {
  const ebayOrder = await ebayApiClient.getOrder(orderId);
  if (!ebayOrder) throw new Error(`eBay order ${orderId} not found on platform`);

  const orderData = mapEbayOrderToOrderData(ebayOrder);
  const result = await omsService.ingestOrder(EBAY_CHANNEL_ID, orderId, orderData);

  const wasCreated =
    result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000;

  if (wasCreated) {
    // Full post-ingest pipeline: WMS sync, reserve, assign, push.
    if (!_wmsSyncService) {
      throw new Error(
        "[eBay Orders] _wmsSyncService must be initialized; legacy createWmsOrderFromEbay fallback removed (plan §6 C10)",
      );
    }
    try {
      await _wmsSyncService.syncOmsOrderToWms(result.id);
    } catch (err: any) {
      console.error(`[eBay Reingest] WMS sync failed for ${orderId}: ${err.message}`);
    }

    try {
      await omsService.reserveInventory(result.id);
      await omsService.assignWarehouse(result.id);
    } catch (err: any) {
      console.error(`[eBay Reingest] Post-ingest (reserve/assign) failed for ${orderId}: ${err.message}`);
    }
    // ShipStation push handled by wmsSyncService.syncOmsOrderToWms()
  }

  return {
    status: wasCreated ? "ingested" : "already_existed",
    omsOrderId: result.id,
  };
}

export function createEbayOrderWebhookHandler(
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
) {
  return async function handleEbayOrderWebhook(req: Request, res: Response) {
    // eBay challenge validation — they send a GET with challenge_code
    if (req.method === "GET" && req.query.challenge_code) {
      const verificationToken = process.env.EBAY_VERIFICATION_TOKEN;
      const endpoint = process.env.EBAY_WEBHOOK_ENDPOINT;

      if (!verificationToken || !endpoint) {
        return res.status(500).json({ error: "Server missing eBay webhook configuration" });
      }
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

            // Post-ingest if newly created — mirrors the polling path (plan §6 C10)
            const isNew = result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000;
            if (isNew) {
              // Sync OMS → WMS (single path — plan §6 C10)
              if (!_wmsSyncService) {
                throw new Error(
                  "[eBay Orders] _wmsSyncService must be initialized; legacy createWmsOrderFromEbay fallback removed (plan §6 C10)",
                );
              }
              try {
                await _wmsSyncService.syncOmsOrderToWms(result.id);
              } catch (e: any) {
                console.error(`[eBay Webhook] WMS sync failed for ${orderId}: ${e.message}`);
              }

              // OMS-level reservation (delegates to WMS reservation service)
              try {
                await omsService.reserveInventory(result.id);
                await omsService.assignWarehouse(result.id);
              } catch (e: any) {
                console.error(`[eBay Webhook] Post-ingest processing failed for ${orderId}: ${e.message}`);
              }
              // ShipStation push handled by wmsSyncService.syncOmsOrderToWms()
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
