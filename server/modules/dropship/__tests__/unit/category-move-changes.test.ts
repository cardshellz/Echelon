import { describe, expect, it } from "vitest";
import {
  CATEGORY_LISTING_SETTING_FIELDS,
  categoryListingSettingValuesSchema,
  type CategoryListingSettingField,
  type CategoryListingSettingValues,
  type ListingSettingStoreShelf,
  type ProductListingSettingField,
} from "../../../../../shared/dropship/listing-setting-values";
import {
  categoryMoveChangedFields,
  categoryMoveMaskedFields,
  type CategoryMoveSizeOwnFields,
} from "../../domain/category-move-changes";

/**
 * Which category settings change when Card Shellz moves a product (plan PR 9,
 * 10.6, 10.9): values compared by what decides the listing, masked where the
 * product's own row, or every chosen size, already decides it. Table-driven,
 * over deeply frozen inputs (plan 3.12 #2).
 */

const NONE: CategoryListingSettingValues = {
  price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
  textAbove: null, textBelow: null,
};
const RECIPE = { basis: "catalog_retail", markupBps: 1_000, flatCents: 0, rounding: "cent" } as const;
const EBAY = { categoryId: "183438", categoryName: "Toploaders & Holders", path: ["Collectibles", "Toploaders & Holders"] };
const SHELF: ListingSettingStoreShelf = { mode: "own", shelves: [{ id: "11", name: "Supplies:Toploaders" }] };

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const field of Object.values(value as Record<string, unknown>)) deepFreeze(field);
    Object.freeze(value);
  }
  return value;
}
/** A category row's values, parsed with the stored contract so a case can't hold a value no row can. */
function values(patch: Partial<CategoryListingSettingValues> = {}): CategoryListingSettingValues {
  return deepFreeze(categoryListingSettingValuesSchema.parse({ ...NONE, ...patch }));
}
const noMask: ReadonlySet<CategoryListingSettingField> = Object.freeze(new Set<CategoryListingSettingField>());
const changed = (from: CategoryListingSettingValues | null, to: CategoryListingSettingValues | null,
  masked: ReadonlySet<CategoryListingSettingField> = noMask) => categoryMoveChangedFields({ from, to, masked });

describe("categoryMoveChangedFields: what decides the listing", () => {
  it.each([
    ["two categories with no settings rows", null, null, []],
    ["a row that sets nothing, and no row", values(), null, []],
    ["a policy set only on the new category", null, values({ returnPolicy: { id: "R1", name: null } }), ["returnPolicy"]],
    ["a policy cleared by the new category (no row)", values({ shippingPolicy: { id: "F1", name: "Ship" } }), null, ["shippingPolicy"]],
    ["another policy id", values({ paymentPolicy: { id: "P1", name: "Pay" } }), values({ paymentPolicy: { id: "P2", name: "Pay" } }),
      ["paymentPolicy"]],
    ["a policy name only: the id decides, so no change", values({ returnPolicy: { id: "R1", name: "Old name" } }),
      values({ returnPolicy: { id: "R1", name: "New name" } }), []],
    ["a policy with a name and the same policy with none: no change", values({ returnPolicy: { id: "R1", name: "Returns" } }),
      values({ returnPolicy: { id: "R1", name: null } }), []],
    ["an eBay category name only: eBay lists by the id", values({ ebayCategory: EBAY }),
      values({ ebayCategory: { ...EBAY, categoryName: "Renamed", path: ["Collectibles", "Renamed"] } }), []],
    ["another eBay category", values({ ebayCategory: EBAY }), values({ ebayCategory: { ...EBAY, categoryId: "261328" } }),
      ["ebayCategory"]],
    ["the same shelf path under another id: eBay is sent the names", values({ storeShelf: SHELF }),
      values({ storeShelf: { mode: "own", shelves: [{ id: "99", name: "Supplies:Toploaders" }] } }), []],
    ["another shelf path", values({ storeShelf: SHELF }),
      values({ storeShelf: { mode: "own", shelves: [{ id: "11", name: "Supplies:Sleeves" }] } }), ["storeShelf"]],
    ["two shelves swapped", values({ storeShelf: { mode: "own", shelves: [{ id: "1", name: "A" }, { id: "2", name: "B" }] } }),
      values({ storeShelf: { mode: "own", shelves: [{ id: "2", name: "B" }, { id: "1", name: "A" }] } }), ["storeShelf"]],
    ["no shelf against the store default (null)", values({ storeShelf: { mode: "none" } }), null, ["storeShelf"]],
    ["another price recipe", values({ price: RECIPE }), values({ price: { ...RECIPE, flatCents: 100 } }), ["price"]],
    ["the same price recipe", values({ price: RECIPE }), values({ price: { ...RECIPE } }), []],
    ["another text below", values({ textBelow: { mode: "own", text: "Thanks." } }), values({ textBelow: { mode: "own", text: "Thank you." } }),
      ["textBelow"]],
    ["text above: none against own text", values({ textAbove: { mode: "none" } }), values({ textAbove: { mode: "own", text: "Hi." } }),
      ["textAbove"]],
    ["every setting at once, in the stored shape's order", null, values({
      price: RECIPE, ebayCategory: EBAY, storeShelf: SHELF, shippingPolicy: { id: "F", name: null }, returnPolicy: { id: "R", name: null },
      paymentPolicy: { id: "P", name: null }, textAbove: { mode: "none" }, textBelow: { mode: "own", text: "Below." },
    }), [...CATEGORY_LISTING_SETTING_FIELDS]],
  ] as const)("gives %s", (_label, from, to, expected) => {
    expect(changed(from, to)).toEqual(expected);
    // Symmetric: a move back changes the same settings.
    expect(changed(to, from)).toEqual(expected);
  });

  it("leaves out the masked settings and keeps the order of the rest", () => {
    const from = values({ price: RECIPE, storeShelf: SHELF, returnPolicy: { id: "R1", name: null } });
    expect(changed(from, null, Object.freeze(new Set<CategoryListingSettingField>(["storeShelf"])))).toEqual(["price", "returnPolicy"]);
    expect(changed(from, null, Object.freeze(new Set<CategoryListingSettingField>([...CATEGORY_LISTING_SETTING_FIELDS])))).toEqual([]);
  });

  it("changes none of its inputs", () => {
    const from = values({ storeShelf: SHELF, returnPolicy: { id: "R1", name: "Returns" } });
    const to = values({ ebayCategory: EBAY });
    const copies = structuredClone({ from, to });
    expect(() => changed(from, to)).not.toThrow();
    expect({ from, to }).toEqual(copies);
  });
});

