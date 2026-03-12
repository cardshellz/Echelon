import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { inventoryStorage } from "../inventory";
import { warehouseStorage } from "../warehouse";
import { catalogStorage } from "../catalog";
import { ordersStorage } from "../orders";
import { channelsStorage } from "../channels";
const storage = { ...inventoryStorage, ...warehouseStorage, ...catalogStorage, ...ordersStorage, ...channelsStorage };
import { requirePermission, requireAuth, syncPickQueueForSku, upload } from "../../routes/middleware";
import { insertWarehouseLocationSchema, insertProductSchema, insertProductVariantSchema } from "@shared/schema";
import Papa from "papaparse";

export function registerInventoryRoutes(app: Express) {

  // ============================================
  // INVENTORY ADJUSTMENTS
  // ============================================

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
      const { channelSync: adjSync, replenishment: adjReplen } = req.app.locals.services;
      if (adjSync) {
        adjSync.queueSyncAfterInventoryChange(adjustVariantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-adjust sync failed for variant ${adjustVariantId}:`, err)
        );
      }
      if (adjReplen) {
        adjReplen.checkReplenForLocation(warehouseLocationId).catch((err: any) =>
          console.warn(`[Replen] Post-adjust check failed for loc ${warehouseLocationId}:`, err)
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
        const result = await storage.searchSkusByLocation(locationId, limit);
        return res.json(result);
      }

      if (!query) {
        return res.json([]);
      }

      const searchPattern = `%${query}%`;
      const result = await storage.searchSkusByPattern(searchPattern, limit);
      res.json(result);
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
      const result = await storage.searchSkuLocations(searchPattern);
      res.json(result);
    } catch (error) {
      console.error("Error fetching SKU locations:", error);
      res.status(500).json({ error: "Failed to fetch SKU locations" });
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
      const { channelSync: xfrSync, replenishment: xfrReplen } = req.app.locals.services;
      if (xfrSync) {
        xfrSync.queueSyncAfterInventoryChange(varId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-transfer sync failed for variant ${varId}:`, err)
        );
      }
      // Auto-complete matching replen tasks fulfilled by this transfer (fire-and-forget)
      if (xfrReplen) {
        xfrReplen.completeMatchingTransferTask(fromLocId, toLocId, varId, userId).catch((err: any) =>
          console.warn(`[Replen] Auto-complete matching task failed for variant ${varId}:`, err)
        );
        xfrReplen.checkReplenForLocation(fromLocId).catch((err: any) =>
          console.warn(`[Replen] Post-transfer replen check failed for loc ${fromLocId}:`, err)
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
  
  // SKU Conversion — move inventory from one variant to another across all locations
  // Atomic: adjust-out old variant, adjust-in new variant, with sku_correction audit trail
  app.post("/api/inventory/convert-sku", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventoryCore } = req.app.locals.services;
      const { fromVariantId, toVariantId, locationId, quantity, notes } = req.body;

      if (!fromVariantId || !toVariantId) {
        return res.status(400).json({ error: "fromVariantId and toVariantId are required" });
      }
      const fromVarId = parseInt(String(fromVariantId));
      const toVarId = parseInt(String(toVariantId));
      if (isNaN(fromVarId) || isNaN(toVarId)) {
        return res.status(400).json({ error: "Variant IDs must be valid integers" });
      }
      if (fromVarId === toVarId) {
        return res.status(400).json({ error: "Source and destination variants must be different" });
      }

      const fromVariant = await storage.getProductVariantById(fromVarId);
      const toVariant = await storage.getProductVariantById(toVarId);
      if (!fromVariant) return res.status(404).json({ error: "Source variant not found" });
      if (!toVariant) return res.status(404).json({ error: "Destination variant not found" });

      const userId = req.session.user?.id || "system";
      const batchId = `skuconv-${Date.now()}`;
      const noteText = `SKU conversion: ${fromVariant.sku} → ${toVariant.sku}${notes ? '. ' + notes : ''}`;

      // Find all inventory for the source variant (optionally filtered to one location)
      const locId = locationId ? parseInt(String(locationId)) : undefined;
      const sourceInventory = await storage.getSourceInventoryForConversion(fromVarId, locId) as any[];

      if (sourceInventory.length === 0) {
        return res.status(400).json({ error: "No inventory found for source variant" });
      }

      // If a specific quantity is given, validate it doesn't exceed total available
      const totalAvailable = sourceInventory.reduce((s: number, l: any) => s + l.variant_qty, 0);
      const convertQty = quantity ? parseInt(String(quantity)) : null;
      if (convertQty !== null) {
        if (isNaN(convertQty) || convertQty <= 0) {
          return res.status(400).json({ error: "Quantity must be a positive integer" });
        }
        if (convertQty > totalAvailable) {
          return res.status(400).json({ error: `Requested ${convertQty} but only ${totalAvailable} available` });
        }
      }

      // Execute conversion in a single transaction
      const conversions: { locationCode: string; qty: number }[] = [];
      let remaining = convertQty ?? totalAvailable;

      await db.transaction(async (tx: any) => {
        const svc = (inventoryCore as any).withTx(tx);

        for (const inv of sourceInventory) {
          if (remaining <= 0) break;
          const qtyToConvert = Math.min(inv.variant_qty, remaining);

          // Adjust-out from old variant
          const sourceLevel = await svc.upsertLevel(fromVarId, inv.warehouse_location_id);
          await svc.adjustLevel(sourceLevel.id, { variantQty: -qtyToConvert });
          await svc.logTransaction({
            productVariantId: fromVarId,
            fromLocationId: inv.warehouse_location_id,
            toLocationId: null,
            transactionType: "sku_correction",
            variantQtyDelta: -qtyToConvert,
            variantQtyBefore: sourceLevel.variantQty,
            variantQtyAfter: sourceLevel.variantQty - qtyToConvert,
            sourceState: "on_hand",
            targetState: "on_hand",
            batchId,
            referenceType: "sku_conversion",
            referenceId: `${fromVariant.sku}→${toVariant.sku}`,
            notes: noteText,
            userId,
          });

          // Adjust-in to new variant at same location
          const destLevel = await svc.upsertLevel(toVarId, inv.warehouse_location_id);
          await svc.adjustLevel(destLevel.id, { variantQty: qtyToConvert });
          await svc.logTransaction({
            productVariantId: toVarId,
            fromLocationId: null,
            toLocationId: inv.warehouse_location_id,
            transactionType: "sku_correction",
            variantQtyDelta: qtyToConvert,
            variantQtyBefore: destLevel.variantQty,
            variantQtyAfter: destLevel.variantQty + qtyToConvert,
            sourceState: "on_hand",
            targetState: "on_hand",
            batchId,
            referenceType: "sku_conversion",
            referenceId: `${fromVariant.sku}→${toVariant.sku}`,
            notes: noteText,
            userId,
          });

          // Clean up empty source level
          if (sourceLevel.variantQty - qtyToConvert <= 0) {
            const hasAssignment = await tx.execute(sql`
              SELECT 1 FROM product_locations
              WHERE product_variant_id = ${fromVarId}
                AND warehouse_location_id = ${inv.warehouse_location_id}
              LIMIT 1
            `);
            if (hasAssignment.rows.length === 0) {
              await tx.execute(sql`
                DELETE FROM inventory_levels WHERE id = ${sourceLevel.id}
              `);
            }
          }

          conversions.push({ locationCode: inv.location_code, qty: qtyToConvert });
          remaining -= qtyToConvert;
        }
      });

      const totalConverted = conversions.reduce((s, c) => s + c.qty, 0);

      // Fire channel sync for both variants (fire-and-forget)
      const { channelSync } = req.app.locals.services;
      if (channelSync) {
        channelSync.queueSyncAfterInventoryChange(fromVarId).catch(() => {});
        channelSync.queueSyncAfterInventoryChange(toVarId).catch(() => {});
      }

      res.json({
        success: true,
        fromSku: fromVariant.sku,
        toSku: toVariant.sku,
        totalConverted,
        conversions,
        batchId,
      });
    } catch (error) {
      console.error("SKU conversion error:", error);
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

      const csvAffectedLocations = new Set<number>();
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
          const { inventoryCore: csvCore } = req.app.locals.services;
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
          csvAffectedLocations.add(warehouseLocation.id);
        } catch (err: any) {
          results.push({ row: rowNum, sku, location: locationCode, status: "error", message: err.message || "Database error" });
          errorCount++;
        }
      }

      const { replenishment: csvReplen } = req.app.locals.services;
      if (csvReplen && csvAffectedLocations.size > 0) {
        for (const locId of csvAffectedLocations) {
          csvReplen.checkReplenForLocation(locId).catch((err: any) =>
            console.warn(`[Replen] Post-CSV-upload check failed for loc ${locId}:`, err)
          );
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
      const { channelSync: rcvSync } = req.app.locals.services;
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

      // Check which locations have this variant assigned
      const assignedLocationIdsList = await storage.getAssignedLocationIdsForVariant(variantId);
      const assignedLocationIds = new Set(assignedLocationIdsList);

      const result = levels.map(level => ({
        ...level,
        isAssigned: assignedLocationIds.has(level.warehouseLocationId),
        location: locationMap.get(level.warehouseLocationId)
      }));

      res.json(result);
    } catch (error) {
      console.error("Error getting variant locations:", error);
      res.status(500).json({ error: "Failed to get variant locations" });
    }
  });

  // Delete an orphan inventory_levels row (0 qty, not assigned)
  app.delete("/api/inventory/levels/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

      const level = await storage.getInventoryLevelById(id);
      if (!level) return res.status(404).json({ error: "Inventory level not found" });

      // Safety: only allow deletion of fully empty rows
      if (level.variantQty !== 0 || level.reservedQty !== 0) {
        return res.status(400).json({ error: "Cannot delete — row still has quantity or reservations" });
      }

      // Safety: don't delete if variant is assigned to this location
      const hasAssignment = await storage.hasProductLocationAssignment(level.productVariantId, level.warehouseLocationId);
      if (hasAssignment) {
        return res.status(400).json({ error: "Cannot delete — variant is assigned to this location" });
      }

      await storage.deleteInventoryLevel(id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting inventory level:", error);
      res.status(500).json({ error: error.message || "Failed to delete" });
    }
  });

  // Check backorder status for an item
  app.get("/api/inventory/backorder-status/:itemId", async (req, res) => {
    try {
      const itemId = parseInt(req.params.itemId);
      const { atp: atpSvc } = req.app.locals.services;
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
          const variantQty = levels.reduce((sum: number, l: any) => sum + (l.variantQty || 0), 0);
          const reservedQty = levels.reduce((sum: number, l: any) => sum + (l.reservedQty || 0), 0);
          const pickedQty = levels.reduce((sum: number, l: any) => sum + (l.pickedQty || 0), 0);
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
          products.map(product => (req.app.locals.services).atp.getInventoryItemSummary(product.id))
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
      const { channelSync } = req.app.locals.services;
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
  // BREAK / ASSEMBLY ROUTES
  // ============================================

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

      const { replenishment: breakReplen } = req.app.locals.services;
      if (breakReplen) {
        const targetLocId = result.targetLocationId || targetLocationId || warehouseLocationId;
        breakReplen.checkReplenForLocation(targetLocId).catch((err: any) =>
          console.warn(`[Replen] Post-break check failed for loc ${targetLocId}:`, err)
        );
      }

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

      const { replenishment: asmReplen } = req.app.locals.services;
      if (asmReplen) {
        asmReplen.checkReplenForLocation(warehouseLocationId).catch((err: any) =>
          console.warn(`[Replen] Post-assemble check failed for loc ${warehouseLocationId}:`, err)
        );
      }

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

  // ============================================
  // RETURNS ROUTES
  // ============================================

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

      const { replenishment: retReplen } = req.app.locals.services;
      if (retReplen) {
        retReplen.checkReplenForLocation(warehouseLocationId).catch((err: any) =>
          console.warn(`[Replen] Post-return check failed for loc ${warehouseLocationId}:`, err)
        );
      }

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

      const order = await storage.getOrderByOrderNumber(orderNumber);
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

  // ============================================
  // ORDER RESERVATION ROUTES
  // ============================================

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

  // ============================================
  // CHANNEL SYNC ROUTES
  // ============================================

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

  // Update channel allocation settings (% or fixed qty)
  app.put("/api/channels/:id/allocation", requirePermission("channels", "edit"), async (req, res) => {
    try {
      const channelId = parseInt(req.params.id);
      const { allocationPct, allocationFixedQty } = req.body;

      const updated = await storage.updateChannelAllocation(channelId, allocationPct ?? null, allocationFixedQty ?? null);
      if (!updated) return res.status(404).json({ error: "Channel not found" });

      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to update channel allocation" });
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

  app.post("/api/channel-sync/refresh-enabled", requirePermission("warehouse", "manage"), async (req, res) => {
    try {
      const { channelSync } = req.app.locals.services;
      const enabled = await channelSync.refreshSyncEnabled();
      res.json({ enabled });
    } catch (error: any) {
      res.status(500).json({ error: error.message || "Failed to refresh sync status" });
    }
  });

  // ============================================
  // INVENTORY ALERTS (anomaly detection)
  // ============================================

  app.get("/api/inventory/alerts", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryAlerts } = req.app.locals.services;
      const alerts = await inventoryAlerts.checkAll();
      const critical = alerts.filter((a: any) => a.severity === "critical").length;
      const warning = alerts.filter((a: any) => a.severity === "warning").length;
      res.json({ alerts, summary: { total: alerts.length, critical, warning } });
    } catch (error: any) {
      console.error("Error checking inventory alerts:", error);
      res.status(500).json({ error: error.message || "Failed to check alerts" });
    }
  });

  // ============================================
  // INVENTORY LOTS
  // ============================================

  app.get("/api/inventory/lots", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryLots } = req.app.locals.services;
      const variantId = req.query.variantId ? Number(req.query.variantId) : undefined;
      const locationId = req.query.locationId ? Number(req.query.locationId) : undefined;

      let lots;
      if (variantId && locationId) {
        lots = await inventoryLots.getLotsAtLocation(variantId, locationId);
      } else if (variantId) {
        lots = await inventoryLots.getLotsByVariant(variantId);
      } else {
        lots = await inventoryLots.getActiveLots(500);
      }

      res.json(lots);
    } catch (error: any) {
      console.error("Error fetching inventory lots:", error);
      res.status(500).json({ error: error.message || "Failed to fetch lots" });
    }
  });

  app.get("/api/inventory/lots/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryLots } = req.app.locals.services;
      const lot = await inventoryLots.getLot(Number(req.params.id));
      if (!lot) return res.status(404).json({ error: "Lot not found" });
      res.json(lot);
    } catch (error: any) {
      console.error("Error fetching lot:", error);
      res.status(500).json({ error: error.message || "Failed to fetch lot" });
    }
  });

  app.get("/api/inventory/valuation", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryLots } = req.app.locals.services;
      const valuation = await inventoryLots.getInventoryValuation();
      res.json(valuation);
    } catch (error: any) {
      console.error("Error computing inventory valuation:", error);
      res.status(500).json({ error: error.message || "Failed to compute valuation" });
    }
  });

  app.post("/api/inventory/lots/create-legacy", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventoryLots } = req.app.locals.services;
      const result = await inventoryLots.createLegacyLots();
      res.json({ success: true, ...result });
    } catch (error: any) {
      console.error("Error creating legacy lots:", error);
      res.status(500).json({ error: error.message || "Failed to create legacy lots" });
    }
  });

  // ============================================
  // BOOTSTRAP ROUTES
  // ============================================

  app.post("/api/inventory/bootstrap/dry-run", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const productLocationsData = await storage.getAllProductLocations();
      
      const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
      
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

      for (const pl of productLocationsData) {
        if (!pl.sku) continue;
        const match = pl.sku.match(variantPattern);
        
        if (match) {
          const baseSku = match[1];
          const variantType = match[2].toUpperCase();
          const pieces = parseInt(match[3], 10);
          
          if (!baseSkuMap[baseSku]) {
            let baseName = pl.name || "";
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
            name: pl.name || "",
            location: pl.location || ""
          });
        } else {
          skusWithoutVariant.push({
            sku: pl.sku,
            name: pl.name || "",
            location: pl.location || ""
          });
        }
      }

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
        const sortedVariants = data.variants.sort((a, b) => a.pieces - b.pieces);
        
        const variantsWithHierarchy = sortedVariants.map((v, idx) => {
          let hierarchyLevel = 1;
          if (v.type === 'Box') hierarchyLevel = 2;
          if (v.type === 'Case') hierarchyLevel = 3;
          
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
          totalSkusAnalyzed: productLocationsData.length,
          baseSkusWithVariants: Object.keys(baseSkuMap).length,
          standaloneSkus: skusWithoutVariant.length,
          totalVariantsToCreate: results.reduce((sum, r) => sum + r.variants.length, 0) + standaloneItems.length
        },
        baseSkusWithVariants: results,
        standaloneItems: standaloneItems.slice(0, 20),
        message: "DRY RUN - No data written. Review above and POST to /api/inventory/bootstrap to execute."
      });
    } catch (error) {
      console.error("Error in bootstrap dry run:", error);
      res.status(500).json({ error: "Failed to run bootstrap analysis" });
    }
  });

  app.post("/api/inventory/bootstrap", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user || user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const productLocationsData = await storage.getAllProductLocations();
      
      const variantPattern = /^(.+)-(P|B|C)(\d+)$/i;
      
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

      for (const pl of productLocationsData) {
        if (!pl.sku) continue;
        const match = pl.sku.match(variantPattern);
        
        if (match) {
          const baseSku = match[1];
          const variantType = match[2].toUpperCase();
          const pieces = parseInt(match[3], 10);
          
          if (!baseSkuMap[baseSku]) {
            let baseName = pl.name || "";
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
            name: pl.name || "",
            location: pl.location || "",
            barcode: pl.barcode
          });
        } else {
          skusWithoutVariant.push({
            sku: pl.sku,
            name: pl.name || "",
            location: pl.location || "",
            barcode: pl.barcode
          });
        }
      }

      let productsCreated = 0;
      let variantsCreated = 0;
      let locationsCreated = 0;
      let levelsCreated = 0;
      const errors: string[] = [];

      for (const [baseSku, data] of Object.entries(baseSkuMap)) {
        try {
          let product = await storage.getProductBySku(baseSku);

          if (!product) {
            product = await storage.createProduct({
              sku: baseSku,
              name: data.name,
              baseUnit: 'each',
            });
            productsCreated++;
          }

          const sortedVariants = data.variants.sort((a, b) => a.pieces - b.pieces);
          const createdVariantIds: Record<string, number> = {};

          for (let idx = 0; idx < sortedVariants.length; idx++) {
            const v = sortedVariants[idx];

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

  // ============================================
  // INVENTORY LOCATIONS & CATALOG ROUTES
  // ============================================

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

  app.get("/api/catalog/products", async (req, res) => {
    try {
      const allProducts = await storage.getAllProducts();
      res.json(allProducts);
    } catch (error) {
      console.error("Error fetching catalog products:", error);
      res.status(500).json({ error: "Failed to fetch catalog products" });
    }
  });

  app.get("/api/catalog/products/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim().toLowerCase();
      const limit = parseInt(String(req.query.limit)) || 20;
      if (!query || query.length < 2) return res.json([]);

      const searchPattern = `%${query}%`;

      const result = await storage.searchCatalogProductsWithImage(searchPattern, limit);

      res.json(result.map(r => ({
        id: r.product_id,
        variantId: r.variant_id,
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

  app.get("/api/inventory/items", async (req, res) => {
    try {
      const items = await storage.getAllProducts();
      res.json(items);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  app.get("/api/inventory/items/unassigned", async (req, res) => {
    try {
      const productsData = await storage.getProductsWithoutLocations();
      res.json(productsData);
    } catch (error) {
      console.error("Error fetching unassigned products:", error);
      res.status(500).json({ error: "Failed to fetch unassigned products" });
    }
  });

  app.get("/api/inventory/items/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { atp } = req.app.locals.services;
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

  // ============================================
  // MIGRATE LOCATIONS & SYNC/DEBUG ROUTES
  // ============================================

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

  app.post("/api/sync/trigger", requirePermission("shopify", "sync"), async (req, res) => {
    try {
      const { syncNewOrders } = await import("../orders/order-sync-listener");
      await syncNewOrders();
      res.json({ success: true, message: "Sync triggered - check logs" });
    } catch (error) {
      console.error("Trigger sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });
  
  app.post("/api/debug/trigger-sync", requirePermission("shopify", "sync"), async (req, res) => {
    try {
      const { syncNewOrders } = await import("../orders/order-sync-listener");
      await syncNewOrders();
      res.json({ success: true, message: "Sync triggered - check logs" });
    } catch (error) {
      console.error("Debug trigger sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/sync/health", async (req, res) => {
    try {
      const { getSyncHealth } = await import("../orders/order-sync-listener");
      const health = getSyncHealth();
      
      const row = await storage.getSyncHealthStats() as any;
      const latestShopifyOrder = row?.latest_shopify_order;
      const latestSyncedOrder = row?.latest_synced_order;
      const unsynced24h = parseInt(row?.unsynced_24h || "0");
      
      let syncGapMinutes: number | null = null;
      if (latestShopifyOrder && latestSyncedOrder) {
        const shopifyTime = new Date(latestShopifyOrder).getTime();
        const syncedTime = new Date(latestSyncedOrder).getTime();
        syncGapMinutes = Math.max(0, Math.floor((shopifyTime - syncedTime) / 60000));
      }
      
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

  app.post("/api/sync/send-alert", requirePermission("system", "admin"), async (req, res) => {
    try {
      const { getSyncHealth } = await import("../orders/order-sync-listener");
      const health = getSyncHealth();
      
      const adminEmail = await storage.getSetting("admin_alert_email");
      
      if (!adminEmail) {
        return res.status(400).json({ error: "No admin email configured. Set admin_alert_email in settings." });
      }
      
      const sendgridApiKey = process.env.SENDGRID_API_KEY;
      
      if (sendgridApiKey) {
        console.log("[ALERT] Would send email alert to:", adminEmail);
        res.json({ success: true, message: "Alert sent (SendGrid configured)", recipient: adminEmail });
      } else {
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

  app.get("/api/debug/order-dates/:orderNumber", async (req, res) => {
    try {
      const orderNumber = req.params.orderNumber;
      const row = await storage.getDebugOrderDates(orderNumber);
      if (!row) {
        return res.json({ error: "Order not found" });
      }
      res.json({
        orderNumber: (row as any).order_number,
        orderPlacedAt: (row as any).order_placed_at,
        shopifyCreatedAt: (row as any).shopify_created_at,
        createdAt: (row as any).created_at,
        serverNow: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  app.get("/api/debug/sync-status", async (req, res) => {
    try {
      const debugStatus = await storage.getDebugSyncStatus();

      res.json({
        missingOrdersCount: debugStatus.missingCount,
        sampleMissingOrders: debugStatus.sampleOrders
      });
    } catch (error) {
      console.error("Debug sync error:", error);
      res.status(500).json({ error: String(error) });
    }
  });

  // ============================================
  // INVENTORY LEVELS (variant-centric view)
  // ============================================

  app.get("/api/inventory/levels", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null;
      
      const inventoryRows = await storage.getInventoryLevelsSummary(warehouseId);

      const levels = inventoryRows.map((row: any) => {
        const variantQty = parseInt(row.total_variant_qty) || 0;
        const reservedQty = parseInt(row.total_reserved_qty) || 0;
        const binCount = parseInt(row.bin_count) || 0;
        const hasReplenRule = parseInt(row.has_replen_rule) === 1;
        const hierarchyLevel = row.hierarchy_level || 1;
        const parentVariantId = row.parent_variant_id || null;
        const barcode = row.barcode || null;
        const isBaseUnit = row.is_base_unit === true;

        return {
          variantId: row.variant_id,
          sku: row.variant_sku,
          name: row.variant_name,
          unitsPerVariant: row.units_per_variant || 1,
          parentVariantId,
          hierarchyLevel,
          isBaseUnit,
          baseSku: row.base_sku,
          productId: row.product_id,
          barcode,
          variantQty,
          reservedQty,
          pickedQty: parseInt(row.total_picked_qty) || 0,
          available: 0,
          locationCount: parseInt(row.location_count) || 0,
          pickableQty: parseInt(row.pickable_variant_qty) || 0,
          binCount,
          noBin: variantQty > 0 && binCount === 0,
          noCaseBreak: hierarchyLevel >= 2 && !parentVariantId && !isBaseUnit,
          noBarcode: !barcode,
          noReplen: binCount > 0 && !hasReplenRule,
          overReserved: reservedQty > variantQty,
          negativeQty: variantQty < 0,
        };
      });

      const skuCounts = new Map<string, number>();
      for (const lv of levels) {
        lv.available = lv.variantQty - lv.reservedQty;
        if (lv.sku) {
          const upper = lv.sku.toUpperCase();
          skuCounts.set(upper, (skuCounts.get(upper) || 0) + 1);
        }
      }

      const result = levels.map(lv => ({
        ...lv,
        isDuplicate: lv.sku ? (skuCounts.get(lv.sku.toUpperCase()) || 0) > 1 : false,
      }));

      res.json(result);
    } catch (error) {
      console.error("Error fetching inventory levels:", error);
      res.status(500).json({ error: "Failed to fetch inventory levels" });
    }
  });

  // ============================================
  // BIN-CENTRIC VIEW & INVENTORY MANAGEMENT
  // ============================================

  app.get("/api/inventory/by-bin", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null;
      const search = (req.query.search as string || "").trim();

      const result = { rows: await storage.getInventoryByBin(warehouseId, search || undefined) as any[] };

      const binMap = new Map<number, {
        locationId: number;
        locationCode: string;
        locationType: string;
        zone: string | null;
        isPickable: boolean;
        warehouseId: number | null;
        warehouseCode: string | null;
        assignedSku: string | null;
        items: Array<{
          inventoryLevelId: number;
          variantId: number;
          sku: string | null;
          variantName: string | null;
          productName: string | null;
          variantQty: number;
          reservedQty: number;
          pickedQty: number;
          available: number;
          isAssigned: boolean;
        }>;
        totalQty: number;
        totalReserved: number;
        totalAvailable: number;
        skuCount: number;
        hasUnassigned: boolean;
      }>();

      for (const row of result.rows) {
        const locId = row.warehouse_location_id;
        if (!binMap.has(locId)) {
          binMap.set(locId, {
            locationId: locId,
            locationCode: row.location_code,
            locationType: row.location_type,
            zone: row.zone,
            isPickable: row.is_pickable === 1,
            warehouseId: row.warehouse_id,
            warehouseCode: row.warehouse_code,
            assignedSku: row.assigned_sku,
            items: [],
            totalQty: 0,
            totalReserved: 0,
            totalAvailable: 0,
            skuCount: 0,
            hasUnassigned: false,
          });
        }
        const bin = binMap.get(locId)!;
        const available = row.variant_qty - row.reserved_qty;
        const isAssigned = row.is_assigned === 1;
        bin.items.push({
          inventoryLevelId: row.inventory_level_id,
          variantId: row.product_variant_id,
          sku: row.sku,
          variantName: row.variant_name,
          productName: row.product_name,
          variantQty: row.variant_qty,
          reservedQty: row.reserved_qty,
          pickedQty: row.picked_qty,
          available,
          isAssigned,
        });
        bin.totalQty += row.variant_qty;
        bin.totalReserved += row.reserved_qty;
        bin.totalAvailable += available;
        bin.skuCount++;
        if (!isAssigned) bin.hasUnassigned = true;
      }

      res.json(Array.from(binMap.values()));
    } catch (error) {
      console.error("Error fetching inventory by bin:", error);
      res.status(500).json({ error: "Failed to fetch inventory by bin" });
    }
  });

  app.get("/api/inventory/levels/:variantId/locations", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const variantId = parseInt(req.params.variantId);
      const warehouseId = req.query.warehouseId ? parseInt(req.query.warehouseId as string) : null;

      const resultRows = await storage.getVariantLocationBreakdown(variantId, warehouseId) as any[];

      const locations = resultRows.map((row: any) => ({
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

  app.get("/api/inventory/export", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { locationType, binType, zone } = req.query;
      
      let rows = await storage.getInventoryExport() as any[];
      
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

      const { channelSync: addSync, replenishment: addReplen } = req.app.locals.services;
      if (addSync) {
        addSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-add-stock sync failed for variant ${variantId}:`, err)
        );
      }
      if (addReplen) {
        addReplen.checkReplenForLocation(warehouseLocationId).catch((err: any) =>
          console.warn(`[Replen] Post-add-stock check failed for loc ${warehouseLocationId}:`, err)
        );
      }

      res.json({ success: true, variantQtyAdded: variantQty });
    } catch (error) {
      console.error("Error adding stock:", error);
      res.status(500).json({ error: "Failed to add stock" });
    }
  });

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

      const { channelSync: adjStockSync, replenishment: adjStockReplen } = req.app.locals.services;
      if (adjStockSync) {
        adjStockSync.queueSyncAfterInventoryChange(variantId).catch((err: any) =>
          console.warn(`[ChannelSync] Post-adjust-stock sync failed for variant ${variantId}:`, err)
        );
      }
      if (adjStockReplen) {
        adjStockReplen.checkReplenForLocation(warehouseLocationId).catch((err: any) =>
          console.warn(`[Replen] Post-adjust-stock check failed for loc ${warehouseLocationId}:`, err)
        );
      }

      res.json({ success: true, variantQtyDelta });
    } catch (error) {
      console.error("Error adjusting stock:", error);
      res.status(500).json({ error: "Failed to adjust stock" });
    }
  });

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
      
      const csvResults = {
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
            csvResults.errors.push(`Invalid row: SKU=${sku}, Location=${locationCode}, Qty=${row.quantity}`);
            continue;
          }
          
          const variant = await storage.getProductVariantBySku(sku);

          if (!variant) {
            csvResults.errors.push(`Variant not found: ${sku}`);
            continue;
          }
          
          const location = await storage.getWarehouseLocationByCode(locationCode);
          if (!location) {
            csvResults.errors.push(`Location not found: ${locationCode}`);
            continue;
          }
          
          const existingLevel = await storage.getInventoryLevelByLocationAndVariant(location.id, variant.id);

          if (existingLevel) {
            const currentQty = existingLevel.variantQty || 0;
            const delta = variantQty - currentQty;
            if (delta !== 0) {
              const { inventoryCore: csvAdjCore } = req.app.locals.services;
              await csvAdjCore.adjustInventory({
                productVariantId: variant.id,
                warehouseLocationId: location.id,
                qtyDelta: delta,
                reason: "CSV_UPLOAD",
                userId,
              });
              csvResults.updated++;
            }
          } else {
            await storage.createInventoryLevel({
              productVariantId: variant.id,
              warehouseLocationId: location.id,
              variantQty: variantQty,
              reservedQty: 0,
            });

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
            
            csvResults.created++;
          }
          
          csvResults.processed++;
        } catch (rowError) {
          csvResults.errors.push(`Error processing row: ${JSON.stringify(row)} - ${rowError}`);
        }
      }
      
      res.json(csvResults);
    } catch (error) {
      console.error("Error importing inventory CSV:", error);
      res.status(500).json({ error: "Failed to import CSV" });
    }
  });

  app.get("/api/inventory/import-template", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=inventory_import_template.csv");
    res.send("sku,location_code,quantity\nSKU-001,A-01-01,100\nSKU-002,A-01-02,50");
  });

  // ============================================
  // EXTERNAL INVENTORY SYNC
  // ============================================

  app.post("/api/sync/external-inventory", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { inventorySource } = req.app.locals.services;
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
}
