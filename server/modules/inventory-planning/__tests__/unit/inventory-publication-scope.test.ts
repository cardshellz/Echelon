import { describe, expect, it } from "vitest";
import { selectPublicationVariants } from "../../domain/inventory-publication-scope";

describe("shared outbound publication scope", () => {
  const variants = [{ id: 1, sku: "P5" }, { id: 2, sku: "C25" }];
  it("preserves whole-product behavior without mutating its input", () => {
    const frozen = Object.freeze(variants.map(row => Object.freeze({ ...row })));
    expect(selectPublicationVariants(frozen, { mode: "whole_product" })).toEqual({ selected: variants, unavailableVariantIds: [] });
  });
  it("selects outbound identities, not the upstream supply graph", () => {
    expect(selectPublicationVariants(variants, { mode: "explicit", includedVariantIds: [2] }))
      .toEqual({ selected: [variants[1]], unavailableVariantIds: [] });
    expect(variants).toHaveLength(2);
  });
  it("does not silently drop an invalid included SKU", () => {
    expect(selectPublicationVariants(variants, { mode: "explicit", includedVariantIds: [3, 1] }))
      .toEqual({ selected: [variants[0]], unavailableVariantIds: [3] });
  });
  it("supports deliberately empty destinations", () => {
    expect(selectPublicationVariants(variants, { mode: "explicit", includedVariantIds: [] }))
      .toEqual({ selected: [], unavailableVariantIds: [] });
  });
  it.each([[1, 1], [0], [-1], [1.1], [Number.MAX_SAFE_INTEGER]].map(ids => ({ ids })))("rejects invalid membership $ids", ({ ids }) => {
    expect(() => selectPublicationVariants(variants, { mode: "explicit", includedVariantIds: ids })).toThrow();
  });
});
