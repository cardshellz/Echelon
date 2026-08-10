import { describe, expect, it } from "vitest";

import {
  marketplaceListingReplacementExecutionEnabled,
  normalizeEbayReplacementOffer,
} from "../../../../marketplace-listing-replacement.composition";

describe("marketplace listing replacement rollout gate", () => {
  it("defaults execution off", () => {
    expect(marketplaceListingReplacementExecutionEnabled({})).toBe(false);
  });

  it("requires the exact explicit true value", () => {
    expect(
      marketplaceListingReplacementExecutionEnabled({
        MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_ENABLED: "true",
      }),
    ).toBe(true);
    expect(
      marketplaceListingReplacementExecutionEnabled({
        MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_ENABLED: "TRUE",
      }),
    ).toBe(false);
  });
});
describe("eBay replacement offer normalization", () => {
  it("exposes the nested eBay listing identity used by registration", () => {
    expect(
      normalizeEbayReplacementOffer({
        offerId: " offer-123 ",
        sku: "ARM-ENV-SGL-P50",
        status: "PUBLISHED",
        listing: { listingId: " 298148438778 ", listingStatus: "ACTIVE" },
      }),
    ).toMatchObject({
      offerId: "offer-123",
      listingId: "298148438778",
      status: "PUBLISHED",
    });
  });

  it("rejects conflicting top-level and nested listing identities", () => {
    expect(() =>
      normalizeEbayReplacementOffer({
        offerId: "offer-123",
        listingId: "listing-a",
        listing: { listingId: "listing-b" },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MARKETPLACE_LISTING_REPLACEMENT_EBAY_RESPONSE_INVALID",
      }),
    );
  });
});
