import { describe, expect, it } from "vitest";
import {
  prepareEbayCategoryRules,
  resolveEbayListingCategory,
  summarizeEbayCategoryRulesReview,
  type EbayCategoryCandidate,
  type EbayCategoryReviewCandidate,
  type ResolvedEbayListingCategory,
} from "../../application/dropship-ebay-category-resolver";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "../../application/dropship-listing-setting-layers";
import {
  EMPTY_CATEGORY_LISTING_SETTING_VALUES,
  EMPTY_PRODUCT_LISTING_SETTING_VALUES,
} from "../../domain/listing-setting-values";
import {
  MAX_EBAY_CATEGORY_IMPACT_GROUPS,
  MAX_EBAY_CATEGORY_IMPACT_SAMPLES,
  type EbayCategoryRule,
  type EbayCategoryRulesProfile,
} from "../../../../../shared/dropship/ebay-category-rules";
import type {
  CategoryListingSettingRow,
  CategoryListingSettingValues,
  ProductListingSettingRow,
  ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import { MAILERS, SLEEVES, TOPLOADERS, categoryCandidate, rulesProfile } from "../fixtures/ebay-category-rules.fixture";

describe("eBay category resolution", () => {
  it("uses the first matching rule in saved order, not the most specific one", () => {
    const candidate = categoryCandidate({ productId: 7, category: "Mailers" });
    const byCategoryFirst = prepareEbayCategoryRules(3, rulesProfile({ rules: [
      { id: "cat", name: "Mailers group", scope: { type: "category", category: "Mailers" }, category: MAILERS },
      { id: "prod", name: "This product", scope: { type: "product", productId: 7 }, category: TOPLOADERS },
    ] }));
    expect(resolveEbayListingCategory(candidate, byCategoryFirst)).toMatchObject({
      categoryId: MAILERS.categoryId, source: "rule", ruleId: "cat", ruleName: "Mailers group", rulesRevisionId: 3,
    });
    const byProductFirst = prepareEbayCategoryRules(3, rulesProfile({ rules: [
      { id: "prod", name: "This product", scope: { type: "product", productId: 7 }, category: TOPLOADERS },
      { id: "cat", name: "Mailers group", scope: { type: "category", category: "Mailers" }, category: MAILERS },
    ] }));
    expect(resolveEbayListingCategory(candidate, byProductFirst).categoryId).toBe(TOPLOADERS.categoryId);
  });

  it("matches named listings and product lines", () => {
    const prepared = prepareEbayCategoryRules(1, rulesProfile({ rules: [
      { id: "picked", name: "Picked", scope: { type: "listings", productVariantIds: [55] }, category: SLEEVES },
      { id: "line", name: "Line 3", scope: { type: "product_line", productLineId: 3 }, category: TOPLOADERS },
    ] }));
    expect(resolveEbayListingCategory(categoryCandidate({ productVariantId: 55 }), prepared).ruleId).toBe("picked");
    expect(resolveEbayListingCategory(categoryCandidate({ productVariantId: 56, productLineIds: [3] }), prepared).ruleId).toBe("line");
  });

  it("falls back to the store default, then the Card Shellz category, then none", () => {
    const withDefault = prepareEbayCategoryRules(2, rulesProfile({ defaultCategory: SLEEVES }));
    expect(resolveEbayListingCategory(categoryCandidate(), withDefault)).toMatchObject({
      categoryId: SLEEVES.categoryId, categoryName: "Sleeves", source: "store_default", ruleId: null,
    });
    const empty = prepareEbayCategoryRules(null, null);
    expect(resolveEbayListingCategory(categoryCandidate({ ebayBrowseCategoryId: " 184267 ", ebayBrowseCategoryName: " Mailers " }), empty))
      .toMatchObject({ categoryId: "184267", categoryName: "Mailers", source: "catalog", rulesRevisionId: null });
    expect(resolveEbayListingCategory(categoryCandidate({ ebayBrowseCategoryId: "  ", ebayBrowseCategoryName: null }), empty))
      .toMatchObject({ categoryId: null, categoryName: null, source: "none" });
  });

  it("reports the rules revision it resolved under, with the eBay name the rules stored", () => {
    const candidate = categoryCandidate();
    const resolved = resolveEbayListingCategory(candidate, prepareEbayCategoryRules(9, rulesProfile({ defaultCategory: { ...SLEEVES, categoryName: "Renamed" } })));
    expect(resolved).toEqual({ categoryId: SLEEVES.categoryId, categoryName: "Renamed", source: "store_default",
      ruleId: null, ruleName: null, rulesRevisionId: 9 });
  });

  it("resolves 10,000 named listings from one prepared profile without mutating inputs", () => {
    const ids = Array.from({ length: 10_000 }, (_, index) => index + 1);
    const profile = rulesProfile({ rules: [{ id: "bulk", name: "Bulk", scope: { type: "listings", productVariantIds: ids }, category: TOPLOADERS }] });
    const before = structuredClone(profile);
    const prepared = prepareEbayCategoryRules(5, profile);
    for (const productVariantId of ids) {
      expect(resolveEbayListingCategory(categoryCandidate({ productVariantId }), prepared).ruleId).toBe("bulk");
    }
    expect(profile).toEqual(before);
  });
});

describe("eBay category review", () => {
  it("counts only a different published category as a change", () => {
    const candidates = [
      categoryCandidate({ productVariantId: 1, category: "Mailers", ebayBrowseCategoryId: MAILERS.categoryId }),
      categoryCandidate({ productVariantId: 2, category: "Sleeves", ebayBrowseCategoryId: null, ebayBrowseCategoryName: null }),
      categoryCandidate({ productVariantId: 3, category: "Toploaders", ebayBrowseCategoryId: TOPLOADERS.categoryId }),
    ];
    const review = summarizeEbayCategoryRulesReview({
      expectedRevisionId: null,
      candidates,
      before: prepareEbayCategoryRules(null, null),
      after: prepareEbayCategoryRules(null, rulesProfile({
        defaultCategory: MAILERS,
        rules: [
          { id: "sleeves", name: "Sleeves", scope: { type: "category", category: "Sleeves" }, category: SLEEVES },
          { id: "unused", name: "Unused", scope: { type: "category", category: "Nothing" }, category: SLEEVES },
        ],
      })),
    });
    expect(review).toMatchObject({
      selectedCount: 3,
      changedCount: 2,
      unchangedCount: 1,
      withoutCategoryBefore: 1,
      withoutCategoryAfter: 0,
      bySource: { rule: 1, store_default: 2, catalog: 0, none: 0 },
      byRule: [{ ruleId: "sleeves", matched: 1 }, { ruleId: "unused", matched: 0 }],
    });
    expect(review.byCategory).toEqual([
      { categoryId: MAILERS.categoryId, categoryName: "Mailers", count: 2 },
      { categoryId: SLEEVES.categoryId, categoryName: "Sleeves", count: 1 },
    ]);
    expect(review.changes.map((change) => [change.productVariantId, change.before.categoryId, change.after.categoryId])).toEqual([
      [2, null, SLEEVES.categoryId],
      [3, TOPLOADERS.categoryId, MAILERS.categoryId],
    ]);
  });

  it("bounds category groups and change samples and reports the rest as counts", () => {
    const candidates = Array.from({ length: MAX_EBAY_CATEGORY_IMPACT_GROUPS + 10 }, (_, index) => categoryCandidate({
      productVariantId: index + 1, ebayBrowseCategoryId: String(500_000 + index), ebayBrowseCategoryName: `Group ${index}`,
    }));
    const review = summarizeEbayCategoryRulesReview({
      expectedRevisionId: 1,
      candidates,
      before: prepareEbayCategoryRules(1, rulesProfile({ defaultCategory: SLEEVES })),
      after: prepareEbayCategoryRules(1, null),
    });
    expect(review.byCategory).toHaveLength(MAX_EBAY_CATEGORY_IMPACT_GROUPS);
    expect(review.otherCategoriesCount).toBe(10);
    expect(review.changedCount).toBe(candidates.length);
    expect(review.changes).toHaveLength(MAX_EBAY_CATEGORY_IMPACT_SAMPLES);
  });
});

// ---------------------------------------------------------------------------
// Product and category layers (plan PR 8b, section 4.6)
// ---------------------------------------------------------------------------

const STORE_ID = 44;
const SAVED_AT = "2026-10-01T08:30:00.000Z";

/** One older rule of each scope type, in saved order. */
const MAILERS_RULE: EbayCategoryRule = { id: "mailers", name: "Mailers group", scope: { type: "category", category: "Mailers" }, category: MAILERS };
const PRODUCT_RULE: EbayCategoryRule = { id: "product-8", name: "Product 8", scope: { type: "product", productId: 8 }, category: TOPLOADERS };
const LINE_RULE: EbayCategoryRule = { id: "line-4", name: "Line 4", scope: { type: "product_line", productLineId: 4 }, category: SLEEVES };
const PICKED_RULE: EbayCategoryRule = { id: "picked", name: "Picked sizes", scope: { type: "listings", productVariantIds: [205] }, category: TOPLOADERS };
const RULES = [MAILERS_RULE, PRODUCT_RULE, LINE_RULE, PICKED_RULE];

/** Each way a store's rules document can stand today. */
const PROFILES: ReadonlyArray<{ label: string; revisionId: number | null; profile: EbayCategoryRulesProfile | null }> = [
  { label: "never saved", revisionId: null, profile: null },
  { label: "saved empty", revisionId: 1, profile: rulesProfile() },
  { label: "store default only", revisionId: 2, profile: rulesProfile({ defaultCategory: SLEEVES }) },
  { label: "rules only", revisionId: 3, profile: rulesProfile({ rules: RULES }) },
  { label: "rules and store default", revisionId: 4, profile: rulesProfile({ defaultCategory: SLEEVES, rules: RULES }) },
];

/** Each branch of today's resolver: every rule scope, the store default, the trimmed Card Shellz base, a blank base, a base without a name. */
const CANDIDATES = {
  inMailers: categoryCandidate(),
  product8: categoryCandidate({ productVariantId: 202, productId: 8, category: "Toploaders", productLineIds: [] }),
  line4: categoryCandidate({ productVariantId: 203, productId: 9, category: "Sleeves", productLineIds: [4] }),
  picked: categoryCandidate({ productVariantId: 205, productId: 10, category: "Toploaders", productLineIds: [] }),
  base: categoryCandidate({ productVariantId: 206, productId: 11, category: "Boxes", productLineIds: [],
    ebayBrowseCategoryId: " 184268 ", ebayBrowseCategoryName: " Card boxes " }),
  blankBase: categoryCandidate({ productVariantId: 207, productId: 12, category: null, productLineIds: [],
    ebayBrowseCategoryId: "  ", ebayBrowseCategoryName: "Ignored" }),
  unnamedBase: categoryCandidate({ productVariantId: 208, productId: 13, category: "Boxes", productLineIds: [],
    ebayBrowseCategoryId: "184269", ebayBrowseCategoryName: null }),
} satisfies Record<string, EbayCategoryCandidate>;
type CandidateKey = keyof typeof CANDIDATES;

type Pin = Omit<ResolvedEbayListingCategory, "rulesRevisionId">;
const byRule = (rule: EbayCategoryRule): Pin => ({ categoryId: rule.category.categoryId, categoryName: rule.category.categoryName,
  source: "rule", ruleId: rule.id, ruleName: rule.name });
const byStoreDefault: Pin = { categoryId: SLEEVES.categoryId, categoryName: "Sleeves", source: "store_default", ruleId: null, ruleName: null };
const byBase = (categoryId: string, categoryName: string | null): Pin => ({ categoryId, categoryName, source: "catalog", ruleId: null, ruleName: null });
const NO_CATEGORY: Pin = { categoryId: null, categoryName: null, source: "none", ruleId: null, ruleName: null };
const BASE_PINS: Record<CandidateKey, Pin> = {
  inMailers: byBase("184267", "Card Shellz mailers"),
  product8: byBase("184267", "Card Shellz mailers"),
  line4: byBase("184267", "Card Shellz mailers"),
  picked: byBase("184267", "Card Shellz mailers"),
  base: byBase("184268", "Card boxes"),
  blankBase: NO_CATEGORY,
  unnamedBase: byBase("184269", null),
};
const RULE_PINS: Record<"inMailers" | "product8" | "line4" | "picked", Pin> = {
  inMailers: byRule(MAILERS_RULE), product8: byRule(PRODUCT_RULE), line4: byRule(LINE_RULE), picked: byRule(PICKED_RULE),
};

/** Today's result for every fixture case, pinned against the resolver before product and category settings existed. */
const TODAY: Record<string, Record<CandidateKey, Pin>> = {
  "never saved": BASE_PINS,
  "saved empty": BASE_PINS,
  "store default only": sameForEvery(byStoreDefault),
  "rules only": { ...BASE_PINS, ...RULE_PINS },
  "rules and store default": { ...sameForEvery(byStoreDefault), ...RULE_PINS },
};

function sameForEvery(pin: Pin): Record<CandidateKey, Pin> {
  return Object.fromEntries((Object.keys(CANDIDATES) as CandidateKey[]).map((key) => [key, pin])) as Record<CandidateKey, Pin>;
}

function productRow(productId: number, values: Partial<ProductListingSettingValues>): ProductListingSettingRow {
  return { storeConnectionId: STORE_ID, productId, revisionId: 70 + productId, updatedAt: SAVED_AT,
    values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ...values } };
}

