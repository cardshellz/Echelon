import { requireAuth, requirePermission } from "./middleware";
import type { Express, Request, Response } from "express";
import { ordersStorage } from "../modules/orders";
import { channelsStorage } from "../modules/channels";
import { catalogStorage } from "../modules/catalog";
import { inventoryStorage } from "../modules/inventory";
import { warehouseStorage } from "../modules/warehouse";
const storage = { ...ordersStorage, ...channelsStorage, ...catalogStorage, ...inventoryStorage, ...warehouseStorage };
import { fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, verifyWebhookWithSecret, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, type ShopifyOrder } from "../modules/integrations/shopify.api";
import { broadcastOrdersUpdated } from "../websocket";
import type { InsertOrderItem } from "@shared/schema";
import { registerShopifyOAuthRoutes } from "./shopify-oauth.routes";
import { parseCountryCode, resolveProviderCountryCode } from "@shared/country-code";
import { normalizeShopifyRepairOrderId, normalizeShopifyRepairShopDomain, type ShopifyCustomerRepairScope } from "../modules/orders/reconciliation-and-repair.api";
import { runReconciliationNow } from "../modules/orders/reconciliation-and-repair.api";
import { sql } from "drizzle-orm";
import {
  processShopifyFulfillmentIngress,
  buildShopifyFulfillmentRetryEnvelope,
  buildShopifyWebhookInboxInput,
  enqueueShopifyFulfillmentWebhookRetry,
  enqueueWebhookInboxRetry,
  markWebhookFailed,
  markWebhookProcessing,
  markWebhookSucceeded,
  receiptRecoveryOwnedStatus,
  recordWebhookReceived,
  sourceChannelIdFromRetryPayload,
  sourceEventIdFromRetryPayload,
  type ShopifyFulfillmentWebhookTopic,
  type WebhookInboxReceipt,
} from "../modules/oms/shopify-intake.api";
import { retireDeletedShopifyProduct } from "../modules/catalog/application/shopify-product-retirement.service";
import { sendShopifyProductSyncFailure } from "./shopify-product-sync.response";
import { logger } from "../platform/observability/logger";

// ---------------------------------------------------------------------------
// Shopify carrier-name → canonical carrier code mapping (§6 Commit 26).
// Shopify ships carrier strings like "USPS", "UPS", "DHL Express". Map them
// to the same canonical codes ShipStation uses (USPS / UPS / FedEx / DHL)
// so downstream OMS columns (`oms_orders.tracking_carrier`) stay consistent
// regardless of which side originated the fulfillment. Unknown carriers
// pass through verbatim (UPPER-cased) so we never silently drop carrier
// metadata; reconcile (Group F) flags any mismatch.
//
// Rule #11 (no magic): the map is the single source of truth for the
// Shopify→canonical translation, so reviewers don't have to chase string
// comparisons through call sites.
// ---------------------------------------------------------------------------
// Fulfillment webhooks below enter through the canonical exact-line ingress.
// Legacy SKU-based handlers were removed because they could manufacture
// shipment state and mark an entire order fulfilled from one package.
function isInternalRetryRequest(req: Request): boolean {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret) return false;
  const header = req.headers["x-internal-retry"];
  const supplied = Array.isArray(header) ? header[0] : header;
  return supplied === secret;
}

function webhookHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.trim() ? first.trim() : null;
}

async function resolveRouteWebhookDb(app: Express, req: Request): Promise<any> {
  return req.app?.locals?.db ?? app.locals?.db ?? (await import("../db")).db;
}

async function receiveShopifyRouteWebhook(
  db: any,
  req: Request,
  res: Response,
  topic: string,
  payload: unknown,
): Promise<{ receipt: WebhookInboxReceipt; shouldProcess: boolean } | null> {
  try {
    const receipt = await recordWebhookReceived(
      db,
      buildShopifyWebhookInboxInput(req, topic, payload),
    );
    const internalRetry = isInternalRetryRequest(req);
    if (!receipt.inserted && receipt.status === "succeeded" && !internalRetry) {
      if (!res.headersSent) {
        res.status(200).json({ received: true, duplicate: true, inboxId: receipt.id });
      }
      return { receipt, shouldProcess: false };
    }
    if (!receipt.inserted && receipt.status === "processing" && !internalRetry) {
      if (!res.headersSent) {
        res.status(200).json({ received: true, duplicate: true, inboxId: receipt.id });
      }
      return { receipt, shouldProcess: false };
    }
    await markWebhookProcessing(db, receipt.id);
    return { receipt, shouldProcess: true };
  } catch (err: any) {
    logger.error("routes.shopify_routes", { message: `[${topic}] webhook inbox write failed: ${err?.message ?? err}` });
    if (!res.headersSent) {
      res.status(500).json({ error: "Webhook inbox unavailable" });
    }
    return null;
  }
}

function acknowledgeShopifyRouteWebhookAccepted(
  req: Request,
  res: Response,
  inboxId: number,
): void {
  if (!isInternalRetryRequest(req) && !res.headersSent) {
    res.status(200).json({ received: true, accepted: true, inboxId });
  }
}

