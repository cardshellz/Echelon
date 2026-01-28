import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { insertProductLocationSchema, updateProductLocationSchema, insertWarehouseSchema, insertWarehouseLocationSchema, insertWarehouseZoneSchema, insertInventoryItemSchema, insertUomVariantSchema, insertChannelSchema, insertChannelConnectionSchema, insertPartnerProfileSchema, insertChannelReservationSchema, insertCatalogProductSchema, generateLocationCode, productLocations, inventoryLevels } from "@shared/schema";
import { fetchAllShopifyProducts, fetchShopifyCatalogProducts, fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, syncInventoryToShopify, syncInventoryItemToShopify, type ShopifyOrder, type InventoryLevelUpdate } from "./shopify";
import { broadcastOrdersUpdated } from "./websocket";
import type { InsertOrderItem, SafeUser, InsertProductLocation, UpdateProductLocation } from "@shared/schema";
import Papa from "papaparse";
import bcrypt from "bcrypt";
import { inventoryService } from "./inventory";
import multer from "multer";
import { seedRBAC, seedDefaultChannels, getUserPermissions, getUserRoles, getAllRoles, getAllPermissions, getRolePermissions, createRole, updateRolePermissions, deleteRole, assignUserRoles, hasPermission } from "./rbac";

const upload = multer({ storage: multer.memoryStorage() });

// Permission checking middleware
function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const allowed = await hasPermission(req.session.user.id, resource, action);
    if (!allowed) {
      return res.status(403).json({ error: `Permission denied: ${resource}:${action}` });
    }
    
    next();
  };
}

