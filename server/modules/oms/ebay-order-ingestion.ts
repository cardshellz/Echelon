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
import {
  buildEbayWebhookInboxInput,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSucceeded,
  recordWebhookReceived,
} from "./webhook-inbox.service";
import { enqueueOmsWmsSyncRetry } from "./webhook-retry.worker";
import { extractEbayShipByDate } from "./ebay-shipby";
import { envPositiveInteger } from "../../infrastructure/scheduler-config";
import {
  markEbayOrderPollFailed,
  markEbayOrderPollRunStarted,
  markEbayOrderPollStarted,
  markEbayOrderPollSucceeded,
} from "./ebay-order-poll-heartbeat";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EBAY_CHANNEL_ID = 67;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — NON-NEGOTIABLE

const POLL_OVERLAP_MINUTES = envPositiveInteger(
  "EBAY_ORDER_POLL_OVERLAP_MINUTES",
  24 * 60,
);
const POLL_DEEP_SCAN_INTERVAL_MINUTES = envPositiveInteger(
  "EBAY_ORDER_DEEP_SCAN_INTERVAL_MINUTES",
  60,
);
const POLL_DEEP_SCAN_LOOKBACK_DAYS = envPositiveInteger(
  "EBAY_ORDER_DEEP_SCAN_LOOKBACK_DAYS",
  30,
);

interface EbayOrderPollCheckpoint {
  last_window_end: Date | string | null;
  last_deep_scan_at: Date | string | null;
}

interface EbayOrderPollWindow {
  startDate: Date;
  endDate: Date;
  deepScan: boolean;
}

export interface EbayOrderPollOptions {
  database?: any;
  now?: Date;
  forceDeepScan?: boolean;
}

function firstResultRow<T>(result: any): T | null {
  return Array.isArray(result?.rows) && result.rows.length > 0
    ? result.rows[0] as T
    : null;
}

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

async function resolveEbayOrderPollWindow(
  database: any,
  now: Date,
  forceDeepScan: boolean,
): Promise<EbayOrderPollWindow> {
  const checkpointResult = await database.execute(sql`
    SELECT last_window_end, last_deep_scan_at
    FROM oms.ebay_order_poll_checkpoints
    WHERE channel_id = ${EBAY_CHANNEL_ID}
    LIMIT 1
  `);
  const checkpoint = firstResultRow<EbayOrderPollCheckpoint>(checkpointResult);
  const lastWindowEnd = validDate(checkpoint?.last_window_end);
  const lastDeepScanAt = validDate(checkpoint?.last_deep_scan_at);
  const deepScanDue = forceDeepScan
    || lastDeepScanAt === null
    || now.getTime() - lastDeepScanAt.getTime()
      >= POLL_DEEP_SCAN_INTERVAL_MINUTES * 60_000;

  if (deepScanDue) {
    return {
      startDate: new Date(
        now.getTime() - POLL_DEEP_SCAN_LOOKBACK_DAYS * 24 * 60 * 60_000,
      ),
      endDate: now,
      deepScan: true,
    };
  }

  const cursorMs = Math.min(lastWindowEnd?.getTime() ?? now.getTime(), now.getTime());
  return {
    startDate: new Date(cursorMs - POLL_OVERLAP_MINUTES * 60_000),
    endDate: now,
    deepScan: false,
  };
}

async function markEbayOrderPollRunInDatabase(database: any, now: Date): Promise<void> {
  await database.execute(sql`
    INSERT INTO oms.ebay_order_poll_checkpoints (
      channel_id,
      last_run_at,
      created_at,
      updated_at
    )
    VALUES (${EBAY_CHANNEL_ID}, ${now}, NOW(), NOW())
    ON CONFLICT (channel_id)
    DO UPDATE SET
      last_run_at = EXCLUDED.last_run_at,
      updated_at = NOW()
  `);
}

