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
import type { InsertOrderItem } from "@shared/schema";
import type { ReservationResult } from "../../services";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { ordersStorage } from "../orders";
import { warehouseStorage } from "../warehouse";

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

// ---------------------------------------------------------------------------
// Create WMS order from eBay OMS order data
// ---------------------------------------------------------------------------

/**
 * Creates a WMS `orders` row + `order_items` rows from eBay order data,
 * following the same pattern as order-sync-listener.ts does for Shopify.
 * Idempotent — deduplicates by source='ebay' + sourceTableId=omsOrderId.
 */
async function createWmsOrderFromEbay(
  omsOrderId: number,
  orderData: OrderData,
  externalOrderId: string,
): Promise<number | null> {
  const omsIdStr = String(omsOrderId);

  // Dedup: check if WMS order already exists for this OMS order
  const existing = await db.execute<{ id: number }>(sql`
    SELECT id FROM wms.orders
    WHERE source = 'ebay' AND source_table_id = ${omsIdStr}
    LIMIT 1
  `);
  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // Skip non-paid / cancelled orders
  if (orderData.status === "cancelled" || orderData.financialStatus === "failed") {
    console.log(`[eBay→WMS] Skipping WMS order for ${externalOrderId} (status: ${orderData.status}, financial: ${orderData.financialStatus})`);
    return null;
  }

  // Build order items with bin locations
  const enrichedItems: InsertOrderItem[] = [];
  for (const line of orderData.lineItems) {
    const binLocation = await warehouseStorage.getBinLocationFromInventoryBySku(line.sku || "");

    // Look up image
    let imageUrl = binLocation?.imageUrl || null;
    if (!imageUrl && line.sku) {
      const imageResult = await db.execute<{ image_url: string | null }>(sql`
        SELECT image_url FROM (
          SELECT pl.image_url FROM warehouse.product_locations pl
          WHERE UPPER(pl.sku) = ${line.sku.toUpperCase()} AND pl.image_url IS NOT NULL
          UNION ALL
          SELECT pa.url as image_url
          FROM catalog.product_variants pv
          LEFT JOIN catalog.products p ON pv.product_id = p.id
          LEFT JOIN catalog.product_assets pa ON pa.product_id = p.id AND pa.is_primary = 1
          WHERE UPPER(pv.sku) = ${line.sku.toUpperCase()}
            AND pa.url IS NOT NULL
        ) sub
        LIMIT 1
      `);
      if (imageResult.rows.length > 0 && imageResult.rows[0].image_url) {
        imageUrl = imageResult.rows[0].image_url;
      }
    }

    enrichedItems.push({
      orderId: 0, // Will be set by createOrderWithItems
      sourceItemId: line.externalLineItemId || null,
      sku: line.sku || "UNKNOWN",
      name: line.title || "Unknown Item",
      quantity: line.quantity,
      pickedQuantity: 0,
      fulfilledQuantity: 0,
      status: "pending",
      location: binLocation?.location || "UNASSIGNED",
      zone: binLocation?.zone || "U",
      imageUrl,
      barcode: binLocation?.barcode || null,
      requiresShipping: 1,
    });
  }

  const totalUnits = enrichedItems.reduce((sum, item) => sum + item.quantity, 0);
  const warehouseStatus = orderData.financialStatus === "paid" ? "ready" : "ready";

  const orderNumber = externalOrderId;

  const newOrder = await ordersStorage.createOrderWithItems({
    channelId: EBAY_CHANNEL_ID,
    source: "ebay",
    externalOrderId: externalOrderId,
    sourceTableId: omsIdStr, // Link to OMS order for dedup + ship confirm
    orderNumber,
    customerName: orderData.customerName || orderData.shipToName || orderNumber,
    customerEmail: orderData.customerEmail || null,
    shippingName: orderData.shipToName || orderData.customerName || null,
    shippingAddress: orderData.shipToAddress1 || null,
    shippingCity: orderData.shipToCity || null,
    shippingState: orderData.shipToState || null,
    shippingPostalCode: orderData.shipToZip || null,
    shippingCountry: orderData.shipToCountry || null,
    financialStatus: orderData.financialStatus || "paid",
    priority: 50,
    warehouseStatus,
    itemCount: enrichedItems.length,
    unitCount: totalUnits,
    orderPlacedAt: orderData.orderedAt || new Date(),
  }, enrichedItems);

  console.log(`[eBay→WMS] Created WMS order ${newOrder.id} (${orderNumber}) with ${enrichedItems.length} items`);

  // Route to warehouse + reserve via WMS reservation
  if (_wmsServices) {
    try {
      const routingCtx = {
        channelId: EBAY_CHANNEL_ID,
        skus: enrichedItems.map(i => i.sku).filter(s => s !== "UNKNOWN"),
        country: orderData.shipToCountry,
      };
      const routing = await _wmsServices.fulfillmentRouter.routeOrder(routingCtx);
      if (routing) {
        await _wmsServices.fulfillmentRouter.assignWarehouseToOrder(newOrder.id, routing);
        console.log(`[eBay→WMS] Routed ${orderNumber} → warehouse ${routing.warehouseCode}`);

        try {
          await _wmsServices.slaMonitor.setSLAForOrder(newOrder.id);
        } catch (slaErr: any) {
          console.error(`[eBay→WMS] SLA setup failed for ${orderNumber}: ${slaErr.message}`);
        }
      }
    } catch (routingErr: any) {
      console.error(`[eBay→WMS] Routing failed for ${orderNumber}: ${routingErr.message}`);
    }

    // Reserve inventory through WMS reservation service (ATP-gated)
    if (warehouseStatus === "ready") {
      try {
        const reserveResult = await _wmsServices.reservation.reserveOrder(newOrder.id);
        if (reserveResult.failed.length > 0) {
          console.log(`[eBay→WMS] Reservation partial for ${orderNumber}: ${reserveResult.failed.length} items could not be reserved`);
        }
      } catch (resErr: any) {
        console.error(`[eBay→WMS] Reservation failed for ${orderNumber}: ${resErr.message}`);
      }
    }
  }

  return newOrder.id;
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
                const wmsOrder = await db.execute(sql`SELECT id FROM wms.orders WHERE source_table_id = ${String(result.id)} LIMIT 1`);
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
          // Sync OMS → WMS (replaces old createWmsOrderFromEbay dual-write)
          if (_wmsSyncService) {
            try {
              await _wmsSyncService.syncOmsOrderToWms(result.id);
            } catch (e: any) {
              console.error(`[eBay Orders] WMS sync failed for ${ebayOrder.orderId}: ${e.message}`);
            }
          } else {
            console.warn(`[eBay Orders] WMS sync service not initialized — falling back to old dual-write`);
            try {
              await createWmsOrderFromEbay(result.id, orderData, ebayOrder.orderId);
            } catch (e: any) {
              console.error(`[eBay Orders] WMS order creation failed for ${ebayOrder.orderId}: ${e.message}`);
            }
          }

          // OMS-level reservation (delegates to WMS reservation service)
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
    try {
      if (_wmsSyncService) {
        await _wmsSyncService.syncOmsOrderToWms(result.id);
      } else {
        await createWmsOrderFromEbay(result.id, orderData, orderId);
      }
    } catch (err: any) {
      console.error(`[eBay Reingest] WMS sync failed for ${orderId}: ${err.message}`);
    }

    try {
      await omsService.reserveInventory(result.id);
      await omsService.assignWarehouse(result.id);
    } catch (err: any) {
      console.error(`[eBay Reingest] Post-ingest (reserve/assign) failed for ${orderId}: ${err.message}`);
    }

    if (_shipStationService?.isConfigured()) {
      try {
        const fullOrder = await omsService.getOrderById(result.id);
        if (fullOrder) await _shipStationService.pushOrder(fullOrder);
      } catch (err: any) {
        console.error(`[eBay Reingest] ShipStation push failed for ${orderId}: ${err.message}`);
      }
    }
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

            // Post-ingest if newly created
            if (result.createdAt && (Date.now() - new Date(result.createdAt).getTime()) < 5000) {
              // Create WMS order for pick queue
              try {
                await createWmsOrderFromEbay(result.id, orderData, orderId);
              } catch (e: any) {
                console.error(`[eBay Webhook] WMS order creation failed for ${orderId}: ${e.message}`);
              }

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
