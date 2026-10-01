import { describe, expect, it } from "vitest";
import {
  listingDraftItemSchema,
  listingTaxonomySchema,
  type ListingTaxonomy,
} from "@shared/types/channel-listing-publication";
import {
  buildProductTypeIndex,
  searchProductTypes,
  selectListingProductType,
} from "../product-type-model";

const taxonomy = (): ListingTaxonomy =>
  listingTaxonomySchema.parse({
    productTypes: ["Protectors", "Storage", "Folders"],
    entries: [
      {
        productType: "Protectors",
        path: ["Collectibles", "Card Protection"],
        description: "Provider description",
      },
      {
        productType: "Storage",
        path: ["Collectibles", "Card Storage"],
        description: null,
      },
      {
        productType: "Folders",
        path: ["Office", "Organization"],
        description: null,
      },
    ],
  });

describe("provider product type hierarchy", () => {
  it("builds real ancestor branches with exact leaf values and descendant counts", () => {
    const index = buildProductTypeIndex(taxonomy());
    expect(index.root.children.map((branch) => branch.label)).toEqual([
      "Collectibles",
      "Office",
    ]);
    expect(index.root.leaves).toEqual([]);
    const collectibles = index.root.children[0];
    expect(collectibles.productTypeCount).toBe(2);
    expect(collectibles.children.map((branch) => branch.label)).toEqual([
      "Card Protection",
      "Card Storage",
    ]);
    expect(collectibles.children[0].leaves[0]).toMatchObject({
      productType: "Protectors",
      path: ["Collectibles", "Card Protection"],
      description: "Provider description",
    });
    expect(index.root.productTypeCount).toBe(3);
  });

  it("keeps missing ancestry as real root leaves without creating guessed categories", () => {
    const value = taxonomy();
    value.entries = value.entries.filter(
      (entry) => entry.productType !== "Folders",
    );
    const index = buildProductTypeIndex(value);
    expect(index.root.children.map((branch) => branch.label)).toEqual([
      "Collectibles",
    ]);
    expect(index.root.leaves.map((leaf) => leaf.productType)).toEqual([
      "Folders",
    ]);
    const legacy = buildProductTypeIndex(
      listingTaxonomySchema.parse({ productTypes: ["Z type", "A type"] }),
    );
    expect(legacy.root.children).toEqual([]);
    expect(legacy.root.leaves.map((leaf) => leaf.productType)).toEqual([
      "A type",
      "Z type",
    ]);
  });

  it("preserves alternate provider paths for the same leaf and counts distinct types", () => {
    const value = taxonomy();
    value.entries.push({
      productType: "Protectors",
      path: ["Collectibles", "Other Protection"],
      description: null,
    });
    const index = buildProductTypeIndex(value);
    expect(index.byType.get("Protectors")).toHaveLength(2);
    expect(index.root.productTypeCount).toBe(3);
    expect(index.root.children[0].productTypeCount).toBe(2);
    expect(index.leaves).toHaveLength(4);
  });

  it("does not conflate branch labels, leaf names or delimiter-containing paths", () => {
    const index = buildProductTypeIndex(
      listingTaxonomySchema.parse({
        productTypes: ["Office", "A leaf", "B leaf"],
        entries: [
          { productType: "Office", path: [], description: null },
          {
            productType: "A leaf",
            path: ["Office", "A > B"],
            description: null,
          },
          {
            productType: "B leaf",
            path: ["Office", "A", "B"],
            description: null,
          },
        ],
      }),
    );
    expect(index.root.leaves[0].productType).toBe("Office");
    expect(index.root.children[0].label).toBe("Office");
    expect(
      index.branches.get(JSON.stringify(["Office", "A > B"]))?.leaves[0]
        .productType,
    ).toBe("A leaf");
    expect(
      index.branches.get(JSON.stringify(["Office", "A", "B"]))?.leaves[0]
        .productType,
    ).toBe("B leaf");
  });

  it("does not mutate provider arrays while indexing, sorting or searching", () => {
    const value = taxonomy();
    const snapshot = JSON.stringify(value);
    for (const entry of value.entries) {
      Object.freeze(entry.path);
      Object.freeze(entry);
    }
    Object.freeze(value.entries);
    Object.freeze(value.productTypes);
    Object.freeze(value);
    const index = buildProductTypeIndex(value);
    expect(
      searchProductTypes(index, "office folders").map(
        (leaf) => leaf.productType,
      ),
    ).toEqual(["Folders"]);
    expect(JSON.stringify(value)).toBe(snapshot);
  });

  it("defensively excludes entries outside the allowed leaves and deduplicates exact records", () => {
    const value = taxonomy();
    value.entries.push(value.entries[0], {
      productType: "Invented",
      path: ["Unknown"],
      description: null,
    });
    const index = buildProductTypeIndex(value);
    expect(index.leaves).toHaveLength(3);
    expect(index.root.children.map((branch) => branch.label)).toEqual([
      "Collectibles",
      "Office",
    ]);
  });

  it("supports empty provider responses and case-sensitive canonical leaf identities", () => {
    const empty = buildProductTypeIndex(
      listingTaxonomySchema.parse({ productTypes: [] }),
    );
    expect(empty.root.children).toEqual([]);
    expect(empty.leaves).toEqual([]);
    expect(searchProductTypes(empty, "anything")).toEqual([]);
    const caseSensitive = buildProductTypeIndex(
      listingTaxonomySchema.parse({ productTypes: ["Type", "type"] }),
    );
    expect(caseSensitive.byType.size).toBe(2);
  });

  it("searches multiple tokens across actual ancestors and leaves without mutating query state", () => {
    const index = buildProductTypeIndex(taxonomy());
    expect(
      searchProductTypes(index, "  COLLECTIBLES\tprotectors ").map(
        (leaf) => leaf.productType,
      ),
    ).toEqual(["Protectors"]);
    expect(
      searchProductTypes(index, "card").map((leaf) => leaf.productType),
    ).toEqual(["Protectors", "Storage"]);
    expect(searchProductTypes(index, "office protectors")).toEqual([]);
    expect(searchProductTypes(index, " ")).toBe(index.leaves);
  });

  it("indexes a large flat response without silently omitting product types", () => {
    const values = Array.from(
      { length: 2_000 },
      (_, index) => `Type ${String(index).padStart(4, "0")}`,
    );
    const index = buildProductTypeIndex(
      listingTaxonomySchema.parse({ productTypes: values }),
    );
    expect(index.root.leaves).toHaveLength(2_000);
    expect(
      searchProductTypes(index, "1999").map((leaf) => leaf.productType),
    ).toEqual(["Type 1999"]);
  });
});

