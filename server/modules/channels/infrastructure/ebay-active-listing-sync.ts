import { ebayBusinessPolicies } from "../ebay-business-policies";
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
import { isVariantSellable, isExistingEbayListingSyncCandidate } from "../ebay-listing-eligibility";

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
  captureEbayListingSourceIdentity,
  assertEbayListingSourceIdentityUnchanged,
  resolveExistingEbayListingIdentity,
} from "../ebay-existing-listing-identity";
import { admitEbayListingSyncProducts } from "../ebay-listing-sync-admission";
import { createEbayMarketplaceRegistrationAdapters } from "../adapters/ebay/ebay-marketplace-registration.factory";
import { quantityProviderResponseRecovery, automaticEbayPublicationRecovery, ebayPublicationReconciliationRepository, ebayPublicationRejectionReader,
  EbayPublicationContentRefreshRejectedError } from "../../inventory-planning/quantity-publication";
import {
  type EbayProductSyncResult,
} from "@shared/types/ebay-listing-sync";
import {
  determineVariationAspectName,
  resolveChannelPrice,
  delay,
} from "./ebay-listing-helpers";
import type { EbayListingMappingSource } from "../ebay-listing-mapping.service";
import { EbayListingOperationExecution, EbayPublicationCompletionExecution } from "../ebay-publication-completion.service";
import { prepareEbayPublicationCompletion } from "./ebay-listing-push";
import { assertEbayPublicationCompatibility } from "./ebay-publication-compatibility";
import { EbayListingWithdrawalExecution,EbayWithdrawalOperationExecution } from "../ebay-listing-withdrawal.service";
import { prepareEbayWithdrawal } from "./ebay-listing-withdrawal";
import { ensureEbayListingInventoryReady } from "./ebay-listing-inventory-readiness";
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
type EbayListingReadDatabase = Pick<typeof db, "select">;
async function readActiveEbaySyncRows(filter: SyncFilter | null, allSavedMembers = false, readDb: EbayListingReadDatabase = db) {
  // Read retained mappings before applying the canonical selection predicate.
  // Keep every saved mapping for fencing and audit. Provider observation later
  // distinguishes actual live members from disabled unpublished nonmembers.
  const conditions = [
    eq(channelListings.channelId, EBAY_CHANNEL_ID),
    or(eq(channelListings.syncStatus, "synced"), isNotNull(channelListings.externalProductId), isNotNull(channelListings.externalVariantId), isNotNull(channelListings.externalSku)),
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

  const rows = await readDb
    .select({
      listing_id: channelListings.id,
      mapping_exists: sql<boolean>`true`,
      listing_sync_status: channelListings.syncStatus,
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
  return allSavedMembers ? rows : rows.filter(row => isExistingEbayListingSyncCandidate({
    productActive: row.product_is_active,
    variantActive: row.variant_is_active,
    salesEligibility: row.variant_sales_eligibility,
    productExcluded: row.product_excluded,
    productOverrideIsListed: row.product_override_is_listed,
    typeListingEnabled: row.type_listing_enabled,
    variantExcluded: row.variant_excluded,
    variantOverrideIsListed: row.variant_override_is_listed,
    syncStatus: row.listing_sync_status,
    externalListingId: row.external_product_id,
    externalOfferId: row.external_variant_id,
  }));
}
async function context(readDb: EbayListingReadDatabase = db, authService = getAuthService()) {
  if (!authService)
    throw new EbayListingSyncError(
      "EBAY_SYNC_AUTH_REQUIRED",
      "eBay OAuth is not configured.",
    );
  const account = await authService.getVerifiedProviderAccount(EBAY_CHANNEL_ID);
  const connections = await readDb
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
  return captureEbayListingSourceIdentity(rows, {
    channelId: EBAY_CHANNEL_ID,
    connectionId: ctx.conn.id,
    accountId: ctx.account.externalAccountId,
    marketplaceId: ctx.marketplaceId,
  });
}
/** Shared complete source snapshot for diagnosis and transaction-fenced repair.
 * The optional database is the caller's transaction, never a provider writer. */
interface MappingSourceReadOptions { database?: EbayListingReadDatabase; authService?: ReturnType<typeof getAuthService> }
export async function readExistingEbayListingMappingIdentity(productId: number, options: MappingSourceReadOptions = {}) {
  z.number().int().positive().max(2147483647).parse(productId);
  const readDb = options.database ?? db;
  const ctx = await context(readDb, options.authService === undefined ? getAuthService() : options.authService);
  const rows = await readActiveEbaySyncRows({ productIds: [productId] }, true, readDb);
  return { identity: identityFromRows(rows, ctx), environment: ctx.authService.getEnvironment(), rows };
}
export async function readExistingEbayListingMappingSource(productId: number, options: MappingSourceReadOptions = {}): Promise<EbayListingMappingSource> {
  const snapshot = await readExistingEbayListingMappingIdentity(productId, options);
  const availability = await atpService.getAtpPerVariant(productId);
  const byVariantId = new Map(availability.map(member => [member.productVariantId, member.atpUnits]));
  return { identity: snapshot.identity, environment: snapshot.environment,
    candidates: snapshot.identity.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku,
      isActive: snapshot.rows.find(row => row.variant_id === member.variantId)!.variant_is_active,
      availableQuantity: byVariantId.get(member.variantId) ?? 0 })) };
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
  const { identity: boundIdentity, observation: providerObservation } = await resolveExistingEbayListingIdentity(
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
  return { ctx, listingsResult, sourceIdentity, boundIdentity, providerObservation, syncAtpByVariantId };
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
  const { ctx, listingsResult, sourceIdentity, boundIdentity, providerObservation, syncAtpByVariantId } =
    await readExistingEbayIdentitySnapshot(identity.productId, identity);
  const { metadata, marketplaceId } = ctx,
    accessToken = await ctx.authService.getAccessToken(EBAY_CHANNEL_ID);
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
  // Only verified live members belong in the group payload. The full source
  // snapshot still fences retired mappings; they are never deleted or edited.
  const boundVariantIds = new Set(boundIdentity.variants.map(member => member.variantId));
  const variants = listingsResult.filter(row => boundVariantIds.has(row.variant_id));
  const productId = identity.productId;
  const product = variants[0];
  // Get effective eBay category
  let ebayBrowseCategoryId = product.ebay_browse_category_id;
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
      if (catRow.ebayStoreCategoryName)
        storeCategoryNames = [catRow.ebayStoreCategoryName];
    }
  }

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

  const resolvedPolicies = await ebayBusinessPolicies.resolveProductPolicies({ productId,
    variantIds: [...sellableVariantIds], expectedScope: { channelId: EBAY_CHANNEL_ID,
      connectionId: identity.connectionId, accountId: identity.accountId,
      environment: ctx.authService.getEnvironment(), marketplaceId } });

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
    resolvedPoliciesByVariantId: resolvedPolicies.byVariantId,
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
    providerObservation,
    client: ebayClient,
    draft: preparedDraft,
    assertInventoryReady: execution => ensureEbayListingInventoryReady({
      channelId: boundIdentity.channelId, connectionId: boundIdentity.connectionId,
      accountId: boundIdentity.accountId, environment: ctx.authService.getEnvironment(),
      productId, purpose: "sync",
      variants: boundIdentity.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku })),
    }, execution, new Date(), { sourceIdentity, observation: providerObservation }),
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
  new PostgresEbayListingSyncRepository(pool, ebayPublicationRejectionReader),
  new EbayWithdrawalOperationExecution(new EbayListingOperationExecution(new EbayExistingListingSyncExecution(
    prepareActiveEbayListingSync,
    quantityProviderResponseRecovery,
    existingListingConnector,
    automaticEbayPublicationRecovery,
  ), new EbayPublicationCompletionExecution(prepareEbayPublicationCompletion, quantityProviderResponseRecovery,
    existingListingConnector, assertEbayPublicationCompatibility, automaticEbayPublicationRecovery)),new EbayListingWithdrawalExecution(prepareEbayWithdrawal,quantityProviderResponseRecovery)),
  () => new Date(),
  randomUUID,
  ebayPublicationReconciliationRepository,
);
export async function syncActiveListings(
  filter: SyncFilter | null,
  actor = "ebay-listing-sync",
  commandKey?: string,
  expectedDestination?: { connectionId: number; accountId: string },
): Promise<EbayProductSyncResult> {
  filter = filterSchema.parse(filter);
  const validatedActor = z.string().trim().min(1).max(200).parse(actor);
  if (commandKey !== undefined) z.string().uuid().parse(commandKey);
  const ctx = await context();
  if (expectedDestination) {
    const expected = z.object({ connectionId: z.number().int().positive().max(2147483647),
      accountId: z.string().trim().min(1).max(240) }).strict().parse(expectedDestination);
    if (ctx.conn.id !== expected.connectionId || ctx.account.externalAccountId !== expected.accountId)
      throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The eBay connection changed. The earlier recovery cannot update a different account.");
  }
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
    findAcceptedCommand: async (key, productId, requestedBy) => {
      const saved = await ebayListingSyncService.getByCommand(key, EBAY_CHANNEL_ID, requestedBy, "sync");
      if (saved && (saved.productId !== productId || saved.identity.connectionId !== ctx.conn.id
        || saved.identity.accountId !== ctx.account.externalAccountId))
        throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "This saved Sync command belongs to another product or eBay destination.");
      return saved;
    },
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

