import { describe, expect, it } from "vitest";
import { isExistingEbayListingSyncCandidate, type ExistingEbayListingSyncCandidate } from "../../ebay-listing-eligibility";

const candidate: ExistingEbayListingSyncCandidate = {
  productActive: true, variantActive: true, salesEligibility: "sellable",
  syncStatus: "pending", externalListingId: null, externalOfferId: "offer-1",
};

describe("existing eBay listing sync selection", () => {
  it.each(["pending", "synced", "error"])("admits a saved %s offer before a listing ID exists", syncStatus => {
    expect(isExistingEbayListingSyncCandidate({ ...candidate, syncStatus })).toBe(true);
  });
  it("admits a saved listing for identity inspection even when an offer ID needs resolving", () => {
    expect(isExistingEbayListingSyncCandidate({ ...candidate, externalOfferId: null, externalListingId: "listing-1" })).toBe(true);
  });
  it.each(["ended", "deleted", "unknown", null, undefined])("cannot republish a %s mapping through bulk Sync", syncStatus => {
    expect(isExistingEbayListingSyncCandidate({ ...candidate, syncStatus })).toBe(false);
  });
  it.each([null, "", "   "])("does not treat an absent offer (%j) or a SKU-only record as an existing listing", externalOfferId => {
    expect(isExistingEbayListingSyncCandidate({ ...candidate, externalOfferId })).toBe(false);
  });
  it.each([
    { productActive: false }, { variantActive: false }, { salesEligibility: "internal_only" as const },
    { productExcluded: true }, { productOverrideIsListed: 0 }, { typeListingEnabled: false },
    { variantExcluded: true }, { variantOverrideIsListed: 0 },
  ])("honors the canonical channel selection and catalog eligibility: %j", change => {
    expect(isExistingEbayListingSyncCandidate({ ...candidate, ...change })).toBe(false);
  });
});
