import { db } from "../../db";
import { EBAY_CHANNEL_ID, getAuthService, getChannelConnection, atpService } from "./ebay-utils";
import {
  channelListings,
  productVariants,
  products,
  productAssets,
  ebayCategoryMappings,
  ebayTypeAspectDefaults,
  ebayProductAspectOverrides,
  channelPricingRules,
  channelProductOverrides,
  channelVariantOverrides,
} from "@shared/schema";
import { eq, and, sql, inArray, asc } from "drizzle-orm";
import { EbayMarketplaceListingConnector } from "../../modules/channels/listing-connectors/ebay-listing.connector";
import { buildEbayRouteListingDraft } from "./ebay-listing-draft-builder";
import {
  createEbayRouteListingClient,
  getExistingEbayInventoryImageUrls,
} from "./ebay-listing-connector-client";

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
    lastSyncedPrice: data.lastSyncedPrice ?? null,
    lastSyncedQty: data.lastSyncedQty ?? null,
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
      lastSyncedPrice: data.lastSyncedPrice ?? null,
      lastSyncedQty: data.lastSyncedQty ?? null,
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

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));



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

  const marketplaceId = typeof metadata.marketplaceId === "string" && metadata.marketplaceId.trim()
    ? metadata.marketplaceId.trim()
    : "EBAY_US";
  const ebayClient = createEbayRouteListingClient({ accessToken });
  const listingConnector = new EbayMarketplaceListingConnector({
    delay,
    inventoryDelayMs: 200,
    offerDelayMs: 200,
  });

  // Build the filter clause for active listings
  const conditions = [
    eq(channelListings.channelId, EBAY_CHANNEL_ID),
    eq(channelListings.syncStatus, "synced"),
    sql`COALESCE(${products.ebayListingExcluded}, false) = false`,
    sql`COALESCE(${productVariants.ebayListingExcluded}, false) = false`,
    sql`COALESCE(${channelProductOverrides.isListed}, 1) <> 0`,
    sql`COALESCE(${channelVariantOverrides.isListed}, 1) <> 0`,
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
    .leftJoin(
      channelProductOverrides,
      and(
        eq(channelProductOverrides.channelId, channelListings.channelId),
        eq(channelProductOverrides.productId, products.id),
      ),
    )
    .leftJoin(
      channelVariantOverrides,
      and(
        eq(channelVariantOverrides.channelId, channelListings.channelId),
        eq(channelVariantOverrides.productVariantId, productVariants.id),
      ),
    )
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

    try {
      // Get effective eBay category
      let ebayBrowseCategoryId = product.ebay_browse_category_id;
      let effectivePolicies = { ...defaultPolicies };
      let storeCategoryNames: string[] = [];

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
              eq(ebayCategoryMappings.productTypeSlug, product.product_type),
            ),
          );
        if (catResult.length > 0) {
          const catRow = catResult[0];
          if (!ebayBrowseCategoryId) ebayBrowseCategoryId = catRow.ebayBrowseCategoryId;
          if (catRow.fulfillmentPolicyOverride) effectivePolicies.fulfillmentPolicyId = catRow.fulfillmentPolicyOverride;
          if (catRow.returnPolicyOverride) effectivePolicies.returnPolicyId = catRow.returnPolicyOverride;
          if (catRow.paymentPolicyOverride) effectivePolicies.paymentPolicyId = catRow.paymentPolicyOverride;
          if (catRow.ebayStoreCategoryName) storeCategoryNames = [catRow.ebayStoreCategoryName];
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
          aspectValue: ebayTypeAspectDefaults.aspectValue,
        })
          .from(ebayTypeAspectDefaults)
          .where(eq(ebayTypeAspectDefaults.productTypeSlug, product.product_type));
        for (const td of typeDefaults) aspects[td.aspectName] = [td.aspectValue];
      }

      const prodOverrides = await db.select({
        aspectName: ebayProductAspectOverrides.aspectName,
        aspectValue: ebayProductAspectOverrides.aspectValue,
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
            const existingImageUrls = await getExistingEbayInventoryImageUrls({ accessToken, sku: firstSku });
            if (existingImageUrls.length > 0) {
              effectiveImageUrls = existingImageUrls;
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

      const routeProduct = {
        name: product.product_name,
        sku: product.product_sku,
        description: product.product_description,
      };
      const routeVariants = variants.map((variant: any) => ({
        id: variant.variant_id,
        sku: variant.variant_sku,
        name: variant.variant_name,
        option1_value: variant.option1_value,
        price_cents: variant.price_cents,
        ebay_fulfillment_policy_override: variant.variant_fulfillment_override,
        ebay_return_policy_override: variant.variant_return_override,
        ebay_payment_policy_override: variant.variant_payment_override,
      }));

      const variantPrices: Map<number, number> = new Map();
      const variantChangeState = new Map<number, { priceChanged: boolean; qtyChanged: boolean }>();
      for (const variant of variants) {
        const newPriceCents = await resolveChannelPrice(
          db,
          EBAY_CHANNEL_ID,
          productId,
          variant.variant_id,
          variant.price_cents,
        );
        const newQty = Math.max(0, syncAtpByVariantId.get(variant.variant_id) ?? 0);
        variantPrices.set(variant.variant_id, newPriceCents);
        variantChangeState.set(variant.variant_id, {
          priceChanged: newPriceCents !== (variant.last_synced_price || 0),
          qtyChanged: newQty !== (variant.last_synced_qty || 0),
        });
      }

      const routeDraft = buildEbayRouteListingDraft({
        productId,
        product: routeProduct,
        variants: routeVariants,
        effectiveImageUrls,
        aspects,
        isMultiVariant,
        variationAspectName,
        variantPrices,
        atpByVariantId: syncAtpByVariantId,
        marketplaceId,
        ebayBrowseCategoryId,
        effectivePolicies,
        storeCategoryNames,
        merchantLocationKey,
      });

      const syncResult = await listingConnector.syncExistingListing({
        client: ebayClient,
        draft: {
          productId,
          marketplaceId,
          inventoryItems: routeDraft.inventoryItems,
          offers: routeDraft.offers,
          itemGroup: routeDraft.itemGroup,
        },
      });

      const missingOfferVariantIds = new Set(syncResult.missingOfferVariantIds);
      const policyChangedVariantIds = new Set(syncResult.policyChangedVariantIds);

      for (const variant of variants) {
        const sku = variant.variant_sku;
        const changes = variantChangeState.get(variant.variant_id) ?? { priceChanged: false, qtyChanged: false };
        const newPriceCents = variantPrices.get(variant.variant_id) ?? variant.price_cents ?? 0;
        const newQty = Math.max(0, syncAtpByVariantId.get(variant.variant_id) ?? 0);
        const policyChanged = policyChangedVariantIds.has(variant.variant_id);

        if (missingOfferVariantIds.has(variant.variant_id)) {
          const error = "eBay offer not found during active listing sync.";
          await upsertChannelListing(db, EBAY_CHANNEL_ID, variant.variant_id, {
            syncStatus: "error",
            syncError: error,
          });
          summary.errors++;
          summary.details.push({
            productId,
            productName: product.product_name,
            variantSku: sku,
            success: false,
            priceChanged: false,
            qtyChanged: false,
            policyChanged: false,
            error,
          });
          continue;
        }

        await upsertChannelListing(db, EBAY_CHANNEL_ID, variant.variant_id, {
          lastSyncedPrice: newPriceCents,
          lastSyncedQty: newQty,
          syncStatus: "synced",
          syncError: null,
        });

        summary.synced++;
        if (changes.priceChanged) summary.priceChanges++;
        if (changes.qtyChanged) summary.qtyChanges++;
        if (policyChanged) summary.policyChanges++;

        summary.details.push({
          productId,
          productName: product.product_name,
          variantSku: sku,
          success: true,
          priceChanged: changes.priceChanged,
          qtyChanged: changes.qtyChanged,
          policyChanged,
        });
      }
    } catch (err: any) {
      console.error(`[eBay Sync] Error syncing product ${productId}:`, err.message);
      const syncError = err.message.substring(0, 500);
      for (const variant of variants) {
        await upsertChannelListing(db, EBAY_CHANNEL_ID, variant.variant_id, {
          syncStatus: "error",
          syncError,
        });
        summary.errors++;
        summary.details.push({
          productId,
          productName: product.product_name,
          variantSku: variant.variant_sku,
          success: false,
          priceChanged: false,
          qtyChanged: false,
          policyChanged: false,
          error: syncError,
        });
      }
    }
  }

  console.log(`[eBay Sync] Complete: synced=${summary.synced} priceChanges=${summary.priceChanges} qtyChanges=${summary.qtyChanges} policyChanges=${summary.policyChanges} errors=${summary.errors}`);
  return summary;
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
