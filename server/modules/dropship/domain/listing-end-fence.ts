import { RELIST_ALLOWED_RESULT_FIELD } from "./marketplace-push-rule";

/**
 * PR C's push fence (PLAN-C v4.1 §6.2, D31, DC11, DC28): what the push worker
 * does with a queued item whose listing Card Shellz is ending on eBay, or
 * ended after the item was queued. Every Dropship push reaches eBay only after
 * `markItemProcessing` (§6.1), which reads the listing's end requests under
 * the item's and the listing's locks and answers one of these outcomes
 * instead of starting the item. Pure: the repository passes the facts it read.
 */

/** The fence's codes; each is permanent for its item (retryable false), never retried. */
export const LISTING_END_FENCE_CODES = Object.freeze({
  /** An end is pending or being sent to eBay. */
  inProgress: "DROPSHIP_LISTING_END_IN_PROGRESS",
  /** An end failed and waits for Card Shellz staff; the listing stays at quantity 0. */
  review: "DROPSHIP_LISTING_END_REVIEW",
  /** Card Shellz ended the listing after this item was queued: the item may not relist it. */
  endedSincePublish: "DROPSHIP_LISTING_ENDED_SINCE_PUBLISH",
});

export const LISTING_END_FENCE_WORDS = Object.freeze({
  // PROPOSED (Stage 4, step 1 plan S2-5) (fenceItem)
  inProgress: "This listing is being ended on eBay, so it wasn't published.",
  // PROPOSED (Stage 4, step 1 plan S2-5) (fenceReview)
  review: "Card Shellz is looking into this listing; it stays at quantity 0.",
  // PROPOSED (Stage 4, step 1 plan S2-5) (fenceEndedSincePublish)
  endedSincePublish: "This listing was ended after it was published. Publish it again in step 3 to sell it.",
});

/** The open states of an end request (the open-end unique index of the end table). */
export type OpenListingEndState = "pending" | "ending" | "failed";

/** A fenced item: an open end (`end_open`), a failed end waiting for staff (`end_review`), or a later Card Shellz end. */
export type ListingEndFenceOutcome = "end_open" | "end_review" | "ended_since_queued";

/** What `markItemProcessing` did with one queued item. */
export type ListingPushItemStart = "started" | "not_started" | ListingEndFenceOutcome;

/**
 * The fence's decision from what the repository read: the listing's open end
 * (at most one) and whether Card Shellz ended it (a verified end, an end eBay
 * already showed, or a staff "Ended on eBay") after the item was created.
 * Null: no fence, the item starts as before.
 */
export function decideListingEndFence(input: {
  openEndState: OpenListingEndState | null;
  endedSinceQueued: boolean;
}): ListingEndFenceOutcome | null {
  if (input.openEndState === "pending" || input.openEndState === "ending") return "end_open";
  if (input.openEndState === "failed") return "end_review";
  return input.endedSinceQueued ? "ended_since_queued" : null;
}

export interface ListingEndFenceAction {
  /** `block`: the item shows in the run's problems; `skip`: cancelled quietly (no failure email, never re-queued). */
  action: "block" | "skip";
  code: (typeof LISTING_END_FENCE_CODES)[keyof typeof LISTING_END_FENCE_CODES];
  message: string;
}

/**
 * How a fenced item ends (§6.2 table). Only an item the vendor's own press
 * created (`result.relistAllowed`, the queue's field) inside a publish run is
 * blocked, so step 3's run problems tell the vendor why it was not published.
 * Every other item is cancelled quietly: a vendor push outside a run would
 * otherwise send the critical "listing push failed" email for a removal the
 * vendor chose and confirmed in step 1 (FID-13), and a system item (a reprice,
 * a restore, a catch-up, a requeue) is not the vendor's to see.
 */
export function decideListingEndFenceAction(input: {
  outcome: ListingEndFenceOutcome;
  itemResult: Record<string, unknown> | null;
  inRun: boolean;
}): ListingEndFenceAction {
  const vendorCreated = input.itemResult?.[RELIST_ALLOWED_RESULT_FIELD] === true;
  const action = vendorCreated && input.inRun ? "block" : "skip";
  switch (input.outcome) {
    case "end_open":
      return { action, code: LISTING_END_FENCE_CODES.inProgress, message: LISTING_END_FENCE_WORDS.inProgress };
    case "end_review":
      return { action, code: LISTING_END_FENCE_CODES.review, message: LISTING_END_FENCE_WORDS.review };
    case "ended_since_queued":
      return { action, code: LISTING_END_FENCE_CODES.endedSincePublish, message: LISTING_END_FENCE_WORDS.endedSincePublish };
  }
}
