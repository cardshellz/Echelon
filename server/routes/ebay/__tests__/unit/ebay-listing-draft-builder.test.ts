import { describe, expect, it } from "vitest";
import { buildEbayRouteListingDraft } from "../../ebay-listing-draft-builder";

describe("buildEbayRouteListingDraft", () => {
  it("requires the owner's resolved selection instead of accepting a legacy fallback", () => {
    const input = {
      ...fixturePolicyInput(),
      resolvedPoliciesByVariantId: new Map(),
      effectivePolicies: fixturePolicies([463]).get(463)!,
    };
    expect(() => buildEbayRouteListingDraft(input)).toThrowError(expect.objectContaining({
      code: "CHANNEL_LISTING_VALIDATION_FAILED",
      context: { validation: { productId: 232, field: "policies", reason: "required" } },
    }));
  });

  it("rejects a resolved map that omits a published variant instead of borrowing another variant's policy", () => {
    expect(() => buildEbayRouteListingDraft({ ...fixturePolicyInput(), resolvedPoliciesByVariantId: fixturePolicies([999]) }))
      .toThrowError(expect.objectContaining({
        code: "CHANNEL_LISTING_VALIDATION_FAILED",
        context: { validation: { productId: 232, variantId: 463, field: "policies", reason: "required" } },
      }));
  });

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
        },
      ],
      photoPlan: fixturePhotoPlan([215, 216], ["https://cdn.example.test/toploader.jpg"]),
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
      resolvedPoliciesByVariantId: fixturePolicies([215, 216], 216),
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
      value: 5,
      unit: "OUNCE",
    });
    expect(draft.inventoryItems[0].payload.availability.shipToLocationAvailability.quantity).toBe(10);
    expect(draft.offers[0].payload.availableQuantity).toBe(10);
    expect(draft.offers[0].payload.categoryId).toBe("183438");
    expect(draft.offers[0].payload.storeCategoryNames).toEqual(["Toploaders"]);
    expect(draft.inventoryItems.map(item => item.payload.product.description)).toEqual(["<p>Toploader</p>", "<p>Toploader</p>"]);
    expect(draft.itemGroup?.payload.description).toBe("<p>Toploader</p>");
    expect(draft.offers.map(offer => offer.payload.listingDescription)).toEqual(["<p>Toploader</p>", "<p>Toploader</p>"]);
    expect(draft.offers[1].payload.listingPolicies.returnPolicyId).toBe("variant-return-policy");
    expect((draft.itemGroup?.payload as any).variantSKUs).toEqual([
      "SHLZ-TOP-130PT-P10",
      "SHLZ-TOP-130PT-C500",
    ]);
    expect(draft.itemGroup?.payload.variesBy.aspectsImageVariesBy).toEqual([]);
  });

  it("retains an inactive sold SKU in the variation group without updating its offer", () => {
    const draft = buildEbayRouteListingDraft({
      productId: 33,
      product: {
        name: "Aramalope Envelope Single Pocket",
        sku: "ARM-ENV-SGL",
        description: "<p>Envelope</p>",
      },
      variants: [
        {
          id: 67,
          sku: "ARM-ENV-SGL-C700",
          name: "Case of 700",
          option1_value: "Case of 700",
          price_cents: null,
          weight_grams: null,
          isListed: false,
        },
        {
          id: 66,
          sku: "ARM-ENV-SGL-P50",
          name: "Pack of 50",
          option1_value: "Pack of 50",
          price_cents: 1034,
          weight_grams: 500,
          isListed: true,
        },
        {
          id: 438,
          sku: "ARM-ENV-SGL-C750",
          name: "Case of 750",
          option1_value: "Case of 750",
          price_cents: 11499,
          weight_grams: 7500,
          isListed: true,
        },
      ],
      photoPlan: fixturePhotoPlan([67, 66, 438], ["https://cdn.example.test/envelope.jpg"]),
      aspects: { Brand: ["Cardshellz"], Type: ["Envelope"] },
      isMultiVariant: true,
      variationAspectName: "Pack Size",
      variantPrices: new Map([
        [67, 0],
        [66, 1034],
        [438, 11499],
      ]),
      atpByVariantId: new Map([
        [67, 900],
        [66, 7610],
        [438, 507],
      ]),
      marketplaceId: "EBAY_US",
      ebayBrowseCategoryId: "183438",
      resolvedPoliciesByVariantId: fixturePolicies([66, 438]),
      storeCategoryNames: ["Armalopes"],
      merchantLocationKey: "card-shellz-hq",
      retainUnlistedVariantsInGroup: true,
    });

    expect(draft.inventoryItems.map((item) => item.sku)).toEqual([
      "ARM-ENV-SGL-P50",
      "ARM-ENV-SGL-C750",
    ]);
    expect(draft.offers.map((offer) => offer.sku)).toEqual([
      "ARM-ENV-SGL-P50",
      "ARM-ENV-SGL-C750",
    ]);
    expect((draft.itemGroup?.payload as any).variantSKUs).toEqual([
      "ARM-ENV-SGL-C700",
      "ARM-ENV-SGL-P50",
      "ARM-ENV-SGL-C750",
    ]);
    expect(draft.inventoryItems).not.toContainEqual(
      expect.objectContaining({ sku: "ARM-ENV-SGL-C700" }),
    );
    expect(draft.offers).not.toContainEqual(
      expect.objectContaining({ sku: "ARM-ENV-SGL-C700" }),
    );
  });

  it("rejects a zero eBay offer price before building marketplace payloads", () => {
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
      photoPlan: fixturePhotoPlan([463], ["https://cdn.example.test/toploader.jpg"]),
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
      resolvedPoliciesByVariantId: fixturePolicies([463]),
      storeCategoryNames: ["Toploaders"],
      merchantLocationKey: "card-shellz-hq",
    })).toThrowError(expect.objectContaining({
      code: "CHANNEL_LISTING_VALIDATION_FAILED",
      context: { validation: { productId: 232, variantId: 463, variantSku: "SHLZ-TOP-180PT-BLU-P10", field: "price", reason: "invalid" } },
    }));
  });

  it.each([{ price: null, reason: "required" }, { price: 98, reason: "invalid" }])(
    "reports a $reason price correction for a saved price of $price cents", ({ price, reason }) => {
      const input = fixturePolicyInput();
      expect(() => buildEbayRouteListingDraft({ ...input, variantPrices: new Map(),
        variants: input.variants.map(variant => ({ ...variant, price_cents: price })) }))
        .toThrowError(expect.objectContaining({ code: "CHANNEL_LISTING_VALIDATION_FAILED",
          context: { validation: { productId: 232, variantId: 463, variantSku: "TOP-P10", field: "price", reason } } }));
    });

  it("uses the same escaped fallback description for the item and offer when the catalog description is absent", () => {
    const draft = buildEbayRouteListingDraft({ ...fixturePolicyInput(), product: { name: "Holder & Case", sku: "HOLDER" } });
    expect(draft.inventoryItems[0].payload.product.description).toBe("<p>Holder &amp; Case</p>");
    expect(draft.offers[0].payload.listingDescription).toBe("<p>Holder &amp; Case</p>");
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
      photoPlan: fixturePhotoPlan([463], ["https://cdn.example.test/toploader.jpg"]),
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
      resolvedPoliciesByVariantId: fixturePolicies([463]),
      storeCategoryNames: ["Toploaders"],
      merchantLocationKey: "card-shellz-hq",
    })).toThrowError(expect.objectContaining({
      code: "CHANNEL_LISTING_VALIDATION_FAILED",
      context: { validation: { productId: 232, variantId: 463, variantSku: "SHLZ-TOP-180PT-BLU-P10", field: "package_weight", reason: "required" } },
    }));
  });
});

