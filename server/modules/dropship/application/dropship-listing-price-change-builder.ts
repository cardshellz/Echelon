import type { SavedListingPriceRevision } from "../../../../shared/dropship/listing-price";
import type { RulePriceResult } from "../../../../shared/dropship/pricing-rules";
import { refuseListingPriceSave, type ListingPriceSaveRefusal } from "../domain/listing-price-save-guard";
import { effectiveSizePrice } from "./dropship-listing-settings-facts";
import {
  evaluateListingPricingPolicy,
  type DropshipPricingPolicyCandidate,
  type DropshipPricingPolicyRecord,
} from "./dropship-listing-preview-service";
import type { DropshipProductCost } from "./dropship-product-cost";
import { createRulePriceResolver, type RulePriceCandidate, type RulePriceContext } from "./dropship-rule-price";

/**
 * Every chosen size's price before and after a listing-settings change (plan
 * PR 9, section 6.4; C-money-3, C-money-6): W5's product price and size
 * prices, and W7's category price and releases (9f).
 *
 * Pure: the caller loads every input inside its write transaction, under the
 * store lock, so "before" is what the store prices today and "after" what it
 * will price once the change commits. Each side uses effectiveSizePrice, the
 * function the read model's size price uses, so "before" is the page's "Now".
 * The resolver takes its recipes as data (RulePriceContext), so the change is
 * two contexts, never a second resolver implementation and never the
 * settings' texts. Nothing is mutated; no clock, no I/O.
 */

/** A chosen size and what its price is resolved from. */
export interface ListingPriceChangeSize {
  candidate: RulePriceCandidate & DropshipPricingPolicyCandidate;
  /** The size's saved price setting now; null when it has none. */
  saved: Pick<SavedListingPriceRevision, "overridePriceCents" | "pricingMode"> | null;
  /** The price an earlier push saved on the size's listing, if any. */
  existingListingPriceCents: number | null;
  cost: DropshipProductCost | null;
}

/** A size price set in this request: a typed price, or the x that releases one. */
export type TypedInRequestPrice = { pricingMode: "fixed"; priceCents: number } | { pricingMode: "inherit" };

export interface ListingPriceChange {
  productVariantId: number;
  productId: number;
  before: { priceCents: number | null; blockers: string[] };
  /** `typed` is true only for a size whose `fixed` price this request sets (C-money-3), never for a typed price stored earlier. */
  after: { priceCents: number | null; blockers: string[]; typed: boolean };
  /** refuseListingPriceSave over before and after; null when the size may be saved. */
  refusal: ListingPriceSaveRefusal | null;
  /** The after side's rule price with its limit check, for answers that name the rule (W7's review rows, 9f). */
  afterRule: (RulePriceResult & { blockedByLimit: boolean }) | null;
}

/**
 * Before and after for every size, in the order given. `after` is `before`
 * with the change's recipes (withRecipes), and each size in `typedInRequest`
 * resolves after from its new setting: `fixed` with its price, `inherit` with
 * none. Card Shellz limits are W9's (`block_listing_push` only, plan P26).
 */
export function buildListingPriceChanges(input: {
  before: RulePriceContext;
  after: RulePriceContext;
  policies: readonly DropshipPricingPolicyRecord[];
  sizes: readonly ListingPriceChangeSize[];
  typedInRequest: ReadonlyMap<number, TypedInRequestPrice>;
}): ListingPriceChange[] {
  const beforeResolver = createRulePriceResolver(input.before);
  const afterResolver = createRulePriceResolver(input.after);
  return input.sizes.map((size) => {
    const { candidate } = size;
    const typed = input.typedInRequest.get(candidate.productVariantId);
    const afterSaved = typed === undefined ? size.saved
      : typed.pricingMode === "fixed" ? { overridePriceCents: typed.priceCents, pricingMode: "fixed" as const }
        : { overridePriceCents: null, pricingMode: "inherit" as const };
    const before = effectiveSizePrice({ candidate, saved: size.saved, cost: size.cost, pricingPolicies: input.policies,
      existingListingPriceCents: size.existingListingPriceCents, resolver: beforeResolver });
    const after = effectiveSizePrice({ candidate, saved: afterSaved, cost: size.cost, pricingPolicies: input.policies,
      existingListingPriceCents: size.existingListingPriceCents, resolver: afterResolver });
    const beforeState = { priceCents: before.priceCents, blockers: evaluateListingPricingPolicy(candidate, input.policies, before.priceCents).blockers };
    const afterState = {
      priceCents: after.priceCents,
      blockers: evaluateListingPricingPolicy(candidate, input.policies, after.priceCents).blockers,
      typed: typed?.pricingMode === "fixed",
    };
    return {
      productVariantId: candidate.productVariantId,
      productId: candidate.productId,
      before: beforeState,
      after: afterState,
      refusal: refuseListingPriceSave({ before: beforeState, after: afterState }),
      afterRule: after.rulePrice,
    };
  });
}

export interface ExpectedPriceComparison {
  /** Chosen sizes the vendor sent no price for, with the price the server computes. */
  missing: Array<{ productVariantId: number; priceCents: number | null }>;
  /** Sizes the vendor sent that are not chosen sizes of the change. */
  extra: Array<{ productVariantId: number; expectedPriceCents: number | null }>;
  /** Sizes whose computed after price is not the one the vendor was shown. */
  differing: Array<{ productVariantId: number; expectedPriceCents: number | null; priceCents: number | null }>;
}

/**
 * The prices the vendor was shown against the server's after prices (plan
 * P14): any missing, extra or differing size means the prices moved. Each
 * list is in ascending size id.
 */
export function compareExpectedPrices(
  rows: ReadonlyArray<Pick<ListingPriceChange, "productVariantId" | "after">>,
  expected: ReadonlyArray<{ productVariantId: number; priceCents: number | null }>,
): ExpectedPriceComparison {
  const shown = new Map(expected.map((row) => [row.productVariantId, row.priceCents]));
  const computed = new Set(rows.map((row) => row.productVariantId));
  const ascending = <T extends { productVariantId: number }>(values: T[]) =>
    values.sort((left, right) => left.productVariantId - right.productVariantId);
  const missing: ExpectedPriceComparison["missing"] = [];
  const differing: ExpectedPriceComparison["differing"] = [];
  for (const row of rows) {
    if (!shown.has(row.productVariantId)) {
      missing.push({ productVariantId: row.productVariantId, priceCents: row.after.priceCents });
      continue;
    }
    const expectedPriceCents = shown.get(row.productVariantId) ?? null;
    if (expectedPriceCents !== row.after.priceCents) {
      differing.push({ productVariantId: row.productVariantId, expectedPriceCents, priceCents: row.after.priceCents });
    }
  }
  const extra = expected.filter((row) => !computed.has(row.productVariantId))
    .map((row) => ({ productVariantId: row.productVariantId, expectedPriceCents: row.priceCents }));
  return { missing: ascending(missing), extra: ascending(extra), differing: ascending(differing) };
}
