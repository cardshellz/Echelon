import { z } from "zod";
import { catalogScopeSchema, MAX_NAMED_CATALOG_GROUP_ITEMS, type CatalogScope } from "./catalog-scope";

/**
 * Vendor eBay category rules for one store connection.
 * Design record: docs/DROPSHIP-VENDOR-CATALOG-REDESIGN.md, section 7.
 *
 * A listing's eBay browse category resolves in this order:
 *   1. the first rule, in saved order, whose scope matches the listing;
 *   2. the store default category;
 *   3. the Card Shellz catalog category (the product's own category, else its
 *      product-type mapping on the Card Shellz eBay channel);
 *   4. none, which keeps the listing blocked with `ebay_browse_category_required`.
 *
 * Category names and paths are always looked up at eBay by the server. The
 * client submits category numbers only, so a stored name can never be forged.
 */

/** eBay category ids are positive decimal strings; the catalog stores them in varchar(20). */
export const EBAY_CATEGORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
export const MAX_EBAY_CATEGORY_RULES = 100;
/** Matches catalog.products.ebay_browse_category_name varchar(200). */
export const MAX_EBAY_CATEGORY_NAME_LENGTH = 200;
/** Upper bound on the stored top-level-to-category path. Deeper nodes are refused, not truncated. */
export const MAX_EBAY_CATEGORY_PATH_DEPTH = 12;
/** The admin category search also ignores queries shorter than two characters. */
export const MIN_EBAY_CATEGORY_QUERY_LENGTH = 2;
export const MAX_EBAY_CATEGORY_QUERY_LENGTH = 100;
export const MAX_EBAY_CATEGORY_SEARCH_RESULTS = 20;
export const MAX_EBAY_CATEGORY_CHILDREN = 2_000;
export const MAX_EBAY_CATEGORY_IMPACT_SAMPLES = 50;
export const MAX_EBAY_CATEGORY_IMPACT_GROUPS = 200;

const revisionId = z.number().int().positive().max(2_147_483_647);
const productVariantId = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().nonnegative();
const saveKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const ruleId = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const ruleName = z.string().trim().min(1).max(120);
const categoryName = z.string().trim().min(1).max(MAX_EBAY_CATEGORY_NAME_LENGTH);

export const ebayCategoryIdSchema = z.string().regex(EBAY_CATEGORY_ID_PATTERN, "Use an eBay category number.");

/** A category exactly as eBay names it, with its path from the top level down to and including itself. */
export const ebayCategorySchema = z.object({
  categoryId: ebayCategoryIdSchema,
  categoryName,
  path: z.array(categoryName).min(1).max(MAX_EBAY_CATEGORY_PATH_DEPTH),
}).strict();

function namedListingCount(rules: ReadonlyArray<{ scope: CatalogScope }>): number {
  return rules.reduce((total, rule) => total + (rule.scope.type === "listings" ? rule.scope.productVariantIds.length : 0), 0);
}

/** Two rules on the same group would leave the second one unreachable, so they are refused. */
function groupScopeKey(scope: CatalogScope): string | null {
  switch (scope.type) {
    case "category": return `category:${scope.category}`;
    case "product_line": return `product_line:${scope.productLineId}`;
    case "product": return `product:${scope.productId}`;
    case "listings": return null;
  }
}

function ruleList<T extends z.ZodType<{ id: string; scope: CatalogScope }>>(item: T) {
  return z.array(item).max(MAX_EBAY_CATEGORY_RULES)
    .refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "Rule identities must be unique.")
    .refine((rules) => {
      const keys = rules.map((rule) => groupScopeKey(rule.scope)).filter((key): key is string => key !== null);
      return new Set(keys).size === keys.length;
    }, "Two rules cannot target the same group. Keep one rule per category, product line, or product.")
    .refine((rules) => namedListingCount(rules) <= MAX_NAMED_CATALOG_GROUP_ITEMS,
      "Rules support up to 10,000 named-listing assignments. Use a category, product, or product-line rule for broader coverage.");
}

export const ebayCategoryRuleSchema = z.object({
  id: ruleId, name: ruleName, scope: catalogScopeSchema, category: ebayCategorySchema,
}).strict();

/** Stored document. Array order is precedence: the first matching rule wins. */
export const ebayCategoryRulesProfileSchema = z.object({
  version: z.literal(1),
  defaultCategory: ebayCategorySchema.nullable(),
  rules: ruleList(ebayCategoryRuleSchema),
}).strict();

