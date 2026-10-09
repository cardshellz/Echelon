import { db } from "../../../db";
import {
  EBAY_CHANNEL_ID,
  getAuthService,
  atpService,
  ebayListingPhotoResolver,
} from "./ebay-api-runtime";
import {
  channelListings,
  productVariants,
  products,
  ebayCategoryMappings,
  ebayTypeAspectDefaults,
  ebayProductAspectOverrides,
  channelProductOverrides,
  channelVariantOverrides,
} from "@shared/schema";
import { eq, and, sql, inArray, asc, or, isNotNull } from "drizzle-orm";
import { EbayMarketplaceListingConnector } from "../listing-connectors/ebay-listing.connector";
import { buildEbayRouteListingDraft } from "../ebay-listing-draft";
import {
  createEbayRouteListingLifecycleClient,
  getExistingEbayListingPhotos,
} from "./ebay-listing-client";
import { isVariantSellable } from "../ebay-listing-eligibility";

import { pool } from "../../../db";
import { channelConnections } from "@shared/schema";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  EbayListingSyncService,
  EbayExistingListingSyncExecution,
  type PreparedEbayListingSync,
} from "../ebay-listing-sync.service";
import { PostgresEbayListingSyncRepository } from "./ebay-listing-sync.repository";
import {
  EbayListingSyncError,
  type EbayListingSyncIdentity,
} from "../ebay-listing-sync.domain";
import {
  captureExistingEbayListingIdentity,
  assertEbayListingSourceIdentityUnchanged,
  resolveExistingEbayListingIdentity,
} from "../ebay-existing-listing-identity";
import { admitEbayListingSyncProducts } from "../ebay-listing-sync-admission";
import { createEbayMarketplaceRegistrationAdapters } from "../adapters/ebay/ebay-marketplace-registration.factory";
import { quantityProviderResponseRecovery } from "../../inventory-planning/quantity-publication";
import {
  type EbayProductSyncResult,
} from "@shared/types/ebay-listing-sync";
import {
  determineVariationAspectName,
  resolveChannelPrice,
  delay,
} from "./ebay-listing-helpers";
export interface SyncFilter {
  productIds?: number[];
  productTypeSlugs?: string[];
  variantIds?: number[];
}
const filterSchema = z
  .object({
    productIds: z.array(z.number().int().positive().max(2147483647)).max(500).optional(),
    productTypeSlugs: z.array(z.string().min(1).max(200)).max(500).optional(),
    variantIds: z.array(z.number().int().positive().max(2147483647)).max(500).optional(),
  })
  .strict()
  .nullable();
