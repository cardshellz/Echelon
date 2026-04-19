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

  // GET /api/ebay/listing-feed — Products with types for listing feed
  // -----------------------------------------------------------------------
  router.get("/api/ebay/listing-feed", requireAuth, async (req: Request, res: Response) => {
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
            (SELECT COUNT(*) FROM product_variants pv WHERE pv.product_id = p.id AND pv.sku IS NOT NULL AND pv.is_active = true) AS variant_count,
            (SELECT COUNT(*) FROM product_assets pa WHERE pa.product_id = p.id) AS image_count,
            cl.id AS listing_id,
            cl.sync_status AS listing_status,
            cl.sync_error AS listing_sync_error,
            cl.external_product_id,
            p.ebay_listing_excluded,
            COALESCE(ecm.listing_enabled, true) AS type_listing_enabled,
            p.ebay_fulfillment_policy_override AS product_fulfillment_override,
            p.ebay_return_policy_override AS product_return_override,
            p.ebay_payment_policy_override AS product_payment_override
          FROM products p
          LEFT JOIN product_types pt ON pt.slug = p.product_type
          LEFT JOIN ebay_category_mappings ecm ON ecm.product_type_slug = p.product_type AND ecm.channel_id = $1
          LEFT JOIN LATERAL (
            SELECT cl2.id, cl2.sync_status, cl2.sync_error, cl2.external_product_id
            FROM channels.channel_listings cl2
            JOIN catalog.product_variants pv2 ON pv2.id = cl2.product_variant_id
            WHERE pv2.product_id = p.id AND cl2.channel_id = $1
            ORDER BY CASE WHEN cl2.sync_error IS NOT NULL THEN 0 ELSE 1 END, cl2.id DESC
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
              pv.ebay_fulfillment_policy_override AS variant_fulfillment_override,
              pv.ebay_return_policy_override AS variant_return_override,
              pv.ebay_payment_policy_override AS variant_payment_override
            FROM product_variants pv
            WHERE pv.product_id = ANY($1) AND pv.sku IS NOT NULL AND pv.is_active = true
            ORDER BY pv.product_id, pv.position ASC, pv.id ASC
          `, [productIds]);

          // Fetch fungible ATP for all products in the feed
          const atpByVariantId: Map<number, number> = new Map();
          const uniqueProductIds = [...new Set(varResult.rows.map((v: any) => v.product_id))];
          for (const pid of uniqueProductIds) {
            const variantAtps = await atpService.getAtpPerVariant(pid);
            for (const va of variantAtps) {
              atpByVariantId.set(va.productVariantId, va.atpUnits);
            }
          }

          for (const v of varResult.rows) {
            const pid = v.product_id;
            if (!variantsByProduct.has(pid)) variantsByProduct.set(pid, []);
            variantsByProduct.get(pid)!.push({
              id: v.id,
              sku: v.sku,
              name: v.name,
              priceCents: v.price_cents,
              ebayListingExcluded: v.ebay_listing_excluded === true,
              inventoryQuantity: Math.max(0, atpByVariantId.get(v.id) ?? 0),
              fulfillmentPolicyOverride: v.variant_fulfillment_override || null,
              returnPolicyOverride: v.variant_return_override || null,
              paymentPolicyOverride: v.variant_payment_override || null,
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
          const isError = !!row.listing_id && row.listing_status === "error";
          const listingSyncStatus = row.listing_status;
          const listingSyncError = row.listing_sync_error || null;

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
          else if (isError) status = "error";
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
            syncError: listingSyncError,
            externalListingId: row.external_product_id,
            variantCount: parseInt(row.variant_count) || 0,
            includedVariantCount,
            imageCount: parseInt(row.image_count) || 0,
            variants,
            fulfillmentPolicyOverride: row.product_fulfillment_override || null,
            returnPolicyOverride: row.product_return_override || null,
            paymentPolicyOverride: row.product_payment_override || null,
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

  //   All eBay API calls use ebayApiRequest (https module).
  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/push", requireAuth, async (req: Request, res: Response) => {
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
          // 1. Fetch product (include policy overrides + SKU)
          const prodResult = await client.query(
            `SELECT id, name, sku, description, brand, product_type, ebay_browse_category_id,
                    ebay_fulfillment_policy_override, ebay_return_policy_override, ebay_payment_policy_override
             FROM catalog.products WHERE id = $1 AND is_active = true`,
            [productId],
          );
          if (prodResult.rows.length === 0) {
            results.push({ productId, productName: "", variantCount: 0, success: false, error: "Product not found or inactive" });
            continue;
          }
          const product = prodResult.rows[0];

          // 2. Fetch variants (skip excluded), include policy overrides
          const varResult = await client.query(
            `SELECT id, sku, name, option1_name, option1_value, option2_name, option2_value,
                    price_cents, compare_at_price_cents, weight_grams, barcode,
                    units_per_variant, hierarchy_level,
                    ebay_fulfillment_policy_override, ebay_return_policy_override, ebay_payment_policy_override
             FROM product_variants WHERE product_id = $1 AND sku IS NOT NULL AND is_active = true
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
            `SELECT url FROM catalog.product_assets WHERE product_id = $1 ORDER BY position ASC`,
            [productId],
          );
          const imageUrls = imgResult.rows
            .map((r: any) => r.url)
            .filter((url: string) => url && url.startsWith("https://"))
            .slice(0, 12); // eBay max 12

          // If no images in Echelon, fetch existing images from eBay to avoid wiping them
          let effectiveImageUrls = imageUrls;
          if (effectiveImageUrls.length === 0) {
            try {
              const firstSku = varResult.rows[0]?.sku;
              if (firstSku) {
                const existingItem = await ebayApiRequest(
                  "GET",
                  `/sell/inventory/v1/inventory_item/${encodeURIComponent(firstSku)}`,
                  accessToken,
                );
                if (existingItem?.product?.imageUrls?.length > 0) {
                  effectiveImageUrls = existingItem.product.imageUrls;
                  console.log(`[eBay Sync] Using ${effectiveImageUrls.length} existing eBay images for product (no Echelon assets)`);
                }
              }
            } catch (e: any) {
              console.warn(`[eBay Sync] Could not fetch existing images from eBay:`, e.message);
            }
          }

          // 4. Fetch effective eBay category + policies
          let ebayBrowseCategoryId = product.ebay_browse_category_id;
          let storeCategoryNames: string[] = [];
          let effectivePolicies = { ...defaultPolicies };

          // Policy resolution: variant override → product override → category override → channel default
          // Step 1: Category-level overrides
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

          // Step 2: Product-level overrides (win over category)
          if (product.ebay_fulfillment_policy_override) effectivePolicies.fulfillmentPolicyId = product.ebay_fulfillment_policy_override;
          if (product.ebay_return_policy_override) effectivePolicies.returnPolicyId = product.ebay_return_policy_override;
          if (product.ebay_payment_policy_override) effectivePolicies.paymentPolicyId = product.ebay_payment_policy_override;

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

          // ---- Fetch fungible ATP for this product (shared pool) ----
          const variantAtps = await atpService.getAtpPerVariant(productId);
          const atpByVariantId: Map<number, number> = new Map();
          for (const va of variantAtps) {
            atpByVariantId.set(va.productVariantId, va.atpUnits);
          }

          // ---- Step A: Create/Update Inventory Items for each variant ----
          let allItemsCreated = true;
          for (const variant of variants) {
            const sku = variant.sku;
            try {
              const availableQty = Math.max(0, atpByVariantId.get(variant.id) ?? 0);
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
                  ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
                  aspects: variantAspects,
                },
                availability: {
                  shipToLocationAvailability: { quantity: availableQty },
                },
              };

              // Always include description — eBay requires it on inventory items
              inventoryItemBody.product.description = product.description || `<p>${product.name}</p>`;

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
            const firstError = variantDetails.find((v) => v.error)?.error || "Unknown error";
            results.push({
              productId, productName: product.name, variantCount: variants.length,
              success: false, error: `Inventory items failed: ${firstError}`, variantDetails,
            });
            continue;
          }

          const successfulSkus = variantDetails.filter((v) => v.success).map((v) => v.sku);

          // ---- Step B: Multi-variant -> Create Inventory Item Group ----
          // Use product SKU as the group key (eBay displays this as the listing's Custom Label/SKU)
          const groupKey = product.sku || `PROD-${productId}`;

          if (isMultiVariant && successfulSkus.length > 1) {
            try {

              // Build variesBy specification
              const variationValues = variants
                .filter((v: any) => successfulSkus.includes(v.sku))
                .map((v: any) => v.option1_value || v.name || v.sku);

              const groupBody: Record<string, any> = {
                title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                description: product.description || `<p>${product.name}</p>`,
                ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
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

          // ---- Step C: Create/Update Offers ----
          // Multi-variant: one offer PER variant SKU (no inventoryItemGroupKey on offers)
          // Single-variant: one offer with sku + price
          const offerIds: Map<string, string> = new Map(); // sku -> offerId
          let offerCreationFailed = false;

          if (isMultiVariant && successfulSkus.length > 1) {
            // --- Multi-variant: create an offer for EACH variant ---
            for (const variant of variants) {
              if (!successfulSkus.includes(variant.sku)) continue;
              try {
                const priceCents = variantPrices.get(variant.id) || variant.price_cents;
                const priceInDollars = (priceCents / 100).toFixed(2);

                const availableQty = Math.max(0, atpByVariantId.get(variant.id) ?? 0);

                // Variant-level policy overrides win over product/category/channel
                const variantPolicies = {
                  fulfillmentPolicyId: variant.ebay_fulfillment_policy_override || effectivePolicies.fulfillmentPolicyId,
                  returnPolicyId: variant.ebay_return_policy_override || effectivePolicies.returnPolicyId,
                  paymentPolicyId: variant.ebay_payment_policy_override || effectivePolicies.paymentPolicyId,
                };

                const offerBody: Record<string, any> = {
                  sku: variant.sku,
                  marketplaceId: "EBAY_US",
                  format: "FIXED_PRICE",
                  categoryId: ebayBrowseCategoryId,
                  listingPolicies: variantPolicies,
                  merchantLocationKey,
                  pricingSummary: {
                    price: { value: priceInDollars, currency: "USD" },
                  },
                  availableQuantity: availableQty,
                };
                if (storeCategoryNames.length > 0) {
                  offerBody.storeCategoryNames = storeCategoryNames;
                }

                console.log(`[eBay Push] Creating offer for variant SKU: ${variant.sku}`);
                let offerId: string | null = null;
                try {
                  const offerData = await ebayApiRequest("POST", "/sell/inventory/v1/offer", accessToken, offerBody);
                  offerId = offerData?.offerId || null;
                  console.log(`[eBay Push] Offer created: offerId=${offerId} for SKU=${variant.sku}`);
                } catch (offerErr: any) {
                  // If duplicate (25002/409), find existing offer and update
                  if (offerErr.message.includes("25002") || offerErr.message.includes("409")) {
                    console.log(`[eBay Push] Duplicate offer for SKU ${variant.sku}, finding existing...`);
                    const existingOffers = await ebayApiRequest(
                      "GET",
                      `/sell/inventory/v1/offer?sku=${encodeURIComponent(variant.sku)}&marketplace_id=EBAY_US`,
                      accessToken,
                    );
                    if (existingOffers?.offers?.length > 0) {
                      offerId = existingOffers.offers[0].offerId;
                      console.log(`[eBay Push] Found existing offer: ${offerId} for SKU=${variant.sku}, updating...`);
                      await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
                    } else {
                      throw offerErr;
                    }
                  } else {
                    throw offerErr;
                  }
                }

                if (offerId) {
                  offerIds.set(variant.sku, offerId);
                }
              } catch (err: any) {
                console.error(`[eBay Push] Offer creation failed for SKU ${variant.sku}:`, err.message);
                await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                  syncStatus: "error",
                  syncError: `Offer creation failed: ${err.message.substring(0, 1000)}`,
                });
                // Mark variant as failed in details
                const detailIdx = variantDetails.findIndex((d) => d.sku === variant.sku);
                if (detailIdx >= 0) {
                  variantDetails[detailIdx] = { sku: variant.sku, success: false, error: `Offer failed: ${err.message.substring(0, 500)}` };
                }
              }
            }

            if (offerIds.size === 0) {
              offerCreationFailed = true;
              results.push({
                productId, productName: product.name, variantCount: variants.length,
                success: false, error: "All variant offer creations failed", variantDetails,
              });
              continue;
            }
          } else {
            // --- Single variant: one offer with sku + price ---
            try {
              const singleSku = successfulSkus[0];
              const singleVariant = variants.find((v: any) => v.sku === singleSku);
              const priceCents = variantPrices.get(singleVariant?.id) || singleVariant?.price_cents || 0;
              const priceInDollars = (priceCents / 100).toFixed(2);

              const singleAvailableQty = Math.max(0, atpByVariantId.get(singleVariant?.id) ?? 0);

              const offerBody: Record<string, any> = {
                sku: singleSku,
                marketplaceId: "EBAY_US",
                format: "FIXED_PRICE",
                categoryId: ebayBrowseCategoryId,
                listingPolicies: {
                  fulfillmentPolicyId: effectivePolicies.fulfillmentPolicyId,
                  returnPolicyId: effectivePolicies.returnPolicyId,
                  paymentPolicyId: effectivePolicies.paymentPolicyId,
                },
                merchantLocationKey,
                pricingSummary: {
                  price: { value: priceInDollars, currency: "USD" },
                },
                availableQuantity: singleAvailableQty,
              };
              if (storeCategoryNames.length > 0) {
                offerBody.storeCategoryNames = storeCategoryNames;
              }

              console.log(`[eBay Push] Creating offer for single-variant product ${product.name}`);
              let offerId: string | null = null;
              try {
                const offerData = await ebayApiRequest("POST", "/sell/inventory/v1/offer", accessToken, offerBody);
                offerId = offerData?.offerId || null;
                console.log(`[eBay Push] Offer created: offerId=${offerId}`);
              } catch (offerErr: any) {
                if (offerErr.message.includes("25002") || offerErr.message.includes("409")) {
                  console.log(`[eBay Push] Duplicate offer detected, finding existing...`);
                  const existingOffers = await ebayApiRequest(
                    "GET",
                    `/sell/inventory/v1/offer?sku=${encodeURIComponent(singleSku)}&marketplace_id=EBAY_US`,
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

              if (offerId) {
                offerIds.set(singleSku, offerId);
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
          }

          // ---- Step D: Publish ----
          // Multi-variant: publish via inventory item group (combines all variant offers into one listing)
          // Single-variant: publish individual offer
          let listingId: string | null = null;
          try {
            if (isMultiVariant && successfulSkus.length > 1) {
              console.log(`[eBay Push] Publishing by inventory item group: ${groupKey}`);
              const publishData = await ebayApiRequest(
                "POST",
                "/sell/inventory/v1/offer/publish_by_inventory_item_group",
                accessToken,
                {
                  inventoryItemGroupKey: groupKey,
                  marketplaceId: "EBAY_US",
                },
              );
              listingId = publishData?.listingId || null;
              console.log(`[eBay Push] Published multi-variant listing: listingId=${listingId}`);
            } else {
              const singleOfferId = offerIds.values().next().value;
              console.log(`[eBay Push] Publishing single offer ${singleOfferId}`);
              const publishData = await ebayApiRequest("POST", `/sell/inventory/v1/offer/${singleOfferId}/publish`, accessToken);
              listingId = publishData?.listingId || null;
              console.log(`[eBay Push] Published: listingId=${listingId}`);
            }
          } catch (err: any) {
            console.error(`[eBay Push] Publish failed:`, err.message);
            for (const variant of variants) {
              const varOfferId = offerIds.get(variant.sku) || null;
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalVariantId: varOfferId,
                syncStatus: "error",
                syncError: `Publish failed: ${err.message.substring(0, 1000)}`,
              });
            }
            results.push({
              productId, productName: product.name, variantCount: variants.length,
              success: false,
              error: `Publish failed: ${err.message.substring(0, 500)}`, variantDetails,
            });
            continue;
          }

          // ---- Success: Update all variant listings ----
          for (const variant of variants) {
            if (successfulSkus.includes(variant.sku)) {
              const varOfferId = offerIds.get(variant.sku) || null;
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalProductId: listingId,
                externalVariantId: varOfferId,
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
  // GET /api/ebay/listings/push-stream — SSE push with real-time progress

  // -----------------------------------------------------------------------
  router.get("/api/ebay/listings/push-stream", requireAuth, async (req: Request, res: Response) => {
    // Parse product IDs from query string
    const idsParam = req.query.productIds as string;
    if (!idsParam) {
      res.status(400).json({ error: "productIds query parameter is required" });
      return;
    }
    const productIds = idsParam.split(",").map((id) => parseInt(id.trim())).filter((id) => !isNaN(id));
    if (productIds.length === 0) {
      res.status(400).json({ error: "No valid product IDs provided" });
      return;
    }

    // Set up SSE headers
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let cancelled = false;
    req.on("close", () => { cancelled = true; });

    const sendEvent = (data: any) => {
      if (cancelled) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const authService = getAuthService();
      if (!authService) {
        sendEvent({ type: "error", error: "eBay OAuth not configured" });
        res.end();
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};
      const defaultPolicies = {
        fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
        returnPolicyId: metadata.returnPolicyId || null,
        paymentPolicyId: metadata.paymentPolicyId || null,
      };
      const merchantLocationKey = metadata.merchantLocationKey || "card-shellz-hq";

      const client = await pool.connect();
      const total = productIds.length;
      let current = 0;
      let succeeded = 0;
      let failed = 0;
      let skipped = 0;

      try {
        for (const productId of productIds) {
          if (cancelled) break;
          current++;

          // 1. Fetch product
          const prodResult = await client.query(
            `SELECT id, name, sku, description, brand, product_type, ebay_browse_category_id,
                    ebay_fulfillment_policy_override, ebay_return_policy_override, ebay_payment_policy_override,
                    ebay_listing_excluded
             FROM catalog.products WHERE id = $1 AND is_active = true`,
            [productId],
          );
          if (prodResult.rows.length === 0) {
            failed++;
            sendEvent({ type: "progress", product: `Product #${productId}`, productId, status: "error", error: "Product not found or inactive", current, total });
            await upsertPushError(client, EBAY_CHANNEL_ID, productId, "Product not found or inactive");
            continue;
          }
          const product = prodResult.rows[0];

          // Check if excluded or type disabled
          if (product.ebay_listing_excluded) {
            skipped++;
            sendEvent({ type: "progress", product: product.name, productId, status: "skipped", error: "Product excluded", current, total });
            continue;
          }

          // 2. Fetch variants
          const varResult = await client.query(
            `SELECT id, sku, name, option1_name, option1_value, option2_name, option2_value,
                    price_cents, compare_at_price_cents, weight_grams, barcode,
                    units_per_variant, hierarchy_level,
                    ebay_fulfillment_policy_override, ebay_return_policy_override, ebay_payment_policy_override
             FROM product_variants WHERE product_id = $1 AND sku IS NOT NULL AND is_active = true
               AND COALESCE(ebay_listing_excluded, false) = false
             ORDER BY position ASC, id ASC`,
            [productId],
          );
          if (varResult.rows.length === 0) {
            failed++;
            const errMsg = "No eligible variants";
            sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, current, total });
            await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
            continue;
          }

          // 3. Fetch images
          const imgResult = await client.query(
            `SELECT url FROM catalog.product_assets WHERE product_id = $1 ORDER BY position ASC`,
            [productId],
          );
          const imageUrls = imgResult.rows
            .map((r: any) => r.url)
            .filter((url: string) => url && url.startsWith("https://"))
            .slice(0, 12);

          // If no images in Echelon, fetch existing images from eBay to avoid wiping them
          let effectiveImageUrls = imageUrls;
          if (effectiveImageUrls.length === 0) {
            try {
              const firstSku = varResult.rows[0]?.sku;
              if (firstSku) {
                const existingItem = await ebayApiRequest(
                  "GET",
                  `/sell/inventory/v1/inventory_item/${encodeURIComponent(firstSku)}`,
                  accessToken,
                );
                if (existingItem?.product?.imageUrls?.length > 0) {
                  effectiveImageUrls = existingItem.product.imageUrls;
                  console.log(`[eBay Sync] Using ${effectiveImageUrls.length} existing eBay images for product (no Echelon assets)`);
                }
              }
            } catch (e: any) {
              console.warn(`[eBay Sync] Could not fetch existing images from eBay:`, e.message);
            }
          }

          // 4. Category & policies
          let ebayBrowseCategoryId = product.ebay_browse_category_id;
          let storeCategoryNames: string[] = [];
          let effectivePolicies = { ...defaultPolicies };

          if (product.product_type) {
            const catResult = await client.query(
              `SELECT ebay_browse_category_id, ebay_store_category_name,
                      fulfillment_policy_override, return_policy_override, payment_policy_override,
                      listing_enabled
               FROM ebay_category_mappings
               WHERE channel_id = $1 AND product_type_slug = $2`,
              [EBAY_CHANNEL_ID, product.product_type],
            );
            if (catResult.rows.length > 0) {
              const catRow = catResult.rows[0];
              if (catRow.listing_enabled === false) {
                skipped++;
                sendEvent({ type: "progress", product: product.name, productId, status: "skipped", error: "Type disabled", current, total });
                continue;
              }
              if (!ebayBrowseCategoryId) ebayBrowseCategoryId = catRow.ebay_browse_category_id;
              if (catRow.ebay_store_category_name) storeCategoryNames = [catRow.ebay_store_category_name];
              if (catRow.fulfillment_policy_override) effectivePolicies.fulfillmentPolicyId = catRow.fulfillment_policy_override;
              if (catRow.return_policy_override) effectivePolicies.returnPolicyId = catRow.return_policy_override;
              if (catRow.payment_policy_override) effectivePolicies.paymentPolicyId = catRow.payment_policy_override;
            }
          }

          if (product.ebay_fulfillment_policy_override) effectivePolicies.fulfillmentPolicyId = product.ebay_fulfillment_policy_override;
          if (product.ebay_return_policy_override) effectivePolicies.returnPolicyId = product.ebay_return_policy_override;
          if (product.ebay_payment_policy_override) effectivePolicies.paymentPolicyId = product.ebay_payment_policy_override;

          if (!ebayBrowseCategoryId) {
            failed++;
            const errMsg = "No eBay browse category configured";
            sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, current, total });
            await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
            continue;
          }

          // 5. Aspects
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
          const variationAspectName = isMultiVariant ? determineVariationAspectName(variants) : "";

          // Prices
          const variantPrices: Map<number, number> = new Map();
          for (const v of variants) {
            const resolved = await resolveChannelPrice(client, EBAY_CHANNEL_ID, productId, v.id, v.price_cents);
            variantPrices.set(v.id, resolved);
          }

          // ATP
          const variantAtps = await atpService.getAtpPerVariant(productId);
          const atpByVariantId: Map<number, number> = new Map();
          for (const va of variantAtps) {
            atpByVariantId.set(va.productVariantId, va.atpUnits);
          }

          // Step A: Create/Update Inventory Items
          const variantDetails: Array<{ sku: string; success: boolean; error?: string }> = [];
          let allItemsCreated = true;

          for (const variant of variants) {
            if (cancelled) break;
            const sku = variant.sku;
            try {
              const availableQty = Math.max(0, atpByVariantId.get(variant.id) ?? 0);
              const priceCents = variantPrices.get(variant.id) || variant.price_cents;

              const variantAspects: Record<string, string[]> = { ...aspects };
              if (isMultiVariant) {
                const variationValue = variant.option1_value || variant.name || sku;
                variantAspects[variationAspectName] = [variationValue];
              }

              const inventoryItemBody: Record<string, any> = {
                condition: "NEW",
                product: {
                  title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                  ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
                  aspects: variantAspects,
                },
                availability: {
                  shipToLocationAvailability: { quantity: availableQty },
                },
              };
              // Always include description — eBay requires it
              inventoryItemBody.product.description = product.description || `<p>${product.name}</p>`;

              await ebayApiRequestWithRateNotify(
                "PUT",
                `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
                accessToken,
                inventoryItemBody,
                (waitSec) => sendEvent({ type: "rate_limited", waitSeconds: waitSec, product: product.name, productId }),
              );
              await delay(200);

              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalSku: sku,
                lastSyncedPrice: priceCents,
                lastSyncedQty: availableQty,
                syncStatus: "pending",
              });
              variantDetails.push({ sku, success: true });
            } catch (err: any) {
              allItemsCreated = false;
              variantDetails.push({ sku, success: false, error: err.message.substring(0, 500) });
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                syncStatus: "error",
                syncError: `Inventory item failed: ${err.message.substring(0, 1000)}`,
              });
            }
          }

          if (cancelled) break;

          if (!allItemsCreated && variantDetails.every((v) => !v.success)) {
            failed++;
            const firstError = variantDetails.find((v) => v.error)?.error || "Unknown error";
            const errMsg = `Inventory items failed: ${firstError}`;
            sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, variantsListed: 0, current, total, variantDetails });
            await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
            continue;
          }

          const successfulSkus = variantDetails.filter((v) => v.success).map((v) => v.sku);
          const groupKey = product.sku || `PROD-${productId}`;

          // Step B: Multi-variant → Create Inventory Item Group
          if (isMultiVariant && successfulSkus.length > 1) {
            try {
              const variationValues = variants
                .filter((v: any) => successfulSkus.includes(v.sku))
                .map((v: any) => v.option1_value || v.name || v.sku);

              const groupBody: Record<string, any> = {
                title: product.name.length > 80 ? product.name.substring(0, 77) + "..." : product.name,
                description: product.description || `<p>${product.name}</p>`,
                ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
                aspects,
                variantSKUs: successfulSkus,
                variesBy: {
                  aspectsImageVariesBy: [],
                  specifications: [{ name: variationAspectName, values: variationValues }],
                },
              };

              await ebayApiRequestWithRateNotify(
                "PUT",
                `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
                accessToken,
                groupBody,
                (waitSec) => sendEvent({ type: "rate_limited", waitSeconds: waitSec, product: product.name, productId }),
              );
              await delay(200);
            } catch (err: any) {
              failed++;
              const errMsg = `Inventory item group failed: ${err.message.substring(0, 500)}`;
              sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, current, total, variantDetails });
              await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
              continue;
            }
          }

          // Step C: Create/Update Offers
          const offerIds: Map<string, string> = new Map();

          if (isMultiVariant && successfulSkus.length > 1) {
            for (const variant of variants) {
              if (cancelled) break;
              if (!successfulSkus.includes(variant.sku)) continue;
              try {
                const priceCents = variantPrices.get(variant.id) || variant.price_cents;
                const priceInDollars = (priceCents / 100).toFixed(2);
                const availableQty = Math.max(0, atpByVariantId.get(variant.id) ?? 0);

                const variantPolicies = {
                  fulfillmentPolicyId: variant.ebay_fulfillment_policy_override || effectivePolicies.fulfillmentPolicyId,
                  returnPolicyId: variant.ebay_return_policy_override || effectivePolicies.returnPolicyId,
                  paymentPolicyId: variant.ebay_payment_policy_override || effectivePolicies.paymentPolicyId,
                };

                const offerBody: Record<string, any> = {
                  sku: variant.sku,
                  marketplaceId: "EBAY_US",
                  format: "FIXED_PRICE",
                  categoryId: ebayBrowseCategoryId,
                  listingPolicies: variantPolicies,
                  merchantLocationKey,
                  pricingSummary: { price: { value: priceInDollars, currency: "USD" } },
                  availableQuantity: availableQty,
                };
                if (storeCategoryNames.length > 0) offerBody.storeCategoryNames = storeCategoryNames;

                let offerId: string | null = null;
                try {
                  const offerData = await ebayApiRequestWithRateNotify("POST", "/sell/inventory/v1/offer", accessToken, offerBody,
                    (waitSec) => sendEvent({ type: "rate_limited", waitSeconds: waitSec, product: product.name, productId }));
                  offerId = offerData?.offerId || null;
                } catch (offerErr: any) {
                  if (offerErr.message.includes("25002") || offerErr.message.includes("409")) {
                    const existingOffers = await ebayApiRequest("GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(variant.sku)}&marketplace_id=EBAY_US`, accessToken);
                    if (existingOffers?.offers?.length > 0) {
                      offerId = existingOffers.offers[0].offerId;
                      await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
                    } else { throw offerErr; }
                  } else { throw offerErr; }
                }
                if (offerId) offerIds.set(variant.sku, offerId);
                await delay(200);
              } catch (err: any) {
                await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                  syncStatus: "error",
                  syncError: `Offer creation failed: ${err.message.substring(0, 1000)}`,
                });
                const detailIdx = variantDetails.findIndex((d) => d.sku === variant.sku);
                if (detailIdx >= 0) variantDetails[detailIdx] = { sku: variant.sku, success: false, error: `Offer failed: ${err.message.substring(0, 500)}` };
              }
            }

            if (offerIds.size === 0) {
              failed++;
              const errMsg = "All variant offer creations failed";
              sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, current, total, variantDetails });
              await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
              continue;
            }
          } else {
            // Single variant
            try {
              const singleSku = successfulSkus[0];
              const singleVariant = variants.find((v: any) => v.sku === singleSku);
              const priceCents = variantPrices.get(singleVariant?.id) || singleVariant?.price_cents || 0;
              const priceInDollars = (priceCents / 100).toFixed(2);
              const singleAvailableQty = Math.max(0, atpByVariantId.get(singleVariant?.id) ?? 0);

              const offerBody: Record<string, any> = {
                sku: singleSku,
                marketplaceId: "EBAY_US",
                format: "FIXED_PRICE",
                categoryId: ebayBrowseCategoryId,
                listingPolicies: effectivePolicies,
                merchantLocationKey,
                pricingSummary: { price: { value: priceInDollars, currency: "USD" } },
                availableQuantity: singleAvailableQty,
              };
              if (storeCategoryNames.length > 0) offerBody.storeCategoryNames = storeCategoryNames;

              let offerId: string | null = null;
              try {
                const offerData = await ebayApiRequestWithRateNotify("POST", "/sell/inventory/v1/offer", accessToken, offerBody,
                  (waitSec) => sendEvent({ type: "rate_limited", waitSeconds: waitSec, product: product.name, productId }));
                offerId = offerData?.offerId || null;
              } catch (offerErr: any) {
                if (offerErr.message.includes("25002") || offerErr.message.includes("409")) {
                  const existingOffers = await ebayApiRequest("GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(singleSku)}&marketplace_id=EBAY_US`, accessToken);
                  if (existingOffers?.offers?.length > 0) {
                    offerId = existingOffers.offers[0].offerId;
                    await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
                  } else { throw offerErr; }
                } else { throw offerErr; }
              }
              if (offerId) offerIds.set(singleSku, offerId);
              await delay(200);
            } catch (err: any) {
              for (const variant of variants) {
                await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                  syncStatus: "error",
                  syncError: `Offer creation failed: ${err.message.substring(0, 1000)}`,
                });
              }
              failed++;
              const errMsg = `Offer creation failed: ${err.message.substring(0, 500)}`;
              sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, current, total, variantDetails });
              await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
              continue;
            }
          }

          if (cancelled) break;

          // Step D: Publish
          let listingId: string | null = null;
          try {
            if (isMultiVariant && successfulSkus.length > 1) {
              const publishData = await ebayApiRequestWithRateNotify(
                "POST", "/sell/inventory/v1/offer/publish_by_inventory_item_group", accessToken,
                { inventoryItemGroupKey: groupKey, marketplaceId: "EBAY_US" },
                (waitSec) => sendEvent({ type: "rate_limited", waitSeconds: waitSec, product: product.name, productId }),
              );
              listingId = publishData?.listingId || null;
            } else {
              const singleOfferId = offerIds.values().next().value;
              const publishData = await ebayApiRequestWithRateNotify(
                "POST", `/sell/inventory/v1/offer/${singleOfferId}/publish`, accessToken, undefined,
                (waitSec) => sendEvent({ type: "rate_limited", waitSeconds: waitSec, product: product.name, productId }),
              );
              listingId = publishData?.listingId || null;
            }
          } catch (err: any) {
            for (const variant of variants) {
              const varOfferId = offerIds.get(variant.sku) || null;
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalVariantId: varOfferId,
                syncStatus: "error",
                syncError: `Publish failed: ${err.message.substring(0, 1000)}`,
              });
            }
            failed++;
            const errMsg = `Publish failed: ${err.message.substring(0, 500)}`;
            sendEvent({ type: "progress", product: product.name, productId, status: "error", error: errMsg, current, total, variantDetails });
            await upsertPushError(client, EBAY_CHANNEL_ID, productId, errMsg);
            continue;
          }

          // Success — update all variant listings
          for (const variant of variants) {
            if (successfulSkus.includes(variant.sku)) {
              const varOfferId = offerIds.get(variant.sku) || null;
              await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.id, {
                externalProductId: listingId,
                externalVariantId: varOfferId,
                externalSku: variant.sku,
                externalUrl: listingId ? `https://www.ebay.com/itm/${listingId}` : null,
                syncStatus: "synced",
                syncError: null,
              });
            }
          }

          // Clear push error on success
          await clearPushError(client, EBAY_CHANNEL_ID, productId);

          succeeded++;
          sendEvent({
            type: "progress",
            product: product.name,
            productId,
            status: "success",
            variantsListed: successfulSkus.length,
            listingId,
            current,
            total,
          });
        }

        // Send completion event
        sendEvent({
          type: "complete",
          summary: { succeeded, failed, skipped, total: current },
          cancelled,
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.error("[eBay Push Stream] Error:", err.message);
      sendEvent({ type: "error", error: err.message });
    }

    res.end();
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/sync-all — Sync all active eBay listings

  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/sync-all", requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await syncActiveListings(null);
      res.json(result);
    } catch (err: any) {
      console.error("[eBay Sync All] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/ebay/listings/sync-product/:productId — Sync a single product

  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/sync-product/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const productId = parseInt(req.params.productId);
      if (isNaN(productId)) {
        res.status(400).json({ error: "Invalid product ID" });
        return;
      }
      const result = await syncActiveListings({ productIds: [productId] });
      res.json(result);
    } catch (err: any) {
      console.error("[eBay Sync Product] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/ebay/listings/sync-stream — SSE sync with real-time progress

  // -----------------------------------------------------------------------
  router.get("/api/ebay/listings/sync-stream", requireAuth, async (req: Request, res: Response) => {
    const idsParam = req.query.productIds as string | undefined;
    const productIds = idsParam
      ? idsParam.split(",").map((id) => parseInt(id.trim())).filter((id) => !isNaN(id))
      : null;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let cancelled = false;
    req.on("close", () => { cancelled = true; });

    const sendEvent = (data: any) => {
      if (cancelled) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const authService = getAuthService();
      if (!authService) {
        sendEvent({ type: "error", error: "eBay OAuth not configured" });
        res.end();
        return;
      }

      const accessToken = await authService.getAccessToken(EBAY_CHANNEL_ID);
      const conn = await getChannelConnection();
      const metadata = (conn?.metadata as Record<string, any>) || {};
      const defaultPolicies = {
        fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
        returnPolicyId: metadata.returnPolicyId || null,
        paymentPolicyId: metadata.paymentPolicyId || null,
      };
      const merchantLocationKey = metadata.merchantLocationKey || "card-shellz-hq";

      const client = await pool.connect();
      try {
        let filterClause = "";
        const params: any[] = [EBAY_CHANNEL_ID];
        let paramIdx = 2;

        if (productIds && productIds.length > 0) {
          filterClause += ` AND p.id = ANY($${paramIdx})`;
          params.push(productIds);
          paramIdx++;
        }

        const listingsResult = await client.query(`
          SELECT
            cl.id AS listing_id,
            cl.product_variant_id,
            cl.external_product_id,
            cl.external_variant_id,
            cl.external_sku,
            cl.last_synced_price,
            cl.last_synced_qty,
            pv.id AS variant_id,
            pv.sku AS variant_sku,
            pv.name AS variant_name,
            pv.price_cents,
            pv.option1_name,
            pv.option1_value,
            pv.ebay_fulfillment_policy_override AS variant_fulfillment_override,
            pv.ebay_return_policy_override AS variant_return_override,
            pv.ebay_payment_policy_override AS variant_payment_override,
            p.id AS product_id,
            p.name AS product_name,
            p.sku AS product_sku,
            p.description AS product_description,
            p.brand AS product_brand,
            p.product_type,
            p.ebay_browse_category_id,
            p.ebay_fulfillment_policy_override AS product_fulfillment_override,
            p.ebay_return_policy_override AS product_return_override,
            p.ebay_payment_policy_override AS product_payment_override
          FROM channels.channel_listings cl
          JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
          JOIN catalog.products p ON p.id = pv.product_id
          WHERE cl.channel_id = $1
            AND cl.sync_status = 'synced'
            ${filterClause}
          ORDER BY p.id ASC, pv.position ASC, pv.id ASC
        `, params);

        if (listingsResult.rows.length === 0) {
          sendEvent({ type: "complete", summary: { synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, total: 0 }, cancelled: false });
          res.end();
          return;
        }

        // Group by product
        const productGroups: Map<number, any[]> = new Map();
        for (const row of listingsResult.rows) {
          const pid = row.product_id;
          if (!productGroups.has(pid)) productGroups.set(pid, []);
          productGroups.get(pid)!.push(row);
        }

        const total = productGroups.size;
        let current = 0;
        let synced = 0;
        let priceChanges = 0;
        let qtyChanges = 0;
        let policyChanges = 0;
        let errors = 0;

        for (const [productId, variants] of productGroups) {
          if (cancelled) break;
          current++;
          const product = variants[0];

          try {
            let ebayBrowseCategoryId = product.ebay_browse_category_id;
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
                if (catRow.fulfillment_policy_override) effectivePolicies.fulfillmentPolicyId = catRow.fulfillment_policy_override;
                if (catRow.return_policy_override) effectivePolicies.returnPolicyId = catRow.return_policy_override;
                if (catRow.payment_policy_override) effectivePolicies.paymentPolicyId = catRow.payment_policy_override;
              }
            }
            if (product.product_fulfillment_override) effectivePolicies.fulfillmentPolicyId = product.product_fulfillment_override;
            if (product.product_return_override) effectivePolicies.returnPolicyId = product.product_return_override;
            if (product.product_payment_override) effectivePolicies.paymentPolicyId = product.product_payment_override;

            const aspects: Record<string, string[]> = {};
            if (product.product_brand) aspects["Brand"] = [product.product_brand];
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

            const imgResult = await client.query(
              `SELECT url FROM catalog.product_assets WHERE product_id = $1 ORDER BY position ASC`,
              [productId],
            );
            const imageUrls = imgResult.rows
              .map((r: any) => r.url)
              .filter((url: string) => url && url.startsWith("https://"))
              .slice(0, 12);

            // If no images in Echelon, fetch existing images from eBay to avoid wiping them
            let effectiveImageUrls = imageUrls;
            if (effectiveImageUrls.length === 0) {
              try {
                const firstSku = variants[0]?.variant_sku;
                if (firstSku) {
                  const existingItem = await ebayApiRequest(
                    "GET",
                    `/sell/inventory/v1/inventory_item/${encodeURIComponent(firstSku)}`,
                    accessToken,
                  );
                  if (existingItem?.product?.imageUrls?.length > 0) {
                    effectiveImageUrls = existingItem.product.imageUrls;
                    console.log(`[eBay Sync] Using ${effectiveImageUrls.length} existing eBay images for product (no Echelon assets)`);
                  }
                }
              } catch (e: any) {
                console.warn(`[eBay Sync] Could not fetch existing images from eBay:`, e.message);
              }
            }

            const isMultiVariant = variants.length > 1;
            const variationAspectName = isMultiVariant ? determineVariationAspectName(variants) : "";

            const syncVariantAtps = await atpService.getAtpPerVariant(productId);
            const syncAtpByVariantId: Map<number, number> = new Map();
            for (const va of syncVariantAtps) syncAtpByVariantId.set(va.productVariantId, va.atpUnits);

            let storeCategoryNames: string[] = [];
            if (product.product_type) {
              const scResult = await client.query(
                `SELECT ebay_store_category_name FROM ebay_category_mappings WHERE channel_id = $1 AND product_type_slug = $2`,
                [EBAY_CHANNEL_ID, product.product_type],
              );
              if (scResult.rows.length > 0 && scResult.rows[0].ebay_store_category_name) {
                storeCategoryNames = [scResult.rows[0].ebay_store_category_name];
              }
            }

            let productPriceChanged = false;
            let productQtyChanged = false;
            let productPolicyChanged = false;
            let productErrors = 0;

            for (const variant of variants) {
              if (cancelled) break;
              const sku = variant.variant_sku;
              try {
                const newPriceCents = await resolveChannelPrice(client, EBAY_CHANNEL_ID, productId, variant.variant_id, variant.price_cents);
                const priceInDollars = (newPriceCents / 100).toFixed(2);
                const newQty = Math.max(0, syncAtpByVariantId.get(variant.variant_id) ?? 0);
                const varPriceChanged = newPriceCents !== (variant.last_synced_price || 0);
                const varQtyChanged = newQty !== (variant.last_synced_qty || 0);

                const variantAspects: Record<string, string[]> = { ...aspects };
                if (isMultiVariant) {
                  variantAspects[variationAspectName] = [variant.option1_value || variant.variant_name || sku];
                }

                const inventoryItemBody: Record<string, any> = {
                  condition: "NEW",
                  product: {
                    title: product.product_name.length > 80 ? product.product_name.substring(0, 77) + "..." : product.product_name,
                    ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
                    aspects: variantAspects,
                    description: product.product_description || `<p>${product.product_name}</p>`,
                  },
                  availability: { shipToLocationAvailability: { quantity: newQty } },
                };

                await ebayApiRequest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken, inventoryItemBody);
                await delay(200);

                let varPolicyChanged = false;
                try {
                  const offersResp = await ebayApiRequest("GET", `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`, accessToken);
                  await delay(200);
                  if (offersResp?.offers?.length > 0) {
                    const existingOffer = offersResp.offers[0];
                    const offerId = existingOffer.offerId;
                    const variantPolicies = {
                      fulfillmentPolicyId: variant.variant_fulfillment_override || effectivePolicies.fulfillmentPolicyId,
                      returnPolicyId: variant.variant_return_override || effectivePolicies.returnPolicyId,
                      paymentPolicyId: variant.variant_payment_override || effectivePolicies.paymentPolicyId,
                    };
                    const oldPolicies = existingOffer.listingPolicies || {};
                    if (
                      oldPolicies.fulfillmentPolicyId !== variantPolicies.fulfillmentPolicyId ||
                      oldPolicies.returnPolicyId !== variantPolicies.returnPolicyId ||
                      oldPolicies.paymentPolicyId !== variantPolicies.paymentPolicyId
                    ) varPolicyChanged = true;

                    const offerBody: Record<string, any> = {
                      sku,
                      marketplaceId: "EBAY_US",
                      format: "FIXED_PRICE",
                      categoryId: ebayBrowseCategoryId,
                      listingPolicies: variantPolicies,
                      merchantLocationKey,
                      pricingSummary: { price: { value: priceInDollars, currency: "USD" } },
                      availableQuantity: newQty,
                    };
                    if (storeCategoryNames.length > 0) offerBody.storeCategoryNames = storeCategoryNames;
                    await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
                    await delay(200);
                  }
                } catch (offerErr: any) {
                  console.error(`[eBay Sync Stream] Offer update failed for ${sku}:`, offerErr.message);
                }

                await upsertChannelListing(client, EBAY_CHANNEL_ID, variant.variant_id, {
                  lastSyncedPrice: newPriceCents,
                  lastSyncedQty: newQty,
                  syncStatus: "synced",
                  syncError: null,
                });

                if (varPriceChanged) productPriceChanged = true;
                if (varQtyChanged) productQtyChanged = true;
                if (varPolicyChanged) productPolicyChanged = true;
              } catch (err: any) {
                console.error(`[eBay Sync Stream] Error syncing SKU ${sku}:`, err.message);
                productErrors++;
                await delay(200);
              }
            }

            // Update inventory item group if multi-variant
            if (isMultiVariant && !cancelled) {
              try {
                const groupKey = product.product_sku || `PROD-${productId}`;
                const successfulSkus = variants.map((v: any) => v.variant_sku);
                const variationValues = variants.map((v: any) => v.option1_value || v.variant_name || v.variant_sku);
                const groupBody: Record<string, any> = {
                  title: product.product_name.length > 80 ? product.product_name.substring(0, 77) + "..." : product.product_name,
                  description: product.product_description || `<p>${product.product_name}</p>`,
                  ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
                  aspects,
                  variantSKUs: successfulSkus,
                  variesBy: {
                    aspectsImageVariesBy: [],
                    specifications: [{ name: variationAspectName, values: variationValues }],
                  },
                };
                await ebayApiRequest("PUT", `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`, accessToken, groupBody);
                await delay(200);
              } catch (groupErr: any) {
                console.error(`[eBay Sync Stream] Group update failed for product ${productId}:`, groupErr.message);
              }
            }

            if (productErrors > 0) {
              errors += productErrors;
              sendEvent({ type: "progress", product: product.product_name, productId, status: "error", error: `${productErrors} variant(s) failed to sync`, current, total });
            } else {
              synced++;
              if (productPriceChanged) priceChanges++;
              if (productQtyChanged) qtyChanges++;
              if (productPolicyChanged) policyChanges++;
              const changes: string[] = [];
              if (productPriceChanged) changes.push("price");
              if (productQtyChanged) changes.push("qty");
              if (productPolicyChanged) changes.push("policies");
              sendEvent({ type: "progress", product: product.product_name, productId, status: "success", changes, current, total });
            }
          } catch (err: any) {
            const raw = err.message || "Unknown error";
            const isHtml = raw.includes("<!DOCTYPE") || raw.includes("<html");
            const cleanError = isHtml ? "eBay server error (HTML error page) — check server logs" : raw.substring(0, 300);
            errors++;
            sendEvent({ type: "progress", product: product.product_name, productId, status: "error", error: cleanError, current, total });
          }
        }

        sendEvent({
          type: "complete",
          summary: { synced, priceChanges, qtyChanges, policyChanges, errors, total: current },
          cancelled,
        });
      } finally {
        client.release();
      }
    } catch (err: any) {
      const raw = err.message || "Unknown error";
      const isHtml = raw.includes("<!DOCTYPE") || raw.includes("<html");
      const cleanError = isHtml ? "eBay server returned an error page — check server logs" : raw.substring(0, 300);
      sendEvent({ type: "error", error: cleanError });
    }

    res.end();
  });

  // -----------------------------------------------------------------------
  // Channel Pricing Rules endpoints
  // -----------------------------------------------------------------------


  // -----------------------------------------------------------------------
  router.post("/api/ebay/listings/reconcile", requireInternalApiKey, async (_req: Request, res: Response) => {
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
          FROM channels.channel_listings cl
          LEFT JOIN catalog.product_variants pv ON pv.id = cl.product_variant_id
          LEFT JOIN catalog.products p ON p.id = pv.product_id
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
