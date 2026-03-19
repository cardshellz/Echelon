/**
 * eBay Channel Configuration Routes
 *
 * Full channel config: connection, category mappings, listing feed.
 *
 * GET  /api/ebay/channel-config          — Full eBay channel config
 * PUT  /api/ebay/category-mapping        — Save category mappings (batch)
 * POST /api/ebay/sync-store-categories   — Create eBay store categories from product types
 * GET  /api/ebay/listing-feed            — Products with type assignments for feed view
 */

import type { Express, Request, Response } from "express";
import { eq, and, sql, asc, isNotNull } from "drizzle-orm";
import { db, pool } from "../db";
import {
  channels,
  channelConnections,
  ebayOauthTokens,
  ebayCategoryMappings,
  products,
  productVariants,
  productTypes,
} from "@shared/schema";
import {
  EbayAuthService,
  createEbayAuthConfig,
} from "../modules/channels/adapters/ebay/ebay-auth.service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EBAY_CHANNEL_ID = 67;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthService(): EbayAuthService | null {
  try {
    const config = createEbayAuthConfig();
    return new EbayAuthService(db as any, config);
  } catch {
    return null;
  }
}

async function getChannelConnection() {
  const [conn] = await (db as any)
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, EBAY_CHANNEL_ID))
    .limit(1);
  return conn || null;
}

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export function registerEbayChannelRoutes(app: Express): void {

  // -----------------------------------------------------------------------
  // GET /api/ebay/channel-config — Full eBay channel configuration
  // -----------------------------------------------------------------------
  app.get("/api/ebay/channel-config", async (_req: Request, res: Response) => {
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
            headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
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
          LEFT JOIN products p ON p.product_type = pt.slug AND p.is_active = true
          GROUP BY pt.id, pt.slug, pt.name, pt.sort_order
          ORDER BY pt.sort_order ASC
        `);

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
          categoryMappings: mappings.map((m: any) => ({
            id: m.id,
            productTypeSlug: m.productTypeSlug || m.product_type_slug,
            ebayBrowseCategoryId: m.ebayBrowseCategoryId || m.ebay_browse_category_id,
            ebayBrowseCategoryName: m.ebayBrowseCategoryName || m.ebay_browse_category_name,
            ebayStoreCategoryId: m.ebayStoreCategoryId || m.ebay_store_category_id,
            ebayStoreCategoryName: m.ebayStoreCategoryName || m.ebay_store_category_name,
            fulfillmentPolicyOverride: m.fulfillmentPolicyOverride || m.fulfillment_policy_override,
            returnPolicyOverride: m.returnPolicyOverride || m.return_policy_override,
            paymentPolicyOverride: m.paymentPolicyOverride || m.payment_policy_override,
            listingEnabled: m.listingEnabled ?? m.listing_enabled ?? true,
          })),
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
  app.put("/api/ebay/category-mapping", async (req: Request, res: Response) => {
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
  app.post("/api/ebay/sync-store-categories", async (req: Request, res: Response) => {
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
  app.put("/api/ebay/product-category/:productId", async (req: Request, res: Response) => {
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
          "UPDATE products SET ebay_browse_category_id = $1, ebay_browse_category_name = $2 WHERE id = $3",
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
  // GET /api/ebay/listing-feed — Products with types for listing feed
  // -----------------------------------------------------------------------
  app.get("/api/ebay/listing-feed", async (req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      try {
        // Get products that have a product_type assigned
        const result = await client.query(`
          SELECT
            p.id,
            p.name,
            p.sku,
            p.product_type,
            p.is_active,
            pt.name AS product_type_name,
            p.ebay_browse_category_id AS product_ebay_browse_category_id,
            p.ebay_browse_category_name AS product_ebay_browse_category_name,
            ecm.ebay_browse_category_id,
            ecm.ebay_browse_category_name,
            ecm.ebay_store_category_id,
            ecm.ebay_store_category_name,
            (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.sku IS NOT NULL) AS variant_count,
            (SELECT COUNT(*) FROM product_assets pa WHERE pa.product_id = p.id) AS image_count,
            cl.id AS listing_id,
            cl.sync_status AS listing_status,
            cl.external_product_id,
            p.ebay_listing_excluded,
            COALESCE(ecm.listing_enabled, true) AS type_listing_enabled
          FROM products p
          LEFT JOIN product_types pt ON pt.slug = p.product_type
          LEFT JOIN ebay_category_mappings ecm ON ecm.product_type_slug = p.product_type AND ecm.channel_id = $1
          LEFT JOIN LATERAL (
            SELECT cl2.id, cl2.sync_status, cl2.external_product_id
            FROM channel_listings cl2
            JOIN product_variants pv2 ON pv2.id = cl2.product_variant_id
            WHERE pv2.product_id = p.id AND cl2.channel_id = $1
            LIMIT 1
          ) cl ON true
          WHERE p.is_active = true AND p.product_type IS NOT NULL
          ORDER BY pt.sort_order ASC, p.name ASC
        `, [EBAY_CHANNEL_ID]);

        // Determine readiness for each product
        const feed = result.rows.map((row: any) => {
          // Effective category: product override wins, then type mapping
          const effectiveCategoryId = row.product_ebay_browse_category_id || row.ebay_browse_category_id || null;
          const effectiveCategoryName = row.product_ebay_browse_category_name || row.ebay_browse_category_name || null;

          const hasCategoryMapping = !!effectiveCategoryId;
          const hasVariants = (row.variant_count || 0) > 0;
          const hasImages = (row.image_count || 0) > 0;
          const isListed = !!row.listing_id && row.listing_status === "synced";

          const isExcluded = row.ebay_listing_excluded === true;
          const isTypeDisabled = row.type_listing_enabled === false;

          let status: string;
          if (isExcluded) status = "excluded";
          else if (isTypeDisabled) status = "type_disabled";
          else if (isListed) status = "listed";
          else if (hasCategoryMapping && hasVariants && hasImages) status = "ready";
          else status = "missing_config";

          const missingItems: string[] = [];
          if (!hasCategoryMapping) missingItems.push("eBay category");
          if (!hasVariants) missingItems.push("variants");
          if (!hasImages) missingItems.push("images");

          return {
            id: row.id,
            name: row.name,
            sku: row.sku,
            productType: row.product_type,
            productTypeName: row.product_type_name,
            ebayBrowseCategoryId: effectiveCategoryId,
            ebayBrowseCategoryName: effectiveCategoryName,
            ebayBrowseCategoryOverrideId: row.product_ebay_browse_category_id || null,
            ebayBrowseCategoryOverrideName: row.product_ebay_browse_category_name || null,
            ebayStoreCategoryName: row.ebay_store_category_name,
            status,
            missingItems,
            isListed,
            isExcluded,
            externalListingId: row.external_product_id,
            variantCount: parseInt(row.variant_count) || 0,
            imageCount: parseInt(row.image_count) || 0,
          };
        });

        res.json({ feed, total: feed.length });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Listing Feed] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/toggle-type-listing/:productTypeSlug — Toggle listingEnabled for a product type
  // -----------------------------------------------------------------------
  app.put("/api/ebay/toggle-type-listing/:productTypeSlug", async (req: Request, res: Response) => {
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

  // -----------------------------------------------------------------------
  // GET /api/ebay/category-search — Search eBay browse categories (Taxonomy API)
  // -----------------------------------------------------------------------
  app.get("/api/ebay/category-search", async (req: Request, res: Response) => {
    try {
      const q = (req.query.q as string || "").trim();
      if (!q || q.length < 2) {
        res.json({ categories: [] });
        return;
      }

      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      const environment = process.env.EBAY_ENVIRONMENT || "production";
      const baseUrl = environment === "sandbox"
        ? "https://api.sandbox.ebay.com"
        : "https://api.ebay.com";

      const url = `${baseUrl}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(q)}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[eBay Category Search] API error:", resp.status, errText);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const suggestions = data.categorySuggestions || [];

      const categories = suggestions.slice(0, 10).map((s: any) => {
        const cat = s.category || {};
        const ancestors = s.categoryTreeNodeAncestors || [];
        // Build breadcrumb from ancestors (root → leaf)
        const ancestorNames = ancestors
          .sort((a: any, b: any) => (b.categoryTreeNodeLevel || 0) - (a.categoryTreeNodeLevel || 0))
          .map((a: any) => a.categoryName);
        const breadcrumb = [...ancestorNames, cat.categoryName].join(" > ");
        return {
          categoryId: cat.categoryId,
          categoryName: cat.categoryName,
          breadcrumb,
        };
      });

      res.json({ categories });
    } catch (err: any) {
      console.error("[eBay Category Search] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-exclusion/:productId — Toggle individual product exclusion
  // -----------------------------------------------------------------------
  app.put("/api/ebay/product-exclusion/:productId", async (req: Request, res: Response) => {
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
          "UPDATE products SET ebay_listing_excluded = $1 WHERE id = $2",
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
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
