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
          weight_grams: 120,
        },
        {
          id: 216,
          sku: "SHLZ-TOP-130PT-C500",
          name: "Case of 500 (50 packs of 10)",
          option1_value: "Case of 500 (50 packs of 10)",
          price_cents: 49999,
          weight_grams: 4200,
          ebay_return_policy_override: "variant-return-policy",
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
    expect(draft.inventoryItems[0].payload.packageWeightAndSize?.weight).toEqual({
      value: 120,
      unit: "GRAM",
    });
    expect(draft.inventoryItems[0].payload.availability.shipToLocationAvailability.quantity).toBe(10);
    expect(draft.offers[0].payload.availableQuantity).toBe(10);
    expect(draft.offers[0].payload.categoryId).toBe("183438");
    expect(draft.offers[0].payload.storeCategoryNames).toEqual(["Toploaders"]);
    expect(draft.offers[0].payload).not.toHaveProperty("listingDescription");
    expect(draft.offers[1].payload.listingPolicies.returnPolicyId).toBe("variant-return-policy");
    expect((draft.itemGroup?.payload as any).variantSKUs).toEqual([
      "SHLZ-TOP-130PT-P10",
      "SHLZ-TOP-130PT-C500",
    ]);
    expect(draft.itemGroup?.payload.variesBy.aspectsImageVariesBy).toEqual([]);
  });

  it("rejects missing eBay offer prices before building marketplace payloads", () => {
    expect(() => buildEbayRouteListingDraft({
      productId: 232,
      product: {
        name: "180PT 3x4 Premium Toploader - UV Shield - Blue Hint",
        sku: "SHLZ-TOP-180PT-BLU",
        description: "<p>Toploader</p>",
      },
      variants: [
        {
          id: 463,
          sku: "SHLZ-TOP-180PT-BLU-P10",
          name: "Pack of 10",
          option1_value: "Pack of 10",
          price_cents: null,
        },
      ],
      effectiveImageUrls: ["https://cdn.example.test/toploader.jpg"],
      aspects: {
        Brand: ["Cardshellz"],
        Type: ["Toploader"],
      },
      isMultiVariant: false,
      variationAspectName: "",
      variantPrices: new Map([[463, 0]]),
      atpByVariantId: new Map([[463, 1]]),
      marketplaceId: "EBAY_US",
      ebayBrowseCategoryId: "183438",
      effectivePolicies: {
        fulfillmentPolicyId: "fulfillment-policy",
        returnPolicyId: "return-policy",
        paymentPolicyId: "payment-policy",
      },
      storeCategoryNames: ["Toploaders"],
      merchantLocationKey: "card-shellz-hq",
    })).toThrow("eBay listing price is required and must be at least $0.99 for SKU SHLZ-TOP-180PT-BLU-P10.");
  });

  it("rejects missing package weight before calling eBay", () => {
    expect(() => buildEbayRouteListingDraft({
      productId: 232,
      product: {
        name: "180PT 3x4 Premium Toploader - UV Shield - Blue Hint",
        sku: "SHLZ-TOP-180PT-BLU",
        description: "<p>Toploader</p>",
      },
      variants: [
        {
          id: 463,
          sku: "SHLZ-TOP-180PT-BLU-P10",
          name: "Pack of 10",
          option1_value: "Pack of 10",
          price_cents: 631,
          weight_grams: null,
        },
      ],
      effectiveImageUrls: ["https://cdn.example.test/toploader.jpg"],
      aspects: {
        Brand: ["Cardshellz"],
        Type: ["Toploader"],
      },
      isMultiVariant: false,
      variationAspectName: "",
      variantPrices: new Map([[463, 631]]),
      atpByVariantId: new Map([[463, 1]]),
      marketplaceId: "EBAY_US",
      ebayBrowseCategoryId: "183438",
      effectivePolicies: {
        fulfillmentPolicyId: "fulfillment-policy",
        returnPolicyId: "return-policy",
        paymentPolicyId: "payment-policy",
      },
      storeCategoryNames: ["Toploaders"],
      merchantLocationKey: "card-shellz-hq",
    })).toThrow(/eBay package weight is required for SKU SHLZ-TOP-180PT-BLU-P10/);
  });
});
