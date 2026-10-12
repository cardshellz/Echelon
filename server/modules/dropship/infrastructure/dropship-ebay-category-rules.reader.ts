import type { PoolClient } from "pg";
import { ebayCategoryRulesStateSchema, type EbayCategoryRulesState } from "../../../../shared/dropship/ebay-category-rules";
import {
  prepareEbayCategoryRules,
  resolveEbayListingCategory,
  type EbayCategoryCandidate,
  type ResolvedEbayListingCategory,
} from "../application/dropship-ebay-category-resolver";
import type { ListingSettingLayers } from "../application/dropship-listing-setting-layers";
import { readListingSettingLayers } from "./dropship-listing-setting-layers.reader";

type Reader = Pick<PoolClient, "query">;

/** The store's current rules. A store with no saved rules reads as an empty state. */
export async function readEbayCategoryRules(client: Reader, vendorId: number, storeConnectionId: number): Promise<EbayCategoryRulesState> {
  const result = await client.query<{ id: number; profile: unknown; created_at: Date }>(
    `SELECT r.id, r.profile, r.created_at FROM dropship.dropship_ebay_category_rule_profiles p
     JOIN dropship.dropship_ebay_category_rule_revisions r ON r.id = p.revision_id
       AND r.vendor_id = p.vendor_id AND r.store_connection_id = p.store_connection_id
     WHERE p.vendor_id = $1 AND p.store_connection_id = $2`, [vendorId, storeConnectionId]);
  const row = result.rows[0];
  const state = ebayCategoryRulesStateSchema.safeParse(row
    ? { revisionId: row.id, profile: row.profile, updatedAt: row.created_at.toISOString() }
    : { revisionId: null, profile: null, updatedAt: null });
  if (!state.success) throw new Error("Persisted eBay category rules failed their contract.");
  return state.data;
}

/**
 * Each candidate's eBay category under the store's rules and its product and
 * category settings. `layers` is the preview's one read of those settings
 * (plan PR 8b, D26); without it they are read here, on the caller's client,
 * so they share its transaction and snapshot.
 */
export async function readResolvedEbayCategories(client: Reader, input: {
  vendorId: number;
  storeConnectionId: number;
  candidates: readonly EbayCategoryCandidate[];
  layers?: ListingSettingLayers;
}): Promise<Map<number, ResolvedEbayListingCategory>> {
  const state = await readEbayCategoryRules(client, input.vendorId, input.storeConnectionId);
  const layers = input.layers ?? await readListingSettingLayers(client, {
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    candidates: input.candidates,
  });
  const prepared = prepareEbayCategoryRules(state.revisionId, state.profile, layers);
  return new Map(input.candidates.map((candidate) => [candidate.productVariantId, resolveEbayListingCategory(candidate, prepared)]));
}
