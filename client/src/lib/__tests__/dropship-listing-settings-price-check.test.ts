import { describe, expect, it } from "vitest";
import {
  applyPriceChangesInputSchema,
  priceChangeReviewResponseSchema,
  reviewPriceChangesInputSchema,
  type PriceChangeReviewResponse,
  type PriceChangeRow,
} from "@shared/dropship/listing-setting-writes";
import { RETAIL_FALLBACK_RULE_NAME, type PricingRecipe } from "@shared/dropship/pricing-rules";
import { reduceListingSettingsDraft, productEditorId, type ListingSettingsDraft } from "../dropship-listing-settings-drafts";
import { formatCents, reviewRetailFallbackWords } from "../dropship-listing-settings-price-words";
import {
  productPriceDraftValue,
  type PriceCheckRef,
  type ProductOwnSettings,
  type ProductPriceChange,
} from "../dropship-listing-settings-product-edit";
import { listingSettingsProductOwnSettingsSchema } from "@shared/dropship/listing-settings";
import { CHECK_NEW_PRICES_WORDS, PRICE_DEFAULT_WORDS, reviewBlockedWords, reviewCannotPriceWords, reviewRowNotes } from "../dropship-listing-settings-recipe";
import { LISTING_SETTINGS_EDIT_WORDS, LISTING_SETTINGS_PRICE_CHECK_WORDS, wouldBeLeftWithoutPriceWords } from "../dropship-listing-settings-words";
import { SUGGESTED_PRICING_RECIPE } from "../dropship-pricing-rules";
import {
  changePriceButton,
  checkPriceCheckPage,
  decideAfterApplyRefusal,
  hasNextPriceCheckPage,
  hasPreviousPriceCheckPage,
  isPriceCheckPage,
  MAX_PRICE_CHECK_PAGE,
  pendingPriceWords,
  PRICE_CHECK_PAGE_SIZE,
  PRICE_CHECK_REQUEST_INVALID,
  PriceCheckRequestError,
  priceCheckAfterOf,
  priceCheckAfterWords,
  priceCheckApplyBody,
  priceCheckApplySignature,
  priceCheckBack,
  priceCheckBuiltFrom,
  priceCheckChangeWords,
  priceCheckCountsWords,
  priceCheckFooter,
  priceCheckPageWords,
  priceCheckRefOf,
  priceCheckRow,
  priceCheckShown,
  PRODUCT_PRICE_EDITOR_WORDS,
  productPriceEditorModel,
  productPriceEditorResult,
  productPricesReviewBody,
  refusedSizesOf,
  type ApplyRefusalDecision,
  type PriceCheckFooterInput,
} from "../dropship-listing-settings-price-check";

/** The price check for one or many products (W7 `product_prices`; plan PR 10d, 7.2-7.6, 7.7). */

const STORE = 22;
const PRODUCT = 11;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const RETAIL_20_UP: PricingRecipe = { basis: "catalog_retail", markupBps: 2000, flatCents: 0, rounding: "up_99" };
const COST_35: PricingRecipe = { basis: "product_cost", markupBps: 3500, flatCents: 0, rounding: "cent" };
const WORDS = LISTING_SETTINGS_PRICE_CHECK_WORDS;
const CHECK: PriceCheckRef = { reviewId: REVIEW_ID, reviewHash: HASH_A, after: null };
const SET: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = { price: { mode: "set", value: RETAIL_20_UP }, releaseExactPrices: false };
const DEFAULT: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = { price: { mode: "default" }, releaseExactPrices: false };
const RELEASE: Pick<ProductPriceChange, "price" | "releaseExactPrices"> = { price: { mode: "leave" }, releaseExactPrices: true };

/** A W7 row: W1's review row with the product, the release and the refusal; prices in odd cents, never round numbers. */
function row(overrides: Partial<PriceChangeRow> = {}): PriceChangeRow {
  return {
    productVariantId: 101,
    productId: PRODUCT,
    title: "Easy Glide Soft Sleeves",
    sku: "EG-SLV-STD-5PCK-B500",
    previousPriceCents: 1499,
    priceCents: 1733,
    productCostCents: 981,
    ruleName: "Store default rule",
    preserved: false,
    issues: [],
    settingRevisionId: null,
    evidenceHash: HASH_A,
    sizeName: "Box of 5 Packs of 100",
    basis: "catalog_retail",
    basisCents: 1251,
    warnings: [],
    released: false,
    refusal: null,
    ...overrides,
  };
}

function review(overrides: Partial<PriceChangeReviewResponse> = {}): PriceChangeReviewResponse {
  return priceChangeReviewResponseSchema.parse({
    reviewId: REVIEW_ID,
    reviewHash: HASH_A,
    createdAt: "2026-10-14T12:00:00.000Z",
    kind: "product_prices",
    summary: { total: 1, changed: 1, released: 0, refused: 0 },
    rows: [row()],
    page: 0,
    ...overrides,
  });
}

const OWN: ProductOwnSettings = listingSettingsProductOwnSettingsSchema.parse({
  storeConnectionId: STORE, productId: PRODUCT, revisionId: 5,
  own: { price: null, ebayCategory: null, storeShelf: null, shippingPolicy: null, returnPolicy: null, paymentPolicy: null, textAbove: null, textBelow: null, mainText: null },
  generatedAt: "2026-10-14T12:00:00.000Z",
});
const EDITOR = productEditorId(PRODUCT);

