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
  // GET /api/ebay/channel-config — Full eBay channel configuration
  // -----------------------------------------------------------------------
  router.get("/api/ebay/channel-config", requireAuth, async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();

      // Token info
      const [tokenRow] = await (db as any)
        .select()
        .from(ebayOauthTokens)
        .where(eq(ebayOauthTokens.channelId, EBAY_CHANNEL_ID))
        .limit(1);

      // Channel
      const [channel] = await (db as any)
        .select()
        .from(channels)
        .where(eq(channels.id, EBAY_CHANNEL_ID))
        .limit(1);

      // Connection metadata (location, policies)
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};

      // Username
      let ebayUsername: string | null = null;
      if (tokenRow?.accessToken && authService) {
        try {
          const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
          const environment = process.env.EBAY_ENVIRONMENT || "production";
          const baseUrl = environment === "sandbox"
            ? "https://api.sandbox.ebay.com"
            : "https://api.ebay.com";
          const userResp = await fetch(`${baseUrl}/commerce/identity/v1/user/`, {
            headers: { Authorization: `Bearer ${accessToken}`,
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US", Accept: "application/json" },
          });
          if (userResp.ok) {
            const userData = await userResp.json();
            ebayUsername = userData.username || null;
          }
        } catch {}
      }

      // Category mappings
      const mappings = await (db as any)
        .select()
        .from(ebayCategoryMappings)
        .where(eq(ebayCategoryMappings.channelId, EBAY_CHANNEL_ID));

      // Product types with product counts
      const client = await pool.connect();
      try {
        const typesResult = await client.query(`
          SELECT pt.id, pt.slug, pt.name, pt.sort_order,
                 COUNT(p.id)::int AS product_count
          FROM product_types pt
          LEFT JOIN catalog.products p ON p.product_type = pt.slug AND p.is_active = true
          GROUP BY pt.id, pt.slug, pt.name, pt.sort_order
          ORDER BY pt.sort_order ASC
        `);

        // Build per-type aspect readiness: for each type that has a browse category,
        // check if all required aspects have corresponding type defaults
        const aspectReadiness: Record<string, { aspectsReady: boolean; missingRequiredCount: number }> = {};
        for (const m of mappings) {
          const slug = m.productTypeSlug || m.product_type_slug;
          const catId = m.ebayBrowseCategoryId || m.ebay_browse_category_id;
          if (!catId) continue;

          // Get required aspects for this category
          const reqResult = await client.query(
            `SELECT aspect_name FROM ebay_category_aspects
             WHERE category_id = $1 AND aspect_required = true`,
            [catId],
          );
          if (reqResult.rows.length === 0) {
            // No cached aspects — check if ANY aspects exist for this category
            const anyAspects = await client.query(
              `SELECT COUNT(*) as cnt FROM ebay_category_aspects WHERE category_id = $1`,
              [catId],
            );
            if (parseInt(anyAspects.rows[0].cnt) === 0) {
              // Aspects never fetched for this category — unknown state, not ready
              aspectReadiness[slug] = { aspectsReady: false, missingRequiredCount: -1 };
              continue;
            }
            // Aspects cached but none are required — genuinely ready
            aspectReadiness[slug] = { aspectsReady: true, missingRequiredCount: 0 };
            continue;
          }

          // Get filled type defaults for this slug
          const tdResult = await client.query(
            `SELECT aspect_name FROM ebay_type_aspect_defaults
             WHERE product_type_slug = $1`,
            [slug],
          );
          const filledSet = new Set(tdResult.rows.map((r: any) => r.aspect_name));

          let missing = 0;
          for (const r of reqResult.rows) {
            if (!filledSet.has(r.aspect_name)) missing++;
          }
          aspectReadiness[slug] = { aspectsReady: missing === 0, missingRequiredCount: missing };
        }

        res.json({
          connected: !!tokenRow?.accessToken,
          channel: channel || null,
          ebayUsername,
          tokenInfo: tokenRow ? {
            accessTokenExpiresAt: tokenRow.accessTokenExpiresAt || tokenRow.access_token_expires_at,
            refreshTokenExpiresAt: tokenRow.refreshTokenExpiresAt || tokenRow.refresh_token_expires_at,
            lastRefreshedAt: tokenRow.lastRefreshedAt || tokenRow.last_refreshed_at,
            environment: tokenRow.environment,
          } : null,
          config: {
            merchantLocationKey: metadata.merchantLocationKey || null,
            fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
            returnPolicyId: metadata.returnPolicyId || null,
            paymentPolicyId: metadata.paymentPolicyId || null,
            merchantLocation: metadata.merchantLocation || null,
          },
          categoryMappings: mappings.map((m: any) => {
            const slug = m.productTypeSlug || m.product_type_slug;
            const readiness = aspectReadiness[slug];
            return {
              id: m.id,
              productTypeSlug: slug,
              ebayBrowseCategoryId: m.ebayBrowseCategoryId || m.ebay_browse_category_id,
              ebayBrowseCategoryName: m.ebayBrowseCategoryName || m.ebay_browse_category_name,
              ebayStoreCategoryId: m.ebayStoreCategoryId || m.ebay_store_category_id,
              ebayStoreCategoryName: m.ebayStoreCategoryName || m.ebay_store_category_name,
              fulfillmentPolicyOverride: m.fulfillmentPolicyOverride || m.fulfillment_policy_override,
              returnPolicyOverride: m.returnPolicyOverride || m.return_policy_override,
              paymentPolicyOverride: m.paymentPolicyOverride || m.payment_policy_override,
              listingEnabled: m.listingEnabled ?? m.listing_enabled ?? true,
              aspectsReady: readiness?.aspectsReady ?? null,
              missingRequiredCount: readiness?.missingRequiredCount ?? null,
            };
          }),
          productTypes: typesResult.rows,
          lastSyncAt: conn?.lastSyncAt || conn?.last_sync_at || null,
          syncStatus: conn?.syncStatus || conn?.sync_status || "never",
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Channel Config] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------

  // PUT /api/ebay/category-mapping — Save category mappings (batch upsert)
  // -----------------------------------------------------------------------
  router.put("/api/ebay/category-mapping", requireAuth, async (req: Request, res: Response) => {
    try {
      const { mappings } = req.body as {
        mappings: Array<{
          productTypeSlug: string;
          ebayBrowseCategoryId?: string;
          ebayBrowseCategoryName?: string;
          ebayStoreCategoryId?: string;
          ebayStoreCategoryName?: string;
          fulfillmentPolicyOverride?: string;
          returnPolicyOverride?: string;
          paymentPolicyOverride?: string;
          listingEnabled?: boolean;
        }>;
      };

      if (!mappings || !Array.isArray(mappings)) {
        res.status(400).json({ error: "mappings array is required" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const m of mappings) {
          await client.query(`
            INSERT INTO ebay_category_mappings (
              channel_id, product_type_slug,
              ebay_browse_category_id, ebay_browse_category_name,
              ebay_store_category_id, ebay_store_category_name,
              fulfillment_policy_override, return_policy_override, payment_policy_override,
              listing_enabled,
              created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
            ON CONFLICT (channel_id, product_type_slug)
            DO UPDATE SET
              ebay_browse_category_id = EXCLUDED.ebay_browse_category_id,
              ebay_browse_category_name = EXCLUDED.ebay_browse_category_name,
              ebay_store_category_id = EXCLUDED.ebay_store_category_id,
              ebay_store_category_name = EXCLUDED.ebay_store_category_name,
              fulfillment_policy_override = EXCLUDED.fulfillment_policy_override,
              return_policy_override = EXCLUDED.return_policy_override,
              payment_policy_override = EXCLUDED.payment_policy_override,
              listing_enabled = EXCLUDED.listing_enabled,
              updated_at = NOW()
          `, [
            EBAY_CHANNEL_ID,
            m.productTypeSlug,
            m.ebayBrowseCategoryId || null,
            m.ebayBrowseCategoryName || null,
            m.ebayStoreCategoryId || null,
            m.ebayStoreCategoryName || null,
            m.fulfillmentPolicyOverride || null,
            m.returnPolicyOverride || null,
            m.paymentPolicyOverride || null,
            m.listingEnabled !== false,
          ]);
        }

        await client.query("COMMIT");
        res.json({ success: true, message: `Saved ${mappings.length} category mapping(s)` });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Category Mapping] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // -----------------------------------------------------------------------
  // POST /api/ebay/sync-store-categories — Create eBay store categories
  // -----------------------------------------------------------------------
  router.post("/api/ebay/sync-store-categories", requireAuth, async (req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const { productTypeNames } = req.body as { productTypeNames: string[] };
      if (!productTypeNames || !productTypeNames.length) {
        res.status(400).json({ error: "productTypeNames array is required" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

      // Build XML for SetStoreCategories
      // Validate store category names — eBay limit is 30 characters
      const tooLong = productTypeNames.filter((name) => name.length > 30);
      if (tooLong.length > 0) {
        res.status(400).json({
          error: "Store category names must be 30 characters or less",
          invalidNames: tooLong.map((name) => ({ name, length: name.length })),
        });
        return;
      }

      const categoriesXml = productTypeNames
        .map((name) => `      <CustomCategory><Name>${escapeXml(name)}</Name></CustomCategory>`)
        .join("\n");

      const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<SetStoreCategoriesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
  <Action>Add</Action>
  <StoreCategories>
${categoriesXml}
  </StoreCategories>
</SetStoreCategoriesRequest>`;

      const resp = await fetch("https://api.ebay.com/ws/api.dll", {
        method: "POST",
        headers: {
          "X-EBAY-API-COMPATIBILITY-LEVEL": "967",
          "X-EBAY-API-CALL-NAME": "SetStoreCategories",
          "X-EBAY-API-SITEID": "0",
          "Content-Type": "text/xml",
        },
        body: xmlBody,
      });

      const xmlText = await resp.text();

      // Check for success
      const ackMatch = xmlText.match(/<Ack>(\w+)<\/Ack>/);
      const ack = ackMatch?.[1] || "Unknown";

      if (ack === "Failure") {
        const errorMsg = xmlText.match(/<LongMessage>([^<]+)<\/LongMessage>/)?.[1] || "Unknown error";
        res.status(400).json({
          success: false,
          error: errorMsg,
          ack,
          rawResponse: xmlText.substring(0, 2000),
        });
        return;
      }

      // Parse the task ID if async
      const taskIdMatch = xmlText.match(/<TaskID>(\d+)<\/TaskID>/);

      res.json({
        success: true,
        ack,
        taskId: taskIdMatch?.[1] || null,
        message: `Requested creation of ${productTypeNames.length} store categories`,
        categoriesRequested: productTypeNames,
      });
    } catch (err: any) {
      console.error("[eBay Sync Store Categories] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-category/:productId — Set per-product category override
  // -----------------------------------------------------------------------
  router.put("/api/ebay/product-category/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const { ebayBrowseCategoryId, ebayBrowseCategoryName } = req.body as {
        ebayBrowseCategoryId: string | null;
        ebayBrowseCategoryName: string | null;
      };
      const client = await pool.connect();
      try {
        await client.query(
          "UPDATE catalog.products SET ebay_browse_category_id = $1, ebay_browse_category_name = $2 WHERE id = $3",
          [ebayBrowseCategoryId || null, ebayBrowseCategoryName || null, productId]
        );
        res.json({ success: true, productId, ebayBrowseCategoryId: ebayBrowseCategoryId || null, ebayBrowseCategoryName: ebayBrowseCategoryName || null });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Product Category Override] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // -----------------------------------------------------------------------
  // PUT /api/ebay/variant-exclusion/:variantId — Toggle per-variant eBay exclusion
  // -----------------------------------------------------------------------
  router.put("/api/ebay/variant-exclusion/:variantId", requireAuth, async (req: Request, res: Response) => {
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId)) {
        res.status(400).json({ error: "Invalid variant ID" });
        return;
      }
      const { excluded } = req.body as { excluded: boolean };
      if (typeof excluded !== "boolean") {
        res.status(400).json({ error: "excluded (boolean) is required" });
        return;
      }
      const client = await pool.connect();
      try {
        await client.query(
          "UPDATE catalog.product_variants SET ebay_listing_excluded = $1 WHERE id = $2",
          [excluded, variantId]
        );
        res.json({ success: true, variantId, excluded });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Variant Exclusion] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });


  // PUT /api/ebay/toggle-type-listing/:productTypeSlug — Toggle listingEnabled for a product type
  // -----------------------------------------------------------------------
  router.put("/api/ebay/toggle-type-listing/:productTypeSlug", requireAuth, async (req: Request, res: Response) => {
    try {
      const { productTypeSlug } = req.params;
      if (!productTypeSlug) {
        res.status(400).json({ error: "productTypeSlug is required" });
        return;
      }
      const { listingEnabled } = req.body as { listingEnabled: boolean };
      if (typeof listingEnabled !== "boolean") {
        res.status(400).json({ error: "listingEnabled (boolean) is required" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query(`
          INSERT INTO ebay_category_mappings (
            channel_id, product_type_slug, listing_enabled, created_at, updated_at
          ) VALUES ($1, $2, $3, NOW(), NOW())
          ON CONFLICT (channel_id, product_type_slug)
          DO UPDATE SET listing_enabled = EXCLUDED.listing_enabled, updated_at = NOW()
        `, [EBAY_CHANNEL_ID, productTypeSlug, listingEnabled]);

        res.json({ success: true, productTypeSlug, listingEnabled });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Toggle Type Listing] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

