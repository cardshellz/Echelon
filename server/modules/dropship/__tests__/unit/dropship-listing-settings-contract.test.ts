import { describe, expect, it } from "vitest";
import {
  LISTING_SETTINGS_FIELD_SETTINGS,
  LISTING_SETTINGS_FIELDS,
  LISTING_SETTINGS_PAGE_SIZE,
  LISTING_SETTINGS_SETTING_KEYS,
  LISTING_SETTINGS_VALUE_SOURCES,
  MAX_LISTING_SETTINGS_PAGE,
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsCategoryInputSchema,
  listingSettingsPricesInputSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductIdsInputSchema,
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductInputSchema,
  listingSettingsProductSettingsSchema,
  listingSettingsProductsInputSchema,
  listingSettingsSizePriceSchema,
  listingSettingsSummarySchema,
} from "../../../../../shared/dropship/listing-settings";
import { RULE_PRICE_LEVELS, listingPriceSettingSchema } from "../../../../../shared/dropship/listing-price";
import { pricingImpactRowSchema, resolvePricingRule, type PricingProfile } from "../../../../../shared/dropship/pricing-rules";
import { ebayCategoryRulesReviewSchema, ebayCategorySourceValues } from "../../../../../shared/dropship/ebay-category-rules";
import { prepareEbayCategoryRules, summarizeEbayCategoryRulesReview } from "../../application/dropship-ebay-category-resolver";
import { MAILERS, SLEEVES, categoryCandidate, rulesProfile } from "../fixtures/ebay-category-rules.fixture";

const sizePrice = {
  productVariantId: 11, productId: 7, productName: "Toploader 35pt", sizeName: "Pack of 25", sku: "TL-35-25",
  priceCents: 1_499, source: "exact", rule: null, basis: null, basisAmountCents: null, issue: null,
  costCents: 1_200, belowCostByCents: null, limits: [], pausedSince: null, settingRevisionId: 3,
} as const;

const summary = {
  storeConnectionId: 5, storeStatus: "connected", access: { allowed: true },
  catalog: { state: "ok", products: 2, sizes: 3 },
  storeDefaults: {
    price: { recipe: null, groupRules: 0 },
    shippingPolicy: { policyId: "123", verification: "not_checked" },
    returnPolicy: { policyId: null, verification: "not_checked" },
    paymentPolicy: { policyId: null, verification: "not_checked" },
    ebayCategory: { category: null, groupRules: 0 },
    description: { hasIntroduction: false, hasFooter: false, groupRules: 0 },
  },
  counts: { productsNeedingFix: 0, productsWithSizesDiffer: 0, productsWithOwnSettings: 0,
    exactPrices: 1, belowCost: 0, cannotPrice: 0, paused: 0 },
  attention: { items: [{ code: "choose_store_policies", count: 2, productId: null, productName: null }], total: 1 },
  rail: { state: "choose_policy", productsNeedingFix: 0, missingPolicy: "return" },
  generatedAt: "2026-10-06T12:00:00.000Z",
} as const;

