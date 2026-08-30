import { describe, expect, it } from "vitest";
import {
  isProductEffectivelyListed,
  isVariantEffectivelyListed,
  isVariantSellable,
} from "../../ebay-listing-state-core";

describe("eBay listing state", () => {
  it("treats product channel override is_listed=0 as an effective exclusion", () => {
    expect(
      isProductEffectivelyListed({
        productExcluded: false,
        productOverrideIsListed: 0,
        typeListingEnabled: true,
      }),
    ).toBe(false);
  });

  it("treats product exclusion as inherited by every child variant", () => {
    expect(
      isVariantEffectivelyListed({
        productExcluded: true,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 1,
        typeListingEnabled: true,
      }),
    ).toBe(false);
  });

  it("keeps a variant excluded when only the variant override is_listed=0", () => {
    expect(
      isVariantEffectivelyListed({
        productExcluded: false,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 0,
        typeListingEnabled: true,
      }),
    ).toBe(false);
  });

  it("requires product, type, and variant to all be listable", () => {
    expect(
      isVariantEffectivelyListed({
        productExcluded: false,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 1,
        typeListingEnabled: true,
      }),
    ).toBe(true);
  });

  it("does not sell an archived catalog variant even when its eBay intent is listed", () => {
    expect(
      isVariantSellable({
        productActive: true,
        variantActive: false,
        productExcluded: false,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 1,
        typeListingEnabled: true,
      }),
    ).toBe(false);
  });

  it("does not sell variants from an inactive catalog product", () => {
    expect(
      isVariantSellable({
        productActive: false,
        variantActive: true,
        productExcluded: false,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 1,
        typeListingEnabled: true,
      }),
    ).toBe(false);
  });

  it("does not sell an internal-only catalog variant even when every eBay control allows it", () => {
    expect(
      isVariantSellable({
        productActive: true,
        variantActive: true,
        salesEligibility: "internal_only",
        productExcluded: false,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 1,
        typeListingEnabled: true,
      }),
    ).toBe(false);
  });

  it("sells an active catalog variant when every eBay listing control allows it", () => {
    expect(
      isVariantSellable({
        productActive: true,
        variantActive: true,
        productExcluded: false,
        productOverrideIsListed: 1,
        variantExcluded: false,
        variantOverrideIsListed: 1,
        typeListingEnabled: true,
      }),
    ).toBe(true);
  });
});