// Authentication middleware (just checks if logged in)
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // Seed RBAC permissions and roles on startup
  await seedRBAC();
  
  // Seed default channels (Shopify, etc.)
  await seedDefaultChannels();
  
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
  
  app.get("/api/auth/me", async (req, res) => {
    if (req.session.user) {
      try {
        const permissions = await getUserPermissions(req.session.user.id);
        const roles = await getUserRoles(req.session.user.id);
        res.json({ 
          user: req.session.user,
          permissions,
          roles: roles.map(r => r.name),
        });
      } catch (error) {
        res.json({ user: req.session.user, permissions: [], roles: [] });
      }
    } else {
      res.status(401).json({ error: "Not authenticated" });
    }
  });
  
  // User Management API
  app.get("/api/users", requirePermission("users", "view"), async (req, res) => {
    try {
      const users = await storage.getAllUsers();
      res.json(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });
  
  app.post("/api/users", requirePermission("users", "create"), async (req, res) => {
    try {
      
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
  
  // Update user
  app.patch("/api/users/:id", requirePermission("users", "edit"), async (req, res) => {
    try {
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
  
  // RBAC Management API
  
  // Get all roles
  app.get("/api/roles", requirePermission("roles", "view"), async (req, res) => {
    try {
      const roles = await getAllRoles();
      res.json(roles);
    } catch (error) {
      console.error("Error fetching roles:", error);
      res.status(500).json({ error: "Failed to fetch roles" });
    }
  });
  
  // Get all permissions
  app.get("/api/permissions", requirePermission("roles", "view"), async (req, res) => {
    try {
      const permissions = await getAllPermissions();
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching permissions:", error);
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  });
  
  // Get permissions for a role
  app.get("/api/roles/:id/permissions", requirePermission("roles", "view"), async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const permissions = await getRolePermissions(roleId);
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching role permissions:", error);
      res.status(500).json({ error: "Failed to fetch role permissions" });
    }
  });
  
  // Create a new role
  app.post("/api/roles", requirePermission("roles", "create"), async (req, res) => {
    try {
      const { name, description, permissionIds } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Role name is required" });
      }
      
      const role = await createRole(name, description || null, permissionIds || []);
      res.status(201).json(role);
    } catch (error) {
      console.error("Error creating role:", error);
      res.status(500).json({ error: "Failed to create role" });
    }
  });
  
  // Update role permissions
  app.put("/api/roles/:id/permissions", requirePermission("roles", "edit"), async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const { permissionIds } = req.body;
      
      await updateRolePermissions(roleId, permissionIds || []);
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating role permissions:", error);
      res.status(500).json({ error: "Failed to update role permissions" });
    }
  });
  
  // Delete a role
  app.delete("/api/roles/:id", requirePermission("roles", "delete"), async (req, res) => {
    try {
      const roleId = parseInt(req.params.id);
      const success = await deleteRole(roleId);
      
      if (!success) {
        return res.status(400).json({ error: "Cannot delete system roles" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting role:", error);
      res.status(500).json({ error: "Failed to delete role" });
    }
  });
  
  // Get roles for a user
  app.get("/api/users/:id/roles", requirePermission("users", "view"), async (req, res) => {
    try {
      const userId = req.params.id;
      const roles = await getUserRoles(userId);
      res.json(roles);
    } catch (error) {
      console.error("Error fetching user roles:", error);
      res.status(500).json({ error: "Failed to fetch user roles" });
    }
  });
  
  // Assign roles to user
  app.put("/api/users/:id/roles", requirePermission("users", "manage_roles"), async (req, res) => {
    try {
      const userId = req.params.id;
      const { roleIds } = req.body;
      
      await assignUserRoles(userId, roleIds || []);
      res.json({ success: true });
    } catch (error) {
      console.error("Error assigning user roles:", error);
      res.status(500).json({ error: "Failed to assign user roles" });
    }
  });
  
  // Product Locations API
  
  // Get all locations
  app.get("/api/locations", async (req, res) => {
    try {
      // Return ALL catalog products with their locations (if assigned)
      const locations = await storage.getAllCatalogProductsWithLocations();
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

  // Create location (with upsert support for catalogProductId)
  app.post("/api/locations", async (req, res) => {
    try {
      const parsed = insertProductLocationSchema.safeParse(req.body);
      
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      
      const data = parsed.data as InsertProductLocation;
      
      // Validate that warehouse location exists
      const warehouseLoc = await storage.getWarehouseLocationByCode(data.location);
      if (!warehouseLoc) {
        return res.status(400).json({ 
          error: `Bin location "${data.location}" does not exist. Please create it first in Warehouse Locations.` 
        });
      }
      
      // Add warehouseLocationId to the data
      const dataWithRef = {
        ...data,
        warehouseLocationId: warehouseLoc.id,
        zone: warehouseLoc.zone || data.zone, // Use zone from warehouse location
      };
      
      // Check if a product_location already exists for this catalogProductId (upsert)
      if (data.catalogProductId) {
        const existing = await storage.getProductLocationByCatalogProductId(data.catalogProductId);
        if (existing) {
          // Update existing record instead of creating duplicate
          const updated = await storage.updateProductLocation(existing.id, dataWithRef);
          return res.status(200).json(updated);
        }
      }
      
      const location = await storage.createProductLocation(dataWithRef);
      
      res.status(201).json(location);
    } catch (error: any) {
      console.error("Error creating location:", error);
      if (error.code === "23505") { // Unique constraint violation
        return res.status(409).json({ error: "Product already has a location assigned" });
      }
      res.status(500).json({ error: error.message || "Failed to create location" });
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
      
      const data = parsed.data as UpdateProductLocation;
      
      // If location is being updated, validate it exists in warehouse locations
      let dataWithRef: any = { ...data };
      if (data.location) {
        const warehouseLoc = await storage.getWarehouseLocationByCode(data.location);
        if (!warehouseLoc) {
          return res.status(400).json({ 
            error: `Bin location "${data.location}" does not exist. Please create it first in Warehouse Locations.` 
          });
        }
        dataWithRef.warehouseLocationId = warehouseLoc.id;
        dataWithRef.zone = warehouseLoc.zone || data.zone;
      }
      
      const location = await storage.updateProductLocation(id, dataWithRef);
      
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      
      res.json(location);
    } catch (error: any) {
      console.error("Error updating location:", error);
      if (error.code === "23505") {
        return res.status(409).json({ error: "SKU already exists" });
      }
      res.status(500).json({ error: error.message || "Failed to update location" });
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
      let binNotMatched = 0;
      const errors: string[] = [];
      
      // Fetch warehouse locations once for efficient lookup
      const warehouseLocations = await storage.getAllWarehouseLocations();
      const warehouseLocMap = new Map(
        warehouseLocations.map((wl: { code: string; id: number }) => [wl.code.toUpperCase(), wl.id])
      );
      
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
        
        // Look up the warehouse location by code to get the ID
        const warehouseLocationId = warehouseLocMap.get(location) || null;
        
        // Find and update
        const existing = await storage.getProductLocationBySku(sku);
        if (existing) {
          await storage.updateProductLocation(existing.id, { 
            location, 
            zone,
            warehouseLocationId
          });
          updated++;
          if (!warehouseLocationId) {
            binNotMatched++;
            errors.push(`Row ${i + 2}: Bin "${location}" not found in warehouse - location saved as text only`);
          }
        } else {
          notFound++;
          errors.push(`Row ${i + 2}: SKU "${sku}" not found`);
        }
      }
      
      res.json({
        success: true,
        updated,
        notFound,
        binNotMatched,
        errors: errors.slice(0, 15),
        totalErrors: errors.length
      });
    } catch (error) {
      console.error("Error importing locations:", error);
      res.status(500).json({ error: "Failed to import locations" });
    }
  });
  
  // Sync product locations to pick queue (update pending order items)
  app.post("/api/locations/sync-to-queue", requireAuth, async (req, res) => {
    try {
      // Get all active orders (not shipped/cancelled) with their items
      const allOrders = await storage.getOrdersWithItems();
      const activeOrders = allOrders.filter(o => 
        o.status !== "shipped" && 
        o.status !== "cancelled" &&
        o.status !== "completed"
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
          }
        }
      }
      
      if (updated > 0) {
        broadcastOrdersUpdated();
      }
      
      res.json({ 
        success: true, 
        updated, 
        checked,
        message: `Updated ${updated} items across ${activeOrders.length} active orders`
      });
    } catch (error) {
      console.error("Error syncing locations to queue:", error);
      res.status(500).json({ error: "Failed to sync locations" });
    }
  });

  // ===== PICKING QUEUE API =====
  
  // DEBUG: Raw SQL test to pinpoint column issues
  app.get("/api/picking/debug", async (req, res) => {
    try {
      // Raw SQL to bypass Drizzle type mapping
      const result = await db.execute(`
        SELECT o.id as order_id, o.status, o.order_number,
               oi.id as item_id, oi.sku, oi.requires_shipping
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status IN ('ready', 'in_progress')
        LIMIT 5
      `);
      res.json({ rows: result.rows, count: result.rows?.length || 0 });
    } catch (error: any) {
      res.status(500).json({ error: error.message, code: error.code, detail: error.detail });
    }
  });
  
  // Get orders for picking queue (including completed for Done count)
  app.get("/api/picking/queue", async (req, res) => {
    try {
      // Only fetch orders that need to be in pick queue (ready/in_progress, plus recent completed)
      const orders = await storage.getPickQueueOrders();
      const user = req.session.user;
      const isAdminOrLead = user && (user.role === "admin" || user.role === "lead");
      
      const filteredOrders = orders.filter(order => {
        // Only show orders that have at least one item requiring shipping
        const hasShippableItems = order.items.some(item => item.requiresShipping === 1);
        if (!hasShippableItems) {
          return false;
        }
        
        // Filter on-hold orders for non-admins
        if (order.onHold === 1 && !isAdminOrLead) {
          return false;
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
      
      // Get all unique channel IDs and lookup their names
      const channelIds = Array.from(new Set(filteredOrders.map(o => o.channelId).filter(Boolean))) as number[];
      const channelMap = new Map<number, { name: string; provider: string }>();
      
      for (const channelId of channelIds) {
        const channel = await storage.getChannelById(channelId);
        if (channel) {
          channelMap.set(channelId, { name: channel.name, provider: channel.provider });
        }
      }
      
      // Add picker display name, channel info, and C2P (Click to Pick) time to orders
      const ordersWithMetadata = filteredOrders.map(order => {
        // Calculate C2P time: completedAt - shopifyCreatedAt (in milliseconds)
        let c2pMs: number | null = null;
        if (order.completedAt && order.shopifyCreatedAt) {
          c2pMs = new Date(order.completedAt).getTime() - new Date(order.shopifyCreatedAt).getTime();
        }
        
        const channelInfo = order.channelId ? channelMap.get(order.channelId) : null;
        
        return {
          ...order,
          pickerName: order.assignedPickerId ? pickerMap.get(order.assignedPickerId) || null : null,
          c2pMs, // Click to Pick time in milliseconds
          channelName: channelInfo?.name || null,
          channelProvider: channelInfo?.provider || order.source || null,
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

  // Set order priority (admin/lead only)
  app.post("/api/orders/:id/priority", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      
      const id = parseInt(req.params.id);
      const { priority } = req.body;
      
      if (!priority || !["rush", "high", "normal"].includes(priority)) {
        return res.status(400).json({ error: "Invalid priority. Must be rush, high, or normal" });
      }
      
      const orderBefore = await storage.getOrderById(id);
      const order = await storage.setOrderPriority(id, priority);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      // Log the priority change (non-blocking)
      storage.createPickingLog({
        actionType: "priority_changed",
        pickerId: req.session.user.id,
        pickerName: req.session.user.displayName || req.session.user.username,
        pickerRole: req.session.user.role,
        orderId: id,
        orderNumber: order.orderNumber,
        orderStatusBefore: orderBefore?.status,
        orderStatusAfter: order.status,
        reason: `Priority changed from ${orderBefore?.priority || 'normal'} to ${priority}`,
        deviceType: req.headers["x-device-type"] as string || "desktop",
        sessionId: req.sessionID,
      }).catch(err => console.warn("[PickingLog] Failed to log priority_changed:", err.message));
      
      res.json(order);
    } catch (error) {
      console.error("Error setting priority:", error);
      res.status(500).json({ error: "Failed to set priority" });
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
      
      // Get channel info for exceptions
      const channelIds = Array.from(new Set(exceptions.map(o => o.channelId).filter(Boolean))) as number[];
      const channelMap = new Map<number, { name: string; provider: string }>();
      
      for (const channelId of channelIds) {
        const channel = await storage.getChannelById(channelId);
        if (channel) {
          channelMap.set(channelId, { name: channel.name, provider: channel.provider });
        }
      }
      
      const exceptionsWithChannel = exceptions.map(order => {
        const channelInfo = order.channelId ? channelMap.get(order.channelId) : null;
        return {
          ...order,
          channelName: channelInfo?.name || null,
          channelProvider: channelInfo?.provider || order.source || null,
        };
      });
      
      res.json(exceptionsWithChannel);
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

  // DRY RUN: Parse SKUs and show what inventory items/variants would be created
  app.post("/api/inventory/bootstrap/dry-run", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      // Get all unique SKUs from product_locations
      const productLocations = await storage.getAllProductLocations();
      
      // FIXED Pattern: base SKU is everything BEFORE the final -[P|B|C]### suffix
      // P = Pack, B = Box, C = Case
      // Number = quantity of pieces
      const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
      
      // Group SKUs by base SKU and collect variants
      const baseSkuMap: Record<string, {
        baseSku: string;
        name: string;
        variants: Array<{
          sku: string;
          type: string;
          pieces: number;
          name: string;
          location: string;
        }>;
      }> = {};

      const skusWithoutVariant: Array<{ sku: string; name: string; location: string }> = [];

      for (const pl of productLocations) {
        const match = pl.sku.match(variantPattern);
        
        if (match) {
          const baseSku = match[1];
          const variantType = match[2].toUpperCase();
          const pieces = parseInt(match[3], 10);
          
          if (!baseSkuMap[baseSku]) {
            // Extract base name (remove variant suffix from name too)
            let baseName = pl.name;
            const packMatch = baseName.match(/\s*[-–]\s*(Pack|Box|Case)\s+of\s+\d+.*/i);
            if (packMatch) {
              baseName = baseName.substring(0, packMatch.index).trim();
            }
            
            baseSkuMap[baseSku] = {
              baseSku,
              name: baseName,
              variants: []
            };
          }
          
          baseSkuMap[baseSku].variants.push({
            sku: pl.sku,
            type: variantType === 'P' ? 'Pack' : variantType === 'B' ? 'Box' : 'Case',
            pieces,
            name: pl.name,
            location: pl.location
          });
        } else {
          // No variant suffix - will create as P1
          skusWithoutVariant.push({
            sku: pl.sku,
            name: pl.name,
            location: pl.location
          });
        }
      }

      // Build hierarchy for each base SKU
      const results: Array<{
        baseSku: string;
        baseName: string;
        variants: Array<{
          sku: string;
          type: string;
          pieces: number;
          hierarchyLevel: number;
          parentVariant: string | null;
        }>;
      }> = [];

      for (const [baseSku, data] of Object.entries(baseSkuMap)) {
        // Sort variants by pieces ascending (smallest first = lowest in hierarchy)
        const sortedVariants = data.variants.sort((a, b) => a.pieces - b.pieces);
        
        const variantsWithHierarchy = sortedVariants.map((v, idx) => {
          // Hierarchy: Pack (1) < Box (2) < Case (3)
          let hierarchyLevel = 1;
          if (v.type === 'Box') hierarchyLevel = 2;
          if (v.type === 'Case') hierarchyLevel = 3;
          
          // Parent is the next smaller variant (if any)
          let parentVariant: string | null = null;
          if (idx > 0) {
            parentVariant = sortedVariants[idx - 1].sku;
          }
          
          return {
            sku: v.sku,
            type: v.type,
            pieces: v.pieces,
            hierarchyLevel,
            parentVariant
          };
        });

        results.push({
          baseSku,
          baseName: data.name,
          variants: variantsWithHierarchy
        });
      }

      // Add SKUs without variant as their own items with P1 variant
      const standaloneItems = skusWithoutVariant.map(s => ({
        baseSku: s.sku,
        baseName: s.name,
        variants: [{
          sku: s.sku,
          type: 'Pack',
          pieces: 1,
          hierarchyLevel: 1,
          parentVariant: null
        }]
      }));

      res.json({
        summary: {
          totalSkusAnalyzed: productLocations.length,
          baseSkusWithVariants: Object.keys(baseSkuMap).length,
          standaloneSkus: skusWithoutVariant.length,
          totalVariantsToCreate: results.reduce((sum, r) => sum + r.variants.length, 0) + standaloneItems.length
        },
        baseSkusWithVariants: results,
        standaloneItems: standaloneItems.slice(0, 20), // Limit output
        message: "DRY RUN - No data written. Review above and POST to /api/inventory/bootstrap to execute."
      });
    } catch (error) {
      console.error("Error in bootstrap dry run:", error);
      res.status(500).json({ error: "Failed to run bootstrap analysis" });
    }
  });

  // EXECUTE: Bootstrap inventory from product_locations - writes to database
  app.post("/api/inventory/bootstrap", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const productLocations = await storage.getAllProductLocations();
      
      // Pattern: base SKU is everything BEFORE the final -[P|B|C]### suffix
      const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
      
      // Group SKUs by base SKU
      const baseSkuMap: Record<string, {
        baseSku: string;
        name: string;
        variants: Array<{
          sku: string;
          type: string;
          pieces: number;
          name: string;
          location: string;
          barcode: string | null;
        }>;
      }> = {};

      const skusWithoutVariant: Array<{ sku: string; name: string; location: string; barcode: string | null }> = [];

      for (const pl of productLocations) {
        const match = pl.sku.match(variantPattern);
        
        if (match) {
          const baseSku = match[1];
          const variantType = match[2].toUpperCase();
          const pieces = parseInt(match[3], 10);
          
          if (!baseSkuMap[baseSku]) {
            let baseName = pl.name;
            const packMatch = baseName.match(/\s*[-–]\s*(Pack|Box|Case|1 Holder|1 Pack)\s+(of\s+)?\d*.*/i);
            if (packMatch) {
              baseName = baseName.substring(0, packMatch.index).trim();
            }
            
            baseSkuMap[baseSku] = { baseSku, name: baseName, variants: [] };
          }
          
          baseSkuMap[baseSku].variants.push({
            sku: pl.sku,
            type: variantType === 'P' ? 'pack' : variantType === 'B' ? 'box' : 'case',
            pieces,
            name: pl.name,
            location: pl.location,
            barcode: pl.barcode
          });
        } else {
          skusWithoutVariant.push({
            sku: pl.sku,
            name: pl.name,
            location: pl.location,
            barcode: pl.barcode
          });
        }
      }

      let inventoryItemsCreated = 0;
      let variantsCreated = 0;
      let locationsCreated = 0;
      let levelsCreated = 0;
      const errors: string[] = [];

      // Process base SKUs with variants
      for (const [baseSku, data] of Object.entries(baseSkuMap)) {
        try {
          // Check if inventory item already exists
          let invItem = await storage.getInventoryItemByBaseSku(baseSku);
          
          if (!invItem) {
            invItem = await storage.createInventoryItem({
              baseSku,
              name: data.name,
              baseUnit: 'each',
              trackingType: 'serialized',
              status: 'active'
            });
            inventoryItemsCreated++;
          }

          // Sort variants by pieces (smallest first for hierarchy)
          const sortedVariants = data.variants.sort((a, b) => a.pieces - b.pieces);
          const createdVariantIds: Record<string, number> = {};

          for (let idx = 0; idx < sortedVariants.length; idx++) {
            const v = sortedVariants[idx];
            
            // Check if variant already exists
            let variant = await storage.getUomVariantBySku(v.sku);
            
            if (!variant) {
              const parentVariantId = idx > 0 ? createdVariantIds[sortedVariants[idx - 1].sku] : null;
              
              variant = await storage.createUomVariant({
                inventoryItemId: invItem.id,
                sku: v.sku,
                name: v.name || `${data.name} - ${v.type} of ${v.pieces}`,
                unitsPerVariant: v.pieces,
                hierarchyLevel: v.type === 'pack' ? 1 : v.type === 'box' ? 2 : 3,
                parentVariantId,
                barcode: v.barcode
              });
              variantsCreated++;
            }
            createdVariantIds[v.sku] = variant.id;

            // Create warehouse location if needed
            let warehouseLoc = await storage.getWarehouseLocationByCode(v.location);
            if (!warehouseLoc && v.location && v.location !== 'UNASSIGNED') {
              warehouseLoc = await storage.createWarehouseLocation({
                code: v.location,
                name: v.location,
                locationType: 'forward_pick',
                zone: v.location.charAt(0) || 'A',
                isPickable: 1,
                movementPolicy: 'implicit'
              });
              locationsCreated++;
            }

            // Create inventory level if location exists
            if (warehouseLoc) {
              const existingLevel = await storage.getInventoryLevelByLocationAndVariant(warehouseLoc.id, variant.id);
              if (!existingLevel) {
                await storage.upsertInventoryLevel({
                  inventoryItemId: invItem.id,
                  uomVariantId: variant.id,
                  warehouseLocationId: warehouseLoc.id,
                  onHandBase: 0,
                  reservedBase: 0,
                  pickedBase: 0,
                  backorderBase: 0
                });
                levelsCreated++;
              }
            }
          }
        } catch (err: any) {
          errors.push(`Error processing ${baseSku}: ${err.message}`);
        }
      }

      // Process standalone SKUs (no variant suffix) as P1
      for (const item of skusWithoutVariant) {
        try {
          let invItem = await storage.getInventoryItemByBaseSku(item.sku);
          
          if (!invItem) {
            invItem = await storage.createInventoryItem({
              baseSku: item.sku,
              name: item.name,
              baseUnit: 'each',
              trackingType: 'serialized',
              status: 'active'
            });
            inventoryItemsCreated++;
          }

          let variant = await storage.getUomVariantBySku(item.sku);
          if (!variant) {
            variant = await storage.createUomVariant({
              inventoryItemId: invItem.id,
              sku: item.sku,
              name: item.name || item.sku,
              unitsPerVariant: 1,
              hierarchyLevel: 1,
              barcode: item.barcode
            });
            variantsCreated++;
          }

          let warehouseLoc = await storage.getWarehouseLocationByCode(item.location);
          if (!warehouseLoc && item.location && item.location !== 'UNASSIGNED') {
            warehouseLoc = await storage.createWarehouseLocation({
              code: item.location,
              name: item.location,
              locationType: 'forward_pick',
              zone: item.location.charAt(0) || 'A',
              isPickable: 1,
              movementPolicy: 'implicit'
            });
            locationsCreated++;
          }

          if (warehouseLoc) {
            const existingLevel = await storage.getInventoryLevelByLocationAndVariant(warehouseLoc.id, variant.id);
            if (!existingLevel) {
              await storage.upsertInventoryLevel({
                inventoryItemId: invItem.id,
                uomVariantId: variant.id,
                warehouseLocationId: warehouseLoc.id,
                onHandBase: 0,
                reservedBase: 0,
                pickedBase: 0,
                backorderBase: 0
              });
              levelsCreated++;
            }
          }
        } catch (err: any) {
          errors.push(`Error processing standalone ${item.sku}: ${err.message}`);
        }
      }

      res.json({
        success: true,
        summary: {
          inventoryItemsCreated,
          variantsCreated,
          locationsCreated,
          levelsCreated
        },
        errors: errors.length > 0 ? errors : undefined,
        message: "Bootstrap complete. Inventory items, variants, and levels have been created."
      });
    } catch (error) {
      console.error("Error in bootstrap:", error);
      res.status(500).json({ error: "Failed to bootstrap inventory" });
    }
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

      const hoursInRange = Math.max(1, (now.getTime() - startDate.getTime()) / (1000 * 60 * 60));

      // Use SQL aggregation instead of loading all records into memory
      const metricsData = await storage.getPickingMetricsAggregated(startDate, now);

      // Format response with aggregated data
      const totalOrdersCompleted = metricsData.totalOrdersCompleted || 0;
      const totalLinesPicked = metricsData.totalLinesPicked || 0;
      const totalItemsPicked = metricsData.totalItemsPicked || 0;
      const totalShortPicks = metricsData.totalShortPicks || 0;
      const scanPicks = metricsData.scanPicks || 0;
      const manualPicks = metricsData.manualPicks || 0;
      const totalPicks = metricsData.totalPicks || 0;
      const pickersActive = metricsData.uniquePickers || 0;
      const exceptionOrders = metricsData.exceptionOrders || 0;

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
          averagePickTime: metricsData.avgPickTimeSeconds || 0,
          averageClaimToComplete: metricsData.avgClaimToCompleteSeconds || 0,
          averageQueueWait: metricsData.avgQueueWaitSeconds || 0,
          pickersActive,
          utilizationRate: 0.85
        },
        quality: {
          shortPickRate: totalLinesPicked > 0 ? totalShortPicks / totalLinesPicked : 0,
          totalShortPicks,
          scanPickRate: totalPicks > 0 ? scanPicks / totalPicks : 0,
          manualPickRate: totalPicks > 0 ? manualPicks / totalPicks : 0,
          exceptionRate: totalOrdersCompleted > 0 ? exceptionOrders / totalOrdersCompleted : 0,
          totalExceptions: exceptionOrders
        },
        pickerPerformance: metricsData.pickerPerformance || [],
        hourlyTrend: metricsData.hourlyTrend || [],
        shortReasons: metricsData.shortReasons || []
      });
    } catch (error) {
      console.error("Error fetching picking metrics:", error);
      res.status(500).json({ error: "Failed to fetch picking metrics" });
    }
  });

  // Shopify Sync API - syncs to inventory_items, catalog_products, and catalog_assets
  app.post("/api/shopify/sync", async (req, res) => {
    try {
      console.log("Starting Shopify catalog sync...");
      
      // Fetch full catalog data from Shopify
      const shopifyProducts = await fetchShopifyCatalogProducts();
      console.log(`Fetched ${shopifyProducts.length} products from Shopify`);
      
      let inventoryCreated = 0;
      let inventoryUpdated = 0;
      let catalogCreated = 0;
      let catalogUpdated = 0;
      let assetsCreated = 0;
      
      for (const product of shopifyProducts) {
        // 1. Upsert inventory_items by variant ID (primary identifier)
        const existingItem = await storage.getInventoryItemByShopifyVariantId(product.variantId);
        const inventoryItem = await storage.upsertInventoryItemByVariantId(product.variantId, {
          baseSku: product.sku, // May be null
          shopifyProductId: product.shopifyProductId,
          name: product.title,
          description: product.description,
          baseUnit: "each",
          imageUrl: product.imageUrl,
          active: product.status === "active" ? 1 : 0,
        });
        
        if (existingItem) {
          inventoryUpdated++;
        } else {
          inventoryCreated++;
        }
        
        // 2. Upsert catalog_products by variant ID (primary identifier)
        const existingCatalog = await storage.getCatalogProductByVariantId(product.variantId);
        const catalogProduct = await storage.upsertCatalogProductByVariantId(product.variantId, inventoryItem.id, {
          sku: product.sku, // May be null
          title: product.title,
          description: product.description,
          brand: product.vendor,
          category: product.productType,
          tags: product.tags,
          status: product.status,
        });
        
        if (existingCatalog) {
          catalogUpdated++;
        } else {
          catalogCreated++;
        }
        
        // 3. Sync catalog_assets (images)
        // Delete existing assets and recreate to ensure sync
        await storage.deleteCatalogAssetsByProductId(catalogProduct.id);
        
        for (let i = 0; i < product.allImages.length; i++) {
          const img = product.allImages[i];
          await storage.createCatalogAsset({
            catalogProductId: catalogProduct.id,
            assetType: "image",
            url: img.url,
            position: img.position,
            isPrimary: i === 0 ? 1 : 0,
          });
          assetsCreated++;
        }
        
        // 4. Also sync to product_locations for warehouse assignment (only if has SKU)
        if (product.sku) {
          await storage.upsertProductLocationBySku(product.sku, product.title, product.status, product.imageUrl || undefined, product.barcode || undefined);
        }
      }
      
      console.log(`Sync complete: inventory ${inventoryCreated} created/${inventoryUpdated} updated, catalog ${catalogCreated} created/${catalogUpdated} updated, ${assetsCreated} assets`);
      
      res.json({
        success: true,
        inventory: { created: inventoryCreated, updated: inventoryUpdated },
        catalog: { created: catalogCreated, updated: catalogUpdated },
        assets: assetsCreated,
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
        
        // Enrich ALL unfulfilled items with location data and requiresShipping per item
        const enrichedItems: InsertOrderItem[] = [];
        for (const item of unfulfilledItems) {
          const productLocation = await storage.getProductLocationBySku(item.sku || '');
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
            location: productLocation?.location || "UNASSIGNED",
            zone: productLocation?.zone || "U",
            imageUrl: productLocation?.imageUrl || null,
            barcode: productLocation?.barcode || null,
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
          AND o.status != 'completed'
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
            o.shopify_order_id = s.id 
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

  // Shopify Orders Sync - fetch all unfulfilled orders from Shopify API (legacy)
  app.post("/api/shopify/sync-orders", async (req, res) => {
    try {
      console.log("Starting Shopify orders sync...");
      
      // Get default Shopify channel for linking orders
      const allChannels = await storage.getAllChannels();
      const shopifyChannel = allChannels.find(c => c.provider === "shopify" && c.isDefault === 1);
      const shopifyChannelId = shopifyChannel?.id || null;
      
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
        // Calculate total units
        const totalUnits = orderData.items.reduce((sum, item) => sum + item.quantity, 0);
        
        // Enrich items with location data from product_locations
        const enrichedItems: InsertOrderItem[] = [];
        for (const item of orderData.items) {
          const productLocation = await storage.getProductLocationBySku(item.sku);
          enrichedItems.push({
            orderId: 0, // Will be set by createOrder
            shopifyLineItemId: item.shopifyLineItemId,
            sourceItemId: item.shopifyLineItemId, // Link to shopify_order_items
            sku: item.sku,
            name: item.name,
            quantity: item.quantity,
            pickedQuantity: 0,
            fulfilledQuantity: 0,
            status: "pending",
            location: productLocation?.location || "UNASSIGNED",
            zone: productLocation?.zone || "U",
            imageUrl: productLocation?.imageUrl || item.imageUrl || null,
            barcode: productLocation?.barcode || null,
          });
        }
        
        // Create order - operational subset only
        // Full order data stays in shopify_orders table
        await storage.createOrderWithItems({
          shopifyOrderId: orderData.shopifyOrderId,
          externalOrderId: orderData.shopifyOrderId,
          sourceTableId: orderData.shopifyOrderId, // Links to shopify_orders for JOIN lookups
          channelId: shopifyChannelId,
          source: "shopify",
          orderNumber: orderData.orderNumber,
          customerName: orderData.customerName,
          customerEmail: orderData.customerEmail,
          shippingAddress: orderData.shippingAddress,
          shippingCity: orderData.shippingCity,
          shippingState: orderData.shippingState,
          shippingPostalCode: orderData.shippingPostalCode,
          shippingCountry: orderData.shippingCountry,
          priority: orderData.priority,
          status: "ready",
          itemCount: orderData.items.length,
          unitCount: totalUnits,
          totalAmount: orderData.totalAmount,
          currency: orderData.currency,
          shopifyCreatedAt: orderData.shopifyCreatedAt ? new Date(orderData.shopifyCreatedAt) : undefined,
          orderPlacedAt: orderData.shopifyCreatedAt ? new Date(orderData.shopifyCreatedAt) : undefined,
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
  // Order create webhook - DISABLED: Orders sync from shopify_orders/shopify_order_items tables instead
  // Keeping endpoint in place for future use if needed
  app.post("/api/shopify/webhooks/orders/create", async (req: Request, res: Response) => {
    console.log("[ORDER WEBHOOK] Received orders/create webhook - DISABLED, use sync-from-raw-tables instead");
    try {
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
      
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
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
      
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
      const hmac = req.headers["x-shopify-hmac-sha256"] as string;
      const rawBody = (req as any).rawBody as Buffer | undefined;
      
      if (!rawBody) {
        return res.status(400).json({ error: "Missing request body" });
      }
      
      if (!verifyShopifyWebhook(rawBody, hmac)) {
        return res.status(401).json({ error: "Invalid signature" });
      }
      
      res.status(200).json({ received: true, note: "Webhook disabled" });
    } catch (error) {
      console.error("Order cancelled webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ============================================
  // INVENTORY MANAGEMENT (WMS) API
  // ============================================

  // Warehouses (physical sites)
  app.get("/api/warehouses", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouses = await storage.getAllWarehouses();
      res.json(warehouses);
    } catch (error) {
      console.error("Error fetching warehouses:", error);
      res.status(500).json({ error: "Failed to fetch warehouses" });
    }
  });

  app.get("/api/warehouses/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const warehouse = await storage.getWarehouseById(id);
      if (!warehouse) {
        return res.status(404).json({ error: "Warehouse not found" });
      }
      res.json(warehouse);
    } catch (error) {
      console.error("Error fetching warehouse:", error);
      res.status(500).json({ error: "Failed to fetch warehouse" });
    }
  });

  app.post("/api/warehouses", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const parsed = insertWarehouseSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      const warehouse = await storage.createWarehouse(parsed.data as any);
      res.status(201).json(warehouse);
    } catch (error: any) {
      console.error("Error creating warehouse:", error);
      if (error.code === "23505") {
        return res.status(409).json({ error: "Warehouse code already exists" });
      }
      res.status(500).json({ error: "Failed to create warehouse" });
    }
  });

  app.patch("/api/warehouses/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = insertWarehouseSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid request data", details: parsed.error });
      }
      const warehouse = await storage.updateWarehouse(id, parsed.data as any);
      if (!warehouse) {
        return res.status(404).json({ error: "Warehouse not found" });
      }
      res.json(warehouse);
    } catch (error: any) {
      console.error("Error updating warehouse:", error);
      if (error.code === "23505") {
        return res.status(409).json({ error: "Warehouse code already exists" });
      }
      res.status(500).json({ error: "Failed to update warehouse" });
    }
  });

  app.delete("/api/warehouses/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteWarehouse(id);
      if (!deleted) {
        return res.status(404).json({ error: "Warehouse not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting warehouse:", error);
      if (error.code === "23503") {
        return res.status(409).json({ error: "Cannot delete warehouse - locations are assigned to it" });
      }
      res.status(500).json({ error: "Failed to delete warehouse" });
    }
  });

  // Warehouse Zones
  app.get("/api/warehouse/zones", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const zones = await storage.getAllWarehouseZones();
      res.json(zones);
    } catch (error) {
      console.error("Error fetching warehouse zones:", error);
      res.status(500).json({ error: "Failed to fetch zones" });
    }
  });

  app.post("/api/warehouse/zones", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const parsed = insertWarehouseZoneSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid zone data", details: parsed.error.errors });
      }
      const zone = await storage.createWarehouseZone(parsed.data);
      res.status(201).json(zone);
    } catch (error: any) {
      console.error("Error creating warehouse zone:", error);
      if (error.code === '23505') {
        return res.status(400).json({ error: "Zone code already exists" });
      }
      res.status(500).json({ error: "Failed to create zone" });
    }
  });

  app.patch("/api/warehouse/zones/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const zone = await storage.updateWarehouseZone(id, req.body);
      if (!zone) {
        return res.status(404).json({ error: "Zone not found" });
      }
      res.json(zone);
    } catch (error) {
      console.error("Error updating warehouse zone:", error);
      res.status(500).json({ error: "Failed to update zone" });
    }
  });

  app.delete("/api/warehouse/zones/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteWarehouseZone(id);
      if (!deleted) {
        return res.status(404).json({ error: "Zone not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting warehouse zone:", error);
      res.status(500).json({ error: "Failed to delete zone" });
    }
  });

  // Warehouse Locations (hierarchical)
  app.get("/api/warehouse/locations", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const locations = await storage.getAllWarehouseLocations();
      res.json(locations);
    } catch (error) {
      console.error("Error fetching warehouse locations:", error);
      res.status(500).json({ error: "Failed to fetch locations" });
    }
  });

  // Export warehouse locations as CSV
  app.get("/api/warehouse/locations/export/csv", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const locations = await storage.getAllWarehouseLocations();
      
      const csvRows = [
        ["code", "zone", "aisle", "bay", "level", "bin", "name", "location_type", "is_pickable", "pick_sequence"].join(",")
      ];
      
      for (const loc of locations) {
        csvRows.push([
          loc.code || "",
          loc.zone || "",
          loc.aisle || "",
          loc.bay || "",
          loc.level || "",
          loc.bin || "",
          `"${(loc.name || "").replace(/"/g, '""')}"`,
          loc.locationType || "",
          loc.isPickable ?? 1,
          loc.pickSequence ?? ""
        ].join(","));
      }
      
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=bin_locations.csv");
      res.send(csvRows.join("\n"));
    } catch (error) {
      console.error("Error exporting warehouse locations:", error);
      res.status(500).json({ error: "Failed to export locations" });
    }
  });

  app.get("/api/warehouse/locations/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const location = await storage.getWarehouseLocationById(id);
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      res.json(location);
    } catch (error) {
      console.error("Error fetching warehouse location:", error);
      res.status(500).json({ error: "Failed to fetch location" });
    }
  });

  app.post("/api/warehouse/locations", requirePermission("inventory", "create"), async (req, res) => {
    try {
      // Storage layer handles validation and code generation
      const location = await storage.createWarehouseLocation(req.body);
      res.status(201).json(location);
    } catch (error: any) {
      console.error("Error creating warehouse location:", error);
      // Return user-friendly error message
      res.status(400).json({ error: error.message || "Failed to create location" });
    }
  });

  app.patch("/api/warehouse/locations/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const location = await storage.updateWarehouseLocation(id, req.body);
      if (!location) {
        return res.status(404).json({ error: "Location not found" });
      }
      res.json(location);
    } catch (error: any) {
      console.error("Error updating warehouse location:", error);
      res.status(400).json({ error: error.message || "Failed to update location" });
    }
  });

  app.delete("/api/warehouse/locations/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteWarehouseLocation(id);
      if (!deleted) {
        return res.status(404).json({ error: "Location not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting warehouse location:", error);
      if (error.code === "23503") {
        return res.status(409).json({ error: "Cannot delete location - products are assigned to it. Remove products first." });
      }
      res.status(500).json({ error: "Failed to delete location" });
    }
  });

  // Bulk delete warehouse locations
  app.post("/api/warehouse/locations/bulk-delete", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "No location IDs provided" });
      }
      let deleted = 0;
      const errors: string[] = [];
      const blocked: string[] = [];
      
      for (const id of ids) {
        try {
          // Check if location has inventory
          const invLevels = await db.select({ id: inventoryLevels.id })
            .from(inventoryLevels)
            .where(eq(inventoryLevels.warehouseLocationId, id))
            .limit(1);
          
          if (invLevels.length > 0) {
            blocked.push(`Location ${id} has inventory - move or adjust stock first`);
            continue;
          }
          
          // Check if location has products assigned
          const productLocs = await db.select({ id: productLocations.id })
            .from(productLocations)
            .where(eq(productLocations.warehouseLocationId, id))
            .limit(1);
          
          if (productLocs.length > 0) {
            blocked.push(`Location ${id} has products assigned - reassign them first`);
            continue;
          }
          
          const result = await storage.deleteWarehouseLocation(id);
          if (result) deleted++;
        } catch (err: any) {
          console.error(`Error deleting location ${id}:`, err);
          errors.push(`Location ${id}: ${err.detail || err.message || err.code || 'Unknown error'}`);
        }
      }
      
      const allErrors = [...blocked, ...errors];
      if (allErrors.length > 0) {
        return res.json({ success: true, deleted, errors: allErrors });
      }
      res.json({ success: true, deleted });
    } catch (error) {
      console.error("Error bulk deleting warehouse locations:", error);
      res.status(500).json({ error: "Failed to delete locations" });
    }
  });

  // Bulk reassign products from source locations to target location
  const bulkReassignSchema = z.object({
    sourceLocationIds: z.array(z.number()).min(1, "At least one source location required"),
    targetLocationId: z.number({ required_error: "Target location ID required" }),
  });
  
  app.post("/api/warehouse/locations/bulk-reassign", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const parseResult = bulkReassignSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: parseResult.error.errors[0]?.message || "Invalid request" });
      }
      const { sourceLocationIds, targetLocationId } = parseResult.data;
      
      // Get target location details
      const targetLocation = await storage.getWarehouseLocationById(targetLocationId);
      if (!targetLocation) {
        return res.status(404).json({ error: "Target location not found" });
      }
      
      // Update all product_locations from source locations to the target in a single query
      const result = await db.update(productLocations)
        .set({ 
          warehouseLocationId: targetLocationId,
          location: targetLocation.code,
          zone: targetLocation.zone || 'STAGING'
        })
        .where(inArray(productLocations.warehouseLocationId, sourceLocationIds));
      
      const reassigned = result.rowCount || 0;
      res.json({ success: true, reassigned });
    } catch (error: any) {
      console.error("Error bulk reassigning products:", error);
      res.status(500).json({ error: error.message || "Failed to reassign products" });
    }
  });

  // Bulk import warehouse locations from CSV
  app.post("/api/warehouse/locations/bulk-import", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { locations, warehouseId } = req.body;
      if (!Array.isArray(locations) || locations.length === 0) {
        return res.status(400).json({ error: "No locations provided" });
      }
      
      const results = { created: 0, errors: [] as string[] };
      
      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];
        const rowNum = i + 2; // Row 1 is header, data starts at row 2
        
        try {
          // Validate that at least one hierarchy field is present
          const zone = loc.zone?.trim() || null;
          const aisle = loc.aisle?.trim() || null;
          const bay = loc.bay?.toString().trim() ? loc.bay.toString().trim().padStart(2, '0') : null;
          const level = loc.level?.trim() || null;
          const bin = loc.bin?.toString().trim() || null;
          
          if (!zone && !aisle && !bay && !level && !bin) {
            results.errors.push(`Row ${rowNum}: At least one hierarchy field required (zone, aisle, bay, level, or bin)`);
            continue;
          }
          
          const rowWarehouseId = loc.warehouseId || loc.warehouse_id;
          let effectiveWarehouseId: number | null = warehouseId || null;
          if (rowWarehouseId) {
            const parsed = parseInt(rowWarehouseId);
            if (isNaN(parsed)) {
              results.errors.push(`Row ${rowNum}: Invalid warehouse_id "${rowWarehouseId}"`);
              continue;
            }
            effectiveWarehouseId = parsed;
          }
          
          await storage.createWarehouseLocation({
            zone,
            aisle,
            bay,
            level,
            bin,
            name: loc.name?.trim() || null,
            locationType: (loc.locationType || loc.location_type || "bin").trim(),
            isPickable: loc.isPickable !== undefined ? parseInt(loc.isPickable) : 1,
            pickSequence: loc.pickSequence || loc.pick_sequence ? parseInt(loc.pickSequence || loc.pick_sequence) : null,
            minQty: loc.minQty || loc.min_qty ? parseInt(loc.minQty || loc.min_qty) : null,
            maxQty: loc.maxQty || loc.max_qty ? parseInt(loc.maxQty || loc.max_qty) : null,
            warehouseId: effectiveWarehouseId,
          });
          results.created++;
        } catch (err: any) {
          results.errors.push(`Row ${rowNum}: ${err.message}`);
        }
      }
      
      res.json(results);
    } catch (error: any) {
      console.error("Error bulk importing warehouse locations:", error);
      res.status(500).json({ error: error.message || "Failed to import locations" });
    }
  });

  // Get products assigned to a specific bin (warehouse location) - for bin-centric view
  app.get("/api/warehouse/locations/:id/products", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseLocationId = parseInt(req.params.id);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }
      const products = await storage.getProductLocationsByWarehouseLocationId(warehouseLocationId);
      res.json(products);
    } catch (error: any) {
      console.error("Error fetching products for location:", error);
      res.status(500).json({ error: error.message || "Failed to fetch products" });
    }
  });

  // Assign a product to a bin (add location) - for bin-centric assignment
  app.post("/api/warehouse/locations/:id/products", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const warehouseLocationId = parseInt(req.params.id);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }
      
      const { catalogProductId, locationType, isPrimary } = req.body;
      if (!catalogProductId) {
        return res.status(400).json({ error: "catalogProductId is required" });
      }
      
      // Get warehouse location details
      const warehouseLocation = await storage.getWarehouseLocationById(warehouseLocationId);
      if (!warehouseLocation) {
        return res.status(404).json({ error: "Warehouse location not found" });
      }
      
      // Get catalog product details
      const catalogProduct = await storage.getCatalogProductById(catalogProductId);
      if (!catalogProduct) {
        return res.status(404).json({ error: "Product not found" });
      }
      
      const productLocation = await storage.addProductToLocation({
        catalogProductId,
        warehouseLocationId,
        sku: catalogProduct.sku || null,
        shopifyVariantId: catalogProduct.shopifyVariantId || null,
        name: catalogProduct.title,
        location: warehouseLocation.code,
        zone: warehouseLocation.zone || warehouseLocation.code.split("-")[0] || "A",
        locationType: locationType || "forward_pick",
        isPrimary: isPrimary ?? 1,
        imageUrl: catalogProduct.imageUrl || null,
        barcode: catalogProduct.barcode || null,
      });
      
      res.status(201).json(productLocation);
    } catch (error: any) {
      console.error("Error assigning product to location:", error);
      res.status(500).json({ error: error.message || "Failed to assign product" });
    }
  });

  // Get all locations for a specific product
  app.get("/api/products/:catalogProductId/locations", async (req, res) => {
    try {
      const catalogProductId = parseInt(req.params.catalogProductId);
      if (isNaN(catalogProductId)) {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      const locations = await storage.getProductLocationsByCatalogProductId(catalogProductId);
      res.json(locations);
    } catch (error: any) {
      console.error("Error fetching locations for product:", error);
      res.status(500).json({ error: error.message || "Failed to fetch locations" });
    }
  });

  // Set a location as primary for a product
  app.post("/api/product-locations/:id/set-primary", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const productLocationId = parseInt(req.params.id);
      if (isNaN(productLocationId)) {
        return res.status(400).json({ error: "Invalid product location ID" });
      }
      const updated = await storage.setPrimaryLocation(productLocationId);
      if (!updated) {
        return res.status(404).json({ error: "Product location not found" });
      }
      res.json(updated);
    } catch (error: any) {
      console.error("Error setting primary location:", error);
      res.status(500).json({ error: error.message || "Failed to set primary location" });
    }
  });

  // Legacy Warehouse Locations (for backward compatibility with existing /api/inventory/locations)
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

  // Catalog Products API
  app.get("/api/catalog/products", async (req, res) => {
    try {
      const products = await storage.getAllCatalogProducts();
      res.json(products);
    } catch (error) {
      console.error("Error fetching catalog products:", error);
      res.status(500).json({ error: "Failed to fetch catalog products" });
    }
  });

  app.get("/api/catalog/products/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = await storage.getCatalogProductById(id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      
      // Also get inventory item and variants
      const inventoryItem = await storage.getInventoryItemById(product.inventoryItemId);
      const variants = inventoryItem ? await storage.getUomVariantsByInventoryItemId(inventoryItem.id) : [];
      const assets = await storage.getCatalogAssetsByProductId(product.id);
      
      res.json({ ...product, inventoryItem, variants, assets });
    } catch (error) {
      console.error("Error fetching catalog product:", error);
      res.status(500).json({ error: "Failed to fetch catalog product" });
    }
  });

  app.post("/api/catalog/products", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const validatedData = insertCatalogProductSchema.parse(req.body);
      const product = await storage.createCatalogProduct(validatedData);
      res.json(product);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid product data", details: error.errors });
      }
      console.error("Error creating catalog product:", error);
      res.status(500).json({ error: error.message || "Failed to create catalog product" });
    }
  });

  app.patch("/api/catalog/products/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const validatedData = insertCatalogProductSchema.partial().parse(req.body);
      const product = await storage.updateCatalogProduct(id, validatedData);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json(product);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid product data", details: error.errors });
      }
      console.error("Error updating catalog product:", error);
      res.status(500).json({ error: error.message || "Failed to update catalog product" });
    }
  });

  app.delete("/api/catalog/products/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteCatalogProduct(id);
      if (!deleted) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting catalog product:", error);
      res.status(500).json({ error: error.message || "Failed to delete catalog product" });
    }
  });

  // Single product with all related data (for detail views) - uses catalog_products as master
  app.get("/api/products/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const catalogProduct = await storage.getCatalogProductById(id);
      
      if (!catalogProduct) {
        return res.status(404).json({ error: "Product not found" });
      }
      
      // Get linked inventory item and assets
      const inventoryItem = await storage.getInventoryItemById(catalogProduct.inventoryItemId);
      const assets = await storage.getCatalogAssetsByProductId(catalogProduct.id);
      const variants = await storage.getUomVariantsByInventoryItemId(catalogProduct.inventoryItemId);
      
      res.json({
        id: catalogProduct.id,
        baseSku: catalogProduct.sku,
        name: catalogProduct.title,
        imageUrl: inventoryItem?.imageUrl || null,
        active: catalogProduct.status === "active" ? 1 : 0,
        description: catalogProduct.description,
        baseUnit: inventoryItem?.baseUnit || "each",
        costPerUnit: inventoryItem?.costPerUnit || null,
        catalogProduct,
        variants,
        assets,
      });
    } catch (error) {
      console.error("Error fetching product:", error);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  });

  // Products with joined data (for list views) - uses catalog_products as master
  app.get("/api/products", async (req, res) => {
    try {
      // Get all catalog products (master source from Shopify sync)
      const catalogProductsList = await storage.getAllCatalogProducts();
      const inventoryItemsList = await storage.getAllInventoryItems();
      const variantsList = await storage.getAllUomVariants();
      
      // Create lookup maps
      const inventoryById = new Map(inventoryItemsList.map(i => [i.id, i]));
      const variantsByItemId = new Map<number, typeof variantsList>();
      for (const v of variantsList) {
        if (!variantsByItemId.has(v.inventoryItemId)) {
          variantsByItemId.set(v.inventoryItemId, []);
        }
        variantsByItemId.get(v.inventoryItemId)!.push(v);
      }
      
      // Combine into product view
      const products = catalogProductsList.map(catalog => {
        const inventoryItem = inventoryById.get(catalog.inventoryItemId);
        return {
          id: catalog.id,
          baseSku: catalog.sku,
          name: catalog.title,
          imageUrl: inventoryItem?.imageUrl || null,
          active: catalog.status === "active" ? 1 : 0,
          catalogProduct: catalog,
          variantCount: variantsByItemId.get(catalog.inventoryItemId)?.length || 0,
          variants: variantsByItemId.get(catalog.inventoryItemId) || [],
        };
      });
      
      res.json(products);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
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

  // Get catalog products without bin locations (for assignment)
  app.get("/api/inventory/items/unassigned", async (req, res) => {
    try {
      const products = await storage.getCatalogProductsWithoutLocations();
      res.json(products);
    } catch (error) {
      console.error("Error fetching unassigned products:", error);
      res.status(500).json({ error: "Failed to fetch unassigned products" });
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

  app.get("/api/inventory/items/:id/variants", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const variants = await storage.getUomVariantsByInventoryItemId(id);
      res.json(variants);
    } catch (error) {
      console.error("Error fetching variants for item:", error);
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

  // Adjustment Reasons API
  app.get("/api/inventory/adjustment-reasons", async (req, res) => {
    try {
      const reasons = await storage.getActiveAdjustmentReasons();
      res.json(reasons);
    } catch (error) {
      console.error("Error fetching adjustment reasons:", error);
      res.status(500).json({ error: "Failed to fetch adjustment reasons" });
    }
  });

  app.post("/api/inventory/adjustment-reasons", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      const reason = await storage.createAdjustmentReason(req.body);
      res.status(201).json(reason);
    } catch (error) {
      console.error("Error creating adjustment reason:", error);
      res.status(500).json({ error: "Failed to create adjustment reason" });
    }
  });

  // Seed default adjustment reasons
  app.post("/api/inventory/adjustment-reasons/seed", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const defaultReasons = [
        { code: "CSV_UPLOAD", name: "CSV Bulk Upload", description: "Inventory updated via CSV file upload", transactionType: "csv_upload", sortOrder: 1 },
        { code: "CYCLE_COUNT", name: "Cycle Count", description: "Physical count adjustment during cycle counting", transactionType: "adjustment", requiresNote: 1, sortOrder: 2 },
        { code: "RECEIVING", name: "Receiving", description: "Goods received from purchase order", transactionType: "receipt", sortOrder: 3 },
        { code: "DAMAGED", name: "Damaged Goods", description: "Items removed due to damage", transactionType: "adjustment", requiresNote: 1, sortOrder: 4 },
        { code: "EXPIRED", name: "Expired", description: "Items removed due to expiration", transactionType: "adjustment", sortOrder: 5 },
        { code: "RETURN", name: "Customer Return", description: "Items returned by customer", transactionType: "return", sortOrder: 6 },
        { code: "TRANSFER", name: "Location Transfer", description: "Items moved between locations", transactionType: "transfer", sortOrder: 7 },
        { code: "SHRINKAGE", name: "Shrinkage/Loss", description: "Unexplained inventory loss", transactionType: "adjustment", requiresNote: 1, sortOrder: 8 },
        { code: "FOUND", name: "Found Inventory", description: "Previously unaccounted inventory found", transactionType: "adjustment", sortOrder: 9 },
        { code: "SHOPIFY_SYNC", name: "Shopify Sync", description: "Adjustment from Shopify inventory sync", transactionType: "adjustment", sortOrder: 10 },
        { code: "MANUAL_ADJ", name: "Manual Adjustment", description: "Manual inventory correction", transactionType: "adjustment", requiresNote: 1, sortOrder: 11 },
        { code: "PICKING", name: "Order Picking", description: "Items picked for customer order", transactionType: "pick", sortOrder: 12 },
        { code: "SHORT_PICK", name: "Short Pick", description: "Unable to pick full quantity", transactionType: "pick", requiresNote: 1, sortOrder: 13 },
      ];

      const created = [];
      const skipped = [];

      for (const reason of defaultReasons) {
        const existing = await storage.getAdjustmentReasonByCode(reason.code);
        if (existing) {
          skipped.push(reason.code);
        } else {
          const newReason = await storage.createAdjustmentReason(reason);
          created.push(newReason);
        }
      }

      res.json({ 
        message: `Seeded ${created.length} reason codes, skipped ${skipped.length} existing`,
        created: created.map(r => r.code),
        skipped
      });
    } catch (error) {
      console.error("Error seeding adjustment reasons:", error);
      res.status(500).json({ error: "Failed to seed adjustment reasons" });
    }
  });

  // Inventory Transactions History
  app.get("/api/inventory/transactions", async (req, res) => {
    try {
      const { batchId, transactionType, startDate, endDate, limit, offset } = req.query;
      const transactions = await storage.getInventoryTransactions({
        batchId: batchId as string,
        transactionType: transactionType as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json(transactions);
    } catch (error) {
      console.error("Error fetching transactions:", error);
      res.status(500).json({ error: "Failed to fetch transactions" });
    }
  });

  // CSV Inventory Upload - bulk update inventory levels
  app.post("/api/inventory/upload-csv", upload.single("file"), async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const csvContent = req.file.buffer.toString("utf-8");
      const parsed = Papa.parse<{ location_code: string; sku: string; quantity: string }>(csvContent, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (header) => header.trim().toLowerCase().replace(/\s+/g, "_"),
      });

      if (parsed.errors.length > 0) {
        return res.status(400).json({ 
          error: "CSV parsing errors", 
          details: parsed.errors.slice(0, 5) 
        });
      }

      const results: { row: number; sku: string; location: string; status: string; message: string }[] = [];
      const userId = req.session.user.id;
      let successCount = 0;
      let errorCount = 0;

      // Generate a unique batch ID for this upload
      const batchId = `CSV-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      
      // Try to get the CSV_UPLOAD reason code (optional - table may not exist yet)
      let csvReason: any = null;
      try {
        csvReason = await storage.getAdjustmentReasonByCode("CSV_UPLOAD");
      } catch (err) {
        // Reason codes table not set up yet - continue without it
        console.log("Note: adjustment_reasons table not available, continuing without reason codes");
      }

      for (let i = 0; i < parsed.data.length; i++) {
        const row = parsed.data[i];
        const rowNum = i + 2; // Account for header row

        const locationCode = row.location_code?.trim();
        const sku = row.sku?.trim();
        const quantityStr = row.quantity?.trim();

        if (!locationCode || !sku || !quantityStr) {
          results.push({ row: rowNum, sku: sku || "", location: locationCode || "", status: "error", message: "Missing required fields (location_code, sku, quantity)" });
          errorCount++;
          continue;
        }

        const quantity = parseInt(quantityStr, 10);
        if (isNaN(quantity) || quantity < 0) {
          results.push({ row: rowNum, sku, location: locationCode, status: "error", message: "Invalid quantity (must be a non-negative number)" });
          errorCount++;
          continue;
        }

        // Find the warehouse location
        const warehouseLocation = await storage.getWarehouseLocationByCode(locationCode);
        if (!warehouseLocation) {
          results.push({ row: rowNum, sku, location: locationCode, status: "error", message: `Location not found: ${locationCode}` });
          errorCount++;
          continue;
        }

        // Try to find as variant SKU first, then as base SKU
        let variant = await storage.getUomVariantBySku(sku);
        let inventoryItem: any = null;
        
        if (variant) {
          // Found as variant SKU - get the inventory item directly from the variant's reference
          const items = await storage.getAllInventoryItems();
          inventoryItem = items.find(item => item.id === variant!.inventoryItemId) || null;
        } else {
          // Try as base SKU - find the inventory item and use unitsPerVariant=1
          inventoryItem = await storage.getInventoryItemByBaseSku(sku);
        }
        
        if (!inventoryItem) {
          results.push({ row: rowNum, sku, location: locationCode, status: "error", message: `SKU not found: ${sku}` });
          errorCount++;
          continue;
        }

        try {
          // Calculate base units
          const unitsPerVariant = variant?.unitsPerVariant || 1;
          const baseUnits = quantity * unitsPerVariant;

          // Find existing level or create new one
          const existingLevels = await storage.getInventoryLevelsByItemId(inventoryItem.id);
          const existingLevel = existingLevels.find(l => 
            l.warehouseLocationId === warehouseLocation.id && 
            (variant ? l.variantId === variant.id : !l.variantId)
          );

          if (existingLevel) {
            // Calculate delta from current value
            const currentOnHand = existingLevel.onHandBase;
            const currentVarQty = existingLevel.variantQty || 0;
            const onHandDelta = baseUnits - currentOnHand;
            const varQtyDelta = quantity - currentVarQty;

            await storage.adjustInventoryLevel(existingLevel.id, {
              onHandBase: onHandDelta,
              variantQty: varQtyDelta,
            });
          } else {
            // Create new level
            await storage.upsertInventoryLevel({
              inventoryItemId: inventoryItem.id,
              warehouseLocationId: warehouseLocation.id,
              variantId: variant?.id || null,
              variantQty: quantity,
              onHandBase: baseUnits,
              reservedBase: 0,
              pickedBase: 0,
              packedBase: 0,
              backorderBase: 0,
            });
          }

          // Log the transaction with before/after snapshots
          const baseQtyBefore = existingLevel ? existingLevel.onHandBase : 0;
          const variantQtyBefore = existingLevel ? (existingLevel.variantQty || 0) : 0;
          const baseQtyDelta = baseUnits - baseQtyBefore;
          const variantQtyDelta = quantity - variantQtyBefore;

          await inventoryService.logTransaction({
            inventoryItemId: inventoryItem.id,
            warehouseLocationId: warehouseLocation.id,
            variantId: variant?.id,
            transactionType: "csv_upload",
            reasonId: csvReason?.id,
            baseQtyDelta,
            variantQtyDelta,
            baseQtyBefore,
            baseQtyAfter: baseUnits,
            variantQtyBefore,
            variantQtyAfter: quantity,
            batchId,
            targetState: "on_hand",
            referenceType: "csv_import",
            referenceId: batchId,
            notes: `CSV import: Set ${sku} at ${locationCode} to ${quantity} units (was ${variantQtyBefore})`,
            userId,
            isImplicit: 0,
          });

          results.push({ row: rowNum, sku, location: locationCode, status: "success", message: `Updated to ${quantity} units (${baseUnits} base units)` });
          successCount++;
        } catch (err: any) {
          results.push({ row: rowNum, sku, location: locationCode, status: "error", message: err.message || "Database error" });
          errorCount++;
        }
      }

      res.json({
        success: true,
        batchId,
        summary: {
          totalRows: parsed.data.length,
          successCount,
          errorCount,
        },
        results,
      });
    } catch (error) {
      console.error("Error processing CSV upload:", error);
      res.status(500).json({ error: "Failed to process CSV upload" });
    }
  });

  // CSV Template download
  app.get("/api/inventory/csv-template", (req, res) => {
    const template = "location_code,sku,quantity\nFP-A-01,EG-SLV-STD-P100,50\nBK-B-02,EG-SLV-STD-B500,10\n";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=inventory_template.csv");
    res.send(template);
  });

  app.post("/api/inventory/receive", async (req, res) => {
    try {
      const { inventoryItemId, warehouseLocationId, variantId, variantQty, referenceId, notes } = req.body;
      const userId = req.session.user?.id;
      
      if (!inventoryItemId || !warehouseLocationId || !variantId || !variantQty || !referenceId) {
        return res.status(400).json({ error: "Missing required fields: inventoryItemId, warehouseLocationId, variantId, variantQty, referenceId" });
      }
      
      // Get the variant to calculate base units
      const variants = await storage.getUomVariantsByInventoryItemId(inventoryItemId);
      const targetVariant = variants.find(v => v.id === variantId);
      
      if (!targetVariant) {
        return res.status(400).json({ error: "Variant not found" });
      }
      
      // Calculate base units from variant quantity
      const baseUnits = variantQty * targetVariant.unitsPerVariant;
      
      await inventoryService.receiveInventory(
        inventoryItemId,
        warehouseLocationId,
        baseUnits,
        referenceId,
        notes,
        userId,
        variantId,
        variantQty
      );
      
      res.json({ success: true, baseUnitsReceived: baseUnits, variantQtyReceived: variantQty });
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
      if (req.query.channel) filters.channel = req.query.channel as string;
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
      
      // Get channel info for orders
      const channelIds = Array.from(new Set(orders.map(o => o.channelId).filter(Boolean))) as number[];
      const channelMap = new Map<number, { name: string; provider: string }>();
      
      for (const channelId of channelIds) {
        const channel = await storage.getChannelById(channelId);
        if (channel) {
          channelMap.set(channelId, { name: channel.name, provider: channel.provider });
        }
      }
      
      const ordersWithChannel = orders.map(order => {
        const channelInfo = order.channelId ? channelMap.get(order.channelId) : null;
        return {
          ...order,
          channelName: channelInfo?.name || null,
          channelProvider: channelInfo?.provider || order.source || null,
        };
      });
      
      res.json({ orders: ordersWithChannel, total });
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
      if (req.query.channel) filters.channel = req.query.channel as string;
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

  // ============================================
  // ORDER MANAGEMENT SYSTEM (OMS) API
  // ============================================

  // Get all orders with channel info (for OMS page)
  app.get("/api/oms/orders", requirePermission("orders", "view"), async (req, res) => {
    try {
      const { status, channelId, source, limit = "50", offset = "0" } = req.query;
      
      // Get all orders with items
      const statusFilter = status ? (Array.isArray(status) ? status : [status]) as string[] : undefined;
      const allOrders = await storage.getOrdersWithItems(statusFilter as any);
      
      // Get all channels for enrichment
      const allChannels = await storage.getAllChannels();
      const channelMap = new Map(allChannels.map(c => [c.id, c]));
      
      // Enrich orders with channel info and apply filters
      let enrichedOrders = allOrders.map(order => ({
        ...order,
        channel: order.channelId ? channelMap.get(order.channelId) : null
      }));
      
      // Filter by channelId if specified
      if (channelId) {
        const cid = parseInt(channelId as string);
        enrichedOrders = enrichedOrders.filter(o => o.channelId === cid);
      }
      
      // Filter by source if specified
      if (source) {
        enrichedOrders = enrichedOrders.filter(o => o.source === source);
      }
      
      // Sort by creation date descending (newest first)
      enrichedOrders.sort((a, b) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      
      // Apply pagination
      const limitNum = parseInt(limit as string);
      const offsetNum = parseInt(offset as string);
      const paginatedOrders = enrichedOrders.slice(offsetNum, offsetNum + limitNum);
      
      res.json({
        orders: paginatedOrders,
        total: enrichedOrders.length,
        limit: limitNum,
        offset: offsetNum
      });
    } catch (error) {
      console.error("Error fetching OMS orders:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  // Create a manual order
  const createOrderSchema = z.object({
    orderNumber: z.string().min(1, "Order number required"),
    customerName: z.string().min(1, "Customer name required"),
    customerEmail: z.string().email().optional().or(z.literal("")),
    customerPhone: z.string().optional(),
    channelId: z.number().optional().nullable(),
    source: z.enum(["shopify", "ebay", "amazon", "etsy", "manual", "api"]).default("manual"),
    priority: z.enum(["rush", "high", "normal"]).default("normal"),
    totalAmount: z.string().optional(),
    currency: z.string().default("USD"),
    shippingAddress: z.string().optional(),
    shippingCity: z.string().optional(),
    shippingState: z.string().optional(),
    shippingPostalCode: z.string().optional(),
    shippingCountry: z.string().optional(),
    notes: z.string().optional(),
    items: z.array(z.object({
      sku: z.string().min(1, "SKU required"),
      name: z.string().min(1, "Item name required"),
      quantity: z.number().min(1, "Quantity must be at least 1"),
      location: z.string().optional(),
      zone: z.string().optional(),
    })).min(1, "At least one item required"),
  });

  app.post("/api/oms/orders", requirePermission("orders", "edit"), async (req, res) => {
    try {
      const parseResult = createOrderSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid order data", 
          details: parseResult.error.errors 
        });
      }
      
      const data = parseResult.data;
      
      // Create order
      const orderData = {
        orderNumber: data.orderNumber,
        customerName: data.customerName,
        customerEmail: data.customerEmail || null,
        customerPhone: data.customerPhone || null,
        channelId: data.channelId || null,
        source: data.source,
        priority: data.priority,
        totalAmount: data.totalAmount || null,
        currency: data.currency,
        shippingAddress: data.shippingAddress || null,
        shippingCity: data.shippingCity || null,
        shippingState: data.shippingState || null,
        shippingPostalCode: data.shippingPostalCode || null,
        shippingCountry: data.shippingCountry || null,
        notes: data.notes || null,
        status: "ready" as const,
        itemCount: data.items.reduce((sum, item) => sum + item.quantity, 0),
        orderPlacedAt: new Date(),
        shopifyOrderId: null, // Manual orders don't have Shopify ID
        externalOrderId: null, // Manual orders don't have external ID
      };
      
      // Create items
      const itemsData = data.items.map(item => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        location: item.location || "UNASSIGNED",
        zone: item.zone || "U",
        status: "pending" as const,
      }));
      
      const order = await storage.createOrderWithItems(orderData as any, itemsData as any);
      
      res.status(201).json(order);
    } catch (error) {
      console.error("Error creating manual order:", error);
      res.status(500).json({ error: "Failed to create order" });
    }
  });

  // Get single order with channel info
  app.get("/api/oms/orders/:id", requirePermission("orders", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }
      
      const order = await storage.getOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      const items = await storage.getOrderItems(id);
      const channel = order.channelId ? await storage.getChannelById(order.channelId) : null;
      
      res.json({ ...order, items, channel });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  // Update order (for editing manual orders)
  app.put("/api/oms/orders/:id", requirePermission("orders", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }
      
      const order = await storage.getOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      const { priority, notes, status, onHold } = req.body;
      
      // Only allow updating certain fields
      const updates: any = {};
      if (priority !== undefined) updates.priority = priority;
      if (notes !== undefined) updates.notes = notes;
      if (status !== undefined) updates.status = status;
      if (onHold !== undefined) updates.onHold = onHold ? 1 : 0;
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No valid updates provided" });
      }
      
      // Use existing update methods for special fields that have side effects
      if (updates.status) {
        await storage.updateOrderStatus(id, updates.status);
        delete updates.status;
      }
      if (updates.priority) {
        await storage.setOrderPriority(id, updates.priority);
        delete updates.priority;
      }
      if (updates.onHold !== undefined) {
        if (updates.onHold) {
          await storage.holdOrder(id);
        } else {
          await storage.releaseHoldOrder(id);
        }
        delete updates.onHold;
      }
      
      // Use generic update for remaining fields (notes, etc.)
      if (Object.keys(updates).length > 0) {
        await storage.updateOrderFields(id, updates);
      }
      
      // Fetch updated order
      const updatedOrder = await storage.getOrderById(id);
      res.json(updatedOrder);
    } catch (error) {
      console.error("Error updating order:", error);
      res.status(500).json({ error: "Failed to update order" });
    }
  });

  // ============================================
  // CHANNELS MANAGEMENT API
  // ============================================
  
  // Get all channels
  app.get("/api/channels", requirePermission("channels", "view"), async (req, res) => {
    try {
      const allChannels = await storage.getAllChannels();
      
      // Enrich with connection info
      const enrichedChannels = await Promise.all(
        allChannels.map(async (channel) => {
          const connection = await storage.getChannelConnection(channel.id);
          const partnerProfile = channel.type === 'partner' 
            ? await storage.getPartnerProfile(channel.id)
            : null;
          return {
            ...channel,
            connection: connection || null,
            partnerProfile: partnerProfile || null
          };
        })
      );
      
      res.json(enrichedChannels);
    } catch (error) {
      console.error("Error fetching channels:", error);
      res.status(500).json({ error: "Failed to fetch channels" });
    }
  });
  
  // Get single channel
  app.get("/api/channels/:id", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      const connection = await storage.getChannelConnection(channelId);
      const partnerProfile = channel.type === 'partner' 
        ? await storage.getPartnerProfile(channelId)
        : null;
      
      res.json({
        ...channel,
        connection: connection || null,
        partnerProfile: partnerProfile || null
      });
    } catch (error) {
      console.error("Error fetching channel:", error);
      res.status(500).json({ error: "Failed to fetch channel" });
    }
  });
  
  // Create channel
  app.post("/api/channels", requirePermission("channels", "create"), async (req, res) => {
    try {
      const channelData = {
        ...req.body,
        priority: req.body.priority ?? 0,
        isDefault: req.body.isDefault ?? 0,
        status: req.body.status ?? "pending_setup",
      };
      
      const parseResult = insertChannelSchema.safeParse(channelData);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Invalid channel data", details: parseResult.error.errors });
      }
      
      const channel = await storage.createChannel(parseResult.data);
      res.status(201).json(channel);
    } catch (error) {
      console.error("Error creating channel:", error);
      res.status(500).json({ error: "Failed to create channel" });
    }
  });
  
  // Update channel
  app.put("/api/channels/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.updateChannel(channelId, req.body);
      
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      res.json(channel);
    } catch (error) {
      console.error("Error updating channel:", error);
      res.status(500).json({ error: "Failed to update channel" });
    }
  });
  
  // Delete channel
  app.delete("/api/channels/:id", requirePermission("channels", "delete"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const deleted = await storage.deleteChannel(channelId);
      
      if (!deleted) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting channel:", error);
      res.status(500).json({ error: "Failed to delete channel" });
    }
  });
  
  // Update channel connection
  app.put("/api/channels/:id/connection", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      const connection = await storage.upsertChannelConnection({
        channelId,
        ...req.body
      });
      
      res.json(connection);
    } catch (error) {
      console.error("Error updating channel connection:", error);
      res.status(500).json({ error: "Failed to update channel connection" });
    }
  });
  
  // Auto-setup Shopify connection using configured secrets
  app.post("/api/channels/:id/setup-shopify", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      if (channel.provider !== 'shopify') {
        return res.status(400).json({ error: "This channel is not a Shopify channel" });
      }
      
      const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
      const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
      
      if (!shopDomain || !accessToken) {
        return res.status(400).json({ 
          error: "Shopify credentials not configured",
          message: "Please set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ACCESS_TOKEN in your environment" 
        });
      }
      
      // Test the connection by fetching shop info
      const store = shopDomain.replace(/\.myshopify\.com$/, "");
      const testResponse = await fetch(
        `https://${store}.myshopify.com/admin/api/2024-01/shop.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
        }
      );
      
      if (!testResponse.ok) {
        return res.status(400).json({ 
          error: "Failed to connect to Shopify",
          message: `Shopify API returned ${testResponse.status}` 
        });
      }
      
      const shopData = await testResponse.json();
      
      // Create/update the connection
      const connection = await storage.upsertChannelConnection({
        channelId,
        shopDomain: shopDomain,
        syncStatus: 'connected',
        lastSyncAt: new Date().toISOString(),
      });
      
      // Update channel status to active
      await storage.updateChannel(channelId, { status: 'active' });
      
      res.json({ 
        success: true, 
        connection,
        shop: {
          name: shopData.shop?.name,
          domain: shopData.shop?.domain,
          email: shopData.shop?.email,
        }
      });
    } catch (error) {
      console.error("Error setting up Shopify connection:", error);
      res.status(500).json({ error: "Failed to setup Shopify connection" });
    }
  });
  
  // Update partner profile
  app.put("/api/channels/:id/partner-profile", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      
      if (!channel) {
        return res.status(404).json({ error: "Channel not found" });
      }
      
      if (channel.type !== 'partner') {
        return res.status(400).json({ error: "Partner profile only available for partner channels" });
      }
      
      const profile = await storage.upsertPartnerProfile({
        channelId,
        ...req.body
      });
      
      res.json(profile);
    } catch (error) {
      console.error("Error updating partner profile:", error);
      res.status(500).json({ error: "Failed to update partner profile" });
    }
  });
  
  // ============================================
  // CHANNEL RESERVATIONS API
  // ============================================
  
  // Get all reservations (optionally filtered by channel)
  app.get("/api/channel-reservations", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = req.query.channelId ? parseInt(req.query.channelId as string) : undefined;
      const reservations = await storage.getChannelReservations(channelId);
      res.json(reservations);
    } catch (error) {
      console.error("Error fetching reservations:", error);
      res.status(500).json({ error: "Failed to fetch reservations" });
    }
  });
  
  // Upsert reservation
  app.post("/api/channel-reservations", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const parseResult = insertChannelReservationSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ error: "Invalid reservation data", details: parseResult.error.errors });
      }
      
      const reservation = await storage.upsertChannelReservation(parseResult.data);
      res.json(reservation);
    } catch (error) {
      console.error("Error creating reservation:", error);
      res.status(500).json({ error: "Failed to create reservation" });
    }
  });
  
  // Delete reservation
  app.delete("/api/channel-reservations/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteChannelReservation(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Reservation not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting reservation:", error);
      res.status(500).json({ error: "Failed to delete reservation" });
    }
  });

  // ============================================
  // SETTINGS API
  // ============================================

  // Get all settings as key-value object
  app.get("/api/settings", requirePermission("settings", "view"), async (req, res) => {
    try {
      const result = await storage.getAllSettings();
      res.json(result);
    } catch (error) {
      console.error("Error fetching settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // Define allowed settings keys for validation
  const allowedSettingsKeys = [
    "company_name", "company_address", "company_city", "company_state", 
    "company_postal_code", "company_country", "default_timezone", 
    "default_warehouse_id", "low_stock_threshold", "critical_stock_threshold",
    "enable_low_stock_alerts", "picking_batch_size", "auto_release_delay_minutes"
  ] as const;

  const settingsUpdateSchema = z.record(
    z.enum(allowedSettingsKeys),
    z.string().nullable()
  );

  // Update settings (upsert multiple key-value pairs)
  app.put("/api/settings", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const parseResult = settingsUpdateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: "Invalid settings data", 
          details: parseResult.error.errors 
        });
      }
      const updates = parseResult.data;
      
      for (const [key, value] of Object.entries(updates)) {
        if (!key) continue;
        await storage.upsertSetting(key, value ?? null);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
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

  // Manually trigger order sync from shopify_orders to orders
  app.post("/api/debug/trigger-sync", async (req, res) => {
    try {
      const { syncNewOrders } = await import("./orderSyncListener");
      await syncNewOrders();
      res.json({ success: true, message: "Sync triggered - check logs" });
    } catch (error) {
      console.error("Debug trigger sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Debug endpoint to check order dates
  app.get("/api/debug/order-dates/:orderNumber", async (req, res) => {
    try {
      const orderNumber = req.params.orderNumber;
      const order = await db.execute(sql`
        SELECT id, order_number, order_placed_at, shopify_created_at, created_at 
        FROM orders WHERE order_number LIKE ${'%' + orderNumber}
        LIMIT 1
      `);
      if (order.rows.length === 0) {
        return res.json({ error: "Order not found" });
      }
      const row = order.rows[0] as any;
      res.json({
        orderNumber: row.order_number,
        orderPlacedAt: row.order_placed_at,
        shopifyCreatedAt: row.shopify_created_at,
        createdAt: row.created_at,
        serverNow: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // Debug endpoint to check sync status
  app.get("/api/debug/sync-status", async (req, res) => {
    try {
      // Check shopify_orders not in orders
      const missing = await db.execute<{ count: string }>(sql`
        SELECT COUNT(*) as count FROM shopify_orders 
        WHERE id NOT IN (SELECT source_table_id FROM orders WHERE source_table_id IS NOT NULL)
      `);
      
      // Get a sample of missing orders
      const sample = await db.execute<{ 
        id: string;
        order_number: string | null;
        created_at: Date | null;
      }>(sql`
        SELECT id, order_number, created_at FROM shopify_orders 
        WHERE id NOT IN (SELECT source_table_id FROM orders WHERE source_table_id IS NOT NULL)
        ORDER BY created_at DESC
        LIMIT 5
      `);
      
      // Check if sample orders have items and their fulfillment status
      const sampleWithItems = [];
      for (const order of sample.rows) {
        const items = await db.execute<{ 
          id: string;
          fulfillment_status: string | null;
          fulfillable_quantity: number | null;
          quantity: number;
        }>(sql`
          SELECT id, fulfillment_status, fulfillable_quantity, quantity FROM shopify_order_items WHERE order_id = ${order.id}
        `);
        sampleWithItems.push({
          ...order,
          items: items.rows.map(i => ({
            id: i.id,
            fulfillmentStatus: i.fulfillment_status,
            fulfillableQty: i.fulfillable_quantity,
            qty: i.quantity
          }))
        });
      }
      
      res.json({
        missingOrdersCount: parseInt(missing.rows[0].count),
        sampleMissingOrders: sampleWithItems
      });
    } catch (error) {
      console.error("Debug sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  return httpServer;
}