describe("listing settings contracts", () => {
  it("fills the list defaults and trims the search", () => {
    expect(listingSettingsProductsInputSchema.parse({ storeConnectionId: 5, search: "  sleeve  " }))
      .toEqual({ storeConnectionId: 5, search: "sleeve", show: "all", page: 0 });
    expect(listingSettingsPricesInputSchema.parse({ storeConnectionId: 5 }))
      .toEqual({ storeConnectionId: 5, search: "", show: "all", page: 0 });
  });

  it("covers every row of the largest selection with its pages, and no more", () => {
    expect((MAX_LISTING_SETTINGS_PAGE + 1) * LISTING_SETTINGS_PAGE_SIZE).toBe(10_000);
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, page: MAX_LISTING_SETTINGS_PAGE }).success).toBe(true);
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, page: MAX_LISTING_SETTINGS_PAGE + 1 }).success).toBe(false);
  });

  it.each([
    ["an unknown field", { storeConnectionId: 5, vendorId: 9 }],
    ["a negative page", { storeConnectionId: 5, page: -1 }],
    ["a fractional page", { storeConnectionId: 5, page: 1.5 }],
    ["an unknown filter", { storeConnectionId: 5, show: "everything" }],
    ["a search over 100 characters", { storeConnectionId: 5, search: "x".repeat(101) }],
    ["a store id of 0", { storeConnectionId: 0 }],
    ["a store id beyond the integer column", { storeConnectionId: 2_147_483_648 }],
  ])("refuses %s", (_case, input) => {
    expect(listingSettingsProductsInputSchema.safeParse(input).success).toBe(false);
  });

  it("refuses a price filter the Prices tab does not have", () => {
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, show: "sizes_differ" }).success).toBe(false);
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 5, show: "nope" }).success).toBe(false);
  });

  it("lists the retail fallbacks on the Prices tab only (A3)", () => {
    expect(listingSettingsPricesInputSchema.parse({ storeConnectionId: 5, show: "retail_fallback" }))
      .toEqual({ storeConnectionId: 5, search: "", show: "retail_fallback", page: 0 });
    expect(listingSettingsProductsInputSchema.safeParse({ storeConnectionId: 5, show: "retail_fallback" }).success).toBe(false);
  });

  it("accepts a size on its retail price as a fallback, with or without the rules' reason, and refuses an unknown source", () => {
    const fallback = { ...sizePrice, priceCents: 1_199, source: "retail_fallback", settingRevisionId: 4 };
    expect(listingSettingsSizePriceSchema.parse(fallback)).toEqual(fallback);
    const tie = { ...fallback, issue: "pricing_rule_priority_conflict" };
    expect(listingSettingsSizePriceSchema.parse(tie)).toEqual(tie);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, source: "inherit" }).success).toBe(false);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, source: "retail" }).success).toBe(false);
    expect(listingSettingsSizePriceSchema.safeParse({ ...fallback, issue: "no_rules" }).success).toBe(false);
  });

  it("accepts a priced size and refuses a loss of zero cents or a money value in dollars", () => {
    expect(listingSettingsSizePriceSchema.parse(sizePrice)).toEqual(sizePrice);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, belowCostByCents: 0 }).success).toBe(false);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, priceCents: 14.99 }).success).toBe(false);
    expect(listingSettingsSizePriceSchema.safeParse({ ...sizePrice, priceCents: 0 }).success).toBe(false);
  });

  it("caps a page at 50 rows", () => {
    const page = (rows: number) => ({ storeConnectionId: 5, page: 0, pageSize: 50, total: rows,
      rows: Array.from({ length: rows }, (_, index) => ({ ...sizePrice, productVariantId: index + 1 })),
      generatedAt: "2026-10-06T12:00:00.000Z" });
    expect(listingSettingsPricesResponseSchema.safeParse(page(50)).success).toBe(true);
    expect(listingSettingsPricesResponseSchema.safeParse(page(51)).success).toBe(false);
  });

  it("accepts a summary, and a too-large selection without counts", () => {
    expect(listingSettingsSummarySchema.parse(summary)).toEqual(summary);
    const tooLarge = { ...summary, catalog: { state: "too_large", limit: 10_000 }, counts: null,
      rail: { state: "too_many_sizes", productsNeedingFix: 0, missingPolicy: null } };
    expect(listingSettingsSummarySchema.parse(tooLarge)).toEqual(tooLarge);
  });

  it("accepts a blocked access decision only with a known code and resolution", () => {
    const blocked = { allowed: false, code: "DROPSHIP_LISTING_STORE_BLOCKED", resolution: "reconnect_store", message: "Reconnect." };
    expect(listingSettingsSummarySchema.safeParse({ ...summary, access: blocked }).success).toBe(true);
    expect(listingSettingsSummarySchema.safeParse({ ...summary, access: { ...blocked, resolution: "try_again" } }).success).toBe(false);
  });

  it("shows at most three attention lines", () => {
    const item = { code: "no_ebay_category", count: 1, productId: 7, productName: "Toploader 35pt" };
    expect(listingSettingsSummarySchema.safeParse({ ...summary, attention: { items: [item, item, item], total: 9 } }).success).toBe(true);
    expect(listingSettingsSummarySchema.safeParse({ ...summary, attention: { items: [item, item, item, item], total: 9 } }).success).toBe(false);
  });
});

