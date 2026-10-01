import { describe, expect, it } from "vitest";
import {
  listingDraftItemSchema,
  type ListingDraftItem,
} from "@shared/types/channel-listing-publication";
import {
  applyBulkEdit,
  bulkEditPatchSchema,
  bulkFixedPriceCents,
  bulkSelectionFingerprint,
  commonBulkContext,
  previewBulkEdit,
  updateBulkAttribute,
} from "../bulk-edit-model";

const item = (variantId: number, overrides: Partial<ListingDraftItem> = {}) =>
  listingDraftItemSchema.parse({
    variantId,
    productType: "Trading Card Accessories",
    identifier: { type: "UPC", value: String(variantId).padStart(12, "0") },
    ...overrides,
  });
const set = (path: string[], value: unknown) => ({
  path,
  action: "set" as const,
  value,
});
const remove = (path: string[]) => ({ path, action: "remove" as const });

describe("explicit bulk draft patches", () => {
  it("defaults to no changes and does not apply an empty patch", () => {
    const current = [item(1), item(2)];
    expect(previewBulkEdit(current, {})).toMatchObject({
      changedCount: 0,
      resetCount: 0,
    });
    expect(() => applyBulkEdit(current, current, {})).toThrow(
      "at least one change",
    );
  });
  it("changes only exact selected variants while preserving identifiers and newer unselected edits", () => {
    const selected = item(1, {
      title: "Original title",
      attributes: { Visible: { color: "Blue" } },
    });
    const unselected = item(2, { brand: "Newer local edit" });
    const current = [selected, unselected];
    const patch = { brand: "Card Shellz", priceOverrideCents: 1234 };
    const original = structuredClone({ current, patch });
    const result = applyBulkEdit(current, [selected], patch);
    expect(result[0]).toEqual({
      ...selected,
      brand: "Card Shellz",
      priceOverrideCents: 1234,
    });
    expect(result[0].identifier).toEqual(selected.identifier);
    expect(result[1]).toBe(unselected);
    expect({ current, patch }).toEqual(original);
    (result[0].attributes.Visible as Record<string, unknown>).color =
      "Changed returned value";
    expect(current[0].attributes).toEqual(original.current[0].attributes);
  });
  it("explicitly restores inheritance without changing unrelated fields", () => {
    const current = [
      item(1, {
        priceOverrideCents: 100,
        brand: "Brand",
        title: "Title",
        description: "Description",
        images: ["https://example.test/image.png"],
      }),
    ];
    expect(
      applyBulkEdit(current, current, {
        priceOverrideCents: null,
        brand: null,
        title: null,
        description: null,
        images: null,
      })[0],
    ).toMatchObject({
      priceOverrideCents: null,
      brand: null,
      title: null,
      description: null,
      images: null,
      identifier: current[0].identifier,
    });
  });
  it("rejects identifier/SKU fields, unknown fields, undefined values and malformed content", () => {
    for (const patch of [
      { identifier: null },
      { sku: "COPY" },
      { variantId: 2 },
      { brand: undefined },
      { title: "" },
      { images: ["not a URL"] },
      { priceOverrideCents: 1.5 },
      { attributeChanges: [set(["Orderable", "sku"], "COPY")] },
      {
        attributeChanges: [
          set(["Orderable", "productIdentifiers", "productId"], "COPY"),
        ],
      },
      { attributeChanges: [set(["Visible", "custom"], { upc: "COPY" })] },
      { attributeChanges: [set(["Visible", "constructor"], "bad")] },
      { attributeChanges: [set(["Orderable"], {})] },
    ])
      expect(bulkEditPatchSchema.safeParse(patch).success).toBe(false);
  });
  it("rejects missing, duplicate, empty and oversized selections atomically", () => {
    const current = [item(1), item(2)];
    const original = structuredClone(current);
    for (const selected of [[], [current[0], current[0]], [item(3)]])
      expect(() =>
        applyBulkEdit(current, selected, { brand: "New" }),
      ).toThrow();
    expect(() =>
      applyBulkEdit([current[0], current[0]], [current[0]], { brand: "New" }),
    ).toThrow();
    const tooMany = Array.from({ length: 101 }, (_, index) => item(index + 1));
    expect(() => applyBulkEdit(tooMany, tooMany, { brand: "New" })).toThrow(
      "100",
    );
    expect(current).toEqual(original);
  });
  it("rejects a changed selected value but ignores object key order", () => {
    const selected = item(1, {
      attributes: {
        Visible: { color: "Blue", size: "Small" },
        Orderable: { weight: 0 },
      },
    });
    const reordered = item(1, {
      attributes: {
        Orderable: { weight: 0 },
        Visible: { size: "Small", color: "Blue" },
      },
    });
    expect(bulkSelectionFingerprint([selected])).toBe(
      bulkSelectionFingerprint([reordered]),
    );
    expect(
      applyBulkEdit([reordered], [selected], { brand: "New" })[0].brand,
    ).toBe("New");
    for (const changed of [
      { ...selected, title: "Edited elsewhere" },
      { ...selected, attributes: { Visible: { color: "Red", size: "Small" } } },
      { ...selected, identifier: { type: "UPC" as const, value: "123" } },
    ])
      expect(() =>
        applyBulkEdit([changed], [selected], { brand: "New" }),
      ).toThrow("changed while bulk editing");
  });
  it("checks permission before applying a valid patch", () => {
    const current = [item(1)];
    expect(() =>
      applyBulkEdit(current, current, { brand: "New" }, { canEdit: false }),
    ).toThrow("permission");
    expect(current[0].brand).toBeNull();
  });
});

