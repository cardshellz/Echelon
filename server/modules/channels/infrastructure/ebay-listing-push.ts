import { z } from "zod";
import { db, pool, getDatabasePoolSnapshot } from "../../../db";
import { EBAY_CHANNEL_ID, atpService, ebayListingPhotoResolver, getAuthService } from "./ebay-api-runtime";
import { createEbayRouteListingClient, createEbayRouteListingLifecycleClient, getExistingEbayListingPhotos } from "./ebay-listing-client";
import { determineVariationAspectName, resolveChannelPrice } from "./ebay-listing-helpers";
import { buildEbayRouteListingDraft } from "../ebay-listing-draft";
import { EbayMarketplaceListingConnector, type EbayListingConnectorDraft, type EbayListingConnectorResult, type EbayPublishedListingIdentityResolver } from "../listing-connectors/ebay-listing.connector";
import { EbayListingSyncError, ebayListingSyncIdentitySchema, type EbayListingSyncIdentity } from "../ebay-listing-sync.domain";
import { EbayListingPushService, EbayListingPushSkipped, ebayListingPushFailure, type EbayListingPushRequest, type EbayListingPushResult } from "../ebay-listing-push.service";
import { PostgresEbayListingPushRepository } from "./ebay-listing-push.repository";
import { readExistingEbayListingIdentityForProduct } from "../ebay-listing-sync";
import { createEbayMarketplaceRegistrationAdapters } from "../adapters/ebay/ebay-marketplace-registration.factory";
import { observeExistingEbayPublication } from "../ebay-existing-listing-identity";

const repository = new PostgresEbayListingPushRepository(pool, EBAY_CHANNEL_ID, () => new Date(),
  () => getDatabasePoolSnapshot().maximumConnections);
const connector = new EbayMarketplaceListingConnector();
const metadataSchema = z.object({
  marketplaceId: z.string().trim().min(1).optional().default("EBAY_US"),
  fulfillmentPolicyId: z.string().trim().min(1).nullable().optional().default(null),
  returnPolicyId: z.string().trim().min(1).nullable().optional().default(null),
  paymentPolicyId: z.string().trim().min(1).nullable().optional().default(null),
  merchantLocationKey: z.string().trim().min(1).optional().default("card-shellz-hq"),
}).passthrough();

async function context() {
  const auth = getAuthService();
  if (!auth) throw new EbayListingSyncError("EBAY_SYNC_AUTH_REQUIRED", "eBay OAuth is not configured. Reconnect the intended eBay account in Connection settings.");
  const account = await auth.getVerifiedProviderAccount(EBAY_CHANNEL_ID);
  const connections = await pool.query<{ id: number; metadata: unknown }>(
    "SELECT id, metadata FROM channels.channel_connections WHERE channel_id=$1 LIMIT 2", [EBAY_CHANNEL_ID]);
  if (!account || connections.rows.length !== 1)
    throw new EbayListingSyncError("EBAY_SYNC_AUTH_REQUIRED", "One verified eBay account connection is required before publishing. Reconnect the intended account.");
  const connection = connections.rows[0];
  return { auth, account, connectionId: connection.id, metadata: metadataSchema.parse(connection.metadata ?? {}) };
}

/** Read-only scope source shared with initial publication. A recovery receipt
 * permits fresh canonical inventory; it never manufactures a published listing. */
export async function readEbayPushRecoveryIdentity(productId: number): Promise<EbayListingSyncIdentity> {
  z.number().int().positive().max(2_147_483_647).parse(productId);
  const ctx = await context();
  const product = await repository.readProduct(productId);
  if ((await repository.currentListingIds(productId)).length > 0)
    throw new EbayListingSyncError("EBAY_LISTING_ALREADY_PUBLISHED", "This product already has a saved eBay listing. Use its Sync action and review that saved update's recovery details.");
  await repository.readCategory(product.product_type);
  const variants = await repository.readVariants(productId);
  return ebayListingSyncIdentitySchema.parse({ channelId: EBAY_CHANNEL_ID, productId,
    connectionId: ctx.connectionId, accountId: ctx.account.externalAccountId, marketplaceId: ctx.metadata.marketplaceId,
    groupKey: variants.length > 1 ? product.sku || `PROD-${productId}` : null,
    variants: variants.map(variant => ({ variantId: variant.id, sku: variant.sku, catalogSku: variant.catalog_sku,
      externalSku: variant.sku, offerId: variant.external_variant_id, listingId: variant.external_product_id, contentSyncEnabled: true })),
  });
}