/** Inventory's recurring drift check asks the existing channel owner to refresh
 * content. It cannot create offers, switch seller accounts, or select quantities.
 * A lost acknowledgement reuses the same admission key; a durable rejection is
 * explicit so the watch can try a new command after the underlying issue changes. */
export async function refreshRecoveredEbayListing(input: {
  productId: number; connectionId: number; accountId: string; commandKey: string;
}): Promise<{ jobId: string }> {
  const request = z.object({ productId: z.number().int().positive().max(2147483647),
    connectionId: z.number().int().positive().max(2147483647), accountId: z.string().trim().min(1).max(240),
    commandKey: z.string().uuid() }).strict().parse(input);
  const actor = "system:ebay-recovery-reconciliation";
  // Resolve a consumed command before capturing today's catalog. Otherwise a
  // lost enqueue acknowledgement followed by a rename/inclusion change traps
  // the old key in a permanent replay conflict. This is a receipt read only;
  // the next durable watch cycle requests fresh content with its own key.
  const prior = await ebayListingSyncService.getByCommand(request.commandKey, EBAY_CHANNEL_ID, actor, "sync");
  if (prior) {
    // The receipt proves this was a Sync command even when it joined an existing
    // publication. The job's original operation remains immutable.
    if (prior.productId !== request.productId
      || prior.identity.connectionId !== request.connectionId || prior.identity.accountId !== request.accountId)
      throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "The saved recovery command belongs to another listing or destination.");
    return { jobId: prior.id };
  }
  const rejection = await ebayListingSyncService.getAdmission(request.commandKey, EBAY_CHANNEL_ID);
  if (rejection) {
    if (rejection.productId !== request.productId || rejection.operation !== "sync")
      throw new EbayListingSyncError("EBAY_SYNC_REPLAY_CONFLICT", "The saved rejection belongs to another listing operation.");
    throw new EbayPublicationContentRefreshRejectedError(rejection.code ?? "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE",
      rejection.message ?? "This listing needs its saved selection or catalog issue corrected.");
  }
  const result = await syncActiveListings({ productIds: [request.productId] },
    actor, request.commandKey,
    { connectionId: request.connectionId, accountId: request.accountId });
  const job = result.jobs.find(member => member.productId === request.productId);
  if (job?.kind === "admission") throw new EbayPublicationContentRefreshRejectedError(
    job.code ?? "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE", job.message ?? "This listing needs its saved selection or catalog issue corrected.");
  if (!job) throw new EbayListingSyncError("EBAY_SYNC_PERSISTENCE_FAILED", "The current listing refresh has not been durably queued.");
  return { jobId: job.id };
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
