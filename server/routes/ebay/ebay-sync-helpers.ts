import { pool, db } from "../../db";
import { EBAY_CHANNEL_ID, getAuthService, getChannelConnection, ebayApiRequest, atpService } from "./ebay-utils";
import {
  channelListings,
  productVariants,
  products,
  productAssets,
  ebayCategoryMappings,
  ebayTypeAspectDefaults,
  ebayProductAspectOverrides,
  channelPricingRules
} from "@shared/schema";
import { eq, and, sql, inArray, asc } from "drizzle-orm";

export interface SyncFilter { productIds?: number[]; productTypeSlugs?: string[]; variantIds?: number[]; }

export async function upsertChannelListing(
  dbArg: any,
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
  await dbArg.insert(channelListings).values({
    channelId,
    productVariantId,
    externalProductId: data.externalProductId || null,
    externalVariantId: data.externalVariantId || null,
    externalSku: data.externalSku || null,
    externalUrl: data.externalUrl || null,
    syncStatus: data.syncStatus || "pending",
    syncError: data.syncError || null,
    lastSyncedPrice: data.lastSyncedPrice || null,
    lastSyncedQty: data.lastSyncedQty || null,
    lastSyncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: [channelListings.channelId, channelListings.productVariantId],
    set: {
      externalProductId: sql`COALESCE(EXCLUDED.external_product_id, channel_listings.external_product_id)`,
      externalVariantId: sql`COALESCE(EXCLUDED.external_variant_id, channel_listings.external_variant_id)`,
      externalSku: sql`COALESCE(EXCLUDED.external_sku, channel_listings.external_sku)`,
      externalUrl: sql`COALESCE(EXCLUDED.external_url, channel_listings.external_url)`,
      syncStatus: data.syncStatus || "pending",
      syncError: data.syncError || null,
      lastSyncedPrice: data.lastSyncedPrice || null,
      lastSyncedQty: data.lastSyncedQty || null,
      lastSyncedAt: new Date(),
      updatedAt: new Date()
    }
  });
}

// ---------------------------------------------------------------------------
// Push Error Helpers — store/clear per-product push errors
// ---------------------------------------------------------------------------

/**
 * Store the last push error for a product (across all its variants).
 * Uses the first variant's channel_listing row to store the error.
 */
export async function upsertPushError(dbArg: any, channelId: number, productId: number, error: string): Promise<void> {
  // Find all variant IDs for this product
  const variants = await dbArg.select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, productId),
        sql`${productVariants.sku} IS NOT NULL`,
        eq(productVariants.isActive, true)
      )
    )
    .limit(1);

  if (variants.length > 0) {
    const variantId = variants[0].id;
    await upsertChannelListing(dbArg, channelId, variantId, {
      syncStatus: "error",
      syncError: error.substring(0, 1000),
    });
  }
}

/**
 * Clear push error for a product (across all its variants).
 */
export async function clearPushError(dbArg: any, channelId: number, productId: number): Promise<void> {
  // Subquery: get all variant IDs for the product
  const variants = await dbArg.select({ id: productVariants.id })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
  
  if (variants.length === 0) return;

  const variantIds = variants.map((v: any) => v.id);

  await dbArg.update(channelListings)
    .set({ syncError: null })
    .where(
      and(
        eq(channelListings.channelId, channelId),
        inArray(channelListings.productVariantId, variantIds)
      )
    );
}

// ---------------------------------------------------------------------------
// Price Resolution — hierarchical pricing rules
// ---------------------------------------------------------------------------

/**
 * Resolve the effective channel price for a variant.
 * Priority: variant > product > category > channel > base price
 */