async function handleFulfillmentWebhookFailure(input: {
  app: Express;
  req: Request;
  res: Response;
  topic: ShopifyFulfillmentWebhookTopic;
  sourceChannelId: number | null;
  sourceEventId: string | null;
  sourceInboxId?: number | null;
  shopDomain: string | null;
  webhookVerified: boolean;
  error: unknown;
}): Promise<Response | void> {
  const errorMessage = input.error instanceof Error
    ? input.error.message
    : String(input.error);
  const retryDb = await resolveRouteWebhookDb(input.app, input.req);

  const recoveryOwnedStatus = receiptRecoveryOwnedStatus(input.error);
  if (recoveryOwnedStatus) {
    if (input.sourceInboxId) {
      await markWebhookSucceeded(retryDb, input.sourceInboxId).catch(() => undefined);
    }
    logger.info("shopify_fulfillment_ingress_recovery_owned", { event: "shopify_fulfillment_ingress_recovery_owned", topic: input.topic, sourceEventId: input.sourceEventId, shopDomain: input.shopDomain, processingStatus: recoveryOwnedStatus });
    if (!input.res.headersSent) {
      return input.res.status(200).json({
        received: true,
        processingStatus: recoveryOwnedStatus,
        replayed: true,
      });
    }
    return;
  }

  if (input.sourceInboxId) {
    await markWebhookFailed(retryDb, input.sourceInboxId, input.error).catch((markErr: any) => {
      logger.error("routes.shopify_routes", { message: `[${input.topic}] failed to mark inbox ${input.sourceInboxId} failed: ${markErr?.message ?? markErr}` });
    });
  }

  if (input.webhookVerified && !isInternalRetryRequest(input.req)) {
    try {
      const envelope = buildShopifyFulfillmentRetryEnvelope({
        topic: input.topic,
        payload: input.req.body as Record<string, unknown>,
        sourceEventId: input.sourceEventId,
        sourceChannelId: input.sourceChannelId,
        shopDomain: input.shopDomain,
      });
      await enqueueShopifyFulfillmentWebhookRetry(retryDb, {
        topic: input.topic,
        envelope,
        errorMessage,
        sourceInboxId: input.sourceInboxId ?? null,
      });
    } catch (enqueueError: any) {
      logger.error("routes.shopify_routes", { message: `[${input.topic}] failed to enqueue retry: ${enqueueError?.message ?? enqueueError}` });
    }
  }

  if (!input.res.headersSent) {
    return input.res.status(500).json({ error: "Webhook processing failed" });
  }
}

