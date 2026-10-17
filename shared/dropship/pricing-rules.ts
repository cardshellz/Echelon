import { z } from "zod";
import { catalogScopeSchema, matchesCatalogScope, catalogTargetsInputSchema, catalogTargetsResponseSchema } from "./catalog-scope";
import { refusingReservedConversionKeys } from "./listing-rules-conversion-keys";
import {
  listingAmountCentsSchema, listingPriceBasisSchema, listingPriceCentsSchema, MAX_LISTING_PRICE_CENTS, rulePriceLevelSchema,
  type RulePriceLevel,
} from "./listing-price";

export const PRICING_REVIEW_PAGE_SIZE = 50;
export const MAX_PRICING_REVIEW_ITEMS = 10_000;
/**
 * What a stored price review checks (= the dropship_pricing_reviews kind
 * CHECK, migration 0740). The kind is a column, never a key of the review's
 * hashed `input`. Rows stored before 0740 read as `store_default`.
 */
export const PRICING_REVIEW_KINDS = ["store_default", "category_price", "product_prices"] as const;
export type PricingReviewKind = (typeof PRICING_REVIEW_KINDS)[number];
const id = z.number().int().positive().max(MAX_LISTING_PRICE_CENTS);
/** A known money amount in integer cents: a cost or a reference retail price. */
export const pricingAmountCentsSchema = listingAmountCentsSchema;
export const pricingRecipeSchema = z.object({
  basis: listingPriceBasisSchema,
  // 100 bps = 1%; this explicit bound permits up to a 10,000% markup.
  markupBps: z.number().int().min(0).max(1_000_000),
  flatCents: z.number().int().min(0).max(MAX_LISTING_PRICE_CENTS),
  rounding: z.enum(["cent", "up_99"]),
}).strict();
export const pricingScopeSchema = catalogScopeSchema;
export const pricingGroupRuleSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(1).max(120), priority: z.number().int().min(1).max(100_000),
  scope: pricingScopeSchema, recipe: pricingRecipeSchema,
}).strict();
export const pricingProfileSchema = z.object({
  defaultRecipe: pricingRecipeSchema,
  groups: z.array(pricingGroupRuleSchema).max(100)
    .refine((groups) => new Set(groups.map((group) => group.id)).size === groups.length, "Rule identities must be unique."),
}).strict();
export const pricingProfileStateSchema = z.object({
  revisionId: id.nullable(), profile: pricingProfileSchema.nullable(), updatedAt: z.string().datetime().nullable(),
}).strict();
export const reviewPricingRulesInputSchema = z.object({
  expectedRevisionId: id.nullable(), profile: pricingProfileSchema, releaseFixedOverrides: z.boolean(),
}).strict();
export const applyPricingRulesInputSchema = z.object({
  reviewId: z.string().uuid(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  // The key lands only in dropship_pricing_applications, which a conversion never writes; the reserved
  // prefixes are refused anyway, so no vendor key on a listing rules save is ever a conversion's.
  idempotencyKey: refusingReservedConversionKeys(z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/)),
}).strict();
export const pricingImpactRowSchema = z.object({
  productVariantId: id, title: z.string(), sku: z.string().nullable(),
  previousPriceCents: listingPriceCentsSchema.nullable(), priceCents: listingPriceCentsSchema.nullable(),
  productCostCents: pricingAmountCentsSchema.nullable(),
  ruleName: z.string().nullable(), preserved: z.boolean(), issues: z.array(z.string()),
  settingRevisionId: id.nullable(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  // The fields below were added after reviews were first stored. They are
  // optional so a stored review without them still parses; applying such a
  // review re-checks it and asks for a fresh review.
  /** The size's own name, such as "Box of 5 Packs of 100". */
  sizeName: z.string().optional(),
  /** What the new price is built from; null for a kept fixed price or when no recipe was chosen. */
  basis: pricingRecipeSchema.shape.basis.nullable().optional(),
  /** The amount the basis starts from; null when that amount is missing. */
  basisCents: pricingAmountCentsSchema.nullable().optional(),
  /** Notes on the new price that never block applying: below the .ops cost, warn-only price limits. */
  warnings: z.array(z.string()).optional(),
  /**
   * Present (true) only for a size saved as "follow the store's pricing"
   * (`inherit`). Applying keeps that setting instead of re-saving the size as
   * `rules`, and its price is the new rule price when the rules give one,
   * else the retail price. Omitted otherwise, so a review stored before this
   * field existed hashes the same.
   */
  followsStorePricing: z.literal(true).optional(),
  /**
   * Present only on a `followsStorePricing` row on its retail price (ruleName
   * RETAIL_FALLBACK_RULE_NAME): why the checked rules give the size no usable
   * price, the rule's issue or `pricing_rule_outside_limit` (a blocking Card
   * Shellz price limit refuses the rule price). Omitted otherwise.
   */
  retailFallbackIssue: z.string().min(1).optional(),
  /**
   * Present only when the product's own price or its category's priced the
   * new price (RulePriceResult.ruleLevel). Omitted for the store's pricing
   * rules, so a review stored before this field existed hashes the same.
   */
  ruleLevel: rulePriceLevelSchema.optional(),
}).strict();
/** The review's rule name for a size that follows the store's pricing but whose rules give it no usable price, so it uses its retail price. */
export const RETAIL_FALLBACK_RULE_NAME = "Retail price (no rule prices this size)";
export const pricingReviewSummarySchema = z.object({
  total: z.number().int().nonnegative(), changed: z.number().int().nonnegative(),
  preserved: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(),
}).strict();
export const pricingReviewResponseSchema = z.object({
  reviewId: z.string().uuid(), reviewHash: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(),
  summary: pricingReviewSummarySchema, rows: z.array(pricingImpactRowSchema), page: z.number().int().nonnegative(),
}).strict();
export type PricingRecipe = z.infer<typeof pricingRecipeSchema>;
export type PricingProfile = z.infer<typeof pricingProfileSchema>;
export type PricingProfileState = z.infer<typeof pricingProfileStateSchema>;
export type ReviewPricingRulesInput = z.infer<typeof reviewPricingRulesInputSchema>;
export type ApplyPricingRulesInput = z.infer<typeof applyPricingRulesInputSchema>;
export type PricingImpactRow = z.infer<typeof pricingImpactRowSchema>;
export type PricingReviewResponse = z.infer<typeof pricingReviewResponseSchema>;
export const pricingTargetsInputSchema = catalogTargetsInputSchema;
export const pricingTargetsResponseSchema = catalogTargetsResponseSchema;

export interface PricingRuleCandidate {
  productVariantId: number; productId: number; category: string | null; productLineIds: readonly number[];
  /**
   * The product's Card Shellz category (`catalog.products.category_id`); null
   * when it has none. Category settings are keyed by it; older group rules
   * keep matching `category` by name.
   */
  categoryId: number | null;
}
export type RulePriceBasis = PricingRecipe["basis"];
/**
 * `basis` names what the winning recipe prices from; null when no recipe was chosen.
 * `ruleLevel` is set only when the product's own price or its category's won
 * (listing settings design 5.1), and absent otherwise, so a store-default,
 * group, tie or no-rule result is unchanged.
 */
export interface RulePriceResult {
  priceCents: number | null; ruleName: string | null; ruleId: string | null; issue: string | null; basis: RulePriceBasis | null;
  ruleLevel?: RulePriceLevel;
}

/** The amount a recipe basis prices from: the .ops cost or the catalog reference retail. */
export function pricingBasisCents(basis: RulePriceBasis, amounts: {
  productCostCents: number | null; catalogRetailCents: number | null;
}): number | null {
  return basis === "product_cost" ? amounts.productCostCents : amounts.catalogRetailCents;
}

/** Pure, integer-only recipe evaluation. No clock, remote reads, or input mutation. */
export function calculateRulePrice(recipeInput: PricingRecipe, basisCents: number | null): RulePriceResult {
  const recipe = pricingRecipeSchema.parse(recipeInput);
  if (basisCents === null || !Number.isSafeInteger(basisCents) || basisCents < 0 || basisCents > MAX_LISTING_PRICE_CENTS) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_basis_unavailable", basis: recipe.basis };
  }
  const denominator = BigInt(10_000);
  const numerator = BigInt(basisCents) * (denominator + BigInt(recipe.markupBps)) + BigInt(recipe.flatCents) * denominator;
  let cents = (numerator + denominator / BigInt(2)) / denominator;
  if (recipe.rounding === "up_99") cents = (cents / BigInt(100)) * BigInt(100) + BigInt(99);
  if (cents <= BigInt(0) || cents > BigInt(MAX_LISTING_PRICE_CENTS)) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_result_out_of_range", basis: recipe.basis };
  }
  return { priceCents: Number(cents), ruleName: null, ruleId: null, issue: null, basis: recipe.basis };
}