export async function resolveChannelPrice(
  dbArg: any,
  channelId: number,
  productId: number,
  variantId: number,
  basePriceCents: number,
): Promise<number> {
  // 1. Check variant-level rule
  const variantRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "variant"),
        eq(channelPricingRules.scopeId, String(variantId))
      )
    );
  if (variantRule.length > 0) {
    return applyPricingRule(basePriceCents, variantRule[0].ruleType, parseFloat(variantRule[0].value as string));
  }

  // 2. Check product-level rule
  const productRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "product"),
        eq(channelPricingRules.scopeId, String(productId))
      )
    );
  if (productRule.length > 0) {
    return applyPricingRule(basePriceCents, productRule[0].ruleType, parseFloat(productRule[0].value as string));
  }

  // 3. Check category-level rule (lookup product's product_type)
  const productInfo = await dbArg.select({ productType: products.productType })
    .from(products)
    .where(eq(products.id, productId));

  if (productInfo.length > 0 && productInfo[0].productType) {
    const categoryRule = await dbArg.select()
      .from(channelPricingRules)
      .where(
        and(
          eq(channelPricingRules.channelId, channelId),
          eq(channelPricingRules.scope, "category"),
          eq(channelPricingRules.scopeId, productInfo[0].productType)
        )
      );
    if (categoryRule.length > 0) {
      return applyPricingRule(basePriceCents, categoryRule[0].ruleType, parseFloat(categoryRule[0].value as string));
    }
  }

  // 4. Check channel-level rule
  const channelRule = await dbArg.select()
    .from(channelPricingRules)
    .where(
      and(
        eq(channelPricingRules.channelId, channelId),
        eq(channelPricingRules.scope, "channel"),
        sql`${channelPricingRules.scopeId} IS NULL`
      )
    );
  if (channelRule.length > 0) {
    return applyPricingRule(basePriceCents, channelRule[0].ruleType, parseFloat(channelRule[0].value as string));
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
export function applyPricingRule(basePriceCents: number, ruleType: string, value: number): number {
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
export function determineVariationAspectName(variants: any[]): string {
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

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---------------------------------------------------------------------------
// Sync Active Listings — updates prices, quantities, policies, aspects
// ---------------------------------------------------------------------------

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));



export async function syncActiveListings(filter: SyncFilter | null): Promise<{
  synced: number;
  priceChanges: number;
  qtyChanges: number;
  policyChanges: number;
  errors: number;
  details: Array<{
    productId: number;
    productName: string;
    variantSku: string;
    success: boolean;
    priceChanged: boolean;
    qtyChanged: boolean;
    policyChanged: boolean;
    error?: string;
  }>;
}> {
  const authService = getAuthService();
  if (!authService) {
    throw new Error("eBay OAuth not configured");
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
  try {
    // Build the filter clause for active listings
    const conditions = [
      eq(channelListings.channelId, EBAY_CHANNEL_ID),
      eq(channelListings.syncStatus, 'synced')
    ];

    if (filter?.productIds && filter.productIds.length > 0) {
      conditions.push(inArray(products.id, filter.productIds));
    }
    if (filter?.productTypeSlugs && filter.productTypeSlugs.length > 0) {
      conditions.push(inArray(products.productType, filter.productTypeSlugs));
    }
    if (filter?.variantIds && filter.variantIds.length > 0) {
      conditions.push(inArray(productVariants.id, filter.variantIds));
    }

    // Get all synced listings with their product/variant data
    const listingsResult = await db.select({
      listing_id: channelListings.id,
      product_variant_id: channelListings.productVariantId,
      external_product_id: channelListings.externalProductId,
      external_variant_id: channelListings.externalVariantId,
      external_sku: channelListings.externalSku,
      last_synced_price: channelListings.lastSyncedPrice,
      last_synced_qty: channelListings.lastSyncedQty,
      variant_id: productVariants.id,
      variant_sku: productVariants.sku,
      variant_name: productVariants.name,
      price_cents: productVariants.priceCents,
      option1_name: productVariants.option1Name,
      option1_value: productVariants.option1Value,
      variant_fulfillment_override: productVariants.ebayFulfillmentPolicyOverride,
      variant_return_override: productVariants.ebayReturnPolicyOverride,
      variant_payment_override: productVariants.ebayPaymentPolicyOverride,
      product_id: products.id,
      product_name: products.name,
      product_sku: products.sku,
      product_description: products.description,
      product_brand: products.brand,
      product_type: products.productType,
      ebay_browse_category_id: products.ebayBrowseCategoryId,
      product_fulfillment_override: products.ebayFulfillmentPolicyOverride,
      product_return_override: products.ebayReturnPolicyOverride,
      product_payment_override: products.ebayPaymentPolicyOverride,
    })
    .from(channelListings)
    .innerJoin(productVariants, eq(productVariants.id, channelListings.productVariantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(...conditions))
    .orderBy(asc(products.id), asc(productVariants.position), asc(productVariants.id));

    if (listingsResult.length === 0) {
      return { synced: 0, priceChanges: 0, qtyChanges: 0, policyChanges: 0, errors: 0, details: [] };
    }

    // Group listings by product
    const productGroups: Map<number, any[]> = new Map();
    for (const row of listingsResult) {
      const pid = row.product_id;
      if (!productGroups.has(pid)) productGroups.set(pid, []);
      productGroups.get(pid)!.push(row);
    }

    const summary = {
      synced: 0,
      priceChanges: 0,
      qtyChanges: 0,
      policyChanges: 0,
      errors: 0,
      details: [] as any[],
    };

    // Process products sequentially
    for (const [productId, variants] of productGroups) {
      const product = variants[0]; // product data is same for all variants

      // Get effective eBay category
      let ebayBrowseCategoryId = product.ebay_browse_category_id;
      let effectivePolicies = { ...defaultPolicies };

      // Category-level overrides
      if (product.product_type) {
        const catResult = await db.select({
            ebayBrowseCategoryId: ebayCategoryMappings.ebayBrowseCategoryId,
            ebayStoreCategoryName: ebayCategoryMappings.ebayStoreCategoryName,
            fulfillmentPolicyOverride: ebayCategoryMappings.fulfillmentPolicyOverride,
            returnPolicyOverride: ebayCategoryMappings.returnPolicyOverride,
            paymentPolicyOverride: ebayCategoryMappings.paymentPolicyOverride,
          })
          .from(ebayCategoryMappings)
          .where(
            and(
              eq(ebayCategoryMappings.channelId, EBAY_CHANNEL_ID),
              eq(ebayCategoryMappings.productTypeSlug, product.product_type)
            )
          );
        if (catResult.length > 0) {
          const catRow = catResult[0];
          if (!ebayBrowseCategoryId) ebayBrowseCategoryId = catRow.ebayBrowseCategoryId;
          if (catRow.fulfillmentPolicyOverride) effectivePolicies.fulfillmentPolicyId = catRow.fulfillmentPolicyOverride;
          if (catRow.returnPolicyOverride) effectivePolicies.returnPolicyId = catRow.returnPolicyOverride;
          if (catRow.paymentPolicyOverride) effectivePolicies.paymentPolicyId = catRow.paymentPolicyOverride;
        }
      }

      // Product-level policy overrides
      if (product.product_fulfillment_override) effectivePolicies.fulfillmentPolicyId = product.product_fulfillment_override;
      if (product.product_return_override) effectivePolicies.returnPolicyId = product.product_return_override;
      if (product.product_payment_override) effectivePolicies.paymentPolicyId = product.product_payment_override;

      // Build product-level aspects
      const aspects: Record<string, string[]> = {};
      if (product.product_brand) aspects["Brand"] = [product.product_brand];

      if (product.product_type) {
        const typeDefaults = await db.select({
            aspectName: ebayTypeAspectDefaults.aspectName,
            aspectValue: ebayTypeAspectDefaults.aspectValue
          })
          .from(ebayTypeAspectDefaults)
          .where(eq(ebayTypeAspectDefaults.productTypeSlug, product.product_type));
        for (const td of typeDefaults) aspects[td.aspectName] = [td.aspectValue];
      }
      
      const prodOverrides = await db.select({
          aspectName: ebayProductAspectOverrides.aspectName,
          aspectValue: ebayProductAspectOverrides.aspectValue
        })
        .from(ebayProductAspectOverrides)
        .where(eq(ebayProductAspectOverrides.productId, productId));
      for (const po of prodOverrides) aspects[po.aspectName] = [po.aspectValue];

      // Get images
      const imgResult = await db.select({ url: productAssets.url })
        .from(productAssets)
        .where(eq(productAssets.productId, productId))
        .orderBy(asc(productAssets.position));
      const imageUrls = imgResult
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

      // ---- Fetch fungible ATP for this product (shared pool) ----
      const syncVariantAtps = await atpService.getAtpPerVariant(productId);
      const syncAtpByVariantId: Map<number, number> = new Map();
      for (const va of syncVariantAtps) {
        syncAtpByVariantId.set(va.productVariantId, va.atpUnits);
      }

      // ---- Process each variant ----
      for (const variant of variants) {
        const sku = variant.variant_sku;
        try {
          // Recalculate price
          const newPriceCents = await resolveChannelPrice(
            db, EBAY_CHANNEL_ID, productId, variant.variant_id, variant.price_cents,
          );
          const priceInDollars = (newPriceCents / 100).toFixed(2);

          // Recalculate available quantity (fungible ATP)
          const newQty = Math.max(0, syncAtpByVariantId.get(variant.variant_id) ?? 0);

          // Detect changes
          const oldPrice = variant.last_synced_price || 0;
          const oldQty = variant.last_synced_qty || 0;
          const priceChanged = newPriceCents !== oldPrice;
          const qtyChanged = newQty !== oldQty;

          // Build variant aspects
          const variantAspects: Record<string, string[]> = { ...aspects };
          if (isMultiVariant) {
            const variationValue = variant.option1_value || variant.variant_name || sku;
            variantAspects[variationAspectName] = [variationValue];
          }

          // A. Update inventory item
          const inventoryItemBody: Record<string, any> = {
            condition: "NEW",
            product: {
              title: product.product_name.length > 80 ? product.product_name.substring(0, 77) + "..." : product.product_name,
              ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
              aspects: variantAspects,
            },
            availability: {
              shipToLocationAvailability: { quantity: newQty },
            },
          };
          // Always include description — eBay requires it
          inventoryItemBody.product.description = product.product_description || `<p>${product.product_name}</p>`;

          console.log(`[eBay Sync] Updating inventory item: ${sku}`);
          await ebayApiRequest("PUT", `/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, accessToken, inventoryItemBody);
          await delay(200);

          // B. Update offer — find existing, then update
          let policyChanged = false;
          try {
            const offersResp = await ebayApiRequest(
              "GET",
              `/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=EBAY_US`,
              accessToken,
            );
            await delay(200);

            if (offersResp?.offers?.length > 0) {
              const existingOffer = offersResp.offers[0];
              const offerId = existingOffer.offerId;

              // Variant-level policy overrides
              const variantPolicies = {
                fulfillmentPolicyId: variant.variant_fulfillment_override || effectivePolicies.fulfillmentPolicyId,
                returnPolicyId: variant.variant_return_override || effectivePolicies.returnPolicyId,
                paymentPolicyId: variant.variant_payment_override || effectivePolicies.paymentPolicyId,
              };

              // Detect policy changes
              const oldPolicies = existingOffer.listingPolicies || {};
              if (
                oldPolicies.fulfillmentPolicyId !== variantPolicies.fulfillmentPolicyId ||
                oldPolicies.returnPolicyId !== variantPolicies.returnPolicyId ||
                oldPolicies.paymentPolicyId !== variantPolicies.paymentPolicyId
              ) {
                policyChanged = true;
              }

              // Get store category names
              let storeCategoryNames: string[] = [];
              if (product.product_type) {
                const scResult = await client.query(
                  `SELECT ebay_store_category_name FROM ebay_category_mappings
                   WHERE channel_id = $1 AND product_type_slug = $2`,
                  [EBAY_CHANNEL_ID, product.product_type],
                );
                if (scResult.rows.length > 0 && scResult.rows[0].ebay_store_category_name) {
                  storeCategoryNames = [scResult.rows[0].ebay_store_category_name];
                }
              }

              const offerBody: Record<string, any> = {
                sku,
                marketplaceId: "EBAY_US",
                format: "FIXED_PRICE",
                categoryId: ebayBrowseCategoryId,
                listingPolicies: variantPolicies,
                merchantLocationKey,
                pricingSummary: {
                  price: { value: priceInDollars, currency: "USD" },
                },
                availableQuantity: newQty,
              };
              if (storeCategoryNames.length > 0) {
                offerBody.storeCategoryNames = storeCategoryNames;
              }

              console.log(`[eBay Sync] Updating offer ${offerId} for SKU: ${sku}`);
              await ebayApiRequest("PUT", `/sell/inventory/v1/offer/${offerId}`, accessToken, offerBody);
              await delay(200);
            }
          } catch (offerErr: any) {
            console.error(`[eBay Sync] Offer update failed for ${sku}:`, offerErr.message);
            // Non-fatal — inventory item was still updated
          }

          // Update channel_listings with new synced values
          await upsertChannelListing(db, EBAY_CHANNEL_ID, variant.variant_id, {
            lastSyncedPrice: newPriceCents,
            lastSyncedQty: newQty,
            syncStatus: "synced",
            syncError: null,
          });

          summary.synced++;
          if (priceChanged) summary.priceChanges++;
          if (qtyChanged) summary.qtyChanges++;
          if (policyChanged) summary.policyChanges++;

          summary.details.push({
            productId,
            productName: product.product_name,
            variantSku: sku,
            success: true,
            priceChanged,
            qtyChanged,
            policyChanged,
          });

        } catch (err: any) {
          console.error(`[eBay Sync] Error syncing SKU ${sku}:`, err.message);
          summary.errors++;
          summary.details.push({
            productId,
            productName: product.product_name,
            variantSku: sku,
            success: false,
            priceChanged: false,
            qtyChanged: false,
            policyChanged: false,
            error: err.message.substring(0, 500),
          });
          await delay(200);
        }
      }

      // C. Update inventory item group if multi-variant
      if (isMultiVariant) {
        try {
          const groupKey = product.product_sku || `PROD-${productId}`;
          const successfulSkus = variants.map((v: any) => v.variant_sku);

          const variationValues = variants.map(
            (v: any) => v.option1_value || v.variant_name || v.variant_sku,
          );

          const groupBody: Record<string, any> = {
            title: product.product_name.length > 80 ? product.product_name.substring(0, 77) + "..." : product.product_name,
            description: product.product_description || `<p>${product.product_name}</p>`,
            ...(effectiveImageUrls.length > 0 ? { imageUrls: effectiveImageUrls } : {}),
            aspects,
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

          console.log(`[eBay Sync] Updating inventory item group: ${groupKey}`);
          await ebayApiRequest(
            "PUT",
            `/sell/inventory/v1/inventory_item_group/${encodeURIComponent(groupKey)}`,
            accessToken,
            groupBody,
          );
          await delay(200);
        } catch (groupErr: any) {
          console.error(`[eBay Sync] Group update failed for product ${productId}:`, groupErr.message);
          // Non-fatal
        }
      }
    }

    console.log(`[eBay Sync] Complete: synced=${summary.synced} priceChanges=${summary.priceChanges} qtyChanges=${summary.qtyChanges} policyChanges=${summary.policyChanges} errors=${summary.errors}`);
    return summary;
  } finally {
    // client.release() is removed since we use db directly
  }
}

// ---------------------------------------------------------------------------
// Trigger Pricing Rule Sync — fire-and-forget background sync
// ---------------------------------------------------------------------------

export async function triggerPricingRuleSync(scope: string, scopeId: string | null): Promise<void> {
  console.log(`[eBay Pricing Rule Sync] Triggered: scope=${scope} scopeId=${scopeId}`);

  let filter: SyncFilter | null = null;

  switch (scope) {
    case "channel":
      // Sync ALL active listings
      filter = null;
      break;
    case "category":
      if (scopeId) {
        // Sync all listings in this product type
        filter = { productTypeSlugs: [scopeId] };
      }
      break;
    case "product":
      if (scopeId) {
        filter = { productIds: [parseInt(scopeId)] };
      }
      break;
    case "variant":
      if (scopeId) {
        filter = { variantIds: [parseInt(scopeId)] };
      }
      break;
  }

  const result = await syncActiveListings(filter);
  console.log(`[eBay Pricing Rule Sync] Complete: synced=${result.synced} priceChanges=${result.priceChanges} errors=${result.errors}`);
}