function categoryRow(categoryId: number, values: Partial<CategoryListingSettingValues>): CategoryListingSettingRow {
  return { storeConnectionId: STORE_ID, categoryId, revisionId: 80 + categoryId, updatedAt: SAVED_AT,
    values: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, ...values } };
}

function layersOf(products: readonly ProductListingSettingRow[], categories: readonly CategoryListingSettingRow[] = []): ListingSettingLayers {
  return {
    products: new Map(products.map((row) => [row.productId, row])),
    categories: new Map(categories.map((row) => [row.categoryId, row])),
  };
}

/** Every other setting a product or category can hold, none of them an eBay category. */
const OTHER_SETTINGS: Partial<CategoryListingSettingValues> = {
  price: { basis: "product_cost", markupBps: 3_000, flatCents: 0, rounding: "up_99" },
  storeShelf: { mode: "own", shelves: [{ id: "301", name: "Mailers" }] },
  shippingPolicy: { id: "ship-1", name: "Ground" },
  textAbove: { mode: "own", text: "Ships fast." },
};
const SETTINGS_CATEGORY_ID = 31;

/**
 * Rows that must change nothing: every fixture product and its Card Shellz
 * category set every other setting but no eBay category, and the only rows
 * that do set one belong to a product and a category no fixture size is in.
 */
