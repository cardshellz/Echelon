import { describe, expect, it } from "vitest";
import {
  ebayCategoryEvidenceHash,
  prepareEbayCategoryRules,
  resolveEbayListingCategory,
  summarizeEbayCategoryRulesReview,
} from "../../application/dropship-ebay-category-resolver";
import { MAX_EBAY_CATEGORY_IMPACT_GROUPS, MAX_EBAY_CATEGORY_IMPACT_SAMPLES } from "../../../../../shared/dropship/ebay-category-rules";
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

  it("gives evidence that follows what publishes and ignores rule names and revision numbers", () => {
    const candidate = categoryCandidate();
    const first = resolveEbayListingCategory(candidate, prepareEbayCategoryRules(4, rulesProfile({ defaultCategory: SLEEVES })));
    const renamedRevision = resolveEbayListingCategory(candidate, prepareEbayCategoryRules(9, rulesProfile({ defaultCategory: { ...SLEEVES, categoryName: "Renamed" } })));
    expect(renamedRevision.evidenceHash).toBe(first.evidenceHash);
    const sameCategoryByRule = resolveEbayListingCategory(candidate, prepareEbayCategoryRules(4, rulesProfile({ rules: [
      { id: "all", name: "Everything", scope: { type: "product", productId: candidate.productId }, category: SLEEVES },
    ] })));
    expect(sameCategoryByRule.categoryId).toBe(first.categoryId);
    expect(sameCategoryByRule.evidenceHash).not.toBe(first.evidenceHash);
    expect(first.evidenceHash).toBe(ebayCategoryEvidenceHash({ categoryId: SLEEVES.categoryId, source: "store_default", ruleId: null }));
    expect(first.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
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
