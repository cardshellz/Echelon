import { Pool, Client } from "pg";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { storage } from "./storage";
import type { InsertOrderItem } from "@shared/schema";

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
      
      const unfulfilledItems = rawItems.rows.filter(item => 
        !item.fulfillment_status || item.fulfillment_status !== 'fulfilled'
      );
      
      if (unfulfilledItems.length === 0) {
        console.log(`[ORDER SYNC] Skipping order ${rawOrder.order_number}: all ${rawItems.rows.length} items already fulfilled`);
        skipped++;
        continue;
      }
      
      const totalUnits = unfulfilledItems.reduce((sum, item) => sum + (item.fulfillable_quantity || item.quantity), 0);
      const hasShippableItems = unfulfilledItems.some(item => item.requires_shipping === true);
      
      const enrichedItems: InsertOrderItem[] = [];
      for (const item of unfulfilledItems) {
        const productLocation = await storage.getProductLocationBySku(item.sku || '');
        enrichedItems.push({
          orderId: 0,
          shopifyLineItemId: item.shopify_line_item_id,
          sourceItemId: item.id,
          sku: item.sku || 'UNKNOWN',
          name: item.name || item.title || 'Unknown Item',
          quantity: item.fulfillable_quantity || item.quantity,
          pickedQuantity: 0,
          fulfilledQuantity: 0,
          status: "pending",
          location: productLocation?.location || "UNASSIGNED",
          zone: productLocation?.zone || "U",
          imageUrl: productLocation?.imageUrl || null,
          barcode: productLocation?.barcode || null,
          requiresShipping: item.requires_shipping ? 1 : 0,
        });
      }
      
      await storage.createOrderWithItems({
        shopifyOrderId: rawOrder.id,
        externalOrderId: rawOrder.id,
        sourceTableId: rawOrder.id,
        channelId: shopifyChannelId,
        source: "shopify",
        orderNumber: rawOrder.order_number,
        customerName: rawOrder.customer_name || rawOrder.shipping_name || rawOrder.order_number,
        customerEmail: rawOrder.customer_email,
        shippingAddress: rawOrder.shipping_address1,
        shippingCity: rawOrder.shipping_city,
        shippingState: rawOrder.shipping_state,
        shippingPostalCode: rawOrder.shipping_postal_code,
        shippingCountry: rawOrder.shipping_country,
        priority: "normal",
        status: hasShippableItems ? "ready" : "completed",
        itemCount: enrichedItems.length,
        unitCount: totalUnits,
        totalAmount: rawOrder.total_price_cents ? String(rawOrder.total_price_cents / 100) : null,
        currency: rawOrder.currency,
        shopifyCreatedAt: rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
        orderPlacedAt: rawOrder.order_date ? new Date(rawOrder.order_date) : rawOrder.created_at ? new Date(rawOrder.created_at) : undefined,
      }, enrichedItems);
      
      created++;
    }
    
    if (created > 0) {
      console.log(`[ORDER SYNC] Created ${created} new orders`);
    }
  } catch (error) {
    console.error("[ORDER SYNC] Error syncing orders:", error);
  } finally {
    isProcessing = false;
  }
}

export async function setupOrderSyncListener() {
  try {
    listenerClient = new Client({
      connectionString: dbConnectionString,
      ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    });
    
    await listenerClient.connect();
    console.log("[ORDER SYNC] Connected to database for LISTEN");
    
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
    
    console.log("[ORDER SYNC] Created trigger on shopify_orders");
    
    listenerClient.on("notification", async (msg) => {
      if (msg.channel === "new_shopify_order") {
        console.log(`[ORDER SYNC] Received notification for order: ${msg.payload}`);
        setTimeout(() => syncNewOrders(), 500);
      }
    });
    
    await listenerClient.query("LISTEN new_shopify_order");
    console.log("[ORDER SYNC] Listening for new_shopify_order notifications");
    
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
  if (listenerClient) {
    listenerClient.end();
    listenerClient = null;
  }
}