function priceDraft(change: ProductPriceChange): ListingSettingsDraft {
  const opened = reduceListingSettingsDraft(null, { type: "open", editor: EDITOR, place: "Easy Glide Soft Sleeves", base: productPriceDraftValue(OWN) });
  return reduceListingSettingsDraft(opened, { type: "edit", value: productPriceDraftValue(OWN, change) })!;
}

const caught = (work: () => unknown): unknown => {
  try { work(); } catch (error) { return error; }
  return null;
};

// ---------------------------------------------------------------------------
// The review body (plan 7.3, D1)
// ---------------------------------------------------------------------------

describe("the review body (plan 7.3, D1)", () => {
  it("sends the price as the vendor chose it: absent to leave, null for Use default, the recipe as parsed; the release only as true", () => {
    expect(productPricesReviewBody({ productIds: [PRODUCT], price: { mode: "leave" }, releaseExactPrices: true }))
      .toEqual({ kind: "product_prices", productIds: [PRODUCT], releaseExactPrices: true });
    expect(productPricesReviewBody({ productIds: [12, 11], price: { mode: "default" }, releaseExactPrices: false }))
      .toEqual({ kind: "product_prices", productIds: [12, 11], price: null });
    const body = productPricesReviewBody({ productIds: [PRODUCT], price: { mode: "set", value: COST_35 }, releaseExactPrices: true });
    expect(body).toEqual({ kind: "product_prices", productIds: [PRODUCT], price: COST_35, releaseExactPrices: true });
    for (const sent of [body, productPricesReviewBody({ productIds: [PRODUCT], price: { mode: "leave" }, releaseExactPrices: true })]) {
      expect(reviewPriceChangesInputSchema.parse(sent)).toEqual(sent);
      expect(Object.keys(sent)).not.toContain("expectedRevisionId");
      expect(sent).not.toHaveProperty("releaseExactPrices", false);
    }
    // Never a `releaseExactPrices: false` key, never a product twice, never shared ids.
    expect("releaseExactPrices" in productPricesReviewBody({ productIds: [PRODUCT], price: { mode: "default" }, releaseExactPrices: false })).toBe(false);
    const ids = [3, 1, 2];
    const built = productPricesReviewBody({ productIds: ids, price: { mode: "default" }, releaseExactPrices: false });
    expect(built.productIds).not.toBe(ids);
    expect(built.productIds).toEqual([3, 1, 2]);
  });

  it("refuses a body the server would refuse, with a namespaced code, and never computes a price", () => {
    const bad = [
      { productIds: [PRODUCT], price: { mode: "leave" as const }, releaseExactPrices: false },
      { productIds: [PRODUCT, PRODUCT], price: { mode: "default" as const }, releaseExactPrices: false },
      { productIds: [], price: { mode: "default" as const }, releaseExactPrices: false },
      { productIds: Array.from({ length: 10_001 }, (_, index) => index + 1), price: { mode: "default" as const }, releaseExactPrices: false },
      { productIds: [0], price: { mode: "default" as const }, releaseExactPrices: false },
      { productIds: [PRODUCT], price: { mode: "set" as const, value: { ...COST_35, markupBps: 1.5 } }, releaseExactPrices: false },
      { productIds: [PRODUCT], price: { mode: "set" as const, value: { ...COST_35, flatCents: -1 } }, releaseExactPrices: false },
    ];
    for (const input of bad) {
      const error = caught(() => productPricesReviewBody(input));
      expect(error).toBeInstanceOf(PriceCheckRequestError);
      expect((error as PriceCheckRequestError).code).toBe(PRICE_CHECK_REQUEST_INVALID);
      expect((error as PriceCheckRequestError).message).toMatch(/Reload the page/);
    }
    // 10,000 products fit (the contract's bound), and the body carries no price cents of the client's.
    const most = productPricesReviewBody({ productIds: Array.from({ length: 10_000 }, (_, index) => index + 1), price: { mode: "default" }, releaseExactPrices: false });
    expect(most.productIds).toHaveLength(10_000);
    expect(JSON.stringify(most)).not.toMatch(/Cents/);
  });
});

// ---------------------------------------------------------------------------
// The apply's signature, key and body (D5)
// ---------------------------------------------------------------------------

