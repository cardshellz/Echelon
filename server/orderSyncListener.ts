import { Pool, Client } from "pg";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import type { InsertOrderItem } from "@shared/schema";
import { createInventoryCoreService } from "./services/inventory-core";
import { createInventoryAtpService } from "./services/inventory-atp";
import { createChannelSyncService } from "./services/channel-sync";
import { createReservationService } from "./services/reservation";
import { createFulfillmentRouterService } from "./services/fulfillment-router";
import { createSLAMonitorService } from "./services/sla-monitor";

// Services for order processing
const inventoryCore = createInventoryCoreService(db);
const atp = createInventoryAtpService(db);
const channelSync = createChannelSyncService(db, atp);
const reservation = createReservationService(db, inventoryCore, channelSync);
const fulfillmentRouter = createFulfillmentRouterService(db);
const slaMonitor = createSLAMonitorService(db);

/**
 * Resolve the channel ID for an order based on shop_domain.
 * 1. If shop_domain is set, match against channel_connections.shopDomain
 * 2. Fall back to the default Shopify channel
 * 3. Returns null if no channel found
 */
async function resolveChannelId(shopDomain: string | null): Promise<number | null> {
  if (shopDomain) {
    // Try to match shop_domain → channel_connections → channel
    const result = await db.execute<{ channel_id: number }>(sql`
      SELECT cc.channel_id FROM channel_connections cc
      INNER JOIN channels c ON cc.channel_id = c.id
      WHERE LOWER(cc.shop_domain) = LOWER(${shopDomain})
      LIMIT 1
    `);
    if (result.rows.length > 0) {
      return result.rows[0].channel_id;
    }
  }

  // Fall back to default Shopify channel
  const allChannels = await storage.getAllChannels();
  const defaultChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
  return defaultChannel?.id || null;
}

// Sync health tracking
let lastSuccessfulSync: Date | null = null;
let lastSyncAttempt: Date | null = null;
let lastSyncError: string | null = null;
let consecutiveErrors = 0;

export function getSyncHealth() {
  const now = new Date();
  const minutesSinceLastSync = lastSuccessfulSync
    ? Math.floor((now.getTime() - lastSuccessfulSync.getTime()) / 60000)
    : null;

  // Consider sync stale if no successful sync in last 30 minutes and we have shopify orders
  const isStale = minutesSinceLastSync !== null && minutesSinceLastSync > 30;
  const hasError = consecutiveErrors > 0;

  return {
    lastSuccessfulSync: lastSuccessfulSync?.toISOString() || null,
    lastSyncAttempt: lastSyncAttempt?.toISOString() || null,
    lastSyncError,
    consecutiveErrors,
    minutesSinceLastSync,
    status: hasError ? "error" : isStale ? "stale" : "healthy",
  };
}

const dbConnectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
const useSSL = process.env.EXTERNAL_DATABASE_URL || process.env.NODE_ENV === "production";

let listenerClient: Client | null = null;
let isBatchProcessing = false;

// Queue of specific order IDs that need to be synced (from NOTIFY)
const pendingSyncQueue = new Set<string>();
let queueProcessorRunning = false;

/**
 * Sync a single specific order by shopify_orders.id.
 * Retries item fetch up to 3 times with delays for timing races.
 * Returns true if order was created, false if skipped/already exists.
 */