describe("listing settings contracts: one product", () => {
  const value = (source: string, ruleName: string | null) =>
    [{ value: { policyId: "F1" }, sources: [{ source, ruleName, productVariantIds: [11] }] }];

  it("takes a store and a product, nothing else", () => {
    expect(listingSettingsProductInputSchema.parse({ storeConnectionId: 5, productId: 7 })).toEqual({ storeConnectionId: 5, productId: 7 });
    expect(listingSettingsProductInputSchema.safeParse({ storeConnectionId: 5, productId: 0 }).success).toBe(false);
    expect(listingSettingsProductInputSchema.safeParse({ storeConnectionId: 5, productId: 7, page: 1 }).success).toBe(false);
  });

  it("lists every setting once, and maps every row field to its settings", () => {
    expect(Object.keys(listingSettingsProductSettingsSchema.shape)).toEqual([...LISTING_SETTINGS_SETTING_KEYS]);
    expect(Object.keys(LISTING_SETTINGS_FIELD_SETTINGS)).toEqual([...LISTING_SETTINGS_FIELDS]);
    expect(Object.values(LISTING_SETTINGS_FIELD_SETTINGS).flat().sort()).toEqual([...LISTING_SETTINGS_SETTING_KEYS].sort());
  });

  it("names a group rule, and only a group rule", () => {
    const policy = listingSettingsProductSettingsSchema.shape.shippingPolicy;
    expect(policy.safeParse(value("group_rule", "Toploaders")).success).toBe(true);
    expect(policy.safeParse(value("group_rule", null)).success).toBe(false);
    expect(policy.safeParse(value("store_default", "Toploaders")).success).toBe(false);
    expect(policy.safeParse([]).success).toBe(false);
  });
});

/**
 * PR 8b widens the read contracts for product and category settings (plan 4.2).
 * Nothing sends the new values until such settings are saved, and every payload
 * built from today's sources parses, and reads, as before.
 */
