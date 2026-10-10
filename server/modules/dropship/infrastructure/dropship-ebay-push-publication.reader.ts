import type { Pool } from "pg";
import { DropshipError } from "../domain/errors";
import type { DropshipMarketplaceListingPushRequest } from "../application/dropship-marketplace-listing-push-provider";
import type { DropshipMarketplaceStoreCredentials } from "./dropship-marketplace-credentials";
import type { EbayDiscoveredPublishedListing } from "../../channels/listing-connectors/ebay-listing.connector";
import { observeExistingEbayPublication } from "../../channels/ebay-existing-listing-identity";
import type { MarketplaceListingRegistrationObserver } from "../../marketplace-listings/application/registration-ports";
import type { MarketplaceObservedListingPublication } from "../../marketplace-listings/domain/listing-registration-plan";
import type { EbayListingConnectorDraft } from "../../channels/listing-connectors/ebay-listing.connector";
import { resolveDropshipEbayProviderEnvironment } from "./dropship-ebay-token-owner";
import { ebayProviderAccountNamespace } from "../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";

interface RebuildIdentityInput { vendorId: number; storeConnectionId: number; draft: EbayListingConnectorDraft }

export interface DropshipEbayPushPublicationReader {
  resolve(request: DropshipMarketplaceListingPushRequest, credential: DropshipMarketplaceStoreCredentials,
    discovered: EbayDiscoveredPublishedListing): Promise<MarketplaceObservedListingPublication>;
  resolveRebuild(request: RebuildIdentityInput, credential: DropshipMarketplaceStoreCredentials,
    discovered: EbayDiscoveredPublishedListing): Promise<MarketplaceObservedListingPublication>;
}

/** Recover a remotely published offer using the existing registration observer.
 * The publication request contains a variant ID, so resolve its real product
 * through the exact vendor-owned listing instead of treating it as a product ID. */
export class PostgresDropshipEbayPushPublicationReader implements DropshipEbayPushPublicationReader {
  constructor(private readonly database: Pick<Pool, "query">, private readonly observer: MarketplaceListingRegistrationObserver) {}

  async resolve(request: DropshipMarketplaceListingPushRequest, credential: DropshipMarketplaceStoreCredentials,
    discovered: EbayDiscoveredPublishedListing): Promise<MarketplaceObservedListingPublication> {
    const accountId = this.account(request, credential);
    const rows = await this.database.query<{ product_id: number; product_variant_id: number; is_active: boolean }>(
      `SELECT pv.product_id,pv.id AS product_variant_id,pv.is_active FROM dropship.dropship_vendor_listings listing
       JOIN catalog.product_variants pv ON pv.id=listing.product_variant_id
       WHERE listing.id=$1 AND listing.vendor_id=$2 AND listing.store_connection_id=$3 AND listing.product_variant_id=$4`,
      [request.listingId, request.vendorId, request.storeConnectionId, request.productVariantId]);
    if (rows.rows.length !== 1 || !Number.isSafeInteger(rows.rows[0].product_id) || rows.rows[0].product_id <= 0
      || discovered.members.length !== 1 || discovered.members[0].variantId !== request.productVariantId
      || discovered.members[0].sku !== request.listingIntent.sku)
      throw new DropshipError("DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED", "The published offer no longer matches this vendor's exact listing and catalog variant. Review the store listing mapping before retrying.", { retryable: false });
    const marketplaceId = request.listingIntent.marketplaceConfig.marketplaceId;
    if (typeof marketplaceId !== "string" || !marketplaceId.trim())
      throw new DropshipError("DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED", "The authorized eBay marketplace is missing from this publication request.", { retryable: false });
    const observation = await observeExistingEbayPublication({
      owner: { kind: "dropship", storeConnectionId: request.storeConnectionId, productId: rows.rows[0].product_id,
        provider: "ebay", marketplaceId },
      locator: { providerPublicationKey: null, externalListingId: discovered.listingId },
      memberCandidates: [{ productVariantId: request.productVariantId, sku: discovered.members[0].sku,
        isActive: rows.rows[0].is_active, availableQuantity: request.listingIntent.quantity }],
    }, this.observer, accountId);
    return this.matchEnvironment(observation,credential);
  }

  async resolveRebuild(request: RebuildIdentityInput, credential: DropshipMarketplaceStoreCredentials,
    discovered: EbayDiscoveredPublishedListing): Promise<MarketplaceObservedListingPublication> {
    const accountId = this.account(request, credential);
    const ids = request.draft.offers.map(offer => offer.variantId);
    const rows = await this.database.query<{ product_variant_id: number; is_active: boolean }>(
      `SELECT DISTINCT pv.id AS product_variant_id,pv.is_active FROM dropship.dropship_vendor_listings listing
       JOIN catalog.product_variants pv ON pv.id=listing.product_variant_id
       WHERE listing.vendor_id=$1 AND listing.store_connection_id=$2 AND pv.product_id=$3 AND pv.id=ANY($4::integer[])`,
      [request.vendorId,request.storeConnectionId,request.draft.productId,ids]);
    if (rows.rows.length !== ids.length || new Set(ids).size !== ids.length || discovered.members.length !== ids.length
      || request.draft.offers.some(offer => !rows.rows.some(row => row.product_variant_id === offer.variantId)
        || !discovered.members.some(member => member.variantId === offer.variantId && member.sku === offer.sku)))
      throw new DropshipError("DROPSHIP_EBAY_PUBLICATION_MAPPING_CHANGED", "The rebuilt publication does not match the exact vendor-owned product and variants. Review its listing mapping.", { retryable: false });
    const observation = await observeExistingEbayPublication({
      owner:{ kind:"dropship",storeConnectionId:request.storeConnectionId,productId:request.draft.productId,provider:"ebay",marketplaceId:request.draft.marketplaceId },
      locator:{ providerPublicationKey:null,externalListingId:discovered.listingId },
      memberCandidates:request.draft.offers.map(offer => ({ productVariantId:offer.variantId,sku:offer.sku,
        isActive:rows.rows.find(row => row.product_variant_id===offer.variantId)!.is_active,availableQuantity:offer.payload.availableQuantity })),
    }, this.observer, accountId);
    return this.matchEnvironment(observation,credential);
  }

  private matchEnvironment(observation: MarketplaceObservedListingPublication, credential: DropshipMarketplaceStoreCredentials) {
    if (observation.providerAccount.accountNamespace !== ebayProviderAccountNamespace(resolveDropshipEbayProviderEnvironment(credential)))
      throw new DropshipError("DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED", "The observed listing belongs to a different eBay environment than the authorized store connection.", { retryable:false });
    return observation;
  }

  private account(request: { vendorId: number; storeConnectionId: number }, credential: DropshipMarketplaceStoreCredentials): string {
    if (credential.vendorId !== request.vendorId || credential.storeConnectionId !== request.storeConnectionId
      || credential.platform !== "ebay" || !credential.externalAccountId || credential.externalAccountIdentityScheme !== "ebay_user_id"
      || !credential.externalAccountVerifiedAt)
      throw new DropshipError("DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED", "The published offer cannot be adopted without this store's verified eBay account. Reconnect the intended store account.", { retryable: false });
    return credential.externalAccountId;
  }
}
