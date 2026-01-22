import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProductLocationSchema, updateProductLocationSchema, insertWarehouseSchema, insertWarehouseLocationSchema, insertWarehouseZoneSchema, insertInventoryItemSchema, insertUomVariantSchema, insertChannelSchema, insertChannelConnectionSchema, insertPartnerProfileSchema, insertChannelReservationSchema, generateLocationCode } from "@shared/schema";
import { fetchAllShopifyProducts, fetchUnfulfilledOrders, fetchOrdersFulfillmentStatus, verifyShopifyWebhook, extractSkusFromWebhookPayload, extractOrderFromWebhookPayload, syncInventoryToShopify, syncInventoryItemToShopify, type ShopifyOrder, type InventoryLevelUpdate } from "./shopify";
import { broadcastOrdersUpdated } from "./websocket";
import type { InsertOrderItem, SafeUser, InsertProductLocation, UpdateProductLocation } from "@shared/schema";
import Papa from "papaparse";
import bcrypt from "bcrypt";
import { inventoryService } from "./inventory";
import multer from "multer";
import { seedRBAC, getUserPermissions, getUserRoles, getAllRoles, getAllPermissions, getRolePermissions, createRole, updateRolePermissions, deleteRole, assignUserRoles, hasPermission } from "./rbac";

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
      
      const location = await storage.createProductLocation(dataWithRef);
      
      res.status(201).json(location);
    } catch (error: any) {
      console.error("Error creating location:", error);
      if (error.code === "23505") { // Unique constraint violation
        return res.status(409).json({ error: "SKU already exists" });
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

      // Get completed orders in date range
      const allOrders = await storage.getOrdersWithItems(["completed"]);
      const completedOrders = allOrders.filter(o => 
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
      for (const id of ids) {
        try {
          const result = await storage.deleteWarehouseLocation(id);
          if (result) deleted++;
        } catch (err: any) {
          console.error(`Error deleting location ${id}:`, err);
          if (err.code === "23503") {
            errors.push(`Location ${id} has products assigned`);
          } else {
            errors.push(`Location ${id}: ${err.message || 'Unknown error'}`);
          }
        }
      }
      if (errors.length > 0) {
        return res.json({ success: true, deleted, errors });
      }
      res.json({ success: true, deleted });
    } catch (error) {
      console.error("Error bulk deleting warehouse locations:", error);
      res.status(500).json({ error: "Failed to delete locations" });
    }
  });

  // Bulk import warehouse locations from CSV
  app.post("/api/warehouse/locations/bulk-import", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { locations } = req.body;
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
          const bay = loc.bay?.toString().trim() || null;
          const level = loc.level?.trim() || null;
          const bin = loc.bin?.toString().trim() || null;
          
          if (!zone && !aisle && !bay && !level && !bin) {
            results.errors.push(`Row ${rowNum}: At least one hierarchy field required (zone, aisle, bay, level, or bin)`);
            continue;
          }
          
          await storage.createWarehouseLocation({
            zone,
            aisle,
            bay,
            level,
            bin,
            name: loc.name?.trim() || null,
            locationType: (loc.locationType || loc.location_type || "forward_pick").trim(),
            isPickable: loc.isPickable !== undefined ? parseInt(loc.isPickable) : 1,
            pickSequence: loc.pickSequence || loc.pick_sequence ? parseInt(loc.pickSequence || loc.pick_sequence) : null,
            minQty: loc.minQty || loc.min_qty ? parseInt(loc.minQty || loc.min_qty) : null,
            maxQty: loc.maxQty || loc.max_qty ? parseInt(loc.maxQty || loc.max_qty) : null,
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
