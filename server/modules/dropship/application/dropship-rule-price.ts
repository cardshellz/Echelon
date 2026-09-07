import { createHash } from "node:crypto";
import { resolvePricingRule, type PricingProfileState, type PricingRuleCandidate, type RulePriceResult } from "../../../../shared/dropship/pricing-rules";
import type { DropshipProductCost } from "./dropship-product-cost";

export interface ListingRulePrice extends RulePriceResult { profileRevisionId: number | null; evidenceHash: string; productCost: DropshipProductCost | null }
export function resolveListingRulePrice(input: {
  state: PricingProfileState; candidate: PricingRuleCandidate & { defaultRetailPriceCents: number | null };
  cost: DropshipProductCost | null;
}): ListingRulePrice {
  const price = resolvePricingRule({ profile: input.state.profile, candidate: input.candidate,
    productCostCents: input.cost?.status === "available" ? input.cost.unitCostCents : null,
    catalogRetailCents: input.candidate.defaultRetailPriceCents });
  return { ...price, profileRevisionId: input.state.revisionId, productCost: input.cost,
    // Content evidence, not a fabricated upstream timestamp. It covers the actual
    // basis, source identity, matching inputs and immutable profile revision.
    evidenceHash: pricingHash({ profile: input.state, productVariantId: input.candidate.productVariantId,
      productId: input.candidate.productId, category: input.candidate.category,
      productLineIds: [...input.candidate.productLineIds].sort((a, b) => a - b),
      catalogRetailCents: input.candidate.defaultRetailPriceCents, cost: input.cost, price }) };
}
export function pricingHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