export const ebayCategoryRulesStateSchema = z.object({
  revisionId: revisionId.nullable(),
  profile: ebayCategoryRulesProfileSchema.nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict();

/** What the vendor submits: category numbers only. */
export const ebayCategoryRuleDraftSchema = z.object({
  id: ruleId, name: ruleName, scope: catalogScopeSchema, categoryId: ebayCategoryIdSchema,
}).strict();

export const ebayCategoryRulesDraftSchema = z.object({
  defaultCategoryId: ebayCategoryIdSchema.nullable(),
  rules: ruleList(ebayCategoryRuleDraftSchema),
}).strict();

export const reviewEbayCategoryRulesInputSchema = z.object({
  expectedRevisionId: revisionId.nullable(),
  draft: ebayCategoryRulesDraftSchema,
}).strict();

export const saveEbayCategoryRulesInputSchema = reviewEbayCategoryRulesInputSchema.extend({
  idempotencyKey: saveKey,
}).strict();

export const saveEbayCategoryRulesResponseSchema = z.object({
  state: ebayCategoryRulesStateSchema,
  idempotentReplay: z.boolean(),
}).strict();

export const ebayCategorySourceValues = ["rule", "store_default", "catalog", "none"] as const;
export type EbayCategorySource = (typeof ebayCategorySourceValues)[number];

const resolvedCategorySummarySchema = z.object({
  categoryId: ebayCategoryIdSchema.nullable(),
  categoryName: z.string().nullable(),
  source: z.enum(ebayCategorySourceValues),
  ruleId: ruleId.nullable(),
}).strict();

/** What a draft would change across the store's selected listings. Nothing is written. */
export const ebayCategoryRulesReviewSchema = z.object({
  expectedRevisionId: revisionId.nullable(),
  selectedCount: count,
  changedCount: count,
  unchangedCount: count,
  withoutCategoryBefore: count,
  withoutCategoryAfter: count,
  bySource: z.object({ rule: count, store_default: count, catalog: count, none: count }).strict(),
  byRule: z.array(z.object({ ruleId, matched: count }).strict()).max(MAX_EBAY_CATEGORY_RULES),
  byCategory: z.array(z.object({
    categoryId: ebayCategoryIdSchema, categoryName: z.string().nullable(), count,
  }).strict()).max(MAX_EBAY_CATEGORY_IMPACT_GROUPS),
  otherCategoriesCount: count,
  changes: z.array(z.object({
    productVariantId, sku: z.string().nullable(), title: z.string(),
    before: resolvedCategorySummarySchema, after: resolvedCategorySummarySchema,
  }).strict()).max(MAX_EBAY_CATEGORY_IMPACT_SAMPLES),
}).strict();

/** A category the vendor can pick. Only leaf categories can be saved. */
export const ebayCategoryOptionSchema = ebayCategorySchema.extend({ leaf: z.boolean() }).strict();

export const ebayCategorySearchQuerySchema = z.string().trim()
  .min(MIN_EBAY_CATEGORY_QUERY_LENGTH).max(MAX_EBAY_CATEGORY_QUERY_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Control characters are not allowed.");

export const ebayCategorySearchResponseSchema = z.object({
  categories: z.array(ebayCategoryOptionSchema).max(MAX_EBAY_CATEGORY_SEARCH_RESULTS),
}).strict();

export const ebayCategoryBrowseResponseSchema = z.object({
  parent: ebayCategoryOptionSchema.nullable(),
  children: z.array(ebayCategoryOptionSchema).max(MAX_EBAY_CATEGORY_CHILDREN),
}).strict();

export const ebayCategoryResponseSchema = z.object({ category: ebayCategoryOptionSchema }).strict();

export type EbayCategory = z.infer<typeof ebayCategorySchema>;
export type EbayCategoryRule = z.infer<typeof ebayCategoryRuleSchema>;
export type EbayCategoryRulesProfile = z.infer<typeof ebayCategoryRulesProfileSchema>;
export type EbayCategoryRulesState = z.infer<typeof ebayCategoryRulesStateSchema>;
export type EbayCategoryRulesDraft = z.infer<typeof ebayCategoryRulesDraftSchema>;
export type ReviewEbayCategoryRulesInput = z.infer<typeof reviewEbayCategoryRulesInputSchema>;
export type SaveEbayCategoryRulesInput = z.infer<typeof saveEbayCategoryRulesInputSchema>;
export type EbayCategoryRulesReview = z.infer<typeof ebayCategoryRulesReviewSchema>;
export type EbayCategoryOption = z.infer<typeof ebayCategoryOptionSchema>;
export type EbayCategoryBrowseResult = z.infer<typeof ebayCategoryBrowseResponseSchema>;