describe("listing settings contracts: product and category values", () => {
  const RECIPE = { basis: "product_cost", markupBps: 2_000, flatCents: 100, rounding: "cent" } as const;
  const value = (source: string, ruleName: string | null) =>
    [{ value: { policyId: "F1" }, sources: [{ source, ruleName, productVariantIds: [11] }] }];
  const unset = <T>(value: T, source = "none") => [{ value, sources: [{ source, ruleName: null, productVariantIds: [11] }] }];
  /** A one-size product whose shipping policy comes from `source`; every other setting is unset. */
  const detail = (source: string, ruleName: string | null, ownSettings: string[]) => ({
    storeConnectionId: 5,
    product: { productId: 7, productName: "Toploader 35pt", category: "Toploaders", sizesChosen: 1, sizesTotal: 1,
      priceRange: { minCents: 1_499, maxCents: 1_499 }, exactPriceCount: 1, ownSettings, sizesDiffer: [], fixes: [] },
    settings: {
      shippingPolicy: value(source, ruleName),
      returnPolicy: unset({ policyId: null }),
      paymentPolicy: unset({ policyId: null }),
      ebayCategory: unset({ categoryId: null, categoryName: null }),
      storeShelf: unset({ names: [] }),
      descriptionTemplate: unset({ hasIntroduction: false, hasFooter: false, groupConflict: false }),
      mainText: unset({ own: false }, "catalog"),
    },
    sizes: [{ price: sizePrice, fixes: [], stockUnits: 4 }],
    stock: { state: "ok", checkedAt: "2026-10-06T12:00:00.000Z" },
    generatedAt: "2026-10-06T12:00:00.000Z",
  });

  it("lists the sources closest first and keeps today's sources in today's order", () => {
    expect(LISTING_SETTINGS_VALUE_SOURCES).toEqual(["size", "product", "group_rule", "category", "store_default", "catalog", "none"]);
    const today = ["size", "group_rule", "store_default", "catalog", "none"];
    expect(LISTING_SETTINGS_VALUE_SOURCES.filter((source) => today.includes(source))).toEqual(today);
  });

  it("takes a product value unnamed and a category value named by the category", () => {
    const policy = listingSettingsProductSettingsSchema.shape.shippingPolicy;
    expect(policy.safeParse(value("product", null)).success).toBe(true);
    expect(policy.safeParse(value("product", "Toploader 35pt")).success).toBe(false);
    expect(policy.safeParse(value("category", "Toploaders")).success).toBe(true);
    expect(policy.safeParse(value("category", null)).success).toBe(false);
    expect(policy.safeParse(value("product_default", null)).success).toBe(false);
  });

  it("counts a product's own value as its own setting, and a category's value as not", () => {
    expect(listingSettingsProductDetailSchema.safeParse(detail("product", null, ["shipping_policy"])).success).toBe(true);
    expect(listingSettingsProductDetailSchema.safeParse(detail("product", null, [])).success).toBe(false);
    expect(listingSettingsProductDetailSchema.safeParse(detail("category", "Toploaders", [])).success).toBe(true);
    expect(listingSettingsProductDetailSchema.safeParse(detail("category", "Toploaders", ["shipping_policy"])).success).toBe(false);
    // Today's payloads read as before.
    expect(listingSettingsProductDetailSchema.safeParse(detail("size", null, ["shipping_policy"])).success).toBe(true);
    expect(listingSettingsProductDetailSchema.safeParse(detail("store_default", null, [])).success).toBe(true);
    expect(listingSettingsProductDetailSchema.safeParse(detail("group_rule", "Envelopes", [])).success).toBe(true);
  });

  it("names a product or a category price rule, and keeps today's kinds", () => {
    const priced = (kind: string) => ({ ...sizePrice, source: "rules", basis: "product_cost", basisAmountCents: 1_200, settingRevisionId: null,
      rule: { kind, name: "Toploaders", recipe: RECIPE } });
    for (const kind of ["store_default", "group", "product", "category"]) {
      expect(listingSettingsSizePriceSchema.parse(priced(kind))).toEqual(priced(kind));
    }
    expect(listingSettingsSizePriceSchema.safeParse(priced("size")).success).toBe(false);
  });

  it("sends the rule level on a price answer and a review row only for the new levels", () => {
    expect(RULE_PRICE_LEVELS).toEqual(["product", "category"]);
    const answer = { storeConnectionId: 5, productVariantId: 11, revisionId: null, overridePriceCents: null,
      effectivePriceCents: 1_499, defaultPriceCents: 1_299, source: "rules", ruleName: "Store default rule", updatedAt: null };
    const parsedAnswer = listingPriceSettingSchema.parse(answer);
    expect(parsedAnswer).toEqual(answer);
    expect("ruleLevel" in parsedAnswer).toBe(false);
    expect(listingPriceSettingSchema.parse({ ...answer, ruleName: "Category price", ruleLevel: "category" }).ruleLevel).toBe("category");
    expect(listingPriceSettingSchema.safeParse({ ...answer, ruleLevel: "store_default" }).success).toBe(false);

    const row = { productVariantId: 11, title: "Toploader 35pt", sku: "TL-35-25", previousPriceCents: 1_299, priceCents: 1_499,
      productCostCents: 1_200, ruleName: "Store default rule", preserved: false, issues: [], settingRevisionId: null,
      evidenceHash: "a".repeat(64) };
    const parsedRow = pricingImpactRowSchema.parse(row);
    // A stored review row from before this field existed parses unchanged, so it hashes the same.
    expect(JSON.stringify(parsedRow)).toBe(JSON.stringify(row));
    expect(pricingImpactRowSchema.parse({ ...row, ruleName: "Product price", ruleLevel: "product" }).ruleLevel).toBe("product");
    expect(pricingImpactRowSchema.safeParse({ ...row, ruleLevel: "group" }).success).toBe(false);
  });

  it("leaves the rule level off every result the store's pricing rules give", () => {
    const profile: PricingProfile = { defaultRecipe: RECIPE, groups: [
      { id: "sleeves", name: "Sleeves", priority: 1, scope: { type: "category", category: "Sleeves" }, recipe: RECIPE },
      { id: "tie-a", name: "Tie A", priority: 2, scope: { type: "category", category: "Binders" }, recipe: RECIPE },
      { id: "tie-b", name: "Tie B", priority: 2, scope: { type: "category", category: "Binders" }, recipe: RECIPE },
    ] };
    const resolve = (category: string, withProfile = true) => resolvePricingRule({ profile: withProfile ? profile : null,
      candidate: { productVariantId: 11, productId: 7, category, categoryId: 3, productLineIds: [] },
      productCostCents: 1_000, catalogRetailCents: 1_499 });
    for (const result of [resolve("Mailers"), resolve("Sleeves"), resolve("Binders"), resolve("Mailers", false)]) {
      expect("ruleLevel" in result).toBe(false);
    }
  });

  it("reads an eBay category review without product or category counts as before", () => {
    expect(ebayCategorySourceValues).toEqual(["product", "rule", "category", "store_default", "catalog", "none"]);
    const review = { expectedRevisionId: null, selectedCount: 3, changedCount: 1, unchangedCount: 2, withoutCategoryBefore: 1,
      withoutCategoryAfter: 0, bySource: { rule: 1, store_default: 2, catalog: 0, none: 0 }, byRule: [], byCategory: [],
      otherCategoriesCount: 0, changes: [] };
    expect(JSON.stringify(ebayCategoryRulesReviewSchema.parse(review))).toBe(JSON.stringify(review));
    const withNew = { ...review, bySource: { ...review.bySource, product: 2, category: 1 } };
    expect(ebayCategoryRulesReviewSchema.parse(withNew)).toEqual(withNew);
    expect(ebayCategoryRulesReviewSchema.safeParse({ ...review, bySource: { ...review.bySource, size: 1 } }).success).toBe(false);
    expect(ebayCategoryRulesReviewSchema.safeParse({ ...review, bySource: { ...review.bySource, product: -1 } }).success).toBe(false);
    const change = { productVariantId: 11, sku: null, title: "Toploader 35pt",
      before: { categoryId: null, categoryName: null, source: "none", ruleId: null },
      after: { categoryId: SLEEVES.categoryId, categoryName: SLEEVES.categoryName, source: "category", ruleId: null } };
    expect(ebayCategoryRulesReviewSchema.safeParse({ ...review, changes: [change] }).success).toBe(true);
  });

  it("builds today's eBay category review counts, with no product or category key", () => {
    const review = summarizeEbayCategoryRulesReview({
      expectedRevisionId: null,
      candidates: [
        categoryCandidate({ productVariantId: 1, category: "Mailers", categoryId: 3 }),
        categoryCandidate({ productVariantId: 2, category: "Sleeves", categoryId: 4 }),
        categoryCandidate({ productVariantId: 3, category: "Binders", categoryId: null, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null }),
      ],
      before: prepareEbayCategoryRules(null, null),
      after: prepareEbayCategoryRules(2, rulesProfile({ defaultCategory: MAILERS,
        rules: [{ id: "sleeves", name: "Sleeves", scope: { type: "category", category: "Sleeves" }, category: SLEEVES }] })),
    });
    expect(Object.keys(review.bySource)).toEqual(["rule", "store_default", "catalog", "none"]);
    expect(review.bySource).toEqual({ rule: 1, store_default: 2, catalog: 0, none: 0 });
    expect(ebayCategoryRulesReviewSchema.parse(review)).toEqual(review);
  });
});

