import express, { type Request, type Response } from "express";
import { eq, and, sql, asc, isNotNull, inArray, isNull, desc } from "drizzle-orm";
import { db, pool } from "../../db";
import { requireAuth, requireInternalApiKey, requirePermission } from "../middleware";
import {
  channels,
  channelConnections,
  ebayOauthTokens,
  ebayCategoryMappings,
  products,
  productVariants,
  productTypes,
  inventoryLevels,
  channelListings,
  productAssets,
} from "@shared/schema";
import { getAuthService, getChannelConnection, escapeXml, getCached, setCache, ebayApiRequest, ebayApiRequestWithRateNotify, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { createInventoryAtpService } from "../../modules/inventory/atp.service";
import { upsertChannelListing, upsertPushError, clearPushError, resolveChannelPrice, applyPricingRule, determineVariationAspectName, syncActiveListings, triggerPricingRuleSync, delay } from "./ebay-sync-helpers";

export const router = express.Router();

  // -----------------------------------------------------------------------
  router.put("/api/ebay/product-exclusion/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const { excluded } = req.body as { excluded: boolean };
      
      await db.update(products)
        .set({ ebayListingExcluded: excluded })
        .where(eq(products.id, productId));
        
      res.json({ success: true, productId, excluded });
    } catch (err: any) {
      console.error("[eBay Product Exclusion] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-policies/:productId — Set policy overrides for a product

  // -----------------------------------------------------------------------
  router.put("/api/ebay/product-policies/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId } = req.body as {
        fulfillmentPolicyId?: string | null;
        returnPolicyId?: string | null;
        paymentPolicyId?: string | null;
      };
      
      await db.update(products)
        .set({
          ebayFulfillmentPolicyOverride: fulfillmentPolicyId || null,
          ebayReturnPolicyOverride: returnPolicyId || null,
          ebayPaymentPolicyOverride: paymentPolicyId || null,
        })
        .where(eq(products.id, productId));
        
      res.json({ success: true, productId });
    } catch (err: any) {
      console.error("[eBay Product Policies] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/variant-policies/:variantId — Set policy overrides for a variant

  // -----------------------------------------------------------------------
  router.put("/api/ebay/variant-policies/:variantId", requireAuth, async (req: Request, res: Response) => {
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId)) {
        res.status(400).json({ error: "Invalid variant ID" });
        return;
      }
      const { fulfillmentPolicyId, returnPolicyId, paymentPolicyId } = req.body as {
        fulfillmentPolicyId?: string | null;
        returnPolicyId?: string | null;
        paymentPolicyId?: string | null;
      };
      
      await db.update(productVariants)
        .set({
          ebayFulfillmentPolicyOverride: fulfillmentPolicyId || null,
          ebayReturnPolicyOverride: returnPolicyId || null,
          ebayPaymentPolicyOverride: paymentPolicyId || null,
        })
        .where(eq(productVariants.id, variantId));
        
      res.json({ success: true, variantId });
    } catch (err: any) {
      console.error("[eBay Variant Policies] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/product-policies/:productId — Get policy overrides for a product

  // -----------------------------------------------------------------------
  router.get("/api/ebay/product-policies/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      
      const result = await db.select({
        fulfillmentPolicyId: products.ebayFulfillmentPolicyOverride,
        returnPolicyId: products.ebayReturnPolicyOverride,
        paymentPolicyId: products.ebayPaymentPolicyOverride,
      })
      .from(products)
      .where(eq(products.id, productId));

      if (result.length === 0) {
        res.status(404).json({ error: "Product not found" });
        return;
      }
      const row = result[0];
      res.json({
        fulfillmentPolicyId: row.fulfillmentPolicyId || null,
        returnPolicyId: row.returnPolicyId || null,
        paymentPolicyId: row.paymentPolicyId || null,
      });
    } catch (err: any) {
      console.error("[eBay Product Policies GET] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/variant-policies/:variantId — Get policy overrides for a variant

  // -----------------------------------------------------------------------
  router.get("/api/ebay/variant-policies/:variantId", requireAuth, async (req: Request, res: Response) => {
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId)) {
        res.status(400).json({ error: "Invalid variant ID" });
        return;
      }
      
      const result = await db.select({
        fulfillmentPolicyId: productVariants.ebayFulfillmentPolicyOverride,
        returnPolicyId: productVariants.ebayReturnPolicyOverride,
        paymentPolicyId: productVariants.ebayPaymentPolicyOverride,
      })
      .from(productVariants)
      .where(eq(productVariants.id, variantId));

      if (result.length === 0) {
        res.status(404).json({ error: "Variant not found" });
        return;
      }
      const row = result[0];
      res.json({
        fulfillmentPolicyId: row.fulfillmentPolicyId || null,
        returnPolicyId: row.returnPolicyId || null,
        paymentPolicyId: row.paymentPolicyId || null,
      });
    } catch (err: any) {
      console.error("[eBay Variant Policies GET] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/import-images — Import product images from eBay into product_assets

  // -----------------------------------------------------------------------
  router.post("/api/ebay/import-images", requireAuth, async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

      try {
        // Get one SKU per product from synced eBay listings
        const listingsResult = await db.execute(sql`
          SELECT DISTINCT ON (p.id)
            p.id AS product_id,
            p.name AS product_name,
            cl.external_sku
          FROM channels.channel_listings cl
          JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
          JOIN catalog.products p ON p.id = pv.product_id
          WHERE cl.channel_id = ${EBAY_CHANNEL_ID}
            AND cl.sync_status = 'synced'
            AND cl.external_sku IS NOT NULL
          ORDER BY p.id ASC, cl.id ASC
        `);

        const prods = listingsResult.rows as any[];
        let imported = 0;
        let skipped = 0;
        let errors = 0;
        const details: Array<{ productId: number; productName: string; status: string; imageCount?: number; error?: string }> = [];

        for (const prod of prods) {
          try {
            const item = await ebayApiRequest(
              "GET",
              `/sell/inventory/v1/inventory_item/${encodeURIComponent(prod.external_sku)}`,
              accessToken,
            );

            const ebayImageUrls: string[] = item?.product?.imageUrls || [];
            if (ebayImageUrls.length === 0) {
              skipped++;
              details.push({ productId: prod.product_id, productName: prod.product_name, status: "no_images" });
              continue;
            }

            const existingResult = await db.select({ url: productAssets.url })
              .from(productAssets)
              .where(eq(productAssets.productId, prod.product_id));
            const existingUrls = new Set(existingResult.map(r => r.url));

            const posResult = await db.select({ max_pos: sql<number>`COALESCE(MAX(${productAssets.position}), -1)` })
              .from(productAssets)
              .where(eq(productAssets.productId, prod.product_id));
            let position = Number(posResult[0].max_pos) + 1;

            let addedCount = 0;
            const toInsert = [];
            for (const url of ebayImageUrls) {
              if (!url || existingUrls.has(url)) continue;
              toInsert.push({
                productId: prod.product_id,
                assetType: 'image',
                url,
                position,
                isPrimary: position === 0,
                storageType: 'url',
                createdAt: new Date()
              });
              position++;
              addedCount++;
            }

            if (toInsert.length > 0) {
              await db.insert(productAssets).values(toInsert as any);
              imported++;
              details.push({ productId: prod.product_id, productName: prod.product_name, status: "imported", imageCount: addedCount });
            } else {
              skipped++;
              details.push({ productId: prod.product_id, productName: prod.product_name, status: "already_exists" });
            }

            await delay(200);
          } catch (err: any) {
            errors++;
            details.push({ productId: prod.product_id, productName: prod.product_name, status: "error", error: err.message.substring(0, 200) });
            await delay(200);
          }
        }

        res.json({ total: prods.length, imported, skipped, errors, details });
      } catch (err: any) {
        throw err;
      }
    } catch (err: any) {
      console.error("[eBay Import Images] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/admin/cleanup-prod60 — One-time cleanup of PROD-60 group

  // -----------------------------------------------------------------------
  router.post("/api/ebay/admin/cleanup-prod60", requireAuth, async (_req: Request, res: Response) => {
    const log: string[] = [];
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }
      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      log.push("Got eBay access token");

      const skus = ["HERO-GRD-PSA-P1", "HERO-GRD-PSA-B5", "HERO-GRD-PSA-C50"];

      // Delete offers for each SKU
      for (const sku of skus) {
        try {
          const offers = await ebayApiRequest(
            "GET",
            `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&limit=100`,
            accessToken,
          );
          if (offers?.offers && offers.offers.length > 0) {
            for (const offer of offers.offers) {
              try {
                await ebayApiRequest("DELETE", `/sell/inventory/v1/offer/${offer.offerId}`, accessToken);
                log.push(`Deleted offer ${offer.offerId} for ${sku}`);
              } catch (err: any) {
                log.push(`Failed to delete offer ${offer.offerId}: ${err.message}`);
              }
            }
          } else {
            log.push(`No offers found for ${sku}`);
          }
        } catch (err: any) {
          log.push(`Error fetching offers for ${sku}: ${err.message}`);
        }
      }

      // Delete the inventory item group PROD-60
      try {
        await ebayApiRequest("DELETE", `/sell/inventory/v1/inventory_item_group/PROD-60`, accessToken);
        log.push("Deleted inventory item group PROD-60");
      } catch (err: any) {
        log.push(`Failed to delete group PROD-60: ${err.message}`);
      }

      // Delete individual inventory items
      for (const sku of skus) {
        try {
          await ebayApiRequest("DELETE", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken);
          log.push(`Deleted inventory item ${sku}`);
        } catch (err: any) {
          log.push(`Failed to delete inventory item ${sku}: ${err.message}`);
        }
      }

      // Clean up channel_listings rows
      const variantsList = await db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.productId, 60));
      if (variantsList.length > 0) {
        const variantIds = variantsList.map(v => v.id);
        const deletedRows = await db.delete(channelListings)
          .where(
            and(
              eq(channelListings.channelId, EBAY_CHANNEL_ID),
              inArray(channelListings.productVariantId, variantIds)
            )
          )
          .returning({ id: channelListings.id, productVariantId: channelListings.productVariantId, externalSku: channelListings.externalSku });
        log.push(`Deleted ${deletedRows.length} channel_listings rows`);
        for (const row of deletedRows) {
          log.push(`  - listing ${row.id}: variant ${row.productVariantId} (${row.externalSku})`);
        }
      }

      res.json({ success: true, log });
    } catch (err: any) {
      console.error("[eBay PROD-60 Cleanup] Error:", err.message);
      res.status(500).json({ error: err.message, log });
    }
  });
