import type { Express } from "express";
import { z } from "zod";
import { createBinAssignmentService, warehouseStorage } from "../warehouse";
import { catalogStorage } from "../catalog";
import { inventoryStorage } from "../inventory";
import { db } from "../../storage/base";
const storage = { ...warehouseStorage, ...catalogStorage, ...inventoryStorage };
import { requirePermission } from "../../routes/middleware";
import { coerceTimeZone, parseCutoffMinutes } from "../orders/sort-rank";
import { getWarehouseById } from "./infrastructure/warehouse.repository";
import { getSlaCutoffConfig } from "./settings.resolver";

import { insertWarehouseSchema, insertWarehouseLocationSchema, insertWarehouseZoneSchema, insertFulfillmentRoutingRuleSchema, routingMatchTypeEnum } from "@shared/schema";

/**
 * Validate the SLA cutoff fields on a warehouse-settings write. Returns an
 * error string, or null if OK. Uses the SAME validators the SLA engine
 * (sort-rank.ts) applies, so a value the API accepts is a value the engine can
 * compute against — a malformed cutoff/tz must never silently poison SLA math.
 * Both fields are optional; an explicit null clears them.
 */
function validateSlaCutoffFields(body: any): string | null {
  if (body == null || typeof body !== "object") return null;
  if ("orderCutoffLocal" in body && body.orderCutoffLocal != null) {
    if (typeof body.orderCutoffLocal !== "string" || parseCutoffMinutes(body.orderCutoffLocal) == null) {
      return "order_cutoff_local must be 'HH:MM' 24-hour, e.g. '14:00'";
    }
  }
  if ("timezone" in body && body.timezone != null) {
    if (typeof body.timezone !== "string" || coerceTimeZone(body.timezone) == null) {
      return "timezone must be a valid IANA timezone, e.g. 'America/New_York'";
    }
  }
  return null;
}

function getLocationDeleteConflictMessage(error: any) {
  const constraint = String(error?.constraint || "");
  if (constraint.includes("product_locations")) {
    return "Cannot delete location because SKU slotting assignments reference it. Remove the assignments or deactivate the location instead.";
  }
  if (constraint.includes("inventory_levels")) {
    return "Cannot delete location because inventory records reference it. Move or adjust stock first, or deactivate the location if it is only historical.";
  }
  if (constraint.includes("inventory_lots")) {
    return "Cannot delete location because inventory lot history references it. Deactivate the location instead.";
  }
  if (constraint.includes("inventory_transactions")) {
    return "Cannot delete location because inventory transaction history references it. Deactivate the location instead.";
  }
  if (constraint.includes("replen")) {
    return "Cannot delete location because replenishment history or tasks reference it. Deactivate the location instead.";
  }
  if (constraint.includes("order")) {
    return "Cannot delete location because order or pick history references it. Deactivate the location instead.";
  }
  return "Cannot delete location because other records still reference it. Deactivate the location instead.";
}

