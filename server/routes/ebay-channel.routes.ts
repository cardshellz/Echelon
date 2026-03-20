/**
 * eBay Channel Configuration Routes
 *
 * Full channel config: connection, category mappings, listing feed.
 *
 * GET  /api/ebay/channel-config          — Full eBay channel config
 * PUT  /api/ebay/category-mapping        — Save category mappings (batch)
 * POST /api/ebay/sync-store-categories   — Create eBay store categories from product types
 * GET  /api/ebay/listing-feed            — Products with type assignments for feed view
 * GET  /api/ebay/category-tree           — Root-level eBay categories (Taxonomy API)
 * GET  /api/ebay/category-tree/:id/children — Children of a category (Taxonomy API)
 */

import type { Express, Request, Response } from "express";
import { eq, and, sql, asc, isNotNull } from "drizzle-orm";
import https from "https";
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
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Category tree cache (module-level, 1-hour TTL)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const categoryTreeCache: Map<string, CacheEntry<any>> = new Map();

function getCached<T>(key: string): T | null {
  const entry = categoryTreeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    categoryTreeCache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  categoryTreeCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

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
// eBay REST API helper (uses https module, not fetch)
// ---------------------------------------------------------------------------

function ebayApiRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<any> {
  const environment = process.env.EBAY_ENVIRONMENT || "production";
  const hostname =
    environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode === 204) {
          resolve(undefined);
          return;
        }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : undefined);
          } catch {
            resolve(data);
          }
          return;
        }
        reject(
          new Error(
            `eBay API ${method} ${path} failed (${res.statusCode}): ${data.substring(0, 1000)}`,
          ),
        );
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
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
          LEFT JOIN products p ON p.product_type = pt.slug AND p.is_active = true
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
  // PUT /api/ebay/variant-exclusion/:variantId — Toggle per-variant eBay exclusion
  // -----------------------------------------------------------------------
  app.put("/api/ebay/variant-exclusion/:variantId", async (req: Request, res: Response) => {
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
          "UPDATE product_variants SET ebay_listing_excluded = $1 WHERE id = $2",
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

        // Fetch variants for all products in the feed
        const productIds = result.rows.map((r: any) => r.id);
        let variantsByProduct: Map<number, any[]> = new Map();
        if (productIds.length > 0) {
          const varResult = await client.query(`
            SELECT
              pv.id,
              pv.product_id,
              pv.sku,
              pv.name,
              pv.price_cents,
              pv.ebay_listing_excluded,
              COALESCE(
                (SELECT SUM(il.variant_qty - il.reserved_qty - il.picked_qty - il.packed_qty)::int
                 FROM inventory_levels il WHERE il.product_variant_id = pv.id),
                0
              ) AS inventory_quantity
            FROM product_variants pv
            WHERE pv.product_id = ANY($1) AND pv.sku IS NOT NULL
            ORDER BY pv.product_id, pv.position ASC, pv.id ASC
          `, [productIds]);

          for (const v of varResult.rows) {
            const pid = v.product_id;
            if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
            variantsByProduct.get(pid)!.push({
              id: v.id,
              sku: v.sku,
              name: v.name,
              priceCents: v.price_cents,
              ebayListingExcluded: v.ebay_listing_excluded === true,
              inventoryQuantity: Math.max(0, parseInt(v.inventory_quantity) || 0),
            });
          }
        }

        // Fetch required aspects per category and type defaults + product overrides
        // Build lookup maps for aspect checking
        const categoryIds = new Set<string>();
        const productTypeSlugs = new Set<string>();
        const feedProductIds = result.rows.map((r: any) => r.id);

        for (const row of result.rows) {
          const catId = row.product_ebay_browse_category_id || row.ebay_browse_category_id;
          if (catId) categoryIds.add(catId);
          if (row.product_type) productTypeSlugs.add(row.product_type);
        }

        // Required aspects per category
        const requiredAspectsByCategory: Map<string, string[]> = new Map();
        if (categoryIds.size > 0) {
          const catIdsArr = Array.from(categoryIds);
          const reqResult = await client.query(
            `SELECT category_id, aspect_name FROM ebay_category_aspects
             WHERE category_id = ANY($1) AND aspect_required = true`,
            [catIdsArr],
          );
          for (const r of reqResult.rows) {
            const existing = requiredAspectsByCategory.get(r.category_id) || [];
            existing.push(r.aspect_name);
            requiredAspectsByCategory.set(r.category_id, existing);
          }
        }

        // Type defaults per slug
        const typeDefaultsBySlug: Map<string, Set<string>> = new Map();
        if (productTypeSlugs.size > 0) {
          const slugsArr = Array.from(productTypeSlugs);
          const tdResult = await client.query(
            `SELECT product_type_slug, aspect_name FROM ebay_type_aspect_defaults
             WHERE product_type_slug = ANY($1)`,
            [slugsArr],
          );
          for (const r of tdResult.rows) {
            if (!typeDefaultsBySlug.has(r.product_type_slug))
              typeDefaultsBySlug.set(r.product_type_slug, new Set());
            typeDefaultsBySlug.get(r.product_type_slug)!.add(r.aspect_name);
          }
        }

        // Product overrides per product
        const overridesByProduct: Map<number, Set<string>> = new Map();
        if (feedProductIds.length > 0) {
          const poResult = await client.query(
            `SELECT product_id, aspect_name FROM ebay_product_aspect_overrides
             WHERE product_id = ANY($1)`,
            [feedProductIds],
          );
          for (const r of poResult.rows) {
            if (!overridesByProduct.has(r.product_id))
              overridesByProduct.set(r.product_id, new Set());
            overridesByProduct.get(r.product_id)!.add(r.aspect_name);
          }
        }

        // Determine readiness for each product
        const feed = result.rows.map((row: any) => {
          // Effective category: product override wins, then type mapping
          const effectiveCategoryId = row.product_ebay_browse_category_id || row.ebay_browse_category_id || null;
          const effectiveCategoryName = row.product_ebay_browse_category_name || row.ebay_browse_category_name || null;

          const hasCategoryMapping = !!effectiveCategoryId;
          const hasVariants = (row.variant_count || 0) > 0;
          const hasImages = (row.image_count || 0) > 0;
          const isListed = !!row.listing_id && row.listing_status === "synced";
          const isEnded = !!row.listing_id && (row.listing_status === "ended" || row.listing_status === "deleted");
          const listingSyncStatus = row.listing_status;

          const isExcluded = row.ebay_listing_excluded === true;
          const isTypeDisabled = row.type_listing_enabled === false;

          // Check for missing required aspects
          const missingAspects: string[] = [];
          if (effectiveCategoryId) {
            const requiredAspects = requiredAspectsByCategory.get(effectiveCategoryId) || [];
            const filledTypeDefaults = typeDefaultsBySlug.get(row.product_type) || new Set();
            const filledOverrides = overridesByProduct.get(row.id) || new Set();
            // Auto-mapped: Brand (if product has brand)
            const autoMapped = new Set<string>();
            // We can't check product.brand here efficiently, but Brand is usually
            // set as a type default. We'll just check type + product overrides.
            for (const reqAspect of requiredAspects) {
              if (!filledTypeDefaults.has(reqAspect) && !filledOverrides.has(reqAspect) && !autoMapped.has(reqAspect)) {
                missingAspects.push(reqAspect);
              }
            }
          }

          let status: string;
          if (isExcluded) status = "excluded";
          else if (isTypeDisabled) status = "type_disabled";
          else if (isListed) status = "listed";
          else if (isEnded) {
            // Ended/deleted listings are re-pushable — treat as ready if they meet all requirements
            if (!hasCategoryMapping || !hasVariants || !hasImages) status = "missing_config";
            else if (missingAspects.length > 0) status = "missing_specifics";
            else status = "ready"; // Can be re-listed
          }
          else if (!hasCategoryMapping || !hasVariants || !hasImages) status = "missing_config";
          else if (missingAspects.length > 0) status = "missing_specifics";
          else status = "ready";

          const missingItems: string[] = [];
          if (!hasCategoryMapping) missingItems.push("eBay category");
          if (!hasVariants) missingItems.push("variants");
          if (!hasImages) missingItems.push("images");

          const variants = variantsByProduct.get(row.id) || [];
          const includedVariantCount = variants.filter((v: any) => !v.ebayListingExcluded).length;

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
            missingAspects,
            isListed,
            isExcluded,
            externalListingId: row.external_product_id,
            variantCount: parseInt(row.variant_count) || 0,
            includedVariantCount,
            imageCount: parseInt(row.image_count) || 0,
            variants,
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
  // GET /api/ebay/category-tree — Root-level eBay categories (Taxonomy API)
  // -----------------------------------------------------------------------
  app.get("/api/ebay/category-tree", async (_req: Request, res: Response) => {
    try {
      const cached = getCached<any>("root");
      if (cached) {
        res.json(cached);
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

      const url = `${baseUrl}/commerce/taxonomy/v1/category_tree/0`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US",
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[eBay Category Tree] API error:", resp.status, errText);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const rootNode = data.rootCategoryNode;
      if (!rootNode || !rootNode.childCategoryTreeNodes) {
        res.json({ categories: [] });
        return;
      }

      const categories = rootNode.childCategoryTreeNodes.map((node: any) => ({
        categoryId: node.category?.categoryId,
        categoryName: node.category?.categoryName,
        hasChildren: !!(node.childCategoryTreeNodes && node.childCategoryTreeNodes.length > 0),
      }));

      const result = { categories };
      setCache("root", result);
      res.json(result);
    } catch (err: any) {
      console.error("[eBay Category Tree] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/category-tree/:categoryId/children — Children of a category
  // -----------------------------------------------------------------------
  app.get("/api/ebay/category-tree/:categoryId/children", async (req: Request, res: Response) => {
    try {
      const { categoryId } = req.params;
      if (!categoryId) {
        res.status(400).json({ error: "categoryId is required" });
        return;
      }

      const cacheKey = `children:${categoryId}`;
      const cached = getCached<any>(cacheKey);
      if (cached) {
        res.json(cached);
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

      const url = `${baseUrl}/commerce/taxonomy/v1/category_tree/0/get_category_subtree?category_id=${encodeURIComponent(categoryId)}`;
      const resp = await fetch(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US",
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        const errText = await resp.text();
        console.error("[eBay Category Children] API error:", resp.status, errText);
        res.status(resp.status).json({ error: `eBay API error: ${resp.status}` });
        return;
      }

      const data = await resp.json();
      const rootNode = data.categorySubtreeNode;
      if (!rootNode) {
        res.json({ categories: [], breadcrumb: "" });
        return;
      }

      // Build breadcrumb from ancestors
      const ancestors = data.categoryTreeNodeAncestors || [];
      const ancestorNames = ancestors
        .sort((a: any, b: any) => (b.categoryTreeNodeLevel || 0) - (a.categoryTreeNodeLevel || 0))
        .map((a: any) => a.categoryName);
      const breadcrumb = [...ancestorNames, rootNode.category?.categoryName].join(" > ");

      // Extract DIRECT children only
      const childNodes = rootNode.childCategoryTreeNodes || [];
      const categories = childNodes.map((node: any) => ({
        categoryId: node.category?.categoryId,
        categoryName: node.category?.categoryName,
        parentId: categoryId,
        hasChildren: !!(node.childCategoryTreeNodes && node.childCategoryTreeNodes.length > 0),
        breadcrumb,
      }));

      const result = { categories, breadcrumb };
      setCache(cacheKey, result);
      res.json(result);
    } catch (err: any) {
      console.error("[eBay Category Children] Error:", err.message);
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
                    "Content-Language": "en-US",
                    "Accept-Language": "en-US",
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
  // GET /api/ebay/category-aspects/:categoryId — Cached eBay aspect definitions
  // -----------------------------------------------------------------------
  app.get("/api/ebay/category-aspects/:categoryId", async (req: Request, res: Response) => {
    try {
      const { categoryId } = req.params;
      if (!categoryId) {
        res.status(400).json({ error: "categoryId is required" });
        return;
      }

      const client = await pool.connect();
      try {
        // Check cache freshness (24 hours)
        const cacheCheck = await client.query(
          `SELECT fetched_at FROM ebay_category_aspects
           WHERE category_id = $1 LIMIT 1`,
          [categoryId],
        );

        const isFresh =
          cacheCheck.rows.length > 0 &&
          Date.now() - new Date(cacheCheck.rows[0].fetched_at).getTime() <
            24 * 60 * 60 * 1000;

        if (!isFresh) {
          // Fetch from eBay Taxonomy API
          const authService = getAuthService();
          if (!authService) {
            res.status(500).json({ error: "eBay OAuth not configured" });
            return;
          }
          const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

          const apiPath = `/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`;
          const data = await ebayApiRequest("GET", apiPath, accessToken);

          // Parse and upsert aspects
          const aspects: Array<{
            name: string;
            required: boolean;
            mode: string;
            usage: string;
            values: string[] | null;
            order: number;
          }> = [];

          if (data && data.aspects) {
            for (let i = 0; i < data.aspects.length; i++) {
              const a = data.aspects[i];
              const constraint = a.aspectConstraint || {};
              const name = a.localizedAspectName || "";
              if (!name) continue;

              const required =
                constraint.aspectRequired === true ||
                constraint.aspectUsage === "REQUIRED";
              const mode = constraint.aspectMode || "FREE_TEXT";
              const usage = constraint.aspectUsage || "RECOMMENDED";

              // Extract allowed values
              let values: string[] | null = null;
              if (a.aspectValues && Array.isArray(a.aspectValues)) {
                values = a.aspectValues
                  .map((v: any) => v.localizedValue)
                  .filter(Boolean);
              }

              aspects.push({
                name,
                required,
                mode,
                usage,
                values,
                order: i,
              });
            }
          }

          // Delete old + insert fresh (transactional)
          await client.query("BEGIN");
          await client.query(
            "DELETE FROM ebay_category_aspects WHERE category_id = $1",
            [categoryId],
          );
          for (const a of aspects) {
            await client.query(
              `INSERT INTO ebay_category_aspects
                 (category_id, aspect_name, aspect_required, aspect_mode, aspect_usage, aspect_values, aspect_order, fetched_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
              [
                categoryId,
                a.name,
                a.required,
                a.mode,
                a.usage,
                a.values ? JSON.stringify(a.values) : null,
                a.order,
              ],
            );
          }
          await client.query("COMMIT");
        }

        // Return cached aspects
        const result = await client.query(
          `SELECT aspect_name, aspect_required, aspect_mode, aspect_usage, aspect_values, aspect_order
           FROM ebay_category_aspects
           WHERE category_id = $1
           ORDER BY aspect_required DESC, aspect_order ASC`,
          [categoryId],
        );

        const aspects = result.rows.map((r: any) => ({
          name: r.aspect_name,
          required: r.aspect_required,
          mode: r.aspect_mode,
          usage: r.aspect_usage,
          values: r.aspect_values || null,
          order: r.aspect_order,
        }));

        res.json({ aspects, categoryId });
      } catch (err: any) {
        // Rollback if we were in a transaction
        try {
          await client.query("ROLLBACK");
        } catch {}
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Category Aspects] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/type-aspect-defaults/:productTypeSlug
  // -----------------------------------------------------------------------
  app.get("/api/ebay/type-aspect-defaults/:productTypeSlug", async (req: Request, res: Response) => {
    try {
      const { productTypeSlug } = req.params;
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT aspect_name, aspect_value FROM ebay_type_aspect_defaults
           WHERE product_type_slug = $1`,
          [productTypeSlug],
        );
        const defaults: Record<string, string> = {};
        for (const r of result.rows) {
          defaults[r.aspect_name] = r.aspect_value;
        }
        res.json({ defaults });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Type Aspect Defaults] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/type-aspect-defaults/:productTypeSlug
  // -----------------------------------------------------------------------
  app.put("/api/ebay/type-aspect-defaults/:productTypeSlug", async (req: Request, res: Response) => {
    try {
      const { productTypeSlug } = req.params;
      const { defaults } = req.body as { defaults: Record<string, string> };
      if (!defaults || typeof defaults !== "object") {
        res.status(400).json({ error: "defaults object is required" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Delete all existing for this slug
        await client.query(
          "DELETE FROM ebay_type_aspect_defaults WHERE product_type_slug = $1",
          [productTypeSlug],
        );

        // Insert new
        const entries = Object.entries(defaults).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        for (const [name, value] of entries) {
          await client.query(
            `INSERT INTO ebay_type_aspect_defaults (product_type_slug, aspect_name, aspect_value, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [productTypeSlug, name, value],
          );
        }

        await client.query("COMMIT");

        // Return updated defaults
        const result: Record<string, string> = {};
        for (const [name, value] of entries) {
          result[name] = value;
        }
        res.json({ defaults: result });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Type Aspect Defaults Save] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/product-aspects/:productId
  // -----------------------------------------------------------------------
  app.get("/api/ebay/product-aspects/:productId", async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT aspect_name, aspect_value FROM ebay_product_aspect_overrides
           WHERE product_id = $1`,
          [productId],
        );
        const overrides: Record<string, string> = {};
        for (const r of result.rows) {
          overrides[r.aspect_name] = r.aspect_value;
        }
        res.json({ overrides });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Product Aspects] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // PUT /api/ebay/product-aspects/:productId
  // -----------------------------------------------------------------------
  app.put("/api/ebay/product-aspects/:productId", async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const { overrides } = req.body as { overrides: Record<string, string> };
      if (!overrides || typeof overrides !== "object") {
        res.status(400).json({ error: "overrides object is required" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Delete all existing for this product
        await client.query(
          "DELETE FROM ebay_product_aspect_overrides WHERE product_id = $1",
          [productId],
        );

        // Insert new
        const entries = Object.entries(overrides).filter(
          ([, v]) => v !== undefined && v !== null && v !== "",
        );
        for (const [name, value] of entries) {
          await client.query(
            `INSERT INTO ebay_product_aspect_overrides (product_id, aspect_name, aspect_value, created_at, updated_at)
             VALUES ($1, $2, $3, NOW(), NOW())`,
            [productId, name, value],
          );
        }

        await client.query("COMMIT");

        const result: Record<string, string> = {};
        for (const [name, value] of entries) {
          result[name] = value;
        }
        res.json({ overrides: result });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Product Aspects Save] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/push — Push products to eBay (create listings)
  //   Supports multi-variant listings via eBay Inventory Item Groups.
  //   All eBay API calls use ebayApiRequest (https module).
  // -----------------------------------------------------------------------
  app.post("/api/ebay/listings/push", async (req: Request, res: Response) => {
    try {
      const { productIds } = req.body as { productIds: number[] };
      if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
        res.status(400).json({ error: "productIds array is required" });
        return;
      }

      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay OAuth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

      // Get connection metadata (default policies)
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};
      const defaultPolicies = {
        fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
        returnPolicyId: metadata.returnPolicyId || null,
        paymentPolicyId: metadata.paymentPolicyId || null,
      };
      const merchantLocationKey = metadata.merchantLocationKey || "card-shellz-hq";

      const client = await pool.connect();
      const results: Array<{
        productId: number;
        productName: string;
        variantCount: number;
        success: boolean;
        listingId?: string;
        offerId?: string;
        error?: string;
        variantDetails?: Array<{ sku: string; success: boolean; error?: string }>;
      }> = [];

      try {
        for (const productId of productIds) {
          // 1. Fetch product
          const prodResult = await client.query(
            `SELECT id, name, sku, description, brand, product_type, ebay_browse_category_id
             FROM products WHERE id = $1 AND is_active = true`,
            [productId],
          );
          if (prodResult.rows.length === 0) {
            results.push({ productId, productName: "", variantCount: 0, success: false, error: "Product not found or inactive" });
            continue;
          }
          const product = prodResult.rows[0];

          // 2. Fetch variants (skip excluded)
          const varResult = await client.query(
            `SELECT id, sku, name, option1_name, option1_value, option2_name, option2_value,
                    price_cents, compare_at_price_cents, weight_grams, barcode,
                    units_per_variant, hierarchy_level
             FROM product_variants WHERE product_id = $1 AND sku IS NOT NULL
               AND COALESCE(ebay_listing_excluded, false) = false
             ORDER BY position ASC, id ASC`,
            [productId],
          );
          if (varResult.rows.length === 0) {
            results.push({ productId, productName: product.name, variantCount: 0, success: false, error: "No eligible variants" });
            continue;
          }

          // 3. Fetch images
          const imgResult = await client.query(
            `SELECT url FROM product_assets WHERE product_id = $1 ORDER BY position ASC`,
            [productId],
          );
          const imageUrls = imgResult.rows
            .map((r: any) => r.url)
            .filter((url: string) => url && url.startsWith("https://"))
            .slice(0, 12); // eBay max 12

          // 4. Fetch effective eBay category + policies
          let ebayBrowseCategoryId = product.ebay_browse_category_id;
          let storeCategoryNames: string[] = [];
          let effectivePolicies = { ...defaultPolicies };

          if (product.product_type) {
            const catResult = await client.query(
              `SELECT ebay_browse_category_id, ebay_store_category_name,
                      fulfillment_policy_override, return_policy_override, payment_policy_override
               FROM ebay_category_mappings
               WHERE channel_id = $1 AND product_type_slug = $2`,
              [EBAY_CHANNEL_ID, product.product_type],
            );
            if (catResult.rows.length > 0) {
              const catRow = catResult.rows[0];
              if (!ebayBrowseCategoryId) ebayBrowseCategoryId = catRow.ebay_browse_category_id;
              if (catRow.ebay_store_category_name) storeCategoryNames = [catRow.ebay_store_category_name];
              if (catRow.fulfillment_policy_override) effectivePolicies.fulfillmentPolicyId = catRow.fulfillment_policy_override;
              if (catRow.return_policy_override) effectivePolicies.returnPolicyId = catRow.return_policy_override;
              if (catRow.payment_policy_override) effectivePolicies.paymentPolicyId = catRow.payment_policy_override;
            }
          }

          if (!ebayBrowseCategoryId) {
            results.push({ productId, productName: product.name, variantCount: 0, success: false, error: "No eBay browse category configured" });
            continue;
          }

          // 5. Build product-level aspects: product override > type default > auto-mapped
          const aspects: Record<string, string[]> = {};
          if (product.brand) aspects["Brand"] = [product.brand];

          if (product.product_type) {
            const typeDefaults = await client.query(
              `SELECT aspect_name, aspect_value FROM ebay_type_aspect_defaults WHERE product_type_slug = $1`,
              [product.product_type],
            );
            for (const td of typeDefaults.rows) aspects[td.aspect_name] = [td.aspect_value];
          }
          const prodOverrides = await client.query(
            `SELECT aspect_name, aspect_value FROM ebay_product_aspect_overrides WHERE product_id = $1`,
            [productId],
          );
          for (const po of prodOverrides.rows) aspects[po.aspect_name] = [po.aspect_value];

          const variants = varResult.rows;
          const isMultiVariant = variants.length > 1;
          const variantDetails: Array<{ sku: string; success: boolean; error?: string }> = [];

          // 6. Resolve prices via pricing rules
          const variantPrices: Map<number, number> = new Map();
          for (const v of variants) {
            const resolved = await resolveChannelPrice(client, EBAY_CHANNEL_ID, productId, v.id, v.price_cents);
            variantPrices.set(v.id, resolved);
          }

          // Determine the variation aspect name for multi-variant products
          const variationAspectName = isMultiVariant ? determineVariationAspectName(variants) : "";

          // ---- Step A: Create/Update Inventory Items for each variant ----
          let allItemsCreated = true;
          for (const variant of variants) {
            const sku = variant.sku;
            try {
              const invResult = await client.query(
                `SELECT COALESCE(SUM(il.variant_qty - il.reserved_qty - il.picked_qty - il.packed_qty), 0)::int AS available_qty
                 FROM inventory_levels il WHERE il.product_variant_id = $1`,
                [variant.id],
              );
              const availableQty = Math.max(0, invResult.rows[0]?.available_qty || 0);
              const priceCents = variantPrices.get(variant.id) || variant.price_cents;
              const priceInDollars = (priceCents / 100).toFixed(2);

              // Per-variant aspects: include the variation aspect value for multi-variant
              const variantAspects: Record<string, string[]> = { ...aspects };
              if (isMultiVariant) {
                const variationValue = variant.option1_value || variant.name || sku;
                variantAspects[variationAspectName] = [variationValue];
              }

              const inventoryItemBody: Record<string, any> = {
                condition: "NEW",
                product: {
                  title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                  ...(imageUrls.length > 0 ? { imageUrls } : {}),
                  aspects: variantAspects,
                },
                availability: {
                  shipToLocationAvailability: { quantity: availableQty },
                },
              };

              // For single-variant, include description on the inventory item
              if (!isMultiVariant) {
                inventoryItemBody.product.description = product.description || `<p>${product.name}</p>`;
              }

              console.log(`[eBay Push] Creating inventory item for SKU: ${sku}`);
              await ebayApiRequest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken, inventoryItemBody);
              console.log(`[eBay Push] Inventory item created/updated: ${sku}`);

              // Save listing record per variant
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalSku: sku,
                lastSyncedPrice: priceCents,
                lastSyncedQty: availableQty,
                syncStatus: "pending",
              });

              variantDetails.push({ sku, success: true });
            } catch (err: any) {
              console.error(`[eBay Push] Inventory item failed for ${sku}:`, err.message);
              allItemsCreated = false;
              variantDetails.push({ sku, success: false, error: err.message.substring(0, 500) });

              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                syncStatus: "error",
                syncError: `Inventory item failed: ${err.message.substring(0, 1000)}`,
              });
            }
          }

          if (!allItemsCreated && variantDetails.every((v) => !v.success)) {
            results.push({
              productId, productName: product.name, variantCount: variants.length,
              success: false, error: "All inventory items failed to create", variantDetails,
            });
            continue;
          }

          const successfulSkus = variantDetails.filter((v) => v.success).map((v) => v.sku);

          // ---- Step B: Multi-variant -> Create Inventory Item Group ----
          if (isMultiVariant && successfulSkus.length > 1) {
            try {
              const groupKey = `PROD-${productId}`;

              // Build variesBy specification
              const variationValues = variants
                .filter((v: any) => successfulSkus.includes(v.sku))
                .map((v: any) => v.option1_value || v.name || v.sku);

              const groupBody: Record<string, any> = {
                title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                description: product.description || `<p>${product.name}</p>`,
                ...(imageUrls.length > 0 ? { imageUrls } : {}),
                aspects: aspects, // Product-level aspects (non-varying)
                variantSKUs: successfulSkus,
                variesBy: {
                  aspectsImageVariesBy: [],
                  specifications: [
                    {
                      name: variationAspectName,
                      values: variationValues,
                    },
                  ],
                },
              };

              console.log(`[eBay Push] Creating inventory item group: ${groupKey} with ${successfulSkus.length} SKUs`);
              await ebayApiRequest(
                "PUT",
                `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
                accessToken,
                groupBody,
              );
              console.log(`[eBay Push] Inventory item group created/updated: ${groupKey}`);
            } catch (err: any) {
              console.error(`[eBay Push] Inventory item group failed:`, err.message);
              results.push({
                productId, productName: product.name, variantCount: variants.length,
                success: false, error: `Inventory item group failed: ${err.message.substring(0, 500)}`, variantDetails,
              });
              continue;
            }
          }

          // ---- Step C: Create/Update Offer ----
          let offerId: string | null = null;
          try {
            const offerBody: Record<string, any> = {
              marketplaceId: "EBAY_US",
              format: "FIXED_PRICE",
              categoryId: ebayBrowseCategoryId,
              listingPolicies: {
                fulfillmentPolicyId: effectivePolicies.fulfillmentPolicyId,
                returnPolicyId: effectivePolicies.returnPolicyId,
                paymentPolicyId: effectivePolicies.paymentPolicyId,
              },
              merchantLocationKey,
            };

            if (storeCategoryNames.length > 0) {
              offerBody.storeCategoryNames = storeCategoryNames;
            }

            if (isMultiVariant && successfulSkus.length > 1) {
              // Multi-variant: use inventoryItemGroupKey (no sku, no price on offer)
              offerBody.inventoryItemGroupKey = `PROD-${productId}`;
            } else {
              // Single variant: use sku + price on the offer
              const singleSku = successfulSkus[0];
              const singleVariant = variants.find((v: any) => v.sku === singleSku);
              const priceCents = variantPrices.get(singleVariant?.id) || singleVariant?.price_cents || 0;
              const priceInDollars = (priceCents / 100).toFixed(2);

              offerBody.sku = singleSku;
              offerBody.pricingSummary = {
                price: { value: priceInDollars, currency: "USD" },
              };

              const invResult = await client.query(
                `SELECT COALESCE(SUM(il.variant_qty - il.reserved_qty - il.picked_qty - il.packed_qty), 0)::int AS available_qty
                 FROM inventory_levels il WHERE il.product_variant_id = $1`,
                [singleVariant?.id],
              );
              offerBody.availableQuantity = Math.max(0, invResult.rows[0]?.available_qty || 0);
            }

            console.log(`[eBay Push] Creating offer for product ${product.name}`);
            try {
              const offerData = await ebayApiRequest("POST", "/sell/inventory/v1/offer", accessToken, offerBody);
              offerId = offerData?.offerId || null;
              console.log(`[eBay Push] Offer created: offerId=${offerId}`);
            } catch (offerErr: any) {
              // If duplicate (25002), find existing offer and update
              if (offerErr.message.includes("25002") || offerErr.message.includes("409")) {
                console.log(`[eBay Push] Duplicate offer detected, finding existing...`);
                const lookupParam = isMultiVariant && successfulSkus.length > 1
                  ? `inventory_item_group_key=${encodeURIComponent(`PROD-${productId}`)}`
                  : `sku=${encodeURIComponent(successfulSkus[0])}`;

                const existingOffers = await ebayApiRequest(
                  "GET",
                  `/sell/inventory/v1/offer?${lookupParam}&marketplace_id=EBAY_US`,
                  accessToken,
                );
                if (existingOffers?.offers?.length > 0) {
                  offerId = existingOffers.offers[0].offerId;
                  console.log(`[eBay Push] Found existing offer: ${offerId}, updating...`);
                  await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
                } else {
                  throw offerErr;
                }
              } else {
                throw offerErr;
              }
            }
          } catch (err: any) {
            console.error(`[eBay Push] Offer creation failed:`, err.message);
            for (const variant of variants) {
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                syncStatus: "error",
                syncError: `Offer creation failed: ${err.message.substring(0, 1000)}`,
              });
            }
            results.push({
              productId, productName: product.name, variantCount: variants.length,
              success: false, error: `Offer creation failed: ${err.message.substring(0, 500)}`, variantDetails,
            });
            continue;
          }

          // ---- Step D: Publish Offer ----
          let listingId: string | null = null;
          try {
            console.log(`[eBay Push] Publishing offer ${offerId}`);
            const publishData = await ebayApiRequest("POST", `/sell/inventory/v1/offer/${offerId}/publish`, accessToken);
            listingId = publishData?.listingId || null;
            console.log(`[eBay Push] Published: listingId=${listingId}`);
          } catch (err: any) {
            console.error(`[eBay Push] Publish failed:`, err.message);
            for (const variant of variants) {
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalVariantId: offerId,
                syncStatus: "error",
                syncError: `Publish failed: ${err.message.substring(0, 1000)}`,
              });
            }
            results.push({
              productId, productName: product.name, variantCount: variants.length,
              success: false, offerId: offerId || undefined,
              error: `Publish failed: ${err.message.substring(0, 500)}`, variantDetails,
            });
            continue;
          }

          // ---- Success: Update all variant listings ----
          for (const variant of variants) {
            if (successfulSkus.includes(variant.sku)) {
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalProductId: listingId,
                externalVariantId: offerId,
                externalSku: variant.sku,
                externalUrl: listingId ? `https://www.ebay.com/itm/${listingId}` : null,
                syncStatus: "synced",
                syncError: null,
              });
            }
          }

          results.push({
            productId,
            productName: product.name,
            variantCount: successfulSkus.length,
            success: true,
            listingId: listingId || undefined,
            offerId: offerId || undefined,
            variantDetails,
          });
        }

        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        console.log(`[eBay Push] Complete: ${succeeded} products succeeded, ${failed} failed`);

        res.json({ results, summary: { succeeded, failed, total: results.length } });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Push] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // Channel Pricing Rules endpoints
  // -----------------------------------------------------------------------

  // GET /api/ebay/pricing-rules
  app.get("/api/ebay/pricing-rules", async (_req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT r.*,
                  CASE r.scope
                    WHEN 'product' THEN (SELECT name FROM products WHERE id = r.scope_id::int LIMIT 1)
                    WHEN 'variant' THEN (SELECT pv.name || ' (' || pv.sku || ')' FROM product_variants pv WHERE pv.id = r.scope_id::int LIMIT 1)
                    WHEN 'category' THEN (SELECT pt.name FROM product_types pt WHERE pt.slug = r.scope_id LIMIT 1)
                    ELSE NULL
                  END AS scope_label
           FROM channel_pricing_rules r
           WHERE r.channel_id = $1
           ORDER BY
             CASE r.scope WHEN 'channel' THEN 4 WHEN 'category' THEN 3 WHEN 'product' THEN 2 WHEN 'variant' THEN 1 END,
             r.created_at ASC`,
          [EBAY_CHANNEL_ID],
        );
        res.json({ rules: result.rows });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Pricing Rules] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/ebay/pricing-rules
  app.put("/api/ebay/pricing-rules", async (req: Request, res: Response) => {
    try {
      const { scope, scopeId, ruleType, value } = req.body as {
        scope: string;
        scopeId: string | null;
        ruleType: string;
        value: number;
      };

      if (!["channel", "category", "product", "variant"].includes(scope)) {
        res.status(400).json({ error: "Invalid scope" });
        return;
      }
      if (!["percentage", "fixed", "override"].includes(ruleType)) {
        res.status(400).json({ error: "Invalid ruleType" });
        return;
      }
      if (typeof value !== "number" || isNaN(value)) {
        res.status(400).json({ error: "value must be a number" });
        return;
      }

      const effectiveScopeId = scope === "channel" ? null : scopeId;

      const client = await pool.connect();
      try {
        // Handle NULL scope_id for channel-level rules with proper ON CONFLICT
        const result = await client.query(
          `INSERT INTO channel_pricing_rules (channel_id, scope, scope_id, rule_type, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (channel_id, scope, scope_id) WHERE scope_id IS NOT NULL
           DO UPDATE SET rule_type = EXCLUDED.rule_type, value = EXCLUDED.value, updated_at = NOW()
           RETURNING *`,
          [EBAY_CHANNEL_ID, scope, effectiveScopeId, ruleType, value],
        );

        // If no rows returned (channel-level insert conflict), try update
        if (result.rows.length === 0) {
          const updateResult = await client.query(
            `UPDATE channel_pricing_rules SET rule_type = $1, value = $2, updated_at = NOW()
             WHERE channel_id = $3 AND scope = $4 AND scope_id IS NULL
             RETURNING *`,
            [ruleType, value, EBAY_CHANNEL_ID, scope],
          );
          if (updateResult.rows.length > 0) {
            res.json({ rule: updateResult.rows[0] });
            return;
          }
        }

        res.json({ rule: result.rows[0] });
      } finally {
        client.release();
      }
    } catch (err: any) {
      // Handle unique violation for channel-level (scope_id IS NULL)
      if (err.code === "23505" && err.message?.includes("channel_pricing_rules")) {
        try {
          const { scope, ruleType, value } = req.body;
          const client2 = await pool.connect();
          try {
            const updateResult = await client2.query(
              `UPDATE channel_pricing_rules SET rule_type = $1, value = $2, updated_at = NOW()
               WHERE channel_id = $3 AND scope = $4 AND scope_id IS NULL
               RETURNING *`,
              [ruleType, value, EBAY_CHANNEL_ID, scope],
            );
            res.json({ rule: updateResult.rows[0] });
            return;
          } finally {
            client2.release();
          }
        } catch (err2: any) {
          res.status(500).json({ error: err2.message });
          return;
        }
      }
      console.error("[eBay Pricing Rules Upsert] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/ebay/pricing-rules/:id
  app.delete("/api/ebay/pricing-rules/:id", async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

      const client = await pool.connect();
      try {
        await client.query(
          `DELETE FROM channel_pricing_rules WHERE id = $1 AND channel_id = $2`,
          [id, EBAY_CHANNEL_ID],
        );
        res.json({ success: true });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Pricing Rules Delete] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ebay/effective-price/:variantId
  app.get("/api/ebay/effective-price/:variantId", async (req: Request, res: Response) => {
    try {
      const variantId = parseInt(req.params.variantId);
      if (isNaN(variantId)) { res.status(400).json({ error: "Invalid variantId" }); return; }

      const client = await pool.connect();
      try {
        const varResult = await client.query(
          `SELECT pv.id, pv.product_id, pv.price_cents, pv.sku, pv.name FROM product_variants pv WHERE pv.id = $1`,
          [variantId],
        );
        if (varResult.rows.length === 0) { res.status(404).json({ error: "Variant not found" }); return; }

        const variant = varResult.rows[0];
        const effectivePrice = await resolveChannelPrice(client, EBAY_CHANNEL_ID, variant.product_id, variant.id, variant.price_cents);

        res.json({
          variantId,
          basePriceCents: variant.price_cents,
          effectivePriceCents: effectivePrice,
          basePrice: (variant.price_cents / 100).toFixed(2),
          effectivePrice: (effectivePrice / 100).toFixed(2),
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Effective Price] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ebay/effective-prices — bulk effective prices for listing feed
  app.get("/api/ebay/effective-prices", async (_req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      try {
        const varResult = await client.query(
          `SELECT pv.id, pv.product_id, pv.price_cents
           FROM product_variants pv
           JOIN products p ON p.id = pv.product_id
           WHERE p.is_active = true AND pv.sku IS NOT NULL`,
        );

        const prices: Record<number, { basePriceCents: number; effectivePriceCents: number }> = {};
        for (const v of varResult.rows) {
          const effective = await resolveChannelPrice(client, EBAY_CHANNEL_ID, v.product_id, v.id, v.price_cents);
          prices[v.id] = { basePriceCents: v.price_cents, effectivePriceCents: effective };
        }

        res.json({ prices });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Effective Prices] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/reconcile — Verify eBay listings still exist
  // -----------------------------------------------------------------------
  app.post("/api/ebay/listings/reconcile", async (_req: Request, res: Response) => {
    try {
      const authService = getAuthService();
      if (!authService) {
        res.status(500).json({ error: "eBay auth not configured" });
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);

      const client = await pool.connect();
      try {
        // Get all synced listings for eBay channel
        const listingsResult = await client.query(`
          SELECT cl.id, cl.product_variant_id, cl.external_product_id, cl.external_variant_id,
                 cl.external_sku, cl.sync_status,
                 pv.sku AS variant_sku, p.name AS product_name
          FROM channel_listings cl
          LEFT JOIN product_variants pv ON pv.id = cl.product_variant_id
          LEFT JOIN products p ON p.id = pv.product_id
          WHERE cl.channel_id = $1 AND cl.sync_status = 'synced'
        `, [EBAY_CHANNEL_ID]);

        const listings = listingsResult.rows;
        if (listings.length === 0) {
          res.json({ checked: 0, active: 0, ended: 0, deleted: 0, errors: 0 });
          return;
        }

        let active = 0;
        let ended = 0;
        let deleted = 0;
        let errors = 0;
        const changes: Array<{ id: number; sku: string; product: string; oldStatus: string; newStatus: string }> = [];

        // Check each listing against eBay
        for (const listing of listings) {
          const sku = listing.external_sku || listing.variant_sku;
          if (!sku) {
            errors++;
            continue;
          }

          try {
            // Step 1: Check if inventory item exists
            let itemExists = true;
            try {
              await ebayApiRequest(
                "GET",
                `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
                accessToken,
              );
            } catch (err: any) {
              if (err.message?.includes("404") || err.message?.includes("25710")) {
                itemExists = false;
              } else {
                throw err;
              }
            }

            if (!itemExists) {
              // Inventory item gone — mark as deleted
              await client.query(
                `UPDATE channel_listings SET sync_status = 'deleted', sync_error = 'Inventory item not found on eBay', updated_at = NOW()
                 WHERE id = $1`,
                [listing.id],
              );
              deleted++;
              changes.push({ id: listing.id, sku, product: listing.product_name || "Unknown", oldStatus: "synced", newStatus: "deleted" });
              continue;
            }

            // Step 2: Check if offer is still active
            let offerActive = false;
            try {
              const offersResp = await ebayApiRequest(
                "GET",
                `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`,
                accessToken,
              );
              if (offersResp?.offers?.length > 0) {
                // Check offer status — PUBLISHED means active
                const hasActiveOffer = offersResp.offers.some(
                  (o: any) => o.status === "PUBLISHED" || o.status === "ACTIVE",
                );
                offerActive = hasActiveOffer;
              }
            } catch (err: any) {
              if (err.message?.includes("404")) {
                offerActive = false;
              } else {
                throw err;
              }
            }

            if (offerActive) {
              active++;
            } else {
              // Offer ended/withdrawn
              await client.query(
                `UPDATE channel_listings SET sync_status = 'ended', sync_error = 'Offer no longer active on eBay', updated_at = NOW()
                 WHERE id = $1`,
                [listing.id],
              );
              ended++;
              changes.push({ id: listing.id, sku, product: listing.product_name || "Unknown", oldStatus: "synced", newStatus: "ended" });
            }
          } catch (err: any) {
            console.error(`[eBay Reconcile] Error checking SKU ${sku}:`, err.message);
            errors++;
          }

          // Small delay between API calls to respect rate limits
          await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (changes.length > 0) {
          console.log(`[eBay Reconcile] Status changes:`, changes.map((c) => `${c.sku}: ${c.oldStatus} → ${c.newStatus}`).join(", "));
        }
        console.log(`[eBay Reconcile] Complete: checked=${listings.length} active=${active} ended=${ended} deleted=${deleted} errors=${errors}`);

        res.json({ checked: listings.length, active, ended, deleted, errors, changes });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Reconcile] Error:", err.message);
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
// Helpers
// ---------------------------------------------------------------------------

async function upsertChannelListing(
  client: any,
  channelId: number,
  productVariantId: number,
  data: {
    externalProductId?: string | null;
    externalVariantId?: string | null;
    externalSku?: string | null;
    externalUrl?: string | null;
    syncStatus?: string;
    syncError?: string | null;
    lastSyncedPrice?: number | null;
    lastSyncedQty?: number | null;
  }
): Promise<void> {
  await client.query(`
    INSERT INTO channel_listings (
      channel_id, product_variant_id, external_product_id, external_variant_id,
      external_sku, external_url, sync_status, sync_error,
      last_synced_price, last_synced_qty, last_synced_at, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW(), NOW())
    ON CONFLICT (channel_id, product_variant_id)
    DO UPDATE SET
      external_product_id = COALESCE(EXCLUDED.external_product_id, channel_listings.external_product_id),
      external_variant_id = COALESCE(EXCLUDED.external_variant_id, channel_listings.external_variant_id),
      external_sku = COALESCE(EXCLUDED.external_sku, channel_listings.external_sku),
      external_url = COALESCE(EXCLUDED.external_url, channel_listings.external_url),
      sync_status = EXCLUDED.sync_status,
      sync_error = EXCLUDED.sync_error,
      last_synced_price = EXCLUDED.last_synced_price,
      last_synced_qty = EXCLUDED.last_synced_qty,
      last_synced_at = NOW(),
      updated_at = NOW()
  `, [
    channelId,
    productVariantId,
    data.externalProductId || null,
    data.externalVariantId || null,
    data.externalSku || null,
    data.externalUrl || null,
    data.syncStatus || "pending",
    data.syncError || null,
    data.lastSyncedPrice || null,
    data.lastSyncedQty || null,
  ]);
}

// ---------------------------------------------------------------------------
// Price Resolution — hierarchical pricing rules
// ---------------------------------------------------------------------------

/**
 * Resolve the effective channel price for a variant.
 * Priority: variant > product > category > channel > base price
 */
async function resolveChannelPrice(
  client: any,
  channelId: number,
  productId: number,
  variantId: number,
  basePriceCents: number,
): Promise<number> {
  // 1. Check variant-level rule
  const variantRule = await client.query(
    `SELECT rule_type, value FROM channel_pricing_rules
     WHERE channel_id = $1 AND scope = 'variant' AND scope_id = $2::text`,
    [channelId, variantId],
  );
  if (variantRule.rows.length > 0) {
    return applyPricingRule(basePriceCents, variantRule.rows[0].rule_type, parseFloat(variantRule.rows[0].value));
  }

  // 2. Check product-level rule
  const productRule = await client.query(
    `SELECT rule_type, value FROM channel_pricing_rules
     WHERE channel_id = $1 AND scope = 'product' AND scope_id = $2::text`,
    [channelId, productId],
  );
  if (productRule.rows.length > 0) {
    return applyPricingRule(basePriceCents, productRule.rows[0].rule_type, parseFloat(productRule.rows[0].value));
  }

  // 3. Check category-level rule (lookup product's product_type)
  const productTypeResult = await client.query(
    `SELECT product_type FROM products WHERE id = $1`,
    [productId],
  );
  if (productTypeResult.rows.length > 0 && productTypeResult.rows[0].product_type) {
    const categoryRule = await client.query(
      `SELECT rule_type, value FROM channel_pricing_rules
       WHERE channel_id = $1 AND scope = 'category' AND scope_id = $2`,
      [channelId, productTypeResult.rows[0].product_type],
    );
    if (categoryRule.rows.length > 0) {
      return applyPricingRule(basePriceCents, categoryRule.rows[0].rule_type, parseFloat(categoryRule.rows[0].value));
    }
  }

  // 4. Check channel-level rule
  const channelRule = await client.query(
    `SELECT rule_type, value FROM channel_pricing_rules
     WHERE channel_id = $1 AND scope = 'channel' AND scope_id IS NULL`,
    [channelId],
  );
  if (channelRule.rows.length > 0) {
    return applyPricingRule(basePriceCents, channelRule.rows[0].rule_type, parseFloat(channelRule.rows[0].value));
  }

  // 5. No rule — return base price
  return basePriceCents;
}

/**
 * Apply a pricing rule to a base price.
 * - percentage: basePriceCents * (1 + value/100) — value is percentage (e.g., 15.00 = 15%)
 * - fixed: basePriceCents + value*100 — value is dollars (e.g., 2.00 = $2.00)
 * - override: value*100 — value is the exact price in dollars (e.g., 39.99 = $39.99)
 */
function applyPricingRule(basePriceCents: number, ruleType: string, value: number): number {
  switch (ruleType) {
    case "percentage":
      return Math.round(basePriceCents * (1 + value / 100));
    case "fixed":
      return basePriceCents + Math.round(value * 100);
    case "override":
      return Math.round(value * 100);
    default:
      return basePriceCents;
  }
}

// ---------------------------------------------------------------------------
// Variation Aspect Name Detection
// ---------------------------------------------------------------------------

/**
 * Determine the eBay variation aspect name from variant data.
 * Uses option1_name if available and consistent, otherwise infers from values.
 */
function determineVariationAspectName(variants: any[]): string {
  // Check if all variants have the same option1_name
  const option1Names = variants
    .map((v) => v.option1_name)
    .filter((n) => n && n.trim());

  if (option1Names.length > 0) {
    const uniqueNames = [...new Set(option1Names)];
    if (uniqueNames.length === 1) {
      return uniqueNames[0];
    }
  }

  // Infer from values: check if they look like quantities
  const values = variants.map((v) => v.option1_value || v.name || "");
  const allNumeric = values.every((v) => /^\d+/.test(v));
  if (allNumeric) return "Pack Size";

  return "Style";
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
