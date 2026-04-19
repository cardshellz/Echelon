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
      const client = await pool.connect();
      try {
        await client.query(
          "UPDATE catalog.products SET ebay_listing_excluded = $1 WHERE id = $2",
          [excluded, productId]
        );
        res.json({ success: true, productId, excluded });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE catalog.products SET
             ebay_fulfillment_policy_override = $1,
             ebay_return_policy_override = $2,
             ebay_payment_policy_override = $3
           WHERE id = $4`,
          [fulfillmentPolicyId || null, returnPolicyId || null, paymentPolicyId || null, productId]
        );
        res.json({ success: true, productId });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE catalog.product_variants SET
             ebay_fulfillment_policy_override = $1,
             ebay_return_policy_override = $2,
             ebay_payment_policy_override = $3
           WHERE id = $4`,
          [fulfillmentPolicyId || null, returnPolicyId || null, paymentPolicyId || null, variantId]
        );
        res.json({ success: true, variantId });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT ebay_fulfillment_policy_override, ebay_return_policy_override, ebay_payment_policy_override
           FROM catalog.products WHERE id = $1`,
          [productId]
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: "Product not found" });
          return;
        }
        const row = result.rows[0];
        res.json({
          fulfillmentPolicyId: row.ebay_fulfillment_policy_override || null,
          returnPolicyId: row.ebay_return_policy_override || null,
          paymentPolicyId: row.ebay_payment_policy_override || null,
        });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT ebay_fulfillment_policy_override, ebay_return_policy_override, ebay_payment_policy_override
           FROM catalog.product_variants WHERE id = $1`,
          [variantId]
        );
        if (result.rows.length === 0) {
          res.status(404).json({ error: "Variant not found" });
          return;
        }
        const row = result.rows[0];
        res.json({
          fulfillmentPolicyId: row.ebay_fulfillment_policy_override || null,
          returnPolicyId: row.ebay_return_policy_override || null,
          paymentPolicyId: row.ebay_payment_policy_override || null,
        });
      } finally {
        client.release();
      }
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
      const client = await pool.connect();

      try {
        // Get one SKU per product from synced eBay listings
        const listingsResult = await client.query(`
          SELECT DISTINCT ON (p.id)
            p.id AS product_id,
            p.name AS product_name,
            cl.external_sku
          FROM channels.channel_listings cl
          JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
          JOIN catalog.products p ON p.id = pv.product_id
          WHERE cl.channel_id = $1
            AND cl.sync_status = 'synced'
            AND cl.external_sku IS NOT NULL
          ORDER BY p.id ASC, cl.id ASC
        `, [EBAY_CHANNEL_ID]);

        const prods = listingsResult.rows;
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

            const existingResult = await client.query(
              `SELECT url FROM catalog.product_assets WHERE product_id = $1`,
              [prod.product_id],
            );
            const existingUrls = new Set(existingResult.rows.map((r: any) => r.url));

            const posResult = await client.query(
              `SELECT COALESCE(MAX(position), -1) AS max_pos FROM catalog.product_assets WHERE product_id = $1`,
              [prod.product_id],
            );
            let position = (posResult.rows[0]?.max_pos ?? -1) + 1;

            let addedCount = 0;
            for (const url of ebayImageUrls) {
              if (!url || existingUrls.has(url)) continue;
              await client.query(
                `INSERT INTO catalog.product_assets (product_id, asset_type, url, position, is_primary, storage_type, created_at)
                 VALUES ($1, 'image', $2, $3, $4, 'url', NOW())`,
                [prod.product_id, url, position, position === 0 ? 1 : 0],
              );
              position++;
              addedCount++;
            }

            if (addedCount > 0) {
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
      } finally {
        client.release();
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
      const client = await pool.connect();
      try {
        const result = await client.query(
          `DELETE FROM channel_listings
           WHERE channel_id = $1
             AND product_variant_id IN (
               SELECT id FROM product_variants WHERE product_id = $2
             )
           RETURNING id, product_variant_id, external_sku`,
          [EBAY_CHANNEL_ID, 60],
        );
        log.push(`Deleted ${result.rowCount} channel_listings rows`);
        for (const row of result.rows) {
          log.push(`  - listing ${row.id}: variant ${row.product_variant_id} (${row.external_sku})`);
        }
      } finally {
        client.release();
      }

      res.json({ success: true, log });
    } catch (err: any) {
      console.error("[eBay PROD-60 Cleanup] Error:", err.message);
      res.status(500).json({ error: err.message, log });
    }
  });
