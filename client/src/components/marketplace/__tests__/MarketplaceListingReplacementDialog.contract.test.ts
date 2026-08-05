import { describe, expect, it } from "vitest";

import {
  buildMarketplaceListingReplacementMembers,
  replacementEndpointBase,
} from "../MarketplaceListingReplacementDialog";

describe("MarketplaceListingReplacementDialog contract", () => {
  it("classifies every variant explicitly and preserves inventory-independent inclusion", () => {
    const members = buildMarketplaceListingReplacementMembers(
      [
        {
          id: 700,
          sku: "ARM-ENV-SGL-C700",
          name: "Case of 700",
          included: false,
        },
        {
          id: 750,
          sku: "ARM-ENV-SGL-C750",
          name: "Case of 750",
          included: true,
        },
        { id: 50, sku: "ARM-ENV-SGL-P50", name: "Pack of 50", included: true },
      ],
      new Set([750, 50]),
    );

    expect(members).toEqual([
      {
        productVariantId: 700,
        disposition: "excluded",
        reasonCode: "operator_excluded_from_replacement",
      },
      { productVariantId: 750, disposition: "included", reasonCode: null },
      { productVariantId: 50, disposition: "included", reasonCode: null },
    ]);
  });

  it("routes Channel and Dropship owners through the same provider-neutral UI contract", () => {
    expect(
      replacementEndpointBase({
        kind: "channel",
        channelId: 67,
        productId: 5,
        marketplaceId: "EBAY_US",
      }),
    ).toBe("/api/marketplace-listings/replacements/channel/ebay");

    expect(
      replacementEndpointBase({
        kind: "dropship",
        storeConnectionId: 81,
        productId: 5,
        marketplaceId: "EBAY_US",
      }),
    ).toBe("/api/marketplace-listings/replacements/dropship/ebay");
  });
});