describe("product ids read and category filters (plan PR 9, section 4.2)", () => {
  it("takes the Products tab's search and filter, an optional category and product, and no page", () => {
    expect(listingSettingsProductIdsInputSchema.parse({ storeConnectionId: 22 })).toEqual({ storeConnectionId: 22, search: "", show: "all" });
    expect(listingSettingsProductIdsInputSchema.parse({ storeConnectionId: 22, search: " sleeve ", show: "own_settings", categoryId: 3, productId: 7 }))
      .toEqual({ storeConnectionId: 22, search: "sleeve", show: "own_settings", categoryId: 3, productId: 7 });
    for (const bad of [{ page: 0 }, { show: "retail_fallback" }, { categoryId: 0 }, { productId: 2_147_483_648 }, { categoryId: "3" }]) {
      expect(listingSettingsProductIdsInputSchema.safeParse({ storeConnectionId: 22, ...bad }).success).toBe(false);
    }
  });

  it("answers every row once, as many rows as the total, up to 10,000", () => {
    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ productId: index + 1, revisionId: index % 2 ? index : null }));
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 10_000, rows: rows(10_000) }).success).toBe(true);
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 0, rows: [] }).success).toBe(true);
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 10_001, rows: rows(10_001) }).success).toBe(false);
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 3, rows: rows(2) }).success).toBe(false);
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 2, rows: [{ productId: 1, revisionId: null }, { productId: 1, revisionId: 4 }] }).success)
      .toBe(false);
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 1, rows: [{ productId: 1, revisionId: 0 }] }).success).toBe(false);
    expect(listingSettingsProductIdsResponseSchema.safeParse({ total: 1, rows: [{ productId: 1, revisionId: null, name: "x" }] }).success).toBe(false);
  });

  it("lets the Products and Prices tabs narrow to a category, and still works without one", () => {
    expect(listingSettingsProductsInputSchema.parse({ storeConnectionId: 22, categoryId: 3 })).toMatchObject({ categoryId: 3 });
    expect(listingSettingsPricesInputSchema.parse({ storeConnectionId: 22, categoryId: 3 })).toMatchObject({ categoryId: 3 });
    expect(listingSettingsProductsInputSchema.parse({ storeConnectionId: 22 })).not.toHaveProperty("categoryId");
    expect(listingSettingsPricesInputSchema.safeParse({ storeConnectionId: 22, categoryId: -1 }).success).toBe(false);
  });
});