async function readActiveEbaySyncRows(filter: SyncFilter | null, allSavedMembers = false) {
  // Build the filter clause for active listings. Do not filter variants by
  // catalog or eBay listing state here: sold variants must remain in an
  // existing variation group even when they are no longer sellable.
  const conditions = allSavedMembers ? [
    eq(channelListings.channelId, EBAY_CHANNEL_ID),
    or(eq(channelListings.syncStatus, "synced"), isNotNull(channelListings.externalProductId), isNotNull(channelListings.externalVariantId), isNotNull(channelListings.externalSku)),
  ] : [
    eq(channelListings.channelId, EBAY_CHANNEL_ID),
    or(
      eq(channelListings.syncStatus, "synced"),
      and(
        eq(channelListings.syncStatus, "error"),
        or(
          isNotNull(channelListings.externalProductId),
          isNotNull(channelListings.externalVariantId),
          isNotNull(channelListings.externalSku),
        ),
      ),
    ),
    eq(products.isActive, true),
    sql`COALESCE(${products.ebayListingExcluded}, false) = false`,
    sql`COALESCE(${channelProductOverrides.isListed}, 1) <> 0`,
    sql`COALESCE(${ebayCategoryMappings.listingEnabled}, true) = true`,
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
  return await db
    .select({
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
      variant_weight_grams: productVariants.weightGrams,
      variant_is_active: productVariants.isActive,
      variant_sales_eligibility: productVariants.salesEligibility,
      variant_excluded: productVariants.ebayListingExcluded,
      variant_override_is_listed: channelVariantOverrides.isListed,
      variant_weight_override: channelVariantOverrides.weightOverride,
      option1_name: productVariants.option1Name,
      option1_value: productVariants.option1Value,
      variant_fulfillment_override:
        productVariants.ebayFulfillmentPolicyOverride,
      variant_return_override: productVariants.ebayReturnPolicyOverride,
      variant_payment_override: productVariants.ebayPaymentPolicyOverride,
      product_id: products.id,
      product_name: products.name,
      product_sku: products.sku,
      product_description: products.description,
      product_brand: products.brand,
      product_is_active: products.isActive,
      product_excluded: products.ebayListingExcluded,
      product_override_is_listed: channelProductOverrides.isListed,
      type_listing_enabled: ebayCategoryMappings.listingEnabled,
      product_type: products.productType,
      ebay_browse_category_id: products.ebayBrowseCategoryId,
      product_fulfillment_override: products.ebayFulfillmentPolicyOverride,
      product_return_override: products.ebayReturnPolicyOverride,
      product_payment_override: products.ebayPaymentPolicyOverride,
    })
    .from(channelListings)
    .innerJoin(
      productVariants,
      eq(productVariants.id, channelListings.productVariantId),
    )
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
    .leftJoin(
      ebayCategoryMappings,
      and(
        eq(ebayCategoryMappings.channelId, channelListings.channelId),
        eq(ebayCategoryMappings.productTypeSlug, products.productType),
      ),
    )
    .where(and(...conditions))
    .orderBy(
      asc(products.id),
      asc(productVariants.position),
      asc(productVariants.id),
    );
}
async function context() {
  const authService = getAuthService();
  if (!authService)
    throw new EbayListingSyncError(
      "EBAY_SYNC_AUTH_REQUIRED",
      "eBay OAuth is not configured.",
    );
  const account = await authService.getVerifiedProviderAccount(EBAY_CHANNEL_ID);
  const connections = await db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, EBAY_CHANNEL_ID))
    .limit(2);
  if (!account || connections.length !== 1)
    throw new EbayListingSyncError(
      "EBAY_SYNC_ACCOUNT_UNVERIFIED",
      "One exact provider-verified eBay connection is required.",
    );
  const conn = connections[0],
    metadata = (conn.metadata as Record<string, any>) || {};
  const marketplaceId =
    typeof metadata.marketplaceId === "string" && metadata.marketplaceId.trim()
      ? metadata.marketplaceId.trim()
      : "EBAY_US";
  return { authService, account, conn, metadata, marketplaceId };
}
function identityFromRows(
  rows: Awaited<ReturnType<typeof readActiveEbaySyncRows>>,
  ctx: Awaited<ReturnType<typeof context>>,
): EbayListingSyncIdentity {
  return captureExistingEbayListingIdentity(rows.map(row => ({ ...row, content_sync_enabled: isVariantSellable({
    productActive: row.product_is_active,
    variantActive: row.variant_is_active,
    salesEligibility: row.variant_sales_eligibility,
    productExcluded: row.product_excluded === true,
    productOverrideIsListed: row.product_override_is_listed,
    typeListingEnabled: row.type_listing_enabled,
    variantExcluded: row.variant_excluded === true,
    variantOverrideIsListed: row.variant_override_is_listed,
  }) })), {
    channelId: EBAY_CHANNEL_ID,
    connectionId: ctx.conn.id,
    accountId: ctx.account.externalAccountId,
    marketplaceId: ctx.marketplaceId,
  });
}
async function readExistingEbayIdentitySnapshot(productId: number, expected?: EbayListingSyncIdentity) {
  const ctx = await context(),
    listingsResult = await readActiveEbaySyncRows({
      productIds: [productId],
    }, true);
  const sourceIdentity = identityFromRows(listingsResult, ctx);
  if (expected) assertEbayListingSourceIdentityUnchanged(expected, sourceIdentity);
  const syncVariantAtps = await atpService.getAtpPerVariant(productId);
  const syncAtpByVariantId = new Map(syncVariantAtps.map(variant => [variant.productVariantId, variant.atpUnits]));
  const boundIdentity = await resolveExistingEbayListingIdentity(
    sourceIdentity,
    createEbayMarketplaceRegistrationAdapters({ authService: ctx.authService }).observer,
    sourceIdentity.variants.map(member => ({
      productVariantId: member.variantId,
      sku: member.sku,
      isActive: listingsResult.find(row => row.variant_id === member.variantId)!.variant_is_active,
      availableQuantity: syncAtpByVariantId.get(member.variantId) ?? 0,
    })),
  );
  // Provider observation may take multiple reads; fence catalog/mapping changes
  // during those reads before preparing any provider write.
  const freshContext = await context();
  assertEbayListingSourceIdentityUnchanged(sourceIdentity,
    identityFromRows(await readActiveEbaySyncRows({ productIds: [productId] }, true), freshContext));
  return { ctx, listingsResult, sourceIdentity, boundIdentity, syncAtpByVariantId };
}

