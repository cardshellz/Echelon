import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { LISTING_SETTINGS_FIX_CODES, listingSettingsSizePriceSchema } from "../../../../../shared/dropship/listing-settings";
import {
  CONVERSION_BLOCKER_CODES, CONVERSION_CHANGED_FIELDS, CONVERSION_CHANGED_REASONS, CONVERSION_CONTENT_BLOCKER_CODES, CONVERSION_PAGE_SIZE,
  CONVERSION_RULE_KINDS,
  CONVERSION_SETTINGS, CONVERSION_STATES, CONVERSION_TIE_SETTINGS, LISTING_RULES_CONVERSION_ERROR_CODES, MAX_CONVERSION_PAGE,
  MAX_CONVERSION_REPORT_ITEMS, conversionChangeRowSchema, conversionKeptSchema, conversionReportSchema, conversionSizeViewSchema,
  LISTING_RULES_CONVERSION_APPLY_OUTCOMES, listingRulesConversionApplyInputSchema, listingRulesConversionApplyResponseSchema,
  listingRulesConversionCheckInputSchema, listingRulesConversionCheckSchema, pricingRuleRefSchema, sizeRefSchema,
} from "../../../../../shared/dropship/listing-rules-conversion";
import {
  LISTING_CONVERSION_CHILD_KEY_PREFIX, RESERVED_CONVERSION_KEY_MESSAGE, RESERVED_CONVERSION_KEY_PREFIXES, RULES_CONVERSION_SYSTEM_KEY_PREFIX,
  isReservedConversionKey,
} from "../../../../../shared/dropship/listing-rules-conversion-keys";
import {
  LISTING_SETTING_BUSY_REASONS, LISTING_SETTING_WRITE_ERROR_CODES, acknowledgeCategoryMovesInputSchema, applyPriceChangesInputSchema,
  saveCategorySettingsInputSchema, saveProductSettingsInputSchema, saveProductsBulkInputSchema, saveSizePricesInputSchema,
} from "../../../../../shared/dropship/listing-setting-writes";
import { listingSettingRequestKeySchema } from "../../../../../shared/dropship/listing-setting-values";
import { saveContentProfileInputSchema, saveListingContentInputSchema } from "../../../../../shared/dropship/listing-content";
import { saveEbayCategoryRulesInputSchema } from "../../../../../shared/dropship/ebay-category-rules";
import { applyPricingRulesInputSchema } from "../../../../../shared/dropship/pricing-rules";
import { listingConversionChildKey } from "../../domain/listing-setting-values";
import { rulesConversionSystemKey } from "../../application/dropship-listing-rules-conversion-service";

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

