import { describe, expect, it } from "vitest";
import { assertEbayPublicationObservation } from "../../ebay-publication-observation";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

function observation() {
  return { providerAccount: { provider: "ebay", accountNamespace: "production", externalAccountId: syncIdentity.accountId,
    identityScheme: "provider_user_id", externalDisplayNameSnapshot: null, evidenceHash: "a".repeat(64) },
    marketplaceId: syncIdentity.marketplaceId, isPublished: true, externalUrl: null,
    publicationKeyIdentity: { identityNamespace: "ebay.inventory_item_group", externalId: syncIdentity.groupKey },
    listingIdentity: { identityNamespace: "ebay.listing", externalId: syncIdentity.variants[0].listingId },
    members: syncIdentity.variants.map(member => ({ sku: member.sku, variantIdentity: null,
      offerIdentity: { identityNamespace: "ebay.offer", externalId: member.offerId },
      inventoryItemIdentity: { identityNamespace: "ebay.inventory_item", externalId: member.sku } })),
    evidence: {}, observedAt: new Date("2026-10-11T21:25:00Z") };
}
describe("retained publication identity evidence", () => {
  it("accepts an exact published observer receipt without changing it", () => {
    const receipt = observation(), before = structuredClone(receipt);
    expect(assertEbayPublicationObservation(syncIdentity, receipt)).toEqual(receipt);
    expect(receipt).toEqual(before);
  });
  it("requires the actual complete observation, not just saved provider IDs", () => {
    expect(() => assertEbayPublicationObservation(syncIdentity, undefined)).toThrow(expect.objectContaining({ code: "EBAY_SYNC_PUBLICATION_UNVERIFIED" }));
  });
  it.each(["account", "group", "offer", "listing", "unpublished", "extra-member"] as const)("rejects %s evidence mismatch before projection", kind => {
    const receipt = observation();
    if (kind === "account") receipt.providerAccount.externalAccountId = "another-seller";
    if (kind === "group") receipt.publicationKeyIdentity.externalId = "another-group";
    if (kind === "offer") receipt.members[0].offerIdentity.externalId = "another-offer";
    if (kind === "listing") receipt.listingIdentity.externalId = "another-listing";
    if (kind === "unpublished") receipt.isPublished = false;
    if (kind === "extra-member") receipt.members.push({ ...receipt.members[0], sku: "another-SKU" });
    expect(() => assertEbayPublicationObservation(syncIdentity, receipt)).toThrow(expect.objectContaining({ code: "EBAY_SYNC_PROVIDER_IDENTITY_CHANGED" }));
  });
});