async function syncSingleOrder(shopifyOrderId: string): Promise<boolean> {
  // Check if already synced
  const alreadySynced = await db.execute<{ id: number }>(sql`
    SELECT id FROM orders WHERE source_table_id = ${shopifyOrderId} LIMIT 1
  `);
  if (alreadySynced.rows.length > 0) {
    return false; // Already exists
  }

  const rawOrderResult = await db.execute<{
    id: string;
    order_number: string;
    customer_name: string | null;
    customer_email: string | null;
    shipping_name: string | null;
    shipping_address1: string | null;
    shipping_city: string | null;
    shipping_state: string | null;
    shipping_postal_code: string | null;
    shipping_country: string | null;
    total_price_cents: number | null;
    currency: string | null;
    order_date: Date | null;
    created_at: Date | null;
    financial_status: string | null;
    fulfillment_status: string | null;
    cancelled_at: Date | null;
    shop_domain: string | null;
  }>(sql`
    SELECT * FROM shopify_orders WHERE id = ${shopifyOrderId}
  `);

  if (rawOrderResult.rows.length === 0) {
    console.log(`[ORDER SYNC] Shopify order ${shopifyOrderId} not found in shopify_orders table`);
    return false;
  }

  const rawOrder = rawOrderResult.rows[0];

  // Resolve channel from shop_domain → channel_connections → channel
  // Falls back to default Shopify channel if shop_domain is not set (legacy orders)
  const channelId = await resolveChannelId(rawOrder.shop_domain);

  // Retry item fetch up to 3 times (items may be inserted slightly after the order)
  let rawItems: { rows: any[] } = { rows: [] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    rawItems = await db.execute<{
      id: string;
      shopify_line_item_id: string;
      sku: string | null;
      name: string | null;
      title: string | null;
      quantity: number;
      fulfillable_quantity: number | null;
      fulfillment_status: string | null;
      requires_shipping: boolean | null;
    }>(sql`
      SELECT * FROM shopify_order_items WHERE order_id = ${shopifyOrderId}
    `);

    if (rawItems.rows.length > 0) break;

    if (attempt < 3) {
      console.log(`[ORDER SYNC] Order ${rawOrder.order_number}: no items yet (attempt ${attempt}/3), retrying in ${attempt * 2}s...`);
      await new Promise(resolve => setTimeout(resolve, attempt * 2000));
    }
  }

  if (rawItems.rows.length === 0) {
    console.warn(`[ORDER SYNC] Order ${rawOrder.order_number} (shopify ID ${shopifyOrderId}): STILL no items after 3 attempts — will retry on next poll`);
    return false;
  }

  const allItems = rawItems.rows;
  const allFullyFulfilled = allItems.every(item => item.fulfillment_status === 'fulfilled');
  const totalUnits = allItems.reduce((sum: number, item: any) => sum + (item.fulfillable_quantity || item.quantity), 0);
  const hasShippableItems = allItems.some(item => item.requires_shipping !== false);

  const enrichedItems: InsertOrderItem[] = [];
  for (const item of allItems) {
    const isFulfilled = item.fulfillment_status === 'fulfilled';

    // Look up bin location from inventory_levels (where stock actually is)
    const binLocation = await storage.getBinLocationFromInventoryBySku(item.sku || '');

    // If no image from inventory, try product_locations first, then product_variants/products
    let imageUrl = binLocation?.imageUrl || null;
    if (!imageUrl && item.sku) {
      const imageResult = await db.execute<{ image_url: string | null }>(sql`
        SELECT image_url FROM (
          SELECT pl.image_url FROM product_locations pl
          WHERE UPPER(pl.sku) = ${item.sku.toUpperCase()} AND pl.image_url IS NOT NULL
          UNION ALL
          SELECT COALESCE(pv.image_url, p.image_url) as image_url
          FROM product_variants pv
          LEFT JOIN products p ON pv.product_id = p.id
          WHERE UPPER(pv.sku) = ${item.sku.toUpperCase()}
            AND COALESCE(pv.image_url, p.image_url) IS NOT NULL
        ) sub
        LIMIT 1
      `);
      if (imageResult.rows.length > 0 && imageResult.rows[0].image_url) {
        imageUrl = imageResult.rows[0].image_url;
      }
    }

    const qty = item.fulfillable_quantity || item.quantity;
    enrichedItems.push({
      orderId: 0,
      shopifyLineItemId: item.shopify_line_item_id,
      sourceItemId: item.id,
      sku: item.sku || 'UNKNOWN',
      name: item.name || item.title || 'Unknown Item',
      quantity: qty,
      pickedQuantity: isFulfilled ? qty : 0,
      fulfilledQuantity: isFulfilled ? qty : 0,
      status: isFulfilled ? "fulfilled" : "pending",
      location: binLocation?.location || "UNASSIGNED",
      zone: binLocation?.zone || "U",
      imageUrl: imageUrl,
      barcode: binLocation?.barcode || null,
      requiresShipping: item.requires_shipping ? 1 : 0,
    });
  }

  const warehouseStatus = rawOrder.cancelled_at
    ? "cancelled"
    : allFullyFulfilled
      ? "shipped"
      : hasShippableItems
        ? "ready"
        : "completed";

  // Set completedAt for orders that arrive already fulfilled/cancelled
  const isTerminal = warehouseStatus === "shipped" || warehouseStatus === "completed" || warehouseStatus === "cancelled";
  const completedAt = isTerminal
    ? (rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : new Date())
    : undefined;

  const newOrder = await storage.createOrderWithItems({
    shopifyOrderId: rawOrder.id,
    externalOrderId: rawOrder.id,
    sourceTableId: rawOrder.id,
    channelId: channelId,
    source: "shopify",
    orderNumber: rawOrder.order_number,
    customerName: rawOrder.customer_name || rawOrder.shipping_name || rawOrder.order_number,
    customerEmail: rawOrder.customer_email,
    shippingName: rawOrder.shipping_name,
    shippingAddress: rawOrder.shipping_address1,
    shippingCity: rawOrder.shipping_city,
    shippingState: rawOrder.shipping_state,
    shippingPostalCode: rawOrder.shipping_postal_code,
    shippingCountry: rawOrder.shipping_country,
    financialStatus: rawOrder.financial_status,
    shopifyFulfillmentStatus: rawOrder.fulfillment_status,
    cancelledAt: rawOrder.cancelled_at ? new Date(rawOrder.cancelled_at) : undefined,
    completedAt,
    priority: "normal",
    warehouseStatus,
    itemCount: enrichedItems.length,
    unitCount: totalUnits,
    totalAmount: rawOrder.total_price_cents ? String(rawOrder.total_price_cents / 100) : null,
    currency: rawOrder.currency,
    shopifyCreatedAt: rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
    orderPlacedAt: rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
  }, enrichedItems);

  // Route order to the correct warehouse via fulfillment routing rules
  try {
    const routingCtx = {
      channelId: channelId,
      skus: enrichedItems.map((i: any) => i.sku).filter((s: string) => s !== "UNKNOWN"),
      country: rawOrder.shipping_country,
    };
    const routing = await fulfillmentRouter.routeOrder(routingCtx);
    if (routing) {
      await fulfillmentRouter.assignWarehouseToOrder(newOrder.id, routing);
      console.log(`[ORDER SYNC] Routed ${rawOrder.order_number} → warehouse ${routing.warehouseCode} (${routing.warehouseType})${routing.matchedRule ? ` via rule ${routing.matchedRule.matchType}=${routing.matchedRule.matchValue}` : " (default)"}`);

      // Set SLA due date based on channel's partner profile
      try {
        await slaMonitor.setSLAForOrder(newOrder.id);
      } catch (slaErr) {
        console.error(`[ORDER SYNC] SLA setup failed for ${rawOrder.order_number}:`, slaErr);
      }

      // 3PL orders: skip bin-level reservation, they don't enter pick/pack workflow
      if (routing.warehouseType === "3pl") {
        console.log(`[ORDER SYNC] 3PL order ${rawOrder.order_number} — skipping reservation (external fulfillment)`);
      } else if (warehouseStatus === "ready") {
        // Auto-reserve inventory at bin level for managed warehouse orders
        try {
          const reserveResult = await reservation.reserveOrder(newOrder.id);
          if (reserveResult.failed.length > 0) {
            console.log(`[ORDER SYNC] Reservation partial for ${rawOrder.order_number}: ${reserveResult.failed.length} items could not be reserved`);
          }
        } catch (e) {
          console.error(`[ORDER SYNC] Reservation failed for ${rawOrder.order_number}:`, e);
        }
      }
    } else {
      // No routing result (no default warehouse configured) — reserve as before
      if (warehouseStatus === "ready") {
        try {
          const reserveResult = await reservation.reserveOrder(newOrder.id);
          if (reserveResult.failed.length > 0) {
            console.log(`[ORDER SYNC] Reservation partial for ${rawOrder.order_number}: ${reserveResult.failed.length} items could not be reserved`);
          }
        } catch (e) {
          console.error(`[ORDER SYNC] Reservation failed for ${rawOrder.order_number}:`, e);
        }
      }
    }
  } catch (routingError) {
    console.error(`[ORDER SYNC] Routing failed for ${rawOrder.order_number}, falling back to default reservation:`, routingError);
    // Fallback: reserve as before if routing fails
    if (warehouseStatus === "ready") {
      try {
        const reserveResult = await reservation.reserveOrder(newOrder.id);
        if (reserveResult.failed.length > 0) {
          console.log(`[ORDER SYNC] Reservation partial for ${rawOrder.order_number}: ${reserveResult.failed.length} items could not be reserved`);
        }
      } catch (e) {
        console.error(`[ORDER SYNC] Reservation failed for ${rawOrder.order_number}:`, e);
      }
    }
  }

  console.log(`[ORDER SYNC] Created order ${rawOrder.order_number} (status: ${warehouseStatus}, items: ${enrichedItems.length})`);
  return true;
}