describe("the apply's contracts (plan 7.B.1, 7.B.2)", () => {
  const apply = (patch: Record<string, unknown> = {}) =>
    ({ idempotencyKey: "ls-convert:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b", planHash: "a".repeat(64), writesHash: "b".repeat(64), ...patch });

  it("takes a request key and the two hashes of the plan shown, strictly", () => {
    expect(listingRulesConversionApplyInputSchema.parse(apply())).toEqual(apply());
    for (const patch of [{ idempotencyKey: "abcdefg" }, { idempotencyKey: "has space key" }, { idempotencyKey: "x".repeat(201) },
      { planHash: "A".repeat(64) }, { planHash: "a".repeat(63) }, { writesHash: null }, { writesHash: "g".repeat(64) },
      { storeConnectionId: 22 }]) {
      expect(listingRulesConversionApplyInputSchema.safeParse(apply(patch)).success).toBe(false);
    }
    expect(listingRulesConversionApplyInputSchema.safeParse({ planHash: "a".repeat(64), writesHash: "b".repeat(64) }).success).toBe(false);
    expect(listingRulesConversionApplyInputSchema.parse(apply({ idempotencyKey: "x".repeat(200) })).idempotencyKey).toHaveLength(200);
  });

  it("refuses the system job's key and a conversion's child key, so a vendor can never take the job's one key for a store (D12)", () => {
    expect(RESERVED_CONVERSION_KEY_PREFIXES).toEqual([RULES_CONVERSION_SYSTEM_KEY_PREFIX, LISTING_CONVERSION_CHILD_KEY_PREFIX]);
    // The keys the server derives start with them, so the refusal covers exactly what the job and the children use.
    expect(rulesConversionSystemKey(23).startsWith(RULES_CONVERSION_SYSTEM_KEY_PREFIX)).toBe(true);
    expect(listingConversionChildKey(apply().idempotencyKey as string, "category", 5).startsWith(LISTING_CONVERSION_CHILD_KEY_PREFIX)).toBe(true);
    for (const idempotencyKey of [rulesConversionSystemKey(23), "rules-conversion:anything-else",
      listingConversionChildKey(apply().idempotencyKey as string, "product", 7)]) {
      expect(isReservedConversionKey(idempotencyKey)).toBe(true);
      const parsed = listingRulesConversionApplyInputSchema.safeParse(apply({ idempotencyKey }));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.path)).toEqual([["idempotencyKey"]]);
    }
    // Only the prefix is reserved: the client's own key and keys that merely contain the words pass.
    for (const idempotencyKey of ["ls-convert:rules-conversion:23", "Rules-Conversion:23", "lcx:12345678"]) {
      expect(listingRulesConversionApplyInputSchema.safeParse(apply({ idempotencyKey })).success).toBe(true);
    }
  });

  it("answers converted, replayed or nothing to convert; only nothing to convert has no record, and then writes nothing", () => {
    expect(LISTING_RULES_CONVERSION_APPLY_OUTCOMES).toEqual(["converted", "replayed", "nothing_to_convert"]);
    const ok = (answer: Record<string, unknown>) => listingRulesConversionApplyResponseSchema.safeParse(answer).success;
    expect(ok({ outcome: "converted", conversionId: 1, categoryCount: 2, productCount: 3 })).toBe(true);
    expect(ok({ outcome: "replayed", conversionId: Number.MAX_SAFE_INTEGER, categoryCount: 10_000, productCount: 0 })).toBe(true);
    expect(ok({ outcome: "nothing_to_convert", conversionId: null, categoryCount: 0, productCount: 0 })).toBe(true);
    for (const broken of [
      { outcome: "converted", conversionId: null, categoryCount: 0, productCount: 0 },
      { outcome: "replayed", conversionId: null, categoryCount: 0, productCount: 0 },
      { outcome: "nothing_to_convert", conversionId: 1, categoryCount: 0, productCount: 0 },
      { outcome: "nothing_to_convert", conversionId: null, categoryCount: 0, productCount: 1 },
      { outcome: "converted", conversionId: 0, categoryCount: 0, productCount: 0 },
      { outcome: "converted", conversionId: 1, categoryCount: 10_001, productCount: 0 },
      { outcome: "converted", conversionId: 1, categoryCount: 1.5, productCount: 0 },
      { outcome: "not_clean", conversionId: null, categoryCount: 0, productCount: 0 },
      { outcome: "converted", conversionId: 1, categoryCount: 0, productCount: 0, clean: true },
    ]) {
      expect(ok(broken)).toBe(false);
    }
  });

  it("names its three refusals in the shared write code list too", () => {
    expect([LISTING_SETTING_WRITE_ERROR_CODES.conversionChanged, LISTING_SETTING_WRITE_ERROR_CODES.conversionCheckUnavailable,
      LISTING_SETTING_WRITE_ERROR_CODES.conversionWouldBlockListing]).toEqual([LISTING_RULES_CONVERSION_ERROR_CODES.changed,
      LISTING_RULES_CONVERSION_ERROR_CODES.checkUnavailable, LISTING_RULES_CONVERSION_ERROR_CODES.wouldBlockListing]);
    expect(Object.isFrozen(LISTING_SETTING_WRITE_ERROR_CODES)).toBe(true);
  });

  it("names every BUSY reason a write raises before it writes, catalog_changed included", () => {
    expect(LISTING_SETTING_BUSY_REASONS).toEqual({ heavyWrite: "heavy_write_in_progress", requestKeyChanged: "request_key_changed",
      catalogChanged: "catalog_changed" });
    expect(Object.isFrozen(LISTING_SETTING_BUSY_REASONS)).toBe(true);
  });
});