/** Existing-listing previews and maintenance use the same provider observation,
 * including saved disabled/inactive members. Catalog content is not prepared. */
export async function readExistingEbayListingIdentityForProduct(productId: number): Promise<EbayListingSyncIdentity> {
  z.number().int().positive().max(2147483647).parse(productId);
  return (await readExistingEbayIdentitySnapshot(productId)).boundIdentity;
}

async function prepareActiveEbayListingSync(
  identity: EbayListingSyncIdentity,
): Promise<PreparedEbayListingSync> {
  const { ctx, listingsResult, sourceIdentity, boundIdentity, syncAtpByVariantId } =
    await readExistingEbayIdentitySnapshot(identity.productId, identity);
  const { metadata, marketplaceId } = ctx,
    accessToken = await ctx.authService.getAccessToken(EBAY_CHANNEL_ID);
  const defaultPolicies = {
    fulfillmentPolicyId: metadata.fulfillmentPolicyId || null,
    returnPolicyId: metadata.returnPolicyId || null,
    paymentPolicyId: metadata.paymentPolicyId || null,
  };
  const merchantLocationKey = metadata.merchantLocationKey || "card-shellz-hq";
  const ebayClient = createEbayRouteListingLifecycleClient({
    accessToken,
    expectedAccountId: identity.accountId,
    expectedConnectionId: identity.connectionId,
  });

  if (!listingsResult.length)
    throw new EbayListingSyncError(
      "EBAY_SYNC_SCOPE_UNAVAILABLE",
      "This product has no eligible existing listing.",
    );
  const variants = listingsResult;
  const productId = identity.productId;
  const product = variants[0];
  // Get effective eBay category
  let ebayBrowseCategoryId = product.ebay_browse_category_id;
  let effectivePolicies = { ...defaultPolicies };
  let storeCategoryNames: string[] = [];

  // Category-level overrides
  if (product.product_type) {
    const catResult = await db
      .select({
        ebayBrowseCategoryId: ebayCategoryMappings.ebayBrowseCategoryId,
        ebayStoreCategoryName: ebayCategoryMappings.ebayStoreCategoryName,
        fulfillmentPolicyOverride:
          ebayCategoryMappings.fulfillmentPolicyOverride,
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
      if (!ebayBrowseCategoryId)
        ebayBrowseCategoryId = catRow.ebayBrowseCategoryId;
      if (catRow.fulfillmentPolicyOverride)
        effectivePolicies.fulfillmentPolicyId =
          catRow.fulfillmentPolicyOverride;
      if (catRow.returnPolicyOverride)
        effectivePolicies.returnPolicyId = catRow.returnPolicyOverride;
      if (catRow.paymentPolicyOverride)
        effectivePolicies.paymentPolicyId = catRow.paymentPolicyOverride;
      if (catRow.ebayStoreCategoryName)
        storeCategoryNames = [catRow.ebayStoreCategoryName];
    }
  }

  // Product-level policy overrides
  if (product.product_fulfillment_override)
    effectivePolicies.fulfillmentPolicyId =
      product.product_fulfillment_override;
  if (product.product_return_override)
    effectivePolicies.returnPolicyId = product.product_return_override;
  if (product.product_payment_override)
    effectivePolicies.paymentPolicyId = product.product_payment_override;

  // Build product-level aspects
  const aspects: Record<string, string[]> = {};
  if (product.product_brand) aspects["Brand"] = [product.product_brand];

  if (product.product_type) {
    const typeDefaults = await db
      .select({
        aspectName: ebayTypeAspectDefaults.aspectName,
        aspectValue: ebayTypeAspectDefaults.aspectValue,
      })
      .from(ebayTypeAspectDefaults)
      .where(eq(ebayTypeAspectDefaults.productTypeSlug, product.product_type));
    for (const td of typeDefaults) aspects[td.aspectName] = [td.aspectValue];
  }

  const prodOverrides = await db
    .select({
      aspectName: ebayProductAspectOverrides.aspectName,
      aspectValue: ebayProductAspectOverrides.aspectValue,
    })
    .from(ebayProductAspectOverrides)
    .where(eq(ebayProductAspectOverrides.productId, productId));
  for (const po of prodOverrides) aspects[po.aspectName] = [po.aspectValue];

  const isMultiVariant = variants.length > 1;
  const variationAspectName = isMultiVariant
    ? determineVariationAspectName(variants)
    : "";

  const routeProduct = {
    name: product.product_name ?? product.product_sku ?? `Product ${productId}`,
    sku: product.product_sku,
    description: product.product_description,
  };
  const routeVariants = variants.map((variant: any) => ({
    id: variant.variant_id,
    sku: boundIdentity.variants.find(member => member.variantId === variant.variant_id)!.sku,
    name: variant.variant_name,
    option1_value: variant.option1_value,
    price_cents: variant.price_cents,
    ebay_weight_grams:
      variant.variant_weight_override ?? variant.variant_weight_grams,
    ebay_fulfillment_policy_override: variant.variant_fulfillment_override,
    ebay_return_policy_override: variant.variant_return_override,
    ebay_payment_policy_override: variant.variant_payment_override,
    isListed: boundIdentity.variants.find(member => member.variantId === variant.variant_id)!.contentSyncEnabled !== false,
  }));
  const sellableVariantIds = new Set(
    routeVariants
      .filter((variant) => variant.isListed)
      .map((variant) => variant.id),
  );
  if (sellableVariantIds.size === 0) {
    throw new EbayListingSyncError("EBAY_SYNC_CONTENT_SCOPE_EMPTY", "This existing listing has no included variants to update. Its retained eBay variations are unchanged.");
  }

  // Catalog photo ownership remains keyed by local variant identity. The final
  // byVariantId plan is then addressed to the separately verified provider SKU.
  const photoVariants = variants.filter(variant => sellableVariantIds.has(variant.variant_id))
    .map(variant => ({ variantId: variant.variant_id, sku: variant.variant_sku! }));
  const photoPlan = await ebayListingPhotoResolver.resolve({
    productId,
    channelId: EBAY_CHANNEL_ID,
    variants: photoVariants,
    mode: "catalog",
    readExistingPhotos: () =>
      getExistingEbayListingPhotos({
        accessToken,
        groupKey: boundIdentity.groupKey,
        variants: boundIdentity.variants,
      }),
  });

  const variantPrices: Map<number, number> = new Map();
  const variantChangeState = new Map<number, { priceChanged: boolean }>();
  for (const variant of variants) {
    if (!sellableVariantIds.has(variant.variant_id)) continue;
    const newPriceCents = await resolveChannelPrice(
      db,
      EBAY_CHANNEL_ID,
      productId,
      variant.variant_id,
      variant.price_cents,
    );
    variantPrices.set(variant.variant_id, newPriceCents);
    variantChangeState.set(variant.variant_id, {
      priceChanged: newPriceCents !== (variant.last_synced_price || 0),
    });
  }

  if (!ebayBrowseCategoryId)
    throw new EbayListingSyncError(
      "EBAY_SYNC_CATEGORY_REQUIRED",
      "An eBay category is required before listing sync.",
    );
  const routeDraft = buildEbayRouteListingDraft({
    productId,
    product: routeProduct,
    variants: routeVariants,
    photoPlan,
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
    retainUnlistedVariantsInGroup: true,
    existingGroupKey: boundIdentity.groupKey,
  });
  const preparedDraft = await existingListingConnector.prepareExistingListingSyncDraft({
    client: ebayClient, identity: boundIdentity,
    draft: { productId, marketplaceId, inventoryItems: routeDraft.inventoryItems, offers: routeDraft.offers, itemGroup: routeDraft.itemGroup },
  });

  return {
    identity: boundIdentity,
    sourceIdentity,
    client: ebayClient,
    draft: preparedDraft,
    variants: variants
      .filter((variant) =>
        routeDraft.offers.some(
          (offer) => offer.variantId === variant.variant_id,
        ),
      )
      .map((variant) => ({
        variantId: variant.variant_id,
        sku: boundIdentity.variants.find(member => member.variantId === variant.variant_id)!.sku,
        productName:
          product.product_name ?? product.product_sku ?? `Product ${productId}`,
        priceCents: variantPrices.get(variant.variant_id)!,
        priceChanged:
          variantChangeState.get(variant.variant_id)?.priceChanged ?? false,
      })),
  };
}

const existingListingConnector = new EbayMarketplaceListingConnector({
  delay,
  inventoryDelayMs: 200,
  offerDelayMs: 200,
});
export const ebayListingSyncService = new EbayListingSyncService(
  new PostgresEbayListingSyncRepository(pool),
  new EbayExistingListingSyncExecution(
    prepareActiveEbayListingSync,
    quantityProviderResponseRecovery,
    existingListingConnector,
  ),
  () => new Date(),
  randomUUID,
);
export async function syncActiveListings(
  filter: SyncFilter | null,
  actor = "ebay-listing-sync",
  commandKey?: string,
): Promise<EbayProductSyncResult> {
  filter = filterSchema.parse(filter);
  const validatedActor = z.string().trim().min(1).max(200).parse(actor);
  if (commandKey !== undefined) z.string().uuid().parse(commandKey);
  const ctx = await context();
  const selected = await readActiveEbaySyncRows(filter);
  const selectedProductIds = [...new Set(selected.map(row => row.product_id))];
  const requestedProductIds = [...new Set(filter?.productIds ?? [])];
  const absentProductIds = requestedProductIds.filter(id => !selectedProductIds.includes(id));
  // Confirm the product exists before writing an admission journal with a
  // product foreign key. An excluded or unmapped product is still actionable.
  const ineligibleProducts = absentProductIds.length ? await db.select({ id: products.id, name: products.name })
    .from(products).where(inArray(products.id, absentProductIds)) : [];
  const productIds = [...selectedProductIds, ...ineligibleProducts.map(product => product.id)];
  if (commandKey && requestedProductIds.length > 1) {
    throw new EbayListingSyncError("EBAY_SYNC_COMMAND_SCOPE_INVALID", "A command key must target one product.");
  }
  // Selection determines products, never provider membership. Capture every
  // saved member even if its current sync/active/inclusion state differs.
  const full = selectedProductIds.length
    ? await readActiveEbaySyncRows({ productIds: selectedProductIds }, true) : [];
  const summary = await admitEbayListingSyncProducts(productIds.map(productId => {
    const rows = full.filter(row => row.product_id === productId);
    return {
      productId,
      productName: rows[0]?.product_name ?? ineligibleProducts.find(product => product.id === productId)?.name ?? `Product ${productId}`,
      variants: rows.map(row => ({ variantId: row.variant_id, sku: row.variant_sku })),
      captureIdentity: () => {
        if (!rows.length) throw new EbayListingSyncError("EBAY_SYNC_PRODUCT_NOT_ELIGIBLE", "This product has no included existing eBay listing available to sync. Review its product/type inclusion and saved published listing mapping.");
        const identity = identityFromRows(rows, ctx);
        if (identity.variants.every(member => member.contentSyncEnabled === false))
          throw new EbayListingSyncError("EBAY_SYNC_CONTENT_SCOPE_EMPTY", "This existing listing has no included variants to update. Review its variant inclusion before requesting sync.");
        return identity;
      },
    };
  }), { channelId: EBAY_CHANNEL_ID, actor: validatedActor, commandKey: productIds.length ? commandKey : undefined }, {
    enqueue: (identity, requestedBy, key) => ebayListingSyncService.enqueue(identity, requestedBy, key),
    recordFailure: failure => ebayListingSyncService.recordAdmissionFailure(failure),
    uuid: randomUUID,
  });
  for (const productId of absentProductIds.filter(id => !ineligibleProducts.some(product => product.id === id))) {
    summary.errors++;
    summary.details.push({ productId, success: false, code: "EBAY_SYNC_PRODUCT_NOT_FOUND", error: "This product no longer exists. Refresh the listing feed before retrying." });
  }
  return summary;
}

export async function triggerPricingRuleSync(
  scope: string,
  scopeId: string | null,
): Promise<void> {
  console.log(
    `[eBay Pricing Rule Sync] Triggered: scope=${scope} scopeId=${scopeId}`,
  );

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

  const result = await syncActiveListings(filter, "ebay-pricing-rule");
  console.log(
    `[eBay Pricing Rule Sync] Saved: pending=${result.pending} errors=${result.errors}`,
  );
}
