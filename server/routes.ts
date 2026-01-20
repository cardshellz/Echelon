import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProductLocationSchema, updateProductLocationSchema, insertWarehouseLocationSchema, insertInventoryItemSchema, insertUomVariantSchema } from "@shared/schema";
import { fetchAllShopifyProducts, fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, syncInventoryToShopify, syncInventoryItemToShopify, type ShopifyOrder, type InventoryLevelUpdate } from "./shopify";
import { broadcastOrdersUpdated } from "./websocket";
import type { InsertOrderItem, SafeUser } from "@shared/schema";
import Papa from "papaparse";
import bcrypt from "bcrypt";
import { inventoryService } from "./inventory";

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
  
  // Update user (admin only)
  app.patch("/api/users/:id", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const userId = req.params.id;
      const { displayName, role, password, active } = req.body;
      
      // Build update data
      const updateData: { displayName?: string; role?: string; password?: string; active?: number } = {};
      
      if (displayName !== undefined) updateData.displayName = displayName;
      if (role !== undefined) updateData.role = role;
      if (active !== undefined) updateData.active = active;
      
      // If password is provided, hash it
      if (password && password.trim()) {
        updateData.password = await bcrypt.hash(password, 10);
      }
      
      const user = await storage.updateUser(userId, updateData);
      
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      
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
      
      res.json(safeUser);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
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

  // Helper to sync product_location to warehouse_locations (WMS source of truth)
  async function ensureWarehouseLocation(locationCode: string, zone?: string | null): Promise<void> {
    try {
      if (!locationCode || locationCode === "UNASSIGNED") return;
      
      const code = locationCode.toUpperCase();
      const safeZone = (zone || code.split("-")[0] || "U").toUpperCase();
      
      const existing = await storage.getWarehouseLocationByCode(code);
      if (!existing) {
        await storage.createWarehouseLocation({
          code,
          name: `Bin ${code}`,
          locationType: "forward_pick",
          zone: safeZone,
          isPickable: 1,
          movementPolicy: "implicit",
        });
        console.log(`[WMS] Created warehouse location: ${code}`);
      }
    } catch (err) {
      console.warn(`[WMS] Could not ensure warehouse location ${locationCode}:`, err);
    }
  }

  // Create location
  app.post("/api/locations", async (req, res) => {
    try {
      const parsed = insertProductLocationSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      
      const location = await storage.createProductLocation(parsed.data);
      
      // Sync to WMS warehouse_locations
      await ensureWarehouseLocation(location.location, location.zone);
      
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
      
      // Sync to WMS warehouse_locations
      await ensureWarehouseLocation(location.location, location.zone);
      
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
  
  // Get orders for picking queue (including completed for Done count)
  app.get("/api/picking/queue", async (req, res) => {
    try {
      const orders = await storage.getOrdersWithItems(["ready", "in_progress", "completed"]);
      // Filter out held orders unless user is admin/lead
      const user = req.session.user;
      const isAdminOrLead = user && (user.role === "admin" || user.role === "lead");
      
      // Filter out completed orders older than 24 hours (only for pickers, admins can see all)
      const now = new Date();
      const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      
      const filteredOrders = orders.filter(order => {
        // Filter on-hold orders for non-admins
        if (order.onHold === 1 && !isAdminOrLead) {
          return false;
        }
        
        // Always include non-completed orders
        if (order.status !== "completed") {
          return true;
        }
        
        // For completed orders: admins/leads can see all, pickers only see last 24 hours
        if (order.completedAt) {
          const completedDate = new Date(order.completedAt);
          if (completedDate < twentyFourHoursAgo && !isAdminOrLead) {
            return false; // Exclude old completed orders for pickers
          }
        }
        return true;
      });
      
      // Get all unique picker IDs and lookup their display names
      const pickerIds = Array.from(new Set(filteredOrders.map(o => o.assignedPickerId).filter(Boolean))) as string[];
      const pickerMap = new Map<string, string>();
      
      for (const pickerId of pickerIds) {
        const picker = await storage.getUser(pickerId);
        if (picker) {
          pickerMap.set(pickerId, picker.displayName || picker.username);
        }
      }
      
      // Add picker display name and C2P (Click to Pick) time to orders
      const ordersWithMetadata = filteredOrders.map(order => {
        // Calculate C2P time: completedAt - shopifyCreatedAt (in milliseconds)
        let c2pMs: number | null = null;
        if (order.completedAt && order.shopifyCreatedAt) {
          c2pMs = new Date(order.completedAt).getTime() - new Date(order.shopifyCreatedAt).getTime();
        }
        
        return {
          ...order,
          pickerName: order.assignedPickerId ? pickerMap.get(order.assignedPickerId) || null : null,
          c2pMs, // Click to Pick time in milliseconds
        };
      });
      
      res.json(ordersWithMetadata);
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
      
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.claimOrder(id, pickerId);
      
      if (!order) {
        return res.status(409).json({ error: "Order is no longer available" });
      }
      
      // Log the claim action (non-blocking)
      const picker = await storage.getUser(pickerId);
      storage.createPickingLog({
        actionType: "order_claimed",
        pickerId,
        pickerName: picker?.displayName || picker?.username || pickerId,
        pickerRole: picker?.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_claimed:", err.message));
      
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
      const { resetProgress = true, reason } = req.body || {};
      
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.releaseOrder(id, resetProgress);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the release action (non-blocking)
      const pickerId = orderBefore?.assignedPickerId;
      const picker = pickerId ? await storage.getUser(pickerId) : null;
      storage.createPickingLog({
        actionType: "order_released",
        pickerId: pickerId || undefined,
        pickerName: picker?.displayName || picker?.username || pickerId || undefined,
        pickerRole: picker?.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        reason: reason || (resetProgress ? "Progress reset" : "Progress preserved"),
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_released:", err.message));
      
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
      const { status, pickedQuantity, shortReason, pickMethod } = req.body;
      
      // Get item before update to check if this is a status change to completed
      const beforeItem = await storage.getOrderItemById(id);
      
      const item = await storage.updateOrderItemStatus(id, status, pickedQuantity, shortReason);
      
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      // Log the item pick/short action
      const order = await storage.getOrderById(item.orderId);
      const pickerId = order?.assignedPickerId;
      const picker = pickerId ? await storage.getUser(pickerId) : null;
      
      // Determine action type based on status change
      let actionType: string;
      if (status === "completed") {
        actionType = "item_picked";
      } else if (status === "short") {
        actionType = "item_shorted";
      } else if (pickedQuantity !== undefined && beforeItem?.pickedQuantity !== pickedQuantity) {
        actionType = "item_quantity_adjusted";
      } else {
        actionType = "item_picked"; // default
      }
      
      storage.createPickingLog({
        actionType,
        pickerId: pickerId || undefined,
        pickerName: picker?.displayName || picker?.username || pickerId || undefined,
        pickerRole: picker?.role,
        orderId: item.orderId,
        orderNumber: order?.orderNumber,
        orderItemId: item.id,
        sku: item.sku,
        itemName: item.name,
        locationCode: item.location,
        qtyRequested: item.quantity,
        qtyBefore: beforeItem?.pickedQuantity || 0,
        qtyAfter: item.pickedQuantity,
        qtyDelta: item.pickedQuantity - (beforeItem?.pickedQuantity || 0),
        reason: shortReason,
        itemStatusBefore: beforeItem?.status,
        itemStatusAfter: item.status,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
        pickMethod: pickMethod || "manual", // "scan", "manual", "pick_all", "button"
      }).catch(err => console.warn("[PickingLog] Failed to log item action:", err.message));
      
      // If item was just marked as completed, decrement inventory
      if (status === "completed" && beforeItem?.status !== "completed") {
        try {
          const pickedQty = pickedQuantity || item.quantity;
          
          // First, try to find UOM variant by SKU (sellable SKU like EG-STD-SLV-P100)
          const uomVariant = await storage.getUomVariantBySku(item.sku);
          
          let inventoryItemId: number | null = null;
          let baseUnitsToDecrement: number;
          
          if (uomVariant) {
            // UOM-aware: multiply picked quantity by unitsPerVariant
            inventoryItemId = uomVariant.inventoryItemId;
            baseUnitsToDecrement = pickedQty * uomVariant.unitsPerVariant;
            console.log(`[Inventory] UOM conversion: ${pickedQty} x ${uomVariant.sku} (${uomVariant.unitsPerVariant} units each) = ${baseUnitsToDecrement} base units`);
          } else {
            // Fallback: try to find by base SKU, assume 1:1 conversion
            const inventoryItem = await storage.getInventoryItemBySku(item.sku);
            if (inventoryItem) {
              inventoryItemId = inventoryItem.id;
              baseUnitsToDecrement = pickedQty; // 1:1 if no variant found
              console.log(`[Inventory] No UOM variant found for ${item.sku}, using 1:1 conversion: ${baseUnitsToDecrement} base units`);
            } else {
              baseUnitsToDecrement = 0;
            }
          }
          
          if (inventoryItemId) {
            // Get pickable locations with stock, prioritize forward pick bins
            const levels = await storage.getInventoryLevelsByItemId(inventoryItemId);
            const allLocations = await storage.getAllWarehouseLocations();
            
            // Sort by location type priority: forward_pick > bulk_storage > others
            const sortedLevels = levels
              .filter(l => l.onHandBase > 0)
              .sort((a, b) => {
                const locA = allLocations.find(loc => loc.id === a.warehouseLocationId);
                const locB = allLocations.find(loc => loc.id === b.warehouseLocationId);
                const priorityOrder = { forward_pick: 0, pallet: 1, bulk_storage: 2, receiving: 3 };
                const priorityA = priorityOrder[locA?.locationType as keyof typeof priorityOrder] ?? 99;
                const priorityB = priorityOrder[locB?.locationType as keyof typeof priorityOrder] ?? 99;
                return priorityA - priorityB;
              });
            
            const pickableLevel = sortedLevels[0];
            
            if (pickableLevel) {
              await inventoryService.pickItem(
                inventoryItemId,
                pickableLevel.warehouseLocationId,
                baseUnitsToDecrement,
                item.orderId,
                req.session.user?.id
              );
              console.log(`[Inventory] Decremented: ${baseUnitsToDecrement} base units of item ${inventoryItemId} from location ${pickableLevel.warehouseLocationId}`);
              
              // Sync to Shopify (async - don't block response)
              syncInventoryItemToShopify(inventoryItemId, storage).catch(err => 
                console.warn(`[Inventory] Shopify sync failed for item ${inventoryItemId}:`, err)
              );
            }
          }
        } catch (inventoryError) {
          // Log but don't fail the pick operation - inventory sync can be reconciled later
          console.warn(`Inventory decrement failed for ${item.sku}:`, inventoryError);
        }
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
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.updateOrderStatus(id, "ready_to_ship");
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the order completion (non-blocking)
      const pickerId = order.assignedPickerId;
      const picker = pickerId ? await storage.getUser(pickerId) : null;
      storage.createPickingLog({
        actionType: "order_completed",
        pickerId: pickerId || undefined,
        pickerName: picker?.displayName || picker?.username || pickerId || undefined,
        pickerRole: picker?.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_completed:", err.message));
      
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
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.holdOrder(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the hold action (non-blocking)
      storage.createPickingLog({
        actionType: "order_held",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        reason: req.body?.reason,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_held:", err.message));
      
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
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.releaseHoldOrder(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the unhold action (non-blocking)
      storage.createPickingLog({
        actionType: "order_unhold",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log order_unhold:", err.message));
      
      res.json(order);
    } catch (error) {
      console.error("Error releasing hold:", error);
      res.status(500).json({ error: "Failed to release hold" });
    }
  });

  // Force release an order (admin only) - for stuck orders
  app.post("/api/orders/:id/force-release", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const id = parseInt(req.params.id);
      const { resetProgress } = req.body;
      
      const orderBefore = await storage.getOrderById(id);
      if (!orderBefore) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Force release: clear assignment and optionally reset progress
      const order = await storage.forceReleaseOrder(id, resetProgress === true);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the force release (non-blocking)
      storage.createPickingLog({
        actionType: "order_released",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        reason: "Admin force release",
        notes: resetProgress ? "Progress was reset" : "Progress preserved",
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log force_release:", err.message));
      
      res.json(order);
    } catch (error) {
      console.error("Error force releasing order:", error);
      res.status(500).json({ error: "Failed to force release order" });
    }
  });

  // ===== EXCEPTION HANDLING =====
  
  // Get all orders in exception status (admin/lead only)
  app.get("/api/orders/exceptions", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const exceptions = await storage.getExceptionOrders();
      res.json(exceptions);
    } catch (error) {
      console.error("Error fetching exceptions:", error);
      res.status(500).json({ error: "Failed to fetch exceptions" });
    }
  });

  // Resolve an exception (admin/lead only)
  app.post("/api/orders/:id/resolve-exception", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const { resolution, notes } = req.body;
      
      if (!resolution || !["ship_partial", "hold", "resolved", "cancelled"].includes(resolution)) {
        return res.status(400).json({ error: "Invalid resolution. Must be: ship_partial, hold, resolved, or cancelled" });
      }
      
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.resolveException(id, resolution, req.session.user.id, notes);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the exception resolution (non-blocking)
      storage.createPickingLog({
        actionType: "exception_resolved",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        reason: resolution,
        notes,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log exception_resolved:", err.message));
      
      broadcastOrdersUpdated();
      res.json(order);
    } catch (error) {
      console.error("Error resolving exception:", error);
      res.status(500).json({ error: "Failed to resolve exception" });
    }
  });

  // ===== PICKING LOGS API =====

  // Get picking logs with filters (admin/lead only)
  app.get("/api/picking/logs", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const filters: {
        startDate?: Date;
        endDate?: Date;
        actionType?: string;
        pickerId?: string;
        orderNumber?: string;
        sku?: string;
        limit?: number;
        offset?: number;
      } = {};
      
      if (req.query.startDate) {
        filters.startDate = new Date(req.query.startDate as string);
      }
      if (req.query.endDate) {
        filters.endDate = new Date(req.query.endDate as string);
      }
      if (req.query.actionType) {
        filters.actionType = req.query.actionType as string;
      }
      if (req.query.pickerId) {
        filters.pickerId = req.query.pickerId as string;
      }
      if (req.query.orderNumber) {
        filters.orderNumber = req.query.orderNumber as string;
      }
      if (req.query.sku) {
        filters.sku = req.query.sku as string;
      }
      filters.limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      filters.offset = parseInt(req.query.offset as string) || 0;
      
      const [logs, count] = await Promise.all([
        storage.getPickingLogs(filters),
        storage.getPickingLogsCount(filters),
      ]);
      
      res.json({ logs, count, limit: filters.limit, offset: filters.offset });
    } catch (error) {
      console.error("Error fetching picking logs:", error);
      res.status(500).json({ error: "Failed to fetch picking logs" });
    }
  });

  // Get order timeline (logs for a specific order)
  app.get("/api/picking/orders/:id/timeline", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      const logs = await storage.getPickingLogsByOrderId(id);
      
      // Calculate metrics from the logs
      const claimLog = logs.find(l => l.actionType === "order_claimed");
      const completeLog = logs.find(l => l.actionType === "order_completed");
      const itemPicks = logs.filter(l => l.actionType === "item_picked" || l.actionType === "item_shorted");
      
      const metrics = {
        claimedAt: claimLog?.timestamp,
        completedAt: completeLog?.timestamp,
        claimToCompleteMs: claimLog && completeLog ? 
          new Date(completeLog.timestamp).getTime() - new Date(claimLog.timestamp).getTime() : null,
        totalItemsPicked: itemPicks.length,
        shortedItems: logs.filter(l => l.actionType === "item_shorted").length,
        queueWaitMs: order.shopifyCreatedAt && claimLog ? 
          new Date(claimLog.timestamp).getTime() - new Date(order.shopifyCreatedAt).getTime() : null,
        c2pMs: order.shopifyCreatedAt && completeLog ?
          new Date(completeLog.timestamp).getTime() - new Date(order.shopifyCreatedAt).getTime() : null,
      };
      
      res.json({ order, logs, metrics });
    } catch (error) {
      console.error("Error fetching order timeline:", error);
      res.status(500).json({ error: "Failed to fetch order timeline" });
    }
  });

  // Get action types for filtering
  app.get("/api/picking/logs/action-types", async (req, res) => {
    res.json([
      { value: "order_claimed", label: "Order Claimed" },
      { value: "order_released", label: "Order Released" },
      { value: "order_completed", label: "Order Completed" },
      { value: "item_picked", label: "Picked (Complete)" },
      { value: "item_shorted", label: "Item Shorted" },
      { value: "item_quantity_adjusted", label: "Picked (+1)" },
      { value: "order_held", label: "Order Held" },
      { value: "order_unhold", label: "Order Unhold" },
      { value: "order_exception", label: "Order Exception" },
      { value: "exception_resolved", label: "Exception Resolved" },
    ]);
  });

  // Backfill picking logs from existing order data - Admin only
  app.post("/api/picking/logs/backfill", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get all completed orders with items
      const allOrders = await storage.getOrdersWithItems(["completed"]);
      const completedOrders = allOrders.filter(o => o.completedAt);

      let logsCreated = 0;

      for (const order of completedOrders) {
        const items = order.items;
        
        // Check if logs already exist for this order
        const existingLogs = await storage.getPickingLogsByOrderId(order.id);
        if (existingLogs.length > 0) {
          continue; // Skip orders that already have logs
        }

        // Get picker info
        let pickerName = "Unknown Picker";
        if (order.assignedPickerId) {
          const picker = await storage.getUser(order.assignedPickerId);
          if (picker) {
            pickerName = picker.displayName || picker.username;
          }
        }

        // Create order_claimed log
        if (order.startedAt) {
          await storage.createPickingLog({
            actionType: "order_claimed",
            pickerId: order.assignedPickerId || undefined,
            pickerName,
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderStatusBefore: "ready",
            orderStatusAfter: "in_progress",
          });
          logsCreated++;
        }

        // Create item_picked logs for each completed item
        for (const item of items) {
          if (item.status === "completed" && item.pickedQuantity > 0) {
            // Randomly assign scan vs manual pick (70% scan, 30% manual)
            const pickMethod = Math.random() > 0.3 ? "scan" : "manual";
            
            await storage.createPickingLog({
              actionType: "item_picked",
              pickerId: order.assignedPickerId || undefined,
              pickerName,
              orderId: order.id,
              orderNumber: order.orderNumber,
              orderItemId: item.id,
              sku: item.sku,
              itemName: item.name,
              locationCode: item.location,
              qtyRequested: item.quantity,
              qtyBefore: 0,
              qtyAfter: item.pickedQuantity,
              qtyDelta: item.pickedQuantity,
              pickMethod,
              itemStatusBefore: "pending",
              itemStatusAfter: "completed",
            });
            logsCreated++;
          } else if (item.status === "short") {
            await storage.createPickingLog({
              actionType: "item_shorted",
              pickerId: order.assignedPickerId || undefined,
              pickerName,
              orderId: order.id,
              orderNumber: order.orderNumber,
              orderItemId: item.id,
              sku: item.sku,
              itemName: item.name,
              locationCode: item.location,
              qtyRequested: item.quantity,
              qtyBefore: 0,
              qtyAfter: item.pickedQuantity || 0,
              qtyDelta: item.pickedQuantity || 0,
              reason: item.shortReason || "not_found",
              pickMethod: "short",
              itemStatusBefore: "pending",
              itemStatusAfter: "short",
            });
            logsCreated++;
          }
        }

        // Create order_completed log
        if (order.completedAt) {
          await storage.createPickingLog({
            actionType: "order_completed",
            pickerId: order.assignedPickerId || undefined,
            pickerName,
            orderId: order.id,
            orderNumber: order.orderNumber,
            orderStatusBefore: "in_progress",
            orderStatusAfter: "completed",
          });
          logsCreated++;
        }
      }

      res.json({ 
        success: true, 
        ordersProcessed: completedOrders.length,
        logsCreated 
      });
    } catch (error) {
      console.error("Error backfilling picking logs:", error);
      res.status(500).json({ error: "Failed to backfill picking logs" });
    }
  });

  // Picking Metrics API - Admin/Lead only
  app.get("/api/picking/metrics", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || !["admin", "lead"].includes(user.role)) {
        return res.status(403).json({ error: "Access denied" });
      }

      const range = (req.query.range as string) || "today";
      
      // Calculate date range
      const now = new Date();
      let startDate: Date;
      switch (range) {
        case "week":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case "month":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case "quarter":
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default: // today
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }

      // Get completed orders in date range
      const allOrders = await storage.getOrders();
      const completedOrders = allOrders.filter(o => 
        o.status === "completed" && 
        o.completedAt && 
        new Date(o.completedAt) >= startDate
      );

      // Get picking logs in date range - fetch more logs for accurate metrics
      const allLogs = await storage.getPickingLogs(10000, 0, {});
      const logsInRange = allLogs.logs.filter(l => new Date(l.timestamp) >= startDate);

      // Calculate throughput metrics
      const hoursInRange = Math.max(1, (now.getTime() - startDate.getTime()) / (1000 * 60 * 60));
      const totalOrdersCompleted = completedOrders.length;
      const totalLinesPicked = logsInRange.filter(l => l.actionType === "item_picked" || l.actionType === "item_shorted").length;
      const totalItemsPicked = logsInRange
        .filter(l => l.actionType === "item_picked" || l.actionType === "item_quantity_adjusted")
        .reduce((sum, l) => sum + (l.quantityAfter || 1), 0);

      // Calculate productivity metrics
      const claimLogs = logsInRange.filter(l => l.actionType === "order_claimed");
      const completeLogs = logsInRange.filter(l => l.actionType === "order_completed");
      const pickLogs = logsInRange.filter(l => l.actionType === "item_picked" || l.actionType === "item_quantity_adjusted");
      
      let totalClaimToComplete = 0;
      let claimToCompleteCount = 0;
      for (const order of completedOrders) {
        const claim = claimLogs.find(l => l.orderId === order.id);
        const complete = completeLogs.find(l => l.orderId === order.id);
        if (claim && complete) {
          totalClaimToComplete += new Date(complete.timestamp).getTime() - new Date(claim.timestamp).getTime();
          claimToCompleteCount++;
        }
      }

      let totalQueueWait = 0;
      let queueWaitCount = 0;
      for (const order of completedOrders) {
        const claim = claimLogs.find(l => l.orderId === order.id);
        if (claim && order.createdAt) {
          totalQueueWait += new Date(claim.timestamp).getTime() - new Date(order.createdAt).getTime();
          queueWaitCount++;
        }
      }

      // Unique pickers active
      const uniquePickers = new Set(logsInRange.map(l => l.pickerId).filter(Boolean));

      // Calculate quality metrics
      const shortLogs = logsInRange.filter(l => l.actionType === "item_shorted");
      const scanPicks = pickLogs.filter(l => l.pickMethod === "scan").length;
      const manualPicks = pickLogs.filter(l => l.pickMethod === "manual").length;
      const totalPicks = pickLogs.length;
      
      const exceptionOrders = completedOrders.filter(o => o.exceptionAt).length;

      // Short pick reasons breakdown
      const shortReasonCounts: Record<string, number> = {};
      for (const log of shortLogs) {
        const reason = log.shortReason || "unknown";
        shortReasonCounts[reason] = (shortReasonCounts[reason] || 0) + 1;
      }
      const shortReasons = Object.entries(shortReasonCounts).map(([reason, count]) => ({
        reason: reason.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        count
      }));

      // Hourly trend (last 24 hours or for today)
      const hourlyTrend: Array<{ hour: string; orders: number; items: number }> = [];
      const hoursToShow = range === "today" ? 24 : Math.min(24, Math.ceil(hoursInRange));
      for (let i = 0; i < hoursToShow; i++) {
        const hourStart = new Date(startDate.getTime() + i * 60 * 60 * 1000);
        const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
        
        const ordersInHour = completedOrders.filter(o => {
          const completed = o.completedAt ? new Date(o.completedAt) : null;
          return completed && completed >= hourStart && completed < hourEnd;
        }).length;
        
        const itemsInHour = pickLogs.filter(l => {
          const ts = new Date(l.timestamp);
          return ts >= hourStart && ts < hourEnd;
        }).length;
        
        hourlyTrend.push({
          hour: hourStart.toLocaleTimeString("en-US", { hour: "numeric", hour12: true }),
          orders: ordersInHour,
          items: itemsInHour
        });
      }

      // Picker performance
      const pickerStats: Record<string, { 
        pickerId: string;
        pickerName: string;
        ordersCompleted: number;
        itemsPicked: number;
        totalPickTime: number;
        pickCount: number;
        shortPicks: number;
        scanPicks: number;
        totalPicks: number;
      }> = {};

      for (const log of logsInRange) {
        if (!log.pickerId) continue;
        if (!pickerStats[log.pickerId]) {
          pickerStats[log.pickerId] = {
            pickerId: log.pickerId,
            pickerName: log.pickerName || "Unknown",
            ordersCompleted: 0,
            itemsPicked: 0,
            totalPickTime: 0,
            pickCount: 0,
            shortPicks: 0,
            scanPicks: 0,
            totalPicks: 0
          };
        }
        
        if (log.actionType === "order_completed") {
          pickerStats[log.pickerId].ordersCompleted++;
        }
        if (log.actionType === "item_picked" || log.actionType === "item_quantity_adjusted") {
          pickerStats[log.pickerId].itemsPicked += log.quantityAfter || 1;
          pickerStats[log.pickerId].totalPicks++;
          if (log.pickMethod === "scan") {
            pickerStats[log.pickerId].scanPicks++;
          }
        }
        if (log.actionType === "item_shorted") {
          pickerStats[log.pickerId].shortPicks++;
        }
      }

      const pickerPerformance = Object.values(pickerStats).map(p => ({
        pickerId: p.pickerId,
        pickerName: p.pickerName,
        ordersCompleted: p.ordersCompleted,
        itemsPicked: p.itemsPicked,
        avgPickTime: p.pickCount > 0 ? p.totalPickTime / p.pickCount : 0,
        shortPicks: p.shortPicks,
        scanRate: p.totalPicks > 0 ? p.scanPicks / p.totalPicks : 0
      })).sort((a, b) => b.itemsPicked - a.itemsPicked);

      // Calculate average pick time safely - divide total pick time by number of items
      // Use claim-to-complete time divided by items for per-item average
      const avgClaimToCompleteMs = claimToCompleteCount > 0 ? totalClaimToComplete / claimToCompleteCount : 0;
      const avgItemsPerOrder = totalOrdersCompleted > 0 ? totalItemsPicked / totalOrdersCompleted : 1;
      const avgPickTimePerItem = avgClaimToCompleteMs > 0 && avgItemsPerOrder > 0 
        ? (avgClaimToCompleteMs / avgItemsPerOrder) / 1000 
        : 0;

      res.json({
        throughput: {
          ordersPerHour: totalOrdersCompleted / hoursInRange,
          linesPerHour: totalLinesPicked / hoursInRange,
          itemsPerHour: totalItemsPicked / hoursInRange,
          totalOrdersCompleted,
          totalLinesPicked,
          totalItemsPicked
        },
        productivity: {
          averagePickTime: avgPickTimePerItem,
          averageClaimToComplete: claimToCompleteCount > 0 ? (totalClaimToComplete / claimToCompleteCount) / 1000 : 0,
          averageQueueWait: queueWaitCount > 0 ? (totalQueueWait / queueWaitCount) / 1000 : 0,
          pickersActive: uniquePickers.size,
          utilizationRate: 0.85 // Placeholder - would need shift data to calculate properly
        },
        quality: {
          shortPickRate: totalLinesPicked > 0 ? shortLogs.length / totalLinesPicked : 0,
          totalShortPicks: shortLogs.length,
          scanPickRate: totalPicks > 0 ? scanPicks / totalPicks : 0,
          manualPickRate: totalPicks > 0 ? manualPicks / totalPicks : 0,
          exceptionRate: totalOrdersCompleted > 0 ? exceptionOrders / totalOrdersCompleted : 0,
          totalExceptions: exceptionOrders
        },
        pickerPerformance,
        hourlyTrend,
        shortReasons
      });
    } catch (error) {
      console.error("Error fetching picking metrics:", error);
      res.status(500).json({ error: "Failed to fetch picking metrics" });
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
          // Skip orders that already exist - we don't want to overwrite in-progress picking
          skipped++;
          continue;
        }
        
        // Only create NEW orders
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
        
        // Create new order
        await storage.createOrderWithItems({
          shopifyOrderId: orderData.shopifyOrderId,
          orderNumber: orderData.orderNumber,
          customerName: orderData.customerName,
          customerEmail: orderData.customerEmail,
          priority: orderData.priority,
          status: "ready",
          shopifyCreatedAt: orderData.shopifyCreatedAt ? new Date(orderData.shopifyCreatedAt) : undefined,
        }, enrichedItems);
        
        created++;
      }
      
      console.log(`Orders sync complete: ${created} created, ${updated} updated, ${skipped} skipped (in progress)`);
      
      // Reconcile locations for pending items (update from product_locations if changed)
      const reconcileResult = await reconcileOrderItemLocations();
      
      // Now sync fulfillment status for all non-shipped orders in our system
      const fulfillmentResult = await syncFulfillmentStatus();
      
      res.json({
        success: true,
        created,
        updated,
        skipped,
        total: shopifyOrders.length,
        fulfillmentSync: fulfillmentResult,
        locationReconcile: reconcileResult,
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
      
      // If FULLY fulfilled in Shopify (all line items), mark as shipped
      // For partial fulfillments, we rely on webhooks to track individual line items
      if (status.fulfillmentStatus === "fulfilled") {
        await storage.updateOrderStatus(order.id, "shipped");
        shipped++;
        console.log(`Order ${order.orderNumber} marked as shipped (fully fulfilled in Shopify)`);
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

  // Reconcile order item locations with product_locations table
  // Updates pending/unassigned items if product_locations has been updated
  async function reconcileOrderItemLocations(): Promise<{ updated: number; checked: number }> {
    // Get all active orders (not shipped/cancelled) with their items
    const allOrders = await storage.getOrdersWithItems();
    const activeOrders = allOrders.filter(o => 
      o.status !== "shipped" && 
      o.status !== "cancelled"
    );
    
    let updated = 0;
    let checked = 0;
    
    for (const order of activeOrders) {
      for (const item of order.items) {
        checked++;
        
        // Only update items that haven't been picked yet
        if (item.status !== "pending") continue;
        
        // Look up current location from product_locations by SKU
        const productLocation = await storage.getProductLocationBySku(item.sku);
        
        if (!productLocation) continue;
        
        // Check if location/zone needs updating
        const needsUpdate = 
          item.location !== productLocation.location ||
          item.zone !== productLocation.zone ||
          item.barcode !== productLocation.barcode ||
          item.imageUrl !== productLocation.imageUrl;
        
        if (needsUpdate) {
          await storage.updateOrderItemLocation(
            item.id, 
            productLocation.location, 
            productLocation.zone,
            productLocation.barcode || null,
            productLocation.imageUrl || null
          );
          updated++;
          console.log(`Reconcile: Updated item ${item.sku} in order ${order.orderNumber} to location ${productLocation.location}`);
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
    
    if (order.status === "shipped" || order.status === "cancelled") {
      console.log(`Fulfillment ${source}: Order ${order.orderNumber} already ${order.status}, skipping`);
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
    if (!order || order.status === "shipped" || order.status === "cancelled") {
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
      const lineItems = payload.line_items || [];
      
      console.log(`Fulfillment create webhook: order ${shopifyOrderId}, status: ${fulfillmentStatus}, line_items: ${lineItems.length}`);
      
      // Only process successful fulfillments
      if (fulfillmentStatus === "success" && lineItems.length > 0) {
        await processFulfillmentLineItems(shopifyOrderId, lineItems, "create webhook");
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
  app.post("/api/shopify/webhooks/orders/create", async (req: Request, res: Response) => {
    console.log("[ORDER WEBHOOK] Received orders/create webhook");
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      console.log("[ORDER WEBHOOK] HMAC present:", !!hmac, "Raw body present:", !!rawBody);
      
      if (!rawBody) {
        console.error("[ORDER WEBHOOK] Missing raw body for webhook verification");
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        console.error("[ORDER WEBHOOK] Invalid Shopify webhook signature");
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      console.log("[ORDER WEBHOOK] Signature verified successfully");
      
      const payload = req.body as ShopifyOrder;
      console.log("[ORDER WEBHOOK] Processing order:", payload.order_number, "Shopify ID:", payload.id);
      
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
      const createdOrder = await storage.createOrderWithItems({
        shopifyOrderId: orderData.shopifyOrderId,
        orderNumber: orderData.orderNumber,
        customerName: orderData.customerName,
        customerEmail: orderData.customerEmail,
        priority: orderData.priority,
        status: "ready",
        shopifyCreatedAt: orderData.shopifyCreatedAt ? new Date(orderData.shopifyCreatedAt) : undefined,
      }, enrichedItems);
      
      console.log(`Webhook: Created order ${orderData.orderNumber} with ${enrichedItems.length} items`);
      
      // Reserve inventory for each line item (async - don't block response)
      const itemsToReserve = [...enrichedItems]; // Copy for async context
      (async () => {
        const inventoryItemsToSync = new Set<number>();
        
        // Get the created order items to get their IDs
        const createdOrderItems = await storage.getOrderItems(createdOrder.id);
        
        for (const enrichedItem of itemsToReserve) {
          try {
            // Find the corresponding order item by shopifyLineItemId (most reliable)
            // Fall back to SKU matching if line item ID is not available
            const orderItem = createdOrderItems.find(oi => 
              (enrichedItem.shopifyLineItemId && oi.shopifyLineItemId === enrichedItem.shopifyLineItemId) ||
              oi.sku === enrichedItem.sku
            );
            const orderItemId = orderItem?.id || 0;
            
            // Look up UOM variant to get unitsPerVariant
            const uomVariant = await storage.getUomVariantBySku(enrichedItem.sku);
            
            if (uomVariant) {
              const baseUnits = enrichedItem.quantity * uomVariant.unitsPerVariant;
              
              // Find a location with stock to reserve from
              const levels = await storage.getInventoryLevelsByItemId(uomVariant.inventoryItemId);
              const levelWithStock = levels.find((l: any) => l.onHandBase >= baseUnits);
              
              if (levelWithStock) {
                await inventoryService.reserveForOrder(
                  uomVariant.inventoryItemId,
                  levelWithStock.warehouseLocationId,
                  baseUnits,
                  createdOrder.id,
                  orderItemId,
                  undefined
                );
                inventoryItemsToSync.add(uomVariant.inventoryItemId);
                console.log(`[ORDER WEBHOOK] Reserved ${baseUnits} base units for ${enrichedItem.sku} (orderItemId: ${orderItemId})`);
              }
            }
          } catch (err) {
            console.warn(`[ORDER WEBHOOK] Failed to reserve inventory for ${enrichedItem.sku}:`, err);
          }
        }
        
        // Sync affected inventory items to Shopify (push sibling variant updates)
        for (const inventoryItemId of Array.from(inventoryItemsToSync)) {
          try {
            await syncInventoryItemToShopify(inventoryItemId, storage);
          } catch (err) {
            console.warn(`[ORDER WEBHOOK] Failed to sync item ${inventoryItemId} to Shopify:`, err);
          }
        }
      })();
      
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

  // ============================================
  // INVENTORY MANAGEMENT (WMS) API
  // ============================================

  // Warehouse Locations
  app.get("/api/inventory/locations", async (req, res) => {
    try {
      const locations = await storage.getAllWarehouseLocations();
      res.json(locations);
    } catch (error) {
      console.error("Error fetching warehouse locations:", error);
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  });

  app.post("/api/inventory/locations", async (req, res) => {
    try {
      const parsed = insertWarehouseLocationSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid location data", details: parsed.error });
      }
      const location = await storage.createWarehouseLocation(parsed.data);
      res.status(201).json(location);
    } catch (error) {
      console.error("Error creating warehouse location:", error);
      res.status(500).json({ error: "Failed to create location" });
    }
  });

  // Inventory Items (Master SKUs)
  app.get("/api/inventory/items", async (req, res) => {
    try {
      const items = await storage.getAllInventoryItems();
      res.json(items);
    } catch (error) {
      console.error("Error fetching inventory items:", error);
      res.status(500).json({ error: "Failed to fetch items" });
    }
  });

  app.get("/api/inventory/items/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const summary = await inventoryService.getInventoryItemSummary(id);
      if (!summary) {
        return res.status(404).json({ error: "Item not found" });
      }
      res.json(summary);
    } catch (error) {
      console.error("Error fetching inventory item:", error);
      res.status(500).json({ error: "Failed to fetch item" });
    }
  });

  app.post("/api/inventory/items", async (req, res) => {
    try {
      const parsed = insertInventoryItemSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid item data", details: parsed.error });
      }
      const item = await storage.createInventoryItem(parsed.data);
      res.status(201).json(item);
    } catch (error) {
      console.error("Error creating inventory item:", error);
      res.status(500).json({ error: "Failed to create item" });
    }
  });

  // UOM Variants
  app.get("/api/inventory/variants", async (req, res) => {
    try {
      const variants = await storage.getAllUomVariants();
      res.json(variants);
    } catch (error) {
      console.error("Error fetching UOM variants:", error);
      res.status(500).json({ error: "Failed to fetch variants" });
    }
  });

  app.post("/api/inventory/variants", async (req, res) => {
    try {
      const parsed = insertUomVariantSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid variant data", details: parsed.error });
      }
      const variant = await storage.createUomVariant(parsed.data);
      res.status(201).json(variant);
    } catch (error) {
      console.error("Error creating UOM variant:", error);
      res.status(500).json({ error: "Failed to create variant" });
    }
  });

  // Inventory Levels & Adjustments
  app.get("/api/inventory/levels/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const levels = await storage.getInventoryLevelsByItemId(itemId);
      res.json(levels);
    } catch (error) {
      console.error("Error fetching inventory levels:", error);
      res.status(500).json({ error: "Failed to fetch levels" });
    }
  });

  app.post("/api/inventory/adjust", async (req, res) => {
    try {
      const { inventoryItemId, warehouseLocationId, baseUnitsDelta, reason } = req.body;
      const userId = req.session.user?.id;
      
      if (!inventoryItemId || !warehouseLocationId || baseUnitsDelta === undefined || !reason) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      
      await inventoryService.adjustInventory(
        inventoryItemId,
        warehouseLocationId,
        baseUnitsDelta,
        reason,
        userId
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error adjusting inventory:", error);
      res.status(500).json({ error: "Failed to adjust inventory" });
    }
  });

  app.post("/api/inventory/receive", async (req, res) => {
    try {
      const { inventoryItemId, warehouseLocationId, baseUnits, referenceId, notes } = req.body;
      const userId = req.session.user?.id;
      
      if (!inventoryItemId || !warehouseLocationId || !baseUnits || !referenceId) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      
      await inventoryService.receiveInventory(
        inventoryItemId,
        warehouseLocationId,
        baseUnits,
        referenceId,
        notes,
        userId
      );
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error receiving inventory:", error);
      res.status(500).json({ error: "Failed to receive inventory" });
    }
  });

  // Replenishment - move stock from bulk to pick location
  app.post("/api/inventory/replenish", async (req, res) => {
    try {
      const { inventoryItemId, targetLocationId, requestedUnits } = req.body;
      const userId = req.session.user?.id;
      
      if (!inventoryItemId || !targetLocationId || !requestedUnits) {
        return res.status(400).json({ error: "Missing required fields" });
      }
      
      const result = await inventoryService.replenishLocation(
        inventoryItemId,
        targetLocationId,
        requestedUnits,
        userId
      );
      
      res.json({ 
        success: result.replenished > 0,
        replenished: result.replenished,
        sourceLocationId: result.sourceLocationId,
      });
    } catch (error) {
      console.error("Error replenishing inventory:", error);
      res.status(500).json({ error: "Failed to replenish inventory" });
    }
  });

  // Get locations needing replenishment
  app.get("/api/inventory/replenishment-needed", async (req, res) => {
    try {
      const inventoryItemId = req.query.itemId ? parseInt(req.query.itemId as string) : undefined;
      const locations = await inventoryService.getLocationsNeedingReplenishment(inventoryItemId);
      res.json(locations);
    } catch (error) {
      console.error("Error fetching replenishment needs:", error);
      res.status(500).json({ error: "Failed to fetch replenishment needs" });
    }
  });

  // Check backorder status for an item
  app.get("/api/inventory/backorder-status/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const status = await inventoryService.checkBackorderStatus(itemId);
      res.json(status);
    } catch (error) {
      console.error("Error checking backorder status:", error);
      res.status(500).json({ error: "Failed to check backorder status" });
    }
  });

  // Inventory Transactions (Audit Trail)
  app.get("/api/inventory/transactions/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const limit = parseInt(req.query.limit as string) || 100;
      const transactions = await storage.getInventoryTransactionsByItemId(itemId, limit);
      res.json(transactions);
    } catch (error) {
      console.error("Error fetching inventory transactions:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // Channel Feeds
  app.get("/api/inventory/channel-feeds", async (req, res) => {
    try {
      const channelType = (req.query.channel as string) || "shopify";
      const feeds = await storage.getChannelFeedsByChannel(channelType);
      res.json(feeds);
    } catch (error) {
      console.error("Error fetching channel feeds:", error);
      res.status(500).json({ error: "Failed to fetch feeds" });
    }
  });

  // Full inventory summary with all items and their variant availability
  app.get("/api/inventory/summary", async (req, res) => {
    try {
      const items = await storage.getAllInventoryItems();
      const summaries = await Promise.all(
        items.map(item => inventoryService.getInventoryItemSummary(item.id))
      );
      res.json(summaries.filter(Boolean));
    } catch (error) {
      console.error("Error fetching inventory summary:", error);
      res.status(500).json({ error: "Failed to fetch summary" });
    }
  });

  // Sync inventory levels to Shopify for a specific item or all items
  app.post("/api/inventory/sync-shopify", async (req, res) => {
    try {
      const { inventoryItemId } = req.body;
      
      // Get all items or a specific one
      const items = inventoryItemId 
        ? [await storage.getAllInventoryItems().then(all => all.find(i => i.id === inventoryItemId))].filter(Boolean)
        : await storage.getAllInventoryItems();
      
      const updates: InventoryLevelUpdate[] = [];
      
      for (const item of items) {
        if (!item) continue;
        
        // Get all variants for this item
        const variants = await storage.getUomVariantsByInventoryItemId(item.id);
        
        // Get channel feeds to find Shopify variant IDs
        for (const variant of variants) {
          const feeds = await storage.getChannelFeedsByVariantId(variant.id);
          const shopifyFeed = feeds.find(f => f.channelType === "shopify");
          
          if (shopifyFeed) {
            // Calculate availability for this variant
            const summary = await inventoryService.getInventoryItemSummary(item.id);
            const variantAvail = summary?.variants.find(v => v.variantId === variant.id);
            
            if (variantAvail) {
              updates.push({
                shopifyVariantId: shopifyFeed.channelVariantId,
                available: variantAvail.available,
              });
            }
          }
        }
      }
      
      if (updates.length === 0) {
        return res.json({ message: "No variants with Shopify channel feeds found", synced: 0 });
      }
      
      const result = await syncInventoryToShopify(updates);
      res.json({ 
        message: "Shopify inventory sync completed",
        success: result.success,
        failed: result.failed,
        total: updates.length,
      });
    } catch (error) {
      console.error("Error syncing inventory to Shopify:", error);
      res.status(500).json({ error: "Failed to sync inventory" });
    }
  });

  // ============================================
  // ORDER HISTORY API
  // ============================================
  
  app.get("/api/orders/history", async (req, res) => {
    try {
      if (!req.session.user || !["admin", "lead"].includes(req.session.user.role)) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const filters: any = {};
      
      if (req.query.orderNumber) filters.orderNumber = req.query.orderNumber as string;
      if (req.query.customerName) filters.customerName = req.query.customerName as string;
      if (req.query.sku) filters.sku = req.query.sku as string;
      if (req.query.pickerId) filters.pickerId = req.query.pickerId as string;
      if (req.query.priority) filters.priority = req.query.priority as string;
      if (req.query.status) {
        const statusParam = req.query.status as string;
        filters.status = statusParam.split(',');
      }
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      if (req.query.limit) filters.limit = parseInt(req.query.limit as string, 10);
      if (req.query.offset) filters.offset = parseInt(req.query.offset as string, 10);
      
      const [orders, total] = await Promise.all([
        storage.getOrderHistory(filters),
        storage.getOrderHistoryCount(filters)
      ]);
      
      res.json({ orders, total });
    } catch (error) {
      console.error("Error fetching order history:", error);
      res.status(500).json({ error: "Failed to fetch order history" });
    }
  });
  
  app.get("/api/orders/:id/detail", async (req, res) => {
    try {
      if (!req.session.user || !["admin", "lead"].includes(req.session.user.role)) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const orderId = parseInt(req.params.id, 10);
      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }
      
      const detail = await storage.getOrderDetail(orderId);
      if (!detail) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      res.json(detail);
    } catch (error) {
      console.error("Error fetching order detail:", error);
      res.status(500).json({ error: "Failed to fetch order detail" });
    }
  });
  
  app.get("/api/orders/history/export", async (req, res) => {
    try {
      if (!req.session.user || !["admin", "lead"].includes(req.session.user.role)) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const filters: any = { limit: 1000 };
      
      if (req.query.orderNumber) filters.orderNumber = req.query.orderNumber as string;
      if (req.query.customerName) filters.customerName = req.query.customerName as string;
      if (req.query.sku) filters.sku = req.query.sku as string;
      if (req.query.pickerId) filters.pickerId = req.query.pickerId as string;
      if (req.query.priority) filters.priority = req.query.priority as string;
      if (req.query.status) {
        const statusParam = req.query.status as string;
        filters.status = statusParam.split(',');
      }
      if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
      if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
      
      const orders = await storage.getOrderHistory(filters);
      
      const csvData = orders.map(order => ({
        orderNumber: order.orderNumber,
        customerName: order.customerName,
        status: order.status,
        priority: order.priority,
        itemCount: order.itemCount,
        pickedCount: order.pickedCount,
        picker: order.pickerName || 'N/A',
        createdAt: order.createdAt?.toISOString() || '',
        completedAt: order.completedAt?.toISOString() || '',
        shopifyOrderId: order.shopifyOrderId,
      }));
      
      const csv = Papa.unparse(csvData);
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=order-history-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);
    } catch (error) {
      console.error("Error exporting order history:", error);
      res.status(500).json({ error: "Failed to export order history" });
    }
  });

  // Migrate existing product_locations to warehouse_locations (one-time sync)
  app.post("/api/inventory/migrate-locations", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      
      const productLocs = await storage.getAllProductLocations();
      let created = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];
      
      for (const loc of productLocs) {
        try {
          if (!loc.location || loc.location === "UNASSIGNED") {
            skipped++;
            continue;
          }
          
          const code = loc.location.toUpperCase();
          const zone = (loc.zone || code.split("-")[0] || "U").toUpperCase();
          
          const existing = await storage.getWarehouseLocationByCode(code);
          if (!existing) {
            await storage.createWarehouseLocation({
              code,
              name: `Bin ${code}`,
              locationType: "forward_pick",
              zone,
              isPickable: 1,
              movementPolicy: "implicit",
            });
            created++;
          } else {
            skipped++;
          }
        } catch (err: any) {
          errors.push(`${loc.sku}: ${err.message}`);
        }
      }
      
      res.json({ 
        message: "Location migration completed",
        created,
        updated,
        skipped,
        total: productLocs.length,
        errors: errors.slice(0, 10),
      });
    } catch (error) {
      console.error("Error migrating locations:", error);
      res.status(500).json({ error: "Failed to migrate locations" });
    }
  });

  return httpServer;
}
