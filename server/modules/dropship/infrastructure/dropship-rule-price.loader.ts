import type { PoolClient } from "pg";
import { createRulePriceResolver, type ListingRulePrice, type RulePriceCandidate, type RulePriceContext } from "../application/dropship-rule-price";
import { readPricingProfile } from "./dropship-pricing-profile.reader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

/** A store's rule-price context, read in the caller's transaction. */
export async function loadRulePriceContext(client: Pick<PoolClient, "query">, input: {
  vendorId: number; storeConnectionId: number;
}): Promise<RulePriceContext> {
  return { state: await readPricingProfile(client, input.storeConnectionId, input.vendorId) };
}

/**
 * The rule prices of a batch of sizes, as every listing path reads them: the
 * store's context, then the sizes' .ops costs in one read, then the shared
 * resolver. Empty when the store has no pricing rules, and then no cost is read.
 */
export async function loadListingRulePrices(client: Pick<PoolClient, "query">, input: {
  vendorId: number; storeConnectionId: number; candidates: readonly RulePriceCandidate[];
}): Promise<Map<number, ListingRulePrice>> {
  const resolver = createRulePriceResolver(await loadRulePriceContext(client, input));
  if (!resolver.configured) return new Map();
  const costs = await PgShellzClubProductCostAdapter.forTransaction(client).loadProductCosts({
    vendorId: input.vendorId, productVariantIds: input.candidates.map((row) => row.productVariantId),
  });
  return new Map(input.candidates.map((candidate) => [candidate.productVariantId,
    resolver.price(candidate, costs.get(candidate.productVariantId) ?? null)]));
}
