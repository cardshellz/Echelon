/**
 * Vendor eBay Integration Routes
 *
 * Multi-tenant eBay OAuth and listing management.
 * Uses the SAME eBay app (CardShel-ProductF-PRD) but stores
 * tokens per-vendor in dropship_vendors.
 *
 * GET  /api/vendor/ebay/auth-url    — generate eBay OAuth consent URL
 * GET  /api/vendor/ebay/callback    — handle OAuth callback
 * GET  /api/vendor/ebay/status      — check eBay connection status
 * POST /api/vendor/ebay/disconnect  — clear eBay tokens
 * POST /api/vendor/ebay/push        — push products to vendor's eBay store
 */

import type { Express, Request, Response } from "express";
import https from "https";
import { requireVendorAuth } from "./vendor-auth";
import { pool } from "../../db";
import { createInventoryAtpService } from "../inventory/atp.service";
import { db } from "../../db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_URLS = {
  sandbox: "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
  production: "https://api.ebay.com/identity/v1/oauth2/token",
} as const;

const CONSENT_URLS = {
  sandbox: "https://auth.sandbox.ebay.com/oauth2/authorize",
  production: "https://auth.ebay.com/oauth2/authorize",
} as const;

const DEFAULT_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
].join(" ");

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

const VENDOR_PORTAL_URL = process.env.VENDOR_PORTAL_URL || "https://vendors.cardshellz.ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEbayConfig() {
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const ruName = process.env.EBAY_VENDOR_RUNAME || process.env.EBAY_RUNAME;
  const environment = (process.env.EBAY_ENVIRONMENT || "production") as "sandbox" | "production";

  if (!clientId || !clientSecret || !ruName) return null;
  return { clientId, clientSecret, ruName, environment };
}

/**
 * Get a valid eBay access token for a vendor.
 * Refreshes automatically if expired.
 */
export async function getVendorEbayToken(vendorId: number): Promise<string | null> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT ebay_oauth_token, ebay_refresh_token, ebay_token_expires_at, ebay_environment
       FROM dropship_vendors WHERE id = $1`,
      [vendorId],
    );

    if (result.rows.length === 0) return null;
    const vendor = result.rows[0];

    if (!vendor.ebay_oauth_token || !vendor.ebay_refresh_token) return null;

    // Check if token is still valid
    const expiresAt = new Date(vendor.ebay_token_expires_at);
    if (expiresAt.getTime() - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
      return vendor.ebay_oauth_token;
    }

    // Token expired or about to — refresh
    const config = getEbayConfig();
    if (!config) return null;

    const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const tokenUrl = TOKEN_URLS[config.environment];

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: vendor.ebay_refresh_token,
        scope: DEFAULT_SCOPES,
      }).toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[VendorEbay] Token refresh failed for vendor ${vendorId}: ${errorBody}`);
      return null;
    }

    const tokenData = await response.json();
    const now = new Date();
    const newExpiresAt = new Date(now.getTime() + tokenData.expires_in * 1000);
    const newRefreshToken = tokenData.refresh_token || vendor.ebay_refresh_token;

    await client.query(
      `UPDATE dropship_vendors SET
         ebay_oauth_token = $1,
         ebay_refresh_token = $2,
         ebay_token_expires_at = $3,
         updated_at = NOW()
       WHERE id = $4`,
      [tokenData.access_token, newRefreshToken, newExpiresAt, vendorId],
    );

    console.log(`[VendorEbay] Token refreshed for vendor ${vendorId}`);
    return tokenData.access_token;
  } finally {
    client.release();
  }
}

/**
 * Make an eBay API request using a vendor's token.
 */
function vendorEbayApiRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
): Promise<any> {
  const environment = process.env.EBAY_ENVIRONMENT || "production";
  const hostname = environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

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
        if (res.statusCode === 429) {
          reject(new Error(`eBay API rate limited (429)`));
          return;
        }
        if (res.statusCode === 204) { resolve(undefined); return; }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(data); }
          return;
        }
        reject(new Error(`eBay API ${method} ${path} failed (${res.statusCode}): ${data.substring(0, 1000)}`));
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// ATP Service
// ---------------------------------------------------------------------------

const atpService = createInventoryAtpService(db);

// ---------------------------------------------------------------------------
// Route Registration
// ---------------------------------------------------------------------------