describe("the reserved conversion keys on every vendor key schema (verify round, plan D12)", () => {
  // The keys a store's system conversion writes are a function of its id alone (CVR openingOf, childKey).
  const SYSTEM_KEY = rulesConversionSystemKey(22);
  const RESERVED = [
    ["the system job's key", SYSTEM_KEY],
    ["its description templates' child key", listingConversionChildKey(SYSTEM_KEY, "content_profile", 22)],
    ["its eBay rules' child key", listingConversionChildKey(SYSTEM_KEY, "ebay_rules", 22)],
    ["its category child key", listingConversionChildKey(SYSTEM_KEY, "category", 5)],
    ["its product child key", listingConversionChildKey(SYSTEM_KEY, "product", 8)],
  ] as const;
  const UUID = "7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
  // Each schema with a body it accepts and the key its client sends (client/src: LISTING_SETTINGS_KEY_PREFIXES and the older pages).
  const SCHEMAS: ReadonlyArray<readonly [string, { safeParse: (body: unknown) => { success: boolean; error?: z.ZodError } },
    (idempotencyKey: string) => unknown, string]> = [
    ["W8 size prices", saveSizePricesInputSchema,
      (idempotencyKey) => ({ idempotencyKey, rows: [{ productVariantId: 101, priceCents: 1_499, expectedRevisionId: null }] }), `ls-size-prices:${UUID}`],
    ["W5 one product", saveProductSettingsInputSchema,
      (idempotencyKey) => ({ idempotencyKey, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } }), `ls-product:${UUID}`],
    ["W6 bulk", saveProductsBulkInputSchema, (idempotencyKey) => ({ idempotencyKey,
      products: [{ productId: 7, expectedRevisionId: null }], patch: { storeShelf: { mode: "none" } } }), `ls-bulk:${UUID}`],
    ["W12 one category", saveCategorySettingsInputSchema,
      (idempotencyKey) => ({ idempotencyKey, expectedRevisionId: null, patch: { storeShelf: { mode: "none" } } }), `ls-cat:${UUID}`],
    ["W7 price changes apply", applyPriceChangesInputSchema,
      (idempotencyKey) => ({ reviewId: UUID, reviewHash: HASH_B, idempotencyKey }), `ls-price-check:${UUID}`],
    ["W13 category moves", acknowledgeCategoryMovesInputSchema,
      (idempotencyKey) => ({ idempotencyKey, items: [{ productId: 7, shownCategoryId: 3 }] }), `ls-moves:${UUID}`],
    ["the conversion's apply", listingRulesConversionApplyInputSchema,
      (idempotencyKey) => ({ idempotencyKey, planHash: HASH_A, writesHash: HASH_B }), `ls-convert:${UUID}`],
    ["W4 description templates", saveContentProfileInputSchema, (idempotencyKey) => ({ expectedRevisionId: null,
      profile: { defaultTemplate: { introduction: "", footer: "" }, groups: [] }, idempotencyKey }), `listing-content:${UUID}`],
    ["one size's description", saveListingContentInputSchema, (idempotencyKey) => ({ customText: "My copy", expectedRevisionId: null,
      expectedProfileRevisionId: null, expectedCatalogHash: HASH_A, idempotencyKey }), `listing-content:${UUID}`],
    ["W3 eBay category rules", saveEbayCategoryRulesInputSchema,
      (idempotencyKey) => ({ expectedRevisionId: null, draft: { defaultCategoryId: null, rules: [] }, idempotencyKey }), `ls-category:${UUID}`],
    ["W1 pricing rules apply", applyPricingRulesInputSchema,
      (idempotencyKey) => ({ reviewId: UUID, reviewHash: HASH_A, idempotencyKey }), `pricing-rules:${UUID}`],
  ];

  it("derives each refused key from the reserved prefixes", () => {
    for (const [, key] of RESERVED) expect(isReservedConversionKey(key)).toBe(true);
    expect(RESERVED_CONVERSION_KEY_MESSAGE).toBe("This key is kept for the system's own conversions.");
  });

  it("the PR 9 request key schema refuses them and takes every other key it took before", () => {
    for (const [, key] of RESERVED) {
      expect(listingSettingRequestKeySchema.safeParse(key).error?.issues).toEqual([
        expect.objectContaining({ code: "custom", path: [], message: RESERVED_CONVERSION_KEY_MESSAGE })]);
    }
    for (const key of [`listing-settings:${UUID}`, "k".repeat(8), "ls-convert:rules-conversion:22", "LC:abcdefgh", "lcx:12345678"]) {
      expect(listingSettingRequestKeySchema.safeParse(key).success).toBe(true);
    }
  });

  it.each(SCHEMAS)("%s refuses each reserved key on the key alone, and takes its client's own key", (_label, schema, body, clientKey) => {
    expect(schema.safeParse(body(clientKey)).success).toBe(true);
    // A key that merely contains a reserved word, or differs in case, is not reserved (the unique keys are case-sensitive).
    expect(schema.safeParse(body("Rules-Conversion:22")).success).toBe(true);
    for (const [, key] of RESERVED) {
      const parsed = schema.safeParse(body(key));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([[["idempotencyKey"], RESERVED_CONVERSION_KEY_MESSAGE]]);
    }
  });
});
