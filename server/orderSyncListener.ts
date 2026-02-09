import { Pool, Client } from "pg";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import type { InsertOrderItem } from "@shared/schema";
import { createInventoryCoreService } from "./services/inventory-core";
import { createReservationService } from "./services/reservation";

// Reservation service for auto-reserving inventory on order creation
const inventoryCore = createInventoryCoreService(db);
const reservation = createReservationService(db, inventoryCore);

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
let isProcessing = false;

export async function syncNewOrders() {
  if (isProcessing) {
    console.log("[ORDER SYNC] Already processing, skipping");
    return;
  }
  
  isProcessing = true;
  lastSyncAttempt = new Date();
  
  try {
    console.log("[ORDER SYNC] Syncing new orders from shopify_orders...");
    
    const allChannels = await storage.getAllChannels();
    const shopifyChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
    const shopifyChannelId = shopifyChannel?.id || null;
    
    const rawOrders = await db.execute<{
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
    }>(sql`
      SELECT * FROM shopify_orders 
      WHERE id NOT IN (SELECT source_table_id FROM orders WHERE source_table_id IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT 50
    `);
    
    let created = 0;
    let skipped = 0;
    
    console.log(`[ORDER SYNC] Found ${rawOrders.rows.length} orders to process`);
    
    for (const rawOrder of rawOrders.rows) {
      const rawItems = await db.execute<{
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
        SELECT * FROM shopify_order_items 
        WHERE order_id = ${rawOrder.id}
      `);
      
      if (rawItems.rows.length === 0) {
        console.log(`[ORDER SYNC] Skipping order ${rawOrder.order_number}: no items in shopify_order_items`);
        skipped++;
        continue;
      }

      const allItems = rawItems.rows;
      const allFullyFulfilled = allItems.every(item => item.fulfillment_status === 'fulfilled');
      const totalUnits = allItems.reduce((sum, item) => sum + (item.fulfillable_quantity || item.quantity), 0);
      const hasShippableItems = allItems.some(item => item.requires_shipping !== false);

      const enrichedItems: InsertOrderItem[] = [];
      for (const item of allItems) {
        const isFulfilled = item.fulfillment_status === 'fulfilled';

        // Look up bin location from inventory_levels (where stock actually is)
        const binLocation = await storage.getBinLocationFromInventoryBySku(item.sku || '');

        // If no image from inventory, try product_locations first (best source), then product_variants/products
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

      const newOrder = await storage.createOrderWithItems({
        shopifyOrderId: rawOrder.id,
        externalOrderId: rawOrder.id,
        sourceTableId: rawOrder.id,
        channelId: shopifyChannelId,
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
        priority: "normal",
        warehouseStatus,
        itemCount: enrichedItems.length,
        unitCount: totalUnits,
        totalAmount: rawOrder.total_price_cents ? String(rawOrder.total_price_cents / 100) : null,
        currency: rawOrder.currency,
        shopifyCreatedAt: rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
        orderPlacedAt: rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
      }, enrichedItems);

      // Auto-reserve inventory at bin level for orders that need fulfillment
      if (warehouseStatus === "ready") {
        try {
          const reserveResult = await reservation.reserveOrder(newOrder.id);
          if (reserveResult.failed.length > 0) {
            console.log(`[ORDER SYNC] Reservation partial for ${rawOrder.order_number}: ${reserveResult.failed.length} items could not be reserved`);
          }
        } catch (e) {
          console.error(`[ORDER SYNC] Reservation failed for ${rawOrder.order_number}:`, e);
          // Non-blocking — order still created, just not reserved
        }
      }

      created++;
    }
    
    if (created > 0) {
      console.log(`[ORDER SYNC] Created ${created} new orders`);
    }
    
    // Mark successful sync
    lastSuccessfulSync = new Date();
    lastSyncError = null;
    consecutiveErrors = 0;
    
    // Persist last sync time to settings
    await storage.upsertSetting("sync_last_success", lastSuccessfulSync.toISOString(), "sync");
    
  } catch (error) {
    console.error("[ORDER SYNC] Error syncing orders:", error);
    lastSyncError = String(error);
    consecutiveErrors++;
    
    // Persist error state
    await storage.upsertSetting("sync_last_error", lastSyncError, "sync");
    await storage.upsertSetting("sync_consecutive_errors", String(consecutiveErrors), "sync");
  } finally {
    isProcessing = false;
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
    
    // Sync any orders that arrived while server was down
    setTimeout(() => {
      console.log("[ORDER SYNC] Running startup sync for missed orders...");
      syncNewOrders();
    }, 2000);
    
    // Periodic polling every 5 minutes as a safety net
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = setInterval(() => {
      syncNewOrders();
    }, 5 * 60 * 1000);
    
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
    
    listenerClient.on("notification", async (msg) => {
      if (msg.channel === "new_shopify_order") {
        console.log(`[ORDER SYNC] Received INSERT notification for order: ${msg.payload}`);
        setTimeout(() => syncNewOrders(), 500);
      } else if (msg.channel === "shopify_order_update" && msg.payload) {
        console.log(`[ORDER SYNC] Received UPDATE notification for order: ${msg.payload}`);
        setTimeout(() => syncOrderUpdate(msg.payload!), 500);
      }
    });
    
    await listenerClient.query("LISTEN new_shopify_order");
    await listenerClient.query("LISTEN shopify_order_update");
    console.log("[ORDER SYNC] Listening for new_shopify_order and shopify_order_update notifications");
    
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
