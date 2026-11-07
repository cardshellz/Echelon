import { DEMOTED_LIVE_LISTING_STATUSES, hasMarketplaceListing, LIVE_LISTING_STATUSES } from "./listing-live-status";
import { MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER } from "./marketplace-sync-sweep";

/**
 * Whether a quantity update to a listing should send 0 to the marketplace
 * instead of being refused as blocked (legacy ATP authority).
 *
 * A preview at 0 carries the blocker `marketplace_quantity_unavailable`
 * (dropship-config-driven-marketplace-listing.provider.ts buildListingIntent),
 * which is right for a listing not yet on the marketplace: nothing is created
 * at 0 (the sweep's "waiting for stock" path lists it once stock returns). For
 * a listing that is already live, refusing leaves the last pushed quantity on
 * sale, so the vendor can oversell. That listing's quantity goes to 0 instead,
 * and only then:
 * - the listing is live: it has a marketplace listing id AND an offer id (the
 *   quantity write targets the recorded offer), and its status is a live one
 *   (LIVE_LISTING_STATUSES) or one an earlier queue or failed push wrote over
 *   a live listing (DEMOTED_LIVE_LISTING_STATUSES);
 * - the quantity blocker is the preview's ONLY blocker. Any other blocker (no
 *   longer selected, tier off, store blocked, a missing price, ...) keeps
 *   today's refusal: this rule only closes the out-of-stock gap.
 * Pure: the caller passes the preview's blockers and the stored listing.
 */

export interface LiveListingZeroQuantityListing {
  status: string;
  externalListingId: string | null;
  externalOfferId: string | null;
}

export type LiveListingZeroQuantityRefusal =
  | "no_quantity_blocker"
  | "other_blockers"
  | "no_listing"
  | "not_published"
  | "no_offer"
  | "not_live";

export type LiveListingZeroQuantityDecision =
  | { kind: "send_zero"; externalListingId: string; externalOfferId: string }
  | { kind: "refuse"; reason: LiveListingZeroQuantityRefusal };

const ZERO_QUANTITY_ELIGIBLE_STATUSES: ReadonlySet<string> = new Set<string>([
  ...LIVE_LISTING_STATUSES,
  ...DEMOTED_LIVE_LISTING_STATUSES,
]);

export function decideLiveListingZeroQuantityUpdate(input: {
  blockers: readonly string[];
  listing: LiveListingZeroQuantityListing | null;
}): LiveListingZeroQuantityDecision {
  const blockers = new Set(input.blockers);
  if (!blockers.has(MARKETPLACE_QUANTITY_UNAVAILABLE_BLOCKER)) return { kind: "refuse", reason: "no_quantity_blocker" };
  if (blockers.size !== 1) return { kind: "refuse", reason: "other_blockers" };
  const listing = input.listing;
  if (listing === null) return { kind: "refuse", reason: "no_listing" };
  if (!hasMarketplaceListing(listing.externalListingId)) return { kind: "refuse", reason: "not_published" };
  if (!hasMarketplaceListing(listing.externalOfferId)) return { kind: "refuse", reason: "no_offer" };
  if (!ZERO_QUANTITY_ELIGIBLE_STATUSES.has(listing.status)) return { kind: "refuse", reason: "not_live" };
  return {
    kind: "send_zero",
    externalListingId: listing.externalListingId!.trim(),
    externalOfferId: listing.externalOfferId!.trim(),
  };
}

/** The statuses the settlement re-checks under its row lock: the same set the decision accepts. */
export const LIVE_LISTING_ZERO_QUANTITY_STATUSES: readonly string[] = Object.freeze([...ZERO_QUANTITY_ELIGIBLE_STATUSES]);
