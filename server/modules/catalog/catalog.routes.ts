import type { Express } from "express";
import { db } from "../../db";
import { sql, eq } from "drizzle-orm";
import { productAssets } from "@shared/schema";
import { catalogStorage } from "../catalog";
import { inventoryStorage } from "../inventory";
import { ordersStorage } from "../orders";
import { channelsStorage } from "../channels";
import { warehouseStorage } from "../warehouse";
import { procurementStorage } from "../procurement";
const storage = { ...catalogStorage, ...inventoryStorage, ...ordersStorage, ...channelsStorage, ...warehouseStorage, ...procurementStorage };
import { requirePermission } from "../../routes/middleware";
import { syncPickQueueForSku } from "../orders";

export async function registerProductRoutes(app: Express) {
  // ============================================================================
  // Products API (Master Catalog)
  // ============================================================================
  app.get("/api/products", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const includeInactive = req.query.includeInactive === "true";
      const allProducts = await storage.getAllProducts(includeInactive);
      const allVariants = await storage.getAllProductVariants(includeInactive);

      // Bulk-fetch primary images (one query instead of N)
      const primaryAssets = await storage.getPrimaryProductAssets();
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
        name: p.name, // Use internal name, not Shopify title
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

  app.put("/api/products/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { variants, ...updates } = req.body;

      // Check for SKU conflict when SKU is being changed
      let oldProductSku: string | null = null;
      const newProductSku: string | undefined = updates.sku;
      if (newProductSku) {
        const existing = await storage.getProductById(id);
        if (existing) oldProductSku = existing.sku ?? null;

        if (newProductSku !== oldProductSku) {
          const conflict = await storage.getProductBySku(newProductSku);
          if (conflict && conflict.id !== id) {
            return res.status(409).json({
              error: `SKU "${newProductSku}" already belongs to product "${conflict.name}" (id ${conflict.id})`,
            });
          }
        }
      }

      const product = await storage.updateProduct(id, updates);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      // Cascade base SKU rename to variants and all downstream tables
      if (newProductSku && oldProductSku && newProductSku !== oldProductSku) {
        const productVariantsList = await storage.getProductVariantsByProductId(id);

        for (const v of productVariantsList) {
          if (!v.sku) continue;

          // Derive new variant SKU by replacing old base prefix with new one
          let newVariantSku: string;
          if (v.sku === oldProductSku) {
            // Variant SKU matches base exactly (standalone product)
            newVariantSku = newProductSku;
          } else if (v.sku.startsWith(oldProductSku + "-")) {
            // Variant SKU has suffix like -P25, -C1000
            newVariantSku = newProductSku + v.sku.slice(oldProductSku.length);
          } else {
            // Variant SKU doesn't follow base pattern — skip
            continue;
          }

          const oldVariantSku = v.sku;
          if (newVariantSku === oldVariantSku) continue;

          // Update the variant itself
          await storage.updateProductVariant(v.id, { sku: newVariantSku });

          // Cascade to downstream tables
          try {
            await storage.cascadeSkuRename(v.id, oldVariantSku, newVariantSku);
          } catch (err: any) {
            console.warn(`[SKU CASCADE] Partial failure renaming variant ${oldVariantSku} → ${newVariantSku}: ${err.message}`);
          }
        }

        console.log(`[SKU CASCADE] Product base SKU ${oldProductSku} → ${newProductSku}, updated ${productVariantsList.length} variants + downstream`);
      }

      const existingVariants = await storage.getProductVariantsByProductId(id);
      res.json({ ...product, variants: existingVariants });
    } catch (error: any) {
      console.error("Error updating product:", error);
      res.status(500).json({ error: "Failed to update product", detail: error?.message || String(error) });
    }
  });

  // Archive product — soft-delete with dependency cleanup
  app.post("/api/products/:id/archive", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const force = req.body?.force === true;
      const transferToVariantId = req.body?.transferToVariantId ? parseInt(req.body.transferToVariantId) : null;

      const product = await storage.getProductById(id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const variants = await storage.getProductVariantsByProductId(id);
      const variantIds = variants.map(v => v.id);

      // Pre-flight dependency check with per-level detail
      let totalInventory = 0;
      let totalReserved = 0;
      let inventoryBins = 0;
      const variantInventory: { variantId: number; sku: string | null; totalQty: number; bins: number; reservedQty: number }[] = [];
      const inventoryDetails: { variantId: number; sku: string | null; warehouseLocationId: number; locationCode: string; variantQty: number; reservedQty: number }[] = [];
      for (const v of variants) {
        const levels = await storage.getInventoryLevelsByVariantId(v.id);
        const qty = levels.reduce((sum, l) => sum + l.variantQty, 0);
        const reserved = levels.reduce((sum, l) => sum + l.reservedQty, 0);
        const bins = levels.filter(l => l.variantQty !== 0).length;
        totalInventory += qty;
        totalReserved += reserved;
        inventoryBins += bins;
        if (qty > 0) {
          variantInventory.push({ variantId: v.id, sku: v.sku, totalQty: qty, bins, reservedQty: reserved });
        }
        // Collect per-level details for transfer preview
        for (const level of levels) {
          if (level.variantQty > 0) {
            // Get location code
            const locCode = await storage.getWarehouseLocationCodeById(level.warehouseLocationId);
            inventoryDetails.push({
              variantId: v.id,
              sku: v.sku,
              warehouseLocationId: level.warehouseLocationId,
              locationCode: locCode ?? `LOC-${level.warehouseLocationId}`,
              variantQty: level.variantQty,
              reservedQty: level.reservedQty,
            });
          }
        }
      }

      const pendingShipments = await storage.getPendingShipmentItemsByVariantIds(variantIds);

      // Count active channel feeds with details
      let activeFeeds = 0;
      const feedDetails: { channelName: string; provider: string; channelSku: string | null; variantSku: string | null }[] = [];
      for (const v of variants) {
        const feeds = await storage.getChannelFeedsByProductVariantId(v.id);
        const activeFeedList = feeds.filter((f: any) => f.isActive === 1);
        activeFeeds += activeFeedList.length;
        for (const feed of activeFeedList) {
          let channelName = feed.channelType || "Unknown";
          if (feed.channelId) {
            const name = await storage.getChannelNameById(feed.channelId);
            if (name) channelName = name;
          }
          feedDetails.push({ channelName, provider: feed.channelType, channelSku: feed.channelSku, variantSku: v.sku });
        }
      }

      // Build dependency report
      const dependencies = {
        inventory: { totalQty: totalInventory, bins: inventoryBins, variants: variantInventory, hasReserved: totalReserved > 0, inventoryDetails },
        shipments: { pending: pendingShipments.length, items: pendingShipments.slice(0, 10) },
        channelFeeds: { active: activeFeeds, details: feedDetails },
        variants: { total: variants.length, active: variants.filter(v => v.isActive).length },
      };

      const hasBlockers = totalInventory > 0 || pendingShipments.length > 0;

      if (!force) {
        return res.json({ blocked: hasBlockers, dependencies, product: { id: product.id, sku: product.sku, name: product.name } });
      }

      // Execute archive
      let inventoryCleared = 0;
      let inventoryTransferred = 0;
      let binAssignmentsCleared = 0;
      let channelFeedsDeactivated = 0;
      const userId = (req as any).user?.username || "system";

      // SKU correction transfer — move inventory to target variant before archive
      if (transferToVariantId) {
        const targetVariant = await storage.getProductVariantById(transferToVariantId);
        if (!targetVariant || !targetVariant.isActive) {
          return res.status(400).json({ error: "Target variant not found or inactive" });
        }

        const { inventoryCore } = req.app.locals.services;
        const batchId = `sku_correction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        for (const v of variants) {
          const levels = await storage.getInventoryLevelsByVariantId(v.id);
          for (const level of levels) {
            if (level.variantQty > 0) {
              if (level.reservedQty > 0) {
                return res.status(400).json({
                  error: `Cannot transfer: variant ${v.sku} has ${level.reservedQty} reserved units. Fulfill or cancel those orders first.`,
                });
              }

              await inventoryCore.skuCorrectionTransfer({
                sourceVariantId: v.id,
                targetVariantId: transferToVariantId,
                warehouseLocationId: level.warehouseLocationId,
                qty: level.variantQty,
                batchId,
                userId,
                notes: `SKU correction: ${v.sku} → ${targetVariant.sku} (archive transfer)`,
              });
              inventoryTransferred += level.variantQty;
            }
          }
        }

        // Sync target variant inventory to channels
        const { channelSync } = req.app.locals.services;
        if (channelSync) {
          channelSync.queueSyncAfterInventoryChange(transferToVariantId).catch((err: any) =>
            console.warn(`[ChannelSync] Post-SKU-correction sync failed:`, err)
          );
        }

        console.log(`[ARCHIVE] SKU correction: transferred ${inventoryTransferred} units to variant ${targetVariant.sku} (batch: ${batchId})`);
      }

      const { inventoryCore: archiveCore } = req.app.locals.services;
      const { channelSync: archiveChannelSync } = req.app.locals.services;

      for (const v of variants) {
        // Zero out inventory through inventoryCore (creates audit trail, fires notifyChange → Shopify sync)
        if (!transferToVariantId) {
          const levels = await storage.getInventoryLevelsByVariantId(v.id);
          for (const level of levels) {
            if (level.variantQty !== 0) {
              await archiveCore.adjustInventory({
                productVariantId: v.id,
                warehouseLocationId: level.warehouseLocationId,
                qtyDelta: -level.variantQty,
                reason: "Product archived — inventory zeroed",
                userId,
              });
            }
          }
        }

        inventoryCleared += await storage.deleteInventoryLevelsByVariantId(v.id);
        binAssignmentsCleared += await storage.deleteProductLocationsByVariantId(v.id);

        // Deactivate channel feeds + clean up channel listings
        channelFeedsDeactivated += await storage.deactivateChannelFeedsByVariantId(v.id);
        await db.execute(sql`DELETE FROM channel_listings WHERE product_variant_id = ${v.id}`);
        if (archiveChannelSync) {
          archiveChannelSync.queueSyncAfterInventoryChange(v.id).catch((err: any) =>
            console.warn(`[ChannelSync] Post-archive feed deactivation sync failed for variant ${v.id}:`, err)
          );
        }

        // Deactivate variant
        await storage.updateProductVariant(v.id, { isActive: false });
      }

      const replenDeactivated = await storage.deactivateReplenRulesByProductId(id);
      const replenTasksCancelled = await storage.cancelReplenTasksByProductId(id);

      // Archive the product
      await storage.updateProduct(id, { isActive: false, status: "archived" });

      console.log(`[ARCHIVE] Product ${id} (${product.sku}) archived: ${variants.length} variants, ${inventoryCleared} inventory rows, ${binAssignmentsCleared} bin assignments, ${channelFeedsDeactivated} feeds, ${replenDeactivated} replen rules, ${replenTasksCancelled} replen tasks`);

      res.json({
        success: true,
        archived: {
          product: { id: product.id, sku: product.sku, name: product.name },
          variants: variants.length,
          inventoryCleared,
          inventoryTransferred,
          binAssignmentsCleared,
          channelFeedsDeactivated,
          replenDeactivated,
          replenTasksCancelled,
        },
      });
    } catch (error) {
      console.error("Error archiving product:", error);
      res.status(500).json({ error: "Failed to archive product" });
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
  // Product Inventory — all variants' inventory levels with location context
  // ============================================================================
  app.get("/api/products/:id/inventory", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const productId = parseInt(req.params.id);
      const rows = await storage.getProductInventoryByProductId(productId);
      res.json(rows);
    } catch (error) {
      console.error("Error fetching product inventory:", error);
      res.status(500).json({ error: "Failed to fetch product inventory" });
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
      const includeInactive = req.query.includeInactive === "true";
      const variants = await storage.getAllProductVariants(includeInactive);
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
      // Check for SKU conflict with existing active variants
      if (req.body.sku) {
        const conflict = await storage.getActiveVariantBySku(req.body.sku);
        if (conflict) {
          const conflictProduct = conflict.productId ? await storage.getProductById(conflict.productId) : null;
          return res.status(409).json({
            error: "SKU already exists",
            conflictVariant: { id: conflict.id, sku: conflict.sku, productId: conflict.productId, productName: conflictProduct?.name || null },
          });
        }
      }
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

  app.put("/api/product-variants/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const newSku: string | undefined = req.body.sku;

      // Check for SKU conflict when SKU is being changed
      if (newSku) {
        const conflict = await storage.getActiveVariantBySku(newSku, id);
        if (conflict) {
          const conflictProduct = conflict.productId ? await storage.getProductById(conflict.productId) : null;
          return res.status(409).json({
            error: "SKU already exists",
            conflictVariant: { id: conflict.id, sku: conflict.sku, productId: conflict.productId, productName: conflictProduct?.name || null },
          });
        }
      }

      // Capture old SKU before update for cascade
      let oldSku: string | null = null;
      if (newSku) {
        const existing = await storage.getProductVariantById(id);
        if (existing) oldSku = existing.sku;
      }

      const variant = await storage.updateProductVariant(id, req.body);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      // Cascade SKU rename to all downstream tables with cached sku columns
      if (newSku && oldSku && newSku !== oldSku) {
        try {
          await storage.cascadeSkuRename(id, oldSku, newSku);
          console.log(`[SKU CASCADE] Renamed ${oldSku} → ${newSku} across all downstream tables`);
        } catch (err: any) {
          console.warn(`[SKU CASCADE] Partial failure renaming ${oldSku} → ${newSku}: ${err.message}`);
        }
      }

      res.json(variant);
    } catch (error) {
      console.error("Error updating variant:", error);
      res.status(500).json({ error: "Failed to update variant" });
    }
  });

  // Merge source variant's inventory into target variant, then deactivate source
  app.post("/api/product-variants/:id/merge", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const targetId = parseInt(req.params.id);
      const sourceId = parseInt(req.body.sourceVariantId);
      if (!sourceId || sourceId === targetId) {
        return res.status(400).json({ error: "Invalid source variant" });
      }

      const target = await storage.getProductVariantById(targetId);
      const source = await storage.getProductVariantById(sourceId);
      if (!target) return res.status(404).json({ error: "Target variant not found" });
      if (!source) return res.status(404).json({ error: "Source variant not found" });

      // Move inventory_levels from source to target
      const movedInventoryCount = await storage.reassignInventoryLevelsToVariant(sourceId, targetId);

      // Move product_locations from source to target
      const movedLocationCount = await storage.reassignProductLocationsToVariant(sourceId, targetId);

      // Log audit transaction
      await storage.createMergeAuditTransaction(targetId, source.sku || '', sourceId, movedInventoryCount, movedLocationCount);

      // Trigger notifyChange for both variants so channel sync picks up the merged inventory
      const { inventoryCore: mergeCore } = req.app.locals.services;
      if (mergeCore && movedInventoryCount > 0) {
        mergeCore.triggerNotifyChange(sourceId, "variant_merge_source");
        mergeCore.triggerNotifyChange(targetId, "variant_merge_target");
      }

      // Deactivate source variant
      await storage.updateProductVariant(sourceId, { isActive: false } as any);

      console.log(`[VARIANT MERGE] ${source.sku} (id=${sourceId}) → ${target.sku} (id=${targetId}): ${movedInventoryCount} inventory, ${movedLocationCount} locations`);

      res.json({
        ok: true,
        movedInventoryCount,
        movedLocationCount,
        deactivatedVariantId: sourceId,
      });
    } catch (error) {
      console.error("Error merging variants:", error);
      res.status(500).json({ error: "Failed to merge variants" });
    }
  });

  // Archive variant — soft-delete with dependency cleanup (mirrors product archive)
  app.post("/api/product-variants/:id/archive", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const force = req.body?.force === true;
      const transferToVariantId = req.body?.transferToVariantId ? parseInt(req.body.transferToVariantId) : null;

      const variant = await storage.getProductVariantById(id);
      if (!variant) {
        return res.status(404).json({ error: "Variant not found" });
      }

      // Dependency scan
      const levels = await storage.getInventoryLevelsByVariantId(id);
      const totalQty = levels.reduce((sum, l) => sum + l.variantQty, 0);
      const totalReserved = levels.reduce((sum, l) => sum + l.reservedQty, 0);
      const bins = levels.filter(l => l.variantQty > 0).length;

      const inventoryDetails: { warehouseLocationId: number; locationCode: string; variantQty: number; reservedQty: number }[] = [];
      for (const level of levels) {
        if (level.variantQty > 0) {
          const locCode = await storage.getWarehouseLocationCodeById(level.warehouseLocationId);
          inventoryDetails.push({
            warehouseLocationId: level.warehouseLocationId,
            locationCode: locCode ?? `LOC-${level.warehouseLocationId}`,
            variantQty: level.variantQty,
            reservedQty: level.reservedQty,
          });
        }
      }

      const pendingShipments = await storage.getPendingShipmentItemsByVariantIds([id]);
      const feeds = await storage.getChannelFeedsByProductVariantId(id);
      const activeFeedList = feeds.filter((f: any) => f.isActive === 1);
      const feedDetails: { channelName: string; provider: string; channelSku: string | null }[] = [];
      for (const feed of activeFeedList) {
        let channelName = feed.channelType || "Unknown";
        if (feed.channelId) {
          const name = await storage.getChannelNameById(feed.channelId);
          if (name) channelName = name;
        }
        feedDetails.push({ channelName, provider: feed.channelType, channelSku: feed.channelSku });
      }

      const dependencies = {
        inventory: { totalQty, bins, hasReserved: totalReserved > 0, inventoryDetails },
        shipments: { pending: pendingShipments.length },
        channelFeeds: { active: activeFeedList.length, details: feedDetails },
      };

      const hasBlockers = totalQty > 0 || pendingShipments.length > 0;

      if (!force) {
        return res.json({ blocked: hasBlockers, dependencies, variant: { id: variant.id, sku: variant.sku, name: variant.name } });
      }

      // Execute archive
      let inventoryCleared = 0;
      let inventoryTransferred = 0;
      let binAssignmentsCleared = 0;
      let channelFeedsDeactivated = 0;
      const userId = (req as any).user?.username || "system";

      // SKU correction transfer
      if (transferToVariantId) {
        const targetVariant = await storage.getProductVariantById(transferToVariantId);
        if (!targetVariant || !targetVariant.isActive) {
          return res.status(400).json({ error: "Target variant not found or inactive" });
        }

        const { inventoryCore } = req.app.locals.services;
        const batchId = `sku_correction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        for (const level of levels) {
          if (level.variantQty > 0) {
            if (level.reservedQty > 0) {
              return res.status(400).json({
                error: `Cannot transfer: ${level.reservedQty} reserved units. Fulfill or cancel those orders first.`,
              });
            }
            await inventoryCore.skuCorrectionTransfer({
              sourceVariantId: id,
              targetVariantId: transferToVariantId,
              warehouseLocationId: level.warehouseLocationId,
              qty: level.variantQty,
              batchId,
              userId,
              notes: `SKU correction: ${variant.sku} → ${targetVariant.sku} (variant archive transfer)`,
            });
            inventoryTransferred += level.variantQty;
          }
        }

        const { channelSync } = req.app.locals.services;
        if (channelSync) {
          channelSync.queueSyncAfterInventoryChange(transferToVariantId).catch((err: any) =>
            console.warn(`[ChannelSync] Post-SKU-correction sync failed:`, err)
          );
        }
        console.log(`[ARCHIVE-VARIANT] SKU correction: transferred ${inventoryTransferred} units from ${variant.sku} to ${targetVariant.sku} (batch: ${batchId})`);
      }

      // Zero remaining inventory through inventoryCore (audit trail + notifyChange → Shopify sync)
      const { inventoryCore: varArchiveCore } = req.app.locals.services;
      const { channelSync: varArchiveSync } = req.app.locals.services;

      if (!transferToVariantId) {
        for (const level of levels) {
          if (level.variantQty !== 0) {
            await varArchiveCore.adjustInventory({
              productVariantId: id,
              warehouseLocationId: level.warehouseLocationId,
              qtyDelta: -level.variantQty,
              reason: "Variant archived — inventory zeroed",
              userId,
            });
          }
        }
      }

      inventoryCleared = await storage.deleteInventoryLevelsByVariantId(id);
      binAssignmentsCleared = await storage.deleteProductLocationsByVariantId(id);

      // Deactivate channel feeds + clean up channel listings
      channelFeedsDeactivated = await storage.deactivateChannelFeedsByVariantId(id);
      await db.execute(sql`DELETE FROM channel_listings WHERE product_variant_id = ${id}`);
      if (varArchiveSync) {
        varArchiveSync.queueSyncAfterInventoryChange(id).catch((err: any) =>
          console.warn(`[ChannelSync] Post-archive feed deactivation sync failed for variant ${id}:`, err)
        );
      }
      await storage.updateProductVariant(id, { isActive: false });

      console.log(`[ARCHIVE-VARIANT] Variant ${id} (${variant.sku}) archived: ${inventoryCleared} inventory rows, ${binAssignmentsCleared} bin assignments, ${channelFeedsDeactivated} feeds`);

      res.json({
        success: true,
        archived: {
          variant: { id: variant.id, sku: variant.sku, name: variant.name },
          inventoryCleared,
          inventoryTransferred,
          binAssignmentsCleared,
          channelFeedsDeactivated,
        },
      });
    } catch (error) {
      console.error("Error archiving variant:", error);
      res.status(500).json({ error: "Failed to archive variant" });
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

  // Bulk update parentVariantId via sku → parent_sku mapping
  app.post("/api/product-variants/bulk-parent", requirePermission("inventory", "update"), async (req, res) => {
    try {
      const rows: { sku: string; parent_sku: string }[] = req.body.rows;
      if (!Array.isArray(rows)) {
        return res.status(400).json({ error: "rows array required" });
      }

      // Build SKU → variant lookup
      const allVariants = await storage.getAllProductVariants();
      const skuMap = new Map<string, typeof allVariants[0]>();
      for (const v of allVariants) {
        if (v.sku) skuMap.set(v.sku.toUpperCase(), v);
      }

      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const row of rows) {
        const sku = row.sku?.trim().toUpperCase();
        if (!sku) { skipped++; continue; }

        const variant = skuMap.get(sku);
        if (!variant) {
          errors.push(`SKU not found: ${row.sku}`);
          continue;
        }

        const parentSku = row.parent_sku?.trim().toUpperCase();
        if (!parentSku) {
          // Clear parent (set to base variant)
          await storage.updateProductVariant(variant.id, { parentVariantId: null } as any);
          updated++;
          continue;
        }

        const parentVariant = skuMap.get(parentSku);
        if (!parentVariant) {
          errors.push(`Parent SKU not found: ${row.parent_sku} (for ${row.sku})`);
          continue;
        }

        if (parentVariant.productId !== variant.productId) {
          errors.push(`Parent ${row.parent_sku} belongs to different product than ${row.sku}`);
          continue;
        }

        await storage.updateProductVariant(variant.id, { parentVariantId: parentVariant.id });
        updated++;
      }

      res.json({ updated, skipped, errors, total: rows.length });
    } catch (error) {
      console.error("Error bulk updating parent variants:", error);
      res.status(500).json({ error: "Failed to bulk update parent variants" });
    }
  });

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
  const { binAssignment } = app.locals.services;

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

  // ============================================================================
  // PRODUCT ASSET UPLOAD (file storage)
  // ============================================================================

  const multer = (await import("multer")).default;
  const assetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

  /**
   * POST /api/product-assets/upload
   * Upload an image file and store it in the database.
   * Accepts multipart form: file, productId, productVariantId (optional), altText, isPrimary, position
   */
  app.post("/api/product-assets/upload", requirePermission("inventory", "edit"), assetUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }

      const { productId, productVariantId, altText, isPrimary, position } = req.body;

      if (!productId) {
        return res.status(400).json({ error: "productId is required" });
      }

      // Validate file type
      const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
      if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: `Invalid file type: ${req.file.mimetype}. Allowed: ${allowedTypes.join(", ")}` });
      }

      // If setting as primary, unset existing primary
      if (isPrimary === "true" || isPrimary === "1") {
        await db.execute(sql`
          UPDATE product_assets SET is_primary = 0
          WHERE product_id = ${parseInt(productId)}
            ${productVariantId ? sql`AND product_variant_id = ${parseInt(productVariantId)}` : sql`AND product_variant_id IS NULL`}
        `);
      }

      const [asset] = await db
        .insert(productAssets)
        .values({
          productId: parseInt(productId),
          productVariantId: productVariantId ? parseInt(productVariantId) : null,
          assetType: "image",
          url: null,
          altText: altText || null,
          position: position ? parseInt(position) : 0,
          isPrimary: (isPrimary === "true" || isPrimary === "1") ? 1 : 0,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
          storageType: "file",
        })
        .returning();

      // Store the actual file data
      await db.execute(sql`
        UPDATE product_assets SET file_data = ${req.file.buffer} WHERE id = ${asset.id}
      `);

      console.log(`[Assets] Uploaded file for product ${productId}: ${req.file.originalname} (${req.file.size} bytes)`);

      res.json({
        ...asset,
        // Don't return file_data in the response — too large
        fileUrl: `/api/product-assets/${asset.id}/file`,
      });
    } catch (error: any) {
      console.error("Error uploading asset:", error);
      res.status(500).json({ error: "Failed to upload asset" });
    }
  });

  /**
   * GET /api/product-assets/:id/file
   * Serve a stored image file from the database.
   */
  app.get("/api/product-assets/:id/file", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const result = await db.execute(sql`
        SELECT file_data, mime_type, alt_text FROM product_assets WHERE id = ${id}
      `);

      if (!result.rows.length || !result.rows[0].file_data) {
        return res.status(404).json({ error: "File not found" });
      }

      const row = result.rows[0] as any;
      res.set("Content-Type", row.mime_type || "image/jpeg");
      res.set("Cache-Control", "public, max-age=86400"); // Cache 24h
      if (row.alt_text) {
        res.set("Content-Disposition", `inline; filename="${row.alt_text || "image"}"`);
      }
      res.send(row.file_data);
    } catch (error: any) {
      console.error("Error serving asset file:", error);
      res.status(500).json({ error: "Failed to serve file" });
    }
  });

  /**
   * GET /api/product-assets/:id
   * Get asset metadata (without file data).
   */
  app.get("/api/product-assets/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [asset] = await db
        .select()
        .from(productAssets)
        .where(eq(productAssets.id, id))
        .limit(1);

      if (!asset) {
        return res.status(404).json({ error: "Asset not found" });
      }

      res.json({
        ...asset,
        fileUrl: ((asset as any).storageType === "file" || (asset as any).storageType === "both")
          ? `/api/product-assets/${asset.id}/file`
          : asset.url,
      });
    } catch (error: any) {
      console.error("Error getting asset:", error);
      res.status(500).json({ error: "Failed to get asset" });
    }
  });

  /**
   * DELETE /api/product-assets/:id
   * Delete an asset (both URL reference and stored file).
   */
  app.delete("/api/product-assets/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const [deleted] = await db
        .delete(productAssets)
        .where(eq(productAssets.id, id))
        .returning();

      if (!deleted) {
        return res.status(404).json({ error: "Asset not found" });
      }

      console.log(`[Assets] Deleted asset ${id} for product ${deleted.productId}`);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting asset:", error);
      res.status(500).json({ error: "Failed to delete asset" });
    }
  });

  /**
   * POST /api/product-assets/store-url
   * Store an external URL as an asset (e.g., from eBay image pull).
   * Body: { productId, productVariantId, url, altText, isPrimary, position }
   * Optionally downloads and caches the file locally.
   */
  app.post("/api/product-assets/store-url", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const { productId, productVariantId, url, altText, isPrimary, position, cacheLocally } = req.body;

      if (!productId || !url) {
        return res.status(400).json({ error: "productId and url are required" });
      }

      // If setting as primary, unset existing primary
      if (isPrimary) {
        await db.execute(sql`
          UPDATE product_assets SET is_primary = 0
          WHERE product_id = ${productId}
            ${productVariantId ? sql`AND product_variant_id = ${productVariantId}` : sql`AND product_variant_id IS NULL`}
        `);
      }

      let fileBuffer: Buffer | null = null;
      let mimeType: string | null = null;
      let fileSize: number | null = null;

      // Optionally download and cache the file
      if (cacheLocally) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const arrayBuf = await response.arrayBuffer();
            fileBuffer = Buffer.from(arrayBuf);
            mimeType = response.headers.get("content-type") || "image/jpeg";
            fileSize = fileBuffer.length;
          }
        } catch (fetchErr: any) {
          console.warn(`[Assets] Failed to cache file from ${url}: ${fetchErr.message}`);
          // Continue with URL-only storage
        }
      }

      const storageType: string = fileBuffer ? "both" : "url";

      const [asset] = await db
        .insert(productAssets)
        .values({
          productId,
          productVariantId: productVariantId || null,
          assetType: "image",
          url,
          altText: altText || null,
          position: position || 0,
          isPrimary: isPrimary ? 1 : 0,
          fileSize,
          mimeType,
          storageType,
        })
        .returning();

      if (fileBuffer) {
        await db.execute(sql`
          UPDATE product_assets SET file_data = ${fileBuffer} WHERE id = ${asset.id}
        `);
      }

      console.log(`[Assets] Stored URL for product ${productId}: ${url} (storage: ${storageType})`);

      res.json({
        ...asset,
        fileUrl: storageType === "both" || storageType === "file"
          ? `/api/product-assets/${asset.id}/file`
          : asset.url,
      });
    } catch (error: any) {
      console.error("Error storing URL asset:", error);
      res.status(500).json({ error: "Failed to store URL asset" });
    }
  });
}
