import { ChannelProviderReadError } from "@shared/channel-provider-read";
import { ebayListingInspectionIssueSchema, type EbayListingInspection, type EbayListingInspectionIssue } from "../marketplace-listings/domain/ebay-listing-inspection";
import { ebayListingSyncIdentitySchema, EbayListingSyncError, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";

export function publicationInspectionError(input: EbayListingInspectionIssue): EbayListingSyncError {
  const issue = ebayListingInspectionIssueSchema.parse(input);
  return new EbayListingSyncError(issue.code, issue.message,
    issue.providerRead ? { cause: new ChannelProviderReadError(issue.providerRead) } : undefined);
}

/** Bind exact provider resources without treating an unpublished offer as a listing. */
export function resolveEbayPublicationTarget(source: EbayListingSyncIdentity, inspection: EbayListingInspection): EbayListingSyncIdentity {
  ebayListingSyncIdentitySchema.parse(source);
  if (inspection.providerAccount.provider !== "ebay" || inspection.providerAccount.externalAccountId !== source.accountId)
    throw new EbayListingSyncError("EBAY_SYNC_ACCOUNT_CHANGED", "The current eBay account differs from the account authorized for this publication. Reconnect the intended account and review again.");
  const readFailure = inspection.skus.find(member => member.issue)?.issue;
  if (readFailure) throw publicationInspectionError(readFailure);
  const published = inspection.publication;
  const target = published ? { groupKey: published.publicationKeyIdentity?.externalId ?? null,
    skus: published.members.map(member => member.sku) } : inspection.unpublishedTarget;
  if (!target) throw publicationInspectionError(inspection.publicationIssue ?? {
    code: "EBAY_PUBLICATION_TARGET_UNVERIFIED",
    message: "eBay did not expose one complete unpublished product or published listing. Review the offer and group membership before publishing.",
  });
  // Ordinary Publish sources have no group. A non-null publication source is
  // the exact group accepted in Finish Publishing's fresh operator review.
  if (source.groupKey !== null && target.groupKey !== source.groupKey)
    throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The unpublished group changed after this publication was reviewed. Review its current mapping before publishing.");
  if (target.skus.length !== source.variants.length || new Set(target.skus).size !== source.variants.length
    || source.variants.some(member => !target.skus.includes(member.sku))
    || (source.variants.length > 1 && target.groupKey === null))
    throw new EbayListingSyncError("EBAY_SYNC_MEMBERSHIP_CHANGED", "The complete eBay group differs from the exact product variants selected for publication. Review its full SKU membership.");
  if (published && (published.marketplaceId !== source.marketplaceId || !published.isPublished))
    throw new EbayListingSyncError("EBAY_PUBLICATION_TARGET_UNVERIFIED", "eBay did not verify a live publication in the selected marketplace.");
  return ebayListingSyncIdentitySchema.parse({ ...source, groupKey: target.groupKey, variants: source.variants.map(member => {
    const observed = inspection.skus.find(row => row.sku === member.sku);
    const final = published?.members.find(row => row.sku === member.sku);
    const offerId = final?.offerIdentity?.externalId ?? observed?.offers[0]?.offerId ?? null;
    const listingId = published?.listingIdentity.externalId ?? null;
    if (!observed || observed.offers.length > 1 || (member.offerId !== null && member.offerId !== offerId)
      || (member.listingId !== null && member.listingId !== listingId))
      throw new EbayListingSyncError("EBAY_SYNC_OFFER_IDENTITY_CHANGED", `SKU ${member.sku} no longer has its exact saved eBay offer or listing. Review its mapping before publishing.`);
    return { ...member, externalSku: member.sku, offerId, listingId };
  }) });
}

/** A target is immutable except that previously absent offers/listing can be
 * observed after preparation. A retry never changes group, SKU, or known ID. */
export function assertEbayPublicationTargetUnchanged(expected: EbayListingSyncIdentity, current: EbayListingSyncIdentity): void {
  if (expected.channelId !== current.channelId || expected.productId !== current.productId
    || expected.connectionId !== current.connectionId || expected.accountId !== current.accountId
    || expected.marketplaceId !== current.marketplaceId || expected.groupKey !== current.groupKey
    || expected.variants.length !== current.variants.length || expected.variants.some(member => {
      const found = current.variants.find(row => row.variantId === member.variantId);
      return !found || found.sku !== member.sku || (member.offerId !== null && found.offerId !== member.offerId)
        || (member.listingId !== null && found.listingId !== member.listingId);
    })) throw new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "The provider resources differ from this saved publication target. Review the current mapping before starting another publication.");
}
