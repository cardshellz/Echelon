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
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons, getUserPermissions, getUserRoles, getAllRoles, getAllPermissions, getRolePermissions, createRole, updateRolePermissions, deleteRole, assignUserRoles, hasPermission } from "./rbac";

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
  
  // Seed adjustment reasons for inventory operations
  await seedAdjustmentReasons();
  
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
      // Also filter out non-shippable items from the pick list (donations, memberships, etc.)
      const ordersWithMetadata = filteredOrders.map(order => {
        // Calculate C2P time: completedAt - shopifyCreatedAt (in milliseconds)
        let c2pMs: number | null = null;
        if (order.completedAt && order.shopifyCreatedAt) {
          c2pMs = new Date(order.completedAt).getTime() - new Date(order.shopifyCreatedAt).getTime();
        }
        
        const channelInfo = order.channelId ? channelMap.get(order.channelId) : null;
        
        // Only include items that require shipping in the pick list
        const shippableItems = order.items.filter(item => item.requiresShipping === 1);
        
        return {
          ...order,
          items: shippableItems,
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

  // Get a specific order with items (for picking - only shippable items)
  app.get("/api/picking/orders/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }
      
      const allItems = await storage.getOrderItems(id);
      // Only include items that require shipping in the pick list
      const shippableItems = allItems.filter(item => item.requiresShipping === 1);
      res.json({ ...order, items: shippableItems });
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

  // Shopify Sync API - syncs to inventory_items (grouped by product), uom_variants, catalog_products, and catalog_assets
  // Uses Shopify's natural hierarchy: Product -> Variants
  // - inventory_items: ONE per Shopify Product (parent container)
  // - uom_variants: ONE per Shopify Variant (sellable SKUs)
  // - catalog_products: ONE per Shopify Variant (storefront display)
  app.post("/api/shopify/sync", async (req, res) => {
    try {
      console.log("Starting Shopify catalog sync...");
      
      // Fetch full catalog data from Shopify
      const shopifyProducts = await fetchShopifyCatalogProducts();
      console.log(`Fetched ${shopifyProducts.length} variants from Shopify`);
      
      // Group variants by Shopify Product ID
      const productGroups = new Map<number, typeof shopifyProducts>();
      for (const variant of shopifyProducts) {
        const group = productGroups.get(variant.shopifyProductId) || [];
        group.push(variant);
        productGroups.set(variant.shopifyProductId, group);
      }
      console.log(`Grouped into ${productGroups.size} parent products`);
      
      let variantsUpdated = 0; // SKU matches found
      let catalogCreated = 0;
      let catalogUpdated = 0;
      let assetsCreated = 0;
      let skuNotFound = 0;
      const unmatchedSkus: string[] = [];
      
      for (const [shopifyProductId, variants] of productGroups) {
        // Echelon owns inventory - Shopify sync only creates catalog_products
        // and links to existing uom_variants by SKU match
        
        for (const variant of variants) {
          // Try to find existing uom_variant by SKU (Echelon is source of truth)
          let uomVariant = null;
          let inventoryItemId = null;
          
          if (variant.sku) {
            uomVariant = await storage.getUomVariantBySku(variant.sku);
            if (uomVariant) {
              inventoryItemId = uomVariant.inventoryItemId;
              variantsUpdated++; // Found existing match
            } else {
              skuNotFound++;
              unmatchedSkus.push(variant.sku);
            }
          } else {
            skuNotFound++;
            unmatchedSkus.push(`(no SKU) ${variant.title}`);
          }
          
          // Create/update catalog_product (channel data) - always happens
          // Links to uom_variant only if SKU match found
          const existingCatalog = await storage.getCatalogProductByVariantId(variant.variantId);
          const catalogProduct = await storage.upsertCatalogProductByVariantId(variant.variantId, inventoryItemId, {
            sku: variant.sku,
            title: variant.title,
            description: variant.description,
            brand: variant.vendor,
            category: variant.productType,
            tags: variant.tags,
            status: variant.status,
            uomVariantId: uomVariant?.id || null, // Only link if match found
          });
          
          if (existingCatalog) {
            catalogUpdated++;
          } else {
            catalogCreated++;
          }
          
          // 4. Sync catalog_assets (images)
          await storage.deleteCatalogAssetsByProductId(catalogProduct.id);
          
          for (let i = 0; i < variant.allImages.length; i++) {
            const img = variant.allImages[i];
            await storage.createCatalogAsset({
              catalogProductId: catalogProduct.id,
              assetType: "image",
              url: img.url,
              position: img.position,
              isPrimary: i === 0 ? 1 : 0,
            });
            assetsCreated++;
          }
          
          // 5. Also sync to product_locations for warehouse assignment (only if has SKU)
          if (variant.sku) {
            await storage.upsertProductLocationBySku(variant.sku, variant.title, variant.status, variant.imageUrl || undefined, variant.barcode || undefined);
          }
        }
      }
      
      console.log(`Sync complete: ${variantsUpdated} SKUs matched, ${skuNotFound} unmatched, catalog ${catalogCreated} created/${catalogUpdated} updated, ${assetsCreated} assets`);
      if (unmatchedSkus.length > 0) {
        console.log(`Unmatched SKUs (need to be created in Echelon first):`, unmatchedSkus.slice(0, 20));
      }
      
      res.json({
        success: true,
        skuMatched: variantsUpdated,
        skuNotFound: skuNotFound,
        unmatchedSkus: unmatchedSkus.slice(0, 50), // Return first 50 for UI display
        catalog: { created: catalogCreated, updated: catalogUpdated },
        assets: assetsCreated,
        totalProducts: productGroups.size,
        totalVariants: shopifyProducts.length,
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
        ["code", "zone", "aisle", "bay", "level", "bin", "name", "location_type", "is_pickable", "pick_sequence", "min_qty", "max_qty"].join(",")
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
          loc.pickSequence ?? "",
          loc.minQty ?? "",
          loc.maxQty ?? ""
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

  // Bulk import warehouse locations from CSV (upsert - updates existing, creates new)
  app.post("/api/warehouse/locations/bulk-import", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { locations, warehouseId } = req.body;
      if (!Array.isArray(locations) || locations.length === 0) {
        return res.status(400).json({ error: "No locations provided" });
      }
      
      const results = { created: 0, updated: 0, errors: [] as string[] };
      
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
          
          // Generate the code to check if location exists
          const codeParts = [zone, aisle, bay, level, bin].filter(Boolean);
          const code = loc.code?.trim() || codeParts.join("-");
          
          // Check if location with this code already exists
          const existingLocations = await storage.getAllWarehouseLocations();
          const existing = existingLocations.find(l => l.code === code);
          
          const locationData = {
            zone,
            aisle,
            bay,
            level,
            bin,
            name: loc.name?.trim() || null,
            locationType: (loc.locationType || loc.location_type || "bin").trim(),
            isPickable: loc.isPickable !== undefined || loc.is_pickable !== undefined 
              ? parseInt(loc.isPickable ?? loc.is_pickable) 
              : (existing?.isPickable ?? 1),
            pickSequence: loc.pickSequence || loc.pick_sequence 
              ? parseInt(loc.pickSequence || loc.pick_sequence) 
              : (existing?.pickSequence ?? null),
            minQty: loc.minQty || loc.min_qty 
              ? parseInt(loc.minQty || loc.min_qty) 
              : (existing?.minQty ?? null),
            maxQty: loc.maxQty || loc.max_qty 
              ? parseInt(loc.maxQty || loc.max_qty) 
              : (existing?.maxQty ?? null),
            warehouseId: effectiveWarehouseId ?? existing?.warehouseId ?? null,
          };
          
          if (existing) {
            // Update existing location
            await storage.updateWarehouseLocation(existing.id, locationData);
            results.updated++;
          } else {
            // Create new location
            await storage.createWarehouseLocation(locationData);
            results.created++;
          }
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
      console.log(`[DEBUG] Fetching products for warehouse_location_id: ${warehouseLocationId}`);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }
      const products = await storage.getProductLocationsByWarehouseLocationId(warehouseLocationId);
      console.log(`[DEBUG] Found ${products.length} products for location ${warehouseLocationId}`);
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

  app.patch("/api/inventory/variants/:variantId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const variantId = parseInt(req.params.variantId);
      const { unitsPerVariant } = req.body;
      
      if (!unitsPerVariant || unitsPerVariant < 1) {
        return res.status(400).json({ error: "unitsPerVariant must be at least 1" });
      }
      
      const updated = await storage.updateUomVariant(variantId, { unitsPerVariant });
      if (!updated) {
        return res.status(404).json({ error: "Variant not found" });
      }
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating variant:", error);
      res.status(500).json({ error: "Failed to update variant" });
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

  // Search SKUs for typeahead (used in cycle counts, receiving, etc.)
  // Model A architecture: uom_variants is source of truth for sellable SKUs
  app.get("/api/inventory/skus/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim().toLowerCase();
      const limit = parseInt(String(req.query.limit)) || 20;
      
      if (!query) {
        return res.json([]);
      }
      
      const searchPattern = `%${query}%`;
      
      // Source of truth: uom_variants (sellable SKUs with inventory_item linkage)
      // Join with catalog_products to get catalogProductId if available
      const result = await db.execute<{
        sku: string;
        name: string;
        source: string;
        catalogProductId: number | null;
        inventoryItemId: number;
        uomVariantId: number;
        unitsPerVariant: number;
      }>(sql`
        SELECT 
          uv.sku as sku,
          uv.name as name,
          'uom_variant' as source,
          cp.id as "catalogProductId",
          uv.inventory_item_id as "inventoryItemId",
          uv.id as "uomVariantId",
          uv.units_per_variant as "unitsPerVariant"
        FROM uom_variants uv
        LEFT JOIN catalog_products cp ON cp.sku = uv.sku
        WHERE uv.active = 1
          AND uv.sku IS NOT NULL
          AND (
            LOWER(uv.sku) LIKE ${searchPattern} OR
            LOWER(uv.name) LIKE ${searchPattern}
          )
        ORDER BY uv.sku
        LIMIT ${limit}
      `);
      
      res.json(result.rows);
    } catch (error) {
      console.error("Error searching SKUs:", error);
      res.status(500).json({ error: "Failed to search SKUs" });
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
          // Both variantQty and onHandBase track the same value (variant count)
          // This ensures consistency across the system
          const targetQty = quantity;

          // Find existing level or create new one
          const existingLevels = await storage.getInventoryLevelsByItemId(inventoryItem.id);
          const existingLevel = existingLevels.find(l => 
            l.warehouseLocationId === warehouseLocation.id && 
            (variant ? l.variantId === variant.id : !l.variantId)
          );

          if (existingLevel) {
            // Calculate delta from current value
            const currentQty = existingLevel.onHandBase;
            const currentVarQty = existingLevel.variantQty || 0;
            const qtyDelta = targetQty - currentQty;
            const varQtyDelta = targetQty - currentVarQty;

            await storage.adjustInventoryLevel(existingLevel.id, {
              onHandBase: qtyDelta,
              variantQty: varQtyDelta,
            });
          } else {
            // Create new level - both fields track variant count
            await storage.upsertInventoryLevel({
              inventoryItemId: inventoryItem.id,
              warehouseLocationId: warehouseLocation.id,
              variantId: variant?.id || null,
              variantQty: targetQty,
              onHandBase: targetQty,
              reservedBase: 0,
              pickedBase: 0,
              packedBase: 0,
              backorderBase: 0,
            });
          }

          // Log the transaction with before/after snapshots
          const baseQtyBefore = existingLevel ? existingLevel.onHandBase : 0;
          const variantQtyBefore = existingLevel ? (existingLevel.variantQty || 0) : 0;
          const baseQtyDelta = targetQty - baseQtyBefore;
          const variantQtyDelta = targetQty - variantQtyBefore;

          // Log with Full WMS fields
          await inventoryService.logTransaction({
            inventoryItemId: inventoryItem.id,
            toLocationId: warehouseLocation.id, // CSV import = TO location (adding/setting inventory)
            warehouseLocationId: warehouseLocation.id, // Legacy
            variantId: variant?.id,
            transactionType: "csv_upload",
            reasonId: csvReason?.id,
            variantQtyDelta,
            variantQtyBefore,
            variantQtyAfter: targetQty,
            baseQtyDelta,
            baseQtyBefore,
            baseQtyAfter: targetQty,
            batchId,
            sourceState: "external",
            targetState: "on_hand",
            referenceType: "csv_import",
            referenceId: batchId,
            notes: `CSV import: Set ${sku} at ${locationCode} to ${targetQty} units (was ${variantQtyBefore})`,
            userId,
            isImplicit: 0,
          });

          results.push({ row: rowNum, sku, location: locationCode, status: "success", message: `Updated to ${targetQty} units` });
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
    if (!req.session.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    try {
      const { variantId, warehouseLocationId, quantity, referenceId, notes } = req.body;
      const userId = req.session.user.id;
      
      if (!variantId || !warehouseLocationId || !quantity) {
        return res.status(400).json({ error: "Missing required fields: variantId, warehouseLocationId, quantity" });
      }
      
      // Get the variant by ID directly (more efficient than getting all)
      const targetVariant = await storage.getUomVariantById(variantId);
      
      if (!targetVariant) {
        return res.status(404).json({ error: "Variant not found" });
      }
      
      if (!targetVariant.active) {
        return res.status(400).json({ error: "Cannot receive stock for inactive variant" });
      }
      
      // Verify warehouse location exists
      const location = await storage.getWarehouseLocationById(warehouseLocationId);
      if (!location) {
        return res.status(404).json({ error: "Warehouse location not found" });
      }
      
      const inventoryItemId = targetVariant.inventoryItemId;
      const variantQty = quantity;
      
      // Calculate base units: variantQty × unitsPerVariant
      const baseUnits = variantQty * targetVariant.unitsPerVariant;
      
      // Generate a reference ID if not provided
      const refId = referenceId || `RCV-${Date.now()}`;
      
      await inventoryService.receiveInventory(
        inventoryItemId,
        warehouseLocationId,
        baseUnits,
        refId,
        notes || "Stock received via UI",
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

  // Get inventory levels by variant ID (for expandable location breakdown)
  app.get("/api/inventory/variants/:variantId/locations", async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId) || variantId <= 0) {
        return res.status(400).json({ error: "Invalid variant ID" });
      }
      
      // Verify variant exists
      const variant = await storage.getUomVariantById(variantId);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }
      
      const levels = await storage.getInventoryLevelsByVariantId(variantId);
      
      // Join with warehouse locations to get location codes
      const locations = await storage.getAllWarehouseLocations();
      const locationMap = new Map(locations.map(l => [l.id, l]));
      
      const result = levels.map(level => ({
        ...level,
        location: locationMap.get(level.warehouseLocationId)
      }));
      
      res.json(result);
    } catch (error) {
      console.error("Error getting variant locations:", error);
      res.status(500).json({ error: "Failed to get variant locations" });
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
    "enable_low_stock_alerts", "allow_multiple_skus_per_bin", "picking_batch_size", 
    "auto_release_delay_minutes"
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

  // ============================================
  // INVENTORY MANAGEMENT (User-Friendly API)
  // ============================================

  // Get all inventory levels - variant-centric view (storable units: packs, boxes, cases)
  // Groups by variant SKU with aggregated quantities across all locations
  //
  // WMS INVENTORY STATES:
  // =====================
  // 1. Qty (On Hand) = Total physical inventory across ALL locations (variant_qty)
  // 2. Pickable = Inventory in forward pick locations only (is_pickable = 1)
  // 3. Committed = Allocated to orders BEFORE picking (order placed, waiting to be picked)
  //    - Comes from order_items.quantity where order status = pending/ready/assigned
  //    - Does NOT include items already being picked or picked
  // 4. Picked = Items currently being picked or picked but not shipped
  //    - Comes from order_items.picked_quantity where order not yet completed
  // 5. Available = Qty - Committed - Picked (what can still be sold)
  //
  app.get("/api/inventory/levels", requirePermission("inventory", "view"), async (req, res) => {
    try {
      // Step 1: Get inventory quantities from inventory_levels (variant_qty only)
      // Pickable = variant_qty where warehouse_locations.is_pickable = 1
      const inventoryResult = await db.execute<{
        variant_id: number;
        variant_sku: string;
        variant_name: string;
        units_per_variant: number;
        base_sku: string | null;
        total_variant_qty: string;
        location_count: string;
        pickable_variant_qty: string;
      }>(sql`
        SELECT 
          uv.id as variant_id,
          uv.sku as variant_sku,
          uv.name as variant_name,
          uv.units_per_variant,
          ii.base_sku,
          COALESCE(SUM(il.variant_qty), 0) as total_variant_qty,
          COUNT(DISTINCT il.warehouse_location_id) as location_count,
          COALESCE(SUM(CASE WHEN wl.is_pickable = 1 THEN il.variant_qty ELSE 0 END), 0) as pickable_variant_qty
        FROM uom_variants uv
        LEFT JOIN inventory_items ii ON uv.inventory_item_id = ii.id
        LEFT JOIN inventory_levels il ON il.variant_id = uv.id
        LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE uv.active = 1
        GROUP BY uv.id, uv.sku, uv.name, uv.units_per_variant, ii.base_sku
        ORDER BY uv.sku
      `);
      
      // Step 2: Get COMMITTED quantities from order_items
      // Committed = items on orders that are waiting to be picked (not yet in picking process)
      // Order statuses: pending, ready, assigned = order placed but not being picked yet
      const committedResult = await db.execute<{
        sku: string;
        committed_qty: string;
      }>(sql`
        SELECT 
          oi.sku,
          COALESCE(SUM(oi.quantity), 0) as committed_qty
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE o.status IN ('pending', 'ready', 'assigned')
          AND oi.requires_shipping = 1
          AND COALESCE(oi.picked_quantity, 0) = 0
        GROUP BY oi.sku
      `);
      
      // Step 3: Get PICKED quantities from order_items
      // Picked = items that have been picked but order not yet shipped/completed
      const pickedResult = await db.execute<{
        sku: string;
        picked_qty: string;
      }>(sql`
        SELECT 
          oi.sku,
          COALESCE(SUM(oi.picked_quantity), 0) as picked_qty
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        WHERE o.status IN ('pending', 'ready', 'assigned', 'picking', 'picked', 'packing')
          AND oi.requires_shipping = 1
          AND COALESCE(oi.picked_quantity, 0) > 0
        GROUP BY oi.sku
      `);
      
      // Build maps of SKU -> qty
      const committedBySku = new Map<string, number>();
      for (const row of committedResult.rows) {
        committedBySku.set(row.sku, parseInt(row.committed_qty) || 0);
      }
      
      const pickedBySku = new Map<string, number>();
      for (const row of pickedResult.rows) {
        pickedBySku.set(row.sku, parseInt(row.picked_qty) || 0);
      }
      
      const levels = inventoryResult.rows.map(row => {
        const variantQty = parseInt(row.total_variant_qty) || 0;
        const unitsPerVariant = row.units_per_variant || 1;
        const pickableQty = parseInt(row.pickable_variant_qty) || 0;
        const sku = row.variant_sku;
        
        // Get committed and picked from orders
        const committed = committedBySku.get(sku) || 0;
        const picked = pickedBySku.get(sku) || 0;
        
        // Available = Qty - Committed - Picked
        const available = variantQty - committed - picked;
        
        return {
          variantId: row.variant_id,
          sku,
          name: row.variant_name,
          unitsPerVariant,
          baseSku: row.base_sku,
          variantQty,
          onHandBase: 0, // Not used - no base units in display
          reservedBase: committed, // "Committed" for display (field name kept for compatibility)
          pickedBase: picked, // "Picked" for display
          available,
          totalPieces: 0, // Not used
          locationCount: parseInt(row.location_count) || 0,
          pickableQty,
        };
      });
      
      res.json(levels);
    } catch (error) {
      console.error("Error fetching inventory levels:", error);
      res.status(500).json({ error: "Failed to fetch inventory levels" });
    }
  });

  // Get inventory breakdown by location for a specific variant
  app.get("/api/inventory/levels/:variantId/locations", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const variantId = parseInt(req.params.variantId);
      
      const result = await db.execute<{
        id: number;
        warehouse_location_id: number;
        location_code: string | null;
        zone: string | null;
        variant_qty: number;
        on_hand_base: number;
        reserved_base: number;
        picked_base: number;
      }>(sql`
        SELECT 
          il.id,
          il.warehouse_location_id,
          wl.code as location_code,
          wl.zone,
          il.variant_qty,
          il.on_hand_base,
          il.reserved_base,
          il.picked_base
        FROM inventory_levels il
        LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_id = ${variantId}
        ORDER BY wl.code
      `);
      
      const locations = result.rows.map(row => ({
        id: row.id,
        warehouseLocationId: row.warehouse_location_id,
        locationCode: row.location_code,
        zone: row.zone,
        variantQty: row.variant_qty,
        onHandBase: row.on_hand_base,
        reservedBase: row.reserved_base,
        pickedBase: row.picked_base,
        available: row.on_hand_base - row.reserved_base - row.picked_base,
      }));
      
      res.json(locations);
    } catch (error) {
      console.error("Error fetching variant locations:", error);
      res.status(500).json({ error: "Failed to fetch variant locations" });
    }
  });

  // Add inventory to a bin (simplified receipt) - variant-centric
  app.post("/api/inventory/add-stock", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { variantId, warehouseLocationId, variantQty, notes } = req.body;
      const userId = req.session.user?.id;
      
      if (!variantId || !warehouseLocationId || variantQty === undefined) {
        return res.status(400).json({ error: "Missing required fields: variantId, warehouseLocationId, variantQty" });
      }
      
      // Get the variant to find its inventory_item_id and units_per_variant
      const variant = await storage.getUomVariantById(variantId);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }
      
      // Calculate base units from variant quantity
      const baseUnits = variantQty * variant.unitsPerVariant;
      
      // Check if inventory level exists for this variant at this location
      let existingLevel = await storage.getInventoryLevelByLocationAndVariant(warehouseLocationId, variantId);
      
      if (existingLevel) {
        // Update existing level - add to current quantities
        await storage.adjustInventoryLevel(existingLevel.id, {
          variantQty: variantQty,
          onHandBase: baseUnits,
        });
      } else {
        // Use the inventory service to create new inventory level
        await inventoryService.receiveInventory(
          variant.inventoryItemId,
          warehouseLocationId,
          baseUnits,
          "MANUAL_ADD",
          notes || "Stock added via inventory page",
          userId
        );
        
        // Update the newly created level with variant info
        const levels = await storage.getInventoryLevelsByItemId(variant.inventoryItemId);
        const newLevel = levels.find(l => l.warehouseLocationId === warehouseLocationId);
        if (newLevel) {
          await storage.updateInventoryLevel(newLevel.id, {
            variantId: variantId,
            variantQty: variantQty,
          });
        }
      }
      
      res.json({ success: true, variantQtyAdded: variantQty, baseUnitsAdded: baseUnits });
    } catch (error) {
      console.error("Error adding stock:", error);
      res.status(500).json({ error: "Failed to add stock" });
    }
  });

  // Adjust inventory with reason code - variant-centric
  app.post("/api/inventory/adjust-stock", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { variantId, warehouseLocationId, variantQtyDelta, reasonCode, notes } = req.body;
      const userId = req.session.user?.id;
      
      if (!variantId || !warehouseLocationId || variantQtyDelta === undefined || !reasonCode) {
        return res.status(400).json({ error: "Missing required fields: variantId, warehouseLocationId, variantQtyDelta, reasonCode" });
      }
      
      // Get the variant to find its inventory_item_id and units_per_variant
      const variant = await storage.getUomVariantById(variantId);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }
      
      // Calculate base units from variant quantity delta
      const baseUnitsDelta = variantQtyDelta * variant.unitsPerVariant;
      
      // Find the inventory level for this variant at this location
      const existingLevel = await storage.getInventoryLevelByLocationAndVariant(warehouseLocationId, variantId);
      
      if (!existingLevel) {
        return res.status(404).json({ error: "No inventory level found for this variant at this location" });
      }
      
      // Use the inventory service to adjust base units
      await inventoryService.adjustInventory(
        variant.inventoryItemId,
        warehouseLocationId,
        baseUnitsDelta,
        reasonCode,
        userId,
        notes
      );
      
      // Also adjust the variant qty
      await storage.adjustInventoryLevel(existingLevel.id, {
        variantQty: variantQtyDelta,
      });
      
      res.json({ success: true, variantQtyDelta, baseUnitsDelta });
    } catch (error) {
      console.error("Error adjusting stock:", error);
      res.status(500).json({ error: "Failed to adjust stock" });
    }
  });

  // CSV import for bulk inventory upload - variant-centric
  // CSV format: variant_sku, location_code, variant_qty
  app.post("/api/inventory/import-csv", requirePermission("inventory", "upload"), upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }
      
      const userId = req.session.user?.id;
      const csvContent = req.file.buffer.toString("utf-8");
      const { data, errors } = Papa.parse<{ sku: string; location_code: string; quantity: string }>(csvContent, {
        header: true,
        skipEmptyLines: true,
      });
      
      if (errors.length > 0) {
        return res.status(400).json({ error: "CSV parse error", details: errors });
      }
      
      const results = {
        processed: 0,
        created: 0,
        updated: 0,
        errors: [] as string[],
      };
      
      for (const row of data) {
        try {
          const sku = row.sku?.trim();
          const locationCode = row.location_code?.trim();
          const variantQty = parseInt(row.quantity, 10);
          
          if (!sku || !locationCode || isNaN(variantQty)) {
            results.errors.push(`Invalid row: SKU=${sku}, Location=${locationCode}, Qty=${row.quantity}`);
            continue;
          }
          
          // Find variant by SKU (storable unit like pack/case)
          const variant = await storage.getUomVariantBySku(sku);
          
          if (!variant) {
            results.errors.push(`Variant not found: ${sku}`);
            continue;
          }
          
          // Find location by code
          const location = await storage.getWarehouseLocationByCode(locationCode);
          if (!location) {
            results.errors.push(`Location not found: ${locationCode}`);
            continue;
          }
          
          // Calculate base units from variant quantity
          const baseUnits = variantQty * variant.unitsPerVariant;
          
          // Check if inventory level exists for this variant at this location
          const existingLevel = await storage.getInventoryLevelByLocationAndVariant(location.id, variant.id);
          
          if (existingLevel) {
            // Calculate delta to reach target quantity (in base units)
            const targetBaseUnits = variantQty * variant.unitsPerVariant;
            const delta = targetBaseUnits - existingLevel.onHandBase;
            if (delta !== 0) {
              await inventoryService.adjustInventory(
                variant.inventoryItemId,
                location.id,
                delta,
                "CSV_UPLOAD",
                userId
              );
              // Update variant qty
              await storage.updateInventoryLevel(existingLevel.id, {
                variantQty: variantQty,
              });
              results.updated++;
            }
          } else {
            // Create new inventory level
            await inventoryService.receiveInventory(
              variant.inventoryItemId,
              location.id,
              baseUnits,
              "CSV_UPLOAD",
              "Initial inventory from CSV import",
              userId
            );
            // Update the newly created level with variant info
            const levels = await storage.getInventoryLevelsByItemId(variant.inventoryItemId);
            const newLevel = levels.find(l => l.warehouseLocationId === location.id);
            if (newLevel) {
              await storage.updateInventoryLevel(newLevel.id, {
                variantId: variant.id,
                variantQty: variantQty,
              });
            }
            results.created++;
          }
          
          results.processed++;
        } catch (rowError) {
          results.errors.push(`Error processing row: ${JSON.stringify(row)} - ${rowError}`);
        }
      }
      
      res.json(results);
    } catch (error) {
      console.error("Error importing inventory CSV:", error);
      res.status(500).json({ error: "Failed to import CSV" });
    }
  });

  // CSV template for inventory import - variant-centric
  app.get("/api/inventory/import-template", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=inventory_import_template.csv");
    res.send("sku,location_code,quantity\nSKU-001,A-01-01,100\nSKU-002,A-01-02,50");
  });

  // ============================================
  // CYCLE COUNTS (Inventory Reconciliation)
  // ============================================

  // Get all cycle counts
  app.get("/api/cycle-counts", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const counts = await storage.getAllCycleCounts();
      res.json(counts);
    } catch (error) {
      console.error("Error fetching cycle counts:", error);
      res.status(500).json({ error: "Failed to fetch cycle counts" });
    }
  });

  // Get single cycle count with items
  app.get("/api/cycle-counts/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const cycleCount = await storage.getCycleCountById(id);
      
      if (!cycleCount) {
        return res.status(404).json({ error: "Cycle count not found" });
      }
      
      const items = await storage.getCycleCountItems(id);
      
      // Enrich items with location details
      const enrichedItems = await Promise.all(items.map(async (item) => {
        const location = await storage.getWarehouseLocationById(item.warehouseLocationId);
        return {
          ...item,
          locationCode: location?.code,
          zone: location?.zone,
        };
      }));
      
      res.json({ ...cycleCount, items: enrichedItems });
    } catch (error) {
      console.error("Error fetching cycle count:", error);
      res.status(500).json({ error: "Failed to fetch cycle count" });
    }
  });

  // Create new cycle count
  app.post("/api/cycle-counts", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const userId = req.session.user?.id;
      const { name, description, warehouseId, zoneFilter } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Name is required" });
      }
      
      const cycleCount = await storage.createCycleCount({
        name,
        description,
        warehouseId: warehouseId || null,
        zoneFilter: zoneFilter || null,
        status: "draft",
        createdBy: userId,
      });
      
      res.status(201).json(cycleCount);
    } catch (error) {
      console.error("Error creating cycle count:", error);
      res.status(500).json({ error: "Failed to create cycle count" });
    }
  });

  // Initialize cycle count with bins (generates items from current inventory)
  app.post("/api/cycle-counts/:id/initialize", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const cycleCount = await storage.getCycleCountById(id);
      
      if (!cycleCount) {
        return res.status(404).json({ error: "Cycle count not found" });
      }
      
      if (cycleCount.status !== "draft") {
        return res.status(400).json({ error: "Can only initialize draft cycle counts" });
      }
      
      // Get all warehouse locations (filtered by zone if specified)
      let locations = await storage.getAllWarehouseLocations();
      if (cycleCount.zoneFilter) {
        locations = locations.filter(l => l.zone === cycleCount.zoneFilter);
      }
      if (cycleCount.warehouseId) {
        locations = locations.filter(l => l.warehouseId === cycleCount.warehouseId);
      }
      
      // For each location, get current inventory and create count items
      const items: any[] = [];
      
      for (const location of locations) {
        // Get inventory levels at this location with actual stock
        // Primary path: inventory_items.base_sku (always populated)
        // Fallback: catalog_products.sku via inventory_item_id link
        const result = await db.execute<{
          inventory_item_id: number;
          variant_qty: number;
          catalog_product_id: number | null;
          sku: string | null;
        }>(sql`
          SELECT 
            il.inventory_item_id,
            il.variant_qty,
            cp.id as catalog_product_id,
            COALESCE(cp.sku, ii.base_sku) as sku
          FROM inventory_levels il
          LEFT JOIN inventory_items ii ON il.inventory_item_id = ii.id
          LEFT JOIN catalog_products cp ON cp.inventory_item_id = ii.id
          WHERE il.warehouse_location_id = ${location.id}
            AND il.variant_qty > 0
        `);
        
        if (result.rows.length > 0) {
          // Has inventory - create item for each product
          for (const row of result.rows) {
            items.push({
              cycleCountId: id,
              warehouseLocationId: location.id,
              inventoryItemId: row.inventory_item_id,
              catalogProductId: row.catalog_product_id,
              expectedSku: row.sku,
              expectedQty: row.variant_qty,
              status: "pending",
            });
          }
        } else {
          // Empty bin - still create item to verify it's empty
          items.push({
            cycleCountId: id,
            warehouseLocationId: location.id,
            inventoryItemId: null,
            catalogProductId: null,
            expectedSku: null,
            expectedQty: 0,
            status: "pending",
          });
        }
      }
      
      // Bulk create items
      if (items.length > 0) {
        await storage.bulkCreateCycleCountItems(items);
      }
      
      // Update cycle count status and counts
      await storage.updateCycleCount(id, {
        status: "in_progress",
        totalBins: locations.length,
        countedBins: 0,
        startedAt: new Date(),
      });
      
      res.json({ success: true, binsCreated: locations.length, itemsCreated: items.length });
    } catch (error) {
      console.error("Error initializing cycle count:", error);
      res.status(500).json({ error: "Failed to initialize cycle count" });
    }
  });

  // Record count for a bin
  app.post("/api/cycle-counts/:id/items/:itemId/count", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const userId = req.session.user?.id;
      const { countedSku, countedQty, notes } = req.body;
      
      const item = await storage.getCycleCountItemById(itemId);
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      // Calculate variance
      const varianceQty = (countedQty ?? 0) - (item.expectedQty ?? 0);
      let varianceType: string | null = null;
      let createdFoundItem = false;
      
      // Detect variance type
      const isSkuMismatch = countedSku && item.expectedSku && countedSku.toUpperCase() !== item.expectedSku.toUpperCase();
      
      if (isSkuMismatch) {
        // SKU MISMATCH WORKFLOW: Create TWO linked items
        // 1. Mark original item as "expected_missing" (expected product not found)
        // 2. Create NEW item for the "unexpected_found" product
        
        varianceType = "sku_mismatch";
        
        // Update original item as MISSING (expected SKU not found, qty = 0)
        await storage.updateCycleCountItem(itemId, {
          countedSku: null, // Not found
          countedQty: 0, // Zero - it's not there
          varianceQty: -(item.expectedQty ?? 0), // Full negative variance
          varianceType: "missing_item",
          varianceNotes: `Expected ${item.expectedSku} not found. Different SKU (${countedSku}) was in bin. ${notes || ''}`.trim(),
          status: "variance",
          requiresApproval: 1,
          mismatchType: "expected_missing",
          countedBy: userId,
          countedAt: new Date(),
        });
        
        // Look up inventory item for the found SKU
        const foundInventoryResult = await db.execute<{ id: number }>(sql`
          SELECT id FROM inventory_items WHERE base_sku = ${countedSku} LIMIT 1
        `);
        const foundInventoryItemId = foundInventoryResult.rows[0]?.id || null;
        
        // Look up catalog product for the found SKU
        const foundCatalogResult = await db.execute<{ id: number }>(sql`
          SELECT id FROM catalog_products WHERE sku = ${countedSku} LIMIT 1
        `);
        const foundCatalogProductId = foundCatalogResult.rows[0]?.id || null;
        
        // Create NEW item for the FOUND product (unexpected item in this bin)
        const foundItemResult = await db.execute<{ id: number }>(sql`
          INSERT INTO cycle_count_items (
            cycle_count_id, warehouse_location_id, inventory_item_id, catalog_product_id,
            expected_sku, expected_qty, counted_sku, counted_qty,
            variance_qty, variance_type, variance_notes, status,
            requires_approval, mismatch_type, related_item_id,
            counted_by, counted_at, created_at
          ) VALUES (
            ${item.cycleCountId}, ${item.warehouseLocationId}, ${foundInventoryItemId}, ${foundCatalogProductId},
            NULL, 0, ${countedSku}, ${countedQty},
            ${countedQty}, 'unexpected_item', ${`Found in bin where ${item.expectedSku} was expected. ${notes || ''}`.trim()}, 'variance',
            1, 'unexpected_found', ${itemId},
            ${userId}, NOW(), NOW()
          ) RETURNING id
        `);
        
        const foundItemId = foundItemResult.rows[0]?.id;
        
        // Link original item to the found item
        if (foundItemId) {
          await storage.updateCycleCountItem(itemId, {
            relatedItemId: foundItemId,
          });
          createdFoundItem = true;
        }
        
      } else if (countedQty > 0 && !item.expectedSku) {
        varianceType = "unexpected_item";
        await storage.updateCycleCountItem(itemId, {
          countedSku: countedSku || null,
          countedQty,
          varianceQty,
          varianceType,
          varianceNotes: notes || null,
          status: "variance",
          requiresApproval: 1,
          mismatchType: "unexpected_found",
          countedBy: userId,
          countedAt: new Date(),
        });
      } else {
        // Normal count (same SKU or empty bin)
        if (countedQty === 0 && item.expectedQty > 0) {
          varianceType = "missing_item";
        } else if (varianceQty > 0) {
          varianceType = "quantity_over";
        } else if (varianceQty < 0) {
          varianceType = "quantity_under";
        }
        
        const requiresApproval = Math.abs(varianceQty) > 10;
        
        await storage.updateCycleCountItem(itemId, {
          countedSku: countedSku || null,
          countedQty,
          varianceQty,
          varianceType,
          varianceNotes: notes || null,
          status: varianceType ? "variance" : "counted",
          requiresApproval: requiresApproval ? 1 : 0,
          countedBy: userId,
          countedAt: new Date(),
        });
      }
      
      // Update cycle count progress
      const cycleCount = await storage.getCycleCountById(item.cycleCountId);
      if (cycleCount) {
        const allItems = await storage.getCycleCountItems(item.cycleCountId);
        const countedCount = allItems.filter(i => i.status !== "pending").length;
        const varianceCount = allItems.filter(i => i.varianceType).length;
        
        await storage.updateCycleCount(item.cycleCountId, {
          countedBins: countedCount,
          varianceCount,
        });
      }
      
      res.json({ 
        success: true, 
        varianceType, 
        varianceQty, 
        requiresApproval: true,
        skuMismatch: isSkuMismatch,
        createdFoundItem
      });
    } catch (error) {
      console.error("Error recording count:", error);
      res.status(500).json({ error: "Failed to record count" });
    }
  });

  // Approve variance and apply adjustment
  app.post("/api/cycle-counts/:id/items/:itemId/approve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const userId = req.session.user?.id;
      const { reasonCode, notes } = req.body;
      
      const item = await storage.getCycleCountItemById(itemId);
      if (!item) {
        return res.status(404).json({ error: "Item not found" });
      }
      
      if (!item.varianceType) {
        return res.status(400).json({ error: "No variance to approve" });
      }
      
      // Track adjustments made for audit response
      const adjustmentsMade: any[] = [];
      
      // Apply inventory adjustment if we have an inventory item
      if (item.inventoryItemId && item.varianceQty !== null && item.varianceQty !== 0) {
        await inventoryService.adjustInventory(
          item.inventoryItemId,
          item.warehouseLocationId,
          item.varianceQty,
          reasonCode || "CYCLE_COUNT",
          userId,
          `Cycle count adjustment: ${item.expectedSku || item.countedSku}. ${notes || ''}`
        );
        adjustmentsMade.push({
          sku: item.expectedSku || item.countedSku,
          type: item.mismatchType || item.varianceType,
          qtyChange: item.varianceQty,
          locationId: item.warehouseLocationId
        });
      }
      
      // Update item as approved
      await storage.updateCycleCountItem(itemId, {
        status: "approved",
        approvedBy: userId,
        approvedAt: new Date(),
        varianceReason: reasonCode,
      });
      
      // MISMATCH WORKFLOW: If this item has a related item, approve it too
      if (item.relatedItemId) {
        const relatedItem = await storage.getCycleCountItemById(item.relatedItemId);
        
        if (relatedItem && relatedItem.status !== "approved") {
          // Apply adjustment for the related item too
          if (relatedItem.inventoryItemId && relatedItem.varianceQty !== null && relatedItem.varianceQty !== 0) {
            await inventoryService.adjustInventory(
              relatedItem.inventoryItemId,
              relatedItem.warehouseLocationId,
              relatedItem.varianceQty,
              reasonCode || "CYCLE_COUNT",
              userId,
              `Cycle count adjustment (linked mismatch): ${relatedItem.expectedSku || relatedItem.countedSku}. ${notes || ''}`
            );
            adjustmentsMade.push({
              sku: relatedItem.expectedSku || relatedItem.countedSku,
              type: relatedItem.mismatchType || relatedItem.varianceType,
              qtyChange: relatedItem.varianceQty,
              locationId: relatedItem.warehouseLocationId
            });
          }
          
          // Update related item as approved
          await storage.updateCycleCountItem(relatedItem.id, {
            status: "approved",
            approvedBy: userId,
            approvedAt: new Date(),
            varianceReason: reasonCode,
          });
        }
      }
      
      // Also check if another item points TO this one (reverse relationship)
      const reverseRelatedResult = await db.execute<{ id: number }>(sql`
        SELECT id FROM cycle_count_items 
        WHERE related_item_id = ${itemId} 
        AND status != 'approved'
        LIMIT 1
      `);
      
      if (reverseRelatedResult.rows.length > 0) {
        const reverseItemId = reverseRelatedResult.rows[0].id;
        const reverseItem = await storage.getCycleCountItemById(reverseItemId);
        
        if (reverseItem && reverseItem.status !== "approved") {
          // Apply adjustment for the reverse-linked item
          if (reverseItem.inventoryItemId && reverseItem.varianceQty !== null && reverseItem.varianceQty !== 0) {
            await inventoryService.adjustInventory(
              reverseItem.inventoryItemId,
              reverseItem.warehouseLocationId,
              reverseItem.varianceQty,
              reasonCode || "CYCLE_COUNT",
              userId,
              `Cycle count adjustment (linked mismatch): ${reverseItem.expectedSku || reverseItem.countedSku}. ${notes || ''}`
            );
            adjustmentsMade.push({
              sku: reverseItem.expectedSku || reverseItem.countedSku,
              type: reverseItem.mismatchType || reverseItem.varianceType,
              qtyChange: reverseItem.varianceQty,
              locationId: reverseItem.warehouseLocationId
            });
          }
          
          await storage.updateCycleCountItem(reverseItem.id, {
            status: "approved",
            approvedBy: userId,
            approvedAt: new Date(),
            varianceReason: reasonCode,
          });
        }
      }
      
      // Update cycle count approved count
      const cycleCount = await storage.getCycleCountById(item.cycleCountId);
      if (cycleCount) {
        const allItems = await storage.getCycleCountItems(item.cycleCountId);
        const approvedCount = allItems.filter(i => i.status === "approved" || i.status === "adjusted").length;
        
        await storage.updateCycleCount(item.cycleCountId, {
          approvedVariances: approvedCount,
        });
      }
      
      res.json({ 
        success: true,
        adjustmentsMade,
        linkedItemsApproved: (item.relatedItemId ? 1 : 0) + reverseRelatedResult.rows.length
      });
    } catch (error) {
      console.error("Error approving variance:", error);
      res.status(500).json({ error: "Failed to approve variance" });
    }
  });

  // Complete cycle count
  app.post("/api/cycle-counts/:id/complete", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const cycleCount = await storage.getCycleCountById(id);
      
      if (!cycleCount) {
        return res.status(404).json({ error: "Cycle count not found" });
      }
      
      // Check all items are counted
      const items = await storage.getCycleCountItems(id);
      const pendingItems = items.filter(i => i.status === "pending");
      
      if (pendingItems.length > 0) {
        return res.status(400).json({ error: `${pendingItems.length} items still pending` });
      }
      
      // Check all variances are approved
      const unapprovedVariances = items.filter(i => i.varianceType && i.status !== "approved" && i.status !== "adjusted");
      
      if (unapprovedVariances.length > 0) {
        return res.status(400).json({ error: `${unapprovedVariances.length} variances not approved` });
      }
      
      await storage.updateCycleCount(id, {
        status: "completed",
        completedAt: new Date(),
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error completing cycle count:", error);
      res.status(500).json({ error: "Failed to complete cycle count" });
    }
  });

  // Delete cycle count
  app.delete("/api/cycle-counts/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteCycleCount(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Cycle count not found" });
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting cycle count:", error);
      res.status(500).json({ error: "Failed to delete cycle count" });
    }
  });

  // ===== VENDORS API =====
  
  app.get("/api/vendors", async (req, res) => {
    try {
      const vendors = await storage.getAllVendors();
      res.json(vendors);
    } catch (error) {
      console.error("Error fetching vendors:", error);
      res.status(500).json({ error: "Failed to fetch vendors" });
    }
  });
  
  app.get("/api/vendors/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const vendor = await storage.getVendorById(id);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error fetching vendor:", error);
      res.status(500).json({ error: "Failed to fetch vendor" });
    }
  });
  
  app.post("/api/vendors", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { code, name, contactName, email, phone, address, notes } = req.body;
      if (!code || !name) {
        return res.status(400).json({ error: "Code and name are required" });
      }
      
      const existing = await storage.getVendorByCode(code);
      if (existing) {
        return res.status(400).json({ error: "Vendor code already exists" });
      }
      
      const vendor = await storage.createVendor({
        code,
        name,
        contactName,
        email,
        phone,
        address,
        notes,
      });
      res.status(201).json(vendor);
    } catch (error) {
      console.error("Error creating vendor:", error);
      res.status(500).json({ error: "Failed to create vendor" });
    }
  });
  
  app.patch("/api/vendors/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      const vendor = await storage.updateVendor(id, updates);
      if (!vendor) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json(vendor);
    } catch (error) {
      console.error("Error updating vendor:", error);
      res.status(500).json({ error: "Failed to update vendor" });
    }
  });
  
  app.delete("/api/vendors/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteVendor(id);
      if (!deleted) {
        return res.status(404).json({ error: "Vendor not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting vendor:", error);
      res.status(500).json({ error: "Failed to delete vendor" });
    }
  });
  
  // ===== RECEIVING ORDERS API =====
  
  app.get("/api/receiving", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const orders = status 
        ? await storage.getReceivingOrdersByStatus(status)
        : await storage.getAllReceivingOrders();
      
      // Enrich with vendor info
      const vendors = await storage.getAllVendors();
      const vendorMap = new Map(vendors.map(v => [v.id, v]));
      
      const enriched = orders.map(order => ({
        ...order,
        vendor: order.vendorId ? vendorMap.get(order.vendorId) : null,
      }));
      
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching receiving orders:", error);
      res.status(500).json({ error: "Failed to fetch receiving orders" });
    }
  });
  
  app.get("/api/receiving/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      console.log("[RECEIVING] Fetching order id:", id);
      
      const order = await storage.getReceivingOrderById(id);
      console.log("[RECEIVING] Order found:", order ? "yes" : "no");
      
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      
      const lines = await storage.getReceivingLines(id);
      console.log("[RECEIVING] Lines count:", lines.length);
      
      const vendor = order.vendorId ? await storage.getVendorById(order.vendorId) : null;
      console.log("[RECEIVING] Vendor:", vendor ? vendor.name : "none");
      
      res.json({ ...order, lines, vendor });
    } catch (error: any) {
      console.error("[RECEIVING] Error fetching receiving order:", error?.message || error);
      console.error("[RECEIVING] Stack:", error?.stack);
      res.status(500).json({ error: "Failed to fetch receiving order", details: error?.message });
    }
  });
  
  app.post("/api/receiving", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { sourceType, vendorId, warehouseId, poNumber, asnNumber, expectedDate, notes } = req.body;
      
      const receiptNumber = await storage.generateReceiptNumber();
      const userId = req.session.user?.id || null;
      
      const order = await storage.createReceivingOrder({
        receiptNumber,
        sourceType: sourceType || "blind",
        vendorId: vendorId || null,
        warehouseId: warehouseId || null,
        poNumber: poNumber || null,
        asnNumber: asnNumber || null,
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        notes: notes || null,
        status: "draft",
        createdBy: userId,
      });
      
      res.status(201).json(order);
    } catch (error: any) {
      console.error("Error creating receiving order:", error?.message || error);
      if (error?.stack) console.error(error.stack);
      res.status(500).json({ error: "Failed to create receiving order", details: error?.message });
    }
  });
  
  app.patch("/api/receiving/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      
      const order = await storage.updateReceivingOrder(id, updates);
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      res.json(order);
    } catch (error) {
      console.error("Error updating receiving order:", error);
      res.status(500).json({ error: "Failed to update receiving order" });
    }
  });
  
  app.delete("/api/receiving/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReceivingOrder(id);
      if (!deleted) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting receiving order:", error);
      res.status(500).json({ error: "Failed to delete receiving order" });
    }
  });
  
  // Open a receiving order for receiving
  app.post("/api/receiving/:id/open", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getReceivingOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      if (order.status !== "draft") {
        return res.status(400).json({ error: "Can only open orders in draft status" });
      }
      
      const userId = req.session.user?.id || null;
      const updated = await storage.updateReceivingOrder(id, {
        status: "open",
        receivedBy: userId,
        receivedDate: new Date(),
      });
      
      // Return order with lines included so UI doesn't lose them
      const lines = await storage.getReceivingLines(id);
      const vendor = order.vendorId ? await storage.getVendorById(order.vendorId) : null;
      res.json({ ...updated, lines, vendor });
    } catch (error) {
      console.error("Error opening receiving order:", error);
      res.status(500).json({ error: "Failed to open receiving order" });
    }
  });
  
  // Close/complete a receiving order - updates inventory
  app.post("/api/receiving/:id/close", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getReceivingOrderById(id);
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      if (order.status === "closed" || order.status === "cancelled") {
        return res.status(400).json({ error: "Order already closed or cancelled" });
      }
      
      const lines = await storage.getReceivingLines(id);
      const userId = req.session.user?.id || null;
      
      // Create inventory transactions for each line
      const batchId = `RCV-${id}-${Date.now()}`;
      let totalReceived = 0;
      let linesReceived = 0;
      
      for (const line of lines) {
        if (line.receivedQty > 0 && line.inventoryItemId && line.putawayLocationId) {
          // Get or create inventory level at location
          let level = await storage.getInventoryLevelByItemAndLocation(line.inventoryItemId, line.putawayLocationId);
          
          const baseQtyBefore = level?.onHandBase || 0;
          const qtyToAdd = line.receivedQty;
          const baseQtyAfter = baseQtyBefore + qtyToAdd;
          
          if (level) {
            // Update existing level - also set variantId if missing
            await storage.updateInventoryLevel(level.id, {
              onHandBase: baseQtyAfter,
              variantId: line.uomVariantId || level.variantId,
              variantQty: (level.variantQty || 0) + qtyToAdd,
            });
          } else {
            // Create new level - include variantId for variant-centric inventory tracking
            await storage.createInventoryLevel({
              inventoryItemId: line.inventoryItemId,
              warehouseLocationId: line.putawayLocationId,
              onHandBase: qtyToAdd,
              reservedBase: 0,
              variantId: line.uomVariantId || undefined,
              variantQty: qtyToAdd,
            });
          }
          
          // Create transaction record with Full WMS fields
          await storage.createInventoryTransaction({
            inventoryItemId: line.inventoryItemId,
            variantId: line.uomVariantId || null,
            toLocationId: line.putawayLocationId, // Receive = TO location
            warehouseLocationId: line.putawayLocationId, // Legacy compatibility
            transactionType: "receipt",
            variantQtyDelta: qtyToAdd,
            variantQtyBefore: level?.variantQty || 0,
            variantQtyAfter: (level?.variantQty || 0) + qtyToAdd,
            baseQtyDelta: qtyToAdd,
            baseQtyBefore,
            baseQtyAfter,
            batchId,
            sourceState: "external", // Coming from outside
            targetState: "on_hand", // Now on hand
            receivingOrderId: id, // Link to receiving order
            referenceType: "receiving",
            referenceId: order.receiptNumber,
            notes: `Received from ${order.sourceType === "po" ? `PO ${order.poNumber}` : order.receiptNumber}`,
            userId,
          });
          
          // Mark line as put away
          await storage.updateReceivingLine(line.id, {
            putawayComplete: 1,
            status: "complete",
          });
          
          totalReceived += qtyToAdd;
          linesReceived++;
        }
      }
      
      // Update order totals and close
      const updated = await storage.updateReceivingOrder(id, {
        status: "closed",
        closedDate: new Date(),
        closedBy: userId,
        receivedLineCount: linesReceived,
        receivedTotalUnits: totalReceived,
      });
      
      res.json({ 
        success: true, 
        order: updated,
        linesProcessed: linesReceived,
        unitsReceived: totalReceived,
      });
    } catch (error) {
      console.error("Error closing receiving order:", error);
      res.status(500).json({ error: "Failed to close receiving order" });
    }
  });
  
  // ===== RECEIVING LINES API =====
  
  app.get("/api/receiving/:orderId/lines", async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const lines = await storage.getReceivingLines(orderId);
      res.json(lines);
    } catch (error) {
      console.error("Error fetching receiving lines:", error);
      res.status(500).json({ error: "Failed to fetch receiving lines" });
    }
  });
  
  app.post("/api/receiving/:orderId/lines", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const { sku, productName, expectedQty, receivedQty, status, inventoryItemId, uomVariantId, catalogProductId, barcode, unitCost, putawayLocationId } = req.body;
      
      await storage.createReceivingLine({
        receivingOrderId: orderId,
        sku: sku || null,
        productName: productName || null,
        expectedQty: expectedQty || 0,
        receivedQty: receivedQty || 0,
        damagedQty: 0,
        inventoryItemId: inventoryItemId || null,
        uomVariantId: uomVariantId || null,
        catalogProductId: catalogProductId || null,
        barcode: barcode || null,
        unitCost: unitCost || null,
        putawayLocationId: putawayLocationId || null,
        status: status || "pending",
      });
      
      // Update order line count
      const lines = await storage.getReceivingLines(orderId);
      await storage.updateReceivingOrder(orderId, {
        expectedLineCount: lines.length,
        expectedTotalUnits: lines.reduce((sum, l) => sum + (l.expectedQty || 0), 0),
      });
      
      // Return updated order with lines and vendor (matching GET pattern)
      const order = await storage.getReceivingOrderById(orderId);
      const vendor = order?.vendorId ? await storage.getVendorById(order.vendorId) : null;
      res.status(201).json({ ...order, lines, vendor });
    } catch (error) {
      console.error("Error creating receiving line:", error);
      res.status(500).json({ error: "Failed to create receiving line" });
    }
  });
  
  app.patch("/api/receiving/lines/:lineId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.lineId);
      const updates = req.body;
      
      // Calculate status based on quantities
      if (updates.receivedQty !== undefined) {
        const line = await storage.getReceivingLineById(lineId);
        if (line) {
          const expectedQty = updates.expectedQty ?? line.expectedQty ?? 0;
          const receivedQty = updates.receivedQty ?? line.receivedQty ?? 0;
          
          if (receivedQty === 0) {
            updates.status = "pending";
          } else if (receivedQty < expectedQty) {
            updates.status = "partial";
          } else if (receivedQty === expectedQty) {
            updates.status = "complete";
          } else if (receivedQty > expectedQty) {
            updates.status = "overage";
          }
        }
      }
      
      const line = await storage.updateReceivingLine(lineId, updates);
      if (!line) {
        return res.status(404).json({ error: "Receiving line not found" });
      }
      res.json(line);
    } catch (error) {
      console.error("Error updating receiving line:", error);
      res.status(500).json({ error: "Failed to update receiving line" });
    }
  });
  
  // Delete a receiving order (only if not closed)
  app.delete("/api/receiving/:orderId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const order = await storage.getReceivingOrder(orderId);
      
      if (!order) {
        return res.status(404).json({ error: "Receiving order not found" });
      }
      
      if (order.status === "closed") {
        return res.status(400).json({ error: "Cannot delete a closed receiving order" });
      }
      
      await storage.deleteReceivingOrder(orderId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting receiving order:", error);
      res.status(500).json({ error: "Failed to delete receiving order" });
    }
  });
  
  // Bulk complete all lines in a receiving order
  app.post("/api/receiving/:orderId/complete-all", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const lines = await storage.getReceivingLines(orderId);
      
      if (!lines || lines.length === 0) {
        return res.status(404).json({ error: "No lines found for this order" });
      }
      
      // Update all lines: set receivedQty = expectedQty and status = complete
      let updated = 0;
      for (const line of lines) {
        if (line.status !== "complete") {
          await storage.updateReceivingLine(line.id, { 
            receivedQty: line.expectedQty || 0,
            status: "complete" 
          });
          updated++;
        }
      }
      
      // Update order received totals
      const updatedLines = await storage.getReceivingLines(orderId);
      await storage.updateReceivingOrder(orderId, {
        receivedLineCount: updatedLines.filter(l => l.status === "complete").length,
        receivedTotalUnits: updatedLines.reduce((sum, l) => sum + (l.receivedQty || 0), 0),
      });
      
      // Return updated order with lines for real-time UI update
      const order = await storage.getReceivingOrderById(orderId);
      const vendor = order?.vendorId ? await storage.getVendorById(order.vendorId) : null;
      res.json({ message: `Completed ${updated} lines`, updated, order: { ...order, lines: updatedLines, vendor } });
    } catch (error) {
      console.error("Error completing all lines:", error);
      res.status(500).json({ error: "Failed to complete all lines" });
    }
  });
  
  app.delete("/api/receiving/lines/:lineId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const lineId = parseInt(req.params.lineId);
      const line = await storage.getReceivingLineById(lineId);
      if (!line) {
        return res.status(404).json({ error: "Receiving line not found" });
      }
      
      const deleted = await storage.deleteReceivingLine(lineId);
      
      // Update order line count
      const lines = await storage.getReceivingLines(line.receivingOrderId);
      await storage.updateReceivingOrder(line.receivingOrderId, {
        expectedLineCount: lines.length,
        expectedTotalUnits: lines.reduce((sum, l) => sum + (l.expectedQty || 0), 0),
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting receiving line:", error);
      res.status(500).json({ error: "Failed to delete receiving line" });
    }
  });
  
  // Bulk add lines from CSV for initial inventory load
  app.post("/api/receiving/:orderId/lines/bulk", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const { lines } = req.body;
      
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ error: "Lines array is required" });
      }
      
      // Check setting for multiple SKUs per bin
      const allowMultipleSkusSetting = await storage.getSetting("allow_multiple_skus_per_bin");
      const allowMultipleSkus = allowMultipleSkusSetting !== "false"; // Default to true
      
      // Pre-fetch product locations if we need to validate bin occupancy
      let existingProductLocations: any[] = [];
      if (!allowMultipleSkus) {
        existingProductLocations = await storage.getAllProductLocations();
      }
      
      // Fetch existing lines for this order to enable idempotent imports (update vs create)
      // Uniqueness key: SKU + Location (allows same SKU at different locations)
      const existingLines = await storage.getReceivingLines(orderId);
      const existingBySkuLocation = new Map(
        existingLines
          .filter(l => l.sku)
          .map(l => {
            const locationId = l.putawayLocationId || 'none';
            return [`${l.sku!.toUpperCase()}|${locationId}`, l];
          })
      );
      
      // Lookup SKUs to get inventory item IDs
      const linesToCreate: any[] = [];
      const linesToUpdate: { id: number; updates: any }[] = [];
      const errors: string[] = [];
      const warnings: string[] = [];
      
      // Pre-fetch warehouse locations for efficient lookup - match by code OR name
      const allWarehouseLocations = await storage.getAllWarehouseLocations();
      const locationByCode = new Map(allWarehouseLocations.map(l => [l.code.toUpperCase().trim(), l]));
      const locationByName = new Map(
        allWarehouseLocations
          .filter(l => l.name)
          .map(l => [l.name!.toUpperCase().trim(), l])
      );
      console.log(`[CSV Import] Loaded ${allWarehouseLocations.length} warehouse locations. Sample codes:`, 
        allWarehouseLocations.slice(0, 5).map(l => l.code).join(', '));
      
      // Pre-fetch catalog products for efficient lookup
      const catalogProducts = await storage.getAllCatalogProducts();
      const catalogBySku = new Map(
        catalogProducts
          .filter(p => p.sku)
          .map(p => [p.sku!.toUpperCase(), p])
      );
      console.log(`[CSV Import] Loaded ${catalogProducts.length} catalog products, ${catalogBySku.size} with SKUs`);
      
      // Pre-fetch uom_variants for efficient lookup (Model A source of truth)
      const allUomVariants = await storage.getAllUomVariants();
      const uomVariantBySku = new Map(
        allUomVariants
          .filter(v => v.sku)
          .map(v => [v.sku!.toUpperCase(), v])
      );
      console.log(`[CSV Import] Loaded ${allUomVariants.length} uom_variants, ${uomVariantBySku.size} with SKUs`);
      
      for (const line of lines) {
        const { sku, qty, location, damaged_qty, unit_cost, barcode, notes } = line;
        
        if (!sku) {
          errors.push(`Missing SKU in line`);
          continue;
        }
        
        // Model A source of truth: uom_variants (sellable SKUs with inventory_item linkage)
        const lookupKey = sku.toUpperCase();
        const uomVariant = uomVariantBySku.get(lookupKey);
        const catalog = catalogBySku.get(lookupKey);
        
        let inventoryItemId: number | null = null;
        let uomVariantId: number | null = null;
        let catalogProductId: number | null = null;
        let productName = sku;
        let productBarcode = barcode || null;
        
        console.log(`[CSV Import] SKU "${sku}" lookup key="${lookupKey}" uomVariant=${!!uomVariant} catalog=${!!catalog}`);
        
        if (uomVariant) {
          // Found in uom_variants - use this as source of truth
          uomVariantId = uomVariant.id;
          inventoryItemId = uomVariant.inventoryItemId;
          productName = uomVariant.name;
          if (!productBarcode && uomVariant.barcode) {
            productBarcode = uomVariant.barcode;
          }
          // Also get catalogProductId if exists
          if (catalog) {
            catalogProductId = catalog.id;
          }
          console.log(`[CSV Import] SKU "${sku}" -> uomVariantId=${uomVariantId}, inventoryItemId=${inventoryItemId}, catalogProductId=${catalogProductId}`);
        } else if (catalog) {
          // Fallback to catalog_products (legacy path)
          catalogProductId = catalog.id;
          inventoryItemId = catalog.inventoryItemId || null;
          productName = catalog.title;
          console.log(`[CSV Import] SKU "${sku}" -> catalogProductId=${catalogProductId}, inventoryItemId=${inventoryItemId} (legacy path, no uom_variant)`);
          if (!productBarcode && (catalog as any).barcode) {
            productBarcode = (catalog as any).barcode;
          }
          warnings.push(`SKU ${sku} found in catalog but not in uom_variants - please set up UOM hierarchy`);
        } else {
          // SKU not found anywhere - add warning but continue
          console.log(`[CSV Import] SKU "${sku}" NOT FOUND in uom_variants or catalog_products`);
          warnings.push(`SKU ${sku} not found in product catalog - inventory will not be updated on close`);
        }
        
        // Look up location by code first, then by name as fallback
        let putawayLocationId = null;
        if (location) {
          const cleanLocation = location.trim().toUpperCase();
          let loc = locationByCode.get(cleanLocation);
          if (!loc) {
            loc = locationByName.get(cleanLocation);
          }
          if (loc) {
            putawayLocationId = loc.id;
            
            // Check if bin is already occupied by a different SKU
            if (!allowMultipleSkus) {
              const existingInBin = existingProductLocations.find(
                pl => pl.location?.trim().toUpperCase() === cleanLocation && 
                      pl.sku?.toUpperCase() !== sku.toUpperCase()
              );
              if (existingInBin) {
                errors.push(`Bin ${location} already contains SKU ${existingInBin.sku} - cannot add ${sku} (multiple SKUs per bin is disabled)`);
                continue;
              }
            }
          } else {
            // Log available locations for debugging
            console.log(`[CSV Import] Location '${location}' (cleaned: '${cleanLocation}') not found in code or name lookup.`);
            warnings.push(`Location "${location}" not found for SKU ${sku}`);
          }
        }
        
        // Parse numeric values
        const parsedQty = parseInt(qty) || 0;
        const parsedDamagedQty = parseInt(damaged_qty) || 0;
        const parsedUnitCost = unit_cost ? Math.round(parseFloat(unit_cost) * 100) : null; // Convert dollars to cents
        
        // Check if line with same SKU + Location already exists in this order (idempotent import)
        const uniqueKey = `${sku.toUpperCase()}|${putawayLocationId || 'none'}`;
        const existingLine = existingBySkuLocation.get(uniqueKey);
        if (existingLine) {
          // Update existing line instead of creating duplicate
          linesToUpdate.push({
            id: existingLine.id,
            updates: {
              productName,
              barcode: productBarcode,
              expectedQty: parsedQty,
              receivedQty: parsedQty,
              damagedQty: parsedDamagedQty,
              unitCost: parsedUnitCost,
              inventoryItemId,
              uomVariantId,
              catalogProductId,
              putawayLocationId,
              notes: notes || null,
              status: putawayLocationId ? "complete" : "pending",
              receivedBy: req.session?.user?.id || null,
              receivedAt: new Date(),
            }
          });
        } else {
          linesToCreate.push({
            receivingOrderId: orderId,
            sku: sku.toUpperCase(),
            productName,
            barcode: productBarcode,
            expectedQty: parsedQty,
            receivedQty: parsedQty, // For initial load, received = expected
            damagedQty: parsedDamagedQty,
            unitCost: parsedUnitCost,
            inventoryItemId,
            uomVariantId,
            catalogProductId,
            putawayLocationId,
            notes: notes || null,
            status: putawayLocationId ? "complete" : "pending",
            receivedBy: req.session?.user?.id || null,
            receivedAt: new Date(),
          });
        }
      }
      
      // Update existing lines
      for (const item of linesToUpdate) {
        await storage.updateReceivingLine(item.id, item.updates);
      }
      
      // Create new lines
      const created = await storage.bulkCreateReceivingLines(linesToCreate);
      
      // Update order totals
      const allLines = await storage.getReceivingLines(orderId);
      await storage.updateReceivingOrder(orderId, {
        expectedLineCount: allLines.length,
        receivedLineCount: allLines.filter(l => l.receivedQty > 0).length,
        expectedTotalUnits: allLines.reduce((sum, l) => sum + (l.expectedQty || 0), 0),
        receivedTotalUnits: allLines.reduce((sum, l) => sum + (l.receivedQty || 0), 0),
      });
      
      res.status(201).json({
        success: true,
        created: created.length,
        updated: linesToUpdate.length,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      });
    } catch (error) {
      console.error("Error bulk creating receiving lines:", error);
      res.status(500).json({ error: "Failed to create receiving lines" });
    }
  });

  // ===== INVENTORY TRANSACTIONS HISTORY (Audit) =====
  
  app.get("/api/inventory/transactions", requirePermission("inventory", "audit"), async (req, res) => {
    try {
      const { transactionType, startDate, endDate, batchId, limit, offset } = req.query;
      
      const filters: any = {};
      if (transactionType) filters.transactionType = transactionType as string;
      if (batchId) filters.batchId = batchId as string;
      if (startDate) filters.startDate = new Date(startDate as string);
      if (endDate) filters.endDate = new Date(endDate as string);
      filters.limit = limit ? Math.min(parseInt(limit as string), 100) : 50;
      filters.offset = offset ? parseInt(offset as string) : 0;
      
      const transactions = await storage.getInventoryTransactions(filters);
      
      // Collect unique IDs for batch lookup
      const locationIds = new Set<number>();
      const itemIds = new Set<number>();
      
      for (const tx of transactions) {
        if (tx.fromLocationId) locationIds.add(tx.fromLocationId);
        if (tx.toLocationId) locationIds.add(tx.toLocationId);
        if (tx.warehouseLocationId) locationIds.add(tx.warehouseLocationId);
        if (tx.inventoryItemId) itemIds.add(tx.inventoryItemId);
      }
      
      // Batch fetch only needed data
      const [allLocations, allItems] = await Promise.all([
        locationIds.size > 0 ? storage.getAllWarehouseLocations() : [],
        itemIds.size > 0 ? storage.getAllInventoryItems() : []
      ]);
      
      const locationMap = new Map(allLocations.filter(l => locationIds.has(l.id)).map(l => [l.id, l]));
      const itemMap = new Map(allItems.filter(i => itemIds.has(i.id)).map(i => [i.id, i]));
      
      const enriched = transactions.map(tx => ({
        ...tx,
        fromLocation: tx.fromLocationId ? locationMap.get(tx.fromLocationId) : null,
        toLocation: tx.toLocationId ? locationMap.get(tx.toLocationId) : null,
        warehouseLocation: tx.warehouseLocationId ? locationMap.get(tx.warehouseLocationId) : null,
        inventoryItem: itemMap.get(tx.inventoryItemId),
      }));
      
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching inventory transactions:", error);
      res.status(500).json({ error: "Failed to fetch inventory transactions" });
    }
  });

  return httpServer;
}