export function registerShopifyRoutes(app: Express) {

  registerShopifyOAuthRoutes(app);
  const {
    productImport,
  } = app.locals.services;

  app.post("/api/shopify/sync", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const result = await productImport.syncContentAndAssets();
      res.json(result);
    } catch (error: any) {
      logger.error("routes.shopify_routes", { message: "Shopify sync error:", error: error });
      res.status(500).json({
        error: "Failed to sync with Shopify",
        message: error.message
      });
    }
  });

  // Sync Shopify variants to products/product_variants tables
  // Parses SKU pattern: BASE-SKU-P50, BASE-SKU-C700 etc.
  app.post("/api/shopify/sync-products", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      res.json(await productImport.syncProductsAndContent());
    } catch (error: unknown) {
      sendShopifyProductSyncFailure(res, error);
    }
  });

  // Sync from oms_orders/oms_order_lines tables to operational orders/order_items
  // This reads from the unified OMS Hub and extracts the WMS operational subset
  app.post("/api/orders/sync-from-oms", requireAuth, async (req, res) => {
    try {
      logger.info("routes.shopify_routes", { message: "Starting sync from oms_orders to operational WMS orders..." });

      const allChannels = await storage.getAllChannels();
      const shopifyChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
      const defaultChannelId = shopifyChannel?.id || null;

      // Fetch unfulfilled orders from oms_orders table
      // Validate the source batch before the first WMS order is created.
      const rawOrderRows = (await storage.getUnfulfilledOmsOrders()).map(order => ({
        ...order, ship_to_country: parseCountryCode(order.ship_to_country),
      }));

      let created = 0;
      let skipped = 0;

      for (const rawOrder of rawOrderRows) {
        // Check if order already exists in operational table (using oms_orders.id as sourceTableId)
        const existingOrder = await storage.getOrderByExternalId(rawOrder.external_order_id || rawOrder.id);
        if (existingOrder) {
          skipped++;
          continue;
        }

        // Fetch ALL line items for this order from oms_order_lines (including requires_shipping flag)
        const rawItemRows = await storage.getOmsOrderItems(rawOrder.id);

        // Skip if no items at all
        if (rawItemRows.length === 0) {
          skipped++;
          continue;
        }

        // Filter to unfulfilled items only (for pick queue relevance)
        const unfulfilledItems = rawItemRows.filter(item =>
          !item.fulfillment_status || item.fulfillment_status !== 'fulfilled'
        );

        // Skip if all items are fulfilled
        if (unfulfilledItems.length === 0) {
          skipped++;
          continue;
        }

        // Calculate total units from ALL unfulfilled items
        const totalUnits = unfulfilledItems.reduce((sum, item) => sum + (item.fulfillable_quantity || item.quantity), 0);

        // Check if any item requires shipping
        const hasShippableItems = unfulfilledItems.some(item => item.requires_shipping === true);

        // Enrich ALL unfulfilled items with location data from inventory_levels (where stock actually is)
        const enrichedItems: InsertOrderItem[] = [];
        for (const item of unfulfilledItems) {
          const binLocation = await storage.getBinLocationFromInventoryBySku(item.sku || '');

          let itemImageUrl = binLocation?.imageUrl || null;
          if (!itemImageUrl && item.sku) {
            itemImageUrl = await storage.getItemImageUrlBySku(item.sku);
          }

          enrichedItems.push({
            orderId: 0,
            shopifyLineItemId: item.external_line_item_id, // Keep field name for legacy compatibility
            sourceItemId: item.id, // Links to oms_order_lines.id
            sku: item.sku || 'UNKNOWN',
            name: item.title || item.variant_title || 'Unknown Item',
            quantity: item.fulfillable_quantity || item.quantity,
            pickedQuantity: 0,
            fulfilledQuantity: 0,
            status: "pending",
            location: binLocation?.location || "UNASSIGNED",
            zone: binLocation?.zone || "U",
            imageUrl: itemImageUrl,
            barcode: binLocation?.barcode || null,
            requiresShipping: item.requires_shipping ? 1 : 0,
          });
        }

        // Create operational order using customer/shipping data from oms_orders
        await storage.createOrderWithItems({
          shopifyOrderId: rawOrder.external_order_id,
          externalOrderId: rawOrder.external_order_id || rawOrder.id,
          sourceTableId: rawOrder.id, // Links to oms_orders.id for JOINs
          omsFulfillmentOrderId: String(rawOrder.id), // §6 C9: required non-null linkage to OMS
          channelId: rawOrder.channel_id || defaultChannelId,
          source: "oms", // Updated to reflect it comes from the unified hub
          orderNumber: rawOrder.order_number,
          customerName: rawOrder.customer_name || rawOrder.ship_to_name || rawOrder.order_number,
          customerEmail: rawOrder.customer_email,
          shippingName: rawOrder.ship_to_name,
          shippingAddress: rawOrder.ship_to_address1,
          shippingCity: rawOrder.ship_to_city,
          shippingState: rawOrder.ship_to_state,
          shippingPostalCode: rawOrder.ship_to_zip,
          shippingCountry: rawOrder.ship_to_country,
          financialStatus: rawOrder.financial_status,
          shopifyFulfillmentStatus: rawOrder.fulfillment_status,
          priority: 100,
          warehouseStatus: hasShippableItems ? "ready" : "completed",
          itemCount: enrichedItems.length,
          unitCount: totalUnits,
          shopifyCreatedAt: rawOrder.order_date || rawOrder.created_at || undefined,
          orderPlacedAt: rawOrder.order_date || rawOrder.created_at || undefined,
        }, enrichedItems);

        created++;
      }

      logger.info("routes.shopify_routes", { message: `Sync complete: ${created} created, ${skipped} skipped` });
      res.json({ success: true, created, skipped });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Error syncing from raw tables:", error: error });
      res.status(500).json({ error: "Failed to sync from raw tables" });
    }
  });

  // Sync order statuses FROM Shopify fulfillment data
  // Updates orders and order_items based on shopify_orders.fulfillment_status
  app.post("/api/shopify/sync-statuses-from-shopify", requireAuth, async (req, res) => {
    try {
      logger.info("routes.shopify_routes", { message: "Syncing order statuses from Shopify fulfillment data..." });
      const startTime = Date.now();

      await storage.syncFulfilledStatusesFromShopify();

      const elapsed = Date.now() - startTime;
      logger.info("routes.shopify_routes", { message: `Status sync complete in ${elapsed}ms` });

      res.json({
        success: true,
        message: "Order statuses synced from Shopify fulfillment data",
        elapsed: `${elapsed}ms`
      });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Error syncing statuses from Shopify:", error: error });
      res.status(500).json({ error: "Failed to sync statuses from Shopify" });
    }
  });

  // Backfill operational orders table with customer data from oms_orders
  // Uses efficient UPDATE FROM JOIN to process thousands of orders at once
  app.post("/api/orders/backfill-orders-from-oms", requireAuth, async (req, res) => {
    try {
      logger.info("routes.shopify_routes", { message: "Starting backfill of operational orders from oms_orders..." });
      const startTime = Date.now();

      const result = await storage.backfillOrdersFromOms();

      const elapsed = Date.now() - startTime;
      logger.info("routes.shopify_routes", { message: `Backfill complete in ${elapsed}ms. Updated ${result.updated} orders.` });

      // Count remaining (orders that couldn't be matched)
      const remaining = await storage.countOrdersMissingShippingData();


      res.json({
        success: true,
        updated: result.updated,
        remaining,
        elapsed: `${elapsed}ms`,
        message: remaining > 0
          ? `Updated ${result.updated} orders. ${remaining} orders could not be matched to oms_orders.`
          : `All ${result.updated} orders backfilled!`
      });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Error backfilling orders:", error: error });
      res.status(500).json({ error: "Failed to backfill orders" });
    }
  });

  // Backfill canonical OMS customer addresses from the configured Shopify shop.
  // Processes ALL orders automatically by looping through all pages
  app.post("/api/shopify/backfill-customer-names", requireAuth, async (req, res) => {
    try {
      logger.info("routes.shopify_routes", { message: "Starting FULL customer name backfill from Shopify API..." });

      const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
      const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

      if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(400).json({ error: "Shopify credentials not configured" });
      }

      const shopDomain = normalizeShopifyRepairShopDomain(SHOPIFY_SHOP_DOMAIN);
      const startTime = Date.now();
      const MAX_TIME_MS = 25000; // Stay under Heroku's 30s timeout

      // Get starting page_info cursor from query params (for resuming)
      let pageInfo = req.query.page_info as string | undefined;

      let totalUpdated = 0;
      let totalSkipped = 0;
      let pagesProcessed = 0;

      // Loop through pages until timeout or done
      while (Date.now() - startTime < MAX_TIME_MS) {
        // Build URL for this page
        let url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=250&status=any`;
        if (pageInfo) {
          url = `https://${shopDomain}/admin/api/2024-01/orders.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`;
        }

        logger.info("routes.shopify_routes", { message: `Fetching page ${pagesProcessed + 1}...` });
        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          logger.error("routes.shopify_routes", { message: `Shopify API error: ${response.status}` });
          return res.status(500).json({ error: `Shopify API error: ${response.status}` });
        }

        const data = await response.json();
        const shopifyOrders = data.orders || [];

        if (shopifyOrders.length === 0) {
          logger.info("routes.shopify_routes", { message: "No more orders to process" });
          break;
        }

        logger.info("routes.shopify_routes", { message: `Processing ${shopifyOrders.length} orders...` });

        // Extract next page cursor from Link header
        const linkHeader = response.headers.get('Link');
        let nextPageInfo: string | null = null;
        if (linkHeader) {
          const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
          if (nextMatch) {
            nextPageInfo = new URL(nextMatch[1]).searchParams.get("page_info");
          }
        }

        // Normalize the complete page before starting any of its writes.
        const updates = shopifyOrders.map((shopifyOrder: any) => {
          const scope: ShopifyCustomerRepairScope = {
            shopDomain,
            externalOrderId: normalizeShopifyRepairOrderId(shopifyOrder.id),
          };
          const customerName = shopifyOrder.customer
            ? `${shopifyOrder.customer.first_name || ''} ${shopifyOrder.customer.last_name || ''}`.trim()
            : shopifyOrder.shipping_address?.name || null;
          const customerEmail = shopifyOrder.email || shopifyOrder.customer?.email || null;
          const shipping = shopifyOrder.shipping_address || {};

          return { scope, data: {
            customerName: customerName || 'Unknown',
            customerEmail,
            shippingName: shipping.name || null,
            shippingAddress1: shipping.address1 || null,
            shippingAddress2: shipping.address2 || null,
            shippingCity: shipping.city || null,
            shippingState: shipping.province || null,
            shippingPostalCode: shipping.zip || null,
            shippingCountry: resolveProviderCountryCode(shipping.country_code, shipping.country),
          } };
        });

        const results = await Promise.all(updates.map(({ scope, data }: { scope: ShopifyCustomerRepairScope; data: Parameters<typeof storage.updateOmsRawOrderCustomer>[1] }) =>
          storage.updateOmsRawOrderCustomer(scope, data)));
        const pageUpdated = results.reduce((sum, count) => sum + count, 0);
        totalUpdated += pageUpdated;
        totalSkipped += shopifyOrders.length - pageUpdated;

        pagesProcessed++;
        pageInfo = nextPageInfo || undefined;

        // No more pages
        if (!nextPageInfo) {
          logger.info("routes.shopify_routes", { message: "Reached end of Shopify orders" });
          break;
        }

        // Small delay for rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);

      // Count remaining orders
      const remaining = await storage.countOmsRawOrdersMissingCustomerName();

      const finished = !pageInfo;
      logger.info("routes.shopify_routes", { message: `Backfill: ${pagesProcessed} pages, ${totalUpdated} updated, ${totalSkipped} not in DB, ${remaining} remaining, ${elapsed}s` });

      // Auto-continue: trigger next batch in background before responding
      if (!finished && pageInfo) {
        const protocol = req.protocol;
        const host = req.get('host');
        const continueUrl = `${protocol}://${host}/api/shopify/backfill-customer-names?page_info=${pageInfo}`;

        // Fire and forget - don't await
        fetch(continueUrl, { method: 'POST' }).catch(err => {
          logger.error("routes.shopify_routes", { message: 'Auto-continue failed:', error: err });
        });

        logger.info("routes.shopify_routes", { message: `Auto-continuing to next batch...` });
      }

      res.json({
        success: true,
        pagesProcessed,
        ordersProcessed: totalUpdated + totalSkipped,
        updated: totalUpdated,
        skipped: totalSkipped,
        remaining,
        elapsed: `${elapsed}s`,
        finished,
        autoContinuing: !finished,
        message: finished ?
          (remaining > 0 ? `Done! ${remaining} orders not found in Shopify (may be deleted).` : 'All orders backfilled!') :
          `Processed ${pagesProcessed} pages. Auto-continuing in background...`
      });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Error backfilling customer names:", error: error });
      res.status(500).json({ error: "Failed to backfill customer names" });
    }
  });

  // Shopify Orders Sync - DEPRECATED: Use sync-from-raw-tables instead
  // Orders now flow through: shopify_orders table -> sync-from-raw-tables -> orders table
  app.post("/api/shopify/sync-orders", requireAuth, async (req, res) => {
    logger.info("routes.shopify_routes", { message: "[DEPRECATED] /api/shopify/sync-orders called - redirecting to sync-from-raw-tables" });
    res.status(410).json({
      error: "This endpoint is deprecated",
      message: "Orders are now synced from shopify_orders table. Use POST /api/shopify/sync-from-raw-tables instead.",
      redirect: "/api/shopify/sync-from-raw-tables"
    });
  });

  // Helper function to sync fulfillment status for all non-terminal orders
  async function syncFulfillmentStatus(): Promise<{ shipped: number; cancelled: number; checked: number }> {
    let shipped = 0;
    let cancelled = 0;
    let checked = 0;
    // Keyset batches preserve coverage as earlier orders leave the active set.
    for await (const activeOrders of storage.scanOrderBatches({
      excludedStatuses: ["shipped", "cancelled"], externalOrderOnly: true,
    })) {
      const shopifyOrderIds = activeOrders.map(order => order.externalOrderId!);
      const fulfillmentStatuses = await fetchOrdersFulfillmentStatus(shopifyOrderIds);
      checked += shopifyOrderIds.length;
      for (const status of fulfillmentStatuses) {
        const order = activeOrders.find(o => o.externalOrderId === status.shopifyOrderId);
        if (!order) {
          logger.info("routes.shopify_routes", { message: `Fulfillment sync: No local order found for Shopify ID ${status.shopifyOrderId}` });
          continue;
        }

        logger.info("routes.shopify_routes", { message: `Fulfillment sync: Order ${order.orderNumber} (${order.externalOrderId}) - Shopify fulfillment_status: "${status.fulfillmentStatus}", cancelled_at: ${status.cancelledAt}` });

        // If FULLY fulfilled in Shopify (all line items), mark as shipped
        // For partial fulfillments, we rely on webhooks to track individual line items
        if (status.fulfillmentStatus === "fulfilled") {
          await storage.updateOrderStatus(order.id, "shipped");
          shipped++;
          logger.info("routes.shopify_routes", { message: `Order ${order.orderNumber} marked as shipped (fully fulfilled in Shopify)` });
        }
        // If cancelled in Shopify, mark as cancelled and release bin reservations
        else if (status.cancelledAt) {
          await storage.updateOrderStatus(order.id, "cancelled");
          try {
            const { reservation } = app.locals.services;
            await reservation.releaseOrderReservation(
              order.id,
              "Order cancelled in Shopify",
              undefined,
              { disposition: "cancel" },
            );
          } catch (e) {
            logger.error("routes.shopify_routes", { message: `Failed to release reservations for cancelled order ${order.orderNumber}:`, error: e });
          }
          cancelled++;
          logger.info("routes.shopify_routes", { message: `Order ${order.orderNumber} marked as cancelled` });
        }
      }

    }
    if (shipped > 0 || cancelled > 0) {
      broadcastOrdersUpdated();
    }

    return { shipped, cancelled, checked };
  }

  // Reconcile order item locations with product_locations table
  // Updates pending/unassigned items if product_locations has been updated
  async function reconcileOrderItemLocations(): Promise<{ updated: number; checked: number }> {
    let updated = 0;
    let checked = 0;

    for await (const batch of storage.scanOrderBatches({ excludedStatuses: ["shipped", "cancelled"] })) {
      for (const order of batch) {
        for (const item of order.items) {
          checked++;

          // Only update items that haven't been picked yet
          if (item.status !== "pending") continue;

          // Look up current location from inventory_levels (where stock actually is)
          const binLocation = await storage.getBinLocationFromInventoryBySku(item.sku || '');

          if (!binLocation) continue;

          // Check if location/zone needs updating
          const needsUpdate =
            item.location !== binLocation.location ||
            item.zone !== binLocation.zone ||
            item.barcode !== binLocation.barcode ||
            item.imageUrl !== binLocation.imageUrl;

          if (needsUpdate) {
            await storage.updateOrderItemLocation(
              item.id,
              binLocation.location,
              binLocation.zone,
              binLocation.barcode || null,
              binLocation.imageUrl || null
            );
            updated++;
            logger.info("routes.shopify_routes", { message: `Reconcile: Updated item ${item.sku} in order ${order.orderNumber} to location ${binLocation.location}` });
          }
        }
      }

    }
    if (updated > 0) {
      broadcastOrdersUpdated();
      logger.info("routes.shopify_routes", { message: `Location reconcile: Updated ${updated} items out of ${checked} checked` });
    }

    return { updated, checked };
  }

  // Dedicated fulfillment sync endpoint
  app.post("/api/shopify/sync-fulfillments", requireAuth, async (req, res) => {
    try {
      logger.info("routes.shopify_routes", { message: "Starting fulfillment status sync..." });

      const result = await syncFulfillmentStatus();

      logger.info("routes.shopify_routes", { message: `Fulfillment sync complete: ${result.shipped} shipped, ${result.cancelled} cancelled out of ${result.checked} checked` });

      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      logger.error("routes.shopify_routes", { message: "Fulfillment sync error:", error: error });
      res.status(500).json({
        error: "Failed to sync fulfillment status",
        message: error.message
      });
    }
  });

  // ===== MULTI-CHANNEL WEBHOOK HELPERS =====

  /**
   * Verify a webhook from any connected Shopify store.
   * 1. Check X-Shopify-Shop-Domain header → look up channel by shop domain
   * 2. If channel has a webhookSecret, verify using that
   * 3. Fall back to default SHOPIFY_API_SECRET (primary store)
   * Returns { verified, channelId, shopDomain }
   */
  async function verifyChannelWebhook(req: Request): Promise<{
    verified: boolean;
    channelId: number | null;
    shopDomain: string | null;
  }> {
    // Allow internal worker bypass (mirrors oms-webhooks.ts verifyAndParse)
    if (isInternalRetryRequest(req)) {
      return {
        verified: true,
        channelId: sourceChannelIdFromRetryPayload(req.body),
        shopDomain: webhookHeader(req, "x-shopify-shop-domain"),
      };
    }

    const hmac = req.headers["x-shopify-hmac-sha256"] as string;
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const shopDomain = (req.headers["x-shopify-shop-domain"] as string) || null;

    if (!rawBody || !hmac) {
      return { verified: false, channelId: null, shopDomain };
    }

    // Try to find channel by shop domain
    if (shopDomain) {
      const conn = await storage.getChannelConnectionByShopDomain(shopDomain);

      if (conn) {
        // If the channel has its own webhook secret, use it
        if (conn.webhookSecret) {
          const verified = verifyWebhookWithSecret(rawBody, hmac, conn.webhookSecret);
          return { verified, channelId: conn.channelId, shopDomain };
        }
        // Channel exists but no webhook secret — fall through to default
        const verified = verifyShopifyWebhook(rawBody, hmac);
        return { verified, channelId: conn.channelId, shopDomain };
      }
    }

    // Fall back to default verification (primary store)
    const verified = verifyShopifyWebhook(rawBody, hmac);
    // Resolve default channel
    const allChannels = await storage.getAllChannels();
    const defaultChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
    return { verified, channelId: defaultChannel?.id || null, shopDomain };
  }

  async function processDurableShopifyProductWebhook(
    req: Request,
    res: Response,
    topic: "products/create" | "products/update" | "products/delete",
    runWork: (payload: any) => Promise<void>,
  ): Promise<void> {
    let inboxReceiptId: number | null = null;
    try {
      const { verified, shopDomain } = await verifyChannelWebhook(req);
      if (!verified) {
        logger.error("routes.shopify_routes", { message: `Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}` });
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      const payload = req.body;
      const inboxDb = await resolveRouteWebhookDb(app, req);
      const inbox = await receiveShopifyRouteWebhook(inboxDb, req, res, topic, payload);
      if (!inbox || !inbox.shouldProcess) return;
      inboxReceiptId = inbox.receipt.id;

      // P1.6: Persist to inbox → ACK → process from inbox (no unpersisted setImmediate)
      acknowledgeShopifyRouteWebhookAccepted(req, res, inboxReceiptId);

      await runWork(payload);
      await markWebhookSucceeded(inboxDb, inboxReceiptId);
      if (!res.headersSent) {
        res.status(200).json({ received: true, inboxId: inboxReceiptId });
      }
    } catch (error: any) {
      logger.error("routes.shopify_routes", { message: `[${topic}] webhook error:`, error: error });
      if (inboxReceiptId !== null) {
        const inboxDb = await resolveRouteWebhookDb(app, req);
        await markWebhookFailed(inboxDb, inboxReceiptId, error).catch(() => undefined);
        if (!isInternalRetryRequest(req)) {
          await enqueueWebhookInboxRetry(inboxDb, {
            provider: "shopify",
            topic,
            payload: req.body,
            sourceInboxId: inboxReceiptId,
            lastError: error?.message ?? String(error),
          }).catch((enqueueErr: any) => {
            logger.error("routes.shopify_routes", { message: `[${topic}] failed to enqueue inbox retry: ${enqueueErr?.message ?? enqueueErr}` });
          });
        }
      }
      if (!res.headersSent) {
        res.status(500).json({ error: "Webhook processing failed" });
      }
    }
  }

  // Shopify Webhooks - raw body captured by express.json verify callback (P1.6: persist to inbox → ACK → process)
  app.post("/api/shopify/webhooks/products/create", async (req: Request, res: Response) => {
    await processDurableShopifyProductWebhook(req, res, "products/create", async (payload) => {
      const skus = extractSkusFromWebhookPayload(payload);
      for (const { sku, name, status } of skus) {
        await storage.upsertProductLocationBySku(sku, name, status);
      }
      logger.info("routes.shopify_routes", { message: `Webhook: Created/updated ${skus.length} SKUs from product create` });
    });
  });

  app.post("/api/shopify/webhooks/products/update", async (req: Request, res: Response) => {
    await processDurableShopifyProductWebhook(req, res, "products/update", async (payload) => {
      const skus = extractSkusFromWebhookPayload(payload);
      for (const { sku, name, status } of skus) {
        await storage.upsertProductLocationBySku(sku, name, status);
      }
      logger.info("routes.shopify_routes", { message: `Webhook: Updated ${skus.length} SKUs from product update` });
    });
  });

  app.post("/api/shopify/webhooks/products/delete", async (req: Request, res: Response) => {
    await processDurableShopifyProductWebhook(req, res, "products/delete", async (payload) => {
      // Shopify's delete payload carries only the product id — no variants —
      // so the SKU-based path this used to take could never match anything.
      // Retire the mapping instead, and resolve SKUs from our own catalog.
      const deletedShopifyProductId = payload?.id;
      const result = await retireDeletedShopifyProduct(deletedShopifyProductId);
      logger.info("shopify_product_deleted", { event: "shopify_product_deleted", shopifyProductId: result.shopifyProductId, mappingsRetired: result.mappingsRetired, pickLocationsRemoved: result.pickLocationsRemoved, retiredProductIds: result.retiredProductIds });
    });
  });

  // ===== FULFILLMENT WEBHOOKS =====

  // Process fulfillment line items and update fulfilled quantities
  // Returns true if all items in the order are now fully fulfilled
  async function processFulfillmentLineItems(
    shopifyOrderId: string,
    lineItems: Array<{ id: number; quantity: number }>,
    source: string
  ): Promise<boolean> {
    const order = await storage.getOrderByExternalId(shopifyOrderId);
    if (!order) {
      logger.info("routes.shopify_routes", { message: `Fulfillment ${source}: No order found for Shopify ID ${shopifyOrderId}` });
      return false;
    }

    if (order.warehouseStatus === "shipped" || order.warehouseStatus === "cancelled") {
      logger.info("routes.shopify_routes", { message: `Fulfillment ${source}: Order ${order.orderNumber} already ${order.warehouseStatus}, skipping` });
      return false;
    }

    // Update fulfilled quantity for each line item in this fulfillment
    let itemsUpdated = 0;
    for (const lineItem of lineItems) {
      const shopifyLineItemId = String(lineItem.id);
      const fulfilledQty = lineItem.quantity;

      const updated = await storage.updateItemFulfilledQuantity(Number(shopifyLineItemId), fulfilledQty);
      if (updated) {
        itemsUpdated++;
        logger.info("routes.shopify_routes", { message: `Fulfillment ${source}: Updated line item ${shopifyLineItemId} +${fulfilledQty} fulfilled (now ${updated.fulfilledQuantity}/${updated.quantity})` });
      }
    }

    logger.info("routes.shopify_routes", { message: `Fulfillment ${source}: Updated ${itemsUpdated} line items for order ${order.orderNumber}` });

    // Check if ALL items we track are now fully fulfilled
    const allFulfilled = await storage.areAllItemsFulfilled(order.id);

    if (allFulfilled) {
      await storage.updateOrderStatus(order.id, "shipped");
      logger.info("routes.shopify_routes", { message: `Fulfillment ${source}: Order ${order.orderNumber} marked as SHIPPED (all physical items fulfilled)` });
      broadcastOrdersUpdated();
      return true;
    } else {
      logger.info("routes.shopify_routes", { message: `Fulfillment ${source}: Order ${order.orderNumber} not yet fully fulfilled, waiting for more shipments` });
      return false;
    }
  }

  async function checkOrderFulfillmentFromShopify(shopifyOrderId: string, source: string): Promise<void> {
    const order = await storage.getOrderByExternalId(shopifyOrderId);
    if (!order || order.warehouseStatus === "shipped" || order.warehouseStatus === "cancelled") {
      return;
    }

    // Fetch the order's overall fulfillment status from Shopify
    const fulfillmentStatuses = await fetchOrdersFulfillmentStatus([shopifyOrderId]);
    const orderStatus = fulfillmentStatuses.find(s => s.shopifyOrderId === shopifyOrderId);

    if (orderStatus?.cancelledAt) {
      await storage.updateOrderStatus(order.id, "cancelled");
      logger.info("routes.shopify_routes", { message: `Order ${order.orderNumber} marked as cancelled via ${source}` });
      broadcastOrdersUpdated();
    }
    // Note: We no longer auto-ship based on Shopify's overall status
    // Instead, we track individual line item fulfillments
  }

  // ---------------------------------------------------------------------
  // Fulfillment created — cascade through WMS shipment + order rollup.
  // Plan ref: shipstation-flow-refactor-plan.md §6 Commit 26.
  //
  // Two paths handled by `handleShopifyFulfillmentCreate`:
  //   A. Shipment exists with `shopify_fulfillment_id` matching the
  //      payload — we pushed it (C22d), Shopify confirmed, mark shipped
  //      via `markShipmentShipped` (idempotent).
  //   B. No shipment exists — external fulfillment (3PL like ShipMonk
  //      or manual Shopify admin). Insert a new shipment row directly
  //      in `shipped` state with `source='shopify_external_fulfillment'`
  //      so the order can roll up to shipped.
  //
  // Failures use a stable provider-event retry key. Once a canonical receipt
  // exists, its leased recovery state owns retries and duplicate deliveries
  // are acknowledged without creating child retry rows.
  // ---------------------------------------------------------------------
  app.post("/api/shopify/webhooks/fulfillments/create", async (req: Request, res: Response) => {
    let sourceChannelId: number | null = null;
    let shopDomain: string | null = null;
    let webhookVerified = false;
    let sourceInboxId: number | null = null;
    const sourceEventId = sourceEventIdFromRetryPayload(req.body)
      ?? webhookHeader(req, "x-shopify-webhook-id");
    try {
      const verification = await verifyChannelWebhook(req);
      sourceChannelId = verification.channelId;
      shopDomain = verification.shopDomain;

      if (!verification.verified) {
        logger.error("routes.shopify_routes", { message: `Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}` });
        return res.status(401).json({ error: "Invalid signature" });
      }
      webhookVerified = true;

      const payload = req.body as Record<string, unknown>;
      const inboxDb = await resolveRouteWebhookDb(app, req);
      const inbox = await receiveShopifyRouteWebhook(inboxDb, req, res, "fulfillments/create", payload);
      if (!inbox || !inbox.shouldProcess) return;
      sourceInboxId = inbox.receipt.id;
      acknowledgeShopifyRouteWebhookAccepted(req, res, sourceInboxId);

      const fulfillmentId = payload?.id ?? "<missing>";
      const shopifyOrderId = payload?.order_id ?? "<missing>";
      const status = payload?.status ?? "<missing>";
      const lineItemCount = Array.isArray(payload?.line_items)
        ? payload.line_items.length
        : 0;
      logger.info("routes.shopify_routes", { message: `[fulfillments/create] received: fulfillment=${fulfillmentId} order=${shopifyOrderId} status=${status} line_items=${lineItemCount}` });

      const service = app.locals.services?.channelFulfillmentIngress;
      if (!service) {
        throw Object.assign(new Error("Channel fulfillment ingress service is unavailable"), {
          code: "CHANNEL_FULFILLMENT_INGRESS_UNAVAILABLE",
        });
      }
      const effectiveSourceEventId = sourceEventId ?? `webhook_inbox:${sourceInboxId}`;
      const outcome = await processShopifyFulfillmentIngress(
        service,
        payload,
        {
          sourceChannelId,
          sourceEventId: effectiveSourceEventId,
          sourceInboxId,
          eventKind: "created",
          source: "shopify_fulfillments_create",
          correlationId: effectiveSourceEventId,
          causationId: effectiveSourceEventId,
        },
      );
      await markWebhookSucceeded(inboxDb, sourceInboxId);
      logger.info("shopify_fulfillment_ingress_accepted", { event: "shopify_fulfillment_ingress_accepted", topic: "fulfillments/create", fulfillmentId: String(fulfillmentId), actionable: outcome.actionable, processingStatus: outcome.result?.processingStatus ?? "ignored", receiptId: outcome.result?.receiptId ?? null, physicalShipmentId: outcome.result?.physicalShipmentId ?? null, replayed: outcome.result?.replayed ?? false });
      if (!res.headersSent) {
        return res.status(200).json({
          received: true,
          actionable: outcome.actionable,
          processingStatus: outcome.result?.processingStatus ?? "ignored",
          receiptId: outcome.result?.receiptId ?? null,
          physicalShipmentId: outcome.result?.physicalShipmentId ?? null,
          replayed: outcome.result?.replayed ?? false,
        });
      }
    } catch (error: any) {
      logger.error("routes.shopify_routes", { message: `[fulfillments/create] unhandled error: ${error?.message ?? error}` });
      return handleFulfillmentWebhookFailure({
        app,
        req,
        res,
        topic: "fulfillments/create",
        sourceChannelId,
        sourceEventId,
        sourceInboxId,
        shopDomain,
        webhookVerified,
        error,
      });
    }
  });

  // ---------------------------------------------------------------------
  // Fulfillment updated — cascade through WMS shipment re-tracking.
  // Plan ref: shipstation-flow-refactor-plan.md §6 Commit 27.
  //
  // When an existing fulfillment's tracking changes (ShipMonk relabels,
  // operator updates Shopify admin), Shopify fires fulfillments/update.
  // We cascade through `markShipmentShipped` whose re-tracking branch
  // (C18) writes a `shipment_tracking_history` row + UPDATEs the WMS
  // shipment. Closes the inbound side of the relabel loop (C24 was
  // outbound).
  //
  // Idempotent on replay: same tracking arrives twice → markShipmentShipped
  // returns changed=false, no DB writes beyond the lookups.
  //
  // Retry behavior is shared with fulfillments/create: authenticated external
  // failures get one idempotent transport retry, while the canonical receipt
  // owns processing retries after it has been staged.
  // ---------------------------------------------------------------------
  app.post("/api/shopify/webhooks/fulfillments/update", async (req: Request, res: Response) => {
    let sourceChannelId: number | null = null;
    let shopDomain: string | null = null;
    let webhookVerified = false;
    let sourceInboxId: number | null = null;
    const sourceEventId = sourceEventIdFromRetryPayload(req.body)
      ?? webhookHeader(req, "x-shopify-webhook-id");
    try {
      const verification = await verifyChannelWebhook(req);
      sourceChannelId = verification.channelId;
      shopDomain = verification.shopDomain;

      if (!verification.verified) {
        logger.error("routes.shopify_routes", { message: `Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}` });
        return res.status(401).json({ error: "Invalid signature" });
      }
      webhookVerified = true;

      const payload = req.body as Record<string, unknown>;
      const inboxDb = await resolveRouteWebhookDb(app, req);
      const inbox = await receiveShopifyRouteWebhook(inboxDb, req, res, "fulfillments/update", payload);
      if (!inbox || !inbox.shouldProcess) return;
      sourceInboxId = inbox.receipt.id;
      acknowledgeShopifyRouteWebhookAccepted(req, res, sourceInboxId);

      const fulfillmentId = payload?.id ?? "<missing>";
      const shopifyOrderId = payload?.order_id ?? "<missing>";
      const status = payload?.status ?? "<missing>";
      logger.info("routes.shopify_routes", { message: `[fulfillments/update] received: fulfillment=${fulfillmentId} order=${shopifyOrderId} status=${status}` });

      const service = req.app.locals.services?.channelFulfillmentIngress;
      if (!service) {
        throw Object.assign(new Error("Channel fulfillment ingress service is unavailable"), {
          code: "CHANNEL_FULFILLMENT_INGRESS_UNAVAILABLE",
        });
      }
      const effectiveSourceEventId = sourceEventId ?? `webhook_inbox:${sourceInboxId}`;
      const outcome = await processShopifyFulfillmentIngress(
        service,
        payload,
        {
          sourceChannelId,
          sourceEventId: effectiveSourceEventId,
          sourceInboxId,
          eventKind: "updated",
          source: "shopify_fulfillments_update",
          correlationId: effectiveSourceEventId,
          causationId: effectiveSourceEventId,
        },
      );
      await markWebhookSucceeded(inboxDb, sourceInboxId);
      logger.info("shopify_fulfillment_ingress_accepted", { event: "shopify_fulfillment_ingress_accepted", topic: "fulfillments/update", fulfillmentId: String(fulfillmentId), actionable: outcome.actionable, processingStatus: outcome.result?.processingStatus ?? "ignored", receiptId: outcome.result?.receiptId ?? null, physicalShipmentId: outcome.result?.physicalShipmentId ?? null, replayed: outcome.result?.replayed ?? false });
      if (!res.headersSent) {
        return res.status(200).json({
          received: true,
          actionable: outcome.actionable,
          processingStatus: outcome.result?.processingStatus ?? "ignored",
          receiptId: outcome.result?.receiptId ?? null,
          physicalShipmentId: outcome.result?.physicalShipmentId ?? null,
          replayed: outcome.result?.replayed ?? false,
        });
      }
    } catch (error: any) {
      logger.error("routes.shopify_routes", { message: `[fulfillments/update] unhandled error: ${error?.message ?? error}` });
      return handleFulfillmentWebhookFailure({
        app,
        req,
        res,
        topic: "fulfillments/update",
        sourceChannelId,
        sourceEventId,
        sourceInboxId,
        shopDomain,
        webhookVerified,
        error,
      });
    }
  });

  // ===== ORDER WEBHOOKS =====

  // Order created - add to picking queue
  // Order create webhook - DISABLED: Orders sync from shopify_orders/shopify_order_items tables instead
  // Keeping endpoint in place for future use if needed
  app.post("/api/shopify/webhooks/orders/create", async (req: Request, res: Response) => {
    logger.info("routes.shopify_routes", { message: "[ORDER WEBHOOK] Received orders/create webhook - DISABLED, use sync-from-raw-tables instead" });
    try {
      const { verified } = await verifyChannelWebhook(req);
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      // Webhook disabled - orders come from shopify_orders table via sync-from-raw-tables
      res.status(200).json({ received: true, note: "Webhook disabled, use sync-from-raw-tables" });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Order create webhook error:", error: error });
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Order fulfilled webhook - DISABLED: Status updates sync from shopify_orders table instead
  app.post("/api/shopify/webhooks/orders/fulfilled", async (req: Request, res: Response) => {
    logger.info("routes.shopify_routes", { message: "[ORDER WEBHOOK] Received orders/fulfilled webhook - DISABLED" });
    try {
      const { verified } = await verifyChannelWebhook(req);
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      res.status(200).json({ received: true, note: "Webhook disabled" });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Order fulfilled webhook error:", error: error });
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Manual trigger for Shopify order reconciliation
  app.post("/api/shopify/reconcile-orders", requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await runReconciliationNow();
      res.json(result);
    } catch (error: any) {
      logger.error("routes.shopify_routes", { message: "[RECONCILE] Manual trigger failed:", error: error });
      res.status(500).json({ error: error.message });
    }
  });

  // Order cancelled webhook - DISABLED: Status updates sync from shopify_orders table instead
  app.post("/api/shopify/webhooks/orders/cancelled", async (req: Request, res: Response) => {
    logger.info("routes.shopify_routes", { message: "[ORDER WEBHOOK] Received orders/cancelled webhook - DISABLED" });
    try {
      const { verified } = await verifyChannelWebhook(req);
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      res.status(200).json({ received: true, note: "Webhook disabled" });
    } catch (error) {
      logger.error("routes.shopify_routes", { message: "Order cancelled webhook error:", error: error });
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });
}
