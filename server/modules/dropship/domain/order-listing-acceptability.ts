/**
 * Whether an order line may be taken on a vendor listing, judged by the
 * listing's Echelon status (step 1 plan S2-5 §4.7, SAFETY16, D30).
 *
 * A listing's status is written by every push: the queue sets `queued` (or
 * `blocked`), the worker `pushing`, a failure `failed`, and only a completed
 * push `active`/`paused` (F6). So a listing that is live on the marketplace and
 * is being re-sent (a publish run, a price change, a staff retry) reads
 * `queued`, `pushing`, `failed` or `blocked` in Echelon while buyers can still
 * order it. Before this rule acceptance and quoting refused those orders for
 * good (F9). The status there is push progress, not the listing's existence:
 * when the row carries the marketplace listing id, the listing exists and the
 * order is taken.
 *
 * The catalog check (is the size still something vendors may list) runs after
 * this and is unchanged, so an item Card Shellz no longer offers is still
 * refused.
 *
 * `ended` is refused here. Ending listings arrives with PR C, which adds the
 * rule for orders placed before the end (§6.7) together with the end time it
 * needs; no `ended_at` exists before then.
 *
 * This rule builds on the live-status rule (domain/listing-live-status), the
 * one definition of the statuses that always take orders and of a
 * marketplace listing id. Since that rule, a queue or a failed push no longer
 * writes over a live listing's status (guarded CASE in the queue upsert, in
 * markItemTerminalFailure and in the ops requeue), so the push-progress branch
 * below admits the rows written before it (until the listing-push recovery
 * repairs them) and rows an older release's process writes during a deploy.
 */
import {
  DEMOTED_LIVE_LISTING_STATUSES,
  hasMarketplaceListing,
  isLiveListingStatus,
} from "./listing-live-status";

/**
 * Push-progress statuses: a push is queued, running, failed or was blocked.
 * With a marketplace listing id the listing is live there regardless. Every
 * status the live-status rule names as written over a live listing
 * (DEMOTED_LIVE_LISTING_STATUSES) is one of them, plus `pushing`, which the
 * status CHECK allows (0086:284) though no code writes it today.
 */
export const PUSH_PROGRESS_LISTING_STATUSES: ReadonlySet<string> = new Set([
  ...DEMOTED_LIVE_LISTING_STATUSES,
  "pushing",
]);

/**
 * A listing that eBay still lists while Echelon re-sends it: a push-progress
 * status and a non-blank marketplace listing id. The one definition every
 * module that asks "is this re-sent listing still live" uses (orders here; the
 * cost-change actions and the publish run's price review, review MC1/MC3), so
 * a listing that takes orders is never treated as gone elsewhere.
 */
export function isPushProgressListingOnMarketplace(input: ListingOrderAcceptabilityInput): boolean {
  return PUSH_PROGRESS_LISTING_STATUSES.has(input.status) && hasMarketplaceListing(input.externalListingId);
}

export type ListingOrderAcceptability =
  | { acceptable: true; reason: "listing_orderable" | "listing_live_on_marketplace" }
  | { acceptable: false; reason: "listing_ended" | "listing_not_on_marketplace" | "listing_status_not_orderable" };

export interface ListingOrderAcceptabilityInput {
  /** `dropship_vendor_listings.status` as stored. */
  status: string;
  /** `dropship_vendor_listings.external_listing_id` as stored. */
  externalListingId: string | null;
}

export function decideListingOrderAcceptability(input: ListingOrderAcceptabilityInput): ListingOrderAcceptability {
  // The statuses that always took orders: the live-status rule's own list.
  if (isLiveListingStatus(input.status)) {
    return { acceptable: true, reason: "listing_orderable" };
  }
  if (input.status === "ended") {
    return { acceptable: false, reason: "listing_ended" };
  }
  if (PUSH_PROGRESS_LISTING_STATUSES.has(input.status)) {
    return isPushProgressListingOnMarketplace(input)
      ? { acceptable: true, reason: "listing_live_on_marketplace" }
      : { acceptable: false, reason: "listing_not_on_marketplace" };
  }
  // `not_listed`, `preview_ready` and any value outside the CHECK (0086:284).
  return { acceptable: false, reason: "listing_status_not_orderable" };
}

/** True when the new push-progress rule (not the long-standing one) admitted the order. */
export function admittedWhilePushing(decision: ListingOrderAcceptability): boolean {
  return decision.acceptable && decision.reason === "listing_live_on_marketplace";
}
