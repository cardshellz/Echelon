import { describe, expect, it } from "vitest";
import { LISTING_SETTINGS_FIX_CODES, listingSettingsSizePriceSchema } from "../../../../../shared/dropship/listing-settings";
import {
  CONVERSION_BLOCKER_CODES, CONVERSION_CHANGED_FIELDS, CONVERSION_CHANGED_REASONS, CONVERSION_CONTENT_BLOCKER_CODES, CONVERSION_PAGE_SIZE,
  CONVERSION_RULE_KINDS,
  CONVERSION_SETTINGS, CONVERSION_STATES, CONVERSION_TIE_SETTINGS, LISTING_RULES_CONVERSION_ERROR_CODES, MAX_CONVERSION_PAGE,
  MAX_CONVERSION_REPORT_ITEMS, conversionChangeRowSchema, conversionKeptSchema, conversionReportSchema, conversionSizeViewSchema,
  listingRulesConversionCheckInputSchema, listingRulesConversionCheckSchema, pricingRuleRefSchema, sizeRefSchema,
} from "../../../../../shared/dropship/listing-rules-conversion";

/*
 * The dry run's contracts (plan 4.A.1, 4.A.3, 4.A.9 "Contracts"): every
 * schema strict, every enum closed, the list caps and page bounds, and the
 * size price is the read model's own schema. The shared tests directory runs
 * in no CI job, so these live with the server unit tests (plan 3.1).
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const RECIPE = { basis: "product_cost", markupBps: 4_000, flatCents: 0, rounding: "cent" } as const;

const sizePrice = {
  productVariantId: 11, productId: 7, productName: "Sleeves 100", sizeName: "Pack of 100", sku: "SL-100",
  priceCents: 1_400, source: "rules", rule: { kind: "group", name: "Sleeves rule", recipe: RECIPE }, basis: "product_cost",
  basisAmountCents: 1_000, issue: null, costCents: 1_000, belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: null,
} as const;

const sizeView = {
  price: sizePrice,
  pricingRule: { kind: "group", name: "Sleeves rule", recipe: RECIPE },
  ebayCategory: { id: "183438", name: "Card Sleeves" },
  shelfNames: ["Sleeves"],
  policies: { shipping: "F1", return: null, payment: "P1" },
  descriptionHash: HASH_A,
  blockers: [],
} as const;

const changeRow = {
  productVariantId: 11, productId: 7, productName: "Sleeves 100", sizeName: "Pack of 100", changed: ["pricingRule"],
  before: sizeView,
  after: { ...sizeView, pricingRule: { kind: "category", name: "Sleeves", recipe: { ...RECIPE, markupBps: 3_000 } } },
} as const;

const emptyList = { total: 0, items: [] } as const;
const emptyReport = { unmatched: emptyList, shared: emptyList, nameMismatches: emptyList, neverApplies: emptyList, ties: emptyList,
  someSizesOnly: emptyList, mixed: emptyList } as const;
const kept = { exactPrices: 2, catalogPrices: 1, sizePolicies: 0, sizeShelves: 3, sizeTexts: 0 } as const;

function check(patch: Record<string, unknown> = {}) {
  return {
    storeConnectionId: 5, generatedAt: "2026-10-15T12:00:00.000Z", state: "clean", planHash: HASH_A, writesHash: HASH_B,
    olderRules: { pricingGroups: 2, contentGroups: 0, ebayCategoryRules: 1 },
    blocked: { wouldLosePrice: emptyList, wouldBlockListing: emptyList, tooMuchText: false },
    becomes: { categories: { total: 1, items: [{ categoryId: 12, categoryName: "Sleeves", settings: ["price", "ebayCategory"] }] },
      products: emptyList },
    report: emptyReport, kept,
    changes: { page: 0, pageSize: CONVERSION_PAGE_SIZE, total: 0, rows: [] },
    ...patch,
  };
}

const sizeRef = { productId: 7, productVariantId: 11, productName: "Sleeves 100", sizeName: "Pack of 100", priceCents: 1_400 };

describe("the dry run's input", () => {
  it("takes a store and a page from 0 to 199, page 0 by default", () => {
    expect(MAX_CONVERSION_PAGE).toBe(199);
    expect(listingRulesConversionCheckInputSchema.parse({ storeConnectionId: 5 })).toEqual({ storeConnectionId: 5, page: 0 });
    expect(listingRulesConversionCheckInputSchema.parse({ storeConnectionId: 5, page: 199 }).page).toBe(199);
    for (const page of [-1, 200, 1.5]) {
      expect(listingRulesConversionCheckInputSchema.safeParse({ storeConnectionId: 5, page }).success).toBe(false);
    }
    for (const storeConnectionId of [0, -3, 2_147_483_648, 1.5]) {
      expect(listingRulesConversionCheckInputSchema.safeParse({ storeConnectionId }).success).toBe(false);
    }
  });

  it("is strict", () => {
    expect(listingRulesConversionCheckInputSchema.safeParse({ storeConnectionId: 5, page: 0, search: "" }).success).toBe(false);
  });
});

describe("the closed lists", () => {
  it("names exactly the compared keys, blocker codes, settings, rule kinds and states of plan 3.2 and 4.A.3", () => {
    expect(CONVERSION_CHANGED_FIELDS).toEqual(["price", "priceSource", "pricingRule", "ebayCategory", "storeShelf",
      "shippingPolicy", "returnPolicy", "paymentPolicy", "description", "listable"]);
    expect(CONVERSION_BLOCKER_CODES).toEqual(["no_ebay_category", "size_cannot_be_priced", "own_text_needs_check",
      "description_group_conflict", "price_outside_limit", "listing_content_catalog_too_large",
      "listing_content_description_required", "listing_content_description_too_large"]);
    // The first four are the read model's fix codes, in their order; the last three the content issues no fix code covers.
    expect(CONVERSION_BLOCKER_CODES.slice(0, LISTING_SETTINGS_FIX_CODES.length)).toEqual([...LISTING_SETTINGS_FIX_CODES]);
    expect(CONVERSION_CONTENT_BLOCKER_CODES).toEqual(["listing_content_catalog_too_large", "listing_content_description_required",
      "listing_content_description_too_large"]);
    expect(CONVERSION_BLOCKER_CODES.slice(-CONVERSION_CONTENT_BLOCKER_CODES.length)).toEqual([...CONVERSION_CONTENT_BLOCKER_CODES]);
    expect(CONVERSION_SETTINGS).toEqual(["price", "ebayCategory", "textAbove", "textBelow"]);
    expect(CONVERSION_RULE_KINDS).toEqual(["price", "description", "ebayCategory"]);
    expect(CONVERSION_TIE_SETTINGS).toEqual(["price", "description"]);
    expect(CONVERSION_STATES).toEqual(["no_older_rules", "clean", "not_clean"]);
    expect(CONVERSION_CHANGED_REASONS).toEqual(["settings_changed", "listed_changes_moved"]);
  });

  it("names the three new refusals by their codes, and the codes cannot be changed", () => {
    expect(LISTING_RULES_CONVERSION_ERROR_CODES).toEqual({
      changed: "DROPSHIP_LISTING_CONVERSION_CHANGED",
      checkUnavailable: "DROPSHIP_LISTING_CONVERSION_CHECK_UNAVAILABLE",
      wouldBlockListing: "DROPSHIP_LISTING_CONVERSION_WOULD_BLOCK_LISTING",
    });
    expect(Object.isFrozen(LISTING_RULES_CONVERSION_ERROR_CODES)).toBe(true);
  });

  it("caps report lists at 100 and pages at 50", () => {
    expect(MAX_CONVERSION_REPORT_ITEMS).toBe(100);
    expect(CONVERSION_PAGE_SIZE).toBe(50);
  });
});

describe("the pricing rule a size follows", () => {
  it("is one of four named rules with a recipe, or a tie with neither", () => {
    for (const kind of ["store_default", "group", "product", "category"]) {
      expect(pricingRuleRefSchema.safeParse({ kind, name: "A rule", recipe: RECIPE }).success).toBe(true);
    }
    expect(pricingRuleRefSchema.parse({ kind: "tie" })).toEqual({ kind: "tie" });
    expect(pricingRuleRefSchema.safeParse({ kind: "tie", name: "Two rules" }).success).toBe(false);
    expect(pricingRuleRefSchema.safeParse({ kind: "group", name: "", recipe: RECIPE }).success).toBe(false);
    expect(pricingRuleRefSchema.safeParse({ kind: "group", name: "A rule" }).success).toBe(false);
    expect(pricingRuleRefSchema.safeParse({ kind: "listing", name: "A rule", recipe: RECIPE }).success).toBe(false);
    expect(pricingRuleRefSchema.safeParse({ kind: "group", name: "A rule", recipe: RECIPE, ruleId: "g1" }).success).toBe(false);
    expect(pricingRuleRefSchema.safeParse({ kind: "group", name: "A rule", recipe: { ...RECIPE, markupBps: 1.5 } }).success).toBe(false);
  });
});

describe("a size's two sides", () => {
  it("reads the price with the read model's own size price schema", () => {
    expect(conversionSizeViewSchema.shape.price).toBe(listingSettingsSizePriceSchema);
    expect(conversionSizeViewSchema.parse(sizeView)).toEqual(sizeView);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, price: { ...sizePrice, priceCents: 14.5 } }).success).toBe(false);
  });

  it("is strict at every level", () => {
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, ruleId: "g1" }).success).toBe(false);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, ebayCategory: { id: "1", name: null, path: [] } }).success).toBe(false);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, policies: { ...sizeView.policies, extra: null } }).success).toBe(false);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, price: { ...sizePrice, extra: 1 } }).success).toBe(false);
  });

  it("keeps the blockers as a closed set in the list's order", () => {
    const blockers = (list: string[]) => conversionSizeViewSchema.safeParse({ ...sizeView, blockers: list }).success;
    expect(blockers(["no_ebay_category", "price_outside_limit", "listing_content_description_too_large"])).toBe(true);
    expect(blockers(["price_outside_limit", "no_ebay_category"])).toBe(false);
    expect(blockers(["no_ebay_category", "no_ebay_category"])).toBe(false);
    expect(blockers(["pricing:below_floor:policy_1"])).toBe(false);
  });

  it("gives a nameless eBay category, no shelf and no policy", () => {
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, ebayCategory: { id: "184267", name: null }, shelfNames: [],
      policies: { shipping: null, return: null, payment: null } }).success).toBe(true);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, ebayCategory: null }).success).toBe(true);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, shelfNames: ["A", "B", "C"] }).success).toBe(false);
    expect(conversionSizeViewSchema.safeParse({ ...sizeView, descriptionHash: "abc" }).success).toBe(false);
  });
});

describe("a changed row", () => {
  it("names at least one changed key, each once, in the list's order", () => {
    expect(conversionChangeRowSchema.parse(changeRow)).toEqual(changeRow);
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, changed: [] }).success).toBe(false);
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, changed: ["pricingRule", "price"] }).success).toBe(false);
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, changed: ["price", "price"] }).success).toBe(false);
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, changed: ["evidenceHash"] }).success).toBe(false);
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, ruleName: "Sleeves rule" }).success).toBe(false);
  });

  it("is about one size on both sides", () => {
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, after: { ...changeRow.after,
      price: { ...sizePrice, productVariantId: 12 } } }).success).toBe(false);
    expect(conversionChangeRowSchema.safeParse({ ...changeRow, before: { ...sizeView, price: { ...sizePrice, productId: 8 } } }).success)
      .toBe(false);
  });
});

describe("the report and the size lists", () => {
  it("carries every item up to 100 and counts them all", () => {
    const item = { ruleName: "Old rule", kind: "price" };
    const neverApplies = (total: number, items: number) => conversionReportSchema.safeParse({ ...emptyReport,
      neverApplies: { total, items: Array.from({ length: items }, () => item) } }).success;
    expect(neverApplies(1, 1)).toBe(true);
    expect(neverApplies(100, 100)).toBe(true);
    expect(neverApplies(250, 100)).toBe(true);
    expect(neverApplies(101, 101)).toBe(false);
    expect(neverApplies(5, 4)).toBe(false);
    expect(neverApplies(0, 1)).toBe(false);
  });

  it("gives every item its rule kind or its setting, from closed lists", () => {
    const parse = (key: string, value: Record<string, unknown>) =>
      conversionReportSchema.safeParse({ ...emptyReport, [key]: { total: 1, items: [value] } }).success;
    expect(parse("unmatched", { ruleName: "Binders", categoryName: "Binders", kind: "price" })).toBe(true);
    expect(parse("unmatched", { ruleName: "Binders", categoryName: "Binders" })).toBe(false);
    expect(parse("unmatched", { ruleName: "Binders", categoryName: "Binders", kind: "shelf" })).toBe(false);
    expect(parse("shared", { ruleName: "Sleeves", categoryName: "Sleeves", categoryCount: 2, kind: "description" })).toBe(true);
    expect(parse("shared", { ruleName: "Sleeves", categoryName: "Sleeves", categoryCount: 1, kind: "description" })).toBe(false);
    expect(parse("neverApplies", { ruleName: "Old", kind: "ebayCategory" })).toBe(true);
    expect(parse("ties", { productId: 7, productName: "Binder", setting: "price" })).toBe(true);
    expect(parse("ties", { productId: 7, productName: "Binder", setting: "ebayCategory" })).toBe(false);
    expect(parse("someSizesOnly", { ruleName: "Two sizes", productId: 7, productName: "Binder", setting: "textBelow" })).toBe(true);
    expect(parse("someSizesOnly", { ruleName: "Two sizes", productId: 7, productName: "Binder" })).toBe(false);
    expect(parse("mixed", { productId: 7, productName: "Binder", setting: "ebayCategory" })).toBe(true);
    expect(parse("mixed", { productId: 7, productName: "Binder", setting: "description" })).toBe(false);
    expect(parse("nameMismatches", { productId: 7, productName: "Binder", listedAs: "Binders", categoryName: null })).toBe(true);
    expect(parse("nameMismatches", { productId: 7, productName: "Binder", listedAs: null, categoryName: "Binders" })).toBe(true);
    expect(parse("nameMismatches", { productId: 7, productName: "Binder", listedAs: null, categoryName: null })).toBe(false);
    for (const key of Object.keys(emptyReport)) {
      expect(conversionReportSchema.safeParse({ ...emptyReport, [key]: { total: 0, items: [], next: null } }).success).toBe(false);
    }
    expect(conversionReportSchema.safeParse({ ...emptyReport, ties: { total: 1, items: [
      { productId: 7, productName: "Binder", setting: "price", ruleName: "A" }] } }).success).toBe(false);
    expect(conversionReportSchema.safeParse({ ...emptyReport, extra: emptyList }).success).toBe(false);
  });

  it("refers to sizes by id and name with today's price", () => {
    expect(sizeRefSchema.parse(sizeRef)).toEqual(sizeRef);
    expect(sizeRefSchema.safeParse({ ...sizeRef, priceCents: null }).success).toBe(true);
    expect(sizeRefSchema.safeParse({ ...sizeRef, priceCents: 0 }).success).toBe(false);
    expect(sizeRefSchema.safeParse({ ...sizeRef, sku: "SL-100" }).success).toBe(false);
  });

  it("counts the kept per-size rows", () => {
    expect(conversionKeptSchema.parse(kept)).toEqual(kept);
    expect(conversionKeptSchema.safeParse({ ...kept, exactPrices: -1 }).success).toBe(false);
    expect(conversionKeptSchema.safeParse({ ...kept, legacyRows: 0 }).success).toBe(false);
  });
});

describe("the dry run's answer", () => {
  it("parses each state", () => {
    expect(listingRulesConversionCheckSchema.parse(check())).toEqual(check());
    expect(listingRulesConversionCheckSchema.safeParse(check({ state: "no_older_rules", planHash: null, writesHash: null,
      olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 }, becomes: { categories: emptyList, products: emptyList } }))
      .success).toBe(true);
    expect(listingRulesConversionCheckSchema.safeParse(check({ state: "not_clean",
      changes: { page: 0, pageSize: 50, total: 1, rows: [changeRow] } })).success).toBe(true);
    expect(listingRulesConversionCheckSchema.safeParse(check({ state: "not_clean",
      blocked: { wouldLosePrice: emptyList, wouldBlockListing: emptyList, tooMuchText: true } })).success).toBe(true);
    expect(listingRulesConversionCheckSchema.safeParse(check({ state: "not_clean", blocked: { wouldLosePrice: emptyList,
      wouldBlockListing: { total: 1, items: [{ ...sizeRef, reasons: ["no_ebay_category"] }] }, tooMuchText: false } })).success).toBe(true);
  });

  it("is strict at every level", () => {
    const refused = (patch: Record<string, unknown>) => listingRulesConversionCheckSchema.safeParse(check(patch)).success === false;
    expect(refused({ cachedAt: "2026-10-15T12:00:00.000Z" })).toBe(true);
    expect(refused({ olderRules: { pricingGroups: 2, contentGroups: 0, ebayCategoryRules: 1, listings: 0 } })).toBe(true);
    expect(refused({ blocked: { wouldLosePrice: emptyList, wouldBlockListing: emptyList, tooMuchText: false, other: false } })).toBe(true);
    expect(refused({ becomes: { categories: emptyList, products: emptyList, sizes: emptyList } })).toBe(true);
    expect(refused({ becomes: { categories: { total: 1, items: [{ categoryId: 12, categoryName: "Sleeves", settings: ["price"],
      revisionId: 3 }] }, products: emptyList } })).toBe(true);
    expect(refused({ kept: { ...kept, other: 0 } })).toBe(true);
    expect(refused({ changes: { page: 0, pageSize: 50, total: 0, rows: [], next: 1 } })).toBe(true);
  });

  it("keeps a plan hash and a writes hash exactly while the store has older rules", () => {
    const refused = (patch: Record<string, unknown>) => listingRulesConversionCheckSchema.safeParse(check(patch)).success === false;
    expect(refused({ planHash: null })).toBe(true);
    expect(refused({ writesHash: null })).toBe(true);
    expect(refused({ planHash: "not-a-hash" })).toBe(true);
    expect(refused({ state: "no_older_rules", planHash: null, writesHash: null })).toBe(true);
    expect(refused({ olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 } })).toBe(true);
    expect(refused({ state: "no_older_rules", olderRules: { pricingGroups: 0, contentGroups: 0, ebayCategoryRules: 0 } })).toBe(true);
  });

  it("is clean only with no changed and no blocked size, and not clean only with one", () => {
    const refused = (patch: Record<string, unknown>) => listingRulesConversionCheckSchema.safeParse(check(patch)).success === false;
    expect(refused({ changes: { page: 0, pageSize: 50, total: 1, rows: [changeRow] } })).toBe(true);
    expect(refused({ blocked: { wouldLosePrice: { total: 1, items: [sizeRef] }, wouldBlockListing: emptyList, tooMuchText: false } }))
      .toBe(true);
    expect(refused({ blocked: { wouldLosePrice: emptyList, wouldBlockListing: emptyList, tooMuchText: true } })).toBe(true);
    expect(refused({ state: "not_clean" })).toBe(true);
    expect(refused({ state: "blocked" })).toBe(true);
  });

  it("pages its changed rows 50 at a time within the page bounds", () => {
    const rows = (count: number) => Array.from({ length: count }, () => changeRow);
    const changes = (value: Record<string, unknown>) =>
      listingRulesConversionCheckSchema.safeParse(check({ state: "not_clean", changes: value })).success;
    expect(changes({ page: 199, pageSize: 50, total: 10_000, rows: rows(50) })).toBe(true);
    expect(changes({ page: 0, pageSize: 50, total: 51, rows: rows(51) })).toBe(false);
    expect(changes({ page: 0, pageSize: 100, total: 1, rows: rows(1) })).toBe(false);
    expect(changes({ page: 200, pageSize: 50, total: 1, rows: [] })).toBe(false);
    expect(changes({ page: 0, pageSize: 50, total: 1, rows: rows(2) })).toBe(false);
    expect(changes({ page: 0, pageSize: 50, total: 10_001, rows: [] })).toBe(false);
  });

  it("says why a size listed on eBay would be blocked", () => {
    const blockedBy = (reasons: string[]) => listingRulesConversionCheckSchema.safeParse(check({ state: "not_clean", blocked: {
      wouldLosePrice: emptyList, wouldBlockListing: { total: 1, items: [{ ...sizeRef, reasons }] }, tooMuchText: false } })).success;
    expect(blockedBy(["no_ebay_category", "listing_content_description_required"])).toBe(true);
    expect(blockedBy([])).toBe(false);
    expect(blockedBy(["listing_content_description_required", "no_ebay_category"])).toBe(false);
  });
});
