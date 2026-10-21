/**
 * Whether a vendor listing is live on its marketplace, and what a push may
 * write over it. Pure rules; the SQL that applies them passes these lists as
 * parameters so the database and the code read one definition.
 *
 * A listing is live once a push published it (it has an external listing id)
 * and its status is one orders and quotes accept
 * (dropship-order-acceptance.repository assertListingCandidateCanAccept,
 * dropship-order-processing.repository QUOTABLE check). Queueing an update or
 * a failed update does not change what the marketplace shows, so neither may
 * move a live listing out of these statuses: before this rule they did
 * (queued/blocked at queue time, failed/blocked on a failed push), and the
 * listing stopped taking orders while it was still for sale.
 */

/** Statuses of a listing that is for sale (or saved as a draft) on its marketplace. */
export const LIVE_LISTING_STATUSES = ["active", "paused", "drift_detected"] as const;
export type LiveListingStatus = (typeof LIVE_LISTING_STATUSES)[number];

/**
 * Statuses an earlier queue or failed push wrote over a live listing: the
 * queue wrote queued or blocked (dropship-listing-preview.repository
 * upsertVendorListingForPreview), a failed push wrote failed or blocked
 * (dropship-listing-push-worker.repository markItemTerminalFailure), an ops
 * retry wrote queued (dropship-listing-push-ops.repository).
 */
export const DEMOTED_LIVE_LISTING_STATUSES = ["queued", "failed", "blocked"] as const;

export function isLiveListingStatus(status: string): status is LiveListingStatus {
  return (LIVE_LISTING_STATUSES as readonly string[]).includes(status);
}

/** A push recorded a marketplace listing for this row; a blank id is no listing. */
export function hasMarketplaceListing(externalListingId: string | null | undefined): boolean {
  return typeof externalListingId === "string" && externalListingId.trim().length > 0;
}

/**
 * The status a completed push leaves: `live` publishes (active), the other
 * listing modes save an unpublished draft (paused). The same rule
 * completeItem has always applied.
 */
export function listingStatusAfterCompletedPush(listingMode: string): "active" | "paused" {
  return listingMode === "live" ? "active" : "paused";
}

const KNOWN_LISTING_MODES: ReadonlySet<string> = new Set(["live", "draft_first", "manual_only"]);

/**
 * A push item's last write, which is what decides the listing's status: the
 * listing carries whatever the item that wrote last left (a completed push
 * writes active or paused; under the old code a queue, a retry or a failure
 * wrote queued, failed or blocked). Item ids do not give that order: a retry
 * of an older job (ops or the stock catch-up) can finish after a newer job's
 * push completed.
 */
export interface PushItemWrite {
  itemId: number;
  /** When the item last changed state (its updated_at). */
  wroteAt: Date;
}

/** Whether `later` wrote after `earlier`: by time, then by id for writes in the same instant. */
export function isLaterPushItemWrite(later: PushItemWrite, earlier: PushItemWrite): boolean {
  const laterAt = later.wroteAt.getTime();
  const earlierAt = earlier.wroteAt.getTime();
  return laterAt > earlierAt || (laterAt === earlierAt && later.itemId > earlier.itemId);
}

export interface DemotedLiveListingEvidence {
  listingId: number;
  status: string;
  externalListingId: string | null;
  /** A queued or processing push item for this listing: its own outcome will set the status. */
  hasInFlightItem: boolean;
  /** The completed push item of this listing that wrote last, or null when none exists. */
  lastCompletedItem: (PushItemWrite & {
    /** The mode the provider published with (result.push.rawResult.listingMode), else the queued intent's mode. */
    listingMode: string | null;
  }) | null;
  /** The push item of this listing, in any status, that wrote last. */
  latestWrite: PushItemWrite | null;
}

export type DemotedLiveListingDecision =
  | { kind: "restore"; status: "active" | "paused"; basisItemId: number }
  | { kind: "skip"; reason: "not_demoted" | "not_published" | "in_flight" }
  | { kind: "requires_review"; code: DemotedLiveListingReviewCode; message: string };

export type DemotedLiveListingReviewCode =
  | "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH"
  | "DROPSHIP_LISTING_LIVE_STATUS_UNKNOWN_MODE"
  | "DROPSHIP_LISTING_LIVE_STATUS_UNEXPLAINED";

/**
 * Whether a listing that an earlier queue or failed push moved out of its
 * live status gets it back, and which one. The status is the one its last
 * completed push left (listingStatusAfterCompletedPush), because no later
 * push changed what the marketplace shows. Nothing is restored on a guess:
 * - a queued or processing item decides the status itself when it finishes;
 * - without a completed push, or with a mode no push writes, or when no push
 *   item wrote after the last completed one (so none explains the current
 *   status), the listing is left as it is and named for review.
 */
export function decideDemotedLiveListingRestore(evidence: DemotedLiveListingEvidence): DemotedLiveListingDecision {
  if (!(DEMOTED_LIVE_LISTING_STATUSES as readonly string[]).includes(evidence.status)) {
    return { kind: "skip", reason: "not_demoted" };
  }
  if (!hasMarketplaceListing(evidence.externalListingId)) return { kind: "skip", reason: "not_published" };
  if (evidence.hasInFlightItem) return { kind: "skip", reason: "in_flight" };
  const completed = evidence.lastCompletedItem;
  if (!completed) {
    return {
      kind: "requires_review",
      code: "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH",
      message: "The listing has a marketplace id but no completed push records which status it was published in.",
    };
  }
  if (completed.listingMode === null || !KNOWN_LISTING_MODES.has(completed.listingMode)) {
    return {
      kind: "requires_review",
      code: "DROPSHIP_LISTING_LIVE_STATUS_UNKNOWN_MODE",
      message: "The listing's last completed push does not name a listing mode a push publishes with.",
    };
  }
  // The current status was written after that push: by a later item's queue, retry or failure.
  if (evidence.latestWrite === null || !isLaterPushItemWrite(evidence.latestWrite, completed)) {
    return {
      kind: "requires_review",
      code: "DROPSHIP_LISTING_LIVE_STATUS_UNEXPLAINED",
      message: "No push item wrote after the last completed one, so none explains the listing's current status.",
    };
  }
  return { kind: "restore", status: listingStatusAfterCompletedPush(completed.listingMode), basisItemId: completed.itemId };
}
