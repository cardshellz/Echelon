/**
 * Whether one size's price may be saved (Listing settings design, 8.6 rule 1
 * and W9). Pure: the caller evaluates the Card Shellz price limits.
 *
 * A price is usable when the size has one and no blocking Card Shellz limit
 * refuses it. A size without a usable price cannot be pushed, and a live
 * listing in that state stops getting stock updates: the push-time refresh
 * throws on a blocked row (dropship-listing-intent-refresh.ts) and the stock
 * catch-up refuses a blocked preview
 * (dropship-quantity-publication-catchup.provider.ts).
 *
 * - A typed price that a blocking limit refuses is refused, whatever the size
 *   had before: the vendor is choosing a price that cannot be listed.
 * - A size with a usable price keeps one: a save that would leave it with no
 *   price, or with one a blocking limit refuses, is refused.
 * - A size without a usable price today may stay without one.
 */

export type ListingPriceSaveRefusal = "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT" | "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST";

export interface ListingPriceState {
  /** Integer cents, or null when the size has no price. */
  priceCents: number | null;
  /** Card Shellz limits that block a listing push at this price. */
  blockers: readonly string[];
}

export function refuseListingPriceSave(input: {
  before: ListingPriceState;
  after: ListingPriceState & { typed: boolean };
}): ListingPriceSaveRefusal | null {
  const usableAfter = isUsable(input.after);
  if (input.after.typed && !usableAfter) return "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT";
  if (isUsable(input.before) && !usableAfter) return "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST";
  return null;
}

function isUsable(state: ListingPriceState): boolean {
  return state.priceCents !== null && state.blockers.length === 0;
}
