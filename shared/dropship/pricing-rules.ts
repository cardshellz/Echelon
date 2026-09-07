import { z } from "zod";
import { catalogScopeSchema, matchesCatalogScope, catalogTargetsInputSchema, catalogTargetsResponseSchema } from "./catalog-scope";
import { listingPriceCentsSchema, MAX_LISTING_PRICE_CENTS } from "./listing-price";

export const PRICING_REVIEW_PAGE_SIZE = 50;
export const MAX_PRICING_REVIEW_ITEMS = 10_000;
const id = z.number().int().positive().max(MAX_LISTING_PRICE_CENTS);
export const pricingRecipeSchema = z.object({
  basis: z.enum(["product_cost", "catalog_retail"]),
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
  idempotencyKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/),
}).strict();
export const pricingImpactRowSchema = z.object({
  productVariantId: id, title: z.string(), sku: z.string().nullable(),
  previousPriceCents: listingPriceCentsSchema.nullable(), priceCents: listingPriceCentsSchema.nullable(),
  productCostCents: z.number().int().min(0).max(MAX_LISTING_PRICE_CENTS).nullable(),
  ruleName: z.string().nullable(), preserved: z.boolean(), issues: z.array(z.string()),
  settingRevisionId: id.nullable(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
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
}
export interface RulePriceResult { priceCents: number | null; ruleName: string | null; ruleId: string | null; issue: string | null }

/** Pure, integer-only recipe evaluation. No clock, remote reads, or input mutation. */
export function calculateRulePrice(recipeInput: PricingRecipe, basisCents: number | null): RulePriceResult {
  const recipe = pricingRecipeSchema.parse(recipeInput);
  if (basisCents === null || !Number.isSafeInteger(basisCents) || basisCents < 0 || basisCents > MAX_LISTING_PRICE_CENTS) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_basis_unavailable" };
  }
  const denominator = BigInt(10_000);
  const numerator = BigInt(basisCents) * (denominator + BigInt(recipe.markupBps)) + BigInt(recipe.flatCents) * denominator;
  let cents = (numerator + denominator / BigInt(2)) / denominator;
  if (recipe.rounding === "up_99") cents = (cents / BigInt(100)) * BigInt(100) + BigInt(99);
  if (cents <= BigInt(0) || cents > BigInt(MAX_LISTING_PRICE_CENTS)) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_result_out_of_range" };
  }
  return { priceCents: Number(cents), ruleName: null, ruleId: null, issue: null };
}

export function resolvePricingRule(input: {
  profile: PricingProfile | null; candidate: PricingRuleCandidate;
  productCostCents: number | null; catalogRetailCents: number | null;
}): RulePriceResult {
  if (!input.profile) return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rules_not_configured" };
  const matches = input.profile.groups.filter(({ scope }) => matchesCatalogScope(scope, input.candidate))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  if (matches.length > 1 && matches[0].priority === matches[1].priority) {
    return { priceCents: null, ruleName: null, ruleId: null, issue: "pricing_rule_priority_conflict" };
  }
  const winner = matches[0];
  const recipe = winner?.recipe ?? input.profile.defaultRecipe;
  return { ...calculateRulePrice(recipe, recipe.basis === "product_cost" ? input.productCostCents : input.catalogRetailCents),
    ruleName: winner?.name ?? "Store default rule", ruleId: winner?.id ?? null };
}
