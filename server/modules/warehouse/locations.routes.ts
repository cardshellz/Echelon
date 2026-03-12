import type { Express } from "express";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { warehouseStorage } from "../warehouse";
import { catalogStorage } from "../catalog";
import { ordersStorage } from "../orders";
import { inventoryStorage } from "../inventory";
const storage = { ...warehouseStorage, ...catalogStorage, ...ordersStorage, ...inventoryStorage };
import { requirePermission, requireAuth, syncPickQueueForSku } from "../../routes/middleware";
import { insertProductLocationSchema, updateProductLocationSchema, productLocations, productVariants, products, inventoryLevels, warehouseLocations, inventoryTransactions } from "@shared/schema";
import type { InsertProductLocation, UpdateProductLocation } from "@shared/schema";
import Papa from "papaparse";
import { broadcastOrdersUpdated } from "../../websocket";

export function registerLocationRoutes(app: Express) {

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
      
      const data = parsed.data as any;
      
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
      
      const data = parsed.data as any;
      
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
      const warehouseLocs = await storage.getAllWarehouseLocations();
      const warehouseLocMap = new Map(
        warehouseLocs.map((wl: { code: string; id: number }) => [wl.code.toUpperCase(), wl.id])
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

}
