import { describe, expect, it } from "vitest";
import {
  LISTING_SETTING_WRITE_ERROR_CODES,
  MAX_EBAY_ID_INPUT_LENGTH,
  MAX_SIZE_PRICES_PER_REQUEST,
  MAX_STORE_LISTING_TEXT_BYTES,
  patchTextBytes,
  productSettingsPatchInputSchema,
  saveProductSettingsInputSchema,
  saveProductSettingsResponseSchema,
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
    expect(MAX_STORE_LISTING_TEXT_BYTES).toBe(30_000_000);
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
