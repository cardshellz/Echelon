import { z } from "zod";
import { ebayPolicyWriteSchema } from "@shared/ebay-business-policies";
import { ebayBusinessPolicies } from "../../modules/channels/ebay-business-policies";
import { ebayPolicyActor, sendEbayPolicyError } from "./ebay-business-policy-http";
import { syncActiveListings, triggerPricingRuleSync } from "../../modules/channels/ebay-listing-sync";
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
import { getAuthService, getChannelConnection, escapeXml, getCached, setCache, EBAY_CHANNEL_ID, atpService } from "./ebay-utils";
import { delay } from "../../modules/channels/infrastructure/ebay-listing-helpers";
import {
  createEbayRouteListingLifecycleClient,
  getExistingEbayInventoryImageUrls,
} from "./ebay-listing-connector-client";
import { ebayListingExclusionService } from "../../modules/channels/ebay-listing-exclusion";
import { registerEbayListingExclusionRoutes } from "./ebay-listing-exclusion.routes";

export const router = express.Router();

async function getEbayRouteMarketplaceId(): Promise<string> {
  const connection = await getChannelConnection();
  const metadata = (connection?.metadata as Record<string, unknown>) || {};
  return typeof metadata.marketplaceId === "string" && metadata.marketplaceId.trim()
    ? metadata.marketplaceId.trim()
    : "EBAY_US";
}

  // -----------------------------------------------------------------------
registerEbayListingExclusionRoutes(router, ebayListingExclusionService);

  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-policies/:productId — Set policy overrides for a product

  // -----------------------------------------------------------------------
for (const kind of ["product", "variant"] as const) {
  const parameter = kind === "product" ? "productId" : "variantId";
  const path = `/api/ebay/${kind}-policies/:${parameter}`;
  const targetFor = (req: Request) => {
    const id = z.coerce.number().int().positive().max(2147483647).parse(req.params[parameter]);
    return kind === "product" ? { kind: "product" as const, productId: id } : { kind: "variant" as const, variantId: id };
  };
  router.put(path, requireAuth, requirePermission("channels", "edit"), async (req: Request, res: Response) => {
    try {
      const { expectedPolicies, expectedScope, ...patch } = ebayPolicyWriteSchema.parse(req.body);
      const target = targetFor(req);
      const policies = await ebayBusinessPolicies.patchPolicies({ target, patch, expectedPolicies, expectedScope, actor: ebayPolicyActor(req) });
      res.json({ success: true, ...target, ...policies });
    } catch (error) { sendEbayPolicyError(res, error); }
  });
  router.get(path, requireAuth, async (req: Request, res: Response) => {
    try { res.json(await ebayBusinessPolicies.readPolicies(targetFor(req))); }
    catch (error) { sendEbayPolicyError(res, error); }
  });
}

  // -----------------------------------------------------------------------
  // POST /api/ebay/import-images — Import product images from eBay into product_assets

  // -----------------------------------------------------------------------
  router.post("/api/ebay/import-images", requireAuth, requirePermission("channels", "edit"), async (_req: Request, res: Response) => {
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
            const ebayImageUrls = await getExistingEbayInventoryImageUrls({
              accessToken,
              sku: prod.external_sku,
            });
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
