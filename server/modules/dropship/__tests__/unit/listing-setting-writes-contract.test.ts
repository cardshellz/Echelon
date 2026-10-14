import { describe, expect, it } from "vitest";
import {
  CATEGORY_LISTING_SETTING_FIELDS,
  productListingSettingPriceApplyPatchSchema,
} from "../../../../../shared/dropship/listing-setting-values";
import { PRICING_REVIEW_KINDS } from "../../../../../shared/dropship/pricing-rules";
import {
  MAX_PRICE_CHANGE_REVIEW_PAGE,
  MAX_PRICE_RELEASES_PER_APPLY,
  PRICE_CHANGE_CLEAR_FIELDS,
  PRICE_CHANGE_REVIEW_KINDS,
  acknowledgeCategoryMovesInputSchema,
  acknowledgeCategoryMovesResponseSchema,
  applyPriceChangesInputSchema,
  applyPriceChangesResponseSchema,
  priceChangeReviewPageInputSchema,
  priceChangeReviewResponseSchema,
  priceChangeRowSchema,
  priceChangeRowsSchema,
  reviewPriceChangesInputSchema,
  storedCategoryPriceInputSchema,
  storedInputSchemaFor,
  storedProductPricesInputSchema,
} from "../../../../../shared/dropship/listing-setting-writes";
import {
  CATEGORY_CLEAR_FIELDS,
  LISTING_SETTING_WRITE_ERROR_CODES,
  MAX_BULK_TEXT_BYTES,
  MAX_EBAY_ID_INPUT_LENGTH,
  MAX_SIZE_PRICES_PER_REQUEST,
  MAX_STORE_LISTING_TEXT_BYTES,
  patchTextBytes,
  productSettingsPatchInputSchema,
  saveCategorySettingsInputSchema,
  saveCategorySettingsResponseSchema,
  saveProductSettingsInputSchema,
  saveProductSettingsResponseSchema,
  saveProductsBulkInputSchema,
  saveProductsBulkResponseSchema,
  saveSizePricesInputSchema,
  saveSizePricesResponseSchema,
} from "../../../../../shared/dropship/listing-setting-writes";

const KEY = "size-prices:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const row = (productVariantId: number, fields: Record<string, unknown> = {}) =>
  ({ productVariantId, priceCents: 1_499, expectedRevisionId: null, ...fields });
const rows = (count: number) => Array.from({ length: count }, (_, index) => row(index + 1));

describe("W8 size prices input (plan PR 9, section 4.2)", () => {
  it("is bound at 200 sizes a request (plan P38)", () => {
    expect(MAX_SIZE_PRICES_PER_REQUEST).toBe(200);
  });

  it("accepts 1 and 200 distinct sizes, and leaves the input as it was", () => {
    const input = Object.freeze({ idempotencyKey: KEY, rows: Object.freeze(rows(200).map((value) => Object.freeze(value))) });
    expect(saveSizePricesInputSchema.parse(input).rows).toHaveLength(200);
    expect(saveSizePricesInputSchema.parse({ idempotencyKey: KEY, rows: [row(7, { expectedRevisionId: 12 })] }))
      .toEqual({ idempotencyKey: KEY, rows: [{ productVariantId: 7, priceCents: 1_499, expectedRevisionId: 12 }] });
  });

  it.each([
    ["no sizes", []],
    ["201 sizes", rows(201)],
    ["the same size twice", [row(7), row(7, { priceCents: 999 })]],
  ])("refuses %s", (_label, value) => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: KEY, rows: value }).success).toBe(false);
  });

  it.each([
    ["a zero price", { priceCents: 0 }],
    ["a negative price", { priceCents: -100 }],
    ["a fractional price", { priceCents: 14.99 }],
    ["a price past the int4 columns", { priceCents: 2_147_483_648 }],
    ["a price as text", { priceCents: "1499" }],
    ["no price", { priceCents: null }],
    ["a zero size id", { productVariantId: 0 }],
    ["a size id past int4", { productVariantId: 2_147_483_648 }],
    ["a zero expected revision", { expectedRevisionId: 0 }],
    ["a missing expected revision", { expectedRevisionId: undefined }],
    ["a pricing mode", { pricingMode: "fixed" }],
    ["an unknown key", { note: "x" }],
  ])("refuses a row with %s", (_label, fields) => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: KEY, rows: [row(7, fields)] }).success).toBe(false);
  });

  it.each([
    ["a 7-character key", "abcdefg"],
    ["a key with a space", "size prices:1"],
    ["a 201-character key", "k".repeat(201)],
    ["no key", undefined],
  ])("refuses %s (a 400, never the wrapper's fatal 500)", (_label, idempotencyKey) => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey, rows: [row(7)] }).success).toBe(false);
  });

  it("accepts an 8-character key, and refuses an unknown top-level key", () => {
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: "abcdefgh", rows: [row(7)] }).success).toBe(true);
    expect(saveSizePricesInputSchema.safeParse({ idempotencyKey: KEY, rows: [row(7)], storeConnectionId: 22 }).success).toBe(false);
  });
});