/**
 * Process the pending sync queue - syncs specific orders that were notified via LISTEN/NOTIFY.
 * Runs one order at a time to avoid overwhelming the DB.
 */
async function processQueue() {
  if (queueProcessorRunning) return;
  queueProcessorRunning = true;

  try {
    while (pendingSyncQueue.size > 0) {
      const orderId = pendingSyncQueue.values().next().value;
      if (!orderId) break;
      pendingSyncQueue.delete(orderId);

      try {
        await syncSingleOrder(orderId);
      } catch (e) {
        console.error(`[ORDER SYNC] Failed to sync order ${orderId}:`, e);
        // Don't re-queue - the batch poll will catch it
      }
    }
  } finally {
    queueProcessorRunning = false;
  }
}

/**
 * Batch sync: finds ALL unsynced orders and creates them.
 * Runs on startup and periodically as a safety net.
 */
export async function syncNewOrders() {
  if (isBatchProcessing) {
    console.log("[ORDER SYNC] Batch sync already processing, skipping");
    return;
  }

  isBatchProcessing = true;
  lastSyncAttempt = new Date();

  try {
    console.log("[ORDER SYNC] Running batch sync for unsynced orders...");

    // Find orders in shopify_orders that aren't yet in our orders table
    const rawOrders = await db.execute<{ id: string; order_number: string }>(sql`
      SELECT so.id, so.order_number FROM shopify_orders so
      WHERE NOT EXISTS (
        SELECT 1 FROM orders o WHERE o.source_table_id = so.id
      )
      ORDER BY so.created_at ASC
      LIMIT 200
    `);

    let created = 0;
    let failed = 0;

    if (rawOrders.rows.length > 0) {
      console.log(`[ORDER SYNC] Found ${rawOrders.rows.length} unsynced orders`);
    }

    for (const row of rawOrders.rows) {
      try {
        const wasCreated = await syncSingleOrder(row.id);
        if (wasCreated) created++;
      } catch (e) {
        console.error(`[ORDER SYNC] Failed to sync order ${row.order_number} (${row.id}):`, e);
        failed++;
      }
    }

    if (created > 0 || failed > 0) {
      console.log(`[ORDER SYNC] Batch sync: ${created} created, ${failed} failed, ${rawOrders.rows.length - created - failed} skipped`);
    }

    // Mark successful sync
    lastSuccessfulSync = new Date();
    lastSyncError = null;
    consecutiveErrors = 0;

    // Persist last sync time to settings
    await storage.upsertSetting("sync_last_success", lastSuccessfulSync.toISOString(), "sync");

  } catch (error) {
    console.error("[ORDER SYNC] Error in batch sync:", error);
    lastSyncError = String(error);
    consecutiveErrors++;

    // Persist error state
    await storage.upsertSetting("sync_last_error", lastSyncError, "sync");
    await storage.upsertSetting("sync_consecutive_errors", String(consecutiveErrors), "sync");
  } finally {
    isBatchProcessing = false;
  }
}

