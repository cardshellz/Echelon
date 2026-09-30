import { matchesCatalogScope, type CatalogScopeCandidate } from "../../../../shared/dropship/catalog-scope";
import {
  MAX_EBAY_CATEGORY_IMPACT_GROUPS,
  MAX_EBAY_CATEGORY_IMPACT_SAMPLES,
  type EbayCategoryRule,
  type EbayCategoryRulesProfile,
  type EbayCategoryRulesReview,
  type EbayCategorySource,
} from "../../../../shared/dropship/ebay-category-rules";

/** A catalog listing as the resolver needs it. The eBay fields carry the Card Shellz base category. */
export interface EbayCategoryCandidate extends CatalogScopeCandidate {
  /** The product's own eBay category, else its product-type mapping on the Card Shellz eBay channel. */
  ebayBrowseCategoryId: string | null;
  ebayBrowseCategoryName: string | null;
}

export interface ResolvedEbayListingCategory {
  categoryId: string | null;
  categoryName: string | null;
  source: EbayCategorySource;
  ruleId: string | null;
  ruleName: string | null;
  /** The rules revision this was resolved under; null before the store's first save. */
  rulesRevisionId: number | null;
}

export interface PreparedEbayCategoryRules {
  readonly revisionId: number | null;
  readonly defaultCategory: EbayCategoryRulesProfile["defaultCategory"];
  readonly rules: ReadonlyArray<{ readonly rule: EbayCategoryRule; readonly variantIds: ReadonlySet<number> | null }>;
}

/** Compile named-listing sets once per batch so matching stays constant-time per listing. */
export function prepareEbayCategoryRules(revisionId: number | null, profile: EbayCategoryRulesProfile | null): PreparedEbayCategoryRules {
  return {
    revisionId,
    defaultCategory: profile?.defaultCategory ?? null,
    rules: (profile?.rules ?? []).map((rule) => ({
      rule,
      variantIds: rule.scope.type === "listings" ? new Set(rule.scope.productVariantIds) : null,
    })),
  };
}

export function resolveEbayListingCategory(
  candidate: EbayCategoryCandidate,
  prepared: PreparedEbayCategoryRules,
): ResolvedEbayListingCategory {
  const match = prepared.rules.find(({ rule, variantIds }) => variantIds
    ? variantIds.has(candidate.productVariantId)
    : matchesCatalogScope(rule.scope, candidate));
  if (match) {
    return resolved(prepared, {
      categoryId: match.rule.category.categoryId,
      categoryName: match.rule.category.categoryName,
      source: "rule",
      ruleId: match.rule.id,
      ruleName: match.rule.name,
    });
  }
  if (prepared.defaultCategory) {
    return resolved(prepared, {
      categoryId: prepared.defaultCategory.categoryId,
      categoryName: prepared.defaultCategory.categoryName,
      source: "store_default",
      ruleId: null,
      ruleName: null,
    });
  }
  const baseCategoryId = trimmedOrNull(candidate.ebayBrowseCategoryId);
  if (baseCategoryId) {
    return resolved(prepared, {
      categoryId: baseCategoryId,
      categoryName: trimmedOrNull(candidate.ebayBrowseCategoryName),
      source: "catalog",
      ruleId: null,
      ruleName: null,
    });
  }
  return resolved(prepared, { categoryId: null, categoryName: null, source: "none", ruleId: null, ruleName: null });
}

export interface EbayCategoryReviewCandidate extends EbayCategoryCandidate {
  sku: string | null;
  title: string | null;
  productName: string;
}

/**
 * What saving a draft would change, over the store's selected listings. "Changed"
 * means the published eBay category differs; a new source for the same category
 * changes nothing at eBay.
 */
export function summarizeEbayCategoryRulesReview(input: {
  expectedRevisionId: number | null;
  candidates: readonly EbayCategoryReviewCandidate[];
  before: PreparedEbayCategoryRules;
  after: PreparedEbayCategoryRules;
}): EbayCategoryRulesReview {
  const bySource: Record<EbayCategorySource, number> = { rule: 0, store_default: 0, catalog: 0, none: 0 };
  const ruleMatches = new Map(input.after.rules.map(({ rule }) => [rule.id, 0]));
  const categoryCounts = new Map<string, { categoryName: string | null; count: number }>();
  const changes: EbayCategoryRulesReview["changes"] = [];
  let changedCount = 0;
  let withoutCategoryBefore = 0;
  for (const candidate of input.candidates) {
    const before = resolveEbayListingCategory(candidate, input.before);
    const after = resolveEbayListingCategory(candidate, input.after);
    bySource[after.source] += 1;
    if (after.ruleId) ruleMatches.set(after.ruleId, (ruleMatches.get(after.ruleId) ?? 0) + 1);
    if (before.categoryId === null) withoutCategoryBefore += 1;
    if (after.categoryId !== null) {
      const entry = categoryCounts.get(after.categoryId) ?? { categoryName: after.categoryName, count: 0 };
      entry.count += 1;
      categoryCounts.set(after.categoryId, entry);
    }
    if (before.categoryId !== after.categoryId) {
      changedCount += 1;
      if (changes.length < MAX_EBAY_CATEGORY_IMPACT_SAMPLES) {
        changes.push({
          productVariantId: candidate.productVariantId,
          sku: candidate.sku,
          title: candidate.title?.trim() || candidate.productName,
          before: summary(before),
          after: summary(after),
        });
      }
    }
  }
  const ranked = [...categoryCounts.entries()]
    .map(([categoryId, entry]) => ({ categoryId, categoryName: entry.categoryName, count: entry.count }))
    .sort((left, right) => right.count - left.count || left.categoryId.localeCompare(right.categoryId));
  return {
    expectedRevisionId: input.expectedRevisionId,
    selectedCount: input.candidates.length,
    changedCount,
    unchangedCount: input.candidates.length - changedCount,
    withoutCategoryBefore,
    withoutCategoryAfter: bySource.none,
    bySource,
    byRule: [...ruleMatches.entries()].map(([ruleId, matched]) => ({ ruleId, matched })),
    byCategory: ranked.slice(0, MAX_EBAY_CATEGORY_IMPACT_GROUPS),
    otherCategoriesCount: ranked.slice(MAX_EBAY_CATEGORY_IMPACT_GROUPS).reduce((total, entry) => total + entry.count, 0),
    changes,
  };
}

function resolved(
  prepared: PreparedEbayCategoryRules,
  value: Omit<ResolvedEbayListingCategory, "rulesRevisionId">,
): ResolvedEbayListingCategory {
  return { ...value, rulesRevisionId: prepared.revisionId };
}

function summary(value: ResolvedEbayListingCategory) {
  return { categoryId: value.categoryId, categoryName: value.categoryName, source: value.source, ruleId: value.ruleId };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
