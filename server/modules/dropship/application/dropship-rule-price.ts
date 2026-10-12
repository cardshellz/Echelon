import { createHash, type Hash } from "node:crypto";
import {
  resolvePricingRule,
  type PricingProfileState,
  type PricingRecipe,
  type PricingRuleCandidate,
  type RulePriceResult,
} from "../../../../shared/dropship/pricing-rules";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import type { ListingSettingLayers } from "./dropship-listing-setting-layers";
import type { DropshipProductCost } from "./dropship-product-cost";

export interface ListingRulePrice extends RulePriceResult { profileRevisionId: number | null; evidenceHash: string; productCost: DropshipProductCost | null }

/**
 * Everything a store's rule prices are resolved from. Every price path builds
 * one per store and batch: the listing preview and queue, the per-size price,
 * the pricing review, the cost-change classifier and the listing settings
 * facts (Listing settings design 8.3). Both recipe maps are required, so each
 * path decides where its product and category prices come from
 * (rulePriceContextOf).
 */
export interface RulePriceContext {
  state: PricingProfileState;
  /** productId → the product's own price recipe; only products whose listing settings set a price. */
  productRules: ReadonlyMap<number, PricingRecipe>;
  /** catalog.product_categories.id → the category's price recipe; only categories whose listing settings set a price. */
  categoryRules: ReadonlyMap<number, PricingRecipe>;
}

/** A store with no pricing profile, as readPricingProfile returns it. Frozen: shared by every caller. */
export const NO_PRICING_PROFILE_STATE: PricingProfileState = Object.freeze({ revisionId: null, profile: null, updatedAt: null });

/** The store's profile with the price recipes of the products and categories `layers` holds. Pure; reads nothing. */
export function rulePriceContextOf(state: PricingProfileState, layers: ListingSettingLayers): RulePriceContext {
  const productRules = new Map<number, PricingRecipe>();
  for (const [productId, row] of layers.products) {
    if (row.values.price !== null) productRules.set(productId, row.values.price);
  }
  const categoryRules = new Map<number, PricingRecipe>();
  for (const [categoryId, row] of layers.categories) {
    if (row.values.price !== null) categoryRules.set(categoryId, row.values.price);
  }
  return { state, productRules, categoryRules };
}

export type RulePriceCandidate = PricingRuleCandidate & { defaultRetailPriceCents: number | null };

export interface RulePriceResolver {
  /**
   * True when something can price the size by rule: the store's pricing
   * profile, the product's own price, or its Card Shellz category's price.
   * Only a covered size has a rule price (or the reason the rules give none);
   * an uncovered one is priced as a store without rules prices it.
   */
  covers(candidate: RulePriceCandidate): boolean;
  /** A size's rule price with the evidence a listing shows and a queued push re-checks. */
  price(candidate: RulePriceCandidate, cost: DropshipProductCost | null): ListingRulePrice;
  /** The rule price at a given .ops cost, without evidence: what the size would cost if its cost moved. */
  priceAtCost(candidate: RulePriceCandidate, productCostCents: number | null): RulePriceResult;
}

/**
 * The evidence hash has two recipes (plan D14):
 *
 * - Priced by the store's profile (the store default, an older group rule, a
 *   tie) or by nothing: the sha256 of
 *   `JSON.stringify({ profile, productVariantId, productId, category, productLineIds, catalogRetailCents, cost, price })`,
 *   byte for byte what it was before product and category prices existed, so
 *   no stored evidence changes. The profile comes first and is the same for
 *   every size of a batch, and it can be tens of kilobytes. Its bytes are
 *   hashed once, and each size continues from a copy of that hash state. The
 *   digest is the one hashing the whole string gives: rule-price-golden.test.ts
 *   pins it.
 * - Priced by the product's own price or its category's (`ruleLevel` set):
 *   recipe version 2, the sha256 of
 *   `JSON.stringify({ v: 2, productVariantId, productId, categoryId, catalogRetailCents, cost, price, recipe })`.
 *   It leaves the profile out, so a store default change does not refuse a
 *   queued product-priced size, and hashes the winning recipe, not the
 *   settings revision, so a product save that changes only, say, its shelf
 *   does not refuse a queued price. The price carries the rule id
 *   (`product:<id>` / `category:<id>`), so a change of level always changes
 *   the hash, and the category id, so does a category move.
 *
 * `basis` and `ruleLevel` are left out of the hashed price in both: the basis
 * is in the hashed profile or recipe already, and the level is in the rule id.
 */