async function markEbayOrderPollSuccessInDatabase(
  database: any,
  window: EbayOrderPollWindow,
  ordersSeen: number,
  ordersIngested: number,
): Promise<void> {
  await database.execute(sql`
    UPDATE oms.ebay_order_poll_checkpoints
    SET last_window_end = ${window.endDate},
        last_success_at = NOW(),
        last_deep_scan_at = CASE
          WHEN ${window.deepScan} THEN ${window.endDate}
          ELSE last_deep_scan_at
        END,
        last_error = NULL,
        consecutive_failures = 0,
        last_orders_seen = ${ordersSeen},
        last_orders_ingested = ${ordersIngested},
        updated_at = NOW()
    WHERE channel_id = ${EBAY_CHANNEL_ID}
  `);
}

async function markEbayOrderPollFailureInDatabase(
  database: any,
  error: unknown,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  await database.execute(sql`
    UPDATE oms.ebay_order_poll_checkpoints
    SET last_error = ${message},
        consecutive_failures = consecutive_failures + 1,
        updated_at = NOW()
    WHERE channel_id = ${EBAY_CHANNEL_ID}
  `);
}

async function enqueueEbayOrderIngestRetry(
  database: any,
  orderId: string,
  error: unknown,
  source: string,
): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  const payload = {
    metadata: { topic: "EBAY_ORDER_INGEST_RECOVERY" },
    notification: { data: { orderId } },
    recovery: { source },
  };
  await database.execute(sql`
    INSERT INTO oms.webhook_retry_queue (
      provider,
      topic,
      payload,
      attempts,
      last_error,
      next_retry_at,
      status,
      created_at,
      updated_at
    )
    VALUES (
      'ebay',
      'EBAY_ORDER_INGEST_RECOVERY',
      ${JSON.stringify(payload)}::jsonb,
      0,
      ${message},
      NOW(),
      'pending',
      NOW(),
      NOW()
    )
    ON CONFLICT DO NOTHING
  `);
}

