import type { Express } from "express";
import { procurementStorage } from "../procurement";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
const storage = { ...procurementStorage, ...catalogStorage, ...warehouseStorage, ...inventoryStorage, ...ordersStorage };
import { requirePermission, requireAuth, requireInternalApiKey, upload } from "../../routes/middleware";
import { PurchasingError } from "./purchasing.service";
import { ShipmentTrackingError } from "./shipment-tracking.service";
import * as apLedger from "./ap-ledger.service";
import { renderPoHtml } from "./po-document";
import * as emailService from "../notifications/email.service";
import * as notificationService from "../notifications/notifications.service";

export function registerPurchasingRoutes(app: Express) {
  const { purchasing, shipmentTracking } = app.locals.services;

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
      const { receiving: rcvService } = req.app.locals.services;
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
      const { receiving: rcvService } = req.app.locals.services;
      const result = await rcvService.close(parseInt(req.params.id), req.session.user?.id || null);
      notificationService.notify("po_received", {
        title: `Receiving Complete: ${(result.order as any)?.orderNumber || `#${req.params.id}`}`,
        message: result.unitsReceived ? `${result.unitsReceived} units received` : undefined,
        data: { receivingOrderId: parseInt(req.params.id) },
      }).catch(() => {});
      const { replenishment: rcvReplen } = req.app.locals.services;
      if (rcvReplen && result.putawayLocationIds?.length) {
        for (const locId of result.putawayLocationIds) {
          rcvReplen.checkReplenForLocation(locId).catch((err: any) =>
            console.warn(`[Replen] Post-receiving check failed for loc ${locId}:`, err)
          );
        }
      }
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
      const { receiving: rcvService } = req.app.locals.services;
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
      const { receiving: rcvService } = req.app.locals.services;
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
      const { receiving: rcvService } = req.app.locals.services;
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
      const updates = req.body;
      const tierDefault = await storage.updateReplenTierDefault(id, updates);
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
        const varBySku = new Map(allVariants.filter(v => v.sku).map(v => [v.sku!.toLowerCase(), v]));

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
      const { replenishment } = req.app.locals.services;
      let shouldAutoExecute = !!autoExecute;
      let executionMode = autoExecute ? "inline" : "queue";

      if (autoExecute === undefined && replenishment) {
        // Caller didn't specify — use warehouse settings to decide
        const destLoc = await storage.getWarehouseLocationById(toLocationId);
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
    } catch (error: any) {
      console.error("Error creating replen task:", error);
      res.status(500).json({ error: error.message || "Failed to create replen task" });
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
      const { replenishment } = req.app.locals.services;
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

  // Mark a replen task as done WITHOUT re-moving inventory (manual reconciliation)
  app.post("/api/replen/tasks/:id/mark-done", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { replenishment } = req.app.locals.services;
      const { notes } = req.body || {};
      const result = await replenishment.markTaskDone(id, req.session.user?.id, notes);
      res.json(result);
    } catch (error: any) {
      console.error("Error marking replen task done:", error);
      res.status(400).json({ error: error.message || "Failed to mark task done" });
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

  // ===== OPERATIONS VIEW ENDPOINTS =====

  app.get("/api/operations/bin-inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const { operationsDashboard: ops } = req.app.locals.services;
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
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;

      // Product-level query: aggregate inventory and velocity in base units (pieces)
      // Also fetch the highest-level variant (ordering UOM) for rounding order quantities
      const rawRows = await storage.getReorderAnalysisData(lookbackDays);

      const HIERARCHY_LABELS: Record<number, string> = { 1: "Pack", 2: "Box", 3: "Case", 4: "Skid" };

      const items = rawRows.map((r: any) => {
        const totalOnHand = Number(r.total_pieces);
        const totalReserved = Number(r.total_reserved_pieces);
        const totalOutbound = Number(r.total_outbound_pieces);
        const onOrderPieces = Number(r.on_order_pieces);
        const openPoCount = Number(r.open_po_count);
        const earliestExpectedDate = r.earliest_expected || null;
        const leadTimeDays = Number(r.lead_time_days);
        const safetyStockDays = Number(r.safety_stock_days);
        const available = totalOnHand - totalReserved;
        const avgDailyUsage = lookbackDays > 0 ? totalOutbound / lookbackDays : 0;
        const daysOfSupply = avgDailyUsage > 0 ? Math.round(available / avgDailyUsage) : available > 0 ? 9999 : 0;
        const reorderPoint = Math.ceil((leadTimeDays + safetyStockDays) * avgDailyUsage);

        // Effective supply = available (unreserved) + on order
        const effectiveSupply = available + onOrderPieces;
        const rawOrderQtyPieces = Math.max(0, reorderPoint - effectiveSupply);

        // Round up to ordering UOM (highest hierarchy variant)
        const orderUomUnits = Number(r.order_uom_units) || 1;
        const orderUomLevel = Number(r.order_uom_level) || 0;
        const orderUomLabel = HIERARCHY_LABELS[orderUomLevel] || (orderUomUnits > 1 ? `${orderUomUnits}pk` : "pcs");
        const suggestedOrderQty = orderUomUnits > 1
          ? Math.ceil(rawOrderQtyPieces / orderUomUnits) // in ordering units (cases, boxes, etc.)
          : Math.ceil(rawOrderQtyPieces); // fallback: pieces
        const suggestedOrderPieces = suggestedOrderQty * orderUomUnits;

        // On-order qty in ordering UOM
        const onOrderQty = orderUomUnits > 1
          ? Math.floor(onOrderPieces / orderUomUnits)
          : onOrderPieces;

        let status: string;
        // Stockout = no available pieces regardless of velocity
        if (available <= 0) {
          status = "stockout";
        } else if (avgDailyUsage === 0) {
          status = "no_movement";
        } else if (available <= reorderPoint && onOrderPieces > 0 && effectiveSupply >= reorderPoint) {
          // Below reorder point but on-order covers the gap
          status = "on_order";
        } else if (available <= reorderPoint) {
          status = "order_now";
        } else if (daysOfSupply <= leadTimeDays * 1.5) {
          status = "order_soon";
        } else {
          status = "ok";
        }

        return {
          productId: r.product_id,
          productVariantId: r.variant_id ? Number(r.variant_id) : undefined,
          sku: r.base_sku || r.product_name,
          productName: r.product_name,
          variantCount: Number(r.variant_count || 0),
          totalOnHand,
          totalReserved,
          available,
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
          onOrderQty,
          onOrderPieces,
          openPoCount,
          earliestExpectedDate,
          status,
          lastReceivedAt: r.last_received_at,
        };
      });

      const summary = {
        totalProducts: items.length,
        outOfStock: items.filter((i) => i.status === "stockout").length,
        belowReorderPoint: items.filter((i) => i.status === "order_now").length,
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
      await storage.updateVelocityLookbackDays(days);
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

      const results = await storage.getOrdersWithShipments(since);

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

      const results = await storage.getShipmentsByOrderIds(orderIds);

      res.json({
        shipments: results.map((s: any) => ({
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

  // ==========================================================================
  // PURCHASING — Purchase Orders, Vendor Products, Approval Tiers
  // ==========================================================================

  // ── PO CRUD ────────────────────────────────────────────────────────

  app.get("/api/purchase-orders", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      // Support ?status=sent&status=acknowledged or ?status=sent,acknowledged
      let statusFilter: string | string[] | undefined;
      if (req.query.status) {
        const raw = Array.isArray(req.query.status) ? req.query.status as string[] : (req.query.status as string).split(",");
        statusFilter = raw.length === 1 ? raw[0] : raw;
      }
      const filters = {
        status: statusFilter,
        vendorId: req.query.vendorId ? Number(req.query.vendorId) : undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit ? Number(req.query.limit) : 50,
        offset: req.query.offset ? Number(req.query.offset) : 0,
      };
      const [pos, count, allVendors] = await Promise.all([
        purchasing.getPurchaseOrders(filters),
        purchasing.getPurchaseOrdersCount(filters),
        storage.getAllVendors(),
      ]);
      const vendorMap = new Map(allVendors.map((v: any) => [v.id, v]));
      const enriched = pos.map((po: any) => ({
        ...po,
        vendor: vendorMap.get(po.vendorId) || null,
      }));
      res.json({ purchaseOrders: enriched, total: count });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const po = await purchasing.getPurchaseOrderById(Number(req.params.id));
      if (!po) return res.status(404).json({ error: "Purchase order not found" });

      const [lines, vendor] = await Promise.all([
        purchasing.getPurchaseOrderLines(po.id),
        storage.getVendorById(po.vendorId),
      ]);
      res.json({ ...po, lines, vendor });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const po = await purchasing.createPO({
        ...req.body,
        expectedDeliveryDate: req.body.expectedDeliveryDate ? new Date(req.body.expectedDeliveryDate) : undefined,
        createdBy: req.session.user?.id,
      });
      res.status(201).json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchase-orders/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const updates = { ...req.body };
      if (updates.expectedDeliveryDate) updates.expectedDeliveryDate = new Date(updates.expectedDeliveryDate);
      if (updates.confirmedDeliveryDate) updates.confirmedDeliveryDate = new Date(updates.confirmedDeliveryDate);
      if (updates.cancelDate) updates.cancelDate = new Date(updates.cancelDate);
      const po = await purchasing.updatePO(Number(req.params.id), updates, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Update incoterms and/or header charges (discount in draft only; shipping/tax any non-cancelled status)
  app.patch("/api/purchase-orders/:id/incoterms-charges", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { incoterms, discountCents, taxCents, shippingCostCents } = req.body;
      const po = await purchasing.updateIncotermsAndCharges(
        Number(req.params.id),
        { incoterms, discountCents, taxCents, shippingCostCents },
        req.session.user?.id,
      );
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchase-orders/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await purchasing.deletePO(Number(req.params.id));
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── PO Lines ───────────────────────────────────────────────────────

  app.get("/api/purchase-orders/:id/lines", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const lines = await purchasing.getPurchaseOrderLines(Number(req.params.id));
      res.json({ lines });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/lines", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await purchasing.addLine(Number(req.params.id), req.body, req.session.user?.id);
      res.status(201).json(line);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/lines/bulk", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lines = await purchasing.addBulkLines(Number(req.params.id), req.body.lines, req.session.user?.id);
      res.status(201).json({ lines });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchase-orders/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await purchasing.updateLine(Number(req.params.lineId), req.body, req.session.user?.id);
      res.json(line);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchase-orders/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await purchasing.deleteLine(Number(req.params.lineId), req.session.user?.id);
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── Status Transitions ─────────────────────────────────────────────

  app.post("/api/purchase-orders/:id/submit", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const po = await purchasing.submit(Number(req.params.id), req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/return-to-draft", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const po = await purchasing.returnToDraft(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/approve", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const po = await purchasing.approve(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/send", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const po = await purchasing.send(Number(req.params.id), req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // Combined send-to-vendor: draft → approved → sent in one click (solo mode only)
  app.post("/api/purchase-orders/:id/send-to-vendor", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const po = await purchasing.sendToVendor(Number(req.params.id), req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/acknowledge", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const data = {
        ...req.body,
        confirmedDeliveryDate: req.body.confirmedDeliveryDate ? new Date(req.body.confirmedDeliveryDate) : undefined,
      };
      const po = await purchasing.acknowledge(Number(req.params.id), data, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/cancel", requirePermission("purchasing", "cancel"), async (req, res) => {
    try {
      const po = await purchasing.cancel(Number(req.params.id), req.body.reason, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/void", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const po = await purchasing.cancel(Number(req.params.id), req.body.reason, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/close", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const po = await purchasing.close(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/close-short", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const po = await purchasing.closeShort(Number(req.params.id), req.body.reason, req.session.user?.id);
      res.json(po);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── PO ↔ Receiving ─────────────────────────────────────────────────

  app.post("/api/purchase-orders/:id/create-receipt", requirePermission("inventory", "receive"), async (req, res) => {
    try {
      const ro = await purchasing.createReceiptFromPO(Number(req.params.id), req.session.user?.id);
      res.status(201).json(ro);
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/receipts", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const receipts = await purchasing.getPoReceipts(Number(req.params.id));
      res.json({ receipts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/history", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const history = await purchasing.getPoStatusHistory(Number(req.params.id));
      res.json({ history });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/revisions", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const revisions = await purchasing.getPoRevisions(Number(req.params.id));
      res.json({ revisions });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/purchase-orders/:id/document", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const poId = Number(req.params.id);
      const po = await purchasing.getPurchaseOrderById(poId);
      if (!po) return res.status(404).json({ error: "PO not found" });

      const [lines, vendor, settings] = await Promise.all([
        purchasing.getPurchaseOrderLines(poId),
        storage.getVendorById(po.vendorId),
        storage.getAllSettings(),
      ]);

      const html = renderPoHtml({
        po,
        lines,
        vendor,
        companyName: settings.company_name ?? undefined,
        companyAddress: settings.company_address ?? undefined,
        companyCity: settings.company_city ?? undefined,
        companyState: settings.company_state ?? undefined,
        companyPostalCode: settings.company_postal_code ?? undefined,
        companyCountry: settings.company_country ?? undefined,
      });

      res.json({ html });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchase-orders/:id/send-email", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      if (!emailService.isSmtpConfigured()) {
        return res.status(503).json({
          error: "Email is not configured. Add SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM to your .env file.",
        });
      }
      const { toEmail, ccEmail, message } = req.body;
      if (!toEmail) return res.status(400).json({ error: "toEmail is required" });

      const poId = Number(req.params.id);
      await emailService.sendPurchaseOrder({ poId, toEmail, ccEmail, message });

      // Record in PO history
      await storage.createPoStatusHistory({
        purchaseOrderId: poId,
        fromStatus: null,
        toStatus: "email_sent",
        changedBy: (req as any).user?.id ?? null,
        notes: `Email sent to ${toEmail}${ccEmail ? `, cc: ${ccEmail}` : ""}`,
      });

      res.json({ ok: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Vendor Products ────────────────────────────────────────────────

  app.get("/api/vendor-products", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const filters = {
        vendorId: req.query.vendorId ? Number(req.query.vendorId) : undefined,
        productId: req.query.productId ? Number(req.query.productId) : undefined,
        productVariantId: req.query.productVariantId ? Number(req.query.productVariantId) : undefined,
        isActive: req.query.isActive !== undefined ? Number(req.query.isActive) : undefined,
      };
      const vendorProducts = await purchasing.getVendorProducts(filters);
      res.json({ vendorProducts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/vendor-products", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const vp = await purchasing.createVendorProduct(req.body);
      res.status(201).json(vp);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Upsert: create or update vendor catalog entry by (vendorId, productId, productVariantId)
  app.post("/api/vendor-products/upsert", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendorId, productId, productVariantId, vendorSku, unitCostCents, packSize, isPreferred } = req.body;
      if (!vendorId || !productId || !productVariantId) {
        return res.status(400).json({ error: "vendorId, productId, and productVariantId are required" });
      }
      const existing = await purchasing.getVendorProducts({ vendorId, productId, productVariantId });
      let vp;
      if (existing.length > 0) {
        vp = await purchasing.updateVendorProduct(existing[0].id, {
          vendorSku: vendorSku || existing[0].vendorSku,
          unitCostCents: unitCostCents ?? existing[0].unitCostCents,
          packSize: packSize ?? existing[0].packSize,
          isPreferred: isPreferred ? 1 : existing[0].isPreferred,
        });
      } else {
        vp = await purchasing.createVendorProduct({
          vendorId,
          productId,
          productVariantId,
          vendorSku,
          unitCostCents: unitCostCents ?? 0,
          packSize: packSize ?? 1,
          isPreferred: isPreferred ? 1 : 0,
          isActive: 1,
        });
      }
      res.json({ vp, created: existing.length === 0 });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/vendor-products/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const vp = await purchasing.updateVendorProduct(Number(req.params.id), req.body);
      if (!vp) return res.status(404).json({ error: "Vendor product not found" });
      res.json(vp);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/vendor-products/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const deleted = await purchasing.deleteVendorProduct(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Vendor product not found" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/products/:id/vendors", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorProducts = await purchasing.getVendorProducts({ productId: Number(req.params.id) });
      res.json(vendorProducts);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/vendors/:id/products", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const vendorProducts = await purchasing.getVendorProducts({ vendorId: Number(req.params.id) });
      res.json({ vendorProducts });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Approval Tiers ─────────────────────────────────────────────────

  app.get("/api/purchasing/approval-tiers", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const tiers = await purchasing.getApprovalTiers();
      res.json({ tiers });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purchasing/approval-tiers", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const tier = await purchasing.createApprovalTier(req.body);
      res.status(201).json(tier);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/purchasing/approval-tiers/:id", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const tier = await purchasing.updateApprovalTier(Number(req.params.id), req.body);
      if (!tier) return res.status(404).json({ error: "Approval tier not found" });
      res.json(tier);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/purchasing/approval-tiers/:id", requirePermission("settings", "edit"), async (req, res) => {
    try {
      const deleted = await purchasing.deleteApprovalTier(Number(req.params.id));
      if (!deleted) return res.status(404).json({ error: "Approval tier not found" });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Reorder → PO ──────────────────────────────────────────────────

  app.post("/api/purchasing/create-po-from-reorder", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const pos = await purchasing.createPOFromReorder(req.body.items, req.session.user?.id);
      res.status(201).json({ purchaseOrders: pos });
    } catch (error: any) {
      if (error instanceof PurchasingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════
  // FINANCIAL REPORTING ENDPOINTS
  // ════════════════════════════════════════════════════════════════════

  // --- Order Profitability ---
  app.get("/api/reports/order-profitability", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      const rows = await storage.getOrderProfitabilityReport(limit, offset);

      res.json({ orders: rows });
    } catch (error: any) {
      console.error("Error fetching order profitability:", error);
      res.status(500).json({ error: error.message || "Failed to fetch order profitability" });
    }
  });

  // --- Product Profitability ---
  app.get("/api/reports/product-profitability", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      const rows = await storage.getProductProfitabilityReport(limit, offset);

      res.json({ products: rows });
    } catch (error: any) {
      console.error("Error fetching product profitability:", error);
      res.status(500).json({ error: error.message || "Failed to fetch product profitability" });
    }
  });

  // --- Inventory Valuation (via lot service) ---
  app.get("/api/reports/inventory-valuation", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const { inventoryLots } = req.app.locals.services;
      const valuation = await inventoryLots.getInventoryValuation();
      res.json(valuation);
    } catch (error: any) {
      console.error("Error computing inventory valuation:", error);
      res.status(500).json({ error: error.message || "Failed to compute inventory valuation" });
    }
  });

  // --- Vendor Spend ---
  app.get("/api/reports/vendor-spend", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const rows = await storage.getVendorSpendReport();

      res.json({ vendors: rows });
    } catch (error: any) {
      console.error("Error fetching vendor spend:", error);
      res.status(500).json({ error: error.message || "Failed to fetch vendor spend" });
    }
  });

  // --- Cost Variance (PO cost vs actual receipt cost) ---
  app.get("/api/reports/cost-variance", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const rows = await storage.getCostVarianceReport();

      res.json({ variances: rows });
    } catch (error: any) {
      console.error("Error fetching cost variance:", error);
      res.status(500).json({ error: error.message || "Failed to fetch cost variance" });
    }
  });

  // --- Open PO Summary ---
  app.get("/api/reports/open-po-summary", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const rows = await storage.getOpenPoSummaryReport();

      const total = (rows as any[]).reduce(
        (acc: any, r: any) => ({
          poCount: acc.poCount + Number(r.po_count),
          valueCents: acc.valueCents + Number(r.total_value_cents || 0),
        }),
        { poCount: 0, valueCents: 0 },
      );

      res.json({ byStatus: rows, total });
    } catch (error: any) {
      console.error("Error fetching open PO summary:", error);
      res.status(500).json({ error: error.message || "Failed to fetch open PO summary" });
    }
  });

  // --- PO Aging ---
  app.get("/api/reports/po-aging", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const rows = await storage.getPoAgingReport();

      res.json({ orders: rows });
    } catch (error: any) {
      console.error("Error fetching PO aging:", error);
      res.status(500).json({ error: error.message || "Failed to fetch PO aging" });
    }
  });

  // --- Expected Receipts ---
  app.get("/api/reports/expected-receipts", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const rows = await storage.getExpectedReceiptsReport();

      res.json({ receipts: rows });
    } catch (error: any) {
      console.error("Error fetching expected receipts:", error);
      res.status(500).json({ error: error.message || "Failed to fetch expected receipts" });
    }
  });

  // ==========================================================================
  // INBOUND SHIPMENTS — Tracking, Costs, Landed Cost Allocation
  // ==========================================================================

  // ── Shipment CRUD ──

  app.get("/api/inbound-shipments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const filters: any = {};
      if (req.query.status) filters.status = (req.query.status as string).includes(",") ? (req.query.status as string).split(",") : req.query.status;
      if (req.query.mode) filters.mode = req.query.mode;
      if (req.query.search) filters.search = req.query.search;
      if (req.query.warehouseId) filters.warehouseId = Number(req.query.warehouseId);
      if (req.query.limit) filters.limit = Number(req.query.limit);
      if (req.query.offset) filters.offset = Number(req.query.offset);

      const [shipmentsList, total] = await Promise.all([
        shipmentTracking.getShipments(filters),
        shipmentTracking.getShipmentsCount(filters),
      ]);
      res.json({ shipments: shipmentsList, total });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.getShipment(Number(req.params.id));
      const [lines, costs, history, paymentStatus] = await Promise.all([
        shipmentTracking.getEnrichedLines(shipment.id),
        shipmentTracking.getCosts(shipment.id),
        shipmentTracking.getStatusHistory(shipment.id),
        apLedger.getShipmentCostPaymentStatus(shipment.id),
      ]);
      res.json({ ...shipment, lines, costs, statusHistory: history, paymentStatus });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.createShipment(req.body, req.session.user?.id);
      res.status(201).json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/inbound-shipments/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.updateShipment(Number(req.params.id), req.body);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/inbound-shipments/:id", requirePermission("purchasing", "delete"), async (req, res) => {
    try {
      await shipmentTracking.deleteShipment(Number(req.params.id));
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── Status Transitions ──

  app.post("/api/inbound-shipments/:id/book", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.book(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/in-transit", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markInTransit(Number(req.params.id), req.session.user?.id, req.body.notes, req.body.shipDate ? new Date(req.body.shipDate) : undefined);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/at-port", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markAtPort(Number(req.params.id), req.session.user?.id, req.body.notes, req.body.actualArrival ? new Date(req.body.actualArrival) : undefined);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/customs-clearance", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markCustomsClearance(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/delivered", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.markDelivered(Number(req.params.id), req.session.user?.id, req.body.notes, req.body.deliveredDate ? new Date(req.body.deliveredDate) : undefined);
      if (shipment) {
        notificationService.notify("shipment_arrived", {
          title: `Shipment Delivered: ${shipment.shipmentNumber || `#${shipment.id}`}`,
          message: shipment.shipperName ? `From ${shipment.shipperName}` : undefined,
          data: { shipmentId: shipment.id },
        }).catch(() => {});
      }
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/start-costing", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.startCosting(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/close", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.close(Number(req.params.id), req.session.user?.id, req.body.notes);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/cancel", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const shipment = await shipmentTracking.cancel(Number(req.params.id), req.session.user?.id, req.body.reason);
      res.json(shipment);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── Shipment Lines ──

  app.post("/api/inbound-shipments/:id/lines/from-po", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lines = await shipmentTracking.addLinesFromPO(Number(req.params.id), req.body.purchaseOrderId, req.body.lineIds);
      res.status(201).json(lines);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/lines/import-packing-list", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const result = await shipmentTracking.importPackingList(Number(req.params.id), req.body.rows);
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/lines/resolve-dimensions", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const result = await shipmentTracking.resolveDimensionsForShipment(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/inbound-shipments/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await shipmentTracking.updateLineDimensions(Number(req.params.lineId), req.body);
      res.json(line);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/inbound-shipments/lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await shipmentTracking.removeLine(Number(req.params.lineId));
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── Shipment Costs ──

  app.get("/api/inbound-shipments/:id/costs", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const costs = await shipmentTracking.getCosts(Number(req.params.id));
      res.json(costs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/costs", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const cost = await shipmentTracking.addCost(Number(req.params.id), req.body);
      res.status(201).json(cost);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/inbound-shipments/costs/:costId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const cost = await shipmentTracking.updateCost(Number(req.params.costId), req.body);
      res.json(cost);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/inbound-shipments/costs/:costId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await shipmentTracking.removeCost(Number(req.params.costId));
      res.json({ success: true });
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── Shipment Cost → AP Bridge ──

  app.post("/api/inbound-shipments/:id/create-invoice", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendorId, invoiceNumber, invoiceDate } = req.body;
      if (!vendorId) return res.status(400).json({ error: "vendorId is required" });
      const invoice = await apLedger.createInvoiceFromShipmentCosts(
        Number(req.params.id),
        {
          vendorId,
          invoiceNumber,
          invoiceDate: invoiceDate ? new Date(invoiceDate) : undefined,
        }
      );
      res.json(invoice);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/inbound-shipments/:id/payment-status", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const status = await apLedger.getShipmentCostPaymentStatus(Number(req.params.id));
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/costs/:costId/link-invoice", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { vendorInvoiceId } = req.body;
      if (!vendorInvoiceId) return res.status(400).json({ error: "vendorInvoiceId required" });
      const result = await apLedger.linkCostToInvoice(Number(req.params.costId), vendorInvoiceId);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/costs/:costId/unlink-invoice", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await apLedger.unlinkCostFromInvoice(Number(req.params.costId));
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ── Allocation ──

  app.post("/api/inbound-shipments/:id/allocate", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const result = await shipmentTracking.runAllocation(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/finalize", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const result = await shipmentTracking.finalizeAllocations(Number(req.params.id), req.session.user?.id);
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ── Cross-references ──

  app.get("/api/purchase-orders/:id/shipments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const shipmentsList = await shipmentTracking.getShipmentsByPo(Number(req.params.id));
      res.json(shipmentsList);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/inbound-shipments/:id/push-costs-to-lots", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const result = await shipmentTracking.pushLandedCostsToLots(Number(req.params.id));
      res.json(result);
    } catch (error: any) {
      if (error instanceof ShipmentTrackingError) return res.status(error.statusCode).json({ error: error.message });
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // AP LEDGER — VENDOR INVOICES
  // ============================================================

  app.get("/api/vendor-invoices", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const { vendorId, status, overdue, dueBefore, limit, offset } = req.query;
      const invoices = await apLedger.listInvoices({
        vendorId: vendorId ? Number(vendorId) : undefined,
        status: status ? (Array.isArray(status) ? status as string[] : (status as string).split(",")) : undefined,
        overdue: overdue === "true",
        dueBefore: dueBefore ? new Date(dueBefore as string) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json({ invoices });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoices/next-number", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const invoiceNumber = await apLedger.generateInvoiceNumber();
      res.json({ invoiceNumber });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices", requirePermission("purchasing", "create"), async (req, res) => {
    try {
      const body = req.body;
      if (!body.vendorId || !body.invoiceNumber) {
        return res.status(400).json({ error: "vendorId and invoiceNumber are required" });
      }
      const invoice = await apLedger.createInvoice({
        ...body,
        invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : undefined,
        dueDate: body.dueDate ? new Date(body.dueDate) : undefined,
        createdBy: (req as any).user?.id,
      });
      res.status(201).json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoices/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const invoice = await apLedger.getInvoiceById(Number(req.params.id));
      if (!invoice) return res.status(404).json({ error: "Invoice not found" });
      res.json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/vendor-invoices/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const invoice = await apLedger.updateInvoice(Number(req.params.id), {
        ...req.body,
        invoiceDate: req.body.invoiceDate ? new Date(req.body.invoiceDate) : undefined,
        dueDate: req.body.dueDate ? new Date(req.body.dueDate) : undefined,
        updatedBy: (req as any).user?.id,
      });
      res.json(invoice);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/approve", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const invoice = await apLedger.approveInvoice(Number(req.params.id), (req as any).user?.id);
      res.json(invoice);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/dispute", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return res.status(400).json({ error: "reason is required" });
      const invoice = await apLedger.disputeInvoice(Number(req.params.id), reason, (req as any).user?.id);
      res.json(invoice);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/void", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return res.status(400).json({ error: "reason is required" });
      const invoice = await apLedger.voidInvoice(Number(req.params.id), reason, (req as any).user?.id);
      res.json(invoice);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/po-links", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { purchaseOrderId, allocatedAmountCents, notes } = req.body;
      if (!purchaseOrderId) return res.status(400).json({ error: "purchaseOrderId is required" });
      const link = await apLedger.linkPoToInvoice(Number(req.params.id), purchaseOrderId, allocatedAmountCents, notes);
      res.status(201).json(link);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/vendor-invoices/:id/po-links/:poId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await apLedger.unlinkPoFromInvoice(Number(req.params.id), Number(req.params.poId));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/purchase-orders/:id/invoices", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const invoices = await apLedger.getInvoicesForPo(Number(req.params.id));
      res.json({ invoices });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Invoice Lines ──

  app.post("/api/vendor-invoices/:id/lines/from-po", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const { purchaseOrderId } = req.body;
      if (!purchaseOrderId) return res.status(400).json({ error: "purchaseOrderId is required" });
      const lines = await apLedger.importLinesFromPO(Number(req.params.id), purchaseOrderId);
      res.status(201).json({ lines });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/lines", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await apLedger.addInvoiceLine(Number(req.params.id), req.body);
      res.status(201).json(line);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/vendor-invoice-lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await apLedger.updateInvoiceLine(Number(req.params.lineId), req.body);
      res.json(line);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/vendor-invoice-lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      await apLedger.removeInvoiceLine(Number(req.params.lineId));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/vendor-invoices/:id/match", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const lines = await apLedger.runInvoiceMatch(Number(req.params.id));
      res.json({ lines });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Invoice Attachments ──

  app.post("/api/vendor-invoices/:id/attachments", requirePermission("purchasing", "edit"), upload.single("file"), async (req, res) => {
    try {
      const invoiceId = Number(req.params.id);
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      // Store to disk: uploads/invoices/{invoiceId}/
      const fs = await import("fs");
      const path = await import("path");
      const dir = path.join("uploads", "invoices", String(invoiceId));
      fs.mkdirSync(dir, { recursive: true });

      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = path.join(dir, `${Date.now()}_${safeName}`);
      fs.writeFileSync(filePath, file.buffer);

      const attachment = await apLedger.addAttachment(invoiceId, {
        fileName: file.originalname,
        fileType: file.mimetype,
        fileSizeBytes: file.size,
        filePath,
        uploadedBy: (req as any).user?.id,
        notes: req.body.notes,
      });
      res.status(201).json(attachment);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoices/:id/attachments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const attachments = await apLedger.getAttachments(Number(req.params.id));
      res.json({ attachments });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/vendor-invoice-attachments/:id/download", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const attachment = await apLedger.getAttachmentById(Number(req.params.id));
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });

      const fs = await import("fs");
      if (!fs.existsSync(attachment.filePath)) return res.status(404).json({ error: "File not found on disk" });

      res.download(attachment.filePath, attachment.fileName);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/vendor-invoice-attachments/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const attachment = await apLedger.getAttachmentById(Number(req.params.id));
      if (attachment) {
        const fs = await import("fs");
        try { fs.unlinkSync(attachment.filePath); } catch {}
      }
      await apLedger.removeAttachment(Number(req.params.id));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // AP LEDGER — PAYMENTS
  // ============================================================

  app.get("/api/ap-payments", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const { vendorId, status, paymentMethod, dateFrom, dateTo, limit, offset } = req.query;
      const rows = await apLedger.listPayments({
        vendorId: vendorId ? Number(vendorId) : undefined,
        status: status ? (Array.isArray(status) ? status as string[] : (status as string).split(",")) : undefined,
        paymentMethod: paymentMethod as string | undefined,
        dateFrom: dateFrom ? new Date(dateFrom as string) : undefined,
        dateTo: dateTo ? new Date(dateTo as string) : undefined,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      res.json({ payments: rows.map(r => ({ ...r.payment, vendorName: r.vendorName, vendorCode: r.vendorCode })) });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ap-payments", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const body = req.body;
      if (!body.vendorId || !body.paymentDate || !body.paymentMethod || body.totalAmountCents == null) {
        return res.status(400).json({ error: "vendorId, paymentDate, paymentMethod, and totalAmountCents are required" });
      }
      const payment = await apLedger.recordPayment({
        ...body,
        paymentDate: new Date(body.paymentDate),
        allocations: body.allocations ?? [],
        createdBy: (req as any).user?.id,
      });
      res.status(201).json(payment);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/ap-payments/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const payment = await apLedger.getPaymentById(Number(req.params.id));
      if (!payment) return res.status(404).json({ error: "Payment not found" });
      res.json(payment);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/ap-payments/:id/void", requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const { reason } = req.body;
      if (!reason) return res.status(400).json({ error: "reason is required" });
      await apLedger.voidPayment(Number(req.params.id), reason, (req as any).user?.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ============================================================
  // AP LEDGER — SUMMARY / AGING
  // ============================================================

  app.get("/api/ap/summary", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const summary = await apLedger.getApSummary();
      res.json(summary);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // NOTIFICATIONS
  // ============================================================

  // Get notifications for the current user
  app.get("/api/notifications", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      const unreadOnly = req.query.unreadOnly === "true";
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const rows = await notificationService.getUserNotifications(userId, { unreadOnly, limit, offset });
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get unread count (for badge)
  app.get("/api/notifications/unread-count", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      const count = await notificationService.getUnreadCount(userId);
      res.json({ count });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark single notification as read
  app.post("/api/notifications/:id/read", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      await notificationService.markRead(parseInt(req.params.id), userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark all notifications as read
  app.post("/api/notifications/read-all", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      await notificationService.markAllRead(userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get notification preferences for the current user
  app.get("/api/notification-preferences", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      const prefs = await notificationService.getPreferencesForUser(userId);
      res.json(prefs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Set a user-specific notification preference
  app.put("/api/notification-preferences/:typeId", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      const typeId = parseInt(req.params.typeId);
      const { enabled } = req.body;
      if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) is required" });
      }
      await notificationService.setUserPreference(userId, typeId, enabled);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Reset user's notification preferences to role defaults
  app.delete("/api/notification-preferences", requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user?.id ?? req.session.user!.id;
      await notificationService.resetUserPreferences(userId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List all notification types (admin only, for settings)
  app.get("/api/notification-types", requirePermission("settings", "view"), async (req, res) => {
    try {
      const types = await notificationService.getAllNotificationTypes();
      res.json(types);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===== PURCHASING DASHBOARD ROUTES =====

  // GET /api/purchasing/dashboard
  app.get("/api/purchasing/dashboard", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const configuredLookback = await storage.getVelocityLookbackDays();
      const lookbackDays = parseInt(req.query.lookbackDays as string) || configuredLookback;
      const data = await storage.getDashboardData(lookbackDays);
      res.json(data);
    } catch (error) {
      console.error("Error fetching purchasing dashboard:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // GET /api/purchasing/exclusion-rules
  app.get("/api/purchasing/exclusion-rules", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const rules = await storage.getReorderExclusionRules();
      const totalExcluded = await storage.getTotalExcludedProducts();

      // Get match counts for each rule
      const rulesWithCounts = await Promise.all(
        rules.map(async (r: any) => ({
          ...r,
          matchCount: await storage.getExclusionRuleMatchCount(r.field, r.value),
        }))
      );

      res.json({ rules: rulesWithCounts, totalExcluded });
    } catch (error) {
      console.error("Error fetching exclusion rules:", error);
      res.status(500).json({ error: "Failed to fetch exclusion rules" });
    }
  });

  // POST /api/purchasing/exclusion-rules
  app.post("/api/purchasing/exclusion-rules", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { field, value } = req.body;
      const validFields = ["category", "brand", "product_type", "sku_prefix", "sku_exact", "tag"];
      if (!field || !validFields.includes(field)) {
        return res.status(400).json({ error: `field must be one of: ${validFields.join(", ")}` });
      }
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        return res.status(400).json({ error: "value is required" });
      }

      const userId = (req as any).user?.id ?? req.session.user?.id;
      const rule = await storage.createReorderExclusionRule({
        field,
        value: value.trim(),
        createdBy: userId,
      });
      const matchCount = await storage.getExclusionRuleMatchCount(rule.field, rule.value);
      res.status(201).json({ ...rule, matchCount });
    } catch (error: any) {
      if (error?.message?.includes("unique") || error?.code === "23505") {
        return res.status(409).json({ error: "Rule already exists" });
      }
      console.error("Error creating exclusion rule:", error);
      res.status(500).json({ error: "Failed to create exclusion rule" });
    }
  });

  // DELETE /api/purchasing/exclusion-rules/:id
  app.delete("/api/purchasing/exclusion-rules/:id", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteReorderExclusionRule(id);
      if (!deleted) {
        return res.status(404).json({ error: "Rule not found" });
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("Error deleting exclusion rule:", error);
      res.status(500).json({ error: "Failed to delete exclusion rule" });
    }
  });

  // PATCH /api/purchasing/products/:productId/reorder-excluded
  app.patch("/api/purchasing/products/:productId/reorder-excluded", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const productId = parseInt(req.params.productId);
      const { excluded } = req.body;
      if (typeof excluded !== "boolean") {
        return res.status(400).json({ error: "excluded must be a boolean" });
      }
      await storage.setProductReorderExcluded(productId, excluded);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error toggling product exclusion:", error);
      res.status(500).json({ error: "Failed to update product exclusion" });
    }
  });

  // GET /api/purchasing/auto-draft/status
  app.get("/api/purchasing/auto-draft/status", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const run = await storage.getLatestAutoDraftRun();
      res.json(run || null);
    } catch (error) {
      console.error("Error fetching auto-draft status:", error);
      res.status(500).json({ error: "Failed to fetch auto-draft status" });
    }
  });

  // POST /api/purchasing/auto-draft/run
  app.post("/api/purchasing/auto-draft/run", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const user = (req as any).user ?? req.session.user;
      if (user?.role !== "admin") {
        return res.status(403).json({ error: "Admin role required" });
      }

      // Import and run the job asynchronously
      const { runAutoDraftJob } = await import("../jobs/auto-draft.job");
      runAutoDraftJob({ triggeredBy: "manual", triggeredByUser: user?.id })
        .catch((err: any) => console.error("[Auto-draft] manual run failed:", err));

      res.status(202).json({ message: "Auto-draft job started" });
    } catch (error) {
      console.error("Error triggering auto-draft:", error);
      res.status(500).json({ error: "Failed to trigger auto-draft" });
    }
  });

  // GET /api/purchasing/auto-draft-settings
  app.get("/api/purchasing/auto-draft-settings", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const settings = await storage.getAutoDraftSettings();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching auto-draft settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // PATCH /api/purchasing/auto-draft-settings
  app.patch("/api/purchasing/auto-draft-settings", requirePermission("inventory", "adjust"), async (req, res) => {
    try {
      const { includeOrderSoon, skipOnOpenPo, skipNoVendor } = req.body;
      await storage.updateAutoDraftSettings(undefined, {
        includeOrderSoon,
        skipOnOpenPo,
        skipNoVendor,
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("Error updating auto-draft settings:", error);
      res.status(500).json({ error: "Failed to update settings" });
    }
  });
}