describe("categoryMoveMaskedFields: what the move cannot reach", () => {
  const size = (ownsPrice: boolean, leftovers: CategoryMoveSizeOwnFields["leftovers"] = []): CategoryMoveSizeOwnFields =>
    deepFreeze({ ownsPrice, leftovers: [...leftovers] });
  const own = (fields: ProductListingSettingField[]) => Object.freeze(new Set(fields));

  it.each([
    ["nothing own", null, [size(false)], []],
    ["the product row's settings, in the stored shape's order", own(["textBelow", "ebayCategory", "price"]), [size(false)],
      ["price", "ebayCategory", "textBelow"]],
    ["the product's main text: not a category setting", own(["mainText"]), [size(false)], []],
    ["the price when every chosen size owns its price", null, [size(true), size(true)], ["price"]],
    ["not the price when one chosen size does not own its price", null, [size(true), size(false)], []],
    ["a policy every chosen size keeps", null, [size(false, ["returnPolicy", "storeShelf"]), size(false, ["returnPolicy"])], ["returnPolicy"]],
    ["not a policy one chosen size lacks", null, [size(false, ["shippingPolicy"]), size(false)], []],
    ["the shelf every chosen size keeps", null, [size(false, ["storeShelf"])], ["storeShelf"]],
    ["a size's own main text: not a category setting", null, [size(false, ["mainText"])], []],
    ["the row and the sizes together, once each", own(["storeShelf"]), [size(true, ["storeShelf", "paymentPolicy"])],
      ["price", "storeShelf", "paymentPolicy"]],
    ["only the row for a product with no chosen size", own(["returnPolicy"]), [], ["returnPolicy"]],
  ] as const)("masks %s", (_label, productOwnFields, sizes, expected) => {
    const masked = categoryMoveMaskedFields({ productOwnFields, sizes: Object.freeze([...sizes]) });
    expect(CATEGORY_LISTING_SETTING_FIELDS.filter((field) => masked.has(field))).toEqual(expected);
    expect(masked.size).toBe(expected.length);
  });

  it("feeds the change: a policy name-only difference and the masked shelf leave only the price", () => {
    const from = values({ price: RECIPE, storeShelf: SHELF, returnPolicy: { id: "R1", name: "Old" } });
    const to = values({ storeShelf: { mode: "none" }, returnPolicy: { id: "R1", name: "New" } });
    const masked = categoryMoveMaskedFields({ productOwnFields: null, sizes: [size(false, ["storeShelf"])] });
    expect(categoryMoveChangedFields({ from, to, masked })).toEqual(["price"]);
  });
});
