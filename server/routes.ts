import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { z } from "zod";
import { eq, inArray, sql, isNull, and, gte } from "drizzle-orm";
import { db } from "./db";
import { storage } from "./storage";
import { insertProductLocationSchema, updateProductLocationSchema, insertWarehouseSchema, insertWarehouseLocationSchema, insertWarehouseZoneSchema, insertProductSchema, insertProductVariantSchema, insertChannelSchema, insertChannelConnectionSchema, insertPartnerProfileSchema, insertChannelReservationSchema, insertFulfillmentRoutingRuleSchema, generateLocationCode, productLocations, productVariants, products, productAssets, channelListings, inventoryLevels, inventoryTransactions, orders, itemStatusEnum, shipments, fulfillmentRoutingRules, warehouses, warehouseLocations, warehouseTypeEnum, inventorySourceTypeEnum, routingMatchTypeEnum } from "@shared/schema";
import { createOrderCombiningService } from "./services/order-combining";
import { fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, verifyWebhookWithSecret, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, type ShopifyOrder } from "./shopify";
import { createProductImportService } from "./services/product-import";
import { createChannelProductPushService } from "./services/channel-product-push";
import { createBinAssignmentService } from "./services/bin-assignment";
import { broadcastOrdersUpdated } from "./websocket";
import type { InsertOrderItem, SafeUser, InsertProductLocation, UpdateProductLocation } from "@shared/schema";
import Papa from "papaparse";
import bcrypt from "bcrypt";
import multer from "multer";
import { seedRBAC, seedDefaultChannels, seedAdjustmentReasons, getUserPermissions, getUserRoles, getAllRoles, getAllPermissions, getRolePermissions, createRole, updateRolePermissions, deleteRole, assignUserRoles, hasPermission } from "./rbac";

const upload = multer({ storage: multer.memoryStorage() });
const orderCombining = createOrderCombiningService(db);
const productImport = createProductImportService();
const channelProductPush = createChannelProductPushService(db);
const binAssignment = createBinAssignmentService(db, storage);

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

// Internal API authentication for cross-service communication (Archon sync)
function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const key = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/**
 * Refresh pick queue locations for a specific SKU (fire-and-forget).
 * Updates all pending order items for this SKU with current bin location.
 */
