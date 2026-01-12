import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProductLocationSchema, updateProductLocationSchema } from "@shared/schema";
import { fetchAllShopifyProducts, fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, type ShopifyOrder } from "./shopify";
import { broadcastOrdersUpdated } from "./websocket";
import type { InsertOrderItem, SafeUser } from "@shared/schema";
import Papa from "papaparse";
import bcrypt from "bcrypt";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Auth API
  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      const user = await storage.getUserByUsername(username);
      
      if (!user || !user.active) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      const validPassword = await bcrypt.compare(password, user.password);
      
      if (!validPassword) {
        return res.status(401).json({ error: "Invalid credentials" });
      }
      
      await storage.updateUserLastLogin(user.id);
      
      const safeUser: SafeUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        active: user.active,
        createdAt: user.createdAt,
        lastLoginAt: new Date(),
      };
      
      req.session.user = safeUser;
      res.json({ user: safeUser });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });
  
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
    });
  });
  
  app.get("/api/auth/me", (req, res) => {
    if (req.session.user) {
      res.json({ user: req.session.user });
    } else {
      res.status(401).json({ error: "Not authenticated" });
    }
  });
  
  // User Management API (admin only)
  app.get("/api/users", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  
  app.post("/api/users", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const { username, password, role, displayName } = req.body;
      
      if (!username || !password) {
        return res.status(400).json({ error: "Username and password required" });
      }
      
      // Check if username already exists
      const existing = await storage.getUserByUsername(username);
      if (existing) {
        return res.status(400).json({ error: "Username already exists" });
      }
      
      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);
      
      const user = await storage.createUser({
        username,
        password: hashedPassword,
        role: role || "picker",
        displayName: displayName || username,
      });
      
      // Return safe user (without password)
      const safeUser: SafeUser = {
        id: user.id,
        username: user.username,
        role: user.role,
        displayName: user.displayName,
        active: user.active,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      };
      
      res.status(201).json(safeUser);
    } catch (error) {
      console.error("Error creating user:", error);
      res.status(500).json({ error: "Failed to create user" });
    }
  });
  
  // Product Locations API
  
  // Get all locations
  app.get("/api/locations", async (req, res) => {
    try {
      const locations = await storage.getAllProductLocations();
      res.json(locations);
    } catch (error) {
      console.error("Error fetching locations:", error);
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  });

  // Get location by ID
  app.get("/api/locations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const location = await storage.getProductLocationById(id);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error) {
      console.error("Error fetching location:", error);
      res.status(500).json({ error: "Failed to fetch location" });
    }
  });

  // Get location by SKU
  app.get("/api/locations/sku/:sku", async (req, res) => {
    try {
      const sku = req.params.sku;
      const location = await storage.getProductLocationBySku(sku);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error) {
      console.error("Error fetching location by SKU:", error);
      res.status(500).json({ error: "Failed to fetch location" });
    }
  });

  // Create location
  app.post("/api/locations", async (req, res) => {
    try {
      const parsed = insertProductLocationSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      
      const location = await storage.createProductLocation(parsed.data);
      res.status(201).json(location);
    } catch (error: any) {
      console.error("Error creating location:", error);
      if (error.code === "23505") { // Unique constraint violation
        return res.status(409).json({ error: "SKU already exists" });
      }
      res.status(500).json({ error: "Failed to create location" });
    }
  });

  // Update location
  app.patch("/api/locations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = updateProductLocationSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      
      const location = await storage.updateProductLocation(id, parsed.data);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error: any) {
      console.error("Error updating location:", error);
      if (error.code === "23505") {
        return res.status(409).json({ error: "SKU already exists" });
      }
      res.status(500).json({ error: "Failed to update location" });
    }
  });

  // Delete location
  app.delete("/api/locations/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteProductLocation(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting location:", error);
      res.status(500).json({ error: "Failed to delete location" });
    }
  });

  // CSV Export - Download all locations as CSV using papaparse
  app.get("/api/locations/export/csv", async (req, res) => {
    try {
      const locations = await storage.getAllProductLocations();
      
      // Use papaparse for proper CSV generation with escaping
      const data = locations.map(loc => ({
        sku: loc.sku,
        name: loc.name,
        location: loc.location,
        zone: loc.zone,
        status: loc.status
      }));
      
      const csv = Papa.unparse(data, {
        header: true,
        quotes: true
      });
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=product_locations.csv");
      res.send(csv);
    } catch (error) {
      console.error("Error exporting locations:", error);
      res.status(500).json({ error: "Failed to export locations" });
    }
  });

  // CSV Import - Bulk update locations from CSV using papaparse
  app.post("/api/locations/import/csv", async (req, res) => {
    try {
      const { csvData } = req.body;
      
      if (!csvData || typeof csvData !== "string") {
        return res.status(400).json({ error: "CSV data is required" });
      }
      
      // Use papaparse for robust CSV parsing
      const parsed = Papa.parse<Record<string, string>>(csvData, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header: string) => header.toLowerCase().trim()
      });
      
      if (parsed.errors.length > 0) {
        return res.status(400).json({ 
          error: "CSV parsing failed", 
          details: parsed.errors.slice(0, 5).map(e => e.message)
        });
      }
      
      const rows = parsed.data;
      
      if (rows.length === 0) {
        return res.status(400).json({ error: "CSV must have at least one data row" });
      }
      
      // Check required columns
      const firstRow = rows[0];
      if (!('sku' in firstRow) || !('location' in firstRow)) {
        return res.status(400).json({ error: "CSV must have 'sku' and 'location' columns" });
      }
      
      let updated = 0;
      let notFound = 0;
      const errors: string[] = [];
      
      // Process each row
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const sku = row.sku?.toUpperCase()?.trim();
        const location = row.location?.toUpperCase()?.trim();
        const zone = row.zone?.toUpperCase()?.trim() || location?.split("-")[0] || "U";
        
        if (!sku || !location) {
          errors.push(`Row ${i + 2}: Missing SKU or location`);
          continue;
        }
        
        // Find and update
        const existing = await storage.getProductLocationBySku(sku);
        if (existing) {
          await storage.updateProductLocation(existing.id, { location, zone });
          updated++;
        } else {
          notFound++;
          errors.push(`Row ${i + 2}: SKU "${sku}" not found`);
        }
      }
      
      res.json({
        success: true,
        updated,
        notFound,
        errors: errors.slice(0, 10),
        totalErrors: errors.length
      });
    } catch (error) {
      console.error("Error importing locations:", error);
      res.status(500).json({ error: "Failed to import locations" });
    }
  });

  // ===== PICKING QUEUE API =====
  
  // Get orders for picking queue (ready or in_progress, excluding held orders for pickers)
  app.get("/api/picking/queue", async (req, res) => {
    try {
      const orders = await storage.getOrdersWithItems(["ready", "in_progress"]);
      // Filter out held orders unless user is admin/lead
      const user = req.session.user;
      const isAdminOrLead = user && (user.role === "admin" || user.role === "lead");
      const filteredOrders = isAdminOrLead 
        ? orders 
        : orders.filter(order => order.onHold === 0);
      res.json(filteredOrders);
    } catch (error) {
      console.error("Error fetching picking queue:", error);
      res.status(500).json({ error: "Failed to fetch picking queue" });
    }
  });

  // Get a specific order with items
  app.get("/api/picking/orders/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      const items = await storage.getOrderItems(id);
      res.json({ ...order, items });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  // Claim an order for picking
  app.post("/api/picking/orders/:id/claim", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { pickerId } = req.body;
      
      if (!pickerId) {
        return res.status(400).json({ error: "pickerId is required" });
      }
      
      const order = await storage.claimOrder(id, pickerId);
      
      if (!order) {
        return res.status(409).json({ error: "Order is no longer available" });
      }
      
      const items = await storage.getOrderItems(id);
      res.json({ ...order, items });
    } catch (error) {
      console.error("Error claiming order:", error);
      res.status(500).json({ error: "Failed to claim order" });
    }
  });

  // Release an order (unclaim)
  app.post("/api/picking/orders/:id/release", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { resetProgress = true } = req.body || {};
      const order = await storage.releaseOrder(id, resetProgress);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      res.json(order);
    } catch (error) {
      console.error("Error releasing order:", error);
      res.status(500).json({ error: "Failed to release order" });
    }
  });

  // Update item picked status
  app.patch("/api/picking/items/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { status, pickedQuantity, shortReason } = req.body;
      
      const item = await storage.updateOrderItemStatus(id, status, pickedQuantity, shortReason);
      
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      // Update order progress
      await storage.updateOrderProgress(item.orderId);
      
      res.json(item);
    } catch (error) {
      console.error("Error updating item:", error);
      res.status(500).json({ error: "Failed to update item" });
    }
  });

  // Mark order as ready to ship
  app.post("/api/picking/orders/:id/ready-to-ship", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.updateOrderStatus(id, "ready_to_ship");
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      res.json(order);
    } catch (error) {
      console.error("Error updating order:", error);
      res.status(500).json({ error: "Failed to update order" });
    }
  });

  // Get all orders (for orders management page)
  app.get("/api/orders", async (req, res) => {
    try {
      const orders = await storage.getOrdersWithItems();
      res.json(orders);
    } catch (error) {
      console.error("Error fetching orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Hold an order (admin/lead only)
  app.post("/api/orders/:id/hold", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const order = await storage.holdOrder(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      res.json(order);
    } catch (error) {
      console.error("Error holding order:", error);
      res.status(500).json({ error: "Failed to hold order" });
    }
  });

  // Release hold on an order (admin/lead only)
  app.post("/api/orders/:id/release-hold", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const order = await storage.releaseHoldOrder(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      res.json(order);
    } catch (error) {
      console.error("Error releasing hold:", error);
      res.status(500).json({ error: "Failed to release hold" });
    }
  });

  // Shopify Sync API
  app.post("/api/shopify/sync", async (req, res) => {
    try {
      console.log("Starting Shopify SKU sync...");
      
      const shopifyProducts = await fetchAllShopifyProducts();
      console.log(`Fetched ${shopifyProducts.length} SKUs from Shopify`);
      
      let created = 0;
      let updated = 0;
      
      for (const product of shopifyProducts) {
        const existing = await storage.getProductLocationBySku(product.sku);
        await storage.upsertProductLocationBySku(product.sku, product.name, product.status, product.imageUrl, product.barcode);
        if (existing) {
          updated++;
        } else {
          created++;
        }
      }
      
      const validSkus = shopifyProducts.map(p => p.sku);
      const deleted = await storage.deleteOrphanedSkus(validSkus);
      
      console.log(`Sync complete: ${created} created, ${updated} updated, ${deleted} deleted`);
      
      res.json({
        success: true,
        created,
        updated,
        deleted,
        total: shopifyProducts.length,
      });
    } catch (error: any) {
      console.error("Shopify sync error:", error);
      res.status(500).json({ 
        error: "Failed to sync with Shopify",
        message: error.message 
      });
    }
  });

  // Shopify Orders Sync - fetch all unfulfilled orders
  app.post("/api/shopify/sync-orders", async (req, res) => {
    try {
      console.log("Starting Shopify orders sync...");
      
      const shopifyOrders = await fetchUnfulfilledOrders();
      console.log(`Fetched ${shopifyOrders.length} unfulfilled orders from Shopify`);
      
      let created = 0;
      let updated = 0;
      let skipped = 0;
      
      for (const orderData of shopifyOrders) {
        // Skip orders with no shippable items (e.g., digital memberships)
        if (orderData.items.length === 0) {
          skipped++;
          continue;
        }
        
        // Check if order already exists
        const existingOrder = await storage.getOrderByShopifyId(orderData.shopifyOrderId);
        
        if (existingOrder) {
          // Skip orders that are already being processed or completed
          if (existingOrder.status !== "ready") {
            skipped++;
            continue;
          }
          updated++;
        } else {
          created++;
        }
        
        // Enrich items with location and image data from product_locations
        const enrichedItems: InsertOrderItem[] = [];
        for (const item of orderData.items) {
          const productLocation = await storage.getProductLocationBySku(item.sku);
          enrichedItems.push({
            orderId: 0, // Will be set by createOrder
            shopifyLineItemId: item.shopifyLineItemId,
            sku: item.sku,
            name: item.name,
            quantity: item.quantity,
            pickedQuantity: 0,
            status: "pending",
            location: productLocation?.location || "UNASSIGNED",
            imageUrl: productLocation?.imageUrl || null,
            zone: productLocation?.zone || "U",
            barcode: productLocation?.barcode || null,
          });
        }
        
        // Create or update order
        await storage.createOrderWithItems({
          shopifyOrderId: orderData.shopifyOrderId,
          orderNumber: orderData.orderNumber,
          customerName: orderData.customerName,
          customerEmail: orderData.customerEmail,
          priority: orderData.priority,
          status: "ready",
        }, enrichedItems);
      }
      
      console.log(`Orders sync complete: ${created} created, ${updated} updated, ${skipped} skipped (in progress)`);
      
      // Now sync fulfillment status for all non-shipped orders in our system
      const fulfillmentResult = await syncFulfillmentStatus();
      
      res.json({
        success: true,
        created,
        updated,
        skipped,
        total: shopifyOrders.length,
        fulfillmentSync: fulfillmentResult,
      });
    } catch (error: any) {
      console.error("Shopify orders sync error:", error);
      res.status(500).json({ 
        error: "Failed to sync orders from Shopify",
        message: error.message 
      });
    }
  });

  // Helper function to sync fulfillment status for all non-terminal orders
  async function syncFulfillmentStatus(): Promise<{ shipped: number; cancelled: number; checked: number }> {
    // Get ALL orders that might need status updates - include everything except already shipped/cancelled
    // This covers ready, in_progress, completed, ready_to_ship, and any on-hold orders
    const allOrders = await storage.getOrdersWithItems();
    
    console.log(`Fulfillment sync: Found ${allOrders.length} total orders in database`);
    
    // Filter to non-terminal orders that have Shopify IDs
    const activeOrders = allOrders.filter(o => 
      o.status !== "shipped" && 
      o.status !== "cancelled" && 
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
      
      // If fulfilled in Shopify, mark as shipped in our system
      if (status.fulfillmentStatus === "fulfilled") {
        await storage.updateOrderStatus(order.id, "shipped");
        shipped++;
        console.log(`Order ${order.orderNumber} marked as shipped (fulfilled in Shopify)`);
      }
      // If cancelled in Shopify, mark as cancelled
      else if (status.cancelledAt) {
        await storage.updateOrderStatus(order.id, "cancelled");
        cancelled++;
        console.log(`Order ${order.orderNumber} marked as cancelled`);
      }
    }
    
    if (shipped > 0 || cancelled > 0) {
      broadcastOrdersUpdated();
    }
    
    return { shipped, cancelled, checked: shopifyOrderIds.length };
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

  // Shopify Webhooks - raw body captured by express.json verify callback
  app.post("/api/shopify/webhooks/products/create", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
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
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body;
      const skus = extractSkusFromWebhookPayload(payload);
      
      for (const { sku, name, status } of skus) {
        await storage.upsertProductLocationBySku(sku, name, status);
      }
      
      console.log(`Webhook: Updated ${skus.length} SKUs from product update`);
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Product update webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  app.post("/api/shopify/webhooks/products/delete", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
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
  
  // Helper to check order fulfillment and update status
  async function checkAndUpdateOrderFulfillment(shopifyOrderId: string, source: string): Promise<void> {
    const order = await storage.getOrderByShopifyId(shopifyOrderId);
    if (!order || order.status === "shipped" || order.status === "cancelled") {
      return;
    }
    
    // Fetch the order's overall fulfillment status from Shopify
    const fulfillmentStatuses = await fetchOrdersFulfillmentStatus([shopifyOrderId]);
    const orderStatus = fulfillmentStatuses.find(s => s.shopifyOrderId === shopifyOrderId);
    
    if (orderStatus?.fulfillmentStatus === "fulfilled") {
      await storage.updateOrderStatus(order.id, "shipped");
      console.log(`Order ${order.orderNumber} marked as shipped via ${source} (fully fulfilled in Shopify)`);
      broadcastOrdersUpdated();
    } else if (orderStatus?.cancelledAt) {
      await storage.updateOrderStatus(order.id, "cancelled");
      console.log(`Order ${order.orderNumber} marked as cancelled via ${source}`);
      broadcastOrdersUpdated();
    }
  }

  // Fulfillment created - check if order is fully fulfilled before marking shipped
  app.post("/api/shopify/webhooks/fulfillments/create", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body;
      const shopifyOrderId = String(payload.order_id);
      const fulfillmentStatus = payload.status; // pending, open, success, cancelled, error, failure
      
      console.log(`Fulfillment webhook: order ${shopifyOrderId}, status: ${fulfillmentStatus}`);
      
      // Only check fulfillment if this specific fulfillment was successful
      if (fulfillmentStatus === "success") {
        await checkAndUpdateOrderFulfillment(shopifyOrderId, "fulfillment create webhook");
      }
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Fulfillment create webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Fulfillment update - handle status changes
  app.post("/api/shopify/webhooks/fulfillments/update", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body;
      const shopifyOrderId = String(payload.order_id);
      const fulfillmentStatus = payload.status;
      
      console.log(`Fulfillment update webhook: order ${shopifyOrderId}, status: ${fulfillmentStatus}`);
      
      // Check overall order fulfillment status
      if (fulfillmentStatus === "success") {
        await checkAndUpdateOrderFulfillment(shopifyOrderId, "fulfillment update webhook");
      }
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Fulfillment update webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ===== ORDER WEBHOOKS =====
  
  // Order created - add to picking queue
  app.post("/api/shopify/webhooks/orders/create", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body as ShopifyOrder;
      
      // Skip if order already exists
      const existing = await storage.getOrderByShopifyId(String(payload.id));
      if (existing) {
        console.log(`Order ${payload.id} already exists, skipping`);
        return res.status(200).json({ received: true });
      }
      
      // Extract order data
      const orderData = extractOrderFromWebhookPayload(payload);
      
      // Skip if no items with SKUs
      if (orderData.items.length === 0) {
        console.log(`Order ${orderData.orderNumber} has no items with SKUs, skipping`);
        return res.status(200).json({ received: true });
      }
      
      // Enrich items with location data from product_locations
      const enrichedItems: InsertOrderItem[] = [];
      for (const item of orderData.items) {
        const productLocation = await storage.getProductLocationBySku(item.sku);
        enrichedItems.push({
          orderId: 0, // Will be set by createOrderWithItems
          shopifyLineItemId: item.shopifyLineItemId,
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          pickedQuantity: 0,
          status: "pending",
          location: productLocation?.location || "UNASSIGNED",
          zone: productLocation?.zone || "U",
          imageUrl: item.imageUrl,
          barcode: productLocation?.barcode || null,
        });
      }
      
      // Create order
      await storage.createOrderWithItems({
        shopifyOrderId: orderData.shopifyOrderId,
        orderNumber: orderData.orderNumber,
        customerName: orderData.customerName,
        customerEmail: orderData.customerEmail,
        priority: orderData.priority,
        status: "ready",
      }, enrichedItems);
      
      console.log(`Webhook: Created order ${orderData.orderNumber} with ${enrichedItems.length} items`);
      
      broadcastOrdersUpdated();
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Order create webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Order fulfilled - mark as shipped
  app.post("/api/shopify/webhooks/orders/fulfilled", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body as ShopifyOrder;
      const order = await storage.getOrderByShopifyId(String(payload.id));
      
      if (order) {
        await storage.updateOrderStatus(order.id, "shipped");
        console.log(`Webhook: Order ${order.orderNumber} marked as shipped`);
      }
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Order fulfilled webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // Order cancelled - mark as cancelled
  app.post("/api/shopify/webhooks/orders/cancelled", async (req: Request, res: Response) => {
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        console.error("Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      const payload = req.body as ShopifyOrder;
      const order = await storage.getOrderByShopifyId(String(payload.id));
      
      if (order) {
        await storage.updateOrderStatus(order.id, "cancelled");
        console.log(`Webhook: Order ${order.orderNumber} marked as cancelled`);
      }
      
      res.status(200).json({ received: true });
    } catch (error) {
      console.error("Order cancelled webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  return httpServer;
}