async function executeProduct(productId: number, command: EbayListingPushRequest, onRateLimit?: (seconds: number) => void): Promise<EbayListingPushResult> {
  return repository.withProductLock(productId, async () => {
    let productName = `Product ${productId}`;
    try {
      const ctx = await context();
      const product = await repository.readProduct(productId);
      productName = product.name;
      const category = await repository.readCategory(product.product_type);
      const variants = await repository.readVariants(productId);
      const listingIds = await repository.currentListingIds(productId);
      if (!command.rebuild && !command.updateExisting && listingIds.length > 0)
        throw new EbayListingSyncError("EBAY_LISTING_ALREADY_PUBLISHED", "This product already has an eBay listing. Close Publish and use Sync on its listing row to update its content, photos and inventory.");
      const browseCategoryId = product.ebay_browse_category_id || category?.ebay_browse_category_id;
      if (!browseCategoryId) throw new EbayListingSyncError("EBAY_LISTING_PREFLIGHT_FAILED", "Choose an eBay browse category for this product or its product type before publishing.");
      const effectivePolicies = {
        fulfillmentPolicyId: product.ebay_fulfillment_policy_override || category?.fulfillment_policy_override || ctx.metadata.fulfillmentPolicyId,
        returnPolicyId: product.ebay_return_policy_override || category?.return_policy_override || ctx.metadata.returnPolicyId,
        paymentPolicyId: product.ebay_payment_policy_override || category?.payment_policy_override || ctx.metadata.paymentPolicyId,
      };
      const accessToken = await ctx.auth.getAccessToken(EBAY_CHANNEL_ID);
      const reviewedPreview = command.updateExisting?.preview ?? (command.rebuild?.mode === "execute" ? command.rebuild.preview : undefined);
      // Execution revalidates the reviewed snapshot inside the lifecycle connector,
      // including a legitimately withdrawn group after interrupted rebuilding.
      let existingIdentity: EbayListingSyncIdentity | null = null;
      if (command.rebuild?.mode === "preview") {
        try { existingIdentity = await readExistingEbayListingIdentityForProduct(productId); }
        catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          if (code === "EBAY_REGISTRATION_LISTING_NOT_FOUND" || code === "EBAY_REGISTRATION_LISTING_NOT_LIVE")
            throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "eBay did not expose this product as a live listing. If a rebuild was interrupted, resume it using its saved review. If that review is unavailable, an administrator must recover its original eBay group and offer mapping before running Analyze again.", { cause: error });
          throw error;
        }
      }
      const groupKey = existingIdentity?.groupKey ?? reviewedPreview?.groupKey ?? (product.sku || `PROD-${productId}`);
      if (reviewedPreview && existingIdentity && existingIdentity.groupKey !== reviewedPreview.groupKey)
        throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The eBay group changed after this listing review. Analyze the listing again before applying a change.");
      const photoVariants = variants.map(variant => ({ variantId: variant.id, sku: variant.catalog_sku }));
      const providerPhotoVariants = variants.map(variant => ({ variantId: variant.id, sku: variant.sku }));
      const photoPlan = await ebayListingPhotoResolver.resolve({ productId, channelId: EBAY_CHANNEL_ID, variants: photoVariants,
        readExistingPhotos: () => getExistingEbayListingPhotos({ accessToken, groupKey, variants: providerPhotoVariants }) });
      const prices = new Map<number, number>();
      for (const variant of variants)
        prices.set(variant.id, await resolveChannelPrice(db, EBAY_CHANNEL_ID, productId, variant.id, variant.price_cents));
      const quantities = await atpService.getAtpPerVariant(productId);
      let routeDraft: ReturnType<typeof buildEbayRouteListingDraft>;
      try {
        routeDraft = buildEbayRouteListingDraft({ productId, product, variants, photoPlan,
          aspects: await repository.readAspects(product), isMultiVariant: variants.length > 1,
          variationAspectName: variants.length > 1 ? determineVariationAspectName(variants) : "",
          variantPrices: prices, atpByVariantId: new Map(quantities.map(row => [row.productVariantId, row.atpUnits])),
          marketplaceId: ctx.metadata.marketplaceId, ebayBrowseCategoryId: browseCategoryId, effectivePolicies,
          storeCategoryNames: category?.ebay_store_category_name ? [category.ebay_store_category_name] : [],
          merchantLocationKey: ctx.metadata.merchantLocationKey,
          ...(existingIdentity ? { existingGroupKey: existingIdentity.groupKey }
            : reviewedPreview ? { existingGroupKey: reviewedPreview.groupKey } : {}),
        });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw new EbayListingSyncError("EBAY_LISTING_VALIDATION_FAILED", error instanceof Error ? error.message : "The listing payload is invalid.", { cause: error });
      }
      const clientInput = { accessToken, onRateLimit, expectedAccountId: ctx.account.externalAccountId, expectedConnectionId: ctx.connectionId };
      const draft: EbayListingConnectorDraft = { productId, marketplaceId: ctx.metadata.marketplaceId,
        inventoryItems: routeDraft.inventoryItems, offers: routeDraft.offers, itemGroup: routeDraft.itemGroup,
        publishMode: "publish", hasExistingExternalIds: listingIds.length > 0,
        existingExternalProductId: listingIds.length === 1 ? listingIds[0] : undefined,
        existingOfferIdsByVariantId: Object.fromEntries(variants.map(variant => [variant.id, variant.external_variant_id])),
      };
      const resolvePublishedIdentity: EbayPublishedListingIdentityResolver = discovered => observeExistingEbayPublication({
        owner: { kind: "channel", channelId: EBAY_CHANNEL_ID, productId, provider: "ebay", marketplaceId: ctx.metadata.marketplaceId },
        locator: { externalListingId: discovered.listingId, providerPublicationKey: null },
        memberCandidates: draft.offers.map(offer => ({ productVariantId: offer.variantId, sku: offer.sku,
          isActive: true, availableQuantity: offer.payload.availableQuantity })),
      }, createEbayMarketplaceRegistrationAdapters({ authService: ctx.auth }).observer, ctx.account.externalAccountId);
      let result: EbayListingConnectorResult;
      if (command.rebuild || command.updateExisting) {
        if (listingIds.length !== 1) throw new EbayListingSyncError("EBAY_SYNC_MAPPING_INVALID", "A reviewed listing change requires exactly one saved eBay listing. Review the product's listing mapping.");
        const client = createEbayRouteListingLifecycleClient(clientInput);
        if (command.rebuild?.mode === "preview") {
          const rebuildPreview = await connector.previewListingRebuild({ client, draft, currentExternalListingId: listingIds[0] });
          return { productId, productName, variantCount: variants.length, success: true, status: "success", listingId: listingIds[0], rebuildPreview };
        }
        result = command.updateExisting
          ? await connector.updateExistingListing({ client, draft, preview: command.updateExisting.preview })
          : await connector.executeListingRebuild({ client, draft, resolvePublishedIdentity, preview: command.rebuild!.mode === "execute" ? command.rebuild!.preview : neverPreview() });
      } else result = await connector.pushListing({ client: createEbayRouteListingClient(clientInput), draft, resolvePublishedIdentity });
      const removedSkus = "removedSkus" in result && Array.isArray(result.removedSkus) ? result.removedSkus as string[] : [];
      try { await repository.projectSuccess(productId, variants, result, prices, removedSkus); }
      catch (error) {
        if (error instanceof EbayListingSyncError) throw error;
        throw new EbayListingSyncError("EBAY_SYNC_PERSISTENCE_FAILED", "eBay returned a publication result, but Echelon could not save its complete local mapping. Retry this product to discover and verify its existing offers before further publication.", { cause: error });
      }
      return { productId, productName, variantCount: variants.length, success: true, status: "success", listingId: result.externalProductId,
        variantDetails: variants.map(variant => ({ sku: variant.sku, success: true })) };
    } catch (caught) {
      const error = caught instanceof z.ZodError
        ? new EbayListingSyncError("EBAY_LISTING_PREFLIGHT_FAILED", `Saved listing inputs are invalid: ${caught.issues.map(issue => issue.path.join(".") || "listing").join(", ").slice(0, 300)}. Review this product and its eBay connection settings before publishing.`, { cause: caught })
        : caught;
      let failure = ebayListingPushFailure(productId, error, productName);
      console.error(JSON.stringify({ event: "ebay_listing_push_failed", productId, code: failure.code, message: failure.error }));
      if (command.rebuild?.mode !== "preview" && !(error instanceof EbayListingPushSkipped)
        && failure.code !== "EBAY_LISTING_ALREADY_PUBLISHED") {
        try { await repository.recordFailure(productId, failure.error ?? "Listing publication failed."); }
        catch (persistenceError) {
          console.error(JSON.stringify({ event: "ebay_listing_push_failure_unsaved", productId, originalCode: failure.code,
            message: persistenceError instanceof Error ? persistenceError.message : "Unknown persistence error" }));
          failure = ebayListingPushFailure(productId, new EbayListingSyncError("EBAY_SYNC_PERSISTENCE_FAILED",
            `${failure.error} Echelon also could not save this error. Copy these details and retry after database connectivity returns.`), productName);
        }
      }
      return failure;
    }
  });
}
function neverPreview(): never { throw new Error("Reviewed rebuild execution requires a preview."); }

export const ebayListingPushService = new EbayListingPushService({ execute: executeProduct });