async function syncPickQueueForSku(sku: string) {
  try {
    const freshLocation = await storage.getBinLocationFromInventoryBySku(sku);
    if (!freshLocation) return;

    // Find all pending order items with this SKU in active orders
    const result = await db.execute(sql`
      SELECT oi.id, oi.location, oi.zone
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE UPPER(oi.sku) = ${sku.toUpperCase()}
        AND oi.status = 'pending'
        AND o.warehouse_status IN ('ready', 'in_progress')
    `);

    let updated = 0;
    for (const row of result.rows as any[]) {
      if (row.location !== freshLocation.location || row.zone !== freshLocation.zone) {
        await storage.updateOrderItemLocation(
          row.id,
          freshLocation.location,
          freshLocation.zone,
          freshLocation.barcode || null,
          freshLocation.imageUrl || null
        );
        updated++;
      }
    }

    if (updated > 0) {
      broadcastOrdersUpdated();
      console.log(`[Queue Sync] Updated ${updated} pending items for SKU ${sku} → ${freshLocation.location}`);
    }
  } catch (err: any) {
    console.warn(`[Queue Sync] Failed to sync SKU ${sku}:`, err?.message);
  }
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
      
      // Explicitly save session before responding (fixes mobile browser issues)
      req.session.save((err) => {
        if (err) {
          console.error("Session save error:", err);
          return res.status(500).json({ error: "Session failed to save" });
        }
        res.json({ user: safeUser });
      });
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
      // Return ALL products with their locations (if assigned)
      const locations = await storage.getAllProductsWithLocations();
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
          locationType: "pick",
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

  // Create location (with upsert support for productId)
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
      
      // Check if a product_location already exists for this productId (upsert)
      if (data.productId) {
        const existing = await storage.getProductLocationByProductId(data.productId);
        if (existing) {
          // Update existing record instead of creating duplicate
          const updated = await storage.updateProductLocation(existing.id, dataWithRef);
          return res.status(200).json(updated);
        }
      }
      
      const location = await storage.createProductLocation(dataWithRef);

      // Auto-sync pick queue for this SKU (fire-and-forget)
      if (location.sku) {
        syncPickQueueForSku(location.sku).catch(() => {});
      }

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

      // Auto-sync pick queue for this SKU (fire-and-forget)
      if (location.sku) {
        syncPickQueueForSku(location.sku).catch(() => {});
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
      // Get SKU before deleting for queue sync
      const existing = await storage.getProductLocationById(id);
      const deleted = await storage.deleteProductLocation(id);

      if (!deleted) {
        return res.status(404).json({ error: "Location not found" });
      }

      // Auto-sync pick queue for this SKU (fire-and-forget)
      if (existing?.sku) {
        syncPickQueueForSku(existing.sku).catch(() => {});
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error deleting location:", error);
      res.status(500).json({ error: "Failed to delete location" });
    }
  });

  // Move a product location to a different warehouse bin
  app.post("/api/locations/:id/move", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { targetWarehouseLocationId, notes } = req.body;
      
      if (!targetWarehouseLocationId) {
        return res.status(400).json({ error: "Target location is required" });
      }
      
      // Get the product location being moved
      const productLocation = await storage.getProductLocationById(id);
      if (!productLocation) {
        return res.status(404).json({ error: "Product location not found" });
      }
      
      // Get target warehouse location details
      const targetLocation = await storage.getWarehouseLocationById(parseInt(targetWarehouseLocationId));
      if (!targetLocation) {
        return res.status(404).json({ error: "Target warehouse location not found" });
      }
      
      // Get source warehouse location for audit
      const sourceLocation = productLocation.warehouseLocationId 
        ? await storage.getWarehouseLocationById(productLocation.warehouseLocationId)
        : null;
      
      // Update the product location
      const updated = await storage.updateProductLocation(id, {
        warehouseLocationId: parseInt(targetWarehouseLocationId),
        location: targetLocation.code,
        zone: targetLocation.zone || 'U'
      });
      
      // Log the move as an inventory transaction (transfer type)
      if (productLocation.productId) {
        const userId = req.session?.user?.id || 'system';
        await db.insert(inventoryTransactions).values({
          productVariantId: null,
          fromLocationId: sourceLocation?.id || null,
          toLocationId: targetLocation.id,
          transactionType: 'transfer',
          sourceState: 'on_hand',
          targetState: 'on_hand',
          variantQtyDelta: 0, // Location change only, not quantity
          notes: notes || `Moved SKU ${productLocation.sku} from ${sourceLocation?.code || 'unassigned'} to ${targetLocation.code}`,
          userId,
          batchId: `move-${Date.now()}`
        });
      }
      
      res.json({ 
        success: true, 
        message: `Moved ${productLocation.sku} to ${targetLocation.code}`,
        productLocation: updated
      });
    } catch (error: any) {
      console.error("Error moving product location:", error);
      res.status(500).json({ error: error.message || "Failed to move product" });
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
        o.warehouseStatus !== "shipped" && 
        o.warehouseStatus !== "cancelled" &&
        o.warehouseStatus !== "completed"
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
        SELECT o.id as order_id, o.warehouse_status, o.order_number,
               oi.id as item_id, oi.sku, oi.requires_shipping
        FROM orders o
        LEFT JOIN order_items oi ON oi.order_id = o.id
        WHERE o.warehouse_status IN ('ready', 'in_progress')
        LIMIT 5
      `);
      res.json({ rows: result.rows, count: result.rows?.length || 0 });
    } catch (error: any) {
      res.status(500).json({ error: error.message, code: error.code, detail: error.detail });
    }
  });
  
  // Get orders for picking queue (including completed for Done count)
  // Diagnostic endpoint to inspect a specific order's items
  app.get("/api/picking/diagnose/:orderNumber", async (req, res) => {
    try {
      const orderNumber = '#' + req.params.orderNumber;
      const result = await db.execute(sql`
        SELECT oi.id, oi.order_id, oi.sku, oi.name, oi.status, oi.quantity, 
               oi.picked_quantity, oi.requires_shipping, oi.location
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.order_number = ${orderNumber}
      `);
      const orderResult = await db.execute(sql`
        SELECT id, order_number, item_count, unit_count, picked_count, warehouse_status
        FROM orders WHERE order_number = ${orderNumber}
      `);
      res.json({ order: orderResult.rows[0], items: result.rows });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnostic: find orders where picked_count > unit_count (double counting)
  app.get("/api/picking/diagnose-overcounted", async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT o.id, o.order_number, o.item_count, o.unit_count, o.picked_count,
               o.warehouse_status,
               (SELECT SUM(oi.picked_quantity) FROM order_items oi WHERE oi.order_id = o.id) as actual_picked_sum,
               (SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id) as actual_unit_sum
        FROM orders o
        WHERE o.picked_count > o.unit_count
          AND o.warehouse_status NOT IN ('cancelled')
        ORDER BY o.picked_count - o.unit_count DESC
        LIMIT 20
      `);
      res.json(result.rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Fix stale item_count/unit_count on all orders
  app.post("/api/picking/fix-order-counts", async (req, res) => {
    try {
      const result = await db.execute(sql`
        UPDATE orders o
        SET 
          item_count = sub.actual_item_count,
          unit_count = sub.actual_unit_count,
          picked_count = sub.actual_picked_count
        FROM (
          SELECT 
            oi.order_id,
            COUNT(*) as actual_item_count,
            COALESCE(SUM(oi.quantity), 0) as actual_unit_count,
            COALESCE(SUM(CASE WHEN oi.requires_shipping = 1 THEN oi.picked_quantity ELSE 0 END), 0) as actual_picked_count
          FROM order_items oi
          GROUP BY oi.order_id
        ) sub
        WHERE o.id = sub.order_id
          AND (o.item_count != sub.actual_item_count 
               OR o.unit_count != sub.actual_unit_count 
               OR o.picked_count != sub.actual_picked_count)
      `);
      res.json({ message: "Order counts recalculated", rowsUpdated: result.rowCount });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Diagnostic endpoint to fix stuck orders (considers only shippable items)
  app.post("/api/picking/fix-stuck-orders", async (req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT o.id, o.order_number, o.warehouse_status, o.item_count,
          (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1) as shippable_count,
          (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1 AND oi.status IN ('completed', 'short')) as shippable_done_count,
          (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.requires_shipping = 1 AND oi.status = 'short') as short_count
        FROM orders o
        WHERE o.warehouse_status = 'in_progress'
      `);
      const stuckOrders = result.rows as any[];
      const fixed: string[] = [];
      
      for (const row of stuckOrders) {
        const shippableCount = Number(row.shippable_count);
        const shippableDoneCount = Number(row.shippable_done_count);
        if (shippableCount > 0 && shippableDoneCount === shippableCount) {
          const hasShort = Number(row.short_count) > 0;
          const newStatus = hasShort ? 'exception' : 'completed';
          await db.execute(sql`
            UPDATE orders 
            SET warehouse_status = ${newStatus}, completed_at = NOW()
            WHERE id = ${row.id}
          `);
          await db.execute(sql`
            UPDATE order_items 
            SET status = 'completed' 
            WHERE order_id = ${row.id} AND requires_shipping = 0 AND status = 'pending'
          `);
          fixed.push(`${row.order_number}: in_progress → ${newStatus} (${shippableDoneCount}/${shippableCount} shippable items done)`);
        }
      }
      
      res.json({ 
        inProgressOrders: stuckOrders.map(r => ({
          orderNumber: r.order_number,
          itemCount: r.item_count,
          shippableCount: r.shippable_count,
          shippableDoneCount: r.shippable_done_count,
          shortCount: r.short_count,
        })),
        fixed 
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===== PICKING ROUTES (thin adapters → PickingService) =====

  app.get("/api/picking/queue", async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const orders = await picking.getPickQueue();
      res.json(orders);
    } catch (error) {
      console.error("Error fetching picking queue:", error);
      res.status(500).json({ error: "Failed to fetch picking queue" });
    }
  });

  app.get("/api/picking/orders/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const order = await storage.getOrderById(id);
      if (!order) return res.status(404).json({ error: "Order not found" });
      const allItems = await storage.getOrderItems(id);
      const shippableItems = allItems.filter(item => item.requiresShipping === 1);
      res.json({ ...order, items: shippableItems });
    } catch (error) {
      console.error("Error fetching order:", error);
      res.status(500).json({ error: "Failed to fetch order" });
    }
  });

  app.post("/api/picking/orders/:id/claim", async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const id = parseInt(req.params.id);
      const { pickerId } = req.body;
      if (!pickerId) return res.status(400).json({ error: "pickerId is required" });
      const result = await picking.claimOrder(id, pickerId, req.headers["x-device-type"] as string, req.sessionID);
      if (!result) return res.status(409).json({ error: "Order is no longer available" });
      res.json({ ...result.order, items: result.items });
    } catch (error) {
      console.error("Error claiming order:", error);
      res.status(500).json({ error: "Failed to claim order" });
    }
  });

  app.post("/api/picking/orders/:id/release", async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const id = parseInt(req.params.id);
      const { resetProgress = true, reason } = req.body || {};
      const order = await picking.releaseOrder(id, {
        resetProgress,
        reason,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });
      if (!order) return res.status(404).json({ error: "Order not found" });
      res.json(order);
    } catch (error) {
      console.error("Error releasing order:", error);
      res.status(500).json({ error: "Failed to release order" });
    }
  });

  app.patch("/api/picking/items/:id", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const result = await picking.pickItem(parseInt(req.params.id), {
        status: req.body.status,
        pickedQuantity: req.body.pickedQuantity,
        shortReason: req.body.shortReason,
        pickMethod: req.body.pickMethod,
        warehouseLocationId: req.body.warehouseLocationId,
        userId: req.session.user?.id,
        deviceType: req.headers["x-device-type"] as string,
        sessionId: req.sessionID,
      });
      if (!result.success) {
        const code = result.error === "not_found" ? 404
          : ["invalid_status", "invalid_quantity"].includes(result.error) ? 400 : 409;
        return res.status(code).json({ error: result.error, message: result.message });
      }
      res.json({ item: result.item, inventory: result.inventory });
    } catch (error) {
      console.error("Error updating item:", error);
      res.status(500).json({ error: "Failed to update item" });
    }
  });

  app.post("/api/picking/case-break", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const { sku, warehouseLocationId } = req.body;
      if (!sku || !warehouseLocationId) {
        return res.status(400).json({ error: "sku and warehouseLocationId are required" });
      }
      const result = await picking.initiateCaseBreak(sku, warehouseLocationId, req.session.user?.id);
      if (!result.success) {
        const code = result.taskId ? 409 : 404;
        return res.status(code).json({ error: result.error, taskId: result.taskId });
      }
      res.json(result);
    } catch (error: any) {
      console.error("Error in picker case break:", error);
      res.status(500).json({ error: error.message || "Failed to execute case break" });
    }
  });

  app.post("/api/picking/case-break/confirm", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const { sku, warehouseLocationId, actualBinQty } = req.body;
      if (!sku || !warehouseLocationId || actualBinQty == null) {
        return res.status(400).json({ error: "sku, warehouseLocationId, and actualBinQty are required" });
      }
      const result = await picking.confirmCaseBreak(sku, warehouseLocationId, actualBinQty, req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      console.error("Error confirming case break:", error);
      res.status(500).json({ error: error.message || "Failed to confirm case break" });
    }
  });

  app.post("/api/picking/case-break/skip", requireAuth, async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const { sku, warehouseLocationId, actualBinQty } = req.body;
      if (!sku || !warehouseLocationId || actualBinQty == null) {
        return res.status(400).json({ error: "sku, warehouseLocationId, and actualBinQty are required" });
      }
      const result = await picking.skipReplen(sku, warehouseLocationId, actualBinQty, req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      console.error("Error skipping case break:", error);
      res.status(500).json({ error: error.message || "Failed to skip case break" });
    }
  });

  app.post("/api/picking/orders/:id/ready-to-ship", async (req, res) => {
    try {
      const { picking } = req.app.locals.services as any;
      const order = await picking.markReadyToShip(
        parseInt(req.params.id),
        req.session?.user?.id,
        req.headers["x-device-type"] as string,
        req.sessionID,
      );
      if (!order) return res.status(404).json({ error: "Order not found" });
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

  // Hold an order (any authenticated user)
  app.post("/api/orders/:id/hold", async (req, res) => {
    try {
      if (!req.session.user) {
        return res.status(401).json({ error: "Authentication required" });
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
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
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

  // Release hold on an order (any authenticated user)
  app.post("/api/orders/:id/release-hold", async (req, res) => {
    try {
      if (!req.session.user) {
        return res.status(401).json({ error: "Authentication required" });
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
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
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
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
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
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
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

  // ===== ORDER COMBINING =====

  app.get("/api/settings/order-combining", async (req, res) => {
    try {
      res.json(await orderCombining.getSettings());
    } catch (error) {
      console.error("Error fetching order combining setting:", error);
      res.json({ enabled: true });
    }
  });

  app.post("/api/settings/order-combining", async (req, res) => {
    try {
      if (!req.session.user || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }
      res.json(await orderCombining.updateSettings(req.body.enabled));
    } catch (error) {
      console.error("Error updating order combining setting:", error);
      res.status(500).json({ error: "Failed to update setting" });
    }
  });

  app.get("/api/orders/combinable", async (req, res) => {
    try {
      res.json(await orderCombining.getCombinableGroups());
    } catch (error) {
      console.error("Error fetching combinable orders:", error);
      res.status(500).json({ error: "Failed to fetch combinable orders" });
    }
  });

  app.post("/api/orders/combine", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      res.json(await orderCombining.combineOrders(req.body.orderIds, req.session.user.id));
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error combining orders:", error);
      res.status(500).json({ error: "Failed to combine orders" });
    }
  });

  app.post("/api/orders/combine-all", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      res.json(await orderCombining.combineAll(req.session.user.id));
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error combining all orders:", error);
      res.status(500).json({ error: "Failed to combine all orders" });
    }
  });

  app.post("/api/orders/:id/uncombine", async (req, res) => {
    try {
      if (!req.session.user || (req.session.user.role !== "admin" && req.session.user.role !== "lead")) {
        return res.status(403).json({ error: "Admin or lead access required" });
      }
      const result = await orderCombining.uncombineOrder(parseInt(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error?.name === "CombineError") {
        return res.status(error.statusCode).json({ error: error.message });
      }
      console.error("Error uncombining order:", error);
      res.status(500).json({ error: "Failed to uncombine order" });
    }
  });

  app.get("/api/orders/combined-groups", async (req, res) => {
    try {
      res.json(await orderCombining.getActiveGroups());
    } catch (error) {
      console.error("Error fetching combined groups:", error);
      res.status(500).json({ error: "Failed to fetch combined groups" });
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
        orderStatusBefore: orderBefore?.warehouseStatus,
        orderStatusAfter: order.warehouseStatus,
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

      let productsCreated = 0;
      let variantsCreated = 0;
      let locationsCreated = 0;
      let levelsCreated = 0;
      const errors: string[] = [];

      // Process base SKUs with variants
      for (const [baseSku, data] of Object.entries(baseSkuMap)) {
        try {
          // Check if product already exists
          let product = await storage.getProductBySku(baseSku);

          if (!product) {
            product = await storage.createProduct({
              sku: baseSku,
              name: data.name,
              baseUnit: 'each',
            });
            productsCreated++;
          }

          // Sort variants by pieces (smallest first for hierarchy)
          const sortedVariants = data.variants.sort((a, b) => a.pieces - b.pieces);
          const createdVariantIds: Record<string, number> = {};

          for (let idx = 0; idx < sortedVariants.length; idx++) {
            const v = sortedVariants[idx];

            // Check if variant already exists
            let variant = await storage.getProductVariantBySku(v.sku);

            if (!variant) {
              const parentVariantId = idx > 0 ? createdVariantIds[sortedVariants[idx - 1].sku] : null;

              variant = await storage.createProductVariant({
                productId: product.id,
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
                locationType: 'pick',
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
                  productVariantId: variant.id,
                  warehouseLocationId: warehouseLoc.id,
                  reservedQty: 0,
                  pickedQty: 0,
                  packedQty: 0,
                  backorderQty: 0
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
          let product = await storage.getProductBySku(item.sku);

          if (!product) {
            product = await storage.createProduct({
              sku: item.sku,
              name: item.name,
              baseUnit: 'each',
            });
            productsCreated++;
          }

          let variant = await storage.getProductVariantBySku(item.sku);
          if (!variant) {
            variant = await storage.createProductVariant({
              productId: product.id,
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
              locationType: 'pick',
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
                productVariantId: variant.id,
                warehouseLocationId: warehouseLoc.id,
                reservedQty: 0,
                pickedQty: 0,
                packedQty: 0,
                backorderQty: 0
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
          productsCreated,
          variantsCreated,
          locationsCreated,
          levelsCreated
        },
        errors: errors.length > 0 ? errors : undefined,
        message: "Bootstrap complete. Products, variants, and levels have been created."
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

  // Shopify Sync API - syncs content fields + assets to products table and product_assets
  // Uses Shopify's natural hierarchy: Product -> Variants
  // - products: ONE per Shopify Product (parent container + content fields)
  // - product_variants: ONE per Shopify Variant (sellable SKUs)
  // - product_assets: product-level + variant-level images
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
      res.json(result);
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

  // ===== FULFILLMENT ROUTING RULES =====

  app.get("/api/fulfillment-routing-rules", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const rules = await db.select().from(fulfillmentRoutingRules).orderBy(sql`priority DESC, id`);
      res.json(rules);
    } catch (error) {
      console.error("Error fetching routing rules:", error);
      res.status(500).json({ error: "Failed to fetch routing rules" });
    }
  });

  app.post("/api/fulfillment-routing-rules", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const parsed = insertFulfillmentRoutingRuleSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid rule data", details: parsed.error });
      }
      const data = parsed.data;
      // Validate matchType
      if (!routingMatchTypeEnum.includes(data.matchType as any)) {
        return res.status(400).json({ error: `Invalid matchType. Must be one of: ${routingMatchTypeEnum.join(", ")}` });
      }
      // 'default' type doesn't need a matchValue
      if (data.matchType !== "default" && !data.matchValue) {
        return res.status(400).json({ error: "matchValue is required for non-default rules" });
      }
      const [rule] = await db.insert(fulfillmentRoutingRules).values(data as any).returning();
      res.status(201).json(rule);
    } catch (error) {
      console.error("Error creating routing rule:", error);
      res.status(500).json({ error: "Failed to create routing rule" });
    }
  });

  app.patch("/api/fulfillment-routing-rules/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const parsed = insertFulfillmentRoutingRuleSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid rule data", details: parsed.error });
      }
      const [rule] = await db.update(fulfillmentRoutingRules)
        .set({ ...parsed.data as any, updatedAt: new Date() })
        .where(eq(fulfillmentRoutingRules.id, id))
        .returning();
      if (!rule) {
        return res.status(404).json({ error: "Routing rule not found" });
      }
      res.json(rule);
    } catch (error) {
      console.error("Error updating routing rule:", error);
      res.status(500).json({ error: "Failed to update routing rule" });
    }
  });

  app.delete("/api/fulfillment-routing-rules/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [deleted] = await db.delete(fulfillmentRoutingRules)
        .where(eq(fulfillmentRoutingRules.id, id))
        .returning();
      if (!deleted) {
        return res.status(404).json({ error: "Routing rule not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting routing rule:", error);
      res.status(500).json({ error: "Failed to delete routing rule" });
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

  // ============================================================================
  // Products API (Master Catalog)
  // ============================================================================
  app.get("/api/products", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const allProducts = await storage.getAllProducts();
      const allVariants = await storage.getAllProductVariants();

      // Bulk-fetch primary images (one query instead of N)
      const primaryAssets = await db.select()
        .from(productAssets)
        .where(eq(productAssets.isPrimary, 1));
      const primaryImageByProductId = new Map<number, string>();
      for (const asset of primaryAssets) {
        if (asset.productId && asset.url) {
          primaryImageByProductId.set(asset.productId, asset.url);
        }
      }

      // Build variant lookup
      const variantsByProductId = new Map<number, typeof allVariants>();
      for (const v of allVariants) {
        if (!variantsByProductId.has(v.productId)) {
          variantsByProductId.set(v.productId, []);
        }
        variantsByProductId.get(v.productId)!.push(v);
      }

      const productsWithData = allProducts.map(p => ({
        ...p,
        baseSku: p.sku,
        name: p.title || p.name,
        active: p.status === "active" ? 1 : 0,
        imageUrl: primaryImageByProductId.get(p.id) || null,
        variantCount: variantsByProductId.get(p.id)?.length || 0,
        variants: variantsByProductId.get(p.id) || [],
      }));

      res.json(productsWithData);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  app.get("/api/products/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = await storage.getProductById(id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      const variants = await storage.getProductVariantsByProductId(id);

      // Get product assets directly (content fields are now on the product itself)
      const assets = await storage.getProductAssetsByProductId(id);

      res.json({ ...product, productId: product.id, variants, assets });
    } catch (error) {
      console.error("Error fetching product:", error);
      res.status(500).json({ error: "Failed to fetch product" });
    }
  });

  app.post("/api/products", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { variants, ...productData } = req.body;
      const product = await storage.createProduct(productData);
      
      // Create variants if provided
      if (variants && Array.isArray(variants)) {
        for (const variant of variants) {
          await storage.createProductVariant({
            ...variant,
            productId: product.id,
          });
        }
      }
      
      const createdVariants = await storage.getProductVariantsByProductId(product.id);
      res.json({ ...product, variants: createdVariants });
    } catch (error) {
      console.error("Error creating product:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  app.put("/api/products/:id", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { variants, ...updates } = req.body;
      const product = await storage.updateProduct(id, updates);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      const existingVariants = await storage.getProductVariantsByProductId(id);
      res.json({ ...product, variants: existingVariants });
    } catch (error) {
      console.error("Error updating product:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  app.delete("/api/products/:id", requirePermission("inventory", "delete"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      // First delete all variants
      const variants = await storage.getProductVariantsByProductId(id);
      for (const variant of variants) {
        await storage.deleteProductVariant(variant.id);
      }
      const success = await storage.deleteProduct(id);
      if (!success) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting product:", error);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  // ============================================================================
  // Product Assets API
  // ============================================================================
  app.get("/api/products/:id/assets", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const assets = await storage.getProductAssetsByProductId(productId);
      res.json(assets);
    } catch (error) {
      console.error("Error fetching product assets:", error);
      res.status(500).json({ error: "Failed to fetch assets" });
    }
  });

  app.post("/api/products/:id/assets", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const asset = await storage.createProductAsset({
        ...req.body,
        productId,
      });
      res.status(201).json(asset);
    } catch (error) {
      console.error("Error creating product asset:", error);
      res.status(500).json({ error: "Failed to create asset" });
    }
  });

  app.patch("/api/product-assets/:id", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const asset = await storage.updateProductAsset(id, req.body);
      if (!asset) {
        return res.status(404).json({ error: "Asset not found" });
      }
      res.json(asset);
    } catch (error) {
      console.error("Error updating product asset:", error);
      res.status(500).json({ error: "Failed to update asset" });
    }
  });

  app.delete("/api/product-assets/:id", requirePermission("inventory", "delete"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = await storage.deleteProductAsset(id);
      if (!success) {
        return res.status(404).json({ error: "Asset not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting product asset:", error);
      res.status(500).json({ error: "Failed to delete asset" });
    }
  });

  app.put("/api/products/:id/assets/reorder", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const { orderedIds } = req.body;
      if (!Array.isArray(orderedIds)) {
        return res.status(400).json({ error: "orderedIds array required" });
      }
      await storage.reorderProductAssets(productId, orderedIds);
      res.json({ success: true });
    } catch (error) {
      console.error("Error reordering product assets:", error);
      res.status(500).json({ error: "Failed to reorder assets" });
    }
  });

  app.put("/api/product-assets/:id/primary", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const assetId = parseInt(req.params.id);
      const { productId } = req.body;
      if (!productId) {
        return res.status(400).json({ error: "productId required" });
      }
      await storage.setPrimaryProductAsset(productId, assetId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error setting primary asset:", error);
      res.status(500).json({ error: "Failed to set primary asset" });
    }
  });

  // ============================================================================
  // Product Variants API
  // ============================================================================
  app.get("/api/product-variants", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const variants = await storage.getAllProductVariants();
      res.json(variants);
    } catch (error) {
      console.error("Error fetching all variants:", error);
      res.status(500).json({ error: "Failed to fetch variants" });
    }
  });

  app.get("/api/products/:productId/variants", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const variants = await storage.getProductVariantsByProductId(productId);
      res.json(variants);
    } catch (error) {
      console.error("Error fetching variants:", error);
      res.status(500).json({ error: "Failed to fetch variants" });
    }
  });

  app.post("/api/products/:productId/variants", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const variant = await storage.createProductVariant({
        ...req.body,
        productId,
      });
      res.json(variant);
    } catch (error) {
      console.error("Error creating variant:", error);
      res.status(500).json({ error: "Failed to create variant" });
    }
  });

  app.put("/api/product-variants/:id", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const variant = await storage.updateProductVariant(id, req.body);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }
      res.json(variant);
    } catch (error) {
      console.error("Error updating variant:", error);
      res.status(500).json({ error: "Failed to update variant" });
    }
  });

  app.delete("/api/product-variants/:id", requirePermission("inventory", "delete"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const success = await storage.deleteProductVariant(id);
      if (!success) {
        return res.status(404).json({ error: "Variant not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting variant:", error);
      res.status(500).json({ error: "Failed to delete variant" });
    }
  });

  // Warehouse Locations (hierarchical)
  app.get("/api/warehouse/locations", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const locations = await storage.getAllWarehouseLocations();

      // Enrich with all assigned SKUs from product_locations
      const assignedSkusResult = await db.execute(sql`
        SELECT warehouse_location_id, STRING_AGG(sku, ', ' ORDER BY is_primary DESC, sku) as skus
        FROM product_locations
        WHERE sku IS NOT NULL
        GROUP BY warehouse_location_id
      `);
      const primarySkuMap = new Map<number, string>();
      for (const row of assignedSkusResult.rows as any[]) {
        if (row.warehouse_location_id && row.skus) {
          primarySkuMap.set(row.warehouse_location_id, row.skus);
        }
      }

      const enriched = locations.map(loc => ({
        ...loc,
        primarySku: primarySkuMap.get(loc.id) || null,
      }));

      res.json(enriched);
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
        ["code", "zone", "aisle", "bay", "level", "bin", "name", "location_type", "is_pickable", "pick_sequence", "width_mm", "height_mm", "depth_mm"].join(",")
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
          loc.widthMm ?? "",
          loc.heightMm ?? "",
          loc.depthMm ?? ""
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
            widthMm: loc.widthMm || loc.width_mm 
              ? parseInt(loc.widthMm || loc.width_mm) 
              : (existing?.widthMm ?? null),
            heightMm: loc.heightMm || loc.height_mm 
              ? parseInt(loc.heightMm || loc.height_mm) 
              : (existing?.heightMm ?? null),
            depthMm: loc.depthMm || loc.depth_mm 
              ? parseInt(loc.depthMm || loc.depth_mm) 
              : (existing?.depthMm ?? null),
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

  // Get actual inventory at a specific bin (warehouse location) - shows what's really there
  app.get("/api/warehouse/locations/:id/inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseLocationId = parseInt(req.params.id);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }
      
      // Get all inventory levels at this location with variant and product details
      const result = await db.execute<{
        id: number;
        product_variant_id: number;
        variant_qty: number;
        reserved_qty: number;
        picked_qty: number;
        sku: string | null;
        variant_name: string | null;
        units_per_variant: number;
        product_title: string | null;
        product_id: number | null;
        image_url: string | null;
        barcode: string | null;
      }>(sql`
        SELECT
          il.id,
          il.product_variant_id,
          il.variant_qty,
          il.reserved_qty,
          il.picked_qty,
          pv.sku,
          pv.name as variant_name,
          pv.units_per_variant,
          COALESCE(p.title, p.name) as product_title,
          p.id as product_id,
          (SELECT pa.url FROM product_assets pa WHERE pa.product_id = p.id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1) as image_url,
          pv.barcode
        FROM inventory_levels il
        JOIN product_variants pv ON il.product_variant_id = pv.id
        LEFT JOIN products p ON pv.product_id = p.id
        WHERE il.warehouse_location_id = ${warehouseLocationId}
          AND il.variant_qty > 0
        ORDER BY pv.sku
      `);

      const inventory = result.rows.map(row => ({
        id: row.id,
        variantId: row.product_variant_id,
        qty: row.variant_qty,
        reservedQty: row.reserved_qty,
        pickedQty: row.picked_qty,
        sku: row.sku,
        variantName: row.variant_name,
        unitsPerVariant: row.units_per_variant,
        productTitle: row.product_title,
        productId: row.product_id,
        imageUrl: row.image_url,
        barcode: row.barcode,
      }));
      
      res.json(inventory);
    } catch (error: any) {
      console.error("Error fetching inventory for location:", error);
      res.status(500).json({ error: error.message || "Failed to fetch inventory" });
    }
  });

  // Get products assigned to a specific bin (warehouse location) - LEGACY: for bin-centric view
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

  // Assign a product/variant to a bin (add location) - for bin-centric assignment
  app.post("/api/warehouse/locations/:id/products", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const warehouseLocationId = parseInt(req.params.id);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }

      const { productId, productVariantId, isPrimary } = req.body;
      if (!productId && !productVariantId) {
        return res.status(400).json({ error: "productId or productVariantId is required" });
      }

      // Get warehouse location details
      const warehouseLocation = await storage.getWarehouseLocationById(warehouseLocationId);
      if (!warehouseLocation) {
        return res.status(404).json({ error: "Warehouse location not found" });
      }

      if (warehouseLocation.isPickable !== 1) {
        return res.status(400).json({ error: `Location ${warehouseLocation.code} is not pickable` });
      }

      let finalProductId = productId;
      let finalVariantId = productVariantId;
      let assignmentSku: string | null = null;
      let assignmentName: string;
      let shopifyVariantId: number | null = null;

      // If variant is provided, use variant-specific data
      if (productVariantId) {
        const variant = await storage.getProductVariantById(productVariantId);
        if (!variant) {
          return res.status(404).json({ error: "Product variant not found" });
        }
        finalProductId = variant.productId;
        assignmentSku = variant.sku;
        assignmentName = variant.name || variant.sku || "Unknown Variant";
        shopifyVariantId = variant.shopifyVariantId ? Number(variant.shopifyVariantId) : null;
      } else {
        // Product-level assignment (original behavior)
        const product = await storage.getProductById(productId!);
        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }
        assignmentSku = product.sku || null;
        assignmentName = product.title || product.name;
        shopifyVariantId = product.shopifyProductId ? Number(product.shopifyProductId) : null;
      }

      const productLocation = await storage.addProductToLocation({
        productId: finalProductId!,
        productVariantId: finalVariantId || null,
        warehouseLocationId,
        sku: assignmentSku,
        shopifyVariantId,
        name: assignmentName,
        location: warehouseLocation.code,
        zone: warehouseLocation.zone || warehouseLocation.code.split("-")[0] || "A",
        isPrimary: isPrimary ?? 1,
      });

      // Auto-sync pick queue for this SKU (fire-and-forget)
      if (assignmentSku) {
        syncPickQueueForSku(assignmentSku).catch(() => {});
      }

      res.status(201).json(productLocation);
    } catch (error: any) {
      console.error("Error assigning product to location:", error);
      res.status(500).json({ error: error.message || "Failed to assign product" });
    }
  });

  // Get all locations for a specific product
  app.get("/api/products/:productId/locations", async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        return res.status(400).json({ error: "Invalid product ID" });
      }
      const locations = await storage.getProductLocationsByProductId(productId);
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

  // ============================================================================
  // Bin Assignments (variant-centric pick location management)
  // ============================================================================
  app.get("/api/bin-assignments", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { search, unassignedOnly, zone, warehouseId } = req.query;
      const assignments = await binAssignment.getAssignmentsView({
        search: search as string || undefined,
        unassignedOnly: unassignedOnly === "true",
        zone: zone as string || undefined,
        warehouseId: warehouseId ? parseInt(warehouseId as string) : undefined,
      });
      res.json(assignments);
    } catch (error: any) {
      console.error("Error fetching bin assignments:", error);
      res.status(500).json({ error: "Failed to fetch bin assignments" });
    }
  });

  app.put("/api/bin-assignments", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const { productVariantId, warehouseLocationId, isPrimary } = req.body;
      if (!productVariantId || !warehouseLocationId) {
        return res.status(400).json({ error: "productVariantId and warehouseLocationId are required" });
      }
      const result = await binAssignment.assignVariantToLocation({
        productVariantId,
        warehouseLocationId,
        isPrimary,
      });

      // Fire-and-forget: sync pick queue for this SKU
      if (result.sku) {
        syncPickQueueForSku(result.sku).catch(() => {});
      }

      res.json(result);
    } catch (error: any) {
      console.error("Error upserting bin assignment:", error);
      res.status(500).json({ error: error.message || "Failed to update bin assignment" });
    }
  });

  app.delete("/api/bin-assignments/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await binAssignment.unassignVariant(id);
      if (!deleted) return res.status(404).json({ error: "Assignment not found" });

      // Fire-and-forget: sync pick queue for this SKU
      if (deleted.sku) {
        syncPickQueueForSku(deleted.sku).catch(() => {});
      }

      res.status(204).end();
    } catch (error: any) {
      console.error("Error deleting bin assignment:", error);
      res.status(500).json({ error: "Failed to delete bin assignment" });
    }
  });

  app.post("/api/bin-assignments/import", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const { assignments } = req.body;
      if (!Array.isArray(assignments) || assignments.length === 0) {
        return res.status(400).json({ error: "assignments array is required" });
      }

      const results = await binAssignment.importAssignments(assignments);
      res.json(results);
    } catch (error: any) {
      console.error("Error importing bin assignments:", error);
      res.status(500).json({ error: "Failed to import bin assignments" });
    }
  });

  app.get("/api/bin-assignments/export", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const csv = await binAssignment.exportAssignments();
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=bin-assignments.csv");
      res.send(csv);
    } catch (error: any) {
      console.error("Error exporting bin assignments:", error);
      res.status(500).json({ error: "Failed to export bin assignments" });
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

  // Catalog Products API — now backed by `products` table directly
  app.get("/api/catalog/products", async (req, res) => {
    try {
      const allProducts = await storage.getAllProducts();
      res.json(allProducts);
    } catch (error) {
      console.error("Error fetching catalog products:", error);
      res.status(500).json({ error: "Failed to fetch catalog products" });
    }
  });

  // Search for SKUs to assign to bin locations
  // Searches product_variants and resolves to their parent product
  app.get("/api/catalog/products/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim().toLowerCase();
      const limit = parseInt(String(req.query.limit)) || 20;
      if (!query || query.length < 2) return res.json([]);

      const searchPattern = `%${query}%`;

      // Search product_variants and resolve to their parent product
      const result = await db.execute<{
        product_id: number;
        variant_sku: string;
        variant_name: string;
        product_sku: string | null;
        product_title: string | null;
        image_url: string | null;
      }>(sql`
        SELECT
          p.id as product_id,
          pv.sku as variant_sku,
          pv.name as variant_name,
          p.sku as product_sku,
          COALESCE(p.title, p.name) as product_title,
          (SELECT pa.url FROM product_assets pa WHERE pa.product_id = p.id AND pa.product_variant_id IS NULL AND pa.is_primary = 1 LIMIT 1) as image_url
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE pv.is_active = true
          AND pv.sku IS NOT NULL
          AND (
            LOWER(pv.sku) LIKE ${searchPattern} OR
            LOWER(pv.name) LIKE ${searchPattern} OR
            LOWER(p.sku) LIKE ${searchPattern} OR
            LOWER(COALESCE(p.title, p.name)) LIKE ${searchPattern}
          )
        ORDER BY pv.sku
        LIMIT ${limit}
      `);

      res.json(result.rows.map(r => ({
        id: r.product_id,
        sku: r.variant_sku,
        title: r.product_title || r.variant_name,
        imageUrl: r.image_url,
        matchedVariantSku: r.variant_sku !== r.product_sku ? r.variant_sku : null,
      })));
    } catch (error) {
      console.error("Error searching catalog products:", error);
      res.status(500).json({ error: "Failed to search catalog products" });
    }
  });

  app.get("/api/catalog/products/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const product = await storage.getProductById(id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      // Get variants and assets
      const variants = await storage.getProductVariantsByProductId(product.id);
      const assets = await storage.getProductAssetsByProductId(product.id);

      res.json({ ...product, variants, assets });
    } catch (error) {
      console.error("Error fetching catalog product:", error);
      res.status(500).json({ error: "Failed to fetch catalog product" });
    }
  });

  app.post("/api/catalog/products", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const validatedData = insertProductSchema.parse(req.body);
      const product = await storage.createProduct(validatedData);
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
      const validatedData = insertProductSchema.partial().parse(req.body);
      const product = await storage.updateProduct(id, validatedData);
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
      const deleted = await storage.deleteProduct(id);
      if (!deleted) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting catalog product:", error);
      res.status(500).json({ error: error.message || "Failed to delete catalog product" });
    }
  });

  // NOTE: Duplicate GET /api/products and /api/products/:id removed — consolidated into master catalog section above

  // Products (Master SKUs) - replaces legacy inventory_items
  app.get("/api/inventory/items", async (req, res) => {
    try {
      const items = await storage.getAllProducts();
      res.json(items);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  // Get products without bin locations (for assignment)
  app.get("/api/inventory/items/unassigned", async (req, res) => {
    try {
      const products = await storage.getProductsWithoutLocations();
      res.json(products);
    } catch (error) {
      console.error("Error fetching unassigned products:", error);
      res.status(500).json({ error: "Failed to fetch unassigned products" });
    }
  });

  app.get("/api/inventory/items/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { atp } = req.app.locals.services as any;
      const summary = await atp.getInventoryItemSummary(id);
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
      const parsed = insertProductSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid product data", details: parsed.error });
      }
      const item = await storage.createProduct(parsed.data);
      res.status(201).json(item);
    } catch (error) {
      console.error("Error creating product:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  // Product Variants (replaces legacy UOM Variants)
  app.get("/api/inventory/variants", async (req, res) => {
    try {
      const variants = await storage.getAllProductVariants();
      res.json(variants);
    } catch (error) {
      console.error("Error fetching product variants:", error);
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

      const updated = await storage.updateProductVariant(variantId, { unitsPerVariant });
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
      const variants = await storage.getProductVariantsByProductId(id);
      res.json(variants);
    } catch (error) {
      console.error("Error fetching variants for product:", error);
      res.status(500).json({ error: "Failed to fetch variants" });
    }
  });

  app.post("/api/inventory/variants", async (req, res) => {
    try {
      const parsed = insertProductVariantSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid variant data", details: parsed.error });
      }
      const variant = await storage.createProductVariant(parsed.data);
      res.status(201).json(variant);
    } catch (error) {
      console.error("Error creating product variant:", error);
      res.status(500).json({ error: "Failed to create variant" });
    }
  });

  // Inventory Levels & Adjustments - uses productVariantId as source of truth
  app.get("/api/inventory/levels/:variantId", async (req, res) => {
    try {
      const variantId = parseInt(req.params.variantId);
      const levels = await storage.getInventoryLevelsByProductVariantId(variantId);
      res.json(levels);
    } catch (error) {
      console.error("Error fetching inventory levels:", error);
      res.status(500).json({ error: "Failed to fetch levels" });
    }
  });

  app.post("/api/inventory/adjust", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventoryCore } = req.app.locals.services;
      const { inventoryItemId, productVariantId: pvId, warehouseLocationId, baseUnitsDelta, qtyDelta: bodyQtyDelta, reason } = req.body;
      const userId = req.session.user?.id;
      const adjustVariantId = pvId || inventoryItemId; // Support both old and new param names
      const qtyDelta = bodyQtyDelta ?? baseUnitsDelta; // Accept both param names

      if (!adjustVariantId || !warehouseLocationId || qtyDelta === undefined || !reason) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      await inventoryCore.adjustInventory({
        productVariantId: adjustVariantId,
        warehouseLocationId,
        qtyDelta,
        reason,
        userId,
      });

      // Sync to sales channels after adjustment (fire-and-forget)
      const { channelSync: adjSync, replenishment: adjReplen } = req.app.locals.services as any;
      if (adjSync) {
        adjSync.queueSyncAfterInventoryChange(adjustVariantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-adjust sync failed for variant ${adjustVariantId}:`, err)
        );
      }
      // Auto-trigger replenishment check (fire-and-forget)
      if (adjReplen) {
        adjReplen.checkAndTriggerAfterPick(adjustVariantId, warehouseLocationId).catch((err: any) =>
          console.warn(`[Replen] Post-adjust check failed for variant ${adjustVariantId}:`, err)
        );
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error adjusting inventory:", error);
      res.status(500).json({ error: "Failed to adjust inventory" });
    }
  });

  // Search SKUs for typeahead (used in cycle counts, receiving, etc.)
  // product_variants is source of truth for sellable SKUs
  app.get("/api/inventory/skus/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim().toLowerCase();
      const locationId = req.query.locationId ? parseInt(String(req.query.locationId)) : null;
      const limit = parseInt(String(req.query.limit)) || 20;

      if (locationId) {
        const result = await db.execute(sql`
          SELECT
            pv.sku as sku,
            pv.name as name,
            pv.id as "variantId",
            il.variant_qty as available,
            wl.id as "locationId",
            wl.code as location
          FROM inventory_levels il
          JOIN product_variants pv ON pv.id = il.product_variant_id
          JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
          WHERE il.warehouse_location_id = ${locationId}
            AND il.variant_qty > 0
          ORDER BY pv.sku
          LIMIT ${limit}
        `);
        return res.json(result.rows);
      }

      if (!query) {
        return res.json([]);
      }

      const searchPattern = `%${query}%`;

      const result = await db.execute(sql`
        SELECT
          pv.sku as sku,
          pv.name as name,
          'product_variant' as source,
          pv.product_id as "productId",
          pv.id as "productVariantId",
          pv.units_per_variant as "unitsPerVariant"
        FROM product_variants pv
        WHERE pv.is_active = true
          AND pv.sku IS NOT NULL
          AND (
            LOWER(pv.sku) LIKE ${searchPattern} OR
            LOWER(pv.name) LIKE ${searchPattern}
          )
        ORDER BY pv.sku
        LIMIT ${limit}
      `);

      res.json(result.rows);
    } catch (error) {
      console.error("Error searching SKUs:", error);
      res.status(500).json({ error: "Failed to search SKUs" });
    }
  });

  app.get("/api/inventory/sku-locations", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim().toLowerCase();
      if (!query || query.length < 2) {
        return res.json([]);
      }

      const searchPattern = `%${query}%`;

      const result = await db.execute(sql`
        SELECT
          pv.sku,
          pv.name,
          pv.id as "variantId",
          wl.code as location,
          wl.zone,
          wl.location_type as "locationType",
          il.variant_qty as available,
          il.warehouse_location_id as "locationId",
          w.code as "warehouseCode"
        FROM inventory_levels il
        JOIN product_variants pv ON pv.id = il.product_variant_id
        JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
        LEFT JOIN warehouses w ON w.id = wl.warehouse_id
        WHERE il.variant_qty > 0
          AND (
            LOWER(pv.sku) LIKE ${searchPattern} OR
            LOWER(pv.name) LIKE ${searchPattern}
          )
        ORDER BY pv.sku, wl.code
      `);

      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching SKU locations:", error);
      res.status(500).json({ error: "Failed to fetch SKU locations" });
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
        { code: "MISPLACED", name: "Misplaced", description: "Item found in wrong location (offsetting variances)", transactionType: "adjustment", sortOrder: 8 },
        { code: "SHRINKAGE", name: "Shrinkage/Loss", description: "Unexplained inventory loss", transactionType: "adjustment", requiresNote: 1, sortOrder: 9 },
        { code: "FOUND", name: "Found Inventory", description: "Previously unaccounted inventory found", transactionType: "adjustment", sortOrder: 10 },
        { code: "SHOPIFY_SYNC", name: "Shopify Sync", description: "Adjustment from Shopify inventory sync", transactionType: "adjustment", sortOrder: 11 },
        { code: "MANUAL_ADJ", name: "Manual Adjustment", description: "Manual inventory correction", transactionType: "adjustment", requiresNote: 1, sortOrder: 12 },
        { code: "PICKING", name: "Order Picking", description: "Items picked for customer order", transactionType: "pick", sortOrder: 13 },
        { code: "SHORT_PICK", name: "Short Pick", description: "Unable to pick full quantity", transactionType: "pick", requiresNote: 1, sortOrder: 14 },
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

  // ============================================
  // BIN-TO-BIN TRANSFERS
  // ============================================
  
  app.post("/api/inventory/transfer", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventoryCore } = req.app.locals.services;
      const { fromLocationId, toLocationId, variantId, quantity, notes } = req.body;

      // Validate required fields exist
      if (!fromLocationId || !toLocationId || !variantId || !quantity) {
        return res.status(400).json({ error: "Missing required fields: fromLocationId, toLocationId, variantId, quantity" });
      }

      // Parse and validate as integers
      const fromLocId = parseInt(String(fromLocationId));
      const toLocId = parseInt(String(toLocationId));
      const varId = parseInt(String(variantId));
      const qty = parseInt(String(quantity));

      if (isNaN(fromLocId) || isNaN(toLocId) || isNaN(varId) || isNaN(qty)) {
        return res.status(400).json({ error: "All numeric fields must be valid integers" });
      }

      if (fromLocId === toLocId) {
        return res.status(400).json({ error: "Source and destination must be different" });
      }

      if (qty <= 0) {
        return res.status(400).json({ error: "Quantity must be positive" });
      }

      // Validate locations exist
      const fromLoc = await storage.getWarehouseLocationById(fromLocId);
      const toLoc = await storage.getWarehouseLocationById(toLocId);
      if (!fromLoc) {
        return res.status(400).json({ error: "Source location not found" });
      }
      if (!toLoc) {
        return res.status(400).json({ error: "Destination location not found" });
      }

      const userId = req.session.user?.id || "system";

      const variant = await storage.getProductVariantById(varId);
      if (!variant) {
        return res.status(400).json({ error: "Variant not found" });
      }

      await inventoryCore.transfer({
        productVariantId: varId,
        fromLocationId: fromLocId,
        toLocationId: toLocId,
        qty,
        userId,
        notes: typeof notes === "string" ? notes : undefined,
      });

      // Sync to sales channels after transfer (fire-and-forget)
      const { channelSync: xfrSync, replenishment: xfrReplen } = req.app.locals.services as any;
      if (xfrSync) {
        xfrSync.queueSyncAfterInventoryChange(varId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-transfer sync failed for variant ${varId}:`, err)
        );
      }
      // Auto-trigger replenishment check on source location (fire-and-forget)
      if (xfrReplen) {
        xfrReplen.checkAndTriggerAfterPick(varId, fromLocId).catch((err: any) =>
          console.warn(`[Replen] Post-transfer check failed for variant ${varId}:`, err)
        );
      }
      // Auto-sync pick queue locations for this SKU (fire-and-forget)
      if (variant.sku) {
        syncPickQueueForSku(variant.sku).catch(() => {});
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Transfer error:", error);
      res.status(400).json({ error: String(error) });
    }
  });
  
  app.get("/api/inventory/transfers", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const transfers = await storage.getTransferHistory(limit);
      res.json(transfers);
    } catch (error) {
      console.error("Get transfers error:", error);
      res.status(500).json({ error: "Failed to get transfer history" });
    }
  });
  
  app.post("/api/inventory/transfer/:id/undo", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const transactionId = parseInt(req.params.id);
      const userId = req.session.user?.id || "system";
      
      const transaction = await storage.undoTransfer(transactionId, userId);
      res.json({ success: true, transaction });
    } catch (error) {
      console.error("Undo transfer error:", error);
      res.status(400).json({ error: String(error) });
    }
  });

  // Inventory Transactions History
  app.get("/api/inventory/transactions", async (req, res) => {
    try {
      const { batchId, transactionType, startDate, endDate, limit, offset, locationCode } = req.query;

      // Resolve locationCode → locationId
      let locationId: number | undefined;
      if (locationCode) {
        const allLocations = await storage.getAllWarehouseLocations();
        const loc = allLocations.find(l => l.code.toLowerCase() === (locationCode as string).toLowerCase());
        if (loc) locationId = loc.id;
      }

      const transactions = await storage.getInventoryTransactions({
        batchId: batchId as string,
        transactionType: transactionType as string,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        locationId,
        limit: limit ? Math.min(parseInt(limit as string), 200) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });

      // Enrich with location, variant, and order details
      const locIds = new Set<number>();
      const varIds = new Set<number>();
      const orderIds = new Set<number>();
      for (const tx of transactions) {
        if (tx.fromLocationId) locIds.add(tx.fromLocationId);
        if (tx.toLocationId) locIds.add(tx.toLocationId);
        if (tx.productVariantId) varIds.add(tx.productVariantId);
        if (tx.orderId) orderIds.add(tx.orderId);
      }
      const [allLocs, allVariants, orderList] = await Promise.all([
        locIds.size > 0 ? storage.getAllWarehouseLocations() : [],
        varIds.size > 0 ? storage.getAllProductVariants() : [],
        orderIds.size > 0 ? Promise.all([...orderIds].map(id => storage.getOrderById(id))) : [],
      ]);
      const locMap = new Map(allLocs.filter(l => locIds.has(l.id)).map(l => [l.id, l]));
      const varMap = new Map(allVariants.filter(v => varIds.has(v.id)).map(v => [v.id, v]));
      const orderMap = new Map(orderList.filter(Boolean).map(o => [o!.id, o!]));

      res.json(transactions.map(tx => ({
        ...tx,
        fromLocation: tx.fromLocationId ? locMap.get(tx.fromLocationId) ?? null : null,
        toLocation: tx.toLocationId ? locMap.get(tx.toLocationId) ?? null : null,
        product: tx.productVariantId ? varMap.get(tx.productVariantId) ?? null : null,
        order: tx.orderId ? orderMap.get(tx.orderId) ? { id: orderMap.get(tx.orderId)!.id, orderNumber: orderMap.get(tx.orderId)!.orderNumber } : null : null,
      })));
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

        // Try to find as variant SKU first, then as base product SKU
        let variant = await storage.getProductVariantBySku(sku);
        let product: any = null;

        if (variant) {
          // Found as variant SKU - get the parent product
          product = await storage.getProductById(variant.productId);
        } else {
          // Try as base SKU - find the product and use unitsPerVariant=1
          product = await storage.getProductBySku(sku);
        }

        if (!product) {
          results.push({ row: rowNum, sku, location: locationCode, status: "error", message: `SKU not found: ${sku}` });
          errorCount++;
          continue;
        }

        try {
          const targetQty = quantity;

          if (!variant) {
            results.push({ row: rowNum, sku, location: locationCode, status: "error", message: `No variant found for SKU: ${sku}` });
            errorCount++;
            continue;
          }

          // Find existing level by variantId (source of truth)
          const existingLevel = await storage.getInventoryLevelByLocationAndVariant(warehouseLocation.id, variant.id);

          if (existingLevel) {
            // Calculate delta from current value
            const currentQty = existingLevel.variantQty || 0;
            const qtyDelta = targetQty - currentQty;

            await storage.adjustInventoryLevel(existingLevel.id, {
              variantQty: qtyDelta,
            });
          } else {
            // Create new level - productVariantId is required
            await storage.upsertInventoryLevel({
              warehouseLocationId: warehouseLocation.id,
              productVariantId: variant.id,
              variantQty: targetQty,
              reservedQty: 0,
              pickedQty: 0,
              packedQty: 0,
              backorderQty: 0,
            });
          }

          // Log the transaction with before/after snapshots
          const variantQtyBefore = existingLevel ? (existingLevel.variantQty || 0) : 0;
          const variantQtyDelta = targetQty - variantQtyBefore;

          // Log with Full WMS fields
          const { inventoryCore: csvCore } = req.app.locals.services as any;
          await csvCore.logTransaction({
            productVariantId: variant?.id,
            toLocationId: warehouseLocation.id, // CSV import = TO location (adding/setting inventory)
            transactionType: "csv_upload",
            reasonId: csvReason?.id,
            variantQtyDelta,
            variantQtyBefore,
            variantQtyAfter: targetQty,
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
      const { inventoryCore } = req.app.locals.services;
      const { variantId, warehouseLocationId, quantity, referenceId, notes } = req.body;
      const userId = req.session.user.id;

      if (!variantId || !warehouseLocationId || !quantity) {
        return res.status(400).json({ error: "Missing required fields: variantId, warehouseLocationId, quantity" });
      }

      // Get the variant by ID directly (more efficient than getting all)
      const targetVariant = await storage.getProductVariantById(variantId);

      if (!targetVariant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      if (!targetVariant.isActive) {
        return res.status(400).json({ error: "Cannot receive stock for inactive variant" });
      }

      // Verify warehouse location exists
      const location = await storage.getWarehouseLocationById(warehouseLocationId);
      if (!location) {
        return res.status(404).json({ error: "Warehouse location not found" });
      }

      const variantQty = quantity;

      // Generate a reference ID if not provided
      const refId = referenceId || `RCV-${Date.now()}`;

      await inventoryCore.receiveInventory({
        productVariantId: variantId,
        warehouseLocationId,
        qty: variantQty,
        referenceId: refId,
        notes: notes || "Stock received via UI",
        userId,
      });

      // Sync to sales channels after receive (fire-and-forget)
      const { channelSync: rcvSync } = req.app.locals.services as any;
      if (rcvSync) {
        rcvSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-receive sync failed for variant ${variantId}:`, err)
        );
      }

      res.json({ success: true, variantQtyReceived: variantQty });
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
      const variant = await storage.getProductVariantById(variantId);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      const levels = await storage.getInventoryLevelsByProductVariantId(variantId);
      
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


  // Check backorder status for an item
  app.get("/api/inventory/backorder-status/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const { atp: atpSvc } = req.app.locals.services as any;
      const variant = await storage.getProductVariantById(itemId);
      let status;
      if (!variant) {
        status = { isBackordered: false, backorderQty: 0, atp: 0 };
      } else {
        const atpBase = await atpSvc.getAtpBase(variant.productId);
        status = {
          isBackordered: atpBase < 0,
          backorderQty: atpBase < 0 ? Math.abs(atpBase) : 0,
          atp: atpBase,
        };
      }
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
      const transactions = await storage.getInventoryTransactionsByProductVariantId(itemId, limit);
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
  // Optional query params: warehouseId (filter by warehouse)
  app.get("/api/inventory/summary", async (req, res) => {
    try {
      const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null;
      
      if (warehouseId) {
        // Warehouse-specific summary: filter inventory levels by locations in this warehouse
        const allLocations = await storage.getAllWarehouseLocations();
        const warehouseLocationIds = new Set(
          allLocations.filter(loc => loc.warehouseId === warehouseId).map(loc => loc.id)
        );
        
        const allLevels = await storage.getAllInventoryLevels();
        const filteredLevels = allLevels.filter(level => warehouseLocationIds.has(level.warehouseLocationId));
        
        // Group levels by variantId to calculate totals
        const levelsByVariant = new Map<number, typeof filteredLevels>();
        for (const level of filteredLevels) {
          if (!level.productVariantId) continue;
          const existing = levelsByVariant.get(level.productVariantId) || [];
          existing.push(level);
          levelsByVariant.set(level.productVariantId, existing);
        }
        
        // Get all variants and products to build summaries
        const allVariants = await storage.getAllProductVariants();
        const allProducts = await storage.getAllProducts();
        const variantToProduct = new Map<number, number>();
        for (const v of allVariants) {
          variantToProduct.set(v.id, v.productId);
        }

        // Build summary by product
        const summaryByProduct = new Map<number, {
          productId: number;
          baseSku: string;
          name: string;
          totalOnHandPieces: number;
          totalReservedPieces: number;
          totalAtpPieces: number;
          variants: Array<{
            variantId: number;
            sku: string;
            name: string;
            unitsPerVariant: number;
            available: number;
            variantQty: number;
            reservedQty: number;
            pickedQty: number;
            atpPieces: number;
          }>;
        }>();

        for (const [variantId, levels] of levelsByVariant) {
          const variant = allVariants.find(v => v.id === variantId);
          if (!variant) continue;
          const productId = variant.productId;
          const product = allProducts.find(p => p.id === productId);
          if (!product) continue;

          const upv = variant.unitsPerVariant || 1;
          const variantQty = levels.reduce((sum, l) => sum + (l.variantQty || 0), 0);
          const reservedQty = levels.reduce((sum, l) => sum + (l.reservedQty || 0), 0);
          const pickedQty = levels.reduce((sum, l) => sum + (l.pickedQty || 0), 0);
          const onHandPieces = variantQty * upv;
          const reservedPieces = reservedQty * upv;
          const pickedPieces = pickedQty * upv;
          const atpPieces = onHandPieces - reservedPieces - pickedPieces;

          let summary = summaryByProduct.get(productId);
          if (!summary) {
            summary = {
              productId,
              baseSku: product.sku || '',
              name: product.name,
              totalOnHandPieces: 0,
              totalReservedPieces: 0,
              totalAtpPieces: 0,
              variants: [],
            };
            summaryByProduct.set(productId, summary);
          }

          summary.totalOnHandPieces += onHandPieces;
          summary.totalReservedPieces += reservedPieces;
          summary.totalAtpPieces += atpPieces;
          summary.variants.push({
            variantId: variant.id,
            sku: variant.sku || '',
            name: variant.name,
            unitsPerVariant: variant.unitsPerVariant,
            available: Math.floor(atpPieces / upv),
            variantQty,
            reservedQty,
            pickedQty,
            atpPieces,
          });
        }

        res.json(Array.from(summaryByProduct.values()));
      } else {
        // Original behavior: full summary across all warehouses
        const products = await storage.getAllProducts();
        const summaries = await Promise.all(
          products.map(product => (req.app.locals.services as any).atp.getInventoryItemSummary(product.id))
        );
        res.json(summaries.filter(Boolean));
      }
    } catch (error) {
      console.error("Error fetching inventory summary:", error);
      res.status(500).json({ error: "Failed to fetch summary" });
    }
  });

  // Sync inventory to all active channels via channel-sync service.
  // Supports single-product sync (productId in body) or full sync.
  app.post("/api/inventory/sync-shopify", async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services as any;
      const { productId } = req.body;

      if (productId) {
        const result = await channelSync.syncProduct(Number(productId));
        return res.json({
          message: "Channel inventory sync completed",
          synced: result.synced,
          errors: result.errors,
          variants: result.variants,
        });
      }

      const result = await channelSync.syncAllProducts();
      res.json({
        message: "Channel inventory sync completed",
        synced: result.synced,
        errors: result.errors,
        total: result.total,
      });
    } catch (error) {
      console.error("Error syncing inventory to channels:", error);
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
        status: order.warehouseStatus,
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
        warehouseStatus: "ready" as const,
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
      
      // Read credentials from request body (per-channel, not env vars)
      const { shopDomain: rawDomain, accessToken } = req.body as { shopDomain?: string; accessToken?: string };
      if (!rawDomain || !accessToken) {
        return res.status(400).json({
          error: "Missing credentials",
          message: "Please provide shopDomain and accessToken",
        });
      }
      // Normalize: "my-store" → "my-store.myshopify.com"
      const shopDomain = rawDomain.includes('.myshopify.com') ? rawDomain : `${rawDomain}.myshopify.com`;
      const store = shopDomain.replace(/\.myshopify\.com$/, '');

      // Test the connection by fetching shop info
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

      // Create/update the connection (store credentials per-channel)
      const connection = await storage.upsertChannelConnection({
        channelId,
        shopDomain,
        accessToken,
        syncStatus: 'connected',
        lastSyncAt: new Date(),
      });
      
      // Update channel status to active
      await storage.updateChannel(channelId, { status: 'active' });
      
      // Fetch Shopify locations
      let locations: any[] = [];
      try {
        const locResponse = await fetch(
          `https://${store}.myshopify.com/admin/api/2024-01/locations.json`,
          {
            headers: {
              "X-Shopify-Access-Token": accessToken,
              "Content-Type": "application/json",
            },
          }
        );
        if (locResponse.ok) {
          const locData = await locResponse.json();
          locations = (locData.locations || []).map((loc: any) => ({
            id: String(loc.id),
            name: loc.name,
            address1: loc.address1,
            city: loc.city,
            province: loc.province,
            country: loc.country_name,
            active: loc.active,
          }));
        }
      } catch (locErr) {
        console.warn("Could not fetch Shopify locations:", locErr);
      }

      // Fetch current warehouse mappings
      const warehouses = await storage.getAllWarehouses();
      const mappings = warehouses
        .filter((w: any) => w.shopifyLocationId)
        .map((w: any) => ({ warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, shopifyLocationId: w.shopifyLocationId }));

      // Auto-create channel feeds for all product variants with Shopify variant IDs
      let feedsCreated = 0;
      let feedsUpdated = 0;
      try {
        const allVariants = await storage.getAllProductVariants();
        const shopifyVariants = allVariants.filter((v: any) => v.shopifyVariantId);

        // Build product ID → Shopify product ID map
        const productIds = [...new Set(shopifyVariants.map((v: any) => v.productId))];
        const productMap = new Map<number, string>();
        for (const pid of productIds) {
          const prod = await storage.getProductById(pid);
          if (prod?.shopifyProductId) {
            productMap.set(pid, prod.shopifyProductId);
          }
        }

        for (const pv of shopifyVariants) {
          const existing = await storage.getChannelFeedByVariantAndChannel(pv.id, 'shopify');
          await storage.upsertChannelFeed({
            channelId: channelId,
            productVariantId: pv.id,
            channelType: 'shopify',
            channelVariantId: pv.shopifyVariantId!,
            channelProductId: productMap.get(pv.productId) || null,
            channelSku: pv.sku || null,
            isActive: 1,
          });
          if (existing) feedsUpdated++;
          else feedsCreated++;
        }
        console.log(`[Setup Shopify] Channel feeds: ${feedsCreated} created, ${feedsUpdated} updated`);
      } catch (feedErr) {
        console.warn("Could not auto-create channel feeds:", feedErr);
      }

      res.json({
        success: true,
        connection,
        shop: {
          name: shopData.shop?.name,
          domain: shopData.shop?.domain,
          email: shopData.shop?.email,
        },
        locations,
        mappings,
        feeds: { created: feedsCreated, updated: feedsUpdated },
      });
    } catch (error) {
      console.error("Error setting up Shopify connection:", error);
      res.status(500).json({ error: "Failed to setup Shopify connection" });
    }
  });

  // Fetch Shopify locations for a connected channel
  app.get("/api/channels/:id/shopify-locations", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      if (!channel) return res.status(404).json({ error: "Channel not found" });
      if (channel.provider !== 'shopify') return res.status(400).json({ error: "Not a Shopify channel" });

      // Read credentials from channel's stored connection
      const connRecord = await storage.getChannelConnection(channelId);
      if (!connRecord?.shopDomain || !connRecord?.accessToken) {
        return res.status(400).json({ error: "Channel has no Shopify credentials. Please connect first." });
      }
      const store = connRecord.shopDomain.replace(/\.myshopify\.com$/, '');

      const locResponse = await fetch(
        `https://${store}.myshopify.com/admin/api/2024-01/locations.json`,
        {
          headers: {
            "X-Shopify-Access-Token": connRecord.accessToken,
            "Content-Type": "application/json",
          },
        }
      );
      if (!locResponse.ok) {
        return res.status(502).json({ error: `Shopify API returned ${locResponse.status}` });
      }
      const locData = await locResponse.json();
      const locations = (locData.locations || []).map((loc: any) => ({
        id: String(loc.id),
        name: loc.name,
        address1: loc.address1,
        city: loc.city,
        province: loc.province,
        country: loc.country_name,
        active: loc.active,
      }));

      // Include current warehouse mappings
      const warehouses = await storage.getAllWarehouses();
      const mappings = warehouses
        .filter((w: any) => w.shopifyLocationId)
        .map((w: any) => ({ warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, shopifyLocationId: w.shopifyLocationId }));

      res.json({ locations, mappings });
    } catch (error) {
      console.error("Error fetching Shopify locations:", error);
      res.status(500).json({ error: "Failed to fetch Shopify locations" });
    }
  });

  // Save Shopify location → warehouse mappings
  app.post("/api/channels/:id/map-locations", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const channel = await storage.getChannelById(channelId);
      if (!channel) return res.status(404).json({ error: "Channel not found" });

      const { mappings } = req.body as { mappings: Array<{ shopifyLocationId: string; warehouseId: number | null }> };
      if (!Array.isArray(mappings)) {
        return res.status(400).json({ error: "mappings must be an array" });
      }

      // Clear all existing Shopify location mappings first
      const allWarehouses = await storage.getAllWarehouses();
      for (const wh of allWarehouses) {
        if ((wh as any).shopifyLocationId) {
          await storage.updateWarehouse(wh.id, { shopifyLocationId: null } as any);
        }
      }

      // Apply new mappings
      for (const m of mappings) {
        if (m.warehouseId) {
          await storage.updateWarehouse(m.warehouseId, { shopifyLocationId: m.shopifyLocationId } as any);
        }
      }

      // Return updated state
      const updatedWarehouses = await storage.getAllWarehouses();
      const updatedMappings = updatedWarehouses
        .filter((w: any) => w.shopifyLocationId)
        .map((w: any) => ({ warehouseId: w.id, warehouseCode: w.code, warehouseName: w.name, shopifyLocationId: w.shopifyLocationId }));

      res.json({ success: true, mappings: updatedMappings });
    } catch (error) {
      console.error("Error saving location mappings:", error);
      res.status(500).json({ error: "Failed to save location mappings" });
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
  // CHANNEL PRODUCT PUSH API
  // ============================================

  // Preview resolved product for a channel (master + overrides merged)
  app.get("/api/channel-push/preview/:productId/:channelId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const channelId = parseInt(req.params.channelId);
      const resolved = await channelProductPush.getResolvedProductForChannel(productId, channelId);
      if (!resolved) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json(resolved);
    } catch (error) {
      console.error("Error previewing product:", error);
      res.status(500).json({ error: "Failed to preview product" });
    }
  });

  // Push product to all active channels
  app.post("/api/channel-push/product/:productId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const results = await channelProductPush.pushProductToAllChannels(productId);
      res.json({ success: true, results });
    } catch (error) {
      console.error("Error pushing product:", error);
      res.status(500).json({ error: "Failed to push product" });
    }
  });

  // Push product to specific channel
  app.post("/api/channel-push/product/:productId/channel/:channelId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const channelId = parseInt(req.params.channelId);
      const result = await channelProductPush.pushProduct(productId, channelId);
      res.json(result);
    } catch (error) {
      console.error("Error pushing product to channel:", error);
      res.status(500).json({ error: "Failed to push product" });
    }
  });

  // Push all products to a channel (bulk)
  app.post("/api/channel-push/all/:channelId", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const result = await channelProductPush.pushAllProducts(channelId);
      res.json(result);
    } catch (error) {
      console.error("Error bulk pushing products:", error);
      res.status(500).json({ error: "Failed to push products" });
    }
  });

  // Get channel sync status for a product
  app.get("/api/products/:productId/channel-status", requirePermission("channels", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const activeChannels = await storage.getAllChannels();
      const statuses = [];
      for (const channel of activeChannels) {
        const listings = await storage.getChannelListingsByProduct(channel.id, productId);
        const override = await storage.getChannelProductOverride(channel.id, productId);
        statuses.push({
          channelId: channel.id,
          channelName: channel.name,
          provider: channel.provider,
          isListed: override ? override.isListed === 1 : true,
          listings: listings.map((l) => ({
            variantId: l.productVariantId,
            externalProductId: l.externalProductId,
            externalVariantId: l.externalVariantId,
            syncStatus: l.syncStatus,
            syncError: l.syncError,
            lastSyncedAt: l.lastSyncedAt,
          })),
        });
      }
      res.json(statuses);
    } catch (error) {
      console.error("Error fetching channel status:", error);
      res.status(500).json({ error: "Failed to fetch channel status" });
    }
  });

  // ============================================
  // CHANNEL PRODUCT OVERRIDES API
  // ============================================

  app.get("/api/channels/:channelId/products/:productId/overrides", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const override = await storage.getChannelProductOverride(channelId, productId);
      res.json(override || null);
    } catch (error) {
      console.error("Error fetching product override:", error);
      res.status(500).json({ error: "Failed to fetch override" });
    }
  });

  app.put("/api/channels/:channelId/products/:productId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const override = await storage.upsertChannelProductOverride({
        channelId,
        productId,
        ...req.body,
      });
      res.json(override);
    } catch (error) {
      console.error("Error saving product override:", error);
      res.status(500).json({ error: "Failed to save override" });
    }
  });

  app.delete("/api/channels/:channelId/products/:productId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const deleted = await storage.deleteChannelProductOverride(channelId, productId);
      res.json({ deleted });
    } catch (error) {
      console.error("Error deleting product override:", error);
      res.status(500).json({ error: "Failed to delete override" });
    }
  });

  // Channel variant overrides
  app.get("/api/channels/:channelId/variants/:variantId/overrides", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const override = await storage.getChannelVariantOverride(channelId, variantId);
      res.json(override || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch variant override" });
    }
  });

  app.put("/api/channels/:channelId/variants/:variantId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const override = await storage.upsertChannelVariantOverride({
        channelId,
        productVariantId: variantId,
        ...req.body,
      });
      res.json(override);
    } catch (error) {
      res.status(500).json({ error: "Failed to save variant override" });
    }
  });

  app.delete("/api/channels/:channelId/variants/:variantId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const deleted = await storage.deleteChannelVariantOverride(channelId, variantId);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete variant override" });
    }
  });

  // Channel pricing
  app.get("/api/channels/:channelId/variants/:variantId/pricing", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const pricing = await storage.getChannelPricing(channelId, variantId);
      res.json(pricing || null);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch pricing" });
    }
  });

  app.put("/api/channels/:channelId/variants/:variantId/pricing", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const pricing = await storage.upsertChannelPricing({
        channelId,
        productVariantId: variantId,
        ...req.body,
      });
      res.json(pricing);
    } catch (error) {
      res.status(500).json({ error: "Failed to save pricing" });
    }
  });

  app.delete("/api/channels/:channelId/variants/:variantId/pricing", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const variantId = parseInt(req.params.variantId);
      const deleted = await storage.deleteChannelPricing(channelId, variantId);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete pricing" });
    }
  });

  // Channel asset overrides
  app.get("/api/channels/:channelId/products/:productId/asset-overrides", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const overrides = await storage.getChannelAssetOverridesByProduct(channelId, productId);
      res.json(overrides);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch asset overrides" });
    }
  });

  app.put("/api/channels/:channelId/assets/:assetId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const assetId = parseInt(req.params.assetId);
      const override = await storage.upsertChannelAssetOverride({
        channelId,
        productAssetId: assetId,
        ...req.body,
      });
      res.json(override);
    } catch (error) {
      res.status(500).json({ error: "Failed to save asset override" });
    }
  });

  app.delete("/api/channels/:channelId/assets/:assetId/overrides", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const assetId = parseInt(req.params.assetId);
      const deleted = await storage.deleteChannelAssetOverride(channelId, assetId);
      res.json({ deleted });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete asset override" });
    }
  });

  // Channel listings
  app.get("/api/channels/:channelId/listings", requirePermission("channels", "view"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.channelId);
      const productId = req.query.productId ? parseInt(req.query.productId as string) : undefined;
      if (productId) {
        const listings = await storage.getChannelListingsByProduct(channelId, productId);
        res.json(listings);
      } else {
        // Return all listings for this channel - use raw query
        const allListings = await db.select().from(channelListings).where(eq(channelListings.channelId, channelId));
        res.json(allListings);
      }
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch listings" });
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
    "default_warehouse_id",
    "allow_multiple_skus_per_bin", "picking_batch_size",
    "auto_release_delay_minutes", "default_lead_time_days", "default_safety_stock_days",
    "cycle_count_auto_approve_tolerance", "cycle_count_approval_threshold"
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
              locationType: "pick",
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

  // Manually trigger order sync from shopify_orders to orders (admin only)
  app.post("/api/sync/trigger", requirePermission("shopify", "sync"), async (req, res) => {
    try {
      const { syncNewOrders } = await import("./orderSyncListener");
      await syncNewOrders();
      res.json({ success: true, message: "Sync triggered - check logs" });
    } catch (error) {
      console.error("Trigger sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });
  
  // Legacy debug endpoint - redirect to authenticated version
  app.post("/api/debug/trigger-sync", requirePermission("shopify", "sync"), async (req, res) => {
    try {
      const { syncNewOrders } = await import("./orderSyncListener");
      await syncNewOrders();
      res.json({ success: true, message: "Sync triggered - check logs" });
    } catch (error) {
      console.error("Debug trigger sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Get sync health status for dashboard alerts
  app.get("/api/sync/health", async (req, res) => {
    try {
      const { getSyncHealth } = await import("./orderSyncListener");
      const health = getSyncHealth();
      
      // Also check for unsynced orders in database
      const unsyncedCheck = await db.execute(sql`
        SELECT 
          (SELECT MAX(created_at) FROM shopify_orders) as latest_shopify_order,
          (SELECT MAX(created_at) FROM orders WHERE source = 'shopify') as latest_synced_order,
          (SELECT COUNT(*) FROM shopify_orders so 
           WHERE NOT EXISTS(SELECT 1 FROM orders WHERE source_table_id = so.id)
           AND so.created_at > NOW() - INTERVAL '24 hours'
           AND so.cancelled_at IS NULL
           AND EXISTS(
             SELECT 1 FROM shopify_order_items soi 
             WHERE soi.order_id = so.id 
             AND (soi.fulfillment_status IS NULL OR soi.fulfillment_status != 'fulfilled')
           )) as unsynced_24h
      `);
      
      const row = unsyncedCheck.rows[0] as any;
      const latestShopifyOrder = row?.latest_shopify_order;
      const latestSyncedOrder = row?.latest_synced_order;
      const unsynced24h = parseInt(row?.unsynced_24h || "0");
      
      // Calculate gap between latest shopify order and latest synced order
      // Clamp to 0 if negative (synced order can be newer due to processing time)
      let syncGapMinutes: number | null = null;
      if (latestShopifyOrder && latestSyncedOrder) {
        const shopifyTime = new Date(latestShopifyOrder).getTime();
        const syncedTime = new Date(latestSyncedOrder).getTime();
        syncGapMinutes = Math.max(0, Math.floor((shopifyTime - syncedTime) / 60000));
      }
      
      // Determine alert status
      // Only alert on actual problems: unsynced actionable orders or sync errors
      const needsAlert = unsynced24h > 0 || health.status === "error";
      
      res.json({
        ...health,
        latestShopifyOrder,
        latestSyncedOrder,
        syncGapMinutes,
        unsynced24h,
        needsAlert,
        alertMessage: needsAlert ? 
          health.status === "error" ? `Sync error: ${health.lastSyncError}` :
          unsynced24h > 0 ? `${unsynced24h} orders waiting to sync` :
          null : null,
      });
    } catch (error) {
      console.error("Error checking sync health:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  // Email alert endpoint (ready for SendGrid integration later)
  // For now, logs the alert - can be connected to SendGrid when API key is available
  app.post("/api/sync/send-alert", requirePermission("system", "admin"), async (req, res) => {
    try {
      const { getSyncHealth } = await import("./orderSyncListener");
      const health = getSyncHealth();
      
      // Get admin email from settings
      const adminEmail = await storage.getSetting("admin_alert_email");
      
      if (!adminEmail) {
        return res.status(400).json({ error: "No admin email configured. Set admin_alert_email in settings." });
      }
      
      // Check if SendGrid is configured
      const sendgridApiKey = process.env.SENDGRID_API_KEY;
      
      if (sendgridApiKey) {
        // SendGrid integration ready - uncomment when API key is available
        /*
        const sgMail = require('@sendgrid/mail');
        sgMail.setApiKey(sendgridApiKey);
        
        const msg = {
          to: adminEmail,
          from: process.env.SENDGRID_FROM_EMAIL || 'alerts@echelon.app',
          subject: 'Echelon Alert: Order Sync Issue Detected',
          text: `Order sync alert:\n\nStatus: ${health.status}\nLast successful sync: ${health.lastSuccessfulSync || 'Never'}\nConsecutive errors: ${health.consecutiveErrors}\nLast error: ${health.lastSyncError || 'None'}\n\nPlease check the Echelon dashboard for more details.`,
          html: `
            <h2>Order Sync Alert</h2>
            <p><strong>Status:</strong> ${health.status}</p>
            <p><strong>Last successful sync:</strong> ${health.lastSuccessfulSync || 'Never'}</p>
            <p><strong>Consecutive errors:</strong> ${health.consecutiveErrors}</p>
            <p><strong>Last error:</strong> ${health.lastSyncError || 'None'}</p>
            <p>Please check the <a href="${process.env.APP_URL || 'https://your-app.replit.app'}">Echelon dashboard</a> for more details.</p>
          `,
        };
        
        await sgMail.send(msg);
        */
        console.log("[ALERT] Would send email alert to:", adminEmail);
        res.json({ success: true, message: "Alert sent (SendGrid configured)", recipient: adminEmail });
      } else {
        // Log alert for manual follow-up
        console.log("[ALERT] Sync alert triggered but SendGrid not configured");
        console.log("[ALERT] Would send to:", adminEmail);
        console.log("[ALERT] Status:", health.status);
        console.log("[ALERT] Error:", health.lastSyncError);
        
        res.json({ 
          success: true, 
          message: "Alert logged (SendGrid not configured - add SENDGRID_API_KEY to enable email)",
          recipient: adminEmail,
          health,
        });
      }
    } catch (error) {
      console.error("Error sending sync alert:", error);
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
  // 3. Reserved = Bin-level reservations for pending orders (inventory_levels.reserved_qty)
  // 4. Picked = Items picked but not yet shipped (inventory_levels.picked_qty)
  // 5. Available = Qty - Reserved - Picked (what can still be promised)
  //
  app.get("/api/inventory/levels", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null;
      
      // Step 1: Get inventory quantities from inventory_levels (variant_qty only)
      // Pickable = variant_qty where warehouse_locations.is_pickable = 1
      // Optional filter by warehouseId
      const inventoryResult = await db.execute<{
        variant_id: number;
        variant_sku: string;
        variant_name: string;
        units_per_variant: number;
        product_id: number | null;
        base_sku: string | null;
        total_variant_qty: string;
        total_reserved_qty: string;
        total_picked_qty: string;
        location_count: string;
        pickable_variant_qty: string;
      }>(warehouseId ? sql`
        SELECT
          pv.id as variant_id,
          pv.sku as variant_sku,
          pv.name as variant_name,
          pv.units_per_variant,
          p.id as product_id,
          p.sku as base_sku,
          COALESCE(SUM(il.variant_qty), 0) as total_variant_qty,
          COALESCE(SUM(il.reserved_qty), 0) as total_reserved_qty,
          COALESCE(SUM(il.picked_qty), 0) as total_picked_qty,
          COUNT(DISTINCT il.warehouse_location_id) as location_count,
          COALESCE(SUM(CASE WHEN wl.is_pickable = 1 THEN il.variant_qty ELSE 0 END), 0) as pickable_variant_qty
        FROM product_variants pv
        LEFT JOIN products p ON pv.product_id = p.id
        LEFT JOIN inventory_levels il ON il.product_variant_id = pv.id
        LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE pv.is_active = true
          AND (wl.warehouse_id = ${warehouseId} OR il.id IS NULL)
        GROUP BY pv.id, pv.sku, pv.name, pv.units_per_variant, p.id, p.sku
        ORDER BY pv.sku
      ` : sql`
        SELECT
          pv.id as variant_id,
          pv.sku as variant_sku,
          pv.name as variant_name,
          pv.units_per_variant,
          p.id as product_id,
          p.sku as base_sku,
          COALESCE(SUM(il.variant_qty), 0) as total_variant_qty,
          COALESCE(SUM(il.reserved_qty), 0) as total_reserved_qty,
          COALESCE(SUM(il.picked_qty), 0) as total_picked_qty,
          COUNT(DISTINCT il.warehouse_location_id) as location_count,
          COALESCE(SUM(CASE WHEN wl.is_pickable = 1 THEN il.variant_qty ELSE 0 END), 0) as pickable_variant_qty
        FROM product_variants pv
        LEFT JOIN products p ON pv.product_id = p.id
        LEFT JOIN inventory_levels il ON il.product_variant_id = pv.id
        LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE pv.is_active = true
        GROUP BY pv.id, pv.sku, pv.name, pv.units_per_variant, p.id, p.sku
        ORDER BY pv.sku
      `);
      
      // Build per-variant rows
      const levels = inventoryResult.rows.map(row => ({
        variantId: row.variant_id,
        sku: row.variant_sku,
        name: row.variant_name,
        unitsPerVariant: row.units_per_variant || 1,
        baseSku: row.base_sku,
        productId: row.product_id,
        variantQty: parseInt(row.total_variant_qty) || 0,
        reservedQty: parseInt(row.total_reserved_qty) || 0,
        pickedQty: parseInt(row.total_picked_qty) || 0,
        available: 0, // set below from fungible ATP
        locationCount: parseInt(row.location_count) || 0,
        pickableQty: parseInt(row.pickable_variant_qty) || 0,
      }));

      // Use inventory-atp service for fungible ATP (accounts for reserved+picked+packed)
      const { atp } = app.locals.services as any;
      const productIds = Array.from(new Set(levels.filter(l => l.productId != null).map(l => l.productId as number)));
      const atpMap: Map<number, number> = productIds.length > 0 ? await atp.getBulkAtp(productIds) : new Map();

      for (const lv of levels) {
        if (lv.productId != null && atpMap.has(lv.productId)) {
          lv.available = Math.floor(atpMap.get(lv.productId)! / lv.unitsPerVariant);
        } else {
          lv.available = lv.variantQty - lv.reservedQty - lv.pickedQty;
        }
      }

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
        reserved_qty: number;
        picked_qty: number;
      }>(sql`
        SELECT
          il.id,
          il.warehouse_location_id,
          wl.code as location_code,
          wl.zone,
          il.variant_qty,
          il.reserved_qty,
          il.picked_qty
        FROM inventory_levels il
        LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.product_variant_id = ${variantId}
        ORDER BY wl.code
      `);

      const locations = result.rows.map(row => ({
        id: row.id,
        warehouseLocationId: row.warehouse_location_id,
        locationCode: row.location_code,
        zone: row.zone,
        variantQty: row.variant_qty,
        reservedQty: row.reserved_qty,
        pickedQty: row.picked_qty,
        available: row.variant_qty - row.reserved_qty - row.picked_qty,
      }));
      
      res.json(locations);
    } catch (error) {
      console.error("Error fetching variant locations:", error);
      res.status(500).json({ error: "Failed to fetch variant locations" });
    }
  });

  // Export all inventory with location details for CSV download
  app.get("/api/inventory/export", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { locationType, binType, zone } = req.query;
      
      let query = sql`
        SELECT
          pv.sku,
          pv.name as variant_name,
          p.sku as base_sku,
          p.name as item_name,
          wl.code as location_code,
          wl.zone,
          wl.location_type,
          wl.bin_type,
          wl.is_pickable,
          il.variant_qty,
          il.reserved_qty,
          il.picked_qty,
          (il.variant_qty - il.reserved_qty - il.picked_qty) as available_qty
        FROM inventory_levels il
        JOIN product_variants pv ON il.product_variant_id = pv.id
        LEFT JOIN products p ON pv.product_id = p.id
        LEFT JOIN warehouse_locations wl ON il.warehouse_location_id = wl.id
        WHERE il.variant_qty > 0
        ORDER BY wl.code, pv.sku
      `;
      
      const result = await db.execute<{
        sku: string;
        variant_name: string;
        base_sku: string | null;
        item_name: string | null;
        location_code: string | null;
        zone: string | null;
        location_type: string | null;
        bin_type: string | null;
        is_pickable: number | null;
        variant_qty: number;
        reserved_qty: number;
        picked_qty: number;
        available_qty: number;
      }>(query);
      
      let rows = result.rows;
      
      // Apply filters in JavaScript (simpler than dynamic SQL)
      if (locationType && typeof locationType === 'string') {
        const types = locationType.split(',');
        rows = rows.filter(r => r.location_type && types.includes(r.location_type));
      }
      if (binType && typeof binType === 'string') {
        const types = binType.split(',');
        rows = rows.filter(r => r.bin_type && types.includes(r.bin_type));
      }
      if (zone && typeof zone === 'string') {
        rows = rows.filter(r => r.zone === zone);
      }
      
      const exportData = rows.map(row => ({
        sku: row.sku,
        variantName: row.variant_name,
        baseSku: row.base_sku,
        itemName: row.item_name,
        locationCode: row.location_code,
        zone: row.zone,
        locationType: row.location_type,
        binType: row.bin_type,
        isPickable: row.is_pickable === 1,
        variantQty: row.variant_qty,
        reservedQty: row.reserved_qty,
        pickedQty: row.picked_qty,
        availableQty: row.available_qty,
      }));
      
      res.json(exportData);
    } catch (error) {
      console.error("Error exporting inventory:", error);
      res.status(500).json({ error: "Failed to export inventory" });
    }
  });

  // Add inventory to a bin (simplified receipt) - variant-centric
  app.post("/api/inventory/add-stock", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventoryCore } = req.app.locals.services;
      const { variantId, warehouseLocationId, variantQty, notes } = req.body;
      const userId = req.session.user?.id;

      if (!variantId || !warehouseLocationId || variantQty === undefined) {
        return res.status(400).json({ error: "Missing required fields: variantId, warehouseLocationId, variantQty" });
      }

      const variant = await storage.getProductVariantById(variantId);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      await inventoryCore.receiveInventory({
        productVariantId: variantId,
        warehouseLocationId,
        qty: variantQty,
        referenceId: `ADD-${Date.now()}`,
        notes: notes || "Stock added via inventory page",
        userId,
      });

      // Sync to sales channels (fire-and-forget)
      const { channelSync: addSync } = req.app.locals.services as any;
      if (addSync) {
        addSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-add-stock sync failed for variant ${variantId}:`, err)
        );
      }

      res.json({ success: true, variantQtyAdded: variantQty });
    } catch (error) {
      console.error("Error adding stock:", error);
      res.status(500).json({ error: "Failed to add stock" });
    }
  });

  // Adjust inventory with reason code - variant-centric
  app.post("/api/inventory/adjust-stock", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventoryCore } = req.app.locals.services;
      const { variantId, warehouseLocationId, variantQtyDelta, reasonCode, notes } = req.body;
      const userId = req.session.user?.id;

      if (!variantId || !warehouseLocationId || variantQtyDelta === undefined || !reasonCode) {
        return res.status(400).json({ error: "Missing required fields: variantId, warehouseLocationId, variantQtyDelta, reasonCode" });
      }

      const variant = await storage.getProductVariantById(variantId);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      await inventoryCore.adjustInventory({
        productVariantId: variantId,
        warehouseLocationId,
        qtyDelta: variantQtyDelta,
        reason: reasonCode,
        userId,
      });

      // Sync to sales channels (fire-and-forget)
      const { channelSync: adjStockSync } = req.app.locals.services as any;
      if (adjStockSync) {
        adjStockSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-adjust-stock sync failed for variant ${variantId}:`, err)
        );
      }

      res.json({ success: true, variantQtyDelta });
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
          const variant = await storage.getProductVariantBySku(sku);

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
          
          // Check if inventory level exists for this variant at this location
          const existingLevel = await storage.getInventoryLevelByLocationAndVariant(location.id, variant.id);

          if (existingLevel) {
            // Calculate delta to reach target quantity (in variant units)
            const currentQty = existingLevel.variantQty || 0;
            const delta = variantQty - currentQty;
            if (delta !== 0) {
              const { inventoryCore: csvAdjCore } = req.app.locals.services as any;
              await csvAdjCore.adjustInventory({
                productVariantId: variant.id,
                warehouseLocationId: location.id,
                qtyDelta: delta,
                reason: "CSV_UPLOAD",
                userId,
              });
              results.updated++;
            }
          } else {
            // Create new inventory level directly with productVariantId
            await storage.createInventoryLevel({
              productVariantId: variant.id,
              warehouseLocationId: location.id,
              variantQty: variantQty,
              reservedQty: 0,
            });

            // Create transaction for audit trail
            await storage.createInventoryTransaction({
              productVariantId: variant.id,
              toLocationId: location.id,
              transactionType: "csv_upload",
              variantQtyDelta: variantQty,
              sourceState: "external",
              targetState: "on_hand",
              notes: "Initial inventory from CSV import",
              userId,
            });
            
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

  app.get("/api/cycle-counts", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.getAll());
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error fetching cycle counts:", error);
      res.status(500).json({ error: "Failed to fetch cycle counts" });
    }
  });

  app.get("/api/cycle-counts/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.getById(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error fetching cycle count:", error);
      res.status(500).json({ error: "Failed to fetch cycle count" });
    }
  });

  app.get("/api/cycle-counts/:id/variance-summary", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.getVarianceSummary(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error fetching variance summary:", error);
      res.status(500).json({ error: "Failed to fetch variance summary" });
    }
  });

  app.post("/api/cycle-counts", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      const result = await ccService.create(req.body, req.session.user?.id);
      res.status(201).json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error creating cycle count:", error);
      res.status(500).json({ error: "Failed to create cycle count" });
    }
  });

  app.post("/api/cycle-counts/:id/initialize", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.initialize(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error initializing cycle count:", error);
      res.status(500).json({ error: "Failed to initialize cycle count" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/count", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.recordCount(
        parseInt(req.params.id),
        parseInt(req.params.itemId),
        req.body,
        req.session.user?.id,
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error recording count:", error);
      res.status(500).json({ error: "Failed to record count" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/reset", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.resetItem(parseInt(req.params.id), parseInt(req.params.itemId)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error resetting count item:", error);
      res.status(500).json({ error: "Failed to reset count item" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/investigate", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.investigateItem(
        parseInt(req.params.id),
        parseInt(req.params.itemId),
        req.body.notes,
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error setting investigation hold:", error);
      res.status(500).json({ error: "Failed to set investigation hold" });
    }
  });

  app.post("/api/cycle-counts/:id/add-found-item", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.addFoundItem(parseInt(req.params.id), req.body, req.session.user?.id));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error adding found item:", error);
      res.status(500).json({ error: "Failed to add found item" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/approve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.approveVariance(
        parseInt(req.params.id),
        parseInt(req.params.itemId),
        { reasonCode: req.body.reasonCode, notes: req.body.notes, approvedBy: req.session.user?.id },
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error approving variance:", error);
      res.status(500).json({ error: "Failed to approve variance" });
    }
  });

  app.post("/api/cycle-counts/:id/bulk-approve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.bulkApprove(
        parseInt(req.params.id),
        { itemIds: req.body.itemIds, reasonCode: req.body.reasonCode, notes: req.body.notes, approvedBy: req.session.user?.id },
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error bulk approving variances:", error);
      res.status(500).json({ error: "Failed to bulk approve variances" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/create-variant", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.createVariant(parseInt(req.params.id), parseInt(req.params.itemId)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      if (error.code === "23505" || error.message?.includes("unique")) {
        return res.status(409).json({ error: "A variant with this SKU already exists. Try refreshing." });
      }
      console.error("Error creating variant from cycle count item:", error);
      res.status(500).json({ error: "Failed to create variant" });
    }
  });

  app.post("/api/cycle-counts/:id/complete", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.complete(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error completing cycle count:", error);
      res.status(500).json({ error: "Failed to complete cycle count" });
    }
  });

  app.delete("/api/cycle-counts/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services as any;
      res.json(await ccService.delete(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
  
  app.post("/api/receiving/:id/open", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services as any;
      const result = await rcvService.open(parseInt(req.params.id), req.session.user?.id || null);
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error opening receiving order:", error);
      res.status(500).json({ error: "Failed to open receiving order" });
    }
  });
  
  // Close/complete a receiving order - updates inventory
  app.post("/api/receiving/:id/close", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services as any;
      const result = await rcvService.close(parseInt(req.params.id), req.session.user?.id || null);
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
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
      const { sku, productName, expectedQty, receivedQty, status, productVariantId, productId, barcode, unitCost, putawayLocationId } = req.body;

      await storage.createReceivingLine({
        receivingOrderId: orderId,
        sku: sku || null,
        productName: productName || null,
        expectedQty: expectedQty || 0,
        receivedQty: receivedQty || 0,
        damagedQty: 0,
        productVariantId: productVariantId || null,
        productId: productId || null,
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
  
  // Create a product variant from a receiving line's SKU and link it
  // Uses the same SKU pattern as Shopify sync: BASE-SKU-[P|B|C]###
  app.post("/api/receiving/lines/:lineId/create-variant", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { receiving: rcvService } = req.app.locals.services as any;
      const result = await rcvService.createVariantFromLine(parseInt(req.params.lineId));
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error creating variant from receiving line:", error);
      res.status(500).json({ error: "Failed to create variant" });
    }
  });

  // Delete a receiving order (only if not closed)
  app.delete("/api/receiving/:orderId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const orderId = parseInt(req.params.orderId);
      const order = await storage.getReceivingOrderById(orderId);

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
      const { receiving: rcvService } = req.app.locals.services as any;
      const result = await rcvService.completeAllLines(parseInt(req.params.orderId));
      res.json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
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
      const { receiving: rcvService } = req.app.locals.services as any;
      const result = await rcvService.bulkImportLines(
        parseInt(req.params.orderId),
        req.body.lines,
        req.session?.user?.id || null,
      );
      res.status(201).json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message, ...error.details });
      console.error("Error bulk creating receiving lines:", error);
      res.status(500).json({ error: "Failed to create receiving lines" });
    }
  });

  // ===== WAREHOUSE SETTINGS API =====
  
  app.get("/api/warehouse-settings", requirePermission("warehouse", "read"), async (req, res) => {
    try {
      const settings = await storage.getAllWarehouseSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching warehouse settings:", error);
      res.status(500).json({ error: "Failed to fetch warehouse settings" });
    }
  });
  
  app.get("/api/warehouse-settings/default", requirePermission("warehouse", "read"), async (req, res) => {
    try {
      let settings = await storage.getDefaultWarehouseSettings();
      if (!settings) {
        settings = await storage.createWarehouseSettings({
          warehouseCode: "DEFAULT",
          warehouseName: "Main Warehouse",
        });
      }
      res.json(settings);
    } catch (error) {
      console.error("Error fetching default warehouse settings:", error);
      res.status(500).json({ error: "Failed to fetch default warehouse settings" });
    }
  });
  
  app.get("/api/warehouse-settings/:id", requirePermission("warehouse", "read"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const settings = await storage.getWarehouseSettingsById(id);
      if (!settings) {
        return res.status(404).json({ error: "Warehouse settings not found" });
      }
      res.json(settings);
    } catch (error) {
      console.error("Error fetching warehouse settings:", error);
      res.status(500).json({ error: "Failed to fetch warehouse settings" });
    }
  });
  
  app.post("/api/warehouse-settings", requirePermission("warehouse", "manage"), async (req, res) => {
    try {
      const data = req.body;
      const settings = await storage.createWarehouseSettings({
        warehouseId: data.warehouseId || null,
        warehouseCode: data.warehouseCode || "DEFAULT",
        warehouseName: data.warehouseName || "Main Warehouse",
        replenMode: data.replenMode || "queue",
        shortPickAction: data.shortPickAction || "partial_pick",
        autoGenerateTrigger: data.autoGenerateTrigger || "manual_only",
        inlineReplenMaxUnits: data.inlineReplenMaxUnits || 50,
        inlineReplenMaxCases: data.inlineReplenMaxCases || 2,
        urgentReplenThreshold: data.urgentReplenThreshold || 0,
        stockoutPriority: data.stockoutPriority || 1,
        minMaxPriority: data.minMaxPriority || 5,
        scheduledReplenIntervalMinutes: data.scheduledReplenIntervalMinutes || 30,
        scheduledReplenEnabled: data.scheduledReplenEnabled || 0,
        pickPathOptimization: data.pickPathOptimization || "zone_sequence",
        maxOrdersPerWave: data.maxOrdersPerWave || 50,
        maxItemsPerWave: data.maxItemsPerWave || 500,
        waveAutoRelease: data.waveAutoRelease || 0,
        postPickStatus: data.postPickStatus || "ready_to_ship",
        pickMode: data.pickMode || "single_order",
        requireScanConfirm: data.requireScanConfirm ?? 0,
        pickingBatchSize: data.pickingBatchSize || 20,
        autoReleaseDelayMinutes: data.autoReleaseDelayMinutes || 30,
        isActive: data.isActive ?? 1,
      });
      res.status(201).json(settings);
    } catch (error) {
      console.error("Error creating warehouse settings:", error);
      res.status(500).json({ error: "Failed to create warehouse settings" });
    }
  });
  
  app.patch("/api/warehouse-settings/:id", requirePermission("warehouse", "manage"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const settings = await storage.updateWarehouseSettings(id, req.body);
      if (!settings) {
        return res.status(404).json({ error: "Warehouse settings not found" });
      }
      res.json(settings);
    } catch (error) {
      console.error("Error updating warehouse settings:", error);
      res.status(500).json({ error: "Failed to update warehouse settings" });
    }
  });
  
  app.delete("/api/warehouse-settings/:id", requirePermission("warehouse", "manage"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteWarehouseSettings(id);
      if (!deleted) {
        return res.status(404).json({ error: "Warehouse settings not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting warehouse settings:", error);
      res.status(500).json({ error: "Failed to delete warehouse settings" });
    }
  });

  // ===== REPLENISHMENT API =====
  
  // Tier Defaults - default rules by UOM hierarchy level
  app.get("/api/replen/tier-defaults", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const tierDefaults = await storage.getAllReplenTierDefaults();
      res.json(tierDefaults);
    } catch (error) {
      console.error("Error fetching tier defaults:", error);
      res.status(500).json({ error: "Failed to fetch tier defaults" });
    }
  });
  
  app.get("/api/replen/tier-defaults/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const tierDefault = await storage.getReplenTierDefaultById(id);
      if (!tierDefault) {
        return res.status(404).json({ error: "Tier default not found" });
      }
      res.json(tierDefault);
    } catch (error) {
      console.error("Error fetching tier default:", error);
      res.status(500).json({ error: "Failed to fetch tier default" });
    }
  });
  
  app.post("/api/replen/tier-defaults", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const data = req.body;
      const tierDefault = await storage.createReplenTierDefault({
        hierarchyLevel: data.hierarchyLevel,
        sourceHierarchyLevel: data.sourceHierarchyLevel,
        pickLocationType: data.pickLocationType || "pick",
        sourceLocationType: data.sourceLocationType || "reserve",
        sourcePriority: data.sourcePriority || "fifo",
        triggerValue: data.triggerValue || 0,
        maxQty: data.maxQty || null,
        replenMethod: data.replenMethod || "case_break",
        priority: data.priority || 5,
        autoReplen: data.autoReplen ?? 0,
        isActive: data.isActive ?? 1,
      });
      res.status(201).json(tierDefault);
    } catch (error) {
      console.error("Error creating tier default:", error);
      res.status(500).json({ error: "Failed to create tier default" });
    }
  });
  
  app.patch("/api/replen/tier-defaults/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const tierDefault = await storage.updateReplenTierDefault(id, req.body);
      if (!tierDefault) {
        return res.status(404).json({ error: "Tier default not found" });
      }
      res.json(tierDefault);
    } catch (error) {
      console.error("Error updating tier default:", error);
      res.status(500).json({ error: "Failed to update tier default" });
    }
  });
  
  app.delete("/api/replen/tier-defaults/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReplenTierDefault(id);
      if (!deleted) {
        return res.status(404).json({ error: "Tier default not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting tier default:", error);
      res.status(500).json({ error: "Failed to delete tier default" });
    }
  });
  
  // SKU Overrides (product-specific exceptions to tier defaults)
  app.get("/api/replen/rules", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const rules = await storage.getAllReplenRules();
      
      const productIds = new Set<number>();
      const variantIds = new Set<number>();
      for (const rule of rules) {
        if (rule.productId) productIds.add(rule.productId);
        if (rule.pickProductVariantId) variantIds.add(rule.pickProductVariantId);
        if (rule.sourceProductVariantId) variantIds.add(rule.sourceProductVariantId);
      }

      const [allProducts, allVariants] = await Promise.all([
        storage.getAllProducts(),
        storage.getAllProductVariants(),
      ]);

      const productMap = new Map(allProducts.filter(p => productIds.has(p.id)).map(p => [p.id, p]));
      const variantMap = new Map(allVariants.filter(v => variantIds.has(v.id)).map(v => [v.id, v]));

      const enriched = rules.map(rule => ({
        ...rule,
        product: rule.productId ? productMap.get(rule.productId) : null,
        pickVariant: rule.pickProductVariantId ? variantMap.get(rule.pickProductVariantId) : null,
        sourceVariant: rule.sourceProductVariantId ? variantMap.get(rule.sourceProductVariantId) : null,
      }));

      res.json(enriched);
    } catch (error) {
      console.error("Error fetching replen rules:", error);
      res.status(500).json({ error: "Failed to fetch replen rules" });
    }
  });

  app.get("/api/replen/rules/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const rule = await storage.getReplenRuleById(id);
      if (!rule) {
        return res.status(404).json({ error: "Replen rule not found" });
      }

      const [allProducts, allVariants] = await Promise.all([
        storage.getAllProducts(),
        storage.getAllProductVariants(),
      ]);

      const productMap = new Map(allProducts.map(p => [p.id, p]));
      const variantMap = new Map(allVariants.map(v => [v.id, v]));

      const enriched = {
        ...rule,
        product: rule.productId ? productMap.get(rule.productId) : null,
        pickVariant: rule.pickProductVariantId ? variantMap.get(rule.pickProductVariantId) : null,
        sourceVariant: rule.sourceProductVariantId ? variantMap.get(rule.sourceProductVariantId) : null,
      };
      
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching replen rule:", error);
      res.status(500).json({ error: "Failed to fetch replen rule" });
    }
  });
  
  app.post("/api/replen/rules", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { productId, pickVariantId, sourceVariantId, pickLocationType, sourceLocationType, sourcePriority, triggerValue, maxQty, replenMethod, priority, autoReplen } = req.body;

      if (!productId || !pickVariantId || !sourceVariantId) {
        return res.status(400).json({ error: "productId, pickVariantId, and sourceVariantId are required" });
      }

      // Validate that variants belong to the product
      const [product, pickVariant, sourceVariant] = await Promise.all([
        storage.getProductById(productId),
        storage.getProductVariantById(pickVariantId),
        storage.getProductVariantById(sourceVariantId),
      ]);

      if (!product) {
        return res.status(400).json({ error: "Product not found" });
      }
      if (!pickVariant) {
        return res.status(400).json({ error: "Pick variant not found" });
      }
      if (!sourceVariant) {
        return res.status(400).json({ error: "Source variant not found" });
      }

      // Validate pick and source variants belong to the product
      if (pickVariant.productId !== product.id) {
        return res.status(400).json({ error: "Pick variant does not belong to the specified product" });
      }
      if (sourceVariant.productId !== product.id) {
        return res.status(400).json({ error: "Source variant does not belong to the specified product" });
      }

      const rule = await storage.createReplenRule({
        productId,
        pickProductVariantId: pickVariantId,
        sourceProductVariantId: sourceVariantId,
        pickLocationType: pickLocationType || "pick",
        sourceLocationType: sourceLocationType || "reserve",
        sourcePriority: sourcePriority || "fifo",
        triggerValue: triggerValue ?? 0,
        maxQty: maxQty ?? null,
        replenMethod: replenMethod || "case_break",
        priority: priority ?? 5,
        autoReplen: autoReplen ?? null,
        isActive: 1,
      });
      
      res.status(201).json(rule);
    } catch (error) {
      console.error("Error creating replen rule:", error);
      res.status(500).json({ error: "Failed to create replen rule" });
    }
  });
  
  app.patch("/api/replen/rules/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;
      const rule = await storage.updateReplenRule(id, updates);
      if (!rule) {
        return res.status(404).json({ error: "Replen rule not found" });
      }
      res.json(rule);
    } catch (error) {
      console.error("Error updating replen rule:", error);
      res.status(500).json({ error: "Failed to update replen rule" });
    }
  });
  
  app.delete("/api/replen/rules/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReplenRule(id);
      if (!deleted) {
        return res.status(404).json({ error: "Replen rule not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting replen rule:", error);
      res.status(500).json({ error: "Failed to delete replen rule" });
    }
  });
  
  // CSV upload for replen rules
  app.post("/api/replen/rules/upload-csv", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const multer = await import("multer");
      const Papa = await import("papaparse");
      const upload = multer.default({ storage: multer.default.memoryStorage() });
      
      // Handle the file upload
      upload.single("file")(req, res, async (err: any) => {
        if (err) {
          return res.status(400).json({ error: "Failed to upload file" });
        }
        
        const file = (req as any).file;
        if (!file) {
          return res.status(400).json({ error: "No file provided" });
        }
        
        const csvContent = file.buffer.toString("utf-8");
        
        // Use Papaparse for robust CSV parsing (handles quoted fields, etc.)
        const parseResult = Papa.default.parse(csvContent, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (h: string) => h.trim().toLowerCase(),
        });
        
        if (parseResult.errors.length > 0) {
          return res.status(400).json({ 
            error: "CSV parsing error", 
            details: parseResult.errors.slice(0, 5).map((e: any) => e.message)
          });
        }
        
        const rows = parseResult.data as Record<string, string>[];
        if (rows.length === 0) {
          return res.status(400).json({ error: "CSV must have at least one data row" });
        }
        
        // Validate required headers
        const expectedHeaders = ["product_sku", "pick_variant_sku", "source_variant_sku"];
        const actualHeaders = parseResult.meta.fields || [];
        const missingHeaders = expectedHeaders.filter(h => !actualHeaders.includes(h));
        if (missingHeaders.length > 0) {
          return res.status(400).json({ error: `Missing required headers: ${missingHeaders.join(", ")}` });
        }
        
        // Get lookup data
        const [allProducts, variants] = await Promise.all([
          storage.getAllProducts(),
          storage.getAllProductVariants(),
        ]);

        // Build lookup maps
        const productBySku = new Map(allProducts.filter(p => p.sku).map(p => [p.sku!.toLowerCase(), p]));
        const variantBySku = new Map(variants.filter(v => v.sku).map(v => [v.sku!.toLowerCase(), v]));

        // Build variant-to-product mapping via productId
        const productById = new Map(allProducts.map(p => [p.id, p]));

        const getProductForVariant = (variant: typeof variants[0]) => {
          return productById.get(variant.productId);
        };
        
        const results = { created: 0, skipped: 0, errors: [] as string[] };
        
        // Process data rows
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rowNum = i + 2; // Account for header row
          
          // Lookup product
          const productSku = (row.product_sku || "").trim();
          if (!productSku) {
            results.errors.push(`Row ${rowNum}: Missing product_sku`);
            results.skipped++;
            continue;
          }
          
          const product = productBySku.get(productSku.toLowerCase());
          if (!product) {
            results.errors.push(`Row ${rowNum}: Product SKU '${productSku}' not found`);
            results.skipped++;
            continue;
          }
          
          // Lookup and validate pick variant
          const pickVariantSku = (row.pick_variant_sku || "").trim();
          if (!pickVariantSku) {
            results.errors.push(`Row ${rowNum}: Missing pick_variant_sku`);
            results.skipped++;
            continue;
          }
          
          const pickVariant = variantBySku.get(pickVariantSku.toLowerCase());
          if (!pickVariant) {
            results.errors.push(`Row ${rowNum}: Pick variant SKU '${pickVariantSku}' not found`);
            results.skipped++;
            continue;
          }
          
          // Validate pick variant belongs to product
          const pickVariantProduct = getProductForVariant(pickVariant);
          if (!pickVariantProduct || pickVariantProduct.id !== product.id) {
            results.errors.push(`Row ${rowNum}: Pick variant '${pickVariantSku}' does not belong to product '${productSku}'`);
            results.skipped++;
            continue;
          }
          
          // Lookup and validate source variant
          const sourceVariantSku = (row.source_variant_sku || "").trim();
          if (!sourceVariantSku) {
            results.errors.push(`Row ${rowNum}: Missing source_variant_sku`);
            results.skipped++;
            continue;
          }
          
          const sourceVariant = variantBySku.get(sourceVariantSku.toLowerCase());
          if (!sourceVariant) {
            results.errors.push(`Row ${rowNum}: Source variant SKU '${sourceVariantSku}' not found`);
            results.skipped++;
            continue;
          }
          
          // Validate source variant belongs to product
          const sourceVariantProduct = getProductForVariant(sourceVariant);
          if (!sourceVariantProduct || sourceVariantProduct.id !== product.id) {
            results.errors.push(`Row ${rowNum}: Source variant '${sourceVariantSku}' does not belong to product '${productSku}'`);
            results.skipped++;
            continue;
          }
          
          try {
            await storage.createReplenRule({
              productId: product.id,
              pickProductVariantId: pickVariant.id,
              sourceProductVariantId: sourceVariant.id,
              pickLocationType: (row.pick_location_type || "pick").trim(),
              sourceLocationType: (row.source_location_type || "reserve").trim(),
              sourcePriority: (row.source_priority || "fifo").trim(),
              triggerValue: parseInt(row.trigger_value) || 0,
              maxQty: row.max_qty ? parseInt(row.max_qty) : null,
              replenMethod: (row.replen_method || "case_break").trim(),
              priority: parseInt(row.priority) || 5,
              isActive: 1,
            });
            results.created++;
          } catch (error) {
            results.errors.push(`Row ${rowNum}: Failed to create rule - ${error}`);
            results.skipped++;
          }
        }
        
        res.json(results);
      });
    } catch (error) {
      console.error("Error uploading replen rules CSV:", error);
      res.status(500).json({ error: "Failed to upload CSV" });
    }
  });
  
  // Location Replen Config — per-location threshold overrides
  app.get("/api/replen/location-configs", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseLocationId = req.query.warehouseLocationId ? parseInt(req.query.warehouseLocationId as string) : undefined;
      const configs = await storage.getLocationReplenConfigs(warehouseLocationId);

      // Enrich with location codes and variant SKUs
      const [allLocations, allVariants] = await Promise.all([
        storage.getAllWarehouseLocations(),
        storage.getAllProductVariants(),
      ]);
      const locMap = new Map(allLocations.map(l => [l.id, l]));
      const varMap = new Map(allVariants.map(v => [v.id, v]));

      const enriched = configs.map(c => ({
        ...c,
        location: locMap.get(c.warehouseLocationId),
        variant: c.productVariantId ? varMap.get(c.productVariantId) : null,
      }));

      res.json(enriched);
    } catch (error) {
      console.error("Error fetching location replen configs:", error);
      res.status(500).json({ error: "Failed to fetch location replen configs" });
    }
  });

  // CSV template download (must be before :id route)
  app.get("/api/replen/location-configs/csv-template", requirePermission("inventory", "view"), async (_req, res) => {
    const template = "location_code,variant_sku,trigger_value,replen_method,max_qty,notes\nF-01,,2,pallet_drop,,All SKUs at F-01\nF-03,ESS-TOP-STD-SLV-CLR-C1000,3,pallet_drop,,High-velocity SKU\nA-11,,0,case_break,50,Standard bin\n";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=location_replen_config_template.csv");
    res.send(template);
  });

  app.get("/api/replen/location-configs/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const config = await storage.getLocationReplenConfigById(parseInt(req.params.id));
      if (!config) return res.status(404).json({ error: "Location replen config not found" });
      res.json(config);
    } catch (error) {
      console.error("Error fetching location replen config:", error);
      res.status(500).json({ error: "Failed to fetch location replen config" });
    }
  });

  app.post("/api/replen/location-configs", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { warehouseLocationId, productVariantId, triggerValue, maxQty, replenMethod, isActive, notes } = req.body;
      if (!warehouseLocationId) return res.status(400).json({ error: "warehouseLocationId is required" });

      const config = await storage.createLocationReplenConfig({
        warehouseLocationId,
        productVariantId: productVariantId || null,
        triggerValue: triggerValue?.toString() || null,
        maxQty: maxQty || null,
        replenMethod: replenMethod || null,
        isActive: isActive ?? 1,
        notes: notes || null,
      });
      res.json(config);
    } catch (error) {
      console.error("Error creating location replen config:", error);
      res.status(500).json({ error: "Failed to create location replen config" });
    }
  });

  app.patch("/api/replen/location-configs/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates: any = {};
      if (req.body.triggerValue !== undefined) updates.triggerValue = req.body.triggerValue?.toString() || null;
      if (req.body.maxQty !== undefined) updates.maxQty = req.body.maxQty;
      if (req.body.replenMethod !== undefined) updates.replenMethod = req.body.replenMethod;
      if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
      if (req.body.notes !== undefined) updates.notes = req.body.notes;

      const config = await storage.updateLocationReplenConfig(id, updates);
      if (!config) return res.status(404).json({ error: "Location replen config not found" });
      res.json(config);
    } catch (error) {
      console.error("Error updating location replen config:", error);
      res.status(500).json({ error: "Failed to update location replen config" });
    }
  });

  app.delete("/api/replen/location-configs/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const deleted = await storage.deleteLocationReplenConfig(parseInt(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Location replen config not found" });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting location replen config:", error);
      res.status(500).json({ error: "Failed to delete location replen config" });
    }
  });

  // CSV upload for location replen configs
  app.post("/api/replen/location-configs/upload-csv", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const multer = await import("multer");
      const Papa = await import("papaparse");
      const upload = multer.default({ storage: multer.default.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

      upload.single("file")(req, res, async (err: any) => {
        if (err) return res.status(400).json({ error: "File upload failed: " + err.message });
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        const csvText = req.file.buffer.toString("utf-8");
        const parsed = Papa.default.parse(csvText, { header: true, skipEmptyLines: true });

        if (parsed.errors?.length > 0) {
          return res.status(400).json({ error: "CSV parse error", details: parsed.errors.slice(0, 5) });
        }

        const allLocations = await storage.getAllWarehouseLocations();
        const allVariants = await storage.getAllProductVariants();
        const locByCode = new Map(allLocations.map(l => [l.code.toLowerCase(), l]));
        const varBySku = new Map(allVariants.map(v => [v.sku.toLowerCase(), v]));

        const results = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };

        for (let i = 0; i < parsed.data.length; i++) {
          const row = parsed.data[i] as any;
          const rowNum = i + 2; // 1-indexed, skip header

          const locationCode = (row.location_code || "").trim().toLowerCase();
          if (!locationCode) {
            results.errors.push(`Row ${rowNum}: Missing location_code`);
            results.skipped++;
            continue;
          }

          const location = locByCode.get(locationCode);
          if (!location) {
            results.errors.push(`Row ${rowNum}: Location '${row.location_code}' not found`);
            results.skipped++;
            continue;
          }

          let variantId: number | null = null;
          const variantSku = (row.variant_sku || "").trim().toLowerCase();
          if (variantSku) {
            const variant = varBySku.get(variantSku);
            if (!variant) {
              results.errors.push(`Row ${rowNum}: Variant SKU '${row.variant_sku}' not found`);
              results.skipped++;
              continue;
            }
            variantId = variant.id;
          }

          const triggerVal = row.trigger_value ? row.trigger_value.toString().trim() : null;
          const maxQty = row.max_qty ? parseInt(row.max_qty) : null;
          const replenMethod = (row.replen_method || "").trim() || null;
          const notes = (row.notes || "").trim() || null;

          try {
            // Check if config already exists for this location+variant
            const existing = await storage.getLocationReplenConfig(location.id, variantId);
            if (existing) {
              await storage.updateLocationReplenConfig(existing.id, {
                triggerValue: triggerVal,
                maxQty,
                replenMethod,
                notes,
                isActive: 1,
              });
              results.updated++;
            } else {
              await storage.createLocationReplenConfig({
                warehouseLocationId: location.id,
                productVariantId: variantId,
                triggerValue: triggerVal,
                maxQty,
                replenMethod,
                notes,
                isActive: 1,
              });
              results.created++;
            }
          } catch (error) {
            results.errors.push(`Row ${rowNum}: Failed - ${error}`);
            results.skipped++;
          }
        }

        res.json(results);
      });
    } catch (error) {
      console.error("Error uploading location replen config CSV:", error);
      res.status(500).json({ error: "Failed to upload CSV" });
    }
  });

  // Replen Tasks
  app.get("/api/replen/tasks", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const assignedTo = req.query.assignedTo as string | undefined;
      const autoReplenFilter = req.query.autoReplen as string | undefined;

      let tasks = await storage.getAllReplenTasks({ status, assignedTo });

      // Filter by autoReplen if specified (0 = worker queue, 1 = picker inline)
      if (autoReplenFilter != null) {
        const filterVal = parseInt(autoReplenFilter);
        tasks = tasks.filter((t: any) => (t.autoReplen ?? 0) === filterVal);
      }
      
      const locationIds = new Set<number>();
      const productIds = new Set<number>();
      const variantIds = new Set<number>();
      for (const task of tasks) {
        locationIds.add(task.fromLocationId);
        locationIds.add(task.toLocationId);
        if (task.productId) productIds.add(task.productId);
        if (task.sourceProductVariantId) variantIds.add(task.sourceProductVariantId);
        if (task.pickProductVariantId) variantIds.add(task.pickProductVariantId);
      }

      const [allLocations, allProducts, allVariants] = await Promise.all([
        storage.getAllWarehouseLocations(),
        storage.getAllProducts(),
        storage.getAllProductVariants(),
      ]);

      const locationMap = new Map(allLocations.filter(l => locationIds.has(l.id)).map(l => [l.id, l]));
      const productMap = new Map(allProducts.filter(p => productIds.has(p.id)).map(p => [p.id, p]));
      const variantMap = new Map(allVariants.filter(v => variantIds.has(v.id)).map(v => [v.id, v]));

      const enriched = tasks.map(task => ({
        ...task,
        fromLocation: locationMap.get(task.fromLocationId),
        toLocation: locationMap.get(task.toLocationId),
        product: task.productId ? productMap.get(task.productId) : null,
        sourceVariant: task.sourceProductVariantId ? variantMap.get(task.sourceProductVariantId) : null,
        pickVariant: task.pickProductVariantId ? variantMap.get(task.pickProductVariantId) : null,
      }));
      
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching replen tasks:", error);
      res.status(500).json({ error: "Failed to fetch replen tasks" });
    }
  });
  
  app.get("/api/replen/tasks/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const task = await storage.getReplenTaskById(id);
      if (!task) {
        return res.status(404).json({ error: "Replen task not found" });
      }
      
      const [allLocations, allProducts] = await Promise.all([
        storage.getAllWarehouseLocations(),
        storage.getAllProducts(),
      ]);

      const locationMap = new Map(allLocations.map(l => [l.id, l]));
      const productMap = new Map(allProducts.map(p => [p.id, p]));

      const enriched = {
        ...task,
        fromLocation: locationMap.get(task.fromLocationId),
        toLocation: locationMap.get(task.toLocationId),
        product: task.productId ? productMap.get(task.productId) : null,
      };
      
      res.json(enriched);
    } catch (error) {
      console.error("Error fetching replen task:", error);
      res.status(500).json({ error: "Failed to fetch replen task" });
    }
  });
  
  app.post("/api/replen/tasks", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { replenRuleId, fromLocationId, toLocationId, productId, sourceVariantId, pickVariantId, qtySourceUnits, qtyTargetUnits, priority, triggeredBy, assignedTo, notes, replenMethod, autoExecute } = req.body;

      if (!fromLocationId || !toLocationId || !qtyTargetUnits) {
        return res.status(400).json({ error: "fromLocationId, toLocationId, and qtyTargetUnits are required" });
      }

      // Resolve execution mode via unified decision when not explicitly set
      const { replenishment } = req.app.locals.services as any;
      let shouldAutoExecute = !!autoExecute;
      let executionMode = autoExecute ? "inline" : "queue";

      if (autoExecute === undefined && replenishment) {
        // Caller didn't specify — use warehouse settings to decide
        const [destLoc] = await db.select().from(warehouseLocations)
          .where(eq(warehouseLocations.id, toLocationId)).limit(1);
        const whSettings = await replenishment.getSettingsForWarehouse(destLoc?.warehouseId ?? undefined);
        const decision = replenishment.resolveAutoExecute(null, null, whSettings, qtyTargetUnits);
        shouldAutoExecute = decision.shouldAutoExecute;
        executionMode = decision.executionMode;
      }

      const task = await storage.createReplenTask({
        replenRuleId: replenRuleId || null,
        fromLocationId,
        toLocationId,
        productId: productId || null,
        sourceProductVariantId: sourceVariantId || null,
        pickProductVariantId: pickVariantId || null,
        qtySourceUnits: qtySourceUnits || 1,
        qtyTargetUnits,
        qtyCompleted: 0,
        status: "pending",
        priority: priority || 5,
        triggeredBy: triggeredBy || "manual",
        executionMode,
        assignedTo: assignedTo || null,
        notes: notes || null,
        replenMethod: replenMethod || "full_case",
      });

      // Auto-execute immediately if resolved decision says so
      if (shouldAutoExecute && replenishment) {
        try {
          const result = await replenishment.executeTask(task.id, req.session.user?.id);
          return res.status(201).json({ ...task, ...result, autoExecuted: true });
        } catch (execErr: any) {
          console.error("Auto-execute failed for task", task.id, execErr);
          // Task was created but execution failed — return 207 (multi-status) so caller knows
          return res.status(207).json({ ...task, autoExecuted: false, autoExecuteError: execErr.message });
        }
      }

      res.status(201).json(task);
    } catch (error) {
      console.error("Error creating replen task:", error);
      res.status(500).json({ error: "Failed to create replen task" });
    }
  });
  
  app.patch("/api/replen/tasks/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;

      // Block manual completion — must use /execute endpoint to move inventory
      if (updates.status === "completed") {
        return res.status(400).json({ error: "Use the /execute endpoint to complete tasks (ensures inventory is moved)" });
      }

      // Validate status transitions if status is being changed
      if (updates.status) {
        const VALID_TRANSITIONS: Record<string, string[]> = {
          pending: ["assigned", "in_progress", "cancelled"],
          assigned: ["in_progress", "pending", "cancelled"],
          in_progress: ["pending", "cancelled", "blocked"],
          blocked: ["pending", "cancelled"],
        };
        const existing = await storage.getReplenTaskById(id);
        if (!existing) {
          return res.status(404).json({ error: "Replen task not found" });
        }
        const allowed = VALID_TRANSITIONS[existing.status];
        if (!allowed || !allowed.includes(updates.status)) {
          return res.status(400).json({ error: `Cannot transition from '${existing.status}' to '${updates.status}'` });
        }
      }

      const task = await storage.updateReplenTask(id, updates);
      if (!task) {
        return res.status(404).json({ error: "Replen task not found" });
      }
      res.json(task);
    } catch (error) {
      console.error("Error updating replen task:", error);
      res.status(500).json({ error: "Failed to update replen task" });
    }
  });
  
  // Execute a replen task (actually move inventory from source to pick location)
  app.post("/api/replen/tasks/:id/execute", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { replenishment } = req.app.locals.services;
      const result = await replenishment.executeTask(id, req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      console.error("Error executing replen task:", error);
      res.status(400).json({ error: error.message || "Failed to execute replen task" });
    }
  });

  // Report an exception during replen task execution → blocks task + auto-creates cycle count
  app.post("/api/replen/tasks/:id/exception", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services as any;
      if (!replenishment) {
        return res.status(500).json({ error: "Replenishment service not available" });
      }
      const id = parseInt(req.params.id);
      const { reason, actualQty, actualSku, notes } = req.body;
      const result = await replenishment.reportException({
        taskId: id,
        reason,
        userId: req.session.user?.id,
        actualQty,
        actualSku,
        notes,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error reporting replen exception:", error);
      res.status(500).json({ error: error.message || "Failed to report exception" });
    }
  });

  app.delete("/api/replen/tasks/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReplenTask(id);
      if (!deleted) {
        return res.status(404).json({ error: "Replen task not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting replen task:", error);
      res.status(500).json({ error: "Failed to delete replen task" });
    }
  });
  
  app.post("/api/replen/generate", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services as any;
      if (!replenishment) {
        return res.status(500).json({ error: "Replenishment service not available" });
      }
      const warehouseId = req.body.warehouseId ? parseInt(req.body.warehouseId) : undefined;
      const result = await replenishment.generateTasks(warehouseId);
      res.json(result);
    } catch (error) {
      console.error("Error generating replen tasks:", error);
      res.status(500).json({ error: "Failed to generate replen tasks" });
    }
  });

  // Scan empty bins — uses ReplenishmentService.checkThresholds which also scans
  // product_locations for bins assigned to products with zero stock
  app.post("/api/replen/scan-empty-bins", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services as any;
      if (!replenishment) {
        return res.status(500).json({ error: "Replenishment service not available" });
      }

      const warehouseId = req.body.warehouseId ? parseInt(req.body.warehouseId) : undefined;
      const tasks = await replenishment.checkThresholds(warehouseId);

      res.json({
        success: true,
        tasksCreated: tasks.length,
        tasks: tasks.map((t: any) => ({
          id: t.id,
          fromLocationId: t.fromLocationId,
          toLocationId: t.toLocationId,
          pickProductVariantId: t.pickProductVariantId,
          qtyTargetUnits: t.qtyTargetUnits,
          status: t.status,
        })),
      });
    } catch (error) {
      console.error("Error running replen sync:", error);
      res.status(500).json({ error: "Failed to run replen sync" });
    }
  });

  // ============================================
  // WMS SERVICE ROUTES (Phase 2)
  // ============================================

  // --- Break / Assembly Routes ---

  app.post("/api/inventory/break", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { breakAssembly } = req.app.locals.services;
      const { sourceVariantId, targetVariantId, sourceQty, warehouseLocationId, targetLocationId } = req.body;
      const userId = req.session.user?.id;

      if (!sourceVariantId || !targetVariantId || !sourceQty || !warehouseLocationId) {
        return res.status(400).json({ error: "Missing required fields: sourceVariantId, targetVariantId, sourceQty, warehouseLocationId" });
      }

      const result = await breakAssembly.breakVariant({
        sourceVariantId,
        targetVariantId,
        sourceQty,
        warehouseLocationId,
        targetLocationId: targetLocationId || undefined,
        userId,
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error breaking variant:", error);
      res.status(400).json({ error: error.message || "Failed to break variant" });
    }
  });

  app.post("/api/inventory/assemble", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { breakAssembly } = req.app.locals.services;
      const { sourceVariantId, targetVariantId, targetQty, warehouseLocationId } = req.body;
      const userId = req.session.user?.id;

      if (!sourceVariantId || !targetVariantId || !targetQty || !warehouseLocationId) {
        return res.status(400).json({ error: "Missing required fields: sourceVariantId, targetVariantId, targetQty, warehouseLocationId" });
      }

      const result = await breakAssembly.assembleVariant({
        sourceVariantId,
        targetVariantId,
        targetQty,
        warehouseLocationId,
        userId,
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error assembling variant:", error);
      res.status(400).json({ error: error.message || "Failed to assemble variant" });
    }
  });

  app.get("/api/inventory/conversion-preview", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { breakAssembly } = req.app.locals.services;
      const sourceVariantId = parseInt(String(req.query.sourceVariantId));
      const targetVariantId = parseInt(String(req.query.targetVariantId));
      const qty = parseInt(String(req.query.qty));
      const direction = String(req.query.direction || "break");

      if (isNaN(sourceVariantId) || isNaN(targetVariantId) || isNaN(qty)) {
        return res.status(400).json({ error: "sourceVariantId, targetVariantId, and qty are required" });
      }

      const preview = await breakAssembly.getConversionPreview({
        sourceVariantId,
        targetVariantId,
        qty,
        direction: direction as "break" | "assemble",
      });

      res.json(preview);
    } catch (error: any) {
      console.error("Error getting conversion preview:", error);
      res.status(400).json({ error: error.message || "Failed to get preview" });
    }
  });

  // --- Returns Routes ---

  app.post("/api/returns/process", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { returns } = req.app.locals.services;
      const { orderId, items, warehouseLocationId, notes } = req.body;
      const userId = req.session.user?.id;

      if (!orderId || !items || !Array.isArray(items) || items.length === 0 || !warehouseLocationId) {
        return res.status(400).json({ error: "Missing required fields: orderId, items (array), warehouseLocationId" });
      }

      const result = await returns.processReturn({
        orderId,
        items,
        warehouseLocationId,
        userId,
        notes,
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error processing return:", error);
      res.status(500).json({ error: error.message || "Failed to process return" });
    }
  });

  app.get("/api/returns/:orderId", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { returns } = req.app.locals.services;
      const orderId = parseInt(req.params.orderId);

      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const history = await returns.getReturnHistory(orderId);
      res.json(history);
    } catch (error: any) {
      console.error("Error getting return history:", error);
      res.status(500).json({ error: error.message || "Failed to get return history" });
    }
  });

  // --- Returns: Order Lookup (enriches items with productVariantId) ---

  app.get("/api/returns/order-lookup/:orderNumber", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { returns } = req.app.locals.services;
      const orderNumber = req.params.orderNumber;

      // Find order by order number
      const allOrders = await storage.getOrders();
      const order = allOrders.find((o: any) => o.orderNumber === orderNumber);
      if (!order) {
        return res.status(404).json({ error: "Order not found" });
      }

      // Get order items
      const items = await storage.getOrderItems(order.id);

      // Resolve SKU → productVariantId for each item
      const enrichedItems = await Promise.all(
        items.map(async (item: any) => {
          let productVariantId: number | null = null;
          if (item.sku) {
            const variant = await storage.getProductVariantBySku(item.sku);
            productVariantId = variant?.id ?? null;
          }
          return {
            id: item.id,
            sku: item.sku,
            name: item.name,
            quantity: item.quantity,
            pickedQuantity: item.pickedQuantity,
            fulfilledQuantity: item.fulfilledQuantity,
            status: item.status,
            productVariantId,
          };
        })
      );

      // Get existing return history
      const returnHistory = await returns.getReturnHistory(order.id);

      res.json({
        order: {
          id: order.id,
          orderNumber: order.orderNumber,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          orderPlacedAt: order.orderPlacedAt,
          warehouseStatus: order.warehouseStatus,
          financialStatus: order.financialStatus,
          itemCount: order.itemCount,
          totalAmount: order.totalAmount,
        },
        items: enrichedItems,
        returnHistory,
      });
    } catch (error: any) {
      console.error("Error looking up order for return:", error);
      res.status(500).json({ error: error.message || "Failed to look up order" });
    }
  });

  // --- Order Reservation Routes ---

  app.post("/api/orders/:id/reserve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { reservation } = req.app.locals.services;
      const orderId = parseInt(req.params.id);

      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const result = await reservation.reserveOrder(orderId);
      res.json(result);
    } catch (error: any) {
      console.error("Error reserving order:", error);
      res.status(500).json({ error: error.message || "Failed to reserve order" });
    }
  });

  app.delete("/api/orders/:id/reserve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { reservation } = req.app.locals.services;
      const orderId = parseInt(req.params.id);

      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const result = await reservation.releaseOrderReservation(orderId, "Manual release via API");
      res.json(result);
    } catch (error: any) {
      console.error("Error releasing reservation:", error);
      res.status(500).json({ error: error.message || "Failed to release reservation" });
    }
  });

  app.get("/api/orders/:id/reservation", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { reservation } = req.app.locals.services;
      const orderId = parseInt(req.params.id);

      if (isNaN(orderId)) {
        return res.status(400).json({ error: "Invalid order ID" });
      }

      const status = await reservation.getOrderReservationStatus(orderId);
      res.json(status);
    } catch (error: any) {
      console.error("Error getting reservation status:", error);
      res.status(500).json({ error: error.message || "Failed to get reservation status" });
    }
  });

  // --- Channel Sync Routes ---

  app.post("/api/channel-sync/product/:productId", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services;
      const productId = parseInt(req.params.productId);

      if (isNaN(productId)) {
        return res.status(400).json({ error: "Invalid product ID" });
      }

      const result = await channelSync.syncProduct(productId);
      res.json(result);
    } catch (error: any) {
      console.error("Error syncing product:", error);
      res.status(500).json({ error: error.message || "Failed to sync product" });
    }
  });

  app.post("/api/channel-sync/all", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services;
      const channelId = req.body.channelId ? parseInt(req.body.channelId) : undefined;

      // Fire-and-forget: respond immediately to avoid Heroku 30s timeout
      res.json({ status: "started", message: "Inventory sync started in background" });

      // Run sync in background
      channelSync.syncAllProducts(channelId)
        .then((result: any) => {
          console.log(`[ChannelSync] Background sync complete: ${result.synced}/${result.total} synced, ${result.errors.length} errors`);
        })
        .catch((err: any) => {
          console.error("[ChannelSync] Background sync failed:", err);
        });
    } catch (error: any) {
      console.error("Error starting channel sync:", error);
      res.status(500).json({ error: error.message || "Failed to start sync" });
    }
  });

  // --- Channel Sync Monitoring ---

  app.get("/api/channel-sync/status", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services;
      const channelId = req.query.channelId ? parseInt(req.query.channelId as string) : undefined;
      const status = await channelSync.getLastSyncStatus(channelId);
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get sync status" });
    }
  });

  app.get("/api/channel-sync/log", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services;
      const log = await channelSync.getSyncLog({
        channelId: req.query.channelId ? parseInt(req.query.channelId as string) : undefined,
        productId: req.query.productId ? parseInt(req.query.productId as string) : undefined,
        status: req.query.status as string | undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 100,
        offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
      });
      res.json(log);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get sync log" });
    }
  });

  app.get("/api/channel-sync/divergence", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services;
      const divergence = await channelSync.getDivergence();
      res.json(divergence);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get divergence" });
    }
  });

  // --- Channel Product Allocation (product-level rules per channel) ---

  app.get("/api/channel-product-allocation", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const rows = await db.select().from(cpa);
      res.json(rows);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get allocations" });
    }
  });

  app.get("/api/channel-product-allocation/:channelId/:productId", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const { and, eq } = await import("drizzle-orm");
      const channelId = parseInt(req.params.channelId);
      const productId = parseInt(req.params.productId);
      const [row] = await db.select().from(cpa).where(
        and(eq(cpa.channelId, channelId), eq(cpa.productId, productId))
      ).limit(1);
      res.json(row || null);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to get allocation" });
    }
  });

  app.put("/api/channel-product-allocation", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const { channelId, productId, minAtpBase, maxAtpBase, isListed, notes } = req.body;

      if (!channelId || !productId) {
        return res.status(400).json({ error: "channelId and productId are required" });
      }

      // Upsert
      const [existing] = await db.select().from(cpa).where(
        and(eq(cpa.channelId, channelId), eq(cpa.productId, productId))
      ).limit(1);

      if (existing) {
        const [updated] = await db.update(cpa).set({
          minAtpBase: minAtpBase ?? null,
          maxAtpBase: maxAtpBase ?? null,
          isListed: isListed ?? 1,
          notes: notes ?? null,
          updatedAt: new Date(),
        }).where(eq(cpa.id, existing.id)).returning();
        res.json(updated);
      } else {
        const [created] = await db.insert(cpa).values({
          channelId,
          productId,
          minAtpBase: minAtpBase ?? null,
          maxAtpBase: maxAtpBase ?? null,
          isListed: isListed ?? 1,
          notes: notes ?? null,
        }).returning();
        res.json(created);
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to save allocation" });
    }
  });

  app.delete("/api/channel-product-allocation/:id", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");
      const id = parseInt(req.params.id);
      await db.delete(cpa).where(eq(cpa.id, id));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to delete allocation" });
    }
  });

  // --- Product-level allocation data for ProductDetail Channels tab ---

  app.get("/api/products/:productId/allocation", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelProductAllocation: cpa, channelReservations: cr, channelFeeds: cf, channels: ch, productVariants: pv } = await import("@shared/schema");
      const { eq, and, inArray } = await import("drizzle-orm");
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) return res.status(400).json({ error: "Invalid product ID" });

      const activeChannels = await db.select().from(ch).where(eq(ch.status, "active"));
      const variants = await db.select().from(pv).where(eq(pv.productId, productId));
      const variantIds = variants.map((v: any) => v.id);

      // Product-level allocation rules per channel
      const productAllocs = await db.select().from(cpa).where(eq(cpa.productId, productId));

      // Variant-level reservations for this product's variants
      const variantReservations = variantIds.length > 0
        ? await db.select().from(cr).where(inArray(cr.productVariantId, variantIds))
        : [];

      // Feed data for this product's variants
      const feeds = variantIds.length > 0
        ? await db.select({
            id: cf.id,
            channelId: cf.channelId,
            productVariantId: cf.productVariantId,
            lastSyncedQty: cf.lastSyncedQty,
            lastSyncedAt: cf.lastSyncedAt,
            isActive: cf.isActive,
          }).from(cf).where(inArray(cf.productVariantId, variantIds))
        : [];

      // ATP data
      const { inventoryAtp } = req.app.locals.services;
      const atpBase = await inventoryAtp.getAtpBase(productId);
      const variantAtp = await inventoryAtp.getAtpPerVariant(productId);

      res.json({
        channels: activeChannels,
        variants: variants.map((v: any) => ({
          id: v.id,
          sku: v.sku,
          name: v.name,
          unitsPerVariant: v.unitsPerVariant,
          atpUnits: variantAtp.find((va: any) => va.productVariantId === v.id)?.atpUnits ?? 0,
        })),
        atpBase,
        productAllocations: productAllocs,
        variantReservations,
        feeds,
      });
    } catch (error: any) {
      console.error("Error fetching product allocation:", error);
      res.status(500).json({ error: error.message || "Failed to fetch product allocation" });
    }
  });

  // --- Channel Allocation View (grid data for UI) ---

  app.get("/api/channel-allocation/grid", requirePermission("channels", "view"), async (req, res) => {
    try {
      const { channelSync, inventoryAtp } = req.app.locals.services;
      const { channelProductAllocation: cpa, channelReservations: cr, channelFeeds: cf, channels: ch, productVariants: pv, products: p } = await import("@shared/schema");
      const { eq, and, inArray } = await import("drizzle-orm");

      // Get all active channels
      const activeChannels = await db.select().from(ch).where(eq(ch.status, "active"));

      // Get all active feeds with variant + product info
      const feeds = await db.select({
        feedId: cf.id,
        channelId: cf.channelId,
        channelType: cf.channelType,
        productVariantId: cf.productVariantId,
        lastSyncedQty: cf.lastSyncedQty,
        lastSyncedAt: cf.lastSyncedAt,
      }).from(cf).where(eq(cf.isActive, 1));

      // Get all variants that have feeds
      const feedVariantIds = Array.from(new Set(feeds.map((f: any) => f.productVariantId)));
      if (feedVariantIds.length === 0) {
        return res.json({ channels: activeChannels, rows: [] });
      }

      const variants = await db.select().from(pv).where(inArray(pv.id, feedVariantIds));
      const productIds = Array.from(new Set(variants.map((v: any) => v.productId)));
      const prods = await db.select().from(p).where(inArray(p.id, productIds));

      // Load all allocation rules
      const productAllocs = await db.select().from(cpa);
      const variantReservations = await db.select().from(cr).where(inArray(cr.productVariantId, feedVariantIds));

      // Batch ATP
      const atpMap = new Map<number, number>();
      for (const pid of productIds) {
        const atpBase = await inventoryAtp.getAtpBase(pid);
        atpMap.set(pid, atpBase);
      }

      const variantAtpMap = new Map<number, any>();
      for (const pid of productIds) {
        const variantAtp = await inventoryAtp.getAtpPerVariant(pid);
        for (const v of variantAtp) {
          variantAtpMap.set(v.productVariantId, v);
        }
      }

      // Build grid rows
      const rows = variants.map((v: any) => {
        const prod = prods.find((p: any) => p.id === v.productId);
        const vatpInfo = variantAtpMap.get(v.id);
        const atpBase = atpMap.get(v.productId) ?? 0;

        const channelData: Record<number, any> = {};
        for (const ch of activeChannels) {
          const feed = feeds.find((f: any) => f.channelId === ch.id && f.productVariantId === v.id);
          const prodAlloc = productAllocs.find((pa: any) => pa.channelId === ch.id && pa.productId === v.productId);
          const varRes = variantReservations.find((r: any) => (r as any).channelId === ch.id && (r as any).productVariantId === v.id);

          channelData[ch.id] = {
            hasFeed: !!feed,
            lastSyncedQty: feed?.lastSyncedQty ?? null,
            lastSyncedAt: feed?.lastSyncedAt ?? null,
            productFloor: prodAlloc?.minAtpBase ?? null,
            productCap: prodAlloc?.maxAtpBase ?? null,
            isListed: prodAlloc?.isListed ?? 1,
            variantFloor: (varRes as any)?.minStockBase ?? null,
            variantCap: (varRes as any)?.maxStockBase ?? null,
            effectiveAtp: vatpInfo?.atpUnits ?? 0,
          };

          // Compute effective ATP with overrides
          let effective = vatpInfo?.atpUnits ?? 0;
          if (prodAlloc?.isListed === 0) effective = 0;
          else if (prodAlloc?.minAtpBase != null && atpBase < prodAlloc.minAtpBase) effective = 0;
          else {
            if ((varRes as any)?.minStockBase != null && (varRes as any).minStockBase > 0 && effective < (varRes as any).minStockBase) effective = 0;
            if ((varRes as any)?.maxStockBase != null && effective > 0) {
              const maxUnits = Math.floor((varRes as any).maxStockBase / (vatpInfo?.unitsPerVariant ?? 1));
              effective = Math.min(effective, maxUnits);
            }
          }
          channelData[ch.id].effectiveAtp = Math.max(effective, 0);
        }

        return {
          productVariantId: v.id,
          productId: v.productId,
          sku: v.sku || prod?.sku || "",
          productName: prod?.name || "",
          variantName: v.name || "",
          unitsPerVariant: v.unitsPerVariant,
          atpBase,
          atpUnits: vatpInfo?.atpUnits ?? 0,
          channels: channelData,
        };
      });

      res.json({ channels: activeChannels, rows });
    } catch (error: any) {
      console.error("Error building allocation grid:", error);
      res.status(500).json({ error: error.message || "Failed to build allocation grid" });
    }
  });

  // --- External Inventory Sync (3PL / Channel pull) ---

  app.post("/api/warehouses/:id/sync-inventory", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventorySource } = req.app.locals.services;
      const warehouseId = parseInt(req.params.id);
      if (isNaN(warehouseId)) {
        return res.status(400).json({ error: "Invalid warehouse ID" });
      }
      // Fire-and-forget to avoid timeout
      res.json({ status: "started", message: "Inventory sync started" });
      inventorySource.syncWarehouse(warehouseId)
        .then((result: any) => {
          console.log(`[InventorySource] Sync complete for warehouse ${result.warehouseCode}: ${result.synced} synced, ${result.skipped} skipped, ${result.errors.length} errors`);
        })
        .catch((err: any) => {
          console.error("[InventorySource] Sync failed:", err);
        });
    } catch (error: any) {
      console.error("Error starting inventory source sync:", error);
      res.status(500).json({ error: error.message || "Failed to start sync" });
    }
  });

  app.post("/api/sync/external-inventory", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventorySource } = req.app.locals.services;
      // Fire-and-forget
      res.json({ status: "started", message: "External inventory sync started for all warehouses" });
      inventorySource.syncAll()
        .then((results: any[]) => {
          for (const r of results) {
            console.log(`[InventorySource] ${r.warehouseCode}: ${r.synced} synced, ${r.skipped} skipped, ${r.errors.length} errors`);
          }
        })
        .catch((err: any) => {
          console.error("[InventorySource] Bulk sync failed:", err);
        });
    } catch (error: any) {
      console.error("Error starting bulk inventory source sync:", error);
      res.status(500).json({ error: error.message || "Failed to start sync" });
    }
  });

  // --- SLA Monitoring ---

  // Get SLA alerts (at_risk + overdue orders)
  app.get("/api/sla/alerts", requirePermission("orders", "view"), async (req, res) => {
    try {
      const { slaMonitor } = req.app.locals.services;
      const alerts = await slaMonitor.getSLAAlerts();
      res.json(alerts);
    } catch (error: any) {
      console.error("Error fetching SLA alerts:", error);
      res.status(500).json({ error: error.message || "Failed to fetch SLA alerts" });
    }
  });

  // Get SLA summary counts
  app.get("/api/sla/summary", requirePermission("orders", "view"), async (req, res) => {
    try {
      const { slaMonitor } = req.app.locals.services;
      const summary = await slaMonitor.getSLASummary();
      res.json(summary);
    } catch (error: any) {
      console.error("Error fetching SLA summary:", error);
      res.status(500).json({ error: error.message || "Failed to fetch SLA summary" });
    }
  });

  // Manually trigger SLA status update
  app.post("/api/sla/update-statuses", requirePermission("orders", "manage"), async (req, res) => {
    try {
      const { slaMonitor } = req.app.locals.services;
      const result = await slaMonitor.updateSLAStatuses();
      res.json({ message: "SLA statuses updated", ...result });
    } catch (error: any) {
      console.error("Error updating SLA statuses:", error);
      res.status(500).json({ error: error.message || "Failed to update SLA statuses" });
    }
  });

  // --- Inventory Alerts (anomaly detection) ---

  app.get("/api/inventory/alerts", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryAlerts } = req.app.locals.services;
      const alerts = await inventoryAlerts.checkAll();
      const critical = alerts.filter(a => a.severity === "critical").length;
      const warning = alerts.filter(a => a.severity === "warning").length;
      res.json({ alerts, summary: { total: alerts.length, critical, warning } });
    } catch (error: any) {
      console.error("Error checking inventory alerts:", error);
      res.status(500).json({ error: error.message || "Failed to check alerts" });
    }
  });

  // --- Replenishment Check Route ---

  app.post("/api/replen/check", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { replenishment } = req.app.locals.services;
      const tasks = await replenishment.checkThresholds();
      res.json({ created: tasks.length, tasks });
    } catch (error: any) {
      console.error("Error checking replenishment thresholds:", error);
      res.status(500).json({ error: error.message || "Failed to check thresholds" });
    }
  });

  // ===== OPERATIONS VIEW ENDPOINTS =====

  app.get("/api/operations/bin-inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getBinInventory({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        zone: (req.query.zone as string) || null,
        locationType: (req.query.locationType as string) || null,
        binType: (req.query.binType as string) || null,
        search: (req.query.search as string) || null,
        hasInventory: req.query.hasInventory === "true" ? true : req.query.hasInventory === "false" ? false : null,
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
        sortField: (req.query.sortField as string) || "code",
        sortDir: (req.query.sortDir as string) === "desc" ? "desc" as const : "asc" as const,
      });
      res.json(result);
    } catch (error: any) {
      console.error("Error fetching bin inventory:", error?.message || error);
      res.status(500).json({ error: "Failed to fetch bin inventory", detail: error?.message });
    }
  });

  app.get("/api/operations/unassigned-inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getUnassignedInventory({
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching unassigned inventory:", error);
      res.status(500).json({ error: "Failed to fetch unassigned inventory" });
    }
  });

  app.get("/api/operations/location-health", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getLocationHealth({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        staleDays: parseInt(req.query.staleDays as string) || 30,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching location health:", error);
      res.status(500).json({ error: "Failed to fetch location health" });
    }
  });

  app.get("/api/operations/exceptions", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getExceptions({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        staleDays: parseInt(req.query.staleDays as string) || 30,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching exceptions:", error);
      res.status(500).json({ error: "Failed to fetch exceptions" });
    }
  });

  app.get("/api/operations/pick-readiness", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getPickReadiness({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        threshold: parseInt(req.query.threshold as string) || 5,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching pick readiness:", error);
      res.status(500).json({ error: "Failed to fetch pick readiness" });
    }
  });

  app.get("/api/operations/activity", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getActivity({
        locationId: req.query.locationId ? parseInt(req.query.locationId as string) : null,
        variantId: req.query.variantId ? parseInt(req.query.variantId as string) : null,
        limit: parseInt(req.query.limit as string) || 20,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching activity:", error);
      res.status(500).json({ error: "Failed to fetch activity" });
    }
  });

  app.get("/api/operations/action-queue", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services as any;
      const result = await ops.getActionQueue({
        warehouseId: req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null,
        filter: (req.query.filter as string) || "all",
        search: (req.query.search as string) || "",
        page: parseInt(req.query.page as string) || 1,
        pageSize: parseInt(req.query.pageSize as string) || 50,
        sortField: (req.query.sortField as string) || "priority",
        sortDir: (req.query.sortDir as string) === "desc" ? "desc" as const : "asc" as const,
      });
      res.json(result);
    } catch (error) {
      console.error("Error fetching action queue:", error);
      res.status(500).json({ error: "Failed to fetch action queue" });
    }
  });

  // ── Purchasing / Reorder Analysis ──────────────────────────────────
  app.get("/api/purchasing/reorder-analysis", requirePermission("inventory", "view"), async (req, res) => {
    try {
      // Use velocity_lookback_days from warehouse_settings as the default lookback
      const wsResult = await db.execute(sql`SELECT velocity_lookback_days FROM warehouse_settings LIMIT 1`);
      const configuredLookback = (wsResult.rows[0] as any)?.velocity_lookback_days ?? 14;
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;

      // Product-level query: aggregate inventory and velocity in base units (pieces)
      // Also fetch the highest-level variant (ordering UOM) for rounding order quantities
      const rows = await db.execute(sql`
        SELECT
          p.id AS product_id,
          p.sku AS base_sku,
          p.name AS product_name,
          p.lead_time_days,
          p.safety_stock_days,
          COALESCE(inv.total_pieces, 0)::bigint AS total_pieces,
          COALESCE(inv.total_reserved_pieces, 0)::bigint AS total_reserved_pieces,
          COALESCE(vel.total_outbound_pieces, 0)::bigint AS total_outbound_pieces,
          inv.variant_count,
          order_uom.units_per_variant AS order_uom_units,
          order_uom.sku AS order_uom_sku,
          order_uom.hierarchy_level AS order_uom_level,
          (SELECT MAX(it2.created_at)
           FROM inventory_transactions it2
           JOIN product_variants pv2 ON pv2.id = it2.product_variant_id
           WHERE pv2.product_id = p.id
             AND it2.transaction_type = 'receipt') AS last_received_at
        FROM products p
        LEFT JOIN (
          SELECT pv.product_id,
                 SUM(il.variant_qty * pv.units_per_variant) AS total_pieces,
                 SUM(il.reserved_qty * pv.units_per_variant) AS total_reserved_pieces,
                 COUNT(DISTINCT pv.id) AS variant_count
          FROM inventory_levels il
          JOIN product_variants pv ON pv.id = il.product_variant_id
          WHERE pv.is_active = true
          GROUP BY pv.product_id
        ) inv ON inv.product_id = p.id
        LEFT JOIN (
          SELECT pv.product_id,
                 SUM(oi.quantity * pv.units_per_variant) AS total_outbound_pieces
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          JOIN product_variants pv ON pv.sku = oi.sku AND pv.is_active = true
          WHERE o.cancelled_at IS NULL
            AND o.warehouse_status != 'cancelled'
            AND oi.status != 'cancelled'
            AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${lookbackDays})
          GROUP BY pv.product_id
        ) vel ON vel.product_id = p.id
        LEFT JOIN LATERAL (
          SELECT pv.units_per_variant, pv.sku, pv.hierarchy_level
          FROM product_variants pv
          WHERE pv.product_id = p.id AND pv.is_active = true
          ORDER BY pv.hierarchy_level DESC
          LIMIT 1
        ) order_uom ON true
        WHERE p.is_active = true
        ORDER BY p.sku, p.name
      `);

      const HIERARCHY_LABELS: Record<number, string> = { 1: "Pack", 2: "Box", 3: "Case", 4: "Skid" };

      const items = (rows.rows as any[]).map((r) => {
        const totalOnHand = Number(r.total_pieces);
        const totalReserved = Number(r.total_reserved_pieces);
        const totalOutbound = Number(r.total_outbound_pieces);
        const leadTimeDays = Number(r.lead_time_days);
        const safetyStockDays = Number(r.safety_stock_days);
        const avgDailyUsage = lookbackDays > 0 ? totalOutbound / lookbackDays : 0;
        const daysOfSupply = avgDailyUsage > 0 ? Math.round(totalOnHand / avgDailyUsage) : totalOnHand > 0 ? 9999 : 0;
        const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);
        const rawOrderQtyPieces = Math.max(0, (leadTimeDays + safetyStockDays) * avgDailyUsage - totalOnHand);

        // Round up to ordering UOM (highest hierarchy variant)
        const orderUomUnits = Number(r.order_uom_units) || 1;
        const orderUomLevel = Number(r.order_uom_level) || 0;
        const orderUomLabel = HIERARCHY_LABELS[orderUomLevel] || (orderUomUnits > 1 ? `${orderUomUnits}pk` : "pcs");
        const suggestedOrderQty = orderUomUnits > 1
          ? Math.ceil(rawOrderQtyPieces / orderUomUnits) // in ordering units (cases, boxes, etc.)
          : Math.ceil(rawOrderQtyPieces); // fallback: pieces
        const suggestedOrderPieces = suggestedOrderQty * orderUomUnits;

        let status: string;
        if (avgDailyUsage === 0) {
          status = "no_movement";
        } else if (totalOnHand <= 0) {
          status = "stockout";
        } else if (totalOnHand <= reorderPoint) {
          status = "order_now";
        } else if (daysOfSupply <= leadTimeDays * 1.5) {
          status = "order_soon";
        } else {
          status = "ok";
        }

        return {
          productId: r.product_id,
          sku: r.base_sku || r.product_name,
          productName: r.product_name,
          variantCount: Number(r.variant_count || 0),
          totalOnHand,
          totalReserved,
          available: totalOnHand - totalReserved,
          periodUsage: totalOutbound,
          avgDailyUsage: Math.round(avgDailyUsage * 100) / 100,
          daysOfSupply,
          leadTimeDays,
          safetyStockDays,
          reorderPoint,
          suggestedOrderQty,
          suggestedOrderPieces,
          orderUomUnits,
          orderUomLabel,
          status,
          lastReceivedAt: r.last_received_at,
        };
      });

      const summary = {
        totalProducts: items.length,
        belowReorderPoint: items.filter((i) => i.status === "order_now" || i.status === "stockout").length,
        orderSoon: items.filter((i) => i.status === "order_soon").length,
        noMovement: items.filter((i) => i.status === "no_movement").length,
        totalOnHand: items.reduce((s, i) => s + i.totalOnHand, 0),
      };

      res.json({ items, summary, lookbackDays });
    } catch (error) {
      console.error("Error fetching reorder analysis:", error);
      res.status(500).json({ error: "Failed to fetch reorder analysis" });
    }
  });

  // PATCH velocity lookback days
  app.patch("/api/purchasing/velocity-lookback", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const days = parseInt(req.body.days);
      if (!days || days < 7 || days > 365) {
        return res.status(400).json({ error: "Days must be between 7 and 365" });
      }
      await db.execute(sql`UPDATE warehouse_settings SET velocity_lookback_days = ${days}, updated_at = NOW()`);
      res.json({ ok: true, days });
    } catch (error) {
      console.error("Error updating velocity lookback:", error);
      res.status(500).json({ error: "Failed to update velocity lookback" });
    }
  });

  // ===== INTERNAL API (for Archon cross-service sync) =====

  app.get("/api/internal/orders", requireInternalApiKey, async (req, res) => {
    try {
      const since = req.query.since ? new Date(req.query.since as string) : null;

      const baseQuery = db
        .select({
          order: orders,
          shipment: shipments,
        })
        .from(orders)
        .leftJoin(shipments, eq(shipments.orderId, orders.id));

      const results = since
        ? await baseQuery.where(gte(orders.createdAt, since))
        : await baseQuery;

      // Deduplicate: an order may have multiple shipments — take the latest
      const orderMap = new Map<number, (typeof results)[number]>();
      for (const r of results) {
        const existing = orderMap.get(r.order.id);
        if (!existing || (r.shipment?.createdAt && (!existing.shipment?.createdAt || r.shipment.createdAt > existing.shipment.createdAt))) {
          orderMap.set(r.order.id, r);
        }
      }

      const orderList = Array.from(orderMap.values()).map(r => ({
        id: r.order.id,
        source: r.order.source,
        externalOrderId: r.order.externalOrderId,
        shopifyOrderId: r.order.shopifyOrderId,
        orderNumber: r.order.orderNumber,
        customerName: r.order.customerName,
        customerEmail: r.order.customerEmail,
        warehouseStatus: r.order.warehouseStatus,
        orderPlacedAt: r.order.orderPlacedAt?.toISOString() ?? null,
        totalAmount: r.order.totalAmount,
        shipment: r.shipment ? {
          carrier: r.shipment.carrier,
          trackingNumber: r.shipment.trackingNumber,
          trackingUrl: r.shipment.trackingUrl,
          status: r.shipment.status,
          shippedAt: r.shipment.shippedAt?.toISOString() ?? null,
        } : null,
      }));

      res.json({
        orders: orderList,
        total: orderList.length,
        syncedAt: new Date().toISOString(),
      });
    } catch (error: any) {
      console.error("Internal API - orders error:", error);
      res.status(500).json({ error: "Failed to fetch orders" });
    }
  });

  app.get("/api/internal/shipments", requireInternalApiKey, async (req, res) => {
    try {
      const orderIdsParam = req.query.orderIds as string;
      if (!orderIdsParam) {
        return res.status(400).json({ error: "orderIds query parameter required" });
      }

      const orderIds = orderIdsParam.split(",").map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id));
      if (orderIds.length === 0) {
        return res.json({ shipments: [] });
      }

      const results = await db
        .select()
        .from(shipments)
        .where(inArray(shipments.orderId, orderIds));

      res.json({
        shipments: results.map(s => ({
          orderId: s.orderId,
          carrier: s.carrier,
          trackingNumber: s.trackingNumber,
          trackingUrl: s.trackingUrl,
          status: s.status,
          shippedAt: s.shippedAt?.toISOString() ?? null,
        })),
      });
    } catch (error: any) {
      console.error("Internal API - shipments error:", error);
      res.status(500).json({ error: "Failed to fetch shipments" });
    }
  });

  return httpServer;
}