async function syncOrderUpdate(shopifyOrderId: string) {
  try {
    console.log(`[ORDER SYNC] Processing update for shopify order: ${shopifyOrderId}`);

    const rawOrder = await db.execute<{
      id: string;
      financial_status: string | null;
      fulfillment_status: string | null;
      cancelled_at: Date | null;
      customer_name: string | null;
      shipping_name: string | null;
    }>(sql`
      SELECT id, financial_status, fulfillment_status, cancelled_at, customer_name, shipping_name
      FROM shopify_orders
      WHERE id = ${shopifyOrderId}
    `);

    if (rawOrder.rows.length === 0) {
      console.log(`[ORDER SYNC] Shopify order ${shopifyOrderId} not found`);
      return;
    }

    const shopifyOrder = rawOrder.rows[0];

    // Look up the internal order ID before updating
    const existingOrder = await db.execute<{ id: number; warehouse_status: string }>(sql`
      SELECT id, warehouse_status FROM orders WHERE source_table_id = ${shopifyOrderId}
    `);

    // If the order doesn't exist yet, it might be a new order that the INSERT trigger missed
    // Queue it for sync instead
    if (existingOrder.rows.length === 0) {
      console.log(`[ORDER SYNC] Order ${shopifyOrderId} not in orders table yet, queuing for sync`);
      pendingSyncQueue.add(shopifyOrderId);
      processQueue();
      return;
    }

    await db.execute(sql`
      UPDATE orders SET
        financial_status = ${shopifyOrder.financial_status},
        shopify_fulfillment_status = ${shopifyOrder.fulfillment_status},
        cancelled_at = ${shopifyOrder.cancelled_at},
        customer_name = COALESCE(NULLIF(${shopifyOrder.customer_name}, ''), NULLIF(${shopifyOrder.shipping_name}, ''), customer_name),
        shipping_name = COALESCE(${shopifyOrder.shipping_name}, shipping_name)
      WHERE source_table_id = ${shopifyOrderId}
    `);

    // Auto-release bin reservations when order is cancelled
    if (shopifyOrder.cancelled_at && existingOrder.rows.length > 0) {
      const orderId = existingOrder.rows[0].id;
      try {
        await reservation.releaseOrderReservation(orderId, "Order cancelled in Shopify");
        console.log(`[ORDER SYNC] Released reservations for cancelled order ${shopifyOrderId}`);
      } catch (e) {
        console.error(`[ORDER SYNC] Failed to release reservations for ${shopifyOrderId}:`, e);
      }
    }

    // Safety net: transition warehouse_status to shipped when Shopify says fulfilled
    // This catches orders that were shipped in Shopify without completing Echelon pick flow
    if (
      shopifyOrder.fulfillment_status === "fulfilled" &&
      existingOrder.rows.length > 0 &&
      existingOrder.rows[0].warehouse_status !== "shipped" &&
      existingOrder.rows[0].warehouse_status !== "ready_to_ship"
    ) {
      const orderId = existingOrder.rows[0].id;
      const prevStatus = existingOrder.rows[0].warehouse_status;
      await db.execute(sql`
        UPDATE orders SET warehouse_status = 'shipped', updated_at = NOW()
        WHERE id = ${orderId}
      `);
      console.log(`[ORDER SYNC] Transitioned order ${orderId} to shipped (was ${prevStatus}, Shopify says fulfilled)`);
    }

    console.log(`[ORDER SYNC] Updated order from shopify order ${shopifyOrderId}`);
  } catch (error) {
    console.error(`[ORDER SYNC] Error syncing update for ${shopifyOrderId}:`, error);
  }
}