export function registerVendorEbayRoutes(app: Express): void {

  // -----------------------------------------------------------------------
  // GET /api/vendor/ebay/auth-url — generate eBay OAuth consent URL
  // -----------------------------------------------------------------------
  app.get("/api/vendor/ebay/auth-url", requireVendorAuth, (req: Request, res: Response) => {
    const config = getEbayConfig();
    if (!config) {
      res.status(500).json({ error: "eBay OAuth not configured" });
      return;
    }

    const vendorId = req.vendor!.id;
    // State encodes vendor_id + CSRF token
    const csrfToken = Buffer.from(String(Date.now())).toString("base64").slice(0, 16);
    const state = `vendor_${vendorId}_${csrfToken}`;

    const baseUrl = CONSENT_URLS[config.environment];
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: config.ruName,
      scope: DEFAULT_SCOPES,
      state,
    });

    res.json({ auth_url: `${baseUrl}?${params.toString()}` });
  });

  // -----------------------------------------------------------------------
  // GET /api/vendor/ebay/callback — handle OAuth callback
  // -----------------------------------------------------------------------
  app.get("/api/vendor/ebay/callback", async (req: Request, res: Response) => {
    const config = getEbayConfig();
    if (!config) {
      res.redirect(`${VENDOR_PORTAL_URL}/settings?ebay=error&reason=not_configured`);
      return;
    }

    const code = req.query.code as string | undefined;
    const error = req.query.error as string | undefined;
    const state = req.query.state as string | undefined;

    if (error || !code) {
      res.redirect(`${VENDOR_PORTAL_URL}/settings?ebay=error&reason=${error || "no_code"}`);
      return;
    }

    // Parse vendor_id from state
    const stateMatch = state?.match(/^vendor_(\d+)_/);
    if (!stateMatch) {
      res.redirect(`${VENDOR_PORTAL_URL}/settings?ebay=error&reason=invalid_state`);
      return;
    }
    const vendorId = parseInt(stateMatch[1], 10);

    try {
      const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
      const tokenUrl = TOKEN_URLS[config.environment];

      // Exchange code for tokens
      const response = await fetch(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${credentials}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: config.ruName,
        }).toString(),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[VendorEbay] Token exchange failed for vendor ${vendorId}: ${errorBody}`);
        res.redirect(`${VENDOR_PORTAL_URL}/settings?ebay=error&reason=token_exchange_failed`);
        return;
      }

      const tokenData = await response.json();
      const now = new Date();
      const accessTokenExpiresAt = new Date(now.getTime() + tokenData.expires_in * 1000);

      // Fetch eBay user ID
      let ebayUserId: string | null = null;
      try {
        const environment = config.environment;
        const baseApiUrl = environment === "sandbox"
          ? "https://api.sandbox.ebay.com"
          : "https://api.ebay.com";
        const userResp = await fetch(`${baseApiUrl}/commerce/identity/v1/user/`, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "Content-Language": "en-US",
            "Accept-Language": "en-US",
            Accept: "application/json",
          },
        });
        if (userResp.ok) {
          const userData = await userResp.json();
          ebayUserId = userData.username || null;
        }
      } catch {}

      const client = await pool.connect();
      try {
        // Store tokens on vendor
        await client.query(
          `UPDATE dropship_vendors SET
             ebay_oauth_token = $1,
             ebay_refresh_token = $2,
             ebay_token_expires_at = $3,
             ebay_user_id = $4,
             ebay_environment = $5,
             updated_at = NOW()
           WHERE id = $6`,
          [
            tokenData.access_token,
            tokenData.refresh_token,
            accessTokenExpiresAt,
            ebayUserId,
            config.environment,
            vendorId,
          ],
        );

        console.log(`[VendorEbay] eBay connected for vendor ${vendorId} (${ebayUserId})`);
      } finally {
        client.release();
      }

      res.redirect(`${VENDOR_PORTAL_URL}/settings?ebay=connected`);
    } catch (err: any) {
      console.error(`[VendorEbay] Callback error for vendor ${vendorId}: ${err.message}`);
      res.redirect(`${VENDOR_PORTAL_URL}/settings?ebay=error&reason=internal_error`);
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/vendor/ebay/status — check eBay connection status
  // -----------------------------------------------------------------------
  app.get("/api/vendor/ebay/status", requireVendorAuth, async (req: Request, res: Response) => {
    try {
      const vendorId = req.vendor!.id;
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT ebay_oauth_token, ebay_refresh_token, ebay_token_expires_at, ebay_user_id, ebay_environment
           FROM dropship_vendors WHERE id = $1`,
          [vendorId],
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "vendor_not_found" });
        }

        const vendor = result.rows[0];
        const connected = !!vendor.ebay_oauth_token && !!vendor.ebay_refresh_token;
        const tokenValid = connected && new Date(vendor.ebay_token_expires_at) > new Date();

        res.json({
          connected,
          ebay_user_id: vendor.ebay_user_id,
          token_valid: tokenValid,
          token_expires_at: vendor.ebay_token_expires_at,
          environment: vendor.ebay_environment,
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/vendor/ebay/disconnect — clear eBay tokens
  // -----------------------------------------------------------------------
  app.post("/api/vendor/ebay/disconnect", requireVendorAuth, async (req: Request, res: Response) => {
    try {
      const vendorId = req.vendor!.id;
      const client = await pool.connect();
      try {
        await client.query(
          `UPDATE dropship_vendors SET
             ebay_oauth_token = NULL,
             ebay_refresh_token = NULL,
             ebay_token_expires_at = NULL,
             ebay_user_id = NULL,
             updated_at = NOW()
           WHERE id = $1`,
          [vendorId],
        );
        res.json({ success: true, message: "eBay disconnected" });
      } finally {
        client.release();
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/vendor/ebay/push — push products to vendor's eBay store
  // -----------------------------------------------------------------------
  app.post("/api/vendor/ebay/push", requireVendorAuth, async (req: Request, res: Response) => {
    try {
      const vendorId = req.vendor!.id;
      const vendorTier = req.vendor!.tier;
      const { product_ids, all } = req.body as { product_ids?: number[]; all?: boolean };

      // Get vendor's eBay token
      const accessToken = await getVendorEbayToken(vendorId);
      if (!accessToken) {
        return res.status(400).json({ error: "ebay_not_connected", message: "eBay account not connected or token expired" });
      }

      const client = await pool.connect();
      try {
        // Get products to push
        let productQuery: string;
        let productParams: any[];

        if (all) {
          productQuery = `SELECT dvp.product_id FROM dropship_vendor_products dvp WHERE dvp.vendor_id = $1 AND dvp.enabled = true`;
          productParams = [vendorId];
        } else if (product_ids && product_ids.length > 0) {
          productQuery = `SELECT dvp.product_id FROM dropship_vendor_products dvp WHERE dvp.vendor_id = $1 AND dvp.product_id = ANY($2::int[]) AND dvp.enabled = true`;
          productParams = [vendorId, product_ids];
        } else {
          return res.status(400).json({ error: "invalid_body", message: "Provide product_ids or set all: true" });
        }

        const dvpResult = await client.query(productQuery, productParams);
        const productIds = dvpResult.rows.map((r: any) => r.product_id);

        if (productIds.length === 0) {
          return res.json({ pushed: 0, results: [] });
        }

        // Get Card Shellz channel connection metadata for policies
        const connResult = await client.query(
          `SELECT metadata FROM channel_connections WHERE channel_id = 67 LIMIT 1`,
        );
        const csMetadata = (connResult.rows[0]?.metadata as Record<string, any>) || {};

        const results: Array<{
          product_id: number;
          status: string;
          ebay_listing_id?: string;
          ebay_offer_id?: string;
          error?: string;
        }> = [];

        // Tier discount for wholesale pricing
        const tierDiscount: Record<string, number> = { standard: 0.15, pro: 0.25, elite: 0.30 };
        const discount = tierDiscount[vendorTier] || 0.15;

        for (const productId of productIds) {
          try {
            // Fetch product data from Card Shellz catalog
            const prodResult = await client.query(
              `SELECT id, name, sku, description, brand, product_type, ebay_browse_category_id
               FROM catalog.products WHERE id = $1 AND is_active = true`,
              [productId],
            );
            if (prodResult.rows.length === 0) {
              results.push({ product_id: productId, status: "error", error: "Product not found" });
              continue;
            }
            const product = prodResult.rows[0];

            // Fetch variants
            const varResult = await client.query(
              `SELECT id, sku, name, option1_name, option1_value, price_cents, weight_grams, barcode
               FROM catalog.product_variants WHERE product_id = $1 AND sku IS NOT NULL AND is_active = true
               ORDER BY position ASC, id ASC`,
              [productId],
            );
            if (varResult.rows.length === 0) {
              results.push({ product_id: productId, status: "error", error: "No variants" });
              continue;
            }

            // Fetch images
            const imgResult = await client.query(
              `SELECT url FROM catalog.product_assets WHERE product_id = $1 ORDER BY position ASC`,
              [productId],
            );
            const imageUrls = imgResult.rows
              .map((r: any) => r.url)
              .filter((url: string) => url && url.startsWith("https://"))
              .slice(0, 12);

            // Get eBay category
            let ebayBrowseCategoryId = product.ebay_browse_category_id;
            if (!ebayBrowseCategoryId && product.product_type) {
              const catResult = await client.query(
                `SELECT ebay_browse_category_id FROM ebay_category_mappings
                 WHERE channel_id = 67 AND product_type_slug = $1 LIMIT 1`,
                [product.product_type],
              );
              if (catResult.rows.length > 0) {
                ebayBrowseCategoryId = catResult.rows[0].ebay_browse_category_id;
              }
            }
            if (!ebayBrowseCategoryId) {
              results.push({ product_id: productId, status: "error", error: "No eBay browse category" });
              continue;
            }

            // Build aspects
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

            // Get variation aspect name
            let variationAspectName = "Style";
            if (isMultiVariant) {
              const option1Names = variants.map((v: any) => v.option1_name).filter(Boolean);
              const uniqueNames = [...new Set(option1Names)];
              if (uniqueNames.length === 1) variationAspectName = uniqueNames[0];
              else {
                const values = variants.map((v: any) => v.option1_value || v.name || "");
                if (values.every((v: string) => /^\d+/.test(v))) variationAspectName = "Pack Size";
              }
            }

            // Get ATP per variant
            const variantAtps = await atpService.getAtpPerVariant(productId);
            const atpByVariantId: Map<number, number> = new Map();
            for (const va of variantAtps) atpByVariantId.set(va.productVariantId, va.atpUnits);

            // Step A: Create inventory items for each variant
            const successfulSkus: string[] = [];
            for (const variant of variants) {
              try {
                const sku = variant.sku;
                const availableQty = Math.max(0, atpByVariantId.get(variant.id) ?? 0);
                // Use Card Shellz retail as default price for vendor eBay listings
                const priceInDollars = (variant.price_cents / 100).toFixed(2);

                const variantAspects: Record<string, string[]> = { ...aspects };
                if (isMultiVariant) {
                  variantAspects[variationAspectName] = [variant.option1_value || variant.name || sku];
                }

                const inventoryItemBody: Record<string, any> = {
                  condition: "NEW",
                  product: {
                    title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                    description: product.description || `<p>${product.name}</p>`,
                    ...(imageUrls.length > 0 ? { imageUrls } : {}),
                    aspects: variantAspects,
                  },
                  availability: {
                    shipToLocationAvailability: { quantity: availableQty },
                  },
                };

                await vendorEbayApiRequest(
                  "PUT",
                  `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
                  accessToken,
                  inventoryItemBody,
                );
                successfulSkus.push(sku);
              } catch (err: any) {
                console.error(`[VendorEbay] Inventory item failed for vendor ${vendorId}, SKU ${variant.sku}: ${err.message}`);
              }
            }

            if (successfulSkus.length === 0) {
              results.push({ product_id: productId, status: "error", error: "All inventory items failed" });
              continue;
            }

            const groupKey = product.sku || `PROD-${productId}`;

            // Step B: Multi-variant group
            if (isMultiVariant && successfulSkus.length > 1) {
              const variationValues = variants
                .filter((v: any) => successfulSkus.includes(v.sku))
                .map((v: any) => v.option1_value || v.name || v.sku);

              await vendorEbayApiRequest(
                "PUT",
                `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
                accessToken,
                {
                  title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                  description: product.description || `<p>${product.name}</p>`,
                  ...(imageUrls.length > 0 ? { imageUrls } : {}),
                  aspects,
                  variantSKUs: successfulSkus,
                  variesBy: {
                    aspectsImageVariesBy: [],
                    specifications: [{ name: variationAspectName, values: variationValues }],
                  },
                },
              );
            }

            // Step C: Create offers for each variant
            // NOTE: Vendor must have their own fulfillment/return/payment policies on their eBay account.
            // For Phase 0 MVP, we'll attempt to use the vendor's default policies.
            // The vendor needs to create a merchant location pointing to Card Shellz warehouse.
            const offerIds: Map<string, string> = new Map();

            for (const variant of variants) {
              if (!successfulSkus.includes(variant.sku)) continue;
              try {
                const priceInDollars = (variant.price_cents / 100).toFixed(2);
                const availableQty = Math.max(0, atpByVariantId.get(variant.id) ?? 0);

                const offerBody: Record<string, any> = {
                  sku: variant.sku,
                  marketplaceId: "EBAY_US",
                  format: "FIXED_PRICE",
                  categoryId: ebayBrowseCategoryId,
                  // Vendor must have these policies on their account
                  // Phase 0: use Card Shellz policy IDs — vendor configures in eBay seller hub
                  listingPolicies: {
                    fulfillmentPolicyId: csMetadata.fulfillmentPolicyId || null,
                    returnPolicyId: csMetadata.returnPolicyId || null,
                    paymentPolicyId: csMetadata.paymentPolicyId || null,
                  },
                  merchantLocationKey: csMetadata.merchantLocationKey || "card-shellz-hq",
                  pricingSummary: {
                    price: { value: priceInDollars, currency: "USD" },
                  },
                  availableQuantity: availableQty,
                };

                let offerId: string | null = null;
                try {
                  const offerData = await vendorEbayApiRequest("POST", "/sell/inventory/v1/offer", accessToken, offerBody);
                  offerId = offerData?.offerId || null;
                } catch (offerErr: any) {
                  // Duplicate offer — find and update
                  if (offerErr.message.includes("25002") || offerErr.message.includes("409")) {
                    const existingOffers = await vendorEbayApiRequest(
                      "GET",
                      `/sell/inventory/v1/offer?sku=${encodeURIComponent(variant.sku)}&marketplace_id=EBAY_US`,
                      accessToken,
                    );
                    if (existingOffers?.offers?.length > 0) {
                      offerId = existingOffers.offers[0].offerId;
                      await vendorEbayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
                    } else throw offerErr;
                  } else throw offerErr;
                }

                if (offerId) offerIds.set(variant.sku, offerId);
              } catch (err: any) {
                console.error(`[VendorEbay] Offer failed for vendor ${vendorId}, SKU ${variant.sku}: ${err.message}`);
              }
            }

            if (offerIds.size === 0) {
              results.push({ product_id: productId, status: "error", error: "All offers failed" });
              continue;
            }

            // Step D: Publish
            let listingId: string | null = null;
            if (isMultiVariant && successfulSkus.length > 1) {
              const publishData = await vendorEbayApiRequest(
                "POST",
                "/sell/inventory/v1/offer/publish_by_inventory_item_group",
                accessToken,
                { inventoryItemGroupKey: groupKey, marketplaceId: "EBAY_US" },
              );
              listingId = publishData?.listingId || null;
            } else {
              const singleOfferId = offerIds.values().next().value;
              const publishData = await vendorEbayApiRequest(
                "POST",
                `/sell/inventory/v1/offer/${singleOfferId}/publish`,
                accessToken,
              );
              listingId = publishData?.listingId || null;
            }

            // Update dropship_vendor_products with eBay listing info
            const firstOfferId = offerIds.values().next().value || null;
            await client.query(
              `UPDATE dropship_vendor_products SET
                 ebay_listing_id = $1,
                 ebay_offer_id = $2,
                 push_status = 'active',
                 last_pushed_at = NOW(),
                 push_error = NULL
               WHERE vendor_id = $3 AND product_id = $4`,
              [listingId, firstOfferId, vendorId, productId],
            );

            results.push({
              product_id: productId,
              status: listingId ? "created" : "updated",
              ebay_listing_id: listingId || undefined,
              ebay_offer_id: firstOfferId || undefined,
            });

            console.log(`[VendorEbay] Pushed product ${productId} for vendor ${vendorId} → listing ${listingId}`);
          } catch (err: any) {
            console.error(`[VendorEbay] Push failed for vendor ${vendorId}, product ${productId}: ${err.message}`);

            // Store error
            await client.query(
              `UPDATE dropship_vendor_products SET push_status = 'error', push_error = $1
               WHERE vendor_id = $2 AND product_id = $3`,
              [err.message.substring(0, 1000), vendorId, productId],
            );

            results.push({ product_id: productId, status: "error", error: err.message.substring(0, 500) });
          }
        }

        res.json({ pushed: results.filter((r) => r.status !== "error").length, results });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error(`[VendorEbay] Push error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/vendor/ebay/listings — view listing status
  // -----------------------------------------------------------------------
  app.get("/api/vendor/ebay/listings", requireVendorAuth, async (req: Request, res: Response) => {
    try {
      const vendorId = req.vendor!.id;
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT dvp.product_id, p.name as product_title, dvp.ebay_listing_id,
                  dvp.push_status, dvp.last_pushed_at, dvp.push_error
           FROM dropship_vendor_products dvp
           JOIN catalog.products p ON p.id = dvp.product_id
           WHERE dvp.vendor_id = $1 AND dvp.enabled = true
           ORDER BY dvp.last_pushed_at DESC NULLS LAST`,
          [vendorId],
        );

        res.json({
          listings: result.rows.map((r: any) => ({
            product_id: r.product_id,
            product_title: r.product_title,
            ebay_listing_id: r.ebay_listing_id,
            push_status: r.push_status,
            last_pushed_at: r.last_pushed_at,
            ebay_url: r.ebay_listing_id ? `https://www.ebay.com/itm/${r.ebay_listing_id}` : null,
            push_error: r.push_error,
          })),
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
