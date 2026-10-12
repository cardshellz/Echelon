import { PgMarketplaceListingRegistrationRepository, type EbayListingInspection } from "../../marketplace-listings";
import type { EbayListingSyncIdentity } from "../ebay-listing-sync.domain";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import { pool } from "../../../db";

const registration = new PgMarketplaceListingRegistrationRepository(pool);

/** Registration owns provider identity claims. Both reviewed continuation and
 * ordinary Publish use its compatibility gate before admitting provider work. */
export async function assertEbayPublicationCompatibility(
  source: EbayListingSyncIdentity, inspection: EbayListingInspection, target: EbayListingSyncIdentity,
): Promise<void> {
  const account = inspection.providerAccount;
  if (account.provider !== "ebay" || account.externalAccountId !== source.accountId
    || (account.accountNamespace !== "production" && account.accountNamespace !== "sandbox"))
    throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The connected eBay account changed before publication. Check the connection and review this request again.");
  const owner = { kind: "channel" as const, channelId: source.channelId, productId: source.productId,
    provider: "ebay" as const, marketplaceId: source.marketplaceId };
  if (inspection.publication) {
    await registration.assertCompatiblePublication({ owner, observation: inspection.publication,
      memberCandidates: source.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku,
        // Compatibility checks only identity; quantity is planned by inventory
        // admission immediately before each quantity-bearing provider write.
        isActive: member.contentSyncEnabled !== false, availableQuantity: 0 })) });
  } else {
    await registration.assertCompatibleUnpublishedPublication({ owner,
      providerAccount: { provider: "ebay", accountNamespace: account.accountNamespace, externalAccountId: account.externalAccountId },
      groupKey: target.groupKey, members: target.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, offerId: member.offerId })) });
  }
}
