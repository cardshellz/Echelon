import type { PoolClient } from "pg";
import type { ListingSettingLayers } from "../application/dropship-listing-setting-layers";
import {
  createRulePriceResolver, rulePriceContextOf, type ListingRulePrice, type RulePriceCandidate, type RulePriceContext,
} from "../application/dropship-rule-price";
import { readListingSettingLayers } from "./dropship-listing-setting-layers.reader";
import { readPricingProfile } from "./dropship-pricing-profile.reader";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

/**
 * A store's rule-price context for a batch of sizes, read in the caller's
 * transaction: the pricing profile, then the product and category listing
 * settings of those sizes. A caller that already read the layers for the same
 * snapshot passes them (the preview reads them once, plan D26), and then only
 * the profile is read here.
 */
export async function loadRulePriceContext(client: Pick<PoolClient, "query">, input: {
  vendorId: number; storeConnectionId: number; candidates: readonly RulePriceCandidate[]; layers?: ListingSettingLayers;
}): Promise<RulePriceContext> {
  const state = await readPricingProfile(client, input.storeConnectionId, input.vendorId);
  const layers = input.layers ?? await readListingSettingLayers(client, {
    vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, candidates: input.candidates,
  });
  return rulePriceContextOf(state, layers);
}

/**
 * The rule prices of a batch of sizes, as every listing path reads them: the
 * store's context, then the .ops costs of the sizes something can price by
 * rule in one read, then the shared resolver. Only those sizes get an entry.
 * With a pricing profile that is every size, and the cost read is today's;
 * with no profile and no product or category price nothing is covered, and
 * no cost is read.
 */
export async function loadListingRulePrices(client: Pick<PoolClient, "query">, input: {
  vendorId: number; storeConnectionId: number; candidates: readonly RulePriceCandidate[]; layers?: ListingSettingLayers;
}): Promise<Map<number, ListingRulePrice>> {
  const resolver = createRulePriceResolver(await loadRulePriceContext(client, input));
  const covered = input.candidates.filter((candidate) => resolver.covers(candidate));
  if (covered.length === 0) return new Map();
  const costs = await PgShellzClubProductCostAdapter.forTransaction(client).loadProductCosts({
    vendorId: input.vendorId, productVariantIds: covered.map((row) => row.productVariantId),
  });
  return new Map(covered.map((candidate) => [candidate.productVariantId,
    resolver.price(candidate, costs.get(candidate.productVariantId) ?? null)]));
}