/**
 * The names and ids a product's or a category's own price is shown and hashed
 * under (plan D15). A group id cannot contain ":" (pricingGroupRuleSchema), so
 * `product:<id>` and `category:<id>` never collide with a group's. The id is
 * the catalog id, never the category's name: a Card Shellz rename must not
 * change any evidence.
 */
export const PRODUCT_PRICE_RULE_NAME = "Product price";
export const CATEGORY_PRICE_RULE_NAME = "Category price";
export const productPriceRuleId = (productId: number): string => `product:${productId}`;
export const categoryPriceRuleId = (categoryId: number): string => `category:${categoryId}`;

/**
 * The size's rule price, one recipe, never stacked (listing settings design
 * 5.1, plan 4.4): the product's own price, then the store's older group rules
 * (the lowest priority wins; a tie at the top is a conflict), then the
 * product's Card Shellz category's price, then the store default recipe.
 * Nothing set at any level is `pricing_rules_not_configured`.
 *
 * With no product or category recipe the result is today's, field for field
 * and key for key: `ruleLevel` is only ever set for those two levels.
 * `categoryRecipe` is the recipe of the size's own category, so a size with no
 * category (`categoryId` null) cannot have one; passing it anyway is a
 * caller's fault and throws.
 */
export function resolvePricingRule(input: {
  profile: PricingProfile | null; candidate: PricingRuleCandidate;
  productCostCents: number | null; catalogRetailCents: number | null;
  /** The recipe the size's product sets as its own price, when it sets one. */
  productRecipe?: PricingRecipe | null;
  /** The recipe the size's Card Shellz category sets as its price, when it sets one. */
  categoryRecipe?: PricingRecipe | null;
}): RulePriceResult {
  const productRecipe = input.productRecipe ?? null;
  const categoryRecipe = input.categoryRecipe ?? null;
  const { categoryId } = input.candidate;
  if (categoryRecipe !== null && categoryId === null) {
    throw new RangeError("A category price was given for a size whose product has no Card Shellz category.");
  }
  if (productRecipe !== null) {
    return { ...calculateRulePrice(productRecipe, pricingBasisCents(productRecipe.basis, input)),
      ruleName: PRODUCT_PRICE_RULE_NAME, ruleId: productPriceRuleId(input.candidate.productId), ruleLevel: "product" };
  }
  const matches = (input.profile?.groups ?? []).filter(({ scope }) => matchesCatalogScope(scope, input.candidate))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (matches.length > 1 && matches[0].priority === matches[1].priority) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rule_priority_conflict", basis: null };
  }
  const winner = matches[0];
  if (!winner && categoryRecipe !== null && categoryId !== null) {
    return { ...calculateRulePrice(categoryRecipe, pricingBasisCents(categoryRecipe.basis, input)),
      ruleName: CATEGORY_PRICE_RULE_NAME, ruleId: categoryPriceRuleId(categoryId), ruleLevel: "category" };
  }
  if (!input.profile) return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rules_not_configured", basis: null };
  const recipe = winner?.recipe ?? input.profile.defaultRecipe;
  return { ...calculateRulePrice(recipe, pricingBasisCents(recipe.basis, input)),
    ruleName: winner?.name ?? "Store default rule", ruleId: winner?.id ?? null };
}
