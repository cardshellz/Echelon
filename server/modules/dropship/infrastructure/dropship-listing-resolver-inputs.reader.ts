import type { PoolClient } from "pg";
import type {
  DropshipListingResolverInputs,
  DropshipListingResolverInputsLoadInput,
} from "../application/dropship-listing-preview-service";
import { EMPTY_LISTING_SETTING_LAYERS } from "../application/dropship-listing-setting-layers";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { readResolvedEbayCategories } from "./dropship-ebay-category-rules.reader";
import { readResolvedListingContents } from "./dropship-listing-content.reader";
import { readListingSettingLayers } from "./dropship-listing-setting-layers.reader";
import { loadListingRulePrices } from "./dropship-rule-price.loader";

type Reader = Pick<PoolClient, "query">;

/**
 * Refuses a rule-eligible size that is not one of the preview's sizes: the
 * layers are read for `candidates` only, so such a size would be priced and
 * described without its product and category settings. The preview builds
 * the one list by filtering the other (PS generatePreview), so this is a
 * broken contract, fatal, never a guess. No query.
 */
export function assertListingResolverScope(input: DropshipListingResolverInputsLoadInput): void {
  const sizes = new Set(input.candidates.map((candidate) => candidate.productVariantId));
  const outside = input.ruleEligibleCandidates.filter((candidate) => !sizes.has(candidate.productVariantId)).length;
  if (outside > 0) {
    throw listingSettingsInvariantFailed("Rule-eligible sizes must be among the preview's sizes.", {
      storeConnectionId: input.storeConnectionId, outsideCount: outside,
    });
  }
}

/** The answers for a preview with no catalog size: nothing to read. `ebayCategories` only for an eBay store. */
export function emptyListingResolverInputs(platform: DropshipListingResolverInputsLoadInput["platform"]): DropshipListingResolverInputs {
  const empty = { layers: EMPTY_LISTING_SETTING_LAYERS, rulePrices: new Map(), contents: new Map() };
  return platform === "ebay" ? { ...empty, ebayCategories: new Map() } : empty;
}

/**
 * The preview's four resolver inputs (PR 11, plan 7.A, D23), every read on
 * `client` and so in the caller's one transaction and snapshot: the product
 * and category settings of every size, once (plan D26); the rule prices of
 * the rule-eligible sizes with the pricing profile and their .ops costs
 * (the cost read takes its own savepoint, shellz-club-product-cost.adapter);
 * their descriptions with the content profile; and, for an eBay store, every
 * size's eBay category with the rules document. The three loaders are given
 * the layers, so they read no settings again. Same readers, inputs and order
 * as the preview's four separate reads, so an unchanged store gets the same
 * answers. It opens, commits and rolls back nothing and takes no lock; the
 * caller owns the snapshot (PgDropshipListingPreviewRepository
 * .loadResolverInputs). No size, no statement.
 */
export async function readListingResolverInputs(
  client: Reader,
  input: DropshipListingResolverInputsLoadInput,
): Promise<DropshipListingResolverInputs> {
  assertListingResolverScope(input);
  if (input.candidates.length === 0) return emptyListingResolverInputs(input.platform);
  const scope = { vendorId: input.vendorId, storeConnectionId: input.storeConnectionId };
  const layers = await readListingSettingLayers(client, { ...scope, candidates: input.candidates });
  const rulePrices = await loadListingRulePrices(client, { ...scope, candidates: input.ruleEligibleCandidates, layers });
  const contents = await readResolvedListingContents(client, { ...scope, candidates: input.ruleEligibleCandidates, layers });
  if (input.platform !== "ebay") return { layers, rulePrices, contents };
  const ebayCategories = await readResolvedEbayCategories(client, { ...scope, candidates: input.candidates, layers });
  return { layers, rulePrices, contents, ebayCategories };
}
