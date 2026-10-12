import { matchesCatalogScope, type CatalogScopeCandidate } from "../../../../shared/dropship/catalog-scope";
import {
  MAX_EBAY_CATEGORY_IMPACT_GROUPS,
  MAX_EBAY_CATEGORY_IMPACT_SAMPLES,
  type EbayCategory,
  type EbayCategoryRule,
  type EbayCategoryRulesProfile,
  type EbayCategoryRulesReview,
  type EbayCategorySource,
} from "../../../../shared/dropship/ebay-category-rules";
import { EMPTY_LISTING_SETTING_LAYERS, type ListingSettingLayers } from "./dropship-listing-setting-layers";

/** A catalog listing as the resolver needs it. The eBay fields carry the Card Shellz base category. */
export interface EbayCategoryCandidate extends CatalogScopeCandidate {
  /** The product's own eBay category, else its product-type mapping on the Card Shellz eBay channel. */
  ebayBrowseCategoryId: string | null;
  ebayBrowseCategoryName: string | null;
  /** The product's Card Shellz category (`catalog.products.category_id`); null when it has none. Category settings key by it. */
  categoryId: number | null;
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
  /** productId → the product's own eBay category. Only products whose settings set one. */
  readonly productCategories: ReadonlyMap<number, EbayCategory>;
  /** catalog.product_categories.id → that Card Shellz category's eBay category. Only categories whose settings set one. */
  readonly categoryCategories: ReadonlyMap<number, EbayCategory>;
}

/**
 * Compile named-listing sets and the product and category eBay categories once
 * per batch so matching stays constant-time per listing. Without layers (or
 * with empty ones) both maps are empty and every listing resolves exactly as
 * before product and category settings existed (plan PR 8b, D1).
 */
export function prepareEbayCategoryRules(
  revisionId: number | null,
  profile: EbayCategoryRulesProfile | null,
  layers: ListingSettingLayers = EMPTY_LISTING_SETTING_LAYERS,
): PreparedEbayCategoryRules {
  return {
    revisionId,
    defaultCategory: profile?.defaultCategory ?? null,
    rules: (profile?.rules ?? []).map((rule) => ({
      rule,
      variantIds: rule.scope.type === "listings" ? new Set(rule.scope.productVariantIds) : null,
    })),
    productCategories: settingCategories(layers.products),
    categoryCategories: settingCategories(layers.categories),
  };
}

/**
 * Closest first (design record 8.3, plan 4.6): the product's own eBay
 * category; the first older rule in saved order whose scope matches (they sit
 * between product and category until PR 11 converts them, plan D16); the
 * product's Card Shellz category's eBay category; the store default; the Card
 * Shellz base; none. A version 2 rules document would put its leftover size
 * entries before the product; only version 1 documents exist before PR 11, so
 * that step is empty here. `ruleId` and `ruleName` stay null for a product or
 * category setting: those are not rules, and a category's name is the live
 * Card Shellz one, which its readers look up (plan 4.6, D19).
 */
export function resolveEbayListingCategory(
  candidate: EbayCategoryCandidate,
  prepared: PreparedEbayCategoryRules,
): ResolvedEbayListingCategory {
  const productCategory = prepared.productCategories.get(candidate.productId);
  if (productCategory) return fromSetting(prepared, productCategory, "product");
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
  // A product with no Card Shellz category follows the store default (R:§5.1).
  const categoryCategory = candidate.categoryId === null ? undefined : prepared.categoryCategories.get(candidate.categoryId);
  if (categoryCategory) return fromSetting(prepared, categoryCategory, "category");
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
  const bySource: Record<EbayCategorySource, number> = { rule: 0, store_default: 0, catalog: 0, none: 0, product: 0, category: 0 };
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
    bySource: reviewBySource(bySource),
    byRule: [...ruleMatches.entries()].map(([ruleId, matched]) => ({ ruleId, matched })),
    byCategory: ranked.slice(0, MAX_EBAY_CATEGORY_IMPACT_GROUPS),
    otherCategoriesCount: ranked.slice(MAX_EBAY_CATEGORY_IMPACT_GROUPS).reduce((total, entry) => total + entry.count, 0),
    changes,
  };
}

/**
 * Today's four counts always, in today's order; the product and category
 * counts only when some listing gets its category there, so the review of a
 * store without product or category settings is byte-identical to before.
 */
function reviewBySource(counts: Readonly<Record<EbayCategorySource, number>>): EbayCategoryRulesReview["bySource"] {
  const { product, category, rule, store_default, catalog, none } = counts;
  return { rule, store_default, catalog, none, ...(product > 0 ? { product } : {}), ...(category > 0 ? { category } : {}) };
}

function resolved(
  prepared: PreparedEbayCategoryRules,
  value: Omit<ResolvedEbayListingCategory, "rulesRevisionId">,
): ResolvedEbayListingCategory {
  return { ...value, rulesRevisionId: prepared.revisionId };
}

/** eBay's id and name as stored at save. As for a rule, the stored path stays out of the result. */
function fromSetting(prepared: PreparedEbayCategoryRules, category: EbayCategory, source: "product" | "category"): ResolvedEbayListingCategory {
  return resolved(prepared, { categoryId: category.categoryId, categoryName: category.categoryName, source, ruleId: null, ruleName: null });
}

/** The rows' eBay categories by the layer's key; a row that follows the default (null) is left out. */
function settingCategories(
  rows: ReadonlyMap<number, { readonly values: { readonly ebayCategory: EbayCategory | null } }>,
): ReadonlyMap<number, EbayCategory> {
  const categories = new Map<number, EbayCategory>();
  for (const [id, row] of rows) {
    if (row.values.ebayCategory !== null) categories.set(id, row.values.ebayCategory);
  }
  return categories;
}

function summary(value: ResolvedEbayListingCategory) {
  return { categoryId: value.categoryId, categoryName: value.categoryName, source: value.source, ruleId: value.ruleId };
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
