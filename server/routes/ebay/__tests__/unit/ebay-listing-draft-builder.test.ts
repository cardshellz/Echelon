import { describe, expect, it } from "vitest";
import { buildEbayRouteListingDraft } from "../../ebay-listing-draft-builder";

describe("buildEbayRouteListingDraft", () => {
  it("keeps shared required item specifics on each multi-variant inventory item", () => {
    const draft = buildEbayRouteListingDraft({
      productId: 107,
      product: {
        name: "130PT 3x4 Premium Toploader - UV Shield - Blue Hint",
        sku: "SHLZ-TOP-130PT",
        description: "<p>Toploader</p>",
      },
      variants: [
        {
          id: 215,
          sku: "SHLZ-TOP-130PT-P10",
          name: "Pack of 10",
          option1_value: "Pack of 10",
          price_cents: 1199,
        },
        {
          id: 216,
          sku: "SHLZ-TOP-130PT-C500",
          name: "Case of 500 (50 packs of 10)",
          option1_value: "Case of 500 (50 packs of 10)",
          price_cents: 49999,
        },
      ],
      effectiveImageUrls: ["https://cdn.example.test/toploader.jpg"],
      aspects: {
        Brand: ["Shellz"],
        Type: ["Toploader"],
      },
      isMultiVariant: true,
      variationAspectName: "Style",
      variantPrices: new Map([
        [215, 1199],
        [216, 49999],
      ]),
      atpByVariantId: new Map([
        [215, 10],
        [216, 2],
      ]),
      marketplaceId: "EBAY_US",
      ebayBrowseCategoryId: "183438",
      effectivePolicies: {
        fulfillmentPolicyId: "fulfillment-policy",
        returnPolicyId: "return-policy",
        paymentPolicyId: "payment-policy",
      },
      storeCategoryNames: ["Toploaders"],
      merchantLocationKey: "card-shellz-hq",
    });

    expect(draft.inventoryItems).toHaveLength(2);
    expect(draft.inventoryItems[0].payload.product.aspects).toMatchObject({
      Brand: ["Shellz"],
      Type: ["Toploader"],
      Style: ["Pack of 10"],
    });
    expect(draft.inventoryItems[1].payload.product.aspects).toMatchObject({
      Brand: ["Shellz"],
      Type: ["Toploader"],
      Style: ["Case of 500 (50 packs of 10)"],
    });
    expect(draft.itemGroup?.payload.aspects).toMatchObject({
      Brand: ["Shellz"],
      Type: ["Toploader"],
    });
  });
});
