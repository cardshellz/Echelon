import type { Express } from "express";
import { catalogStorage } from "../catalog";
import { warehouseStorage } from "../warehouse";
import { inventoryStorage } from "../inventory";
import { requirePermission } from "../../routes/middleware";

export function registerReplenishmentRoutes(app: Express) {
  // Compose `storage` at CALL time, not at module-init. This module is re-exported
  // by ../inventory (the barrel, index.ts:38), so during module evaluation
  // `inventoryStorage` is still in its temporal dead zone — the barrel body that
  // assigns it (index.ts:20) hasn't run yet. Snapshotting it at load made `storage`
  // EMPTY in the esbuild prod bundle (TDZ -> undefined -> {...undefined}), so every
  // /api/replen/* 500'd with "createReplenTask is not a function". By call time
  // (app startup) the barrel is fully initialized.
  const storage = { ...inventoryStorage, ...warehouseStorage, ...catalogStorage };
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

      const openStatuses = new Set(["pending", "assigned", "in_progress", "blocked"]);
      const statusFilter = status && !["open", "all"].includes(status) ? status : undefined;
      let tasks = await storage.getAllReplenTasks({ status: statusFilter, assignedTo });

      if (status === "open") {
        tasks = tasks.filter((t: any) => openStatuses.has(t.status));
      }

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
      
      const [allLocations, allProducts, allVariants] = await Promise.all([
        storage.getAllWarehouseLocations(),
        storage.getAllProducts(),
        storage.getAllProductVariants(),
      ]);

      const locationMap = new Map(allLocations.map(l => [l.id, l]));
      const productMap = new Map(allProducts.map(p => [p.id, p]));
      const variantMap = new Map(allVariants.map(v => [v.id, v]));

      const enriched = {
        ...task,
        fromLocation: locationMap.get(task.fromLocationId),
        toLocation: locationMap.get(task.toLocationId),
        product: task.productId ? productMap.get(task.productId) : null,
        sourceVariant: task.sourceProductVariantId ? variantMap.get(task.sourceProductVariantId) : null,
        pickVariant: task.pickProductVariantId ? variantMap.get(task.pickProductVariantId) : null,
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
  
}