import type { Express, Request, Response } from "express";
import { z } from "zod";
import { eq, sql, and } from "drizzle-orm";
import { db } from "../db";
import { ordersStorage } from "../modules/orders";
import { channelsStorage } from "../modules/channels";
import { inventoryStorage } from "../modules/inventory";
import { warehouseStorage } from "../modules/warehouse";
const storage = { ...ordersStorage, ...channelsStorage, ...inventoryStorage, ...warehouseStorage };
import { requirePermission, requireAuth } from "./middleware";
import { fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, verifyWebhookWithSecret, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, type ShopifyOrder } from "../modules/integrations/shopify";
import { broadcastOrdersUpdated } from "../websocket";
import { orders, orderItems, channels, channelListings, productVariants, products, productAssets, inventoryLevels } from "@shared/schema";
import type { InsertOrderItem } from "@shared/schema";

export function registerShopifyRoutes(app: Express) {
  const {
    productImport,
  } = app.locals.services as any;

  app.post("/api/shopify/sync", async (req, res) => {
    try {
      const result = await productImport.syncContentAndAssets();
      res.json(result);
    } catch (error: any) {
      console.error("Shopify sync error:", error);
      res.status(500).json({
        error: "Failed to sync with Shopify",
        message: error.message
      });
    }
  });

  // Sync Shopify variants to products/product_variants tables
  // Parses SKU pattern: BASE-SKU-P50, BASE-SKU-C700 etc.
  app.post("/api/shopify/sync-products", async (req, res) => {
    try {
      const result = await productImport.syncProductsWithMultiUOM();
      // Also sync content + images now that products exist
      const contentResult = await productImport.syncContentAndAssets();
      res.json({
        ...result,
        contentSync: {
          productsUpdated: contentResult.productsUpdated,
          assets: contentResult.assets,
          skuMatched: contentResult.skuMatched,
          skuNotFound: contentResult.skuNotFound,
        },
      });
    } catch (error: any) {
      console.error("Shopify product sync error:", error);
      res.status(500).json({
        error: "Failed to sync products from Shopify",
        message: error.message
      });
    }
  });

  // Sync from shopify_orders/shopify_order_items tables to operational orders/order_items
  // This reads from the raw Shopify tables and extracts operational subset
  app.post("/api/shopify/sync-from-raw-tables", async (req, res) => {
    try {
      console.log("Starting sync from shopify_orders to operational orders...");
      
      // Get default Shopify channel for linking orders
      const allChannels = await storage.getAllChannels();
      const shopifyChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
      const shopifyChannelId = shopifyChannel?.id || null;
      
      // Fetch unfulfilled orders from shopify_orders table
      const rawOrders = await db.execute<{
        id: string;
        order_number: string;
        legacy_order_id: string | null;
        member_id: string | null;
        shopify_customer_id: string | null;
        order_date: Date | null;
        financial_status: string | null;
        fulfillment_status: string | null;
        total_price_cents: number | null;
        currency: string | null;
        note: string | null;
        tags: string[] | null;
        discount_codes: any | null;
        created_at: Date | null;
        customer_name: string | null;
        customer_email: string | null;
        shipping_name: string | null;
        shipping_address1: string | null;
        shipping_address2: string | null;
        shipping_city: string | null;
        shipping_state: string | null;
        shipping_postal_code: string | null;
        shipping_country: string | null;
        cancelled_at: Date | null;
      }>(sql`
        SELECT * FROM shopify_orders 
        WHERE fulfillment_status IS NULL 
           OR fulfillment_status = 'unfulfilled'
           OR fulfillment_status = 'partial'
        ORDER BY order_date DESC
      `);
      
      let created = 0;
      let skipped = 0;
      
      for (const rawOrder of rawOrders.rows) {
        // Check if order already exists in operational table
        const existingOrder = await storage.getOrderByShopifyId(rawOrder.id);
        if (existingOrder) {
          skipped++;
          continue;
        }
        
        // Fetch ALL line items for this order from shopify_order_items (including requires_shipping flag)
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
        
        // Skip if no items at all
        if (rawItems.rows.length === 0) {
          skipped++;
          continue;
        }
        
        // Filter to unfulfilled items only (for pick queue relevance)
        const unfulfilledItems = rawItems.rows.filter(item => 
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
          
          // Look up image from product_locations first (best source), then products/product_variants
          let itemImageUrl = binLocation?.imageUrl || null;
          if (!itemImageUrl && item.sku) {
            const imgResult = await db.execute<{ image_url: string | null }>(sql`
              SELECT image_url FROM (
                SELECT pl.image_url FROM product_locations pl
                WHERE UPPER(pl.sku) = ${item.sku.toUpperCase()} AND pl.image_url IS NOT NULL
                UNION ALL
                SELECT COALESCE(
                  (SELECT pa.url FROM product_assets pa WHERE pa.product_variant_id = pv.id AND pa.is_primary = 1 LIMIT 1),
                  (SELECT pa.url FROM product_assets pa WHERE pa.product_id = pv.product_id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1)
                ) as image_url
                FROM product_variants pv
                WHERE UPPER(pv.sku) = ${item.sku.toUpperCase()}
                  AND EXISTS (SELECT 1 FROM product_assets pa WHERE (pa.product_variant_id = pv.id OR (pa.product_id = pv.product_id AND pa.product_variant_id IS NULL)) AND pa.is_primary = 1)
              ) sub
              LIMIT 1
            `);
            if (imgResult.rows.length > 0 && imgResult.rows[0].image_url) {
              itemImageUrl = imgResult.rows[0].image_url;
            }
          }
          
          enrichedItems.push({
            orderId: 0,
            shopifyLineItemId: item.shopify_line_item_id,
            sourceItemId: item.id, // Links to shopify_order_items.id
            sku: item.sku || 'UNKNOWN',
            name: item.name || item.title || 'Unknown Item',
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
        
        // Create operational order using customer/shipping data from shopify_orders
        await storage.createOrderWithItems({
          shopifyOrderId: rawOrder.id,
          externalOrderId: rawOrder.id,
          sourceTableId: rawOrder.id, // Links to shopify_orders.id for JOINs
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
          warehouseStatus: rawOrder.cancelled_at ? "cancelled" : (hasShippableItems ? "ready" : "completed"),
          itemCount: enrichedItems.length,
          unitCount: totalUnits,
          totalAmount: rawOrder.total_price_cents ? String(rawOrder.total_price_cents / 100) : null,
          currency: rawOrder.currency,
          shopifyCreatedAt: rawOrder.order_date || rawOrder.created_at || undefined,
          orderPlacedAt: rawOrder.order_date || rawOrder.created_at || undefined,
        }, enrichedItems);
        
        created++;
      }
      
      console.log(`Sync complete: ${created} created, ${skipped} skipped`);
      res.json({ success: true, created, skipped });
    } catch (error) {
      console.error("Error syncing from raw tables:", error);
      res.status(500).json({ error: "Failed to sync from raw tables" });
    }
  });

  // Sync order statuses FROM Shopify fulfillment data
  // Updates orders and order_items based on shopify_orders.fulfillment_status
  app.post("/api/shopify/sync-statuses-from-shopify", async (req, res) => {
    try {
      console.log("Syncing order statuses from Shopify fulfillment data...");
      const startTime = Date.now();
      
      // 1. Update ORDERS status to 'completed' where Shopify shows fulfilled
      const ordersResult = await db.execute(sql`
        UPDATE orders o SET
          status = 'completed',
          completed_at = COALESCE(o.completed_at, NOW())
        FROM shopify_orders s
        WHERE o.source_table_id = s.id
          AND s.fulfillment_status = 'fulfilled'
          AND o.warehouse_status != 'completed'
      `);
      
      // 2. Update ORDER_ITEMS to 'completed' with full picked_quantity where Shopify item is fulfilled
      const itemsResult = await db.execute(sql`
        UPDATE order_items oi SET
          status = 'completed',
          picked_quantity = oi.quantity,
          fulfilled_quantity = oi.quantity
        FROM shopify_order_items soi
        WHERE oi.source_item_id = soi.id
          AND soi.fulfillment_status = 'fulfilled'
          AND oi.status != 'completed'
      `);
      
      // 3. Also update items where the parent ORDER is fulfilled (catches items without individual fulfillment status)
      const itemsByOrderResult = await db.execute(sql`
        UPDATE order_items oi SET
          status = 'completed',
          picked_quantity = oi.quantity,
          fulfilled_quantity = oi.quantity
        FROM orders o
        INNER JOIN shopify_orders s ON o.source_table_id = s.id
        WHERE oi.order_id = o.id
          AND s.fulfillment_status = 'fulfilled'
          AND oi.status != 'completed'
      `);
      
      // 4. Handle partial fulfillments - update items individually
      const partialResult = await db.execute(sql`
        UPDATE order_items oi SET
          status = 'completed',
          picked_quantity = oi.quantity,
          fulfilled_quantity = oi.quantity
        FROM shopify_order_items soi
        WHERE oi.source_item_id = soi.id
          AND soi.fulfillment_status = 'fulfilled'
          AND oi.status = 'pending'
      `);
      
      const elapsed = Date.now() - startTime;
      console.log(`Status sync complete in ${elapsed}ms`);
      
      res.json({ 
        success: true, 
        message: "Order statuses synced from Shopify fulfillment data",
        elapsed: `${elapsed}ms`
      });
    } catch (error) {
      console.error("Error syncing statuses from Shopify:", error);
      res.status(500).json({ error: "Failed to sync statuses from Shopify" });
    }
  });

  // Backfill operational orders table with customer data from shopify_orders
  // Uses efficient UPDATE FROM JOIN to process thousands of orders at once
  app.post("/api/shopify/backfill-orders-from-raw", async (req, res) => {
    try {
      console.log("Starting backfill of operational orders from shopify_orders...");
      const startTime = Date.now();
      
      // Single efficient UPDATE using JOIN - processes ALL orders at once
      // Match on source_table_id OR shopify_order_id (various formats)
      const result = await db.execute(sql`
        UPDATE orders o SET
          customer_name = COALESCE(s.customer_name, s.shipping_name, o.customer_name),
          customer_email = COALESCE(s.customer_email, o.customer_email),
          shipping_address = COALESCE(s.shipping_address1, o.shipping_address),
          shipping_city = COALESCE(s.shipping_city, o.shipping_city),
          shipping_state = COALESCE(s.shipping_state, o.shipping_state),
          shipping_postal_code = COALESCE(s.shipping_postal_code, o.shipping_postal_code),
          shipping_country = COALESCE(s.shipping_country, o.shipping_country)
        FROM shopify_orders s
        WHERE o.source = 'shopify'
          AND (
            o.source_table_id = CAST(s.id AS TEXT)
            OR o.shopify_order_id = s.id 
            OR o.shopify_order_id = REPLACE(s.id, 'gid://shopify/Order/', '')
            OR CONCAT('gid://shopify/Order/', o.shopify_order_id) = s.id
          )
          AND (o.shipping_address IS NULL OR o.shipping_city IS NULL)
      `);
      
      const updated = result.rowCount || 0;
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      // Count remaining (orders that couldn't be matched)
      const remainingCount = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*) as count FROM orders 
        WHERE source = 'shopify' 
          AND shopify_order_id IS NOT NULL
          AND (shipping_address IS NULL OR shipping_city IS NULL)
      `);
      const remaining = parseInt(remainingCount.rows[0]?.count || '0', 10);
      
      console.log(`Backfill complete: ${updated} updated, ${remaining} remaining, ${elapsed}s`);
      
      res.json({ 
        success: true, 
        updated,
        remaining,
        elapsed: `${elapsed}s`,
        message: remaining > 0 
          ? `Updated ${updated} orders. ${remaining} orders could not be matched to shopify_orders.`
          : `All ${updated} orders backfilled!`
      });
    } catch (error) {
      console.error("Error backfilling orders:", error);
      res.status(500).json({ error: "Failed to backfill orders" });
    }
  });

  // Backfill customer names from Shopify API into shopify_orders table
  // Processes ALL orders automatically by looping through all pages
  app.post("/api/shopify/backfill-customer-names", async (req, res) => {
    try {
      console.log("Starting FULL customer name backfill from Shopify API...");
      
      const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
      const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
      
      if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_ACCESS_TOKEN) {
        return res.status(400).json({ error: "Shopify credentials not configured" });
      }
      
      const store = SHOPIFY_SHOP_DOMAIN.replace(/\.myshopify\.com$/, "");
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
        let url = `https://${store}.myshopify.com/admin/api/2024-01/orders.json?limit=250&status=any`;
        if (pageInfo) {
          url = `https://${store}.myshopify.com/admin/api/2024-01/orders.json?limit=250&page_info=${pageInfo}`;
        }
        
        console.log(`Fetching page ${pagesProcessed + 1}...`);
        const response = await fetch(url, {
          headers: {
            "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
            "Content-Type": "application/json",
          },
        });
        
        if (!response.ok) {
          console.error(`Shopify API error: ${response.status}`);
          return res.status(500).json({ error: `Shopify API error: ${response.status}` });
        }
        
        const data = await response.json();
        const shopifyOrders = data.orders || [];
        
        if (shopifyOrders.length === 0) {
          console.log("No more orders to process");
          break;
        }
        
        console.log(`Processing ${shopifyOrders.length} orders...`);
        
        // Extract next page cursor from Link header
        const linkHeader = response.headers.get('Link');
        let nextPageInfo: string | null = null;
        if (linkHeader) {
          const nextMatch = linkHeader.match(/<[^>]*page_info=([^>&>]+)[^>]*>;\s*rel="next"/);
          if (nextMatch) {
            nextPageInfo = nextMatch[1];
          }
        }
        
        // Run all updates in parallel for speed
        const updatePromises = shopifyOrders.map(async (shopifyOrder: any) => {
          const orderId = `gid://shopify/Order/${shopifyOrder.id}`;
          const customerName = shopifyOrder.customer 
            ? `${shopifyOrder.customer.first_name || ''} ${shopifyOrder.customer.last_name || ''}`.trim()
            : shopifyOrder.shipping_address?.name || null;
          const customerEmail = shopifyOrder.email || shopifyOrder.customer?.email || null;
          const shipping = shopifyOrder.shipping_address || {};
          
          const result = await db.execute(sql`
            UPDATE shopify_orders SET
              customer_name = ${customerName || 'Unknown'},
              customer_email = ${customerEmail},
              shipping_name = ${shipping.name || null},
              shipping_address1 = ${shipping.address1 || null},
              shipping_address2 = ${shipping.address2 || null},
              shipping_city = ${shipping.city || null},
              shipping_state = ${shipping.province || null},
              shipping_postal_code = ${shipping.zip || null},
              shipping_country = ${shipping.country || null}
            WHERE id = ${orderId}
          `);
          return result.rowCount || 0;
        });
        
        const results = await Promise.all(updatePromises);
        const pageUpdated = results.reduce((sum, count) => sum + count, 0);
        totalUpdated += pageUpdated;
        totalSkipped += shopifyOrders.length - pageUpdated;
        
        pagesProcessed++;
        pageInfo = nextPageInfo || undefined;
        
        // No more pages
        if (!nextPageInfo) {
          console.log("Reached end of Shopify orders");
          break;
        }
        
        // Small delay for rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      
      // Count remaining orders
      const remainingCount = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*) as count FROM shopify_orders WHERE customer_name IS NULL
      `);
      const remaining = parseInt(remainingCount.rows[0]?.count || '0', 10);
      
      const finished = !pageInfo;
      console.log(`Backfill: ${pagesProcessed} pages, ${totalUpdated} updated, ${totalSkipped} not in DB, ${remaining} remaining, ${elapsed}s`);
      
      // Auto-continue: trigger next batch in background before responding
      if (!finished && pageInfo) {
        const protocol = req.protocol;
        const host = req.get('host');
        const continueUrl = `${protocol}://${host}/api/shopify/backfill-customer-names?page_info=${pageInfo}`;
        
        // Fire and forget - don't await
        fetch(continueUrl, { method: 'POST' }).catch(err => {
          console.error('Auto-continue failed:', err);
        });
        
        console.log(`Auto-continuing to next batch...`);
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
      console.error("Error backfilling customer names:", error);
      res.status(500).json({ error: "Failed to backfill customer names" });
    }
  });

  // Shopify Orders Sync - DEPRECATED: Use sync-from-raw-tables instead
  // Orders now flow through: shopify_orders table -> sync-from-raw-tables -> orders table
  app.post("/api/shopify/sync-orders", async (req, res) => {
    console.log("[DEPRECATED] /api/shopify/sync-orders called - redirecting to sync-from-raw-tables");
    res.status(410).json({ 
      error: "This endpoint is deprecated",
      message: "Orders are now synced from shopify_orders table. Use POST /api/shopify/sync-from-raw-tables instead.",
      redirect: "/api/shopify/sync-from-raw-tables"
    });
  });

  // Helper function to sync fulfillment status for all non-terminal orders
  async function syncFulfillmentStatus(): Promise<{ shipped: number; cancelled: number; checked: number }> {
    // Get ALL orders that might need status updates - include everything except already shipped/cancelled
    // This covers ready, in_progress, completed, ready_to_ship, and any on-hold orders
    const allOrders = await storage.getOrdersWithItems();
    
    console.log(`Fulfillment sync: Found ${allOrders.length} total orders in database`);
    
    // Filter to non-terminal orders that have Shopify IDs
    const activeOrders = allOrders.filter(o => 
      o.warehouseStatus !== "shipped" && 
      o.warehouseStatus !== "cancelled" && 
      o.shopifyOrderId
    );
    
    console.log(`Fulfillment sync: ${activeOrders.length} active orders to check (not shipped/cancelled, have Shopify ID)`);
    
    if (activeOrders.length === 0) {
      return { shipped: 0, cancelled: 0, checked: 0 };
    }
    
    // Get their Shopify IDs
    const shopifyOrderIds = activeOrders
      .filter(o => o.shopifyOrderId)
      .map(o => o.shopifyOrderId!);
    
    if (shopifyOrderIds.length === 0) {
      return { shipped: 0, cancelled: 0, checked: 0 };
    }
    
    // Fetch fulfillment status from Shopify
    console.log(`Fulfillment sync: Fetching status from Shopify for ${shopifyOrderIds.length} orders...`);
    const fulfillmentStatuses = await fetchOrdersFulfillmentStatus(shopifyOrderIds);
    console.log(`Fulfillment sync: Shopify returned ${fulfillmentStatuses.length} order statuses`);
    
    let shipped = 0;
    let cancelled = 0;
    
    for (const status of fulfillmentStatuses) {
      const order = activeOrders.find(o => o.shopifyOrderId === status.shopifyOrderId);
      if (!order) {
        console.log(`Fulfillment sync: No local order found for Shopify ID ${status.shopifyOrderId}`);
        continue;
      }
      
      console.log(`Fulfillment sync: Order ${order.orderNumber} (${order.shopifyOrderId}) - Shopify fulfillment_status: "${status.fulfillmentStatus}", cancelled_at: ${status.cancelledAt}`);
      
      // If FULLY fulfilled in Shopify (all line items), mark as shipped
      // For partial fulfillments, we rely on webhooks to track individual line items
      if (status.fulfillmentStatus === "fulfilled") {
        await storage.updateOrderStatus(order.id, "shipped");
        shipped++;
        console.log(`Order ${order.orderNumber} marked as shipped (fully fulfilled in Shopify)`);
      }
      // If cancelled in Shopify, mark as cancelled and release bin reservations
      else if (status.cancelledAt) {
        await storage.updateOrderStatus(order.id, "cancelled");
        try {
          const { reservation } = app.locals.services;
          await reservation.releaseOrderReservation(order.id, "Order cancelled in Shopify");
        } catch (e) {
          console.error(`Failed to release reservations for cancelled order ${order.orderNumber}:`, e);
        }
        cancelled++;
        console.log(`Order ${order.orderNumber} marked as cancelled`);
      }
    }
    
    if (shipped > 0 || cancelled > 0) {
      broadcastOrdersUpdated();
    }
    
    return { shipped, cancelled, checked: shopifyOrderIds.length };
  }

  // Reconcile order item locations with product_locations table
  // Updates pending/unassigned items if product_locations has been updated
  async function reconcileOrderItemLocations(): Promise<{ updated: number; checked: number }> {
    // Get all active orders (not shipped/cancelled) with their items
    const allOrders = await storage.getOrdersWithItems();
    const activeOrders = allOrders.filter(o => 
      o.warehouseStatus !== "shipped" && 
      o.warehouseStatus !== "cancelled"
    );
    
    let updated = 0;
    let checked = 0;
    
    for (const order of activeOrders) {
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
          console.log(`Reconcile: Updated item ${item.sku} in order ${order.orderNumber} to location ${binLocation.location}`);
        }
      }
    }
    
    if (updated > 0) {
      broadcastOrdersUpdated();
      console.log(`Location reconcile: Updated ${updated} items out of ${checked} checked`);
    }
    
    return { updated, checked };
  }

  // Dedicated fulfillment sync endpoint
  app.post("/api/shopify/sync-fulfillments", async (req, res) => {
    try {
      console.log("Starting fulfillment status sync...");
      
      const result = await syncFulfillmentStatus();
      
      console.log(`Fulfillment sync complete: ${result.shipped} shipped, ${result.cancelled} cancelled out of ${result.checked} checked`);
      
      res.json({
        success: true,
        ...result,
      });
    } catch (error: any) {
      console.error("Fulfillment sync error:", error);
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
    const hmac = req.headers["x-shopify-hmac-sha256"] as string;
    const rawBody = (req as any).rawBody as Buffer | undefined;
    const shopDomain = (req.headers["x-shopify-shop-domain"] as string) || null;

    if (!rawBody || !hmac) {
      return { verified: false, channelId: null, shopDomain };
    }

    // Try to find channel by shop domain
    if (shopDomain) {
      const connResult = await db.execute<{ channel_id: number; webhook_secret: string | null }>(sql`
        SELECT cc.channel_id, cc.webhook_secret
        FROM channel_connections cc
        WHERE LOWER(cc.shop_domain) = LOWER(${shopDomain})
        LIMIT 1
      `);

      if (connResult.rows.length > 0) {
        const conn = connResult.rows[0];
        // If the channel has its own webhook secret, use it
        if (conn.webhook_secret) {
          const verified = verifyWebhookWithSecret(rawBody, hmac, conn.webhook_secret);
          return { verified, channelId: conn.channel_id, shopDomain };
        }
        // Channel exists but no webhook secret — fall through to default
        const verified = verifyShopifyWebhook(rawBody, hmac);
        return { verified, channelId: conn.channel_id, shopDomain };
      }
    }

    // Fall back to default verification (primary store)
    const verified = verifyShopifyWebhook(rawBody, hmac);
    // Resolve default channel
    const allChannels = await storage.getAllChannels();
    const defaultChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
    return { verified, channelId: defaultChannel?.id || null, shopDomain };
  }

  // Shopify Webhooks - raw body captured by express.json verify callback
  app.post("/api/shopify/webhooks/products/create", async (req: Request, res: Response) => {
    try {
      const { verified, shopDomain } = await verifyChannelWebhook(req);

      if (!verified) {
        console.error(`Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}`);
        return res.status(401).json({ error: "Invalid signature" });
      }

      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      
      for (const { sku, name, status } of skus) {
        await storage.upsertProductLocationBySku(sku, name, status);
      }
      
      console.log(`Webhook: Created/updated ${skus.length} SKUs from product create`);
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Product create webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  app.post("/api/shopify/webhooks/products/update", async (req: Request, res: Response) => {
    try {
      const { verified, shopDomain } = await verifyChannelWebhook(req);

      if (!verified) {
        console.error(`Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}`);
        return res.status(401).json({ error: "Invalid signature" });
      }

      // Respond immediately to prevent webhook timeout and memory pileup
      res.status(200).json({ received: true });
      
      // Process in background (fire-and-forget)
      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      
      // Process SKUs with a small delay to avoid DB connection storms
      setImmediate(async () => {
        try {
          for (const { sku, name, status } of skus) {
            await storage.upsertProductLocationBySku(sku, name, status);
          }
          console.log(`Webhook: Updated ${skus.length} SKUs from product update`);
        } catch (err) {
          console.error("Background product update failed:", err);
        }
      });
    } catch (error) {
      console.error("Product update webhook error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Webhook processing failed" });
      }
    }
  });

  app.post("/api/shopify/webhooks/products/delete", async (req: Request, res: Response) => {
    try {
      const { verified, shopDomain } = await verifyChannelWebhook(req);

      if (!verified) {
        console.error(`Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}`);
        return res.status(401).json({ error: "Invalid signature" });
      }

      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      const skuList = skus.map(s => s.sku);
      
      const deleted = await storage.deleteProductLocationsBySku(skuList);
      console.log(`Webhook: Deleted ${deleted} SKUs from product delete`);
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Product delete webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ===== FULFILLMENT WEBHOOKS =====
  
  // Process fulfillment line items and update fulfilled quantities
  // Returns true if all items in the order are now fully fulfilled
  async function processFulfillmentLineItems(
    shopifyOrderId: string, 
    lineItems: Array<{ id: number; quantity: number }>,
    source: string
  ): Promise<boolean> {
    const order = await storage.getOrderByShopifyId(shopifyOrderId);
    if (!order) {
      console.log(`Fulfillment ${source}: No order found for Shopify ID ${shopifyOrderId}`);
      return false;
    }
    
    if (order.warehouseStatus === "shipped" || order.warehouseStatus === "cancelled") {
      console.log(`Fulfillment ${source}: Order ${order.orderNumber} already ${order.warehouseStatus}, skipping`);
      return false;
    }
    
    // Update fulfilled quantity for each line item in this fulfillment
    let itemsUpdated = 0;
    for (const lineItem of lineItems) {
      const shopifyLineItemId = String(lineItem.id);
      const fulfilledQty = lineItem.quantity;
      
      const updated = await storage.updateItemFulfilledQuantity(shopifyLineItemId, fulfilledQty);
      if (updated) {
        itemsUpdated++;
        console.log(`Fulfillment ${source}: Updated line item ${shopifyLineItemId} +${fulfilledQty} fulfilled (now ${updated.fulfilledQuantity}/${updated.quantity})`);
      }
    }
    
    console.log(`Fulfillment ${source}: Updated ${itemsUpdated} line items for order ${order.orderNumber}`);
    
    // Check if ALL items we track are now fully fulfilled
    const allFulfilled = await storage.areAllItemsFulfilled(order.id);
    
    if (allFulfilled) {
      await storage.updateOrderStatus(order.id, "shipped");
      console.log(`Fulfillment ${source}: Order ${order.orderNumber} marked as SHIPPED (all physical items fulfilled)`);
      broadcastOrdersUpdated();
      return true;
    } else {
      console.log(`Fulfillment ${source}: Order ${order.orderNumber} not yet fully fulfilled, waiting for more shipments`);
      return false;
    }
  }
  
  // Helper to check order fulfillment status from Shopify (used by sync, not webhooks)
  async function checkOrderFulfillmentFromShopify(shopifyOrderId: string, source: string): Promise<void> {
    const order = await storage.getOrderByShopifyId(shopifyOrderId);
    if (!order || order.warehouseStatus === "shipped" || order.warehouseStatus === "cancelled") {
      return;
    }
    
    // Fetch the order's overall fulfillment status from Shopify
    const fulfillmentStatuses = await fetchOrdersFulfillmentStatus([shopifyOrderId]);
    const orderStatus = fulfillmentStatuses.find(s => s.shopifyOrderId === shopifyOrderId);
    
    if (orderStatus?.cancelledAt) {
      await storage.updateOrderStatus(order.id, "cancelled");
      console.log(`Order ${order.orderNumber} marked as cancelled via ${source}`);
      broadcastOrdersUpdated();
    }
    // Note: We no longer auto-ship based on Shopify's overall status
    // Instead, we track individual line item fulfillments
  }

  // Fulfillment created - track line items and check if all fulfilled
  app.post("/api/shopify/webhooks/fulfillments/create", async (req: Request, res: Response) => {
    try {
      const { verified, channelId: webhookChannelId, shopDomain } = await verifyChannelWebhook(req);

      if (!verified) {
        console.error(`Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}`);
        return res.status(401).json({ error: "Invalid signature" });
      }

      const payload = req.body;
      const shopifyOrderId = String(payload.order_id);
      const fulfillmentStatus = payload.status; // pending, open, success, cancelled, error, failure
      const lineItems = payload.line_items || [];
      
      console.log(`Fulfillment create webhook: order ${shopifyOrderId}, status: ${fulfillmentStatus}, line_items: ${lineItems.length}`);
      
      // Only process successful fulfillments
      if (fulfillmentStatus === "success" && lineItems.length > 0) {
        await processFulfillmentLineItems(shopifyOrderId, lineItems, "create webhook");

        // Record shipment and release picked inventory via FulfillmentService
        // NOTE: No channel sync here — shipments are order-driven and Shopify
        // already tracks fulfillments. Syncing would double-dip.
        const { fulfillment: fulfillmentSvc } = app.locals.services;
        if (fulfillmentSvc) {
          try {
            const shipment = await fulfillmentSvc.processShopifyFulfillment({
              shopifyOrderId,
              fulfillmentId: String(payload.id),
              trackingNumber: payload.tracking_number || undefined,
              trackingUrl: payload.tracking_url || undefined,
              trackingCompany: payload.tracking_company || undefined,
              lineItems: lineItems.map((li: any) => ({
                sku: li.sku || "",
                quantity: li.quantity,
              })),
            });
            console.log(`Fulfillment create webhook: shipment ${shipment.id} recorded for order ${shopifyOrderId}`);
          } catch (fulfillErr: any) {
            console.error(`Fulfillment create webhook: shipment recording failed for order ${shopifyOrderId}:`, fulfillErr.message);
          }
        }
      }

      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Fulfillment create webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Fulfillment update - handle status changes (tracking numbers, etc.)
  // NOTE: We don't process line items here to avoid double-counting.
  // The create webhook handles initial shipment; update is just for metadata changes.
  app.post("/api/shopify/webhooks/fulfillments/update", async (req: Request, res: Response) => {
    try {
      const { verified, shopDomain } = await verifyChannelWebhook(req);

      if (!verified) {
        console.error(`Invalid webhook signature${shopDomain ? ` from ${shopDomain}` : ""}`);
        return res.status(401).json({ error: "Invalid signature" });
      }

      const payload = req.body;
      const shopifyOrderId = String(payload.order_id);
      const fulfillmentStatus = payload.status;

      console.log(`Fulfillment update webhook: order ${shopifyOrderId}, status: ${fulfillmentStatus} (metadata update only, not processing line items)`);
      
      // We don't process line items on update to avoid double-counting.
      // The create webhook already processed the shipment.
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Fulfillment update webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ===== ORDER WEBHOOKS =====
  
  // Order created - add to picking queue
  // Order create webhook - DISABLED: Orders sync from shopify_orders/shopify_order_items tables instead
  // Keeping endpoint in place for future use if needed
  app.post("/api/shopify/webhooks/orders/create", async (req: Request, res: Response) => {
    console.log("[ORDER WEBHOOK] Received orders/create webhook - DISABLED, use sync-from-raw-tables instead");
    try {
      const { verified } = await verifyChannelWebhook(req);
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      // Webhook disabled - orders come from shopify_orders table via sync-from-raw-tables
      res.status(200).json({ received: true, note: "Webhook disabled, use sync-from-raw-tables" });
    } catch (error) {
      console.error("Order create webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Order fulfilled webhook - DISABLED: Status updates sync from shopify_orders table instead
  app.post("/api/shopify/webhooks/orders/fulfilled", async (req: Request, res: Response) => {
    console.log("[ORDER WEBHOOK] Received orders/fulfilled webhook - DISABLED");
    try {
      const { verified } = await verifyChannelWebhook(req);
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      res.status(200).json({ received: true, note: "Webhook disabled" });
    } catch (error) {
      console.error("Order fulfilled webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Order cancelled webhook - DISABLED: Status updates sync from shopify_orders table instead
  app.post("/api/shopify/webhooks/orders/cancelled", async (req: Request, res: Response) => {
    console.log("[ORDER WEBHOOK] Received orders/cancelled webhook - DISABLED");
    try {
      const { verified } = await verifyChannelWebhook(req);
      if (!verified) return res.status(401).json({ error: "Invalid signature" });

      res.status(200).json({ received: true, note: "Webhook disabled" });
    } catch (error) {
      console.error("Order cancelled webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });
}