describe("W8 size prices answer", () => {
  const size = (productVariantId: number, idempotentReplay: boolean) => ({ productVariantId, revisionId: productVariantId + 1_000, idempotentReplay });

  it("is changed with no replayed size, or replayed with every size replayed", () => {
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false), size(2, false)] }).success).toBe(true);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "replayed", sizes: [size(1, true)] }).success).toBe(true);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false), size(2, true)] }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "replayed", sizes: [size(1, false)] }).success).toBe(false);
  });

  it("names each size once, at least one and at most 200, with no other key", () => {
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [] }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false), size(1, false)] }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed",
      sizes: Array.from({ length: 201 }, (_, index) => size(index + 1, false)) }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "changed", sizes: [size(1, false)], requestId: 4 }).success).toBe(false);
    expect(saveSizePricesResponseSchema.safeParse({ outcome: "unchanged", sizes: [size(1, false)] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W5 (plan PR 9, section 6.3)
// ---------------------------------------------------------------------------

const PRODUCT_KEY = "product-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const RECIPE = { basis: "product_cost", markupBps: 3_000, flatCents: 0, rounding: "cent" } as const;
const product = (fields: Record<string, unknown> = {}) =>
  ({ idempotencyKey: PRODUCT_KEY, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } }, ...fields });
const shown = (count: number) => Array.from({ length: count }, (_, index) => ({ productVariantId: index + 1, priceCents: 1_499 }));
const typed = (productVariantId: number) => ({ productVariantId, pricingMode: "fixed", priceCents: 1_499, expectedRevisionId: null });
const released = (productVariantId: number) => ({ productVariantId, pricingMode: "inherit", expectedRevisionId: 4 });

describe("W5 one product input", () => {
  it("names the new codes and bounds", () => {
    expect(LISTING_SETTING_WRITE_ERROR_CODES.pricesMoved).toBe("DROPSHIP_LISTING_PRICES_MOVED");
    expect(LISTING_SETTING_WRITE_ERROR_CODES.ebaySignInRequired).toBe("DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED");
    expect(MAX_EBAY_ID_INPUT_LENGTH).toBe(100);
    // The store cap moves with the bulk text budget (plan 3.10 (e)).
    expect(MAX_STORE_LISTING_TEXT_BYTES).toBe(MAX_BULK_TEXT_BYTES);
  });

  it("fills an absent patch and size prices, and keeps the patch in the stored shape's key order", () => {
    const parsed = saveProductSettingsInputSchema.parse({ idempotencyKey: PRODUCT_KEY, expectedRevisionId: 5,
      sizePrices: [typed(1)], expectedPrices: shown(1) });
    expect(parsed.patch).toEqual({});
    const ordered = productSettingsPatchInputSchema.parse({ textBelow: null, price: RECIPE, ebayCategory: { categoryId: "183438" } });
    expect(Object.keys(ordered)).toEqual(["price", "ebayCategory", "textBelow"]);
  });

  it.each([
    ["no change at all", product({ patch: {} })],
    ["a 7-character key", product({ idempotencyKey: "abcdefg" })],
    ["no expected revision", { idempotencyKey: PRODUCT_KEY, patch: { storeShelf: null } }],
    ["an unknown top-level key", { ...product(), storeConnectionId: 22 }],
    ["an unknown patch key", product({ patch: { storeShelf: null, shelf: null } })],
    ["an eBay category name", product({ patch: { ebayCategory: { categoryId: "183438", categoryName: "Toploaders" } } })],
    ["an eBay category that is not a number", product({ patch: { ebayCategory: { categoryId: "0183" } } })],
    ["a policy name", product({ patch: { shippingPolicy: { id: "P1", name: "Free" } } })],
    ["a policy id past 100 characters", product({ patch: { shippingPolicy: { id: "p".repeat(101) } } })],
    ["shelf names", product({ patch: { storeShelf: { mode: "own", shelves: [{ id: "1", name: "Top" }] } } })],
    ["three shelves", product({ patch: { storeShelf: { mode: "own", shelfIds: ["1", "2", "3"] } } })],
    ["the same shelf twice", product({ patch: { storeShelf: { mode: "own", shelfIds: ["1", "1"] } } })],
    ["a shelf id past 100 characters", product({ patch: { storeShelf: { mode: "own", shelfIds: ["s".repeat(101)] } } })],
    ["a main text with its catalog hash", product({ patch: { mainText: { text: "Words.", catalogHash: "a".repeat(64) } } })],
    ["an empty own text above", product({ patch: { textAbove: { mode: "own", text: "  " } } })],
    ["a rules size price", product({ sizePrices: [{ productVariantId: 1, pricingMode: "rules", expectedRevisionId: null }], expectedPrices: shown(1) })],
    ["a fixed size price without a price", product({ sizePrices: [{ productVariantId: 1, pricingMode: "fixed", expectedRevisionId: null }], expectedPrices: shown(1) })],
    ["an inherit size price with a price", product({ sizePrices: [{ ...released(1), priceCents: 999 }], expectedPrices: shown(1) })],
    ["a fractional typed price", product({ sizePrices: [{ ...typed(1), priceCents: 14.99 }], expectedPrices: shown(1) })],
    ["the same size twice in size prices", product({ sizePrices: [typed(1), released(1)], expectedPrices: shown(1) })],
    ["201 size prices", product({ sizePrices: Array.from({ length: 201 }, (_, index) => typed(index + 1)), expectedPrices: shown(201) })],
    ["the same size twice in shown prices", product({ patch: { price: null }, expectedPrices: [...shown(1), ...shown(1)] })],
    ["10,001 shown prices", product({ patch: { price: null }, expectedPrices: shown(10_001) })],
    ["no shown prices", product({ patch: { price: null }, expectedPrices: [] })],
    ["a price change without shown prices", product({ patch: { price: RECIPE } })],
    ["a size price without shown prices", product({ sizePrices: [typed(1)] })],
    ["shown prices with no price change", product({ expectedPrices: shown(1) })],
    ["a zero shown price", product({ patch: { price: null }, expectedPrices: [{ productVariantId: 1, priceCents: 0 }] })],
  ])("refuses %s", (_label, value) => {
    expect(saveProductSettingsInputSchema.safeParse(value).success).toBe(false);
  });

  it("refuses without shown prices, with our words, and refuses them sent with nothing to check", () => {
    const missing = saveProductSettingsInputSchema.safeParse(product({ patch: { price: null } }));
    expect(missing.success).toBe(false);
    expect(missing.error?.issues).toEqual([expect.objectContaining({ code: "custom", path: ["expectedPrices"],
      message: "Send the price you were shown for every size." })]);
    const extra = saveProductSettingsInputSchema.safeParse(product({ expectedPrices: shown(1) }));
    expect(extra.error?.issues).toEqual([expect.objectContaining({ code: "custom", path: ["expectedPrices"],
      message: "Send shown prices only with a price change." })]);
  });

  it.each([
    ["a shelf reset", product({ patch: { storeShelf: null } })],
    ["only size prices", product({ patch: {}, sizePrices: [typed(1), released(2)], expectedPrices: shown(2) })],
    ["200 size prices", product({ patch: {}, sizePrices: Array.from({ length: 200 }, (_, index) => typed(index + 1)), expectedPrices: shown(200) })],
    ["10,000 shown prices", product({ patch: { price: RECIPE }, expectedPrices: shown(10_000) })],
    ["a null shown price (can't price)", product({ patch: { price: null }, expectedPrices: [{ productVariantId: 1, priceCents: null }] })],
    ["every field by id", product({ patch: { price: RECIPE, ebayCategory: { categoryId: "183438" },
      storeShelf: { mode: "own", shelfIds: ["s".repeat(100), "2"] }, shippingPolicy: { id: "p".repeat(100) }, returnPolicy: null,
      paymentPolicy: { id: "P1" }, textAbove: { mode: "own", text: "Above." }, textBelow: { mode: "none" }, mainText: { text: "Main." } },
      expectedPrices: shown(1) })],
    ["an 8-character key", product({ idempotencyKey: "abcdefgh" })],
  ])("accepts %s", (_label, value) => {
    const frozen = Object.freeze(value);
    expect(saveProductSettingsInputSchema.safeParse(frozen).success).toBe(true);
  });
});

describe("W5 one product answer", () => {
  const answer = (fields: Record<string, unknown> = {}) =>
    ({ outcome: "changed", productId: 7, revisionId: 31, sizes: [{ productVariantId: 101, revisionId: 55 }], clearedSizeCount: 2, ...fields });

  it("accepts a change, an unchanged save that wrote nothing, and a replay with no count", () => {
    expect(saveProductSettingsResponseSchema.safeParse(answer()).success).toBe(true);
    expect(saveProductSettingsResponseSchema.safeParse(answer({ outcome: "unchanged", sizes: [], clearedSizeCount: 0 })).success).toBe(true);
    expect(saveProductSettingsResponseSchema.safeParse(answer({ outcome: "replayed", clearedSizeCount: null })).success).toBe(true);
    expect(saveProductSettingsResponseSchema.safeParse(answer({ revisionId: null, sizes: [] })).success).toBe(true);
  });

  it.each([
    ["a replay with a count", answer({ outcome: "replayed" })],
    ["a change with no count", answer({ clearedSizeCount: null })],
    ["an unchanged save with sizes", answer({ outcome: "unchanged", clearedSizeCount: 0 })],
    ["an unchanged save that cleared", answer({ outcome: "unchanged", sizes: [], clearedSizeCount: 1 })],
    ["a size twice", answer({ sizes: [{ productVariantId: 101, revisionId: 1 }, { productVariantId: 101, revisionId: 2 }] })],
    ["201 sizes", answer({ sizes: Array.from({ length: 201 }, (_, index) => ({ productVariantId: index + 1, revisionId: index + 1 })) })],
    ["an unknown key", answer({ requestId: 4 })],
    ["another outcome", answer({ outcome: "acknowledged" })],
  ])("refuses %s", (_label, value) => {
    expect(saveProductSettingsResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("patchTextBytes (plan 3.10 (b), (e))", () => {
  it.each([
    ["ASCII", "Ships fast.", 11],
    ["two-byte characters", "Ünïcödé", 11],
    ["three-byte characters", "Card’s “best”", 19],
    ["astral characters", "Cards 🃏🃏", 14],
  ])("counts %s in UTF-8 bytes, in each part that sets text", (_label, text, bytes) => {
    expect(patchTextBytes({ textAbove: { mode: "own", text } })).toBe(bytes);
    expect(patchTextBytes({ textBelow: { mode: "own", text } })).toBe(bytes);
    expect(patchTextBytes({ mainText: { text } })).toBe(bytes);
    expect(patchTextBytes({ textAbove: { mode: "own", text }, textBelow: { mode: "own", text }, mainText: { text } })).toBe(3 * bytes);
  });

  it("counts none, null and absent as 0, and a stored main text's text only", () => {
    expect(patchTextBytes({})).toBe(0);
    expect(patchTextBytes({ textAbove: { mode: "none" }, textBelow: null, mainText: null })).toBe(0);
    expect(patchTextBytes(Object.freeze({ mainText: Object.freeze({ text: "abc", catalogHash: "a".repeat(64) }) }))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// W6 (plan PR 9, section 7.3)
// ---------------------------------------------------------------------------

const BULK_KEY = "products-bulk:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const products = (count: number) => Array.from({ length: count }, (_, index) =>
  ({ productId: 2_000_000_000 + index, expectedRevisionId: index % 2 === 0 ? null : 2_000_000_000 + index }));
const bulk = (fields: Record<string, unknown> = {}) =>
  ({ idempotencyKey: BULK_KEY, products: products(2), patch: { storeShelf: { mode: "none" } }, ...fields });

describe("W6 many products input", () => {
  it("names the bulk text budget: plan 3.10's live-heap rule's output, at P9's 30,000,000 ceiling", () => {
    expect(MAX_BULK_TEXT_BYTES).toBe(30_000_000);
  });

  it("accepts 1 and 10,000 products, under the 1 MiB body, and leaves the input as it was", () => {
    const input = Object.freeze(bulk({ products: Object.freeze(products(10_000).map((entry) => Object.freeze(entry))) }));
    const parsed = saveProductsBulkInputSchema.parse(input);
    expect(parsed.products).toHaveLength(10_000);
    expect(JSON.stringify(input).length).toBeLessThan(600_000);
    expect(saveProductsBulkInputSchema.parse(bulk({ products: products(1) })).products).toEqual(products(1));
  });

  it("keeps the patch in the stored shape's key order", () => {
    const parsed = saveProductsBulkInputSchema.parse(bulk({ patch: { textBelow: null, mainText: null, shippingPolicy: { id: "P1" } } }));
    expect(Object.keys(parsed.patch)).toEqual(["shippingPolicy", "textBelow", "mainText"]);
  });

  it.each([
    ["no products", bulk({ products: [] })],
    ["10,001 products", bulk({ products: products(10_001) })],
    ["the same product twice", bulk({ products: [...products(1), ...products(1)] })],
    ["a product without its expected revision", bulk({ products: [{ productId: 7 }] })],
    ["a product with another key", bulk({ products: [{ productId: 7, expectedRevisionId: null, categoryId: 3 }] })],
    ["a product id of 0", bulk({ products: [{ productId: 0, expectedRevisionId: null }] })],
    ["a product id past int4", bulk({ products: [{ productId: 2_147_483_648, expectedRevisionId: null }] })],
    ["a 7-character key", bulk({ idempotencyKey: "abcdefg" })],
    ["an unknown top-level key", { ...bulk(), storeConnectionId: 22 }],
    ["an unknown patch key", bulk({ patch: { storeShelf: null, shelf: null } })],
    ["an eBay category name", bulk({ patch: { ebayCategory: { categoryId: "183438", categoryName: "Toploaders" } } })],
    ["shelf names", bulk({ patch: { storeShelf: { mode: "own", shelves: [{ id: "1", name: "Top" }] } } })],
    ["an empty own text below", bulk({ patch: { textBelow: { mode: "own", text: " " } } })],
    ["no patch", { idempotencyKey: BULK_KEY, products: products(1) }],
  ])("refuses %s", (_label, value) => {
    expect(saveProductsBulkInputSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["a price, even a reset", { price: null }, ["price"], "Change prices for many products with a price check."],
    ["a price recipe", { price: RECIPE, storeShelf: null }, ["price"], "Change prices for many products with a price check."],
    ["a main text value", { mainText: { text: "Own words." } }, ["mainText"], "Main text can only be reset for many products."],
    ["no change at all", {}, [], "Change at least one setting."],
  ])("refuses %s with the stored bulk contract's words", (_label, patch, path, message) => {
    const parsed = saveProductsBulkInputSchema.safeParse(bulk({ patch }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ code: "custom", path: ["patch", ...path], message })]);
  });

  it.each([
    ["a shelf none", { storeShelf: { mode: "none" } }],
    ["every reset", { ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null,
      textAbove: null, textBelow: null, mainText: null }],
    ["every eBay field by id and own texts", { ebayCategory: { categoryId: "183438" }, storeShelf: { mode: "own", shelfIds: ["1", "2"] },
      shippingPolicy: { id: "P1" }, returnPolicy: { id: "P2" }, paymentPolicy: { id: "P3" },
      textAbove: { mode: "own", text: "Above." }, textBelow: { mode: "none" } }],
  ])("accepts %s", (_label, patch) => {
    expect(saveProductsBulkInputSchema.safeParse(Object.freeze(bulk({ patch: Object.freeze(patch) }))).success).toBe(true);
  });
});

describe("W6 many products answer", () => {
  const answer = (fields: Record<string, unknown> = {}) =>
    ({ outcome: "changed", requestId: 9_007_199_254, productCount: 3, changedProductCount: 2, clearedSizeCount: 5, ...fields });

  it("accepts a change, an unchanged save that wrote nothing, and a replay with no counts", () => {
    expect(saveProductsBulkResponseSchema.safeParse(answer()).success).toBe(true);
    expect(saveProductsBulkResponseSchema.safeParse(answer({ changedProductCount: 0 })).success).toBe(true);
    expect(saveProductsBulkResponseSchema.safeParse(answer({ outcome: "unchanged", changedProductCount: 0, clearedSizeCount: 0 })).success)
      .toBe(true);
    expect(saveProductsBulkResponseSchema.safeParse(answer({ outcome: "replayed", changedProductCount: null, clearedSizeCount: null }))
      .success).toBe(true);
    // The ledger id is a bigint identity: past int4 is allowed.
    expect(saveProductsBulkResponseSchema.safeParse(answer({ requestId: 2_147_483_648 })).success).toBe(true);
  });

  it.each([
    ["a replay with counts", answer({ outcome: "replayed" })],
    ["a replay with one count", answer({ outcome: "replayed", changedProductCount: null })],
    ["a change with no counts", answer({ changedProductCount: null, clearedSizeCount: null })],
    ["an unchanged save that changed a product", answer({ outcome: "unchanged", changedProductCount: 1, clearedSizeCount: 0 })],
    ["an unchanged save that cleared", answer({ outcome: "unchanged", changedProductCount: 0, clearedSizeCount: 1 })],
    ["more changed products than named", answer({ changedProductCount: 4 })],
    ["no product named", answer({ productCount: 0, changedProductCount: 0 })],
    ["10,001 products named", answer({ productCount: 10_001 })],
    ["a request id of 0", answer({ requestId: 0 })],
    ["an unknown key", answer({ sizes: [] })],
    ["another outcome", answer({ outcome: "acknowledged" })],
  ])("refuses %s", (_label, value) => {
    expect(saveProductsBulkResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("W12 one category input (plan PR 9, section 8.3)", () => {
  const CATEGORY_KEY = "category-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
  const RECIPE = { basis: "catalog_retail", markupBps: 0, flatCents: 100, rounding: "cent" };
  const clearProducts = (count: number) => Array.from({ length: count }, (_, index) => ({ productId: index + 1, expectedRevisionId: null }));
  const category = (fields: Record<string, unknown> = {}) =>
    ({ idempotencyKey: CATEGORY_KEY, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } }, ...fields });

  it("names the clearable settings in the stored shape's order: no price (plan P34), no main text", () => {
    expect(CATEGORY_CLEAR_FIELDS).toEqual(["ebayCategory", "storeShelf", "shippingPolicy", "returnPolicy", "paymentPolicy", "textAbove",
      "textBelow"]);
  });

  it("accepts a change with no clear, and a clear of 10,000 products under the 1 MiB body, leaving the input as it was", () => {
    const input = Object.freeze(category({ expectedRevisionId: 12, patch: Object.freeze({ shippingPolicy: { id: "P1" }, storeShelf: null }) }));
    const parsed = saveCategorySettingsInputSchema.parse(input);
    expect(parsed).toEqual({ idempotencyKey: CATEGORY_KEY, expectedRevisionId: 12, patch: { storeShelf: null, shippingPolicy: { id: "P1" } } });
    // The patch keys come back in the stored shape's order, so the hash does not depend on the order sent.
    expect(Object.keys(parsed.patch)).toEqual(["storeShelf", "shippingPolicy"]);

    const large = category({ patch: { textAbove: { mode: "own", text: "Above." } },
      clear: { fields: ["textAbove"], products: Array.from({ length: 10_000 },
        (_, index) => ({ productId: 2_000_000_000 + index, expectedRevisionId: 2_000_000_000 + index })) } });
    expect(JSON.stringify(large).length).toBeLessThan(1024 * 1024);
    expect(saveCategorySettingsInputSchema.parse(Object.freeze(large)).clear?.products).toHaveLength(10_000);
  });

  it("accepts every clearable setting at once when the patch sets each", () => {
    const patch = { ebayCategory: { categoryId: "183438" }, storeShelf: { mode: "none" }, shippingPolicy: { id: "P1" },
      returnPolicy: { id: "P2" }, paymentPolicy: { id: "P3" }, textAbove: { mode: "own", text: "Above." }, textBelow: { mode: "none" } };
    expect(saveCategorySettingsInputSchema.safeParse(category({ patch,
      clear: { fields: [...CATEGORY_CLEAR_FIELDS].reverse(), products: clearProducts(1) } })).success).toBe(true);
  });

  it.each([
    ["a price, even a reset (plan P34)", category({ patch: { price: null } })],
    ["a price recipe", category({ patch: { price: RECIPE, storeShelf: null } })],
    ["a main text", category({ patch: { mainText: null } })],
    ["no change at all", category({ patch: {} })],
    ["no patch", { idempotencyKey: CATEGORY_KEY, expectedRevisionId: null }],
    ["a 7-character key", category({ idempotencyKey: "abcdefg" })],
    ["no expected revision", { idempotencyKey: CATEGORY_KEY, patch: { storeShelf: null } }],
    ["an unknown top-level key", { ...category(), categoryId: 3 }],
    ["an unknown patch key", category({ patch: { storeShelf: null, shelf: null } })],
    ["an eBay category name", category({ patch: { ebayCategory: { categoryId: "183438", categoryName: "Toploaders" } } })],
    ["a clear of the price", category({ patch: { storeShelf: { mode: "none" } }, clear: { fields: ["price"], products: clearProducts(1) } })],
    ["a clear of the main text", category({ clear: { fields: ["mainText"], products: clearProducts(1) } })],
    ["a clear with no setting", category({ clear: { fields: [], products: clearProducts(1) } })],
    ["a clear naming a setting twice", category({ clear: { fields: ["storeShelf", "storeShelf"], products: clearProducts(1) } })],
    ["a clear with no product", category({ clear: { fields: ["storeShelf"], products: [] } })],
    ["a clear of 10,001 products", category({ clear: { fields: ["storeShelf"], products: clearProducts(10_001) } })],
    ["a clear naming a product twice", category({ clear: { fields: ["storeShelf"], products: [...clearProducts(1), ...clearProducts(1)] } })],
    ["a cleared product without its expected revision", category({ clear: { fields: ["storeShelf"], products: [{ productId: 7 }] } })],
    ["a cleared product with another key", category({ clear: { fields: ["storeShelf"],
      products: [{ productId: 7, expectedRevisionId: null, categoryId: 3 }] } })],
    ["a clear with another key", category({ clear: { fields: ["storeShelf"], products: clearProducts(1), all: true } })],
  ])("refuses %s", (_label, value) => {
    expect(saveCategorySettingsInputSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["absent from the patch", { shippingPolicy: { id: "P1" } }],
    ["reset to the store default in the patch", { storeShelf: null, shippingPolicy: { id: "P1" } }],
  ])("refuses a cleared setting %s, with our words at the cleared field (plan P20)", (_label, patch) => {
    const parsed = saveCategorySettingsInputSchema.safeParse(category({ patch,
      clear: { fields: ["shippingPolicy", "storeShelf"], products: clearProducts(2) } }));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ code: "custom", path: ["clear", "fields", 1],
      message: "Set this on the category to clear it on its products." })]);
  });
});

describe("W12 one category answer", () => {
  const answer = (fields: Record<string, unknown> = {}) =>
    ({ outcome: "changed", categoryId: 3, revisionId: 41, clearedProductCount: 2, ...fields });

  it("accepts a change, an unchanged save that cleared nothing, and a replay with no count", () => {
    expect(saveCategorySettingsResponseSchema.safeParse(answer()).success).toBe(true);
    expect(saveCategorySettingsResponseSchema.safeParse(answer({ clearedProductCount: 0 })).success).toBe(true);
    expect(saveCategorySettingsResponseSchema.safeParse(answer({ outcome: "unchanged", revisionId: null, clearedProductCount: 0 })).success)
      .toBe(true);
    expect(saveCategorySettingsResponseSchema.safeParse(answer({ outcome: "replayed", revisionId: null, clearedProductCount: null })).success)
      .toBe(true);
  });

  it.each([
    ["a replay with a count", answer({ outcome: "replayed" })],
    ["a change with no count", answer({ clearedProductCount: null })],
    ["an unchanged save that cleared", answer({ outcome: "unchanged", clearedProductCount: 1 })],
    ["10,001 cleared products", answer({ clearedProductCount: 10_001 })],
    ["a category id of 0", answer({ categoryId: 0 })],
    ["an unknown key", answer({ requestId: 9 })],
    ["another outcome", answer({ outcome: "acknowledged" })],
  ])("refuses %s", (_label, value) => {
    expect(saveCategorySettingsResponseSchema.safeParse(value).success).toBe(false);
  });
});

describe("W7 price check and apply contracts (plan PR 9, 9.4)", () => {
  const RECIPE = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } as const;
  const REVIEW = "7d1b5e0a-3c4f-4a8b-9e2d-0f1a2b3c4d5e";
  const ids = (count: number, first = 1) => Array.from({ length: count }, (_, index) => first + index);
  const productsReview = (fields: Record<string, unknown> = {}) => ({ kind: "product_prices", productIds: [7, 3], price: RECIPE, ...fields });
  const categoryReview = (fields: Record<string, unknown> = {}) => ({
    kind: "category_price", categoryId: 3, expectedRevisionId: null,
    patch: { price: RECIPE, shippingPolicy: { id: "ship-a" }, storeShelf: { mode: "own", shelfIds: ["11"] } }, ...fields,
  });
  const row = (productVariantId: number, fields: Record<string, unknown> = {}) => ({
    productVariantId, title: "Toploader", sku: null, previousPriceCents: 1_199, priceCents: 1_040, productCostCents: 800,
    ruleName: "Product price", preserved: false, issues: [], settingRevisionId: null, evidenceHash: "e".repeat(64),
    productId: 7, released: false, refusal: null, ...fields,
  });

  it("bounds releases at W8's 200 size prices (plan P24, P38), and pages at 200 of 50 sizes", () => {
    expect(MAX_PRICE_RELEASES_PER_APPLY).toBe(200);
    expect(MAX_PRICE_RELEASES_PER_APPLY).toBe(MAX_SIZE_PRICES_PER_REQUEST);
    expect(MAX_PRICE_CHANGE_REVIEW_PAGE).toBe(200);
  });

  it("names the two W7 review kinds of 0740's CHECK, and clears every category setting, the price included (P25)", () => {
    expect([...PRICE_CHANGE_REVIEW_KINDS]).toEqual(["product_prices", "category_price"]);
    for (const kind of PRICE_CHANGE_REVIEW_KINDS) expect(PRICING_REVIEW_KINDS).toContain(kind);
    expect([...PRICE_CHANGE_CLEAR_FIELDS]).toEqual([...CATEGORY_LISTING_SETTING_FIELDS]);
    expect(PRICE_CHANGE_CLEAR_FIELDS[0]).toBe("price");
  });

  describe("the review input", () => {
    it("takes 10,000 products with a price, releases, or both, and leaves the input as it was", () => {
      const input = Object.freeze(productsReview({ productIds: Object.freeze(ids(10_000)), releaseExactPrices: true }));
      expect(reviewPriceChangesInputSchema.parse(input)).toMatchObject({ kind: "product_prices", releaseExactPrices: true });
      expect(reviewPriceChangesInputSchema.safeParse(productsReview({ price: null })).success).toBe(true);
      const releaseOnly = { kind: "product_prices", productIds: [7], releaseExactPrices: true };
      expect(reviewPriceChangesInputSchema.parse(releaseOnly)).toEqual(releaseOnly);
    });

    it.each([
      ["10,001 products", productsReview({ productIds: ids(10_001) })],
      ["no products", productsReview({ productIds: [] })],
      ["a product twice", productsReview({ productIds: [7, 3, 7] })],
      ["neither a price nor releases", { kind: "product_prices", productIds: [7] }],
      ["releases as false", { kind: "product_prices", productIds: [7], releaseExactPrices: false }],
      ["another setting (W6 saves those, P25)", productsReview({ storeShelf: { mode: "none" } })],
      ["an unknown kind", productsReview({ kind: "store_default" })],
      ["no kind", { productIds: [7], price: RECIPE }],
      ["a product id past int4", productsReview({ productIds: [2_147_483_648] })],
    ])("refuses a products check with %s", (_label, value) => {
      expect(reviewPriceChangesInputSchema.safeParse(value).success).toBe(false);
    });

    it("words its own refusals, so the 400 can say them", () => {
      const neither = reviewPriceChangesInputSchema.safeParse({ kind: "product_prices", productIds: [7, 7] });
      expect(neither.success ? [] : neither.error.issues.map((issue) => [issue.code, issue.message]))
        .toEqual([["custom", "Each product once."], ["custom", "Change the price, release exact prices, or both."]]);
    });

    it("takes a category check with its price (a recipe or Use default) and its clear list, the price clearable (P25)", () => {
      const clear = { fields: ["shippingPolicy", "price"], products: ids(10_000).map((productId) => ({ productId, expectedRevisionId: null })) };
      expect(reviewPriceChangesInputSchema.safeParse(categoryReview({ clear })).success).toBe(true);
      expect(reviewPriceChangesInputSchema.safeParse(categoryReview({ patch: { price: null } })).success).toBe(true);
      // The patch keeps the stored shape's key order whatever the order sent, so equal checks store and hash equal.
      const parsed = reviewPriceChangesInputSchema.parse(categoryReview({ patch: { storeShelf: { mode: "none" }, price: RECIPE } }));
      expect(parsed.kind === "category_price" && Object.keys(parsed.patch)).toEqual(["price", "storeShelf"]);
    });

    it.each([
      ["no price (a change without one is a W12 save, 9.12 #3)", categoryReview({ patch: { shippingPolicy: { id: "ship-a" } } })],
      ["a main text (a category has none)", categoryReview({ patch: { price: RECIPE, mainText: { text: "Words" } } })],
      ["an eBay name sent by the client", categoryReview({ patch: { price: RECIPE, shippingPolicy: { id: "ship-a", name: "Mine" } } })],
      ["a cleared field the category does not set", categoryReview({ clear: { fields: ["returnPolicy"], products: [{ productId: 7, expectedRevisionId: null }] } })],
      ["a cleared price the category resets", categoryReview({ patch: { price: null }, clear: { fields: ["price"], products: [{ productId: 7, expectedRevisionId: null }] } })],
      ["a cleared main text", categoryReview({ clear: { fields: ["mainText"], products: [{ productId: 7, expectedRevisionId: null }] } })],
      ["a field cleared twice", categoryReview({ clear: { fields: ["price", "price"], products: [{ productId: 7, expectedRevisionId: null }] } })],
      ["a product cleared twice", categoryReview({ clear: { fields: ["price"], products: [{ productId: 7, expectedRevisionId: null }, { productId: 7, expectedRevisionId: 3 }] } })],
      ["10,001 cleared products", categoryReview({ clear: { fields: ["price"], products: ids(10_001).map((productId) => ({ productId, expectedRevisionId: null })) } })],
      ["an empty clear list", categoryReview({ clear: { fields: ["price"], products: [] } })],
      ["no expected revision", { ...categoryReview(), expectedRevisionId: undefined }],
      ["releases (the products kind only, 9.12 #1)", categoryReview({ releaseExactPrices: true })],
      ["an unknown key", categoryReview({ note: "x" })],
    ])("refuses a category check with %s", (_label, value) => {
      expect(reviewPriceChangesInputSchema.safeParse(value).success).toBe(false);
    });
  });

  describe("the stored inputs (plan P22, C-money-10)", () => {
    const storedCategory = {
      categoryId: 3, expectedRevisionId: 40,
      patch: { price: RECIPE, shippingPolicy: { id: "ship-a", name: "Ships in one day" },
        ebayCategory: { categoryId: "183454", categoryName: "Toploaders", path: ["Collectibles", "Toploaders"] } },
      clear: { fields: ["price", "shippingPolicy"], products: [{ productId: 3, expectedRevisionId: null }, { productId: 7, expectedRevisionId: 30 }] },
    };

    it("are the route input without the kind, with resolved eBay values, each kind its own schema", () => {
      expect(storedInputSchemaFor("product_prices")).toBe(storedProductPricesInputSchema);
      expect(storedInputSchemaFor("category_price")).toBe(storedCategoryPriceInputSchema);
      expect(storedProductPricesInputSchema.safeParse({ productIds: [3, 7], price: RECIPE }).success).toBe(true);
      expect(storedCategoryPriceInputSchema.safeParse(storedCategory).success).toBe(true);
      // The kind is a column, never a key of the stored input (D6).
      expect(storedProductPricesInputSchema.safeParse({ kind: "product_prices", productIds: [3, 7], price: RECIPE }).success).toBe(false);
      // An id-only eBay value is a route input, not a stored one.
      expect(storedCategoryPriceInputSchema.safeParse({ ...storedCategory, patch: { price: RECIPE, ebayCategory: { categoryId: "183454" } } })
        .success).toBe(false);
    });

    it("rebuild objects in shape order, so a jsonb round trip in any key order serializes byte for byte the same", () => {
      const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]))
          : value;
      const product = { productIds: [3, 7], price: RECIPE, releaseExactPrices: true };
      expect(JSON.stringify(storedProductPricesInputSchema.parse(reorder(product))))
        .toBe(JSON.stringify(storedProductPricesInputSchema.parse(product)));
      expect(JSON.stringify(storedCategoryPriceInputSchema.parse(reorder(storedCategory))))
        .toBe(JSON.stringify(storedCategoryPriceInputSchema.parse(storedCategory)));
      // An absent optional key stays absent: it is not written as undefined or null.
      expect(Object.keys(storedProductPricesInputSchema.parse({ productIds: [3], price: RECIPE }))).toEqual(["productIds", "price"]);
    });

    it.each([
      ["products out of order", storedProductPricesInputSchema, { productIds: [7, 3], price: RECIPE }],
      ["a product twice", storedProductPricesInputSchema, { productIds: [3, 3], price: RECIPE }],
      ["no products", storedProductPricesInputSchema, { productIds: [], price: RECIPE }],
      ["neither a price nor releases", storedProductPricesInputSchema, { productIds: [3] }],
      ["clear fields out of the stored order", storedCategoryPriceInputSchema,
        { ...storedCategory, clear: { ...storedCategory.clear, fields: ["shippingPolicy", "price"] } }],
      ["cleared products out of order", storedCategoryPriceInputSchema,
        { ...storedCategory, clear: { ...storedCategory.clear, products: [...storedCategory.clear.products].reverse() } }],
      ["a cleared setting the category does not set", storedCategoryPriceInputSchema,
        { ...storedCategory, clear: { ...storedCategory.clear, fields: ["price", "returnPolicy"] } }],
      ["no price", storedCategoryPriceInputSchema, { ...storedCategory, patch: { shippingPolicy: storedCategory.patch.shippingPolicy } }],
    ] as const)("refuse %s", (_label, schema, value) => {
      expect(schema.safeParse(value).success).toBe(false);
    });
  });

  describe("the review rows", () => {
    it("are W1's review row with the size's product, its release and its refusal; strict", () => {
      expect(priceChangeRowSchema.safeParse(row(101)).success).toBe(true);
      expect(priceChangeRowSchema.safeParse(row(101, { released: true, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
        followsStorePricing: true, ruleLevel: "product" })).success).toBe(true);
      for (const broken of [
        row(101, { refusal: "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" }), row(101, { productId: undefined }), row(101, { released: undefined }),
        row(101, { refusal: undefined }), row(101, { note: "x" }), row(101, { priceCents: 10.5 }),
      ]) {
        expect(priceChangeRowSchema.safeParse(broken).success).toBe(false);
      }
    });

    it("are at most 10,000, by size ascending, each once", () => {
      expect(priceChangeRowsSchema.safeParse(ids(10_000).map((id) => row(id))).success).toBe(true);
      expect(priceChangeRowsSchema.safeParse([]).success).toBe(true);
      expect(priceChangeRowsSchema.safeParse(ids(10_001).map((id) => row(id))).success).toBe(false);
      expect(priceChangeRowsSchema.safeParse([row(102), row(101)]).success).toBe(false);
      expect(priceChangeRowsSchema.safeParse([row(101), row(101)]).success).toBe(false);
    });
  });

  describe("the review answer and its pages", () => {
    const answer = (fields: Record<string, unknown> = {}) => ({
      reviewId: REVIEW, reviewHash: "b".repeat(64), createdAt: "2026-10-13T09:00:00.000Z", kind: "product_prices",
      summary: { total: 120, changed: 100, released: 20, refused: 1 }, rows: ids(50).map((id) => row(id)), page: 0, ...fields,
    });

    it("answers a page of up to 50 rows with the summary", () => {
      expect(priceChangeReviewResponseSchema.safeParse(answer()).success).toBe(true);
      expect(priceChangeReviewResponseSchema.safeParse(answer({ page: 2, rows: ids(20, 101).map((id) => row(id)) })).success).toBe(true);
      expect(priceChangeReviewResponseSchema.safeParse(answer({ page: 3, rows: [] })).success).toBe(true);
      expect(priceChangeReviewResponseSchema.safeParse(answer({ summary: { total: 0, changed: 0, released: 0, refused: 0 }, rows: [] })).success)
        .toBe(true);
    });

    it.each([
      ["51 rows", { rows: ids(51).map((id) => row(id)) }],
      ["more changed sizes than sizes", { summary: { total: 10, changed: 11, released: 0, refused: 0 }, rows: [] }],
      ["a page past the last size", { page: 2, rows: ids(21, 101).map((id) => row(id)) }],
      ["page 201", { page: 201, rows: [] }],
      ["a review id in upper case", { reviewId: REVIEW.toUpperCase() }],
      ["W1's kind", { kind: "store_default" }],
      ["an unknown key", { note: "x" }],
    ])("refuses %s", (_label, fields) => {
      expect(priceChangeReviewResponseSchema.safeParse(answer(fields)).success).toBe(false);
    });

    it("takes a page's review id and page number within the bound", () => {
      expect(priceChangeReviewPageInputSchema.parse({ reviewId: REVIEW, page: 200 })).toEqual({ reviewId: REVIEW, page: 200 });
      for (const value of [{ reviewId: REVIEW, page: 201 }, { reviewId: REVIEW, page: -1 }, { reviewId: REVIEW, page: 1.5 },
        { reviewId: "review", page: 0 }, { reviewId: REVIEW }]) {
        expect(priceChangeReviewPageInputSchema.safeParse(value).success).toBe(false);
      }
    });
  });

  describe("the apply input and answer", () => {
    const APPLY_KEY = "price-changes:4a2f9c1e-8b7d-4e6f-a5c3-2d1e0f9a8b7c";
    const apply = { reviewId: REVIEW, reviewHash: "b".repeat(64), idempotencyKey: APPLY_KEY };
    const applied = (fields: Record<string, unknown> = {}) => ({
      outcome: "changed", reviewId: REVIEW, requestId: 900, changedProductCount: 2, releasedSizeCount: 200, categoryRevisionId: null, ...fields,
    });

    it("takes the review the vendor saw, its hash and a listing-settings key (P6), strict", () => {
      expect(applyPriceChangesInputSchema.parse(apply)).toEqual(apply);
      for (const value of [
        { ...apply, idempotencyKey: "k".repeat(7) }, { ...apply, idempotencyKey: "a key" }, { ...apply, reviewHash: "B".repeat(64) },
        { ...apply, reviewId: REVIEW.toUpperCase() }, { ...apply, reviewId: "review-1" }, { ...apply, note: "x" },
        { reviewId: REVIEW, reviewHash: apply.reviewHash },
      ]) {
        expect(applyPriceChangesInputSchema.safeParse(value).success).toBe(false);
      }
      expect(applyPriceChangesInputSchema.safeParse({ ...apply, idempotencyKey: "k".repeat(8) }).success).toBe(true);
    });

    it("answers counts except on a replay, nothing counted on an unchanged apply, at most 200 releases", () => {
      expect(applyPriceChangesResponseSchema.safeParse(applied()).success).toBe(true);
      expect(applyPriceChangesResponseSchema.safeParse(applied({ outcome: "replayed", changedProductCount: null, releasedSizeCount: 3,
        categoryRevisionId: 41 })).success).toBe(true);
      expect(applyPriceChangesResponseSchema.safeParse(applied({ outcome: "unchanged", changedProductCount: 0, releasedSizeCount: 0 })).success)
        .toBe(true);
      expect(applyPriceChangesResponseSchema.safeParse(applied({ requestId: Number.MAX_SAFE_INTEGER })).success).toBe(true);
      for (const fields of [
        { changedProductCount: null }, { outcome: "replayed" }, { outcome: "unchanged", changedProductCount: 0, releasedSizeCount: 1 },
        { outcome: "unchanged", changedProductCount: 1, releasedSizeCount: 0 }, { releasedSizeCount: 201 }, { changedProductCount: 10_001 },
        { requestId: 0 }, { categoryRevisionId: 0 }, { note: "x" },
      ]) {
        expect(applyPriceChangesResponseSchema.safeParse(applied(fields)).success).toBe(false);
      }
    });
  });

  describe("the bulk writer's price apply patch (P23, 9.7)", () => {
    it("sets the price, resets anything else, and may be empty", () => {
      for (const patch of [{}, { price: RECIPE }, { price: null }, { price: null, storeShelf: null, shippingPolicy: null, textAbove: null,
        textBelow: null, mainText: null, ebayCategory: null, returnPolicy: null, paymentPolicy: null }]) {
        expect(productListingSettingPriceApplyPatchSchema.safeParse(patch).success).toBe(true);
      }
    });

    it("refuses any other setting with a value, own text included, in our words", () => {
      const refused = productListingSettingPriceApplyPatchSchema.safeParse({
        storeShelf: { mode: "none" }, textAbove: { mode: "own", text: "Words" }, mainText: { text: "Words", catalogHash: "c".repeat(64) },
      });
      expect(refused.success ? [] : refused.error.issues.map((issue) => [issue.path.join("."), issue.message])).toEqual([
        ["storeShelf", "A price change sets only prices; other settings can only be reset."],
        ["textAbove", "A price change sets only prices; other settings can only be reset."],
        ["mainText", "Main text can only be reset for many products."],
      ]);
      expect(productListingSettingPriceApplyPatchSchema.safeParse({ price: RECIPE, note: "x" }).success).toBe(false);
    });
  });
});

describe("W13 \"Got it\" contracts (plan PR 9, 10.3)", () => {
  const MOVES_KEY = "category-moves:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
  const items = (count: number) => Array.from({ length: count }, (_, index) =>
    ({ productId: index + 1, shownCategoryId: index % 2 === 0 ? 3 : null }));
  const input = (fields: Record<string, unknown> = {}) => ({ idempotencyKey: MOVES_KEY, items: items(1), ...fields });
  const answer = (fields: Record<string, unknown> = {}) =>
    ({ outcome: "acknowledged", acknowledgedProductIds: [1, 2], movedAgainProductIds: [3], ...fields });

  it("accepts 1 and 10,000 items, a shown category or none, and keeps the items as sent", () => {
    expect(acknowledgeCategoryMovesInputSchema.parse(input())).toEqual(input());
    const parsed = acknowledgeCategoryMovesInputSchema.parse(input({ items: items(10_000) }));
    expect(parsed.items).toHaveLength(10_000);
    expect(parsed.items.slice(0, 2)).toEqual([{ productId: 1, shownCategoryId: 3 }, { productId: 2, shownCategoryId: null }]);
  });

  it.each([
    ["10,001 items", input({ items: items(10_001) })],
    ["no item", input({ items: [] })],
    ["a product twice", input({ items: [{ productId: 7, shownCategoryId: 3 }, { productId: 7, shownCategoryId: 4 }] })],
    ["a shown category of 0", input({ items: [{ productId: 7, shownCategoryId: 0 }] })],
    ["a product id of 0", input({ items: [{ productId: 0, shownCategoryId: 3 }] })],
    ["a product id past int4", input({ items: [{ productId: 2_147_483_648, shownCategoryId: 3 }] })],
    ["a missing shown category", input({ items: [{ productId: 7 }] })],
    ["an unknown item key", input({ items: [{ productId: 7, shownCategoryId: 3, categoryName: "Sleeves" }] })],
    ["a 7-character key", input({ idempotencyKey: "abcdefg" })],
    ["no key", { items: items(1) }],
    ["an unknown key", input({ storeConnectionId: 22 })],
  ])("refuses an input with %s", (_label, value) => {
    expect(acknowledgeCategoryMovesInputSchema.safeParse(value).success).toBe(false);
  });

  it("accepts an answer with both lists, with empty lists, and a replay with empty lists", () => {
    expect(acknowledgeCategoryMovesResponseSchema.safeParse(answer()).success).toBe(true);
    expect(acknowledgeCategoryMovesResponseSchema.safeParse(answer({ acknowledgedProductIds: [], movedAgainProductIds: [] })).success)
      .toBe(true);
    expect(acknowledgeCategoryMovesResponseSchema.safeParse({ outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] })
      .success).toBe(true);
    const all = Array.from({ length: 10_000 }, (_, index) => index + 1);
    expect(acknowledgeCategoryMovesResponseSchema.safeParse(answer({ acknowledgedProductIds: all, movedAgainProductIds: [] })).success)
      .toBe(true);
  });

  it.each([
    ["a replay naming a product", answer({ outcome: "replayed" })],
    ["a product in both lists", answer({ movedAgainProductIds: [2] })],
    ["a product twice in one list", answer({ acknowledgedProductIds: [1, 1] })],
    ["more than 10,000 products over both lists", answer({ acknowledgedProductIds: Array.from({ length: 10_000 }, (_, index) => index + 1),
      movedAgainProductIds: [10_001] })],
    ["10,001 acknowledged", answer({ acknowledgedProductIds: Array.from({ length: 10_001 }, (_, index) => index + 1), movedAgainProductIds: [] })],
    ["a product id of 0", answer({ acknowledgedProductIds: [0] })],
    ["another outcome", answer({ outcome: "changed" })],
    ["an unknown key", answer({ requestId: 900 })],
  ])("refuses an answer with %s", (_label, value) => {
    expect(acknowledgeCategoryMovesResponseSchema.safeParse(value).success).toBe(false);
  });
});
