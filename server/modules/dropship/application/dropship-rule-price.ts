import { createHash, type Hash } from "node:crypto";
import {
  resolvePricingRule,
  type PricingProfileState,
  type PricingRuleCandidate,
  type RulePriceResult,
} from "../../../../shared/dropship/pricing-rules";
import type { DropshipProductCost } from "./dropship-product-cost";

export interface ListingRulePrice extends RulePriceResult { profileRevisionId: number | null; evidenceHash: string; productCost: DropshipProductCost | null }

/**
 * Everything a store's rule prices are resolved from. Every price path builds
 * one per store and batch: the listing preview and queue, the per-size price,
 * the pricing review and the cost-change classifier (Listing settings design
 * 8.3). Product and category prices join it there, so each path picks them up
 * without its own change.
 */
export interface RulePriceContext {
  state: PricingProfileState;
}

export type RulePriceCandidate = PricingRuleCandidate & { defaultRetailPriceCents: number | null };

export interface RulePriceResolver {
  /** False when the store has no pricing profile, so its rules price nothing. */
  readonly configured: boolean;
  /** A size's rule price with the evidence a listing shows and a queued push re-checks. */
  price(candidate: RulePriceCandidate, cost: DropshipProductCost | null): ListingRulePrice;
  /** The rule price at a given .ops cost, without evidence: what the size would cost if its cost moved. */
  priceAtCost(candidate: RulePriceCandidate, productCostCents: number | null): RulePriceResult;
}

/**
 * The evidence hash is the sha256 of
 * `JSON.stringify({ profile, productVariantId, productId, category, productLineIds, catalogRetailCents, cost, price })`.
 * The profile comes first and is the same for every size of a batch, and it
 * can be tens of kilobytes. Its bytes are hashed once, and each size continues
 * from a copy of that hash state. The digest is the one hashing the whole
 * string gives: rule-price-golden.test.ts pins it.
 */
export function createRulePriceResolver(context: RulePriceContext): RulePriceResolver {
  const { state } = context;
  let profilePrefix: Hash | null = null;
  const evidenceHash = (rest: Record<string, unknown>): string => {
    profilePrefix ??= createHash("sha256").update(`{"profile":${JSON.stringify(state)}`);
    const restJson = JSON.stringify(rest);
    // The rest always has fields, so its object opens with "{" and has a body to splice in.
    if (!restJson.startsWith("{") || restJson.length < 3) throw new Error("Rule-price evidence fields are missing.");
    return profilePrefix.copy().update(`,${restJson.slice(1)}`).digest("hex");
  };
  const priceAtCost = (candidate: RulePriceCandidate, productCostCents: number | null): RulePriceResult =>
    resolvePricingRule({ profile: state.profile, candidate, productCostCents, catalogRetailCents: candidate.defaultRetailPriceCents });

  return {
    configured: state.profile !== null,
    priceAtCost,
    price(candidate, cost) {
      const price = priceAtCost(candidate, cost?.status === "available" ? cost.unitCostCents : null);
      // The recipe basis is part of the hashed profile already; leaving it out of
      // the price keeps every stored evidence hash valid across the deploy that added it.
      const { basis: _basis, ...hashedPrice } = price;
      return { ...price, profileRevisionId: state.revisionId, productCost: cost,
        // Content evidence, not a fabricated upstream timestamp. It covers the actual
        // basis, source identity, matching inputs and immutable profile revision.
        // The key order is part of the hash: keep it.
        evidenceHash: evidenceHash({ productVariantId: candidate.productVariantId,
          productId: candidate.productId, category: candidate.category,
          productLineIds: [...candidate.productLineIds].sort((a, b) => a - b),
          catalogRetailCents: candidate.defaultRetailPriceCents, cost, price: hashedPrice }) };
    },
  };
}

export function pricingHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
