import { describe, expect, it } from "vitest";
import { describePriceBasis, describeReviewedSize, parseNonnegativeHundredths, parseProfileDraft, profileDraft } from "../dropship-pricing-rules";
import { draftFromListingPrice, isListingPriceDirty, prepareListingPriceSave } from "../dropship-listing-price";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
describe("pricing rule form contracts", () => {
  it.each([["0", 0], ["30", 3000], ["30.25", 3025], ["1.01", 101]])("parses %s exactly", (input, expected) => {
    expect(parseNonnegativeHundredths(input, "Value")).toBe(expected);
  });
  it.each(["-1", "1.001", "NaN", "1e2", "", "Infinity", "2,000"])("rejects %s", (input) => {
    expect(() => parseNonnegativeHundredths(input, "Value")).toThrow();
  });
  it("round trips a store recipe and preserves typed scopes", () => {
    const value = { defaultRecipe: { basis: "product_cost" as const, markupBps: 3025, flatCents: 101, rounding: "up_99" as const }, groups: [] };
    expect(parseProfileDraft(profileDraft(value))).toEqual(value);
  });
  it("keeps inherited rules distinct from catalog reset and fixed overrides", () => {
    const baseline: ListingPriceSetting = { storeConnectionId: 22, productVariantId: 66, revisionId: 3, overridePriceCents: null,
      effectivePriceCents: 1152, defaultPriceCents: 899, pricingMode: "rules", source: "rules", updatedAt: null };
    const draft = draftFromListingPrice(baseline);
    expect(isListingPriceDirty(draft)).toBe(false); expect(draft.useRules).toBe(true); expect(draft.useDefault).toBe(false);
    expect(isListingPriceDirty({ ...draft, useRules: false, useDefault: true })).toBe(true);
    const attempt = prepareListingPriceSave({ storeConnectionId: 22, productVariantId: 66 }, { ...draft, baseline: { ...baseline, pricingMode: "fixed" } }, null, () => "test");
    expect(attempt.request).toMatchObject({ pricingMode: "rules", priceCents: null, expectedRevisionId: 3 });
  });
});
describe("pricing review words", () => {
  it.each([
    [{ preserved: false, basis: "catalog_retail", basisCents: 1249 }, "Reference retail $12.49"],
    [{ preserved: false, basis: "product_cost", basisCents: 1089 }, ".ops cost $10.89"],
    [{ preserved: false, basis: "catalog_retail", basisCents: null }, "No catalog reference retail"],
    [{ preserved: false, basis: "product_cost", basisCents: null }, "No .ops product cost"],
    [{ preserved: true, basis: null, basisCents: null }, "Your fixed price"],
    [{ preserved: false, basis: null, basisCents: null }, "—"],
    [{ preserved: false }, "—"],
  ] as const)("describes %o as %s", (row, expected) => {
    expect(describePriceBasis(row)).toBe(expected);
  });
  it("shows the size name and SKU, skipping blanks", () => {
    expect(describeReviewedSize({ sizeName: "Box of 5 Packs of 100", sku: "EG-SLV-STD-5PCK-B500" })).toBe("Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500");
    expect(describeReviewedSize({ sku: "EG-SLV-STD-5PCK-B500" })).toBe("EG-SLV-STD-5PCK-B500");
    expect(describeReviewedSize({ sizeName: "  ", sku: null })).toBe("");
  });
});
