import { describe, expect, it } from "vitest";
import { LISTING_TAXONOMY_LIMITS, listingTaxonomySchema } from "@shared/types/channel-listing-publication";
import { normalizeWalmartListingTaxonomy } from "../../adapters/walmart/walmart-listing-taxonomy";

const category = {
  category: "Beauty",
  productTypeGroup: [{
    productTypeGroupName: "Fragrances",
    productType: [{ productTypeName: "Body Sprays", description: "Provider supplied description" }],
  }],
};
const invalid = { code: "WALMART_LISTING_RESPONSE_INVALID" };

describe("Walmart product type taxonomy normalization", () => {
  it.each([category, [category]])("preserves the documented hierarchy in either envelope: %#", (itemTaxonomy) => {
    expect(normalizeWalmartListingTaxonomy({ itemTaxonomy })).toEqual({
      productTypes: ["Body Sprays"],
      entries: [{ productType: "Body Sprays", path: ["Beauty", "Fragrances"], description: "Provider supplied description" }],
    });
  });

  it("deduplicates exact paths while preserving every distinct provider path and exact leaf identity", () => {
    const response = {
      itemTaxonomy: [
        { category: "Z", productTypeGroup: [{ productTypeGroupName: "Group", productType: [
          { productTypeName: "Same Type", description: null }, { productTypeName: "Same Type", description: "Z description" },
          { productTypeName: "Same Type", description: "A description" }, { productTypeName: "same type" },
        ] }] },
        { category: "A", productTypeGroup: [{ productTypeGroupName: "Group", productType: [{ productTypeName: "Same Type" }] }] },
      ],
    };
    const original = structuredClone(response);
    const result = normalizeWalmartListingTaxonomy(response);
    expect(result).toEqual({
      productTypes: ["Same Type", "same type"],
      entries: [
        { productType: "Same Type", path: ["A", "Group"], description: null },
        { productType: "Same Type", path: ["Z", "Group"], description: "A description" },
        { productType: "same type", path: ["Z", "Group"], description: null },
      ],
    });
    expect(response).toEqual(original);
    const reversed = structuredClone(response);
    reversed.itemTaxonomy.reverse();
    for (const item of reversed.itemTaxonomy) item.productTypeGroup[0].productType.reverse();
    expect(normalizeWalmartListingTaxonomy(reversed)).toEqual(result);
    result.entries[0].path[0] = "Changed result";
    expect(response).toEqual(original);
  });

  it("keeps missing ancestor labels as partial or flat paths without inventing a category", () => {
    const leaf = { productTypeName: " Exact Type ", description: " " };
    expect(normalizeWalmartListingTaxonomy({ itemTaxonomy: [
      { productTypeGroup: [{ productType: [leaf] }] },
      { category: " ", productTypeGroup: [{ productTypeGroupName: "Group", productType: [leaf] }] },
      { category: "Category", productTypeGroup: [{ productTypeGroupName: null, productType: [leaf] }] },
    ] })).toEqual({
      productTypes: ["Exact Type"],
      entries: [
        { productType: "Exact Type", path: [], description: null },
        { productType: "Exact Type", path: ["Category"], description: null },
        { productType: "Exact Type", path: ["Group"], description: null },
      ],
    });
  });

  it.each([
    undefined,
    { itemTaxonomy: null },
    { itemTaxonomy: { category: "Beauty", subCategory: [{ subCategoryName: "Unproven Type" }] } },
    { itemTaxonomy: { category: 123, productTypeGroup: [] } },
    { itemTaxonomy: { productTypeGroup: [{ productTypeGroupName: [], productType: [] }] } },
    ...[{}, { productTypeName: " " }, { productTypeName: 42 },
      { productTypeName: "x".repeat(LISTING_TAXONOMY_LIMITS.nameLength + 1) },
      { productTypeName: "Valid", description: "x".repeat(LISTING_TAXONOMY_LIMITS.descriptionLength + 1) }]
      .map((leaf) => ({ itemTaxonomy: { productTypeGroup: [{ productType: [leaf] }] } })),
  ])("rejects malformed provider data rather than offering unproven selectable types: %#", (response) => {
    expect(() => normalizeWalmartListingTaxonomy(response)).toThrowError(expect.objectContaining(invalid));
  });

  it("enforces the total raw leaf bound across groups, including repeated leaves", () => {
    const leaves = Array.from({ length: LISTING_TAXONOMY_LIMITS.entries / 2 + 1 }, () => ({ productTypeName: "Repeated" }));
    expect(() => normalizeWalmartListingTaxonomy({ itemTaxonomy: {
      productTypeGroup: [{ productType: leaves }, { productType: leaves }],
    } })).toThrowError(expect.objectContaining(invalid));
  });

  it("rejects an oversized response before traversing otherwise valid taxonomy", () => {
    expect(() => normalizeWalmartListingTaxonomy({ itemTaxonomy: [], padding: "x".repeat(21 * 1024 * 1024) }))
      .toThrowError(expect.objectContaining(invalid));
  });

  it("accepts a successful empty taxonomy without adding placeholder categories", () => {
    expect(normalizeWalmartListingTaxonomy({ itemTaxonomy: [] })).toEqual({ productTypes: [], entries: [] });
  });
});

describe("shared listing taxonomy boundary", () => {
  it("accepts the legacy flat response and normalizes an optional description", () => {
    expect(listingTaxonomySchema.parse({ productTypes: ["Existing Type"] })).toEqual({ productTypes: ["Existing Type"], entries: [] });
    expect(listingTaxonomySchema.parse({ productTypes: ["Existing Type"], entries: [{ productType: "Existing Type", path: [] }] }).entries[0].description).toBeNull();
  });

  it("rejects hidden leaves, duplicate paths, duplicate type identities and excessive ancestry", () => {
    const entry = { productType: "Existing Type", path: ["Category"], description: null };
    for (const value of [
      { productTypes: [], entries: [entry] },
      { productTypes: ["Existing Type"], entries: [entry, entry] },
      { productTypes: ["Existing Type", "Existing Type"], entries: [] },
      { productTypes: ["Existing Type"], entries: [{ ...entry, path: Array(LISTING_TAXONOMY_LIMITS.pathDepth + 1).fill("Category") }] },
    ]) expect(listingTaxonomySchema.safeParse(value).success).toBe(false);
  });
});
