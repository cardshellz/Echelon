import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_LISTING_SETTING_FIELDS,
  LISTING_SETTING_KEY_PATTERN,
  LISTING_SETTING_REQUEST_OPERATIONS,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  MAX_LISTING_STORE_SHELVES,
  PRODUCT_LISTING_SETTING_FIELDS,
  categoryListingSettingPatchSchema,
  categoryListingSettingRowSchema,
  categoryListingSettingValuesSchema,
  categoryMovesAcknowledgeItemsSchema,
  listingSettingRequestKeySchema,
  productCategoryMarkSchema,
  productListingSettingBulkPatchSchema,
  productListingSettingPatchSchema,
  productListingSettingRowSchema,
  productListingSettingValuesSchema,
  type ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import { PRICING_REVIEW_KINDS } from "../../../../../shared/dropship/pricing-rules";
import { MAX_EBAY_STORE_SHELVES } from "../../domain/ebay-listing-setup-config";
import {
  EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  applyListingSettingPatch,
  changedListingSettingFields,
  isListingSettingChildKey,
  listingSettingBulkAuditValues,
  listingSettingChildKey,
  listingSettingRequestHash,
} from "../../domain/listing-setting-values";

const HASH = "a".repeat(64);
const RECIPE = { basis: "product_cost", markupBps: 2_500, flatCents: 99, rounding: "up_99" } as const;
const SLEEVES = { categoryId: "183454", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] };
const PARENT_KEY = "listing-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";

function allNull(): ProductListingSettingValues {
  return { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES };
}