describe("explicit product type changes", () => {
  const draft = () =>
    listingDraftItemSchema.parse({
      variantId: 1,
      productType: "Protectors",
      attributes: { shippingWeight: 1, nested: { country: "US" } },
      title: "My title",
      priceOverrideCents: 549,
    });

  it("returns the existing draft and attributes unchanged when its leaf is selected again", () => {
    const original = draft();
    expect(selectListingProductType(original, "Protectors", taxonomy())).toBe(
      original,
    );
    expect(original.attributes).toEqual({
      shippingWeight: 1,
      nested: { country: "US" },
    });
  });

  it("resets only provider attributes when a different valid leaf is selected", () => {
    const original = draft();
    const changed = selectListingProductType(original, "Folders", taxonomy());
    expect(changed).toEqual({
      ...original,
      productType: "Folders",
      attributes: {},
    });
    expect(original.productType).toBe("Protectors");
    expect(original.attributes).toEqual({
      shippingWeight: 1,
      nested: { country: "US" },
    });
  });

  it("rejects free text, category names and case changes instead of replacing the draft", () => {
    const original = draft();
    for (const value of [
      "Collectibles",
      "",
      "protectors",
      "Protectors ",
      "Unknown",
    ]) {
      expect(() =>
        selectListingProductType(original, value, taxonomy()),
      ).toThrow("Choose an available product type");
    }
    expect(original).toEqual(draft());
  });
});
