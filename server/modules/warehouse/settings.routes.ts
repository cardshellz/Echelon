import type { Express } from "express";
import { z } from "zod";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
const storage = { ...warehouseStorage, ...inventoryStorage };
import { requirePermission, requireAuth } from "../../routes/middleware";

export function registerSettingsRoutes(app: Express) {
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

  // Adjustment Reasons API
  app.get("/api/inventory/adjustment-reasons", requireAuth, async (req, res) => {
    try {
      const reasons = await storage.getActiveAdjustmentReasons();
      res.json(reasons);
    } catch (error) {
      console.error("Error fetching adjustment reasons:", error);
      res.status(500).json({ error: "Failed to fetch adjustment reasons" });
    }
  });

  app.post("/api/inventory/adjustment-reasons", requireAuth, async (req, res) => {
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
  app.post("/api/inventory/adjustment-reasons/seed", requireAuth, async (req, res) => {
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
  // CYCLE COUNTS (Inventory Reconciliation)
  // ============================================

  app.get("/api/cycle-counts", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.getAll());
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error fetching cycle counts:", error);
      res.status(500).json({ error: "Failed to fetch cycle counts" });
    }
  });

  app.get("/api/cycle-counts/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.getById(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error fetching cycle count:", error);
      res.status(500).json({ error: "Failed to fetch cycle count" });
    }
  });

  app.get("/api/cycle-counts/:id/variance-summary", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.getVarianceSummary(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error fetching variance summary:", error);
      res.status(500).json({ error: "Failed to fetch variance summary" });
    }
  });

  // Reconciliation preview — shows real-time variance, transfer suggestions, stale warnings
  app.get("/api/cycle-counts/:id/reconciliation-preview", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.getReconciliationPreview(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error generating reconciliation preview:", error);
      res.status(500).json({ error: "Failed to generate reconciliation preview" });
    }
  });

  app.post("/api/cycle-counts", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      const result = await ccService.create(req.body, req.session.user?.id);
      res.status(201).json(result);
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error creating cycle count:", error);
      res.status(500).json({ error: "Failed to create cycle count" });
    }
  });

  // Quick Count — create + initialize + return in one step for single-bin counts
  app.post("/api/cycle-counts/quick", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      const { locationCode, warehouseId } = req.body;
      if (!locationCode) return res.status(400).json({ error: "locationCode is required" });

      const code = locationCode.trim().toUpperCase();
      const cc = await ccService.create({
        name: `Quick Count — ${code}`,
        description: `Single-bin quick count for ${code}`,
        locationCodes: code,
        warehouseId: warehouseId || undefined,
      }, req.session.user?.id);

      const initialized = await ccService.initialize(cc.id);
      res.status(201).json({ ...initialized, cycleCountId: cc.id });
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error creating quick count:", error);
      res.status(500).json({ error: error.message || "Failed to create quick count" });
    }
  });

  app.post("/api/cycle-counts/:id/initialize", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.initialize(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error initializing cycle count:", error);
      res.status(500).json({ error: "Failed to initialize cycle count" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/count", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
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
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.resetItem(parseInt(req.params.id), parseInt(req.params.itemId)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error resetting count item:", error);
      res.status(500).json({ error: "Failed to reset count item" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/investigate", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
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

  // Resolve variance by recording a transfer (move stock to correct location)
  // Sync cycle count item expected qty from current inventory (after an external transfer)
  app.post("/api/cycle-counts/:id/items/:itemId/sync-expected", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.syncExpectedFromInventory(
        parseInt(req.params.id),
        parseInt(req.params.itemId),
        req.session.user?.id,
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error syncing cycle count expected:", error);
      res.status(500).json({ error: error.message || "Failed to sync expected qty" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/resolve-transfer", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.resolveWithTransfer(
        parseInt(req.params.id),
        parseInt(req.params.itemId),
        {
          destinationLocationId: parseInt(req.body.destinationLocationId),
          qty: parseInt(req.body.qty),
          notes: req.body.notes,
        },
        req.session.user?.id,
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error resolving with transfer:", error);
      res.status(500).json({ error: error.message || "Failed to resolve with transfer" });
    }
  });

  // Resolve variance without inventory adjustment
  app.post("/api/cycle-counts/:id/items/:itemId/resolve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.resolveItem(
        parseInt(req.params.id),
        parseInt(req.params.itemId),
        {
          reasonCode: req.body.reasonCode,
          notes: req.body.notes,
        },
        req.session.user?.id,
      ));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error resolving item:", error);
      res.status(500).json({ error: error.message || "Failed to resolve item" });
    }
  });

  app.post("/api/cycle-counts/:id/add-found-item", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.addFoundItem(parseInt(req.params.id), req.body, req.session.user?.id));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error adding found item:", error);
      res.status(500).json({ error: "Failed to add found item" });
    }
  });

  app.post("/api/cycle-counts/:id/items/:itemId/approve", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
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
      const { cycleCount: ccService } = req.app.locals.services;
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
      const { cycleCount: ccService } = req.app.locals.services;
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
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.complete(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error completing cycle count:", error);
      res.status(500).json({ error: "Failed to complete cycle count" });
    }
  });

  app.delete("/api/cycle-counts/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { cycleCount: ccService } = req.app.locals.services;
      res.json(await ccService.delete(parseInt(req.params.id)));
    } catch (error: any) {
      if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
      console.error("Error deleting cycle count:", error);
      res.status(500).json({ error: "Failed to delete cycle count" });
    }
  });
}