async function ensureEbayOrderQueuedForWmsSync(
  wmsSyncService: WmsSyncService | null,
  omsOrderId: number,
  externalOrderId: string,
  database: any = db,
): Promise<void> {
  if (!wmsSyncService) {
    const err = new Error(
      "[eBay Orders] _wmsSyncService must be initialized; legacy createWmsOrderFromEbay fallback removed (plan §6 C10)",
    );
    await enqueueOmsWmsSyncRetry(database, omsOrderId, err);
    throw err;
  }

  try {
    const wmsOrderId = await wmsSyncService.syncOmsOrderToWms(omsOrderId);
    if (!wmsOrderId) {
      // `null` = sync intentionally skipped (order already final/fulfilled out-of-band) —
      // a no-op, not a failure. Do NOT re-queue it (that just dead-letters a harmless skip).
      console.log(`[eBay Orders] WMS sync skipped for ${externalOrderId} (omsOrder ${omsOrderId}) — already fulfilled out-of-band; no-op`);
    }
  } catch (err: any) {
    await enqueueOmsWmsSyncRetry(database, omsOrderId, err);
    console.error(`[eBay Orders] WMS sync failed for ${externalOrderId}: ${err.message}`);
  }
}

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

  const channelShipByDate = extractEbayShipByDate(ebayOrder);

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
      name: item.title,
      quantity: qty,
      fulfillmentProvider: "ebay",
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
    sourceTopic: "ebay/order",
    externalOrderNumber: ebayOrder.orderId,
    status,
    financialStatus,
    fulfillmentStatus,
    customerName: shipTo?.fullName || ebayOrder.buyer?.username,
    customerEmail: shipTo?.email,
    customerPhone: shipTo?.primaryPhone?.phoneNumber,
    // Channel-agnostic customer id — for eBay this is the buyer username (eBay's stable buyer identifier).
    externalCustomerId: ebayOrder.buyer?.username || undefined,
    shipToName: shipTo?.fullName,
    shipToCompany: (shipTo as any)?.companyName || (address as any)?.companyName || null,
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
let pollInFlight = false;
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

  markEbayOrderPollStarted();

  async function poll() {
    if (pollInFlight) {
      console.warn("[eBay Orders] Previous poll is still running; overlapping poll skipped");
      return;
    }
    pollInFlight = true;
    try {
      await pollEbayOrders(omsService, ebayApiClient);
    } catch (err: any) {
      console.error(`[eBay Orders] Poll error: ${err.message}`);
    } finally {
      pollInFlight = false;
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
 * Uses a durable checkpoint, a 24-hour overlap, and an hourly 30-day deep scan.
 * Idempotent — duplicates are safely ignored by ingestOrder().
 */
export async function pollEbayOrders(
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
  options: EbayOrderPollOptions = {},
): Promise<number> {
  const database = options.database ?? db;
  markEbayOrderPollRunStarted();
  try {
    return await runEbayOrderPoll(omsService, ebayApiClient, options);
  } catch (error) {
    markEbayOrderPollFailed(error);
    try {
      await markEbayOrderPollFailureInDatabase(database, error);
    } catch (checkpointError: any) {
      console.error(
        `[eBay Orders] Failed to record poll checkpoint error: ${checkpointError.message}`,
      );
    }
    throw error;
  }
}

async function runEbayOrderPoll(
  omsService: OmsService,
  ebayApiClient: EbayApiClient,
  options: EbayOrderPollOptions = {},
): Promise<number> {
  const database = options.database ?? db;
  const now = options.now ?? new Date();
  const window = await resolveEbayOrderPollWindow(
    database,
    now,
    options.forceDeepScan === true,
  );
  await markEbayOrderPollRunInDatabase(database, now);
  const endDate = window.endDate;
  const startDate = window.startDate;

  // P0.6: sweep BOTH windows. creationdate catches new orders;
  // lastmodifieddate catches late cancels/refunds on orders created before
  // the window (the creationdate-only filter silently missed those).
  const filters = [
    `creationdate:[${startDate.toISOString()}..${endDate.toISOString()}]`,
    `lastmodifieddate:[${startDate.toISOString()}..${endDate.toISOString()}]`,
  ];

  let totalIngested = 0;
  let ordersSeen = 0;
  const limit = 50;
  const seenThisPoll = new Set<string>();
  const failedOrders: Array<{ orderId: string; error: string }> = [];

  for (const filter of filters) {
  let offset = 0;
  while (true) {
    const response = await ebayApiClient.getOrders({ filter, limit, offset });

    if (!response.orders || response.orders.length === 0) break;

    for (const ebayOrder of response.orders) {
      try {
        if (seenThisPoll.has(ebayOrder.orderId)) continue;
        seenThisPoll.add(ebayOrder.orderId);
        ordersSeen++;
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
              await database.execute(sql`
                UPDATE oms_orders SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
                WHERE id = ${result.id} AND status != 'cancelled'
              `);
              // Release WMS reservation
              try {
                const wmsOrder = await database.execute(sql`
                  SELECT id FROM wms.orders
                  WHERE (source = 'oms' AND oms_fulfillment_order_id = ${String(result.id)})
                     OR source_table_id = ${String(result.id)}
                  LIMIT 1
                `);
                if (wmsOrder.rows.length > 0) {
                  const { cancelOrder: cancelWmsOrder } = await import("../orders/order-status-core");
                  await cancelWmsOrder(database, Number(wmsOrder.rows[0].id), "ebay_cancel");
                }
              } catch (e: any) {
                console.error(`[eBay Orders] Failed to cancel WMS order for ${ebayOrder.orderId}: ${e.message}`);
              }
            }
            if ((orderData.financialStatus === "refunded" || orderData.financialStatus === "partially_refunded")
                && existing.financialStatus !== orderData.financialStatus) {
              console.log(`[eBay Orders] Order ${ebayOrder.orderId} ${orderData.financialStatus} on eBay — updating OMS`);
              // eBay polls don't provide refund dollar amounts; full refund = total_cents,
              // partial = 0 (best-effort until eBay returns API exposes amounts).
              const refundAmountCents = orderData.financialStatus === "refunded" ? (existing.totalCents ?? 0) : 0;
              await database.execute(sql`
                UPDATE oms_orders
                SET financial_status = ${orderData.financialStatus},
                    refunded_at = NOW(),
                    refund_amount_cents = ${refundAmountCents},
                    updated_at = NOW()
                WHERE id = ${result.id}
              `);
            }
          }
        }

        // If this was a new order, or an existing order that never got
        // routed, run the fulfillment path. Polling can see an order after a
        // webhook inserted it, so "already existed" must not mean "already
        // reached WMS".
        if (isNew || !result.warehouseId) {
          await ensureEbayOrderQueuedForWmsSync(
            _wmsSyncService,
            result.id,
            ebayOrder.orderId,
            database,
          );

          if (!result.warehouseId) {
            // OMS-level reservation (delegates to WMS reservation service)
            try {
              await omsService.reserveInventory(result.id);
              await omsService.assignWarehouse(result.id);
            } catch (e: any) {
              console.error(`[eBay Orders] Post-ingest processing failed for ${ebayOrder.orderId}: ${e.message}`);
            }
          }

          await ensureEbayOrderQueuedForWmsSync(
            _wmsSyncService,
            result.id,
            ebayOrder.orderId,
            database,
          );
          totalIngested++;
        }
      } catch (err: any) {
        const message = err?.message || String(err);
        failedOrders.push({ orderId: ebayOrder.orderId, error: message });
        console.error(`[eBay Orders] Failed to ingest order ${ebayOrder.orderId}: ${message}`);
        await enqueueEbayOrderIngestRetry(
          database,
          ebayOrder.orderId,
          err,
          window.deepScan ? "deep_scan" : "incremental_poll",
        );
      }
    }

    // Paginate
    if (response.orders.length < limit || offset + limit >= response.total) break;
    offset += limit;
  }
  }

  if (failedOrders.length > 0) {
    throw new Error(
      `${failedOrders.length} eBay order(s) failed ingestion: ${
        failedOrders.map((item) => item.orderId).join(", ")
      }`,
    );
  }

  await markEbayOrderPollSuccessInDatabase(
    database,
    window,
    ordersSeen,
    totalIngested,
  );
  markEbayOrderPollSucceeded({
    windowStart: window.startDate,
    windowEnd: window.endDate,
    deepScan: window.deepScan,
    ordersSeen,
    ordersIngested: totalIngested,
  });

  if (totalIngested > 0) {
    console.log(`[eBay Orders] Poll complete — ${totalIngested} new order(s) ingested`);
  }

  console.log(
    `[eBay Orders] Poll checkpoint advanced - mode=${window.deepScan ? "deep" : "incremental"} `
    + `window=${window.startDate.toISOString()}..${window.endDate.toISOString()} `
    + `seen=${ordersSeen} ingested=${totalIngested}`,
  );
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

  if (wasCreated || !result.warehouseId) {
    await ensureEbayOrderQueuedForWmsSync(_wmsSyncService, result.id, orderId);

    if (!result.warehouseId) {
      try {
        await omsService.reserveInventory(result.id);
        await omsService.assignWarehouse(result.id);
      } catch (err: any) {
        console.error(`[eBay Reingest] Post-ingest (reserve/assign) failed for ${orderId}: ${err.message}`);
      }
    }

    await ensureEbayOrderQueuedForWmsSync(_wmsSyncService, result.id, orderId);
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
      // P0.6: the route is now PUBLIC (eBay can't hold a session). Defense
      // in depth: (1) require eBay's signature header — casual scans bounce;
      // (2) the payload is never trusted for order DATA — we only take the
      // orderId and re-fetch the full order from eBay's authenticated API,
      // so a forged POST can at worst trigger an idempotent re-ingest of a
      // REAL order. Full cryptographic verification of x-ebay-signature
      // (eBay Notification SDK public-key flow) is tracked as follow-up.
      if (!req.headers["x-ebay-signature"]) {
        return res.status(401).json({ error: "Missing notification signature" });
      }

      const payload = req.body as EbayNotificationPayload;

      if (!payload?.notification?.data) {
        return res.status(400).json({ error: "Invalid notification payload" });
      }

      const topic = payload.metadata?.topic;
      console.log(`[eBay Webhook] Received notification: ${topic}`);

      let inbox: { id: number } | null = null;
      try {
        const receipt = await recordWebhookReceived(db, buildEbayWebhookInboxInput(req, payload));
        inbox = { id: receipt.id };

        if (!receipt.inserted && receipt.status === "succeeded") {
          console.log(`[eBay Webhook] Duplicate already succeeded (inbox=${receipt.id}), skipping`);
          return res.status(200).json({ status: "ok", duplicate: true });
        }
        if (!receipt.inserted && receipt.status === "processing") {
          console.log(`[eBay Webhook] Duplicate already processing (inbox=${receipt.id}), skipping`);
          return res.status(200).json({ status: "ok", duplicate: true });
        }

        await markWebhookProcessing(db, receipt.id);
      } catch (err: any) {
        console.error(`[eBay Webhook] Inbox write failed: ${err.message}`);
        return res.status(500).json({ error: "webhook inbox unavailable" });
      }

      // Only process order-related topics
      if (topic?.includes("ORDER") || topic?.includes("order")) {
        const orderId = (payload.notification.data as any)?.orderId;
        if (orderId) {
          try {
            // Fetch the full order from eBay API
            const ebayOrder = await ebayApiClient.getOrder(orderId);
            const orderData = mapEbayOrderToOrderData(ebayOrder);
            const result = await omsService.ingestOrder(EBAY_CHANNEL_ID, orderId, orderData);

            // Post-ingest if newly created, or if a prior delivery inserted
            // the OMS order but did not finish routing it to WMS.
            const isNew = result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000;
            if (isNew || !result.warehouseId) {
              await ensureEbayOrderQueuedForWmsSync(_wmsSyncService, result.id, orderId);

              if (!result.warehouseId) {
                // OMS-level reservation (delegates to WMS reservation service)
                try {
                  await omsService.reserveInventory(result.id);
                  await omsService.assignWarehouse(result.id);
                } catch (e: any) {
                  console.error(`[eBay Webhook] Post-ingest processing failed for ${orderId}: ${e.message}`);
                }
              }

              await ensureEbayOrderQueuedForWmsSync(_wmsSyncService, result.id, orderId);
            }

            console.log(`[eBay Webhook] Processed order ${orderId}`);
          } catch (err: any) {
            console.error(`[eBay Webhook] Failed to process order ${orderId}: ${err.message}`);
            if (inbox) {
              await markWebhookFailed(db, inbox.id, err).catch((markErr: any) => {
                console.error(`[eBay Webhook] Failed to mark inbox ${inbox?.id} failed: ${markErr.message}`);
              });
            }
            // P0.6: a failed notification must not dead-end at the 200 ACK —
            // enqueue it for the retry worker (backoff + dead-letter at 5
            // attempts). ACKing after durable enqueue is correct (§6:
            // persist first, then 2xx); if the ENQUEUE fails too, 500 so
            // eBay redelivers.
            try {
              await db.execute(sql`
                INSERT INTO oms.webhook_retry_queue
                  (provider, topic, payload, source_inbox_id, attempts, last_error, next_retry_at, status, created_at, updated_at)
                VALUES
                  ('ebay', ${topic ?? "ORDER"}, ${JSON.stringify(payload)}::jsonb, ${inbox?.id ?? null},
                   0, ${String(err?.message ?? err).slice(0, 500)}, NOW(), 'pending', NOW(), NOW())
                ON CONFLICT DO NOTHING
              `);
            } catch (queueErr: any) {
              console.error(`[eBay Webhook] Retry enqueue failed for ${orderId}: ${queueErr.message}`);
              return res.status(500).json({ error: "retry enqueue failed" });
            }
            return res.status(200).json({ status: "ok", processing: "queued_for_retry" });
          }
        }
      }

      if (inbox) {
        await markWebhookSucceeded(db, inbox.id);
      }

      // Always acknowledge the webhook
      res.status(200).json({ status: "ok" });
    } catch (err: any) {
      console.error(`[eBay Webhook] Error: ${err.message}`);
      res.status(500).json({ error: "Internal error" });
    }
  };
}
