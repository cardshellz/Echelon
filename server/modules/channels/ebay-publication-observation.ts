import { marketplaceObservedListingPublicationSchema, type MarketplaceObservedListingPublication } from "../marketplace-listings";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";

/** Validate the actual observer receipt before retaining it as identity proof.
 * Provider quantities in evidence never acknowledge local inventory. */
export function assertEbayPublicationObservation(identity: EbayListingSyncIdentity, input: unknown): MarketplaceObservedListingPublication {
  const parsed = marketplaceObservedListingPublicationSchema.safeParse(input);
  if (!parsed.success) throw new EbayListingSyncError("EBAY_SYNC_PUBLICATION_UNVERIFIED", "The published listing requires its complete saved eBay observation before local completion.");
  const observation = parsed.data;
  if (observation.providerAccount.provider !== "ebay" || !["production", "sandbox"].includes(observation.providerAccount.accountNamespace)
    || observation.providerAccount.externalAccountId !== identity.accountId || observation.marketplaceId !== identity.marketplaceId
    || !observation.isPublished || observation.listingIdentity.identityNamespace !== "ebay.listing"
    || (observation.publicationKeyIdentity?.externalId ?? null) !== identity.groupKey
    || (identity.groupKey !== null && observation.publicationKeyIdentity?.identityNamespace !== "ebay.inventory_item_group")
    || observation.members.length !== identity.variants.length || new Set(observation.members.map(member => member.sku)).size !== identity.variants.length
    || identity.variants.some(member => member.listingId !== observation.listingIdentity.externalId
      || !observation.members.some(observed => observed.sku === member.sku
        && observed.offerIdentity?.identityNamespace === "ebay.offer" && observed.offerIdentity.externalId === member.offerId
        && observed.inventoryItemIdentity?.identityNamespace === "ebay.inventory_item" && observed.inventoryItemIdentity.externalId === member.sku)))
    throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The saved eBay observation does not match this publication's exact account, group, offers and listing.");
  return observation;
}