export function registerWarehouseRoutes(app: Express) {
  const binAssignments = createBinAssignmentService(db, storage);

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
      const cutoffError = validateSlaCutoffFields(req.body);
      if (cutoffError) {
        return res.status(400).json({ error: cutoffError });
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
      const cutoffError = validateSlaCutoffFields(req.body);
      if (cutoffError) {
        return res.status(400).json({ error: cutoffError });
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
      const rules = await storage.getAllFulfillmentRoutingRules();
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
      if (!routingMatchTypeEnum.includes(data.matchType as any)) {
        return res.status(400).json({ error: `Invalid matchType. Must be one of: ${routingMatchTypeEnum.join(", ")}` });
      }
      if (data.matchType !== "default" && !data.matchValue) {
        return res.status(400).json({ error: "matchValue is required for non-default rules" });
      }
      const rule = await storage.createFulfillmentRoutingRule(data as any);
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
      const rule = await storage.updateFulfillmentRoutingRule(id, parsed.data as any);
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
      const deleted = await storage.deleteFulfillmentRoutingRule(id);
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
        maxOrdersPerWave: data.maxOrdersPerWave || 50,
        maxItemsPerWave: data.maxItemsPerWave || 500,
        waveAutoRelease: data.waveAutoRelease || 0,
        postPickStatus: data.postPickStatus || "ready_to_ship",
        pickMode: data.pickMode || "single_order",
        requireScanConfirm: data.requireScanConfirm ?? 0,
        pickingBatchSize: data.pickingBatchSize || 20,
        autoReleaseDelayMinutes: data.autoReleaseDelayMinutes || 30,
        enableOrderCombining: data.enableOrderCombining ?? 1,
        channelSyncEnabled: data.channelSyncEnabled ?? 0,
        channelSyncIntervalMinutes: data.channelSyncIntervalMinutes || 15,
        velocityLookbackDays: data.velocityLookbackDays || 14,
        replenQaDailyEnabled: data.replenQaDailyEnabled ?? 1,
        replenQaDailySampleLimit: data.replenQaDailySampleLimit || 2,
        replenQaCooldownDays: data.replenQaCooldownDays ?? 30,
        replenQaIncludePickBins: data.replenQaIncludePickBins ?? 1,
        replenQaIncludePalletLocations: data.replenQaIncludePalletLocations ?? 1,
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

  // ===== SLA ORDER CUTOFF (per warehouse) =====
  // Dedicated endpoint to read/set a warehouse's fulfillment SLA cutoff. The
  // cutoff + timezone live on the warehouse row (warehouse.warehouses) — they
  // describe one building's fulfillment clock. This is a focused alias for
  // setting just those two fields without sending the whole warehouse; the
  // Edit Warehouse form (PATCH /api/warehouses/:id) sets them too. Drives
  // sla_due_at / pick priority (see server/modules/orders/sort-rank.ts).

  app.get("/api/warehouses/:id/sla-cutoff", requirePermission("warehouse", "read"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "warehouse id must be a positive integer" });
      }
      const warehouse = await getWarehouseById(id);
      if (!warehouse) {
        return res.status(404).json({ error: "Warehouse not found" });
      }
      // `effective` applies the null-warehouse → default-warehouse fallback used
      // for unassigned orders; the top-level fields are this warehouse's own.
      const effective = await getSlaCutoffConfig(id);
      res.json({
        warehouseId: id,
        orderCutoffLocal: (warehouse as any).orderCutoffLocal ?? null,
        timezone: (warehouse as any).timezone ?? null,
        effective: { orderCutoffLocal: effective.cutoffLocal, timezone: effective.timezone },
      });
    } catch (error) {
      console.error("Error fetching warehouse SLA cutoff:", error);
      res.status(500).json({ error: "Failed to fetch SLA cutoff" });
    }
  });

  // PUT the cutoff for a warehouse. Body: { orderCutoffLocal, timezone }.
  // Either field may be null (orderCutoffLocal null = no cutoff; timezone null =
  // inherit global default_timezone). Writes directly to the warehouse row.
  app.put("/api/warehouses/:id/sla-cutoff", requirePermission("warehouse", "manage"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "warehouse id must be a positive integer" });
      }
      const cutoffError = validateSlaCutoffFields(req.body);
      if (cutoffError) {
        return res.status(400).json({ error: cutoffError });
      }
      const updates: Record<string, any> = {};
      if ("orderCutoffLocal" in req.body) updates.orderCutoffLocal = req.body.orderCutoffLocal ?? null;
      if ("timezone" in req.body) updates.timezone = req.body.timezone ?? null;

      const saved = await storage.updateWarehouse(id, updates);
      if (!saved) {
        return res.status(404).json({ error: "Warehouse not found" });
      }
      res.json({
        warehouseId: id,
        orderCutoffLocal: (saved as any)?.orderCutoffLocal ?? null,
        timezone: (saved as any)?.timezone ?? null,
      });
    } catch (error) {
      console.error("Error setting warehouse SLA cutoff:", error);
      res.status(500).json({ error: "Failed to set SLA cutoff" });
    }
  });

  // ===== WAREHOUSE LOCATIONS =====

  app.get("/api/warehouse/locations", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const locations = await storage.getAllWarehouseLocations();
      const primarySkuMap = await storage.getSkusByWarehouseLocation();

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

  app.get("/api/warehouse/locations/export/csv", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const locations = await storage.getAllWarehouseLocations();
      
      const csvRows = [
        ["code", "zone", "aisle", "bay", "level", "bin", "name", "location_type", "is_pickable", "width_mm", "height_mm", "depth_mm"].join(",")
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
      const location = await storage.createWarehouseLocation(req.body);
      res.status(201).json(location);
    } catch (error: any) {
      console.error("Error creating warehouse location:", error);
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
        return res.status(409).json({
          error: getLocationDeleteConflictMessage(error),
          canDeactivate: true,
          constraint: error.constraint,
        });
      }
      res.status(500).json({ error: "Failed to delete location" });
    }
  });

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
          const hasInventory = await storage.hasInventoryAtLocation(id);

          if (hasInventory) {
            blocked.push(`Location ${id} has inventory - move or adjust stock first`);
            continue;
          }

          const hasProducts = await storage.hasProductsAssignedToLocation(id);

          if (hasProducts) {
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
      
      const targetLocation = await storage.getWarehouseLocationById(targetLocationId);
      if (!targetLocation) {
        return res.status(404).json({ error: "Target location not found" });
      }
      
      const reassigned = await storage.bulkReassignProducts(
        sourceLocationIds,
        targetLocationId,
        targetLocation.code,
        targetLocation.zone || 'STAGING'
      );
      res.json({ success: true, reassigned });
    } catch (error: any) {
      console.error("Error bulk reassigning products:", error);
      res.status(500).json({ error: error.message || "Failed to reassign products" });
    }
  });

  app.post("/api/warehouse/locations/bulk-import", requirePermission("inventory", "create"), async (req, res) => {
    try {
      const { locations, warehouseId } = req.body;
      if (!Array.isArray(locations) || locations.length === 0) {
        return res.status(400).json({ error: "No locations provided" });
      }
      
      const results = { created: 0, updated: 0, errors: [] as string[] };
      
      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];
        const rowNum = i + 2;
        
        try {
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
          
          const codeParts = [zone, aisle, bay, level, bin].filter(Boolean);
          const code = loc.code?.trim() || codeParts.join("-");
          
          const existingLocations = await storage.getAllWarehouseLocations();
          let existing = existingLocations.find(l =>
            l.code === code &&
            (effectiveWarehouseId == null || l.warehouseId === effectiveWarehouseId)
          );
          if (effectiveWarehouseId == null && existing?.warehouseId != null) {
            effectiveWarehouseId = existing.warehouseId;
          }
          if (effectiveWarehouseId == null) {
            results.errors.push(`Row ${rowNum}: warehouse_id is required for active warehouse locations`);
            continue;
          }
          
          const locationData = {
            zone,
            aisle,
            bay,
            level,
            bin,
            name: loc.name?.trim() || null,
            locationType: (loc.locationType || loc.location_type || existing?.locationType || "pick").trim(),
            isPickable: loc.isPickable !== undefined || loc.is_pickable !== undefined 
              ? parseInt(loc.isPickable ?? loc.is_pickable) 
              : (existing?.isPickable ?? 1),
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
            await storage.updateWarehouseLocation(existing.id, locationData);
            results.updated++;
          } else {
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

  app.get("/api/warehouse/locations/:id/inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseLocationId = parseInt(req.params.id);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }
      
      const inventory = await storage.getLocationInventoryDetail(warehouseLocationId);
      
      res.json(inventory);
    } catch (error: any) {
      console.error("Error fetching inventory for location:", error);
      res.status(500).json({ error: error.message || "Failed to fetch inventory" });
    }
  });

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

  app.post("/api/warehouse/locations/:id/products", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const warehouseLocationId = parseInt(req.params.id);
      if (isNaN(warehouseLocationId)) {
        return res.status(400).json({ error: "Invalid location ID" });
      }

      const { productVariantId, isPrimary } = req.body;
      if (!productVariantId) {
        return res.status(400).json({ error: "productVariantId is required" });
      }

      const warehouseLocation = await storage.getWarehouseLocationById(warehouseLocationId);
      if (!warehouseLocation) {
        return res.status(404).json({ error: "Warehouse location not found" });
      }

      const productLocation = await binAssignments.assignVariantToLocation({
        productVariantId,
        warehouseLocationId,
        isPrimary: isPrimary ?? 1,
      });
      res.status(201).json(productLocation);
    } catch (error: any) {
      console.error("Error assigning product to location:", error);
      const message = error.message || "Failed to assign product";
      const status = /not found/i.test(message)
        ? 404
        : /(cannot assign|not assigned to a warehouse|not a pick face|inactive|required)/i.test(message)
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  // ===== WAREHOUSE INVENTORY SYNC =====

  app.post("/api/warehouses/:id/sync-inventory", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventorySource } = req.app.locals.services;
      const warehouseId = parseInt(req.params.id);
      if (isNaN(warehouseId)) {
        return res.status(400).json({ error: "Invalid warehouse ID" });
      }
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

  // ===== WAREHOUSE FIFO SETTINGS =====
  
  app.get("/api/warehouses/:id/fifo", requirePermission("warehouse", "read"), async (req, res) => {
    try {
      const warehouseId = parseInt(req.params.id);
      if (isNaN(warehouseId)) return res.status(400).json({ error: "Invalid warehouse ID" });
      
      const key = `warehouse_${warehouseId}_fifo_mode`;
      const val = await storage.getSetting(key);
      
      res.json({ enabled: val === 'true' });
    } catch (error) {
      console.error("Error fetching FIFO mode:", error);
      res.status(500).json({ error: "Failed to fetch FIFO mode" });
    }
  });

  app.post("/api/warehouses/:id/fifo", requirePermission("warehouse", "manage"), async (req, res) => {
    try {
      const warehouseId = parseInt(req.params.id);
      if (isNaN(warehouseId)) return res.status(400).json({ error: "Invalid warehouse ID" });
      
      const isEnabled = req.body.enabled === true ? 'true' : 'false';
      const key = `warehouse_${warehouseId}_fifo_mode`;
      
      await storage.upsertSetting(key, isEnabled, "picking");
      res.json({ success: true, enabled: isEnabled === 'true' });
    } catch (error) {
      console.error("Error updating FIFO mode:", error);
      res.status(500).json({ error: "Failed to update FIFO mode" });
    }
  });
}