function fullValues(): ProductListingSettingValues {
  return {
    price: { ...RECIPE },
    ebayCategory: { ...SLEEVES, path: [...SLEEVES.path] },
    storeShelf: { mode: "own", shelves: [{ id: "101", name: "Sleeves" }, { id: "202", name: "Sleeves:Standard" }] },
    shippingPolicy: { id: "6200000001", name: "Free shipping" },
    returnPolicy: { id: "6200000002", name: null },
    paymentPolicy: { id: "6200000003", name: "Pay now" },
    textAbove: { mode: "own", text: "Ships in 1 day." },
    textBelow: { mode: "none" },
    mainText: { text: "Our own words about this product.", catalogHash: HASH },
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function valuesWith(patch: Partial<Record<keyof ProductListingSettingValues, unknown>>): Record<string, unknown> {
  return { ...allNull(), ...patch };
}

describe("listing setting stored values", () => {
  it("parses every setting following the default, and every setting set", () => {
    expect(productListingSettingValuesSchema.parse(allNull())).toEqual(allNull());
    expect(productListingSettingValuesSchema.parse(fullValues())).toEqual(fullValues());
    expect(categoryListingSettingValuesSchema.parse(EMPTY_CATEGORY_LISTING_SETTING_VALUES)).toEqual(EMPTY_CATEGORY_LISTING_SETTING_VALUES);
  });

  it.each([
    ["a partial recipe", { price: { basis: "product_cost", markupBps: 100, flatCents: 0 } }],
    ["a negative markup", { price: { ...RECIPE, markupBps: -1 } }],
    ["a fractional flat amount", { price: { ...RECIPE, flatCents: 1.5 } }],
    ["three shelves", { storeShelf: { mode: "own", shelves: [{ id: "1", name: "A" }, { id: "2", name: "B" }, { id: "3", name: "C" }] } }],
    ["the same shelf twice", { storeShelf: { mode: "own", shelves: [{ id: "1", name: "A" }, { id: "1", name: "A" }] } }],
    ["no shelves with own", { storeShelf: { mode: "own", shelves: [] } }],
    ["none with shelves", { storeShelf: { mode: "none", shelves: [{ id: "1", name: "A" }] } }],
    ["a shelf id over 40 characters", { storeShelf: { mode: "own", shelves: [{ id: "1".repeat(41), name: "A" }] } }],
    ["blank own text", { textAbove: { mode: "own", text: "  \n " } }],
    ["own text over 4,000 characters", { textBelow: { mode: "own", text: "x".repeat(4_001) } }],
    ["none with text", { textAbove: { mode: "none", text: "Hello" } }],
    ["a blank policy id", { shippingPolicy: { id: " ", name: null } }],
    ["a blank policy name", { returnPolicy: { id: "1", name: " " } }],
    ["a policy name over 200 characters", { paymentPolicy: { id: "1", name: "n".repeat(201) } }],
    ["an eBay category without its path", { ebayCategory: { categoryId: "1", categoryName: "Toploaders" } }],
    ["a main text without its catalog hash", { mainText: { text: "Own words" } }],
    ["a main text with a malformed catalog hash", { mainText: { text: "Own words", catalogHash: "A".repeat(64) } }],
    ["control characters in own text", { textAbove: { mode: "own", text: "Bell\u0007" } }],
  ])("refuses %s", (_label, patch) => {
    expect(productListingSettingValuesSchema.safeParse(valuesWith(patch)).success).toBe(false);
  });

  it("refuses unknown keys at every level and a missing setting", () => {
    expect(productListingSettingValuesSchema.safeParse({ ...allNull(), descriptionTemplate: null }).success).toBe(false);
    expect(productListingSettingValuesSchema.safeParse(valuesWith({ price: { ...RECIPE, priority: 1 } })).success).toBe(false);
    expect(productListingSettingValuesSchema.safeParse(valuesWith({ shippingPolicy: { id: "1", name: null, verified: true } })).success).toBe(false);
    const { price: _price, ...withoutPrice } = allNull();
    expect(productListingSettingValuesSchema.safeParse(withoutPrice).success).toBe(false);
  });

  it("takes 4,000 characters of own text and normalizes line endings and outer space", () => {
    const parsed = productListingSettingValuesSchema.parse(valuesWith({
      textAbove: { mode: "own", text: "y".repeat(4_000) },
      textBelow: { mode: "own", text: "  Line one\r\nLine two\rLine three  " },
    }));
    expect(parsed.textAbove).toEqual({ mode: "own", text: "y".repeat(4_000) });
    expect(parsed.textBelow).toEqual({ mode: "own", text: "Line one\nLine two\nLine three" });
  });

  it("keeps a policy whose name is not known", () => {
    expect(productListingSettingValuesSchema.parse(valuesWith({ shippingPolicy: { id: "6200000001", name: null } })).shippingPolicy)
      .toEqual({ id: "6200000001", name: null });
  });

  it("gives a category every setting but the main text", () => {
    expect(Object.keys(categoryListingSettingValuesSchema.shape)).not.toContain("mainText");
    expect(categoryListingSettingValuesSchema.safeParse(allNull()).success).toBe(false);
    const { mainText: _mainText, ...category } = fullValues();
    expect(categoryListingSettingValuesSchema.parse(category)).toEqual(category);
  });

  it("lists the settings in shape order", () => {
    expect(PRODUCT_LISTING_SETTING_FIELDS).toEqual(Object.keys(productListingSettingValuesSchema.shape));
    expect(CATEGORY_LISTING_SETTING_FIELDS).toEqual(Object.keys(categoryListingSettingValuesSchema.shape));
  });

  it("mirrors the server's store shelf limit", () => {
    expect(MAX_LISTING_STORE_SHELVES).toBe(MAX_EBAY_STORE_SHELVES);
  });

  it("pins the ledger operations, the review kinds and the bulk limit", () => {
    expect(LISTING_SETTING_REQUEST_OPERATIONS).toEqual(["product_settings_bulk", "category_settings_clear", "category_moves_acknowledge"]);
    expect(PRICING_REVIEW_KINDS).toEqual(["store_default", "category_price", "product_prices"]);
    expect(MAX_LISTING_SETTING_BULK_PRODUCTS).toBe(10_000);
  });

  it("takes request keys of 8 to 200 key characters", () => {
    expect(LISTING_SETTING_KEY_PATTERN.source).toBe("^[A-Za-z0-9:_-]{8,200}$");
    expect(listingSettingRequestKeySchema.safeParse("k".repeat(8)).success).toBe(true);
    expect(listingSettingRequestKeySchema.safeParse("k".repeat(200)).success).toBe(true);
    expect(listingSettingRequestKeySchema.safeParse(PARENT_KEY).success).toBe(true);
    expect(listingSettingRequestKeySchema.safeParse("k".repeat(7)).success).toBe(false);
    expect(listingSettingRequestKeySchema.safeParse("k".repeat(201)).success).toBe(false);
    expect(listingSettingRequestKeySchema.safeParse("listing settings 1").success).toBe(false);
  });
});

describe("listing setting patches", () => {
  it("refuses a patch that changes nothing", () => {
    expect(productListingSettingPatchSchema.safeParse({}).success).toBe(false);
    expect(productListingSettingPatchSchema.safeParse({ price: undefined }).success).toBe(false);
    expect(categoryListingSettingPatchSchema.safeParse({}).success).toBe(false);
  });

  it("tells leave (absent), use the default (null) and set (a value) apart", () => {
    const parsed = productListingSettingPatchSchema.parse({ price: null, storeShelf: { mode: "none" } });
    expect(parsed).toEqual({ price: null, storeShelf: { mode: "none" } });
    expect("ebayCategory" in parsed).toBe(false);
    const after = applyListingSettingPatch(fullValues(), parsed);
    expect(after.price).toBeNull();
    expect(after.storeShelf).toEqual({ mode: "none" });
    expect(after.ebayCategory).toEqual(SLEEVES);
  });

  it("refuses unknown keys and a main text on a category", () => {
    expect(productListingSettingPatchSchema.safeParse({ price: null, descriptionTemplate: null }).success).toBe(false);
    expect(categoryListingSettingPatchSchema.safeParse({ mainText: null }).success).toBe(false);
  });

  it("refuses a price in a bulk change, even null, and main text except a reset", () => {
    const priced = productListingSettingBulkPatchSchema.safeParse({ price: { ...RECIPE } });
    expect(priced.success).toBe(false);
    expect(priced.success ? [] : priced.error.issues.map((issue) => issue.path.join("."))).toEqual(["price"]);
    expect(productListingSettingBulkPatchSchema.safeParse({ price: null }).success).toBe(false);
    expect(productListingSettingBulkPatchSchema.safeParse({ price: null, textAbove: null }).success).toBe(false);
    // A key with the value undefined (built in code, never from JSON) counts as absent, as in the single patch.
    expect(productListingSettingBulkPatchSchema.safeParse({ price: undefined, storeShelf: null }).success).toBe(true);
    expect(productListingSettingBulkPatchSchema.safeParse({ price: undefined }).success).toBe(false);
    const ownText = productListingSettingBulkPatchSchema.safeParse({ mainText: { text: "Own words", catalogHash: HASH } });
    expect(ownText.success ? [] : ownText.error.issues.map((issue) => issue.path.join("."))).toEqual(["mainText"]);
    expect(productListingSettingBulkPatchSchema.parse({ mainText: null })).toEqual({ mainText: null });
    expect(productListingSettingBulkPatchSchema.parse({ storeShelf: null, textBelow: { mode: "none" } }))
      .toEqual({ storeShelf: null, textBelow: { mode: "none" } });
    expect(productListingSettingBulkPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe("category move acknowledgements", () => {
  it("takes 1 to 10,000 distinct products", () => {
    expect(categoryMovesAcknowledgeItemsSchema.parse([{ productId: 1, shownCategoryId: 4 }, { productId: 2, shownCategoryId: null }]))
      .toEqual([{ productId: 1, shownCategoryId: 4 }, { productId: 2, shownCategoryId: null }]);
    const max = Array.from({ length: 10_000 }, (_, index) => ({ productId: index + 1, shownCategoryId: null }));
    expect(categoryMovesAcknowledgeItemsSchema.safeParse(max).success).toBe(true);
  });

  it("refuses none, 10,001, a product twice, and a non-positive id", () => {
    expect(categoryMovesAcknowledgeItemsSchema.safeParse([]).success).toBe(false);
    const over = Array.from({ length: 10_001 }, (_, index) => ({ productId: index + 1, shownCategoryId: null }));
    expect(categoryMovesAcknowledgeItemsSchema.safeParse(over).success).toBe(false);
    expect(categoryMovesAcknowledgeItemsSchema.safeParse([
      { productId: 1, shownCategoryId: 4 }, { productId: 1, shownCategoryId: 5 },
    ]).success).toBe(false);
    expect(categoryMovesAcknowledgeItemsSchema.safeParse([{ productId: 0, shownCategoryId: null }]).success).toBe(false);
    expect(categoryMovesAcknowledgeItemsSchema.safeParse([{ productId: 1 }]).success).toBe(false);
  });
});

describe("listing setting rows", () => {
  it("parses product rows, category rows and marks", () => {
    const updatedAt = "2026-10-10T12:00:00.000Z";
    expect(productListingSettingRowSchema.parse({ storeConnectionId: 5, productId: 7, revisionId: 3, updatedAt, values: fullValues() }).values)
      .toEqual(fullValues());
    const { mainText: _mainText, ...category } = fullValues();
    expect(categoryListingSettingRowSchema.safeParse({ storeConnectionId: 5, categoryId: 2, revisionId: 1, updatedAt, values: category }).success).toBe(true);
    expect(productCategoryMarkSchema.safeParse({ storeConnectionId: 5, productId: 7, categoryId: null, seenAt: updatedAt }).success).toBe(true);
    expect(productListingSettingRowSchema.safeParse({ storeConnectionId: 5, productId: 7, revisionId: 3, updatedAt, values: fullValues(), vendorId: 1 }).success)
      .toBe(false);
  });
});

describe("applyListingSettingPatch", () => {
  it("never mutates its inputs and keeps every absent setting", () => {
    const before = deepFreeze(fullValues());
    const patch = deepFreeze({ price: null, textBelow: { mode: "own" as const, text: "Thanks!" } });
    const after = applyListingSettingPatch(before, patch);
    expect(after).not.toBe(before);
    expect(after).toEqual({ ...fullValues(), price: null, textBelow: { mode: "own", text: "Thanks!" } });
    expect(before).toEqual(fullValues());
    expect(patch).toEqual({ price: null, textBelow: { mode: "own", text: "Thanks!" } });
  });

  it("starts from the frozen empty values without changing them", () => {
    const after = applyListingSettingPatch(EMPTY_PRODUCT_LISTING_SETTING_VALUES, { storeShelf: { mode: "none" } });
    expect(after).toEqual({ ...allNull(), storeShelf: { mode: "none" } });
    expect(Object.isFrozen(EMPTY_PRODUCT_LISTING_SETTING_VALUES)).toBe(true);
    expect(EMPTY_PRODUCT_LISTING_SETTING_VALUES.storeShelf).toBeNull();
  });

  it("treats a key present as undefined as absent", () => {
    expect(applyListingSettingPatch(fullValues(), { price: undefined, returnPolicy: null }))
      .toEqual({ ...fullValues(), returnPolicy: null });
  });
});

describe("changedListingSettingFields", () => {
  it("names the settings that differ, in the order given", () => {
    const before = fullValues();
    const after = { ...fullValues(), textAbove: null, price: { ...RECIPE, markupBps: 3_000 } };
    expect(changedListingSettingFields(before, after, PRODUCT_LISTING_SETTING_FIELDS)).toEqual(["price", "textAbove"]);
    expect(changedListingSettingFields(before, after, ["textAbove", "price"])).toEqual(["textAbove", "price"]);
    expect(changedListingSettingFields(before, after, ["storeShelf"])).toEqual([]);
  });

  it("ignores key order inside a value but not array order", () => {
    const before = fullValues();
    const reordered = {
      ...fullValues(),
      price: { rounding: "up_99", flatCents: 99, markupBps: 2_500, basis: "product_cost" } as const,
      ebayCategory: { path: [...SLEEVES.path], categoryName: SLEEVES.categoryName, categoryId: SLEEVES.categoryId },
    };
    expect(changedListingSettingFields(before, reordered, PRODUCT_LISTING_SETTING_FIELDS)).toEqual([]);
    const swapped = { ...fullValues(), storeShelf: { mode: "own" as const, shelves: [{ id: "202", name: "Sleeves:Standard" }, { id: "101", name: "Sleeves" }] } };
    expect(changedListingSettingFields(before, swapped, PRODUCT_LISTING_SETTING_FIELDS)).toEqual(["storeShelf"]);
  });

  it("reads no stored row as every setting following the default", () => {
    expect(changedListingSettingFields(null, allNull(), PRODUCT_LISTING_SETTING_FIELDS)).toEqual([]);
    expect(changedListingSettingFields(null, { ...allNull(), storeShelf: { mode: "none" } }, PRODUCT_LISTING_SETTING_FIELDS))
      .toEqual(["storeShelf"]);
  });
});

describe("listingSettingBulkAuditValues", () => {
  const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("keeps only the named settings and puts texts in by length and digest", () => {
    const values = { ...fullValues(), textBelow: { mode: "own" as const, text: "Thanks for buying!" } };
    const audit = listingSettingBulkAuditValues(values, ["textAbove", "textBelow", "mainText", "storeShelf"]);
    expect(audit).toEqual({
      textAbove: { mode: "own", length: "Ships in 1 day.".length, sha256: digest("Ships in 1 day.") },
      textBelow: { mode: "own", length: "Thanks for buying!".length, sha256: digest("Thanks for buying!") },
      mainText: { length: "Our own words about this product.".length, sha256: digest("Our own words about this product."), catalogHash: HASH },
      storeShelf: values.storeShelf,
    });
    expect(JSON.stringify(audit)).not.toContain("Ships in 1 day.");
    expect(listingSettingBulkAuditValues(values, ["textAbove"])).toEqual(listingSettingBulkAuditValues(values, ["textAbove"]));
  });

  it("keeps none, null and non-text values as stored, and no values as null", () => {
    expect(listingSettingBulkAuditValues({ ...allNull(), textBelow: { mode: "none" }, price: { ...RECIPE } }, ["textBelow", "textAbove", "price"]))
      .toEqual({ textBelow: { mode: "none" }, textAbove: null, price: RECIPE });
    expect(listingSettingBulkAuditValues(null, ["price"])).toBeNull();
    expect(listingSettingBulkAuditValues(fullValues(), [])).toEqual({});
  });
});

describe("listing setting child keys", () => {
  it("is deterministic, short, and a valid key even for a 200-character parent", () => {
    const longParent = "p".repeat(200);
    const key = listingSettingChildKey(longParent, "ebay_rules", 2_147_483_647);
    expect(key).toBe(listingSettingChildKey(longParent, "ebay_rules", 2_147_483_647));
    expect(key).toBe(`ls:${createHash("sha256").update(longParent).digest("hex")}:ebay_rules:2147483647`);
    expect(key.length).toBeLessThanOrEqual(91);
    expect(LISTING_SETTING_KEY_PATTERN.test(key)).toBe(true);
    expect(listingSettingChildKey(PARENT_KEY, "product", 7)).not.toBe(listingSettingChildKey(PARENT_KEY, "size", 7));
    expect(listingSettingChildKey(PARENT_KEY, "product", 7)).not.toBe(listingSettingChildKey(`${PARENT_KEY}x`, "product", 7));
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])("refuses id %s", (id) => {
    expect(() => listingSettingChildKey(PARENT_KEY, "size", id)).toThrow(expect.objectContaining({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: expect.objectContaining({ classification: "fatal", retryable: false }),
    }));
  });

  it("refuses a malformed parent key", () => {
    expect(() => listingSettingChildKey("short", "product", 1)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" }));
    expect(() => listingSettingChildKey("not a valid key", "product", 1)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" }));
  });

  it("recognizes a child key of its own parent and kind only", () => {
    const key = listingSettingChildKey(PARENT_KEY, "content", 42);
    expect(isListingSettingChildKey(PARENT_KEY, key, "content")).toBe(true);
    expect(isListingSettingChildKey(PARENT_KEY, key, "size")).toBe(false);
    expect(isListingSettingChildKey(`${PARENT_KEY}x`, key, "content")).toBe(false);
    expect(isListingSettingChildKey(PARENT_KEY, PARENT_KEY, "content")).toBe(false);
    expect(isListingSettingChildKey(PARENT_KEY, `${key}0`, "content")).toBe(true);
    const prefix = key.slice(0, -"42".length);
    expect(isListingSettingChildKey(PARENT_KEY, `${prefix}0`, "content")).toBe(false);
    expect(isListingSettingChildKey(PARENT_KEY, `${prefix}042`, "content")).toBe(false);
    expect(isListingSettingChildKey(PARENT_KEY, `${prefix}2147483648`, "content")).toBe(false);
    expect(isListingSettingChildKey(PARENT_KEY, prefix, "content")).toBe(false);
  });

  it("recognizes a child key for one target only when given its id", () => {
    const variantFive = listingSettingChildKey(PARENT_KEY, "content", 5);
    expect(isListingSettingChildKey(PARENT_KEY, variantFive, "content", 5)).toBe(true);
    expect(isListingSettingChildKey(PARENT_KEY, variantFive, "content", 6)).toBe(false);
    expect(isListingSettingChildKey(PARENT_KEY, variantFive, "content")).toBe(true);
    expect(isListingSettingChildKey(PARENT_KEY, variantFive, "ebay_rules", 5)).toBe(false);
    for (const invalid of [0, -5, 5.5, Number.NaN]) {
      expect(isListingSettingChildKey(PARENT_KEY, variantFive, "content", invalid)).toBe(false);
    }
  });
});

describe("listingSettingRequestHash", () => {
  it("is the same for equal parsed requests whatever the input key order", () => {
    const first = productListingSettingPatchSchema.parse({ price: { ...RECIPE }, storeShelf: { mode: "none" } });
    const second = productListingSettingPatchSchema.parse({
      storeShelf: { mode: "none" }, price: { rounding: "up_99", flatCents: 99, markupBps: 2_500, basis: "product_cost" },
    });
    expect(listingSettingRequestHash({ productId: 7, patch: first })).toBe(listingSettingRequestHash({ productId: 7, patch: second }));
    expect(listingSettingRequestHash({ productId: 7, patch: first })).toMatch(/^[a-f0-9]{64}$/);
    expect(listingSettingRequestHash({ productId: 8, patch: first })).not.toBe(listingSettingRequestHash({ productId: 7, patch: first }));
  });
});
