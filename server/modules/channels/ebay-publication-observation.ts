import { marketplaceObservedListingPublicationSchema, buildEbayRegistrationIdentityNamespace, type MarketplaceObservedListingPublication } from "../marketplace-listings";
import { EbayListingSyncError, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";

/** Validate the actual observer receipt before retaining it as identity proof.
 * Provider quantities in evidence never acknowledge local inventory. */
export function assertEbayPublicationObservation(identity: EbayListingSyncIdentity, input: unknown): MarketplaceObservedListingPublication {
  const parsed = marketplaceObservedListingPublicationSchema.safeParse(input);
  if (!parsed.success) throw new EbayListingSyncError("EBAY_SYNC_PUBLICATION_UNVERIFIED", "The published listing requires its complete saved eBay observation before local completion.");
  const observation = parsed.data;
  const environment = observation.providerAccount.accountNamespace;
  if (environment !== "production" && environment !== "sandbox")
    throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The saved eBay observation has an unsupported account environment.");
  const namespace = (role: "listing" | "inventory_item_group" | "offer" | "inventory_item") =>
    buildEbayRegistrationIdentityNamespace({ environment, marketplaceId: identity.marketplaceId, role });
  const retained = identity.retainedGroupSkus ?? [];
  const groupSkus = observation.evidence.groupVariantSkus;
  if (retained.length && (!Array.isArray(groupSkus) || identity.groupKey === null
    || groupSkus.length !== identity.variants.length + retained.length
    || new Set(groupSkus).size !== groupSkus.length
    || [...identity.variants.map(member => member.sku), ...retained].some(sku => !groupSkus.includes(sku)))) {
    throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The retained group membership differs from the exact saved eBay observation.");
  }
  if (observation.providerAccount.provider !== "ebay"
    || observation.providerAccount.externalAccountId !== identity.accountId || observation.marketplaceId !== identity.marketplaceId
    || !observation.isPublished || observation.listingIdentity.identityNamespace !== namespace("listing")
    || (observation.publicationKeyIdentity?.externalId ?? null) !== identity.groupKey
    || (identity.groupKey !== null && observation.publicationKeyIdentity?.identityNamespace !== namespace("inventory_item_group"))
    || observation.members.length !== identity.variants.length || new Set(observation.members.map(member => member.sku)).size !== identity.variants.length
    || identity.variants.some(member => member.listingId !== observation.listingIdentity.externalId
      || !observation.members.some(observed => observed.sku === member.sku
        && observed.offerIdentity?.identityNamespace === namespace("offer") && observed.offerIdentity.externalId === member.offerId
        && observed.inventoryItemIdentity?.identityNamespace === namespace("inventory_item") && observed.inventoryItemIdentity.externalId === member.sku)))
    throw new EbayListingSyncError("EBAY_SYNC_PROVIDER_IDENTITY_CHANGED", "The saved eBay observation does not match this publication's exact account, group, offers and listing.");
  return observation;
}
