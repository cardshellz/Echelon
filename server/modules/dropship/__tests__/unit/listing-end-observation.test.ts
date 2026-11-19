import { describe, expect, it } from "vitest";
import { LISTING_END_CODES } from "../../domain/listing-end-errors";
import { resolveListingEndObservation, type ListingEndObservedIdentity } from "../../domain/listing-end-observation";
import {
  INSPECTION_ACCOUNT,
  INSPECTION_LISTING,
  INSPECTION_MARKET,
  INSPECTION_OFFER,
  INSPECTION_SKU,
  inspectedOffer,
  inspectionWithAccount,
  observedPublication,
  publishedInspection,
  unpublishedInspection,
} from "../fixtures/listing-end-inspection.fixture";

/**
 * What eBay shows of the listing an end is about (PLAN-C v4.1 §5.5 step 4; SAF-1, DC9): only our stored offer, read
 * as the SKU's one offer on the marketplace, proves anything; a published listing needs a verified publication.
 */
const identity: ListingEndObservedIdentity = { accountId: INSPECTION_ACCOUNT, market: INSPECTION_MARKET, externalSku: INSPECTION_SKU,
  externalProductId: INSPECTION_LISTING, externalVariantId: INSPECTION_OFFER };

function failureCode(result: ReturnType<typeof resolveListingEndObservation>): string | null {
  return result.kind === "failure" ? result.failure.code : null;
}

describe("resolveListingEndObservation", () => {
  it("reads our offer PUBLISHED with its verified publication as published", () => {
    expect(resolveListingEndObservation(identity, publishedInspection())).toEqual({ kind: "published" });
    // No stored listing id: any verified publication of our offer on the market is ours.
    expect(resolveListingEndObservation({ ...identity, externalProductId: null },
      publishedInspection({ publication: observedPublication({ listingId: "999" }) }))).toEqual({ kind: "published" });
  });

  it("reads our offer UNPUBLISHED with no publication as unpublished", () => {
    expect(resolveListingEndObservation(identity, unpublishedInspection())).toEqual({ kind: "unpublished" });
    // A publication issue does not matter once our offer reads UNPUBLISHED.
    expect(resolveListingEndObservation(identity, unpublishedInspection({ unpublishedTarget: null,
      publicationIssue: { code: "EBAY_REGISTRATION_LISTING_LOCATOR_REQUIRED", message: "x" } }))).toEqual({ kind: "unpublished" });
  });

  it("never reads an absent SKU (no offers) as nothing published: IDENTITY_MISMATCH (SAF-1)", () => {
    const absent = unpublishedInspection({ skus: [{ sku: INSPECTION_SKU, inventoryItemExists: false, offers: [], issue: null }],
      unpublishedTarget: null });
    expect(failureCode(resolveListingEndObservation(identity, absent))).toBe(LISTING_END_CODES.identityMismatch);
  });

  it("refuses another offer, two offers, another SKU on the offer and a SKU that was not read", () => {
    const other = publishedInspection({ skus: [{ sku: INSPECTION_SKU, inventoryItemExists: true, offers: [inspectedOffer({ offerId: "OTHER" })], issue: null }] });
    const two = publishedInspection({ skus: [{ sku: INSPECTION_SKU, inventoryItemExists: true,
      offers: [inspectedOffer(), inspectedOffer({ offerId: "SECOND" })], issue: null }] });
    const skuDiffers = publishedInspection({ skus: [{ sku: INSPECTION_SKU, inventoryItemExists: true,
      offers: [inspectedOffer({ sku: "OTHER-SKU" })], issue: null }] });
    const unread = publishedInspection({ skus: [] });
    for (const inspection of [other, two, skuDiffers, unread]) {
      expect(failureCode(resolveListingEndObservation(identity, inspection))).toBe(LISTING_END_CODES.identityMismatch);
    }
    // An offer that does not name its SKU is still ours by offer id.
    expect(resolveListingEndObservation(identity, publishedInspection({ skus: [{ sku: INSPECTION_SKU, inventoryItemExists: true,
      offers: [inspectedOffer({ sku: null })], issue: null }] }))).toEqual({ kind: "published" });
  });

  it("refuses a publication of another listing, marketplace or member set", () => {
    for (const publication of [observedPublication({ listingId: "OTHER" }), observedPublication({ marketplaceId: "EBAY_GB" }),
      observedPublication({ members: 2 }), observedPublication({ offerId: "OTHER" }), observedPublication({ isPublished: false })]) {
      expect(failureCode(resolveListingEndObservation(identity, publishedInspection({ publication })))).toBe(LISTING_END_CODES.identityMismatch);
    }
  });

  it("does not take a PUBLISHED offer without a verified publication as proof: READ_FAILED (not proven)", () => {
    expect(failureCode(resolveListingEndObservation(identity, publishedInspection({ publication: null,
      publicationIssue: { code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", message: "x", status: 503 } })))).toBe(LISTING_END_CODES.readFailed);
    // UNPUBLISHED but a publication found: contradictory, not proven.
    expect(failureCode(resolveListingEndObservation(identity, unpublishedInspection({ publication: observedPublication() }))))
      .toBe(LISTING_END_CODES.readFailed);
  });

  it("refuses a group: inventory item group, or a group of more than one SKU (SHARED_LISTING)", () => {
    expect(failureCode(resolveListingEndObservation(identity, publishedInspection({ groupKey: "GROUP-1" })))).toBe(LISTING_END_CODES.sharedListing);
    expect(failureCode(resolveListingEndObservation(identity, unpublishedInspection({ groupSkus: [INSPECTION_SKU, "OTHER"] }))))
      .toBe(LISTING_END_CODES.sharedListing);
  });

  it("refuses another account (ACCOUNT_CHANGED) before anything else", () => {
    expect(failureCode(resolveListingEndObservation(identity, inspectionWithAccount("seller-other")))).toBe(LISTING_END_CODES.accountChanged);
  });

  it("classifies the SKU's read issue by code and status", () => {
    const withIssue = (issue: { code: string; message: string; status?: number }) =>
      resolveListingEndObservation(identity, publishedInspection({ skus: [{ sku: INSPECTION_SKU, inventoryItemExists: null, offers: [], issue }] }));
    expect(failureCode(withIssue({ code: "EBAY_REGISTRATION_OFFER_MARKETPLACE_MISMATCH", message: "x" }))).toBe(LISTING_END_CODES.identityMismatch);
    expect(failureCode(withIssue({ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", message: "x", status: 400 }))).toBe(LISTING_END_CODES.readRefused);
    for (const status of [401, 403, 429, 500, undefined]) {
      expect(failureCode(withIssue({ code: "EBAY_REGISTRATION_PROVIDER_READ_FAILED", message: "x", ...(status ? { status } : {}) })))
        .toBe(LISTING_END_CODES.readFailed);
    }
  });

  it("treats an identity without offer, SKU or account as broken, never as eBay's answer", () => {
    expect(failureCode(resolveListingEndObservation({ ...identity, externalVariantId: null }, unpublishedInspection())))
      .toBe(LISTING_END_CODES.identityMissing);
  });
});