const QUIET_LAYERS = layersOf(
  [...Object.values(CANDIDATES).map((candidate) => productRow(candidate.productId, OTHER_SETTINGS)),
    productRow(999, { ebayCategory: MAILERS })],
  [categoryRow(SETTINGS_CATEGORY_ID, OTHER_SETTINGS), categoryRow(998, { ebayCategory: TOPLOADERS })],
);

describe("eBay category resolution with product and category settings", () => {
  describe.each(PROFILES)("$label", ({ label, revisionId, profile }) => {
    it.each(Object.keys(CANDIDATES) as CandidateKey[])("%s: empty layers give today's result", (key) => {
      const expected = { ...TODAY[label][key], rulesRevisionId: revisionId };
      for (const categoryId of [null, SETTINGS_CATEGORY_ID]) {
        const candidate = { ...CANDIDATES[key], categoryId };
        expect(resolveEbayListingCategory(candidate, prepareEbayCategoryRules(revisionId, profile))).toEqual(expected);
        expect(resolveEbayListingCategory(candidate, prepareEbayCategoryRules(revisionId, profile, EMPTY_LISTING_SETTING_LAYERS)))
          .toEqual(expected);
        expect(resolveEbayListingCategory(candidate, prepareEbayCategoryRules(revisionId, profile, QUIET_LAYERS))).toEqual(expected);
      }
    });

    it("the review of every fixture size is byte-identical with empty layers, with today's four counts", () => {
      const candidates = Object.values(CANDIDATES).map((candidate, index) =>
        reviewCandidate({ ...candidate, categoryId: index % 2 === 0 ? null : SETTINGS_CATEGORY_ID }));
      const before = prepareEbayCategoryRules(revisionId, profile);
      for (const after of PROFILES) {
        const today = summarizeEbayCategoryRulesReview({ expectedRevisionId: revisionId, candidates, before,
          after: prepareEbayCategoryRules(revisionId, after.profile) });
        for (const layers of [EMPTY_LISTING_SETTING_LAYERS, QUIET_LAYERS]) {
          const review = summarizeEbayCategoryRulesReview({ expectedRevisionId: revisionId, candidates,
            before: prepareEbayCategoryRules(revisionId, profile, layers), after: prepareEbayCategoryRules(revisionId, after.profile, layers) });
          expect(JSON.stringify(review)).toBe(JSON.stringify(today));
          expect(Object.keys(review.bySource)).toEqual(["rule", "store_default", "catalog", "none"]);
        }
      }
    });
  });

  it("pins today's review counts for the fixture sizes under rules and a store default", () => {
    const candidates = Object.values(CANDIDATES).map((candidate) => reviewCandidate(candidate));
    const review = summarizeEbayCategoryRulesReview({ expectedRevisionId: 4, candidates,
      before: prepareEbayCategoryRules(null, null), after: prepareEbayCategoryRules(4, rulesProfile({ defaultCategory: SLEEVES, rules: RULES })) });
    expect(review.bySource).toEqual({ rule: 4, store_default: 3, catalog: 0, none: 0 });
    expect(review.byRule).toEqual(RULES.map((rule) => ({ ruleId: rule.id, matched: 1 })));
    expect(review).toMatchObject({ selectedCount: 7, changedCount: 7, withoutCategoryBefore: 1, withoutCategoryAfter: 0 });
  });

  it("a product's own eBay category beats every older rule, including a named-size rule", () => {
    const prepared = prepareEbayCategoryRules(4, rulesProfile({ defaultCategory: SLEEVES, rules: RULES }), layersOf(
      [productRow(7, { ebayCategory: SLEEVES }), productRow(8, { ebayCategory: MAILERS }), productRow(10, { ebayCategory: SLEEVES })],
      [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: TOPLOADERS })],
    ));
    for (const [candidate, category] of [
      [CANDIDATES.inMailers, SLEEVES], [CANDIDATES.product8, MAILERS], [CANDIDATES.picked, SLEEVES],
    ] as const) {
      expect(resolveEbayListingCategory({ ...candidate, categoryId: SETTINGS_CATEGORY_ID }, prepared)).toEqual({
        categoryId: category.categoryId, categoryName: category.categoryName, source: "product", ruleId: null, ruleName: null, rulesRevisionId: 4,
      });
    }
  });

  it("an older rule beats the product's category setting", () => {
    const prepared = prepareEbayCategoryRules(3, rulesProfile({ rules: RULES }), layersOf(
      [productRow(7, { ebayCategory: null, storeShelf: { mode: "none" } })],
      [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: TOPLOADERS })],
    ));
    expect(resolveEbayListingCategory({ ...CANDIDATES.inMailers, categoryId: SETTINGS_CATEGORY_ID }, prepared))
      .toEqual({ ...byRule(MAILERS_RULE), rulesRevisionId: 3 });
    expect(resolveEbayListingCategory({ ...CANDIDATES.line4, categoryId: SETTINGS_CATEGORY_ID }, prepared))
      .toEqual({ ...byRule(LINE_RULE), rulesRevisionId: 3 });
  });

  it("the category setting beats the store default and the Card Shellz base", () => {
    const layers = layersOf([], [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: TOPLOADERS })]);
    const fromCategory = { categoryId: TOPLOADERS.categoryId, categoryName: "Toploaders", source: "category", ruleId: null, ruleName: null };
    for (const { revisionId, profile } of PROFILES) {
      for (const key of ["base", "blankBase", "unnamedBase"] as const) {
        expect(resolveEbayListingCategory({ ...CANDIDATES[key], categoryId: SETTINGS_CATEGORY_ID },
          prepareEbayCategoryRules(revisionId, profile, layers))).toEqual({ ...fromCategory, rulesRevisionId: revisionId });
      }
    }
  });

  it("a product with no Card Shellz category skips every category setting", () => {
    const layers = layersOf([], [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: TOPLOADERS })]);
    for (const { label, revisionId, profile } of PROFILES) {
      const prepared = prepareEbayCategoryRules(revisionId, profile, layers);
      for (const key of Object.keys(CANDIDATES) as CandidateKey[]) {
        expect(resolveEbayListingCategory({ ...CANDIDATES[key], categoryId: null }, prepared))
          .toEqual({ ...TODAY[label][key], rulesRevisionId: revisionId });
      }
      // Another category's setting is not this product's either.
      expect(resolveEbayListingCategory({ ...CANDIDATES.base, categoryId: SETTINGS_CATEGORY_ID + 1 }, prepared))
        .toEqual({ ...TODAY[label].base, rulesRevisionId: revisionId });
    }
  });

  it("prepares the layers once without changing them, and resolves to the eBay id and name stored at save", () => {
    const layers = layersOf([productRow(7, { ebayCategory: SLEEVES })], [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: TOPLOADERS })]);
    const before = structuredClone(layers);
    const prepared = prepareEbayCategoryRules(null, null, layers);
    expect([...prepared.productCategories]).toEqual([[7, SLEEVES]]);
    expect([...prepared.categoryCategories]).toEqual([[SETTINGS_CATEGORY_ID, TOPLOADERS]]);
    expect(prepareEbayCategoryRules(null, null).productCategories.size).toBe(0);
    expect(prepareEbayCategoryRules(null, null).categoryCategories.size).toBe(0);
    expect(resolveEbayListingCategory(CANDIDATES.inMailers, prepared)).toEqual({ categoryId: SLEEVES.categoryId, categoryName: "Sleeves",
      source: "product", ruleId: null, ruleName: null, rulesRevisionId: null });
    expect(layers).toEqual(before);
  });
});