describe("the apply request (D5)", () => {
  it("signs the review it saves and builds the body with the key, checked by the apply's schema", () => {
    expect(priceCheckRefOf(review())).toEqual({ reviewId: REVIEW_ID, reviewHash: HASH_A, after: null });
    expect(priceCheckRefOf(review(), "prices_moved").after).toBe("prices_moved");
    const signature = priceCheckApplySignature(CHECK);
    expect(signature).toBe(JSON.stringify({ reviewId: REVIEW_ID, reviewHash: HASH_A }));
    const expired: PriceCheckRef = { ...CHECK, after: "expired" };
    expect(priceCheckApplySignature(expired)).toBe(signature);
    expect(priceCheckApplySignature({ reviewId: REVIEW_ID, reviewHash: HASH_B })).not.toBe(signature);
    const body = priceCheckApplyBody(signature, "ls-price-check:abc");
    expect(body).toEqual({ reviewId: REVIEW_ID, reviewHash: HASH_A, idempotencyKey: "ls-price-check:abc" });
    expect(applyPriceChangesInputSchema.parse(body)).toEqual(body);
  });

  it("refuses a signature it can't rebuild, with a namespaced code", () => {
    for (const signature of ["not json", "[]", JSON.stringify({ reviewId: "x", reviewHash: HASH_A }), JSON.stringify({ reviewId: "1A111111-1111-4111-8111-111111111111", reviewHash: HASH_A })]) {
      const error = caught(() => priceCheckApplyBody(signature, "ls-price-check:1"));
      expect(error).toBeInstanceOf(PriceCheckRequestError);
      expect((error as PriceCheckRequestError).code).toBe(PRICE_CHECK_REQUEST_INVALID);
    }
    expect(() => priceCheckApplyBody(priceCheckApplySignature(CHECK), "has space")).toThrow(PriceCheckRequestError);
  });
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

describe("pages (plan 7.3)", () => {
  it("takes the contract's pages, 50 rows each, 0 to 200", () => {
    expect(PRICE_CHECK_PAGE_SIZE).toBe(50);
    expect(MAX_PRICE_CHECK_PAGE).toBe(200);
    for (const page of [0, 1, 200]) expect(isPriceCheckPage(page)).toBe(true);
    for (const page of [-1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(isPriceCheckPage(page)).toBe(false);
  });

  it("accepts a page of the very review shown and refuses any other, with the page words", () => {
    expect(checkPriceCheckPage(CHECK, review({ page: 1, summary: { total: 60, changed: 60, released: 0, refused: 0 }, rows: [row()] })).page).toBe(1);
    for (const other of [
      review({ reviewId: OTHER_REVIEW_ID }), review({ reviewHash: HASH_B }), { ...review(), extra: true }, { nope: true }, null,
    ]) {
      const error = caught(() => checkPriceCheckPage(CHECK, other));
      expect(error).toBeInstanceOf(PriceCheckRequestError);
      expect((error as PriceCheckRequestError).message).toBe(CHECK_NEW_PRICES_WORDS.pageFailed);
    }
    // A category check's page is not this check's.
    expect(() => checkPriceCheckPage(CHECK, review(), "category_price")).toThrow(CHECK_NEW_PRICES_WORDS.pageFailed);
  });

  it("words the pages as W1 does", () => {
    const summary = { total: 1240, changed: 10, released: 0, refused: 0 };
    expect(priceCheckPageWords({ page: 0, summary })).toBe("1–50 of 1,240");
    expect(priceCheckPageWords({ page: 24, summary })).toBe("1,201–1,240 of 1,240");
    expect(priceCheckPageWords({ page: 0, summary: { ...summary, total: 0 } })).toBeNull();
    expect(hasPreviousPriceCheckPage({ page: 0 })).toBe(false);
    expect(hasPreviousPriceCheckPage({ page: 1 })).toBe(true);
    expect(hasNextPriceCheckPage({ page: 0, summary })).toBe(true);
    expect(hasNextPriceCheckPage({ page: 24, summary })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rows (plan 7.4)
// ---------------------------------------------------------------------------

describe("rows (plan 7.4)", () => {
  it("says what a price is built from by the row's level, then its name (CC-C22)", () => {
    expect(priceCheckBuiltFrom(row({ ruleLevel: "product", ruleName: "Easy Glide Soft Sleeves" }))).toBe("This product's price, from retail $12.51");
    expect(priceCheckBuiltFrom(row({ ruleLevel: "category", ruleName: "Sleeves", basis: "product_cost", basisCents: 981 }))).toBe("Category price, from your cost $9.81");
    expect(priceCheckBuiltFrom(row({ ruleLevel: "product", ruleName: "Store default rule" }))).toBe("This product's price, from retail $12.51");
    expect(priceCheckBuiltFrom(row())).toBe("Store default, from retail $12.51");
    expect(priceCheckBuiltFrom(row({ ruleName: null }))).toBe("Store default, from retail $12.51");
    expect(priceCheckBuiltFrom(row({ ruleName: "Envelopes", basisCents: 625 }))).toBe("Older group rule “Envelopes”, from retail $6.25");
    // A group rule that happens to be named like a level, with no level, is still an older group rule.
    expect(priceCheckBuiltFrom(row({ ruleName: "Product price" }))).toBe("Older group rule “Product price”, from retail $12.51");
    expect(priceCheckBuiltFrom(row({ ruleName: "Category price", basis: null, basisCents: null }))).toBe("Older group rule “Category price”");
    expect(priceCheckBuiltFrom(row({ ruleLevel: "category", ruleName: "Sleeves", basisCents: null }))).toBe("Category price, from retail");
    expect(priceCheckBuiltFrom(row({ preserved: true, ruleName: "Fixed override preserved", priceCents: 1499, basis: null, basisCents: null }))).toBe("Exact price kept");
    expect(priceCheckBuiltFrom(row({ ruleName: RETAIL_FALLBACK_RULE_NAME, followsStorePricing: true, priceCents: 899 }))).toBe("Retail price (no price set)");
    expect(priceCheckBuiltFrom(row({ ruleName: RETAIL_FALLBACK_RULE_NAME, followsStorePricing: true, retailFallbackIssue: "pricing_rule_outside_limit", priceCents: 899 })))
      .toBe(reviewRetailFallbackWords("pricing_rule_outside_limit", 899));
    expect(priceCheckBuiltFrom(row({ ruleName: RETAIL_FALLBACK_RULE_NAME, followsStorePricing: true, retailFallbackIssue: "pricing_rule_outside_limit", priceCents: 899 })))
      .toMatch(/retail price \(\$8\.99\)/);
    const cannot = row({ priceCents: null, ruleName: null, issues: ["pricing_basis_unavailable", "vendor_retail_price_required"], basis: "product_cost" });
    expect(priceCheckBuiltFrom(cannot)).toBe(reviewCannotPriceWords(cannot));
    expect(priceCheckBuiltFrom(cannot)).toBe("Can't price: your cost isn't on file. Contact support.");
  });

  it("draws a row with the server's cents exactly as given, never rounded, and W1's notes", () => {
    const drawn = priceCheckRow(row());
    expect(drawn).toEqual({
      productVariantId: 101, productId: PRODUCT, title: "Easy Glide Soft Sleeves", size: "Box of 5 Packs of 100 · EG-SLV-STD-5PCK-B500",
      builtFrom: "Store default, from retail $12.51", now: "$14.99", next: "$17.33", notes: [], refused: false, released: false,
    });
    // The largest price, as `formatCents` writes it: the cents as given, never rounded or grouped differently from W1's columns.
    expect(priceCheckRow(row({ previousPriceCents: 1, priceCents: 2_147_483_647 }))).toMatchObject({ now: "$0.01", next: formatCents(2_147_483_647) });
    expect(formatCents(2_147_483_647)).toMatch(/^\$21,?474,?836\.47$/);
    expect(priceCheckRow(row({ previousPriceCents: null, priceCents: 1730 }))).toMatchObject({ now: "—", next: "$17.30" });
    expect(priceCheckRow(row({ priceCents: 1733 })).next).toBe(formatCents(1733));
    expect(priceCheckRow(row({ productCostCents: 2310, priceCents: 2199, warnings: ["price_below_product_cost"] })).notes)
      .toEqual([{ kind: "below_cost", text: "! Below your cost ($23.10)" }]);
    expect(priceCheckRow(row({ issues: ["pricing:below_floor:policy_3"] })).notes).toEqual([{ kind: "outside_limit", text: "Outside a Card Shellz price limit" }]);
  });

  it("notes a refusal once as a lost price, and a release as a cleared exact price (7.4)", () => {
    const refused = row({ refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", priceCents: null, issues: ["pricing_basis_unavailable"] });
    expect(priceCheckRow(refused)).toMatchObject({ refused: true, next: "—", notes: [{ kind: "loses_price", text: "● Loses its price" }] });
    // W1's own note for the same row is not doubled.
    expect(reviewRowNotes(refused)).toEqual([{ kind: "loses_price", text: "● Loses its price" }]);
    // A refusal the apply named (422 WOULD_BE_LOST `sizes`) marks the row too, even one the check thought fine.
    expect(priceCheckRow(row(), new Set([101]))).toMatchObject({ refused: true, notes: [{ kind: "loses_price", text: "● Loses its price" }] });
    expect(priceCheckRow(row(), new Set([102])).refused).toBe(false);
    const released = row({ released: true, previousPriceCents: 1499, preserved: false });
    expect(priceCheckRow(released)).toMatchObject({ released: true, notes: [{ kind: "released", text: "Exact price cleared" }] });
    expect(priceCheckRow(row({ released: true, refusal: "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", priceCents: null, issues: ["pricing_basis_unavailable"] })).notes.map((note) => note.kind))
      .toEqual(["loses_price", "released"]);
    // Never a raw code in the words.
    for (const drawn of [priceCheckRow(refused), priceCheckRow(released), priceCheckRow(row({ warnings: ["price_below_product_cost", "pricing:above_ceiling:policy_4"] }))]) {
      expect(JSON.stringify([drawn.builtFrom, drawn.now, drawn.next, drawn.notes.map((note) => note.text)])).not.toMatch(/DROPSHIP_|[a-z]+_[a-z_]+|policy_\d/);
    }
  });

  it("reads the sizes a refusal names from its context, ignoring anything else", () => {
    expect(refusedSizesOf({ sizes: [{ productVariantId: 101 }, { productVariantId: 102, beforePriceCents: 1 }, { productVariantId: "x" }, null, 7], sizeCount: 3 }))
      .toEqual(new Set([101, 102]));
    expect(refusedSizesOf({ sizes: "none" })).toEqual(new Set());
    expect(refusedSizesOf({})).toEqual(new Set());
    expect(refusedSizesOf(null)).toEqual(new Set());
    expect(refusedSizesOf(undefined)).toEqual(new Set());
  });
});

// ---------------------------------------------------------------------------
// Counts, the change, the stale line (plan 7.4, 7.5)
// ---------------------------------------------------------------------------

describe("counts and lines (plan 7.4, 7.5)", () => {
  it("counts the sizes, the changes, the cleared exact prices and the lost prices, leaving out zeros", () => {
    expect(priceCheckCountsWords({ total: 1240, changed: 1180, released: 36, refused: 3 })).toBe("1,240 sizes · 1,180 change · 36 lose their exact price · 3 would lose their price");
    expect(priceCheckCountsWords({ total: 1, changed: 1, released: 1, refused: 1 })).toBe("1 size · 1 change · 1 loses its exact price · 1 would lose its price");
    expect(priceCheckCountsWords({ total: 4, changed: 0, released: 0, refused: 0 })).toBe("4 sizes · no price changes");
    expect(priceCheckCountsWords({ total: 0, changed: 0, released: 0, refused: 0 })).toBe("0 sizes · no price changes");
  });

  it("says what is being checked, and the price's pending line", () => {
    expect(priceCheckChangeWords(SET)).toEqual(["Retail price + 20%, round up to .99"]);
    expect(priceCheckChangeWords({ ...SET, releaseExactPrices: true })).toEqual(["Retail price + 20%, round up to .99", "Clear exact prices too"]);
    expect(priceCheckChangeWords(DEFAULT)).toEqual([LISTING_SETTINGS_EDIT_WORDS.useDefault]);
    expect(priceCheckChangeWords(RELEASE)).toEqual(["Clear exact prices too"]);
    expect(priceCheckChangeWords({ price: { mode: "leave" }, releaseExactPrices: false })).toEqual([]);
    expect(pendingPriceWords({ ...SET, releaseExactPrices: true })).toBe("→ Retail price + 20%, round up to .99 · Clear exact prices too · Not saved");
    expect(pendingPriceWords(DEFAULT)).toBe("→ Use default · Not saved");
    expect(pendingPriceWords({ price: { mode: "leave" }, releaseExactPrices: false })).toBeNull();
  });

  it("says once why a new check replaced the one before it", () => {
    expect(priceCheckAfterWords(null)).toBeNull();
    expect(priceCheckAfterWords("prices_moved")).toBe("Prices changed while you were checking. Here's the new check.");
    expect(priceCheckAfterWords("already_applied")).toBe(WORDS.alreadySaved);
    expect(priceCheckAfterWords("expired")).toBe(WORDS.expired);
    // A page read's 404 says the same; the tag differs so the apply runner still gives the check its one re-check.
    expect(priceCheckAfterWords("page_expired")).toBe(WORDS.expired);
    expect(priceCheckAfterOf("DROPSHIP_IDEMPOTENCY_CONFLICT")).toBe("already_applied");
    expect(priceCheckAfterOf("DROPSHIP_PRICING_REVIEW_NOT_FOUND")).toBe("expired");
    expect(priceCheckAfterOf("DROPSHIP_LISTING_PRICES_MOVED")).toBe("prices_moved");
    expect(priceCheckAfterOf("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT")).toBe("prices_moved");
    expect(priceCheckAfterOf(null)).toBe("prices_moved");
  });
});

// ---------------------------------------------------------------------------
// The footer (plan 7.4, 7.6, UX-M2)
// ---------------------------------------------------------------------------

describe("the footer (plan 7.4, UX-M2)", () => {
  const footer = (overrides: Partial<PriceCheckFooterInput>) => priceCheckFooter({
    phase: null, summary: { total: 12, changed: 10, released: 2, refused: 0 }, change: SET, busy: false, paging: false, ...overrides,
  });

  it("turns Save off while sizes would lose their price, naming the other start with a recipe, else the exact price route, and the one-draft line", () => {
    const refused = footer({ summary: { total: 12, changed: 10, released: 0, refused: 3 } });
    expect(refused.primary).toEqual({ label: "Save new prices", action: "save", disabled: true });
    expect(refused.lines).toEqual([
      { text: reviewBlockedWords(3, "catalog_retail"), tone: "alert" },
      { text: WORDS.oneDraft, tone: "status" },
    ]);
    expect(footer({ summary: { total: 12, changed: 10, released: 0, refused: 3 }, change: { price: { mode: "set", value: COST_35 }, releaseExactPrices: false } }).lines[0].text)
      .toBe("● 3 sizes can't be priced this way. Give them an exact price in Products, or start from Retail price.");
    for (const change of [DEFAULT, RELEASE]) {
      expect(footer({ summary: { total: 12, changed: 10, released: 0, refused: 1 }, change })).toMatchObject({
        primary: { disabled: true },
        lines: [{ text: wouldBeLeftWithoutPriceWords(1), tone: "alert" }, { text: WORDS.oneDraft, tone: "status" }],
      });
    }
    expect(refused.backDisabled).toBe(false);
  });

  it("keeps Save on when a price is sent with no rows or no changes, and off for a release with nothing to clear (P35, 7.4)", () => {
    const none = { total: 0, changed: 0, released: 0, refused: 0 };
    expect(footer({ summary: none })).toMatchObject({ primary: { disabled: false }, lines: [{ text: WORDS.noSizes, tone: "status" }] });
    expect(footer({ summary: none, change: DEFAULT })).toMatchObject({ primary: { disabled: false }, lines: [{ text: WORDS.noSizes, tone: "status" }] });
    expect(footer({ summary: none, change: RELEASE })).toMatchObject({ primary: { disabled: true }, lines: [{ text: WORDS.noSizes, tone: "status" }] });
    expect(footer({ summary: { total: 12, changed: 0, released: 0, refused: 0 } })).toMatchObject({ primary: { disabled: false }, lines: [{ text: WORDS.noPriceChanges, tone: "status" }] });
    expect(footer({ summary: { total: 12, changed: 0, released: 0, refused: 0 }, change: DEFAULT })).toMatchObject({ primary: { disabled: false }, lines: [{ text: WORDS.noPriceChanges, tone: "status" }] });
    expect(footer({ summary: { total: 12, changed: 0, released: 0, refused: 0 }, change: RELEASE })).toMatchObject({ primary: { disabled: true }, lines: [{ text: WORDS.nothingToClear, tone: "status" }] });
    expect(footer({ summary: { total: 12, changed: 2, released: 2, refused: 0 }, change: RELEASE })).toMatchObject({ primary: { disabled: false }, lines: [] });
    expect(footer({})).toEqual({ primary: { label: "Save new prices", action: "save", disabled: false }, backDisabled: false, lines: [] });
  });

  it("follows the owner's draft phase: Saving…, Check again, the failed apply's words, busy and paging (W1's footer)", () => {
    expect(footer({ phase: "saving" })).toEqual({ primary: { label: "Saving…", action: "none", disabled: true }, backDisabled: true, lines: [] });
    // Back is off while saving only: while unconfirmed it closes the owner and keeps the locked draft (plan 7.6, D21).
    expect(footer({ phase: "uncertain", message: "We couldn't confirm your save." }))
      .toEqual({ primary: { label: "Check again", action: "resend", disabled: false }, backDisabled: false, lines: [{ text: "We couldn't confirm your save.", tone: "alert" }] });
    expect(footer({ phase: "uncertain", busy: true }).primary.disabled).toBe(true);
    expect(footer({ phase: "refused", message: "Refused words." }).lines).toEqual([{ text: "Refused words.", tone: "alert" }]);
    expect(footer({ phase: "refused", message: "Refused words.", summary: { total: 12, changed: 10, released: 0, refused: 2 } }).lines.map((line) => line.tone)).toEqual(["alert", "status", "alert"]);
    expect(footer({ phase: "editing", message: "Here's what's saved now." }).lines).toEqual([]);
    expect(footer({ phase: "refused", message: null }).lines).toEqual([]);
    expect(footer({ busy: true }).primary.disabled).toBe(true);
    expect(footer({ paging: true }).primary.disabled).toBe(true);
  });

  it("waits for the rows of a reopened check before Save, but Check again needs only the draft's reference (D21)", () => {
    expect(footer({ summary: null })).toEqual({ primary: { label: "Save new prices", action: "save", disabled: true }, backDisabled: false, lines: [] });
    expect(footer({ summary: null, change: DEFAULT }).primary.disabled).toBe(true);
    // Unconfirmed, rows not read (or their read failed): Check again on, Back on; another listing action still holds it.
    expect(footer({ summary: null, phase: "uncertain", message: "We couldn't confirm your save." }))
      .toEqual({ primary: { label: "Check again", action: "resend", disabled: false }, backDisabled: false, lines: [{ text: "We couldn't confirm your save.", tone: "alert" }] });
    expect(footer({ summary: null, phase: "uncertain", busy: true }).primary.disabled).toBe(true);
    expect(footer({ summary: null, phase: "saving" }).primary).toEqual({ label: "Saving…", action: "none", disabled: true });
  });

  it("keeps Save off after a refused apply, whatever the code, since the same check would be refused again; a sign-in alone can save again (plan 7.5, CLAUDE.md §6)", () => {
    const refusedCodes = [
      "DROPSHIP_LISTING_PRICES_MOVED", "DROPSHIP_PRICING_REVIEW_NOT_FOUND", "DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST",
      "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", "DROPSHIP_REQUEST_TOO_LARGE",
      "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED",
      "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", PRICE_CHECK_REQUEST_INVALID, "DROPSHIP_SOMETHING_NEW", null,
    ];
    for (const code of refusedCodes) {
      expect(footer({ phase: "refused", message: "Refused words.", code }), code ?? "no code").toEqual({
        primary: { label: "Save new prices", action: "save", disabled: true }, backDisabled: false, lines: [{ text: "Refused words.", tone: "alert" }],
      });
    }
    expect(footer({ phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.signedOut, code: "DROPSHIP_AUTH_REQUIRED" }).primary)
      .toEqual({ label: "Save new prices", action: "save", disabled: false });
    // Other failed phases keep Save as the counts decide it: a 429 or busy answer can be sent again.
    for (const phase of ["rate_limited", "unreachable", "blocked"] as const) {
      expect(footer({ phase, message: "Words.", code: "DROPSHIP_LISTING_SETTINGS_BUSY" }).primary.disabled, phase).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// After a refused apply (plan 7.5, 9.4; CC-C3)
// ---------------------------------------------------------------------------

describe("decideAfterApplyRefusal (plan 7.5, CC-C3)", () => {
  type Row = readonly [kind: "product_prices" | "category_price", code: string | null, context: Record<string, unknown> | null, decision: ApplyRefusalDecision];
  const ROWS: readonly Row[] = [
    ["product_prices", "DROPSHIP_LISTING_PRICES_MOVED", { sizes: [] }, "recheck"],
    ["product_prices", "DROPSHIP_IDEMPOTENCY_CONFLICT", { reviewId: REVIEW_ID }, "recheck"],
    ["product_prices", "DROPSHIP_PRICING_REVIEW_NOT_FOUND", { reviewId: REVIEW_ID }, "recheck"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", { productVariantId: 101 }, "recheck"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", { productVariantId: 101 }, "recheck"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", { productVariantId: 101 }, "recheck"],
    // The sizes the check named (`sizeCount`): shown; a release's W9 refusal of one size names no count: a new check.
    ["product_prices", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizes: [{ productVariantId: 101 }], sizeCount: 1 }, "refused"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { productVariantId: 101 }, "recheck"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 0 }, "recheck"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", null, "recheck"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", { releaseCount: 236, maxReleases: 200 }, "refused"],
    ["product_prices", "DROPSHIP_LISTING_SETTINGS_TOO_LARGE", null, "refused"],
    ["product_prices", "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", { reason: "price_check_rows" }, "refused"],
    ["product_prices", "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE", null, "refused"],
    // The three fatal 500s (3.3 row 8, D7c): final, never a re-check.
    ["product_prices", "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", null, "refused"],
    ["product_prices", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", null, "refused"],
    ["product_prices", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", null, "refused"],
    ["product_prices", "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", null, "refused"],
    ["product_prices", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED", null, "refused"],
    // The category kind's version conflicts are a conflict only for the category kind (9.4, PR 10f).
    ["product_prices", "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", null, "refused"],
    ["product_prices", "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 2 }, "refused"],
    ["category_price", "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", null, "conflict"],
    ["category_price", "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT", { conflictCount: 2 }, "conflict"],
    ["category_price", "DROPSHIP_LISTING_PRICES_MOVED", null, "recheck"],
    ["category_price", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", { sizeCount: 2 }, "refused"],
    ["product_prices", null, null, "refused"],
    ["product_prices", "DROPSHIP_SOMETHING_NEW", null, "refused"],
  ];

  it.each(ROWS.map((entry) => [entry[0], entry[1] ?? "no code", entry] as const))("%s %s", (_kind, _code, entry) => {
    const [kind, code, context, decision] = entry;
    expect(decideAfterApplyRefusal(kind, code, context)).toBe(decision);
  });

  it("defaults to a product check with no context", () => {
    expect(decideAfterApplyRefusal("product_prices", "DROPSHIP_LISTING_PRICES_MOVED")).toBe("recheck");
    expect(decideAfterApplyRefusal("product_prices", "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST")).toBe("recheck");
  });
});

// ---------------------------------------------------------------------------
// The price editor (plan 7.2)
// ---------------------------------------------------------------------------

describe("the price editor (plan 7.2, D1)", () => {
  const rights = { canSet: true, canDefault: true, reason: null };

  it("opens on the draft's change, else the product's own price, else Use default over the store price or the suggestion", () => {
    expect(productPriceEditorModel({ rights, change: SET, ownPrice: null, storeRecipe: COST_35 })).toEqual({
      canSet: true, canDefault: true, reason: null, suggestion: false,
      initial: { mode: "set", fields: { basis: "catalog_retail", percent: "20", flat: "0.00", rounding: "up_99" }, releaseExactPrices: false },
    });
    expect(productPriceEditorModel({ rights, change: { ...DEFAULT, releaseExactPrices: true }, ownPrice: RETAIL_20_UP, storeRecipe: COST_35 })).toMatchObject({
      suggestion: true, initial: { mode: "default", fields: { basis: "product_cost", percent: "35", flat: "0.00", rounding: "cent" }, releaseExactPrices: true },
    });
    expect(productPriceEditorModel({ rights, change: { price: { mode: "leave" }, releaseExactPrices: false }, ownPrice: RETAIL_20_UP, storeRecipe: COST_35 })).toMatchObject({
      suggestion: false, initial: { mode: "set", fields: { basis: "catalog_retail", percent: "20" } },
    });
    expect(productPriceEditorModel({ rights, change: { price: { mode: "leave" }, releaseExactPrices: false }, ownPrice: null, storeRecipe: COST_35 })).toMatchObject({
      suggestion: true, initial: { mode: "default", fields: { basis: "product_cost", percent: "35" } },
    });
    expect(productPriceEditorModel({ rights, change: { price: { mode: "leave" }, releaseExactPrices: false }, ownPrice: null, storeRecipe: null })).toMatchObject({
      suggestion: true, initial: { mode: "default", fields: { basis: SUGGESTED_PRICING_RECIPE.basis, percent: "0", flat: "0.00", rounding: SUGGESTED_PRICING_RECIPE.rounding } },
    });
    expect(productPriceEditorModel({ rights: { canSet: false, canDefault: false, reason: "banner" }, change: SET, ownPrice: null, storeRecipe: null }))
      .toMatchObject({ canSet: false, canDefault: false, reason: "banner" });
  });

  it("parses the fields with the integer parsers, every error at once, and never computes a price (D1)", () => {
    const model = { canSet: true, canDefault: true };
    expect(productPriceEditorResult(model, { mode: "set", fields: { basis: "product_cost", percent: "12.5", flat: "1.50", rounding: "cent" }, releaseExactPrices: true }))
      .toEqual({ ok: true, change: { price: { mode: "set", value: { basis: "product_cost", markupBps: 1250, flatCents: 150, rounding: "cent" } }, releaseExactPrices: true } });
    expect(productPriceEditorResult(model, { mode: "set", fields: { basis: "catalog_retail", percent: "0.01", flat: "0.1", rounding: "up_99" }, releaseExactPrices: false }))
      .toEqual({ ok: true, change: { price: { mode: "set", value: { basis: "catalog_retail", markupBps: 1, flatCents: 10, rounding: "up_99" } }, releaseExactPrices: false } });
    expect(productPriceEditorResult(model, { mode: "set", fields: { basis: "catalog_retail", percent: "20", flat: "", rounding: "up_99" }, releaseExactPrices: false }))
      .toEqual({ ok: true, change: { price: { mode: "set", value: RETAIL_20_UP }, releaseExactPrices: false } });
    expect(productPriceEditorResult(model, { mode: "default", fields: { basis: "catalog_retail", percent: "x", flat: "y", rounding: "up_99" }, releaseExactPrices: true }))
      .toEqual({ ok: true, change: { price: { mode: "default" }, releaseExactPrices: true } });
    expect(productPriceEditorResult(model, { mode: "set", fields: { basis: "catalog_retail", percent: "x", flat: "1.999", rounding: "up_99" }, releaseExactPrices: false }))
      .toEqual({ ok: false, errors: { percent: PRICE_DEFAULT_WORDS.percentInvalid, flat: PRICE_DEFAULT_WORDS.flatInvalid } });
    expect(productPriceEditorResult(model, { mode: "set", fields: { basis: "catalog_retail", percent: "10001", flat: "0", rounding: "cent" }, releaseExactPrices: false }))
      .toEqual({ ok: false, errors: { percent: PRICE_DEFAULT_WORDS.percentTooLarge } });
    expect(productPriceEditorResult({ canSet: false, canDefault: true }, { mode: "set", fields: { basis: "catalog_retail", percent: "20", flat: "", rounding: "up_99" }, releaseExactPrices: false }))
      .toEqual({ ok: false, errors: {} });
    expect(productPriceEditorResult({ canSet: true, canDefault: false }, { mode: "default", fields: { basis: "catalog_retail", percent: "20", flat: "", rounding: "up_99" }, releaseExactPrices: false }))
      .toEqual({ ok: false, errors: {} });
  });

  it("names its buttons with W1's and this part's words", () => {
    expect(PRODUCT_PRICE_EDITOR_WORDS).toEqual({
      change: "Change price", useDefault: "Use default", setPrice: "Set price", clearExactPrices: WORDS.clearExactPrices,
      checkNewPrices: "Check new prices", checking: "Checking…", suggested: "Suggested · not saved",
    });
  });

  it("decides [Change price] as the rows decide their Change: the right's reason, Checking…, the one-change line (D2, D3)", () => {
    const editable = { editable: true, reason: null } as const;
    expect(changePriceButton({ own: "ready", right: editable, otherHoldsChange: false, waiting: false })).toEqual({ disabled: false, line: null });
    expect(changePriceButton({ own: "loading", right: editable, otherHoldsChange: false, waiting: false })).toEqual({ disabled: true, line: "Checking…" });
    // A failed own read is said once by the drawer, not here.
    expect(changePriceButton({ own: "failed", right: editable, otherHoldsChange: false, waiting: false })).toEqual({ disabled: true, line: null });
    expect(changePriceButton({ own: "ready", right: editable, otherHoldsChange: true, waiting: false })).toEqual({ disabled: true, line: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
    expect(changePriceButton({ own: "ready", right: editable, otherHoldsChange: false, waiting: true })).toEqual({ disabled: true, line: null });
    expect(changePriceButton({ own: "ready", right: { editable: false, reason: "sign_in" }, otherHoldsChange: true, waiting: false })).toEqual({ disabled: true, line: "Reconnect eBay to change this." });
    expect(changePriceButton({ own: "loading", right: { editable: false, reason: "banner" }, otherHoldsChange: false, waiting: false })).toEqual({ disabled: true, line: null });
  });
});

// ---------------------------------------------------------------------------
// The check inside its owner (D16, D20, D21)
// ---------------------------------------------------------------------------

describe("the check inside its owner (D16, D20, D21)", () => {
  const change: ProductPriceChange = { ...SET, check: CHECK };

  it("shows the check while the draft holds one, with its phase, and never after a save", () => {
    const draft = priceDraft(change);
    expect(priceCheckShown(draft, change)).toEqual({ check: CHECK, phase: "editing", message: null, code: null, locked: false });
    expect(priceCheckShown(draft, { ...SET, check: null })).toBeNull();
    expect(priceCheckShown(draft, null)).toBeNull();
    expect(priceCheckShown(null, change)).toBeNull();
    const saving = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(priceCheckShown(saving, change)).toMatchObject({ phase: "saving", locked: true });
    const uncertain = reduceListingSettingsDraft(saving, { type: "failure", key: "k", failure: { phase: "uncertain", message: "We couldn't confirm your save.", code: null, status: null, fields: [] } })!;
    expect(priceCheckShown(uncertain, change)).toEqual({ check: CHECK, phase: "uncertain", message: "We couldn't confirm your save.", code: null, locked: true });
    const refused = reduceListingSettingsDraft(saving, { type: "failure", key: "k", failure: { phase: "refused", message: "Refused words.", code: "C", status: 422, fields: [] } })!;
    // A refused apply's code travels with the check, so the footer keeps Save off also after Back and reopening.
    expect(priceCheckShown(refused, change)).toEqual({ check: CHECK, phase: "refused", message: "Refused words.", code: "C", locked: false });
    for (const viewStale of [false, true]) {
      expect(priceCheckShown(reduceListingSettingsDraft(saving, { type: "saved", key: "k", nowMs: 1, viewStale })!, change)).toBeNull();
    }
    // Hidden by Back, the draft keeps the check: reopening shows it again (D21).
    expect(priceCheckShown(reduceListingSettingsDraft(uncertain, { type: "close" }), change)).toMatchObject({ phase: "uncertain", locked: true });
  });

  it("Back to editing drops the check and keeps the change, or closes the owner while a save is out or unconfirmed", () => {
    const draft = priceDraft(change);
    expect(priceCheckBack(draft, change)).toEqual({ kind: "edit", change: { ...SET, check: null } });
    expect(priceCheckBack(draft, { ...SET, check: null })).toEqual({ kind: "none" });
    expect(priceCheckBack(null, change)).toEqual({ kind: "none" });
    const saving = reduceListingSettingsDraft(draft, { type: "startSave", attempt: { signature: "s", key: "k" } })!;
    expect(priceCheckBack(saving, change)).toEqual({ kind: "close" });
    const uncertain = reduceListingSettingsDraft(saving, { type: "failure", key: "k", failure: { phase: "uncertain", message: "x", code: null, status: null, fields: [] } })!;
    expect(priceCheckBack(uncertain, change)).toEqual({ kind: "close" });
    const refused = reduceListingSettingsDraft(saving, { type: "failure", key: "k", failure: { phase: "refused", message: "x", code: "C", status: 422, fields: [] } })!;
    expect(priceCheckBack(refused, change)).toEqual({ kind: "edit", change: { ...SET, check: null } });
    // A release alone is a change too.
    expect(priceCheckBack(priceDraft({ ...RELEASE, check: CHECK }), { ...RELEASE, check: CHECK })).toEqual({ kind: "edit", change: { ...RELEASE, check: null } });
  });
});