describe("category reads (plan PR 9, sections 8.3, 8.11)", () => {
  const GENERATED_AT = "2026-10-06T12:00:00.000Z";
  const list = (fields: Record<string, unknown> = {}) => ({ storeConnectionId: 5, categories: [
    { categoryId: 3, name: "Sleeves", productCount: 1, revisionId: null, setFields: [] },
    { categoryId: 1, name: "Toploaders", productCount: 2, revisionId: 41, setFields: ["price", "storeShelf"] },
  ], uncategorizedProductCount: 1, generatedAt: GENERATED_AT, ...fields });
  const none = { source: "none", value: null } as const;
  const settings = {
    price: { source: "category", value: { basis: "catalog_retail", markupBps: 0, flatCents: 100, rounding: "cent" } },
    ebayCategory: { source: "store_default", value: { categoryId: "183438", categoryName: "Toploaders" } },
    storeShelf: { source: "category", value: { mode: "own", shelves: [{ id: "11", name: "Supplies:Top" }] } },
    shippingPolicy: { source: "store_default", value: { id: "ship-a", name: null } },
    returnPolicy: { source: "category", value: { id: "return-a", name: "Thirty days" } },
    paymentPolicy: none,
    textAbove: { source: "category", value: { mode: "none" } },
    textBelow: { source: "store_default", value: { mode: "own", text: "Shipped in a rigid mailer." } },
  } as const;
  const detail = (fields: Record<string, unknown> = {}) => ({ storeConnectionId: 5, categoryId: 1, name: "Toploaders", productCount: 2,
    revisionId: 41, settings, ownValues: [{ productId: 7, revisionId: null, fields: ["shippingPolicy"] }], examples: [sizePrice],
    generatedAt: GENERATED_AT, ...fields });

  it("takes a store and a category id, and nothing else", () => {
    expect(listingSettingsCategoryInputSchema.parse({ storeConnectionId: 5, categoryId: 3 })).toEqual({ storeConnectionId: 5, categoryId: 3 });
    for (const input of [{ storeConnectionId: 5 }, { storeConnectionId: 5, categoryId: 0 }, { storeConnectionId: 5, categoryId: 2_147_483_648 },
      { storeConnectionId: 5, categoryId: 3, page: 0 }]) {
      expect(listingSettingsCategoryInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("lists categories strictly: each once, with a positive product count and set fields only on a row", () => {
    expect(listingSettingsCategoriesResponseSchema.safeParse(list()).success).toBe(true);
    expect(listingSettingsCategoriesResponseSchema.safeParse(list({ categories: [] })).success).toBe(true);
    for (const broken of [
      list({ extra: true }),
      list({ categories: [{ categoryId: 1, name: "Toploaders", productCount: 2, revisionId: 41, setFields: [], color: "red" }] }),
      list({ categories: [{ categoryId: 1, name: "A", productCount: 1, revisionId: 41, setFields: [] },
        { categoryId: 1, name: "B", productCount: 1, revisionId: 42, setFields: [] }] }),
      list({ categories: [{ categoryId: 1, name: "Toploaders", productCount: 0, revisionId: null, setFields: [] }] }),
      list({ categories: [{ categoryId: 1, name: "", productCount: 1, revisionId: null, setFields: [] }] }),
      list({ categories: [{ categoryId: 1, name: "Toploaders", productCount: 1, revisionId: null, setFields: ["price"] }] }),
      list({ categories: [{ categoryId: 1, name: "Toploaders", productCount: 1, revisionId: 41, setFields: ["mainText"] }] }),
      list({ categories: [{ categoryId: 1, name: "Toploaders", productCount: 1, revisionId: 41, setFields: ["price", "price"] }] }),
      list({ uncategorizedProductCount: -1 }),
    ]) {
      expect(listingSettingsCategoriesResponseSchema.safeParse(broken).success).toBe(false);
    }
  });

  it("gives one category's settings strictly: a value exactly when one applies, own values once each", () => {
    expect(listingSettingsCategoryDetailSchema.safeParse(detail()).success).toBe(true);
    // A category with no row: every setting from the store default or none.
    expect(listingSettingsCategoryDetailSchema.safeParse(detail({ revisionId: null,
      settings: Object.fromEntries(Object.keys(settings).map((key) => [key, none])), ownValues: [], examples: [] })).success).toBe(true);
    for (const broken of [
      detail({ extra: true }),
      detail({ revisionId: null }),
      detail({ settings: { ...settings, paymentPolicy: { source: "none", value: { id: "pay-a", name: null } } } }),
      detail({ settings: { ...settings, paymentPolicy: { source: "category", value: null } } }),
      detail({ settings: { ...settings, price: { source: "group_rule", value: null } } }),
      detail({ settings: { ...settings, mainText: none } }),
      detail({ settings: { ...settings, textAbove: { source: "category", value: { mode: "own", text: "" } } } }),
      detail({ settings: { ...settings, storeShelf: { source: "category", value: { mode: "own", shelves: [] } } } }),
      detail({ ownValues: [{ productId: 7, revisionId: null, fields: [] }] }),
      detail({ ownValues: [{ productId: 7, revisionId: null, fields: ["mainText"] }] }),
      detail({ ownValues: [{ productId: 7, revisionId: null, fields: ["price"] }, { productId: 7, revisionId: 3, fields: ["price"] }] }),
      detail({ ownValues: [1, 2, 3].map((productId) => ({ productId, revisionId: null, fields: ["price"] })) }),
      detail({ examples: [sizePrice, sizePrice, sizePrice, sizePrice] }),
      detail({ productCount: 0, ownValues: [] }),
    ]) {
      expect(listingSettingsCategoryDetailSchema.safeParse(broken).success).toBe(false);
    }
  });
});