function fixturePhotoPlan(variantIds: number[], urls: string[]) {
  return { byVariantId: new Map(variantIds.map(id => [id, urls])), groupImageUrls: urls };
}

function fixturePolicies(variantIds: number[], returnOverrideVariant?: number) {
  return new Map(variantIds.map(id => [id, {
    fulfillmentPolicyId: "fulfillment-policy",
    returnPolicyId: id === returnOverrideVariant ? "variant-return-policy" : "return-policy",
    paymentPolicyId: "payment-policy",
  }]));
}

function fixturePolicyInput(): Parameters<typeof buildEbayRouteListingDraft>[0] {
  return {
    productId: 232, product: { name: "Toploader", sku: "TOP" },
    variants: [{ id: 463, sku: "TOP-P10", price_cents: 1000, weight_grams: 100 }],
    photoPlan: fixturePhotoPlan([463], ["https://cdn.example.test/toploader.jpg"]),
    aspects: {}, isMultiVariant: false, variationAspectName: "",
    variantPrices: new Map([[463, 1000]]), atpByVariantId: new Map([[463, 1]]),
    marketplaceId: "EBAY_US", ebayBrowseCategoryId: "183438",
    resolvedPoliciesByVariantId: fixturePolicies([463]), storeCategoryNames: [], merchantLocationKey: "hq",
  };
}