describe("eBay category review with product and category settings", () => {
  const sizes = [
    reviewCandidate({ ...CANDIDATES.inMailers, productVariantId: 1 }),
    reviewCandidate({ ...CANDIDATES.product8, productVariantId: 2, categoryId: SETTINGS_CATEGORY_ID }),
    reviewCandidate({ ...CANDIDATES.base, productVariantId: 3, categoryId: SETTINGS_CATEGORY_ID }),
    reviewCandidate({ ...CANDIDATES.blankBase, productVariantId: 4 }),
  ];
  const layers = layersOf([productRow(7, { ebayCategory: TOPLOADERS })], [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: MAILERS })]);

  it("counts the product and category sources, after today's four, only when some size gets its category there", () => {
    const review = summarizeEbayCategoryRulesReview({ expectedRevisionId: 3, candidates: sizes,
      before: prepareEbayCategoryRules(3, rulesProfile({ rules: RULES }), layers),
      after: prepareEbayCategoryRules(3, rulesProfile({ defaultCategory: SLEEVES, rules: RULES }), layers) });
    expect(review.bySource).toEqual({ rule: 1, store_default: 1, catalog: 0, none: 0, product: 1, category: 1 });
    expect(Object.keys(review.bySource)).toEqual(["rule", "store_default", "catalog", "none", "product", "category"]);
    // Rules matched only by the size that a rule decides; the product's own category and the category setting are not rules.
    expect(review.byRule).toEqual([
      { ruleId: "mailers", matched: 0 }, { ruleId: "product-8", matched: 1 }, { ruleId: "line-4", matched: 0 }, { ruleId: "picked", matched: 0 },
    ]);
    // Only the size with nothing closer than the new store default changes.
    expect(review).toMatchObject({ changedCount: 1, unchangedCount: 3, withoutCategoryBefore: 1, withoutCategoryAfter: 0 });
    expect(review.changes).toEqual([{ productVariantId: 4, sku: "ARM-50", title: "Armalope pack",
      before: { categoryId: null, categoryName: null, source: "none", ruleId: null },
      after: { categoryId: SLEEVES.categoryId, categoryName: "Sleeves", source: "store_default", ruleId: null } }]);
  });

  it("sends a new count only when it is not zero", () => {
    const onlyCategory = layersOf([], [categoryRow(SETTINGS_CATEGORY_ID, { ebayCategory: MAILERS })]);
    const review = summarizeEbayCategoryRulesReview({ expectedRevisionId: null, candidates: sizes,
      before: prepareEbayCategoryRules(null, null, onlyCategory), after: prepareEbayCategoryRules(null, null, onlyCategory) });
    expect(review.bySource).toEqual({ rule: 0, store_default: 0, catalog: 1, none: 1, category: 2 });
    expect(review.changedCount).toBe(0);
  });
});

function reviewCandidate(candidate: EbayCategoryCandidate): EbayCategoryReviewCandidate {
  return { ...candidate, sku: "ARM-50", title: "Armalope pack", productName: "Armalope" };
}