export function createRulePriceResolver(context: RulePriceContext): RulePriceResolver {
  const { state, productRules, categoryRules } = context;
  let profilePrefix: Hash | null = null;
  const profileEvidenceHash = (rest: Record<string, unknown>): string => {
    profilePrefix ??= createHash("sha256").update(`{"profile":${JSON.stringify(state)}`);
    const restJson = JSON.stringify(rest);
    // The rest always has fields, so its object opens with "{" and has a body to splice in.
    if (!restJson.startsWith("{") || restJson.length < 3) throw new Error("Rule-price evidence fields are missing.");
    return profilePrefix.copy().update(`,${restJson.slice(1)}`).digest("hex");
  };
  const recipesFor = (candidate: RulePriceCandidate) => ({
    productRecipe: productRules.get(candidate.productId) ?? null,
    categoryRecipe: candidate.categoryId === null ? null : categoryRules.get(candidate.categoryId) ?? null,
  });
  const resolve = (candidate: RulePriceCandidate, productCostCents: number | null, recipes: ReturnType<typeof recipesFor>): RulePriceResult =>
    resolvePricingRule({ profile: state.profile, candidate, productCostCents, catalogRetailCents: candidate.defaultRetailPriceCents, ...recipes });

  return {
    covers: (candidate) => state.profile !== null || productRules.has(candidate.productId)
      || (candidate.categoryId !== null && categoryRules.has(candidate.categoryId)),
    priceAtCost: (candidate, productCostCents) => resolve(candidate, productCostCents, recipesFor(candidate)),
    price(candidate, cost) {
      const recipes = recipesFor(candidate);
      const price = resolve(candidate, cost?.status === "available" ? cost.unitCostCents : null, recipes);
      const { basis: _basis, ruleLevel, ...hashedPrice } = price;
      let evidenceHash: string;
      if (ruleLevel === undefined) {
        // Content evidence, not a fabricated upstream timestamp. It covers the actual
        // basis, source identity, matching inputs and immutable profile revision.
        // The key order is part of the hash: keep it.
        evidenceHash = profileEvidenceHash({ productVariantId: candidate.productVariantId,
          productId: candidate.productId, category: candidate.category,
          productLineIds: [...candidate.productLineIds].sort((a, b) => a - b),
          catalogRetailCents: candidate.defaultRetailPriceCents, cost, price: hashedPrice });
      } else {
        const recipe = ruleLevel === "product" ? recipes.productRecipe : recipes.categoryRecipe;
        if (recipe === null) {
          throw listingSettingsInvariantFailed("A product or category rule price was resolved without its recipe.", {
            ruleLevel, productVariantId: candidate.productVariantId,
          });
        }
        // Recipe version 2. The key order is part of the hash, the recipe's included: keep it.
        evidenceHash = pricingHash({ v: 2, productVariantId: candidate.productVariantId, productId: candidate.productId,
          categoryId: candidate.categoryId, catalogRetailCents: candidate.defaultRetailPriceCents, cost, price: hashedPrice,
          recipe: { basis: recipe.basis, markupBps: recipe.markupBps, flatCents: recipe.flatCents, rounding: recipe.rounding } });
      }
      return { ...price, profileRevisionId: state.revisionId, productCost: cost, evidenceHash };
    },
  };
}

export function pricingHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