let syncInterval: ReturnType<typeof setInterval> | null = null;

export async function setupOrderSyncListener() {
  try {
    listenerClient = new Client({
      connectionString: dbConnectionString,
      ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    });

    await listenerClient.connect();
    console.log("[ORDER SYNC] Connected to database for LISTEN");

    // Backfill completedAt for terminal orders that have NULL completedAt
    setTimeout(async () => {
      try {
        const result = await db.execute(sql`
          UPDATE orders SET completed_at = COALESCE(order_placed_at, created_at)
          WHERE completed_at IS NULL
            AND warehouse_status IN ('completed', 'shipped', 'cancelled')
        `);
        console.log(`[ORDER SYNC] Backfilled completedAt for terminal orders`);
      } catch (e) {
        console.error("[ORDER SYNC] Backfill error:", e);
      }
    }, 1000);

    // Sync any orders that arrived while server was down
    setTimeout(() => {
      console.log("[ORDER SYNC] Running startup sync for missed orders...");
      syncNewOrders();
    }, 2000);

    // Periodic polling every 60 seconds as a safety net (was 5 min, too long)
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(() => {
      syncNewOrders();
    }, 60 * 1000);

    // Periodic SLA status update every 15 minutes
    setInterval(async () => {
      try {
        await slaMonitor.updateSLAStatuses();
      } catch (e) {
        console.error("[ORDER SYNC] SLA status update failed:", e);
      }
    }, 15 * 60 * 1000);

    // INSERT trigger for new orders
    await listenerClient.query(`
      CREATE OR REPLACE FUNCTION notify_new_shopify_order()
      RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_notify('new_shopify_order', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await listenerClient.query(`
      DROP TRIGGER IF EXISTS shopify_order_insert_trigger ON shopify_orders;
    `);

    await listenerClient.query(`
      CREATE TRIGGER shopify_order_insert_trigger
      AFTER INSERT ON shopify_orders
      FOR EACH ROW
      EXECUTE FUNCTION notify_new_shopify_order();
    `);

    // UPDATE trigger for status changes
    await listenerClient.query(`
      CREATE OR REPLACE FUNCTION notify_shopify_order_update()
      RETURNS TRIGGER AS $$
      BEGIN
        PERFORM pg_notify('shopify_order_update', NEW.id::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await listenerClient.query(`
      DROP TRIGGER IF EXISTS shopify_order_update_trigger ON shopify_orders;
    `);

    await listenerClient.query(`
      CREATE TRIGGER shopify_order_update_trigger
      AFTER UPDATE ON shopify_orders
      FOR EACH ROW
      EXECUTE FUNCTION notify_shopify_order_update();
    `);

    console.log("[ORDER SYNC] Created INSERT and UPDATE triggers on shopify_orders");

    // Handle notifications: queue specific order for sync (instead of running batch)
    listenerClient.on("notification", async (msg) => {
      if (msg.channel === "new_shopify_order" && msg.payload) {
        console.log(`[ORDER SYNC] Received INSERT notification for order: ${msg.payload}`);
        pendingSyncQueue.add(msg.payload);
        // Small delay to let items be inserted too
        setTimeout(() => processQueue(), 1500);
      } else if (msg.channel === "shopify_order_update" && msg.payload) {
        console.log(`[ORDER SYNC] Received UPDATE notification for order: ${msg.payload}`);
        setTimeout(() => syncOrderUpdate(msg.payload!), 500);
      }
    });

    await listenerClient.query("LISTEN new_shopify_order");
    await listenerClient.query("LISTEN shopify_order_update");
    console.log("[ORDER SYNC] Listening for new_shopify_order and shopify_order_update notifications");

    // Keepalive: periodically ping the connection to detect stale connections
    setInterval(async () => {
      try {
        if (listenerClient) {
          await listenerClient.query("SELECT 1");
        }
      } catch (e) {
        console.error("[ORDER SYNC] Keepalive failed, reconnecting:", e);
        try {
          if (listenerClient) listenerClient.end().catch(() => {});
        } catch (_) {}
        listenerClient = null;
        setTimeout(setupOrderSyncListener, 2000);
      }
    }, 30000); // Every 30 seconds

    listenerClient.on("error", (err) => {
      console.error("[ORDER SYNC] Database connection error:", err);
      setTimeout(setupOrderSyncListener, 5000);
    });

  } catch (error) {
    console.error("[ORDER SYNC] Failed to setup listener:", error);
    setTimeout(setupOrderSyncListener, 10000);
  }
}

export function stopOrderSyncListener() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  if (listenerClient) {
    listenerClient.end();
    listenerClient = null;
  }
}