describe("compatible shared attribute changes", () => {
  it("merges exact nested leaves preserving false, zero and unrelated per-item values", () => {
    const current = [
      item(1, {
        attributes: {
          Orderable: { shipping: { weight: 5, unit: "lb" }, unrelated: "one" },
          Visible: { color: "Blue" },
        },
      }),
      item(2, {
        attributes: {
          Orderable: { shipping: { weight: 6, unit: "oz" }, unrelated: "two" },
          Visible: { color: "Red" },
        },
      }),
    ];
    const original = structuredClone(current);
    const patch = {
      attributeChanges: [
        set(["Orderable", "shipping", "weight"], 0),
        set(["Visible", "fragile"], false),
      ],
    };
    const result = applyBulkEdit(current, current, patch);
    expect(result.map((value) => value.attributes)).toEqual([
      {
        Orderable: { shipping: { weight: 0, unit: "lb" }, unrelated: "one" },
        Visible: { color: "Blue", fragile: false },
      },
      {
        Orderable: { shipping: { weight: 0, unit: "oz" }, unrelated: "two" },
        Visible: { color: "Red", fragile: false },
      },
    ]);
    expect(current).toEqual(original);
  });
  it("merges object patches and replaces only the explicitly changed array", () => {
    const current = [
      item(1, {
        attributes: {
          Visible: {
            details: { keep: "different" },
            colors: ["Red"],
            sizes: ["Small"],
          },
        },
      }),
    ];
    expect(
      applyBulkEdit(current, current, {
        attributeChanges: [
          set(["Visible", "details"], { shared: "value" }),
          set(["Visible", "colors"], ["Blue", "Green"]),
        ],
      })[0].attributes,
    ).toEqual({
      Visible: {
        details: { keep: "different", shared: "value" },
        colors: ["Blue", "Green"],
        sizes: ["Small"],
      },
    });
  });
  it("explicitly removes one value and leaves unrelated siblings and absent paths intact", () => {
    const current = [
      item(1, { attributes: { Visible: { color: "Blue", size: "Small" } } }),
      item(2),
    ];
    const result = applyBulkEdit(current, current, {
      attributeChanges: [remove(["Visible", "color"])],
    });
    expect(result[0].attributes).toEqual({ Visible: { size: "Small" } });
    expect(result[1]).toBe(current[1]);
  });
  it("preserves explicit empty arrays, nulls and required empty objects", () => {
    const current = [item(1)];
    expect(
      applyBulkEdit(current, current, {
        attributeChanges: [
          set(["Visible", "colors"], []),
          set(["Visible", "optional"], null),
          set(["Visible", "details"], {}),
        ],
      })[0].attributes,
    ).toEqual({ Visible: { colors: [], optional: null, details: {} } });
  });
  it("requires a common effective method and type for attributes, but permits other mixed-field edits", () => {
    const mixed = [item(1), item(2, { productType: "Other", method: "match" })];
    const attributeChanges = [set(["Orderable", "weight"], 1)];
    expect(commonBulkContext(mixed)).toBeNull();
    expect(() => applyBulkEdit(mixed, mixed, { attributeChanges })).toThrow(
      "common listing method",
    );
    expect(() =>
      applyBulkEdit(mixed, mixed, { productType: "Common", attributeChanges }),
    ).toThrow("common listing method");
    expect(
      applyBulkEdit(mixed, mixed, { brand: "New" }).every(
        (value) => value.brand === "New",
      ),
    ).toBe(true);
    expect(
      applyBulkEdit(mixed, mixed, {
        method: "create",
        productType: "Common",
        attributeChanges,
      }).every((value) => value.attributes.Orderable !== undefined),
    ).toBe(true);
    expect(
      commonBulkContext([item(1, { method: "match", productType: "" })]),
    ).toEqual({ method: "match", productType: "" });
    expect(commonBulkContext([item(1, { productType: "" })])).toBeNull();
  });
  it("resets only items whose type or method actually changes and reports the exact affected fields", () => {
    const current = [
      item(1, { attributes: { Visible: { keep: true } } }),
      item(2, {
        productType: "Other",
        attributes: { Visible: { clear: true } },
      }),
    ];
    const patch = {
      productType: current[0].productType,
      attributeChanges: [set(["Orderable", "weight"], 1)],
    };
    const result = applyBulkEdit(current, current, patch);
    expect(result[0].attributes).toEqual({
      Visible: { keep: true },
      Orderable: { weight: 1 },
    });
    expect(result[1].attributes).toEqual({ Orderable: { weight: 1 } });
    expect(previewBulkEdit(current, patch)).toEqual({
      changedCount: 2,
      resetCount: 1,
      items: [
        {
          variantId: 1,
          fields: ["attributes.Orderable.weight"],
          attributesReset: false,
        },
        {
          variantId: 2,
          fields: ["productType", "attributes.Orderable.weight"],
          attributesReset: true,
        },
      ],
    });
    expect(
      applyBulkEdit(current, current, { method: "match" }).every(
        (value) => Object.keys(value.attributes).length === 0,
      ),
    ).toBe(true);
  });
  it("rejects conflicting paths, oversized changes and non-JSON data", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const attributeChanges of [
      [
        set(["Visible", "details"], {}),
        set(["Visible", "details", "color"], "Blue"),
      ],
      [set(["Visible", "color"], "Blue"), remove(["Visible", "color"])],
      [set(["Visible", "color"], undefined)],
      [set(["Visible", "color"], NaN)],
      [set(["Visible", "color"], cycle)],
      Array.from({ length: 251 }, (_, index) =>
        set(["Visible", `field${index}`], index),
      ),
    ])
      expect(bulkEditPatchSchema.safeParse({ attributeChanges }).success).toBe(
        false,
      );
  });
  it("rejects structural conflicts and an oversized combined result without mutating earlier items", () => {
    const current = [
      item(1),
      item(2, { attributes: { Visible: { details: "scalar" } } }),
    ];
    const original = structuredClone(current);
    expect(() =>
      applyBulkEdit(current, current, {
        attributeChanges: [set(["Visible", "details", "color"], "Blue")],
      }),
    ).toThrow("conflicts");
    expect(current).toEqual(original);
    const large = [
      item(1, {
        attributes: {
          Visible: {
            a: "a".repeat(30_000),
            b: "b".repeat(30_000),
            c: "c".repeat(30_000),
          },
        },
      }),
    ];
    expect(() =>
      applyBulkEdit(large, large, {
        attributeChanges: [set(["Visible", "d"], "d".repeat(20_000))],
      }),
    ).toThrow();
  });
  it("records clears and subsequent exact edits without duplicating or retaining overlapping paths", () => {
    const first = updateBulkAttribute([], ["Visible", "details"], {});
    const next = updateBulkAttribute(
      first,
      ["Visible", "details", "color"],
      "Blue",
    );
    expect(next).toEqual([set(["Visible", "details", "color"], "Blue")]);
    expect(
      updateBulkAttribute(next, ["Visible", "details", "color"], undefined),
    ).toEqual([remove(["Visible", "details", "color"])]);
  });
  it("retains other explicitly edited object leaves when one nested value is edited again", () => {
    const previous = updateBulkAttribute([], ["Visible", "dimensions"], {
      width: 2,
      length: 3,
    });
    const next = updateBulkAttribute(
      previous,
      ["Visible", "dimensions", "length"],
      4,
    );
    expect(next).toEqual([
      set(["Visible", "dimensions", "width"], 2),
      set(["Visible", "dimensions", "length"], 4),
    ]);
    const current = [
      item(1, { attributes: { Visible: { dimensions: { unit: "in" } } } }),
    ];
    expect(
      applyBulkEdit(current, current, { attributeChanges: next })[0].attributes,
    ).toEqual({ Visible: { dimensions: { width: 2, length: 4, unit: "in" } } });
  });
});

describe("bulk money boundary", () => {
  it("uses exact cents and rejects zero, negative, fractional cents and overflow", () => {
    expect(bulkFixedPriceCents("12.34")).toBe(1234);
    expect(bulkFixedPriceCents("90071992547409.91")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    for (const value of [
      "",
      "0",
      "-1",
      "1.001",
      "1e3",
      "NaN",
      "90071992547409.92",
    ])
      expect(() => bulkFixedPriceCents(value)).toThrow("positive fixed price");
  });
});
