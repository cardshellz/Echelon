import { describe, expect, it } from "vitest";
import {
  listingCatalogItemSchema,
  listingDraftItemSchema,
  type ListingCatalogItem,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import {
  buildBulkFieldPatch,
  projectBulkField,
  setBulkFieldEdit,
  undoBulkFieldEdit,
  type BulkFieldEdits,
} from "../bulk-field-state";
import { applyBulkEdit } from "../bulk-edit-model";

const item = (variantId: number, overrides: Partial<ListingDraftItem> = {}) =>
  listingDraftItemSchema.parse({ variantId, ...overrides });
const catalog = (
  variantId: number,
  overrides: Partial<ListingCatalogItem> = {},
) =>
  listingCatalogItemSchema.parse({
    variantId,
    productId: 1,
    sku: `SKU-${variantId}`,
    name: "Catalog product",
    variantName: "Each",
    unitLabel: "Each",
    productType: null,
    title: "Catalog title",
    description: "Catalog description",
    brand: "Catalog brand",
    images: ["https://example.test/a.png"],
    identifier: null,
    priceCents: 1299,
    basePriceCents: 999,
    priceSource: "retail_cache",
    appliedRule: { type: "fixed", value: "3.00" },
    appliedRuleScope: "channel",
    eligible: true,
    alreadyLinked: false,
    sourceHash: "a".repeat(64),
    ...overrides,
  });
const metadata = (...items: ListingCatalogItem[]) =>
  new Map(items.map((item) => [item.variantId, item]));

describe("bulk field presentation", () => {
  it("shows actual common catalog content without making a patch", () => {
    const items = [item(1), item(2)];
    const source = metadata(catalog(1), catalog(2));
    expect(projectBulkField(items, source, "brand")).toEqual({
      status: "common",
      value: "Catalog brand",
      source: "catalog",
      unavailableCount: 0,
    });
    expect(projectBulkField(items, source, "images").value).toBe(
      "https://example.test/a.png",
    );
    expect(buildBulkFieldPatch({})).toEqual({});
    expect(
      items.every((item) => item.brand === null && item.images === null),
    ).toBe(true);
  });

  it("keeps shared values separate from mixed provenance", () => {
    const source = metadata(catalog(1), catalog(2));
    expect(
      projectBulkField(
        [item(1, { brand: "Catalog brand" }), item(2)],
        source,
        "brand",
      ),
    ).toMatchObject({
      status: "common",
      value: "Catalog brand",
      source: "mixed",
    });
    expect(
      projectBulkField(
        [item(1, { brand: "A" }), item(2, { brand: "B" })],
        source,
        "brand",
      ),
    ).toMatchObject({
      status: "mixed",
      value: "",
      source: "custom",
    });
  });

  it("distinguishes known empty catalog content from unavailable or mismatched metadata", () => {
    const empty = metadata(catalog(1, { description: null }));
    expect(projectBulkField([item(1)], empty, "description")).toMatchObject({
      status: "common",
      value: "",
    });
    expect(
      projectBulkField([item(1), item(2)], empty, "description"),
    ).toMatchObject({ status: "unavailable", value: "", unavailableCount: 1 });
    expect(
      projectBulkField([item(1)], new Map([[1, catalog(2)]]), "title"),
    ).toMatchObject({ status: "unavailable", unavailableCount: 1 });
    expect(
      projectBulkField([item(1, { title: "Custom" })], new Map(), "title"),
    ).toMatchObject({ status: "common", value: "Custom", source: "custom" });
    expect(projectBulkField([], new Map(), "title")).toEqual({
      status: "unavailable",
      value: "",
      source: null,
      unavailableCount: 0,
    });
  });

  it("uses final inherited pricing and respects draft overrides without floating point", () => {
    const items = [item(1, { priceOverrideCents: 1599 }), item(2)];
    const source = metadata(catalog(1), catalog(2, { priceCents: 1599 }));
    expect(projectBulkField(items, source, "priceOverrideCents")).toMatchObject(
      { status: "common", value: "15.99", source: "mixed" },
    );
    expect(
      projectBulkField(items, source, "priceOverrideCents", { inherit: true }),
    ).toMatchObject({ status: "mixed", value: "", source: "pricing" });
    expect(
      projectBulkField(
        [item(1)],
        metadata(catalog(1, { priceCents: 0 })),
        "priceOverrideCents",
      ).value,
    ).toBe("0.00");
    expect(
      projectBulkField(
        [item(1)],
        metadata(catalog(1, { priceCents: null })),
        "priceOverrideCents",
      ).status,
    ).toBe("unavailable");
    expect(
      projectBulkField(
        [item(1, { priceOverrideCents: Number.MAX_SAFE_INTEGER })],
        new Map(),
        "priceOverrideCents",
      ).value,
    ).toBe("90071992547409.91");
  });

  it("previews inheritance by ignoring custom overrides without changing items", () => {
    const items = [item(1, { title: "Custom" })];
    const before = structuredClone(items);
    expect(
      projectBulkField(items, metadata(catalog(1)), "title", { inherit: true }),
    ).toMatchObject({
      status: "common",
      value: "Catalog title",
      source: "catalog",
    });
    expect(items).toEqual(before);
  });

  it("shows method and product type independently of compatible attribute context", () => {
    const items = [
      item(1, { method: "match", productType: "A" }),
      item(2, { method: "match", productType: "B" }),
    ];
    expect(projectBulkField(items, new Map(), "method")).toMatchObject({
      status: "common",
      value: "match",
      source: "draft",
    });
    expect(projectBulkField(items, new Map(), "productType")).toMatchObject({
      status: "mixed",
      value: "",
    });
    expect(
      projectBulkField([item(1), item(2)], new Map(), "productType"),
    ).toMatchObject({ status: "common", value: "" });
  });

  it("compares image arrays in order and preserves empty explicit overrides", () => {
    const source = metadata(catalog(1), catalog(2));
    const a = "https://example.test/a.png",
      b = "https://example.test/b.png";
    expect(
      projectBulkField(
        [item(1, { images: [a, b] }), item(2, { images: [b, a] })],
        source,
        "images",
      ).status,
    ).toBe("mixed");
    expect(
      projectBulkField([item(1, { title: "" })], source, "title"),
    ).toMatchObject({ status: "common", value: "", source: "custom" });
  });

  it("projects each row after shared and individual edits without replacing unrelated inherited fields", () => {
    const original = [item(1), item(2)];
    const source = metadata(catalog(1), catalog(2, { priceCents: 1499 }));
    const shared = applyBulkEdit(
      original,
      original,
      buildBulkFieldPatch({
        brand: "Shared brand",
        priceOverrideCents: "20.00",
      }),
    );
    const individual = applyBulkEdit(
      shared,
      [shared[1]],
      buildBulkFieldPatch({
        brand: "Individual brand",
        priceOverrideCents: null,
      }),
    );
    expect(
      projectBulkField([individual[0]], source, "priceOverrideCents"),
    ).toMatchObject({
      status: "common",
      value: "20.00",
      source: "custom",
    });
    expect(
      projectBulkField([individual[1]], source, "priceOverrideCents"),
    ).toMatchObject({
      status: "common",
      value: "14.99",
      source: "pricing",
    });
    expect(projectBulkField(individual, source, "brand").status).toBe("mixed");
    expect(projectBulkField([individual[1]], source, "brand").value).toBe(
      "Individual brand",
    );
    expect(projectBulkField(individual, source, "title")).toMatchObject({
      status: "common",
      value: "Catalog title",
      source: "catalog",
    });
    expect(individual.every((item) => item.title === null)).toBe(true);
    expect(original).toEqual([item(1), item(2)]);
  });
});

describe("explicit bulk field edit buffers", () => {
  it("preserves incomplete raw edits and Undo restores untouched state", () => {
    const before: BulkFieldEdits = { brand: "New brand" };
    const edited = setBulkFieldEdit(before, "priceOverrideCents", "12.");
    expect(() => buildBulkFieldPatch(edited)).toThrow("positive fixed price");
    expect(edited).toEqual({ brand: "New brand", priceOverrideCents: "12." });
    expect(before).toEqual({ brand: "New brand" });
    expect(
      buildBulkFieldPatch(undoBulkFieldEdit(edited, "priceOverrideCents")),
    ).toEqual({ brand: "New brand" });
  });

  it("restores inheritance for deliberate clears and explicit inheritance actions", () => {
    expect(
      buildBulkFieldPatch({
        brand: "",
        title: " \t ",
        description: "\n",
        images: "\r\n",
        priceOverrideCents: " ",
      }),
    ).toEqual({
      brand: null,
      title: null,
      description: null,
      images: null,
      priceOverrideCents: null,
    });
    expect(
      buildBulkFieldPatch({ brand: null, priceOverrideCents: null }),
    ).toEqual({ brand: null, priceOverrideCents: null });
    expect(
      buildBulkFieldPatch(undoBulkFieldEdit({ brand: null }, "brand")),
    ).toEqual({});
  });

  it("parses cents and content with the existing bounds while preserving description whitespace", () => {
    expect(
      buildBulkFieldPatch({
        brand: " Brand ",
        description: "  Paragraph\n ",
        images: " https://example.test/a.png\r\nhttps://example.test/b.png ",
        priceOverrideCents: "12.30",
      }),
    ).toEqual({
      brand: "Brand",
      description: "  Paragraph\n ",
      images: ["https://example.test/a.png", "https://example.test/b.png"],
      priceOverrideCents: 1230,
    });
    expect(
      buildBulkFieldPatch({ priceOverrideCents: "90071992547409.91" })
        .priceOverrideCents,
    ).toBe(Number.MAX_SAFE_INTEGER);
    for (const price of ["0", "-1", "12.345", "1e3", "90071992547409.92"])
      expect(() =>
        buildBulkFieldPatch({ priceOverrideCents: price }),
      ).toThrow();
    expect(() => buildBulkFieldPatch({ brand: "a".repeat(201) })).toThrow(
      "Brand",
    );
    expect(() => buildBulkFieldPatch({ images: "not-a-url" })).toThrow(
      "Images",
    );
    expect(() =>
      buildBulkFieldPatch({
        images: Array(21).fill("https://example.test/a.png").join("\n"),
      }),
    ).toThrow("Images");
  });

  it("rejects unsafe or ambiguous edit keys instead of silently writing them", () => {
    expect(() =>
      buildBulkFieldPatch({ identifier: "UPC" } as BulkFieldEdits),
    ).toThrow("cannot be changed");
    expect(() => buildBulkFieldPatch({ brand: undefined })).toThrow(
      "leave untouched fields out",
    );
    expect(() =>
      buildBulkFieldPatch(JSON.parse('{"__proto__":"value"}')),
    ).toThrow("cannot be changed");
  });
});
