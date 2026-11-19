import { DropshipError } from "./errors";
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
 * `ended` is refused, except for an order placed before the end (eBay
 * sync-back, plan v4 §7.3 step 8): sync-back writes `ended` with
 * `marketplace_ended_at`, the time it saw the end. That time is later than
 * the real end, so every order genuinely placed while the listing was live
 * passes; an order placed after it is refused as before. Card Shellz's own
 * end (PR C, PLAN-C v4.1 §8) leaves `marketplace_ended_at` NULL and records
 * the time on its end request (`ended_at`, after eBay read the offer
 * withdrawn), which the readers pass as `listingEndedAt`. An order refused
 * because its listing had ended is reviewed by a person (DC14): eBay sold on a
 * listing recorded as ended.
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
  | { acceptable: true; reason: "listing_orderable" | "listing_live_on_marketplace" | "ordered_before_listing_ended" }
  | { acceptable: false; reason: "listing_ended" | "listing_not_on_marketplace" | "listing_status_not_orderable" };

export interface ListingOrderAcceptabilityInput {
  /** `dropship_vendor_listings.status` as stored. */
  status: string;
  /** `dropship_vendor_listings.external_listing_id` as stored. */
  externalListingId: string | null;
  /** `dropship_vendor_listings.marketplace_ended_at`: when sync-back saw the listing ended; null otherwise. */
  marketplaceEndedAt?: Date | null;
  /** PR C: the newest `ended_at` of the listing's ended end requests (Card Shellz's own end); null otherwise. */
  listingEndedAt?: Date | null;
  /** The order's own time (the intake's `orderedAt`); null when the marketplace sent none. */
  orderedAt?: Date | null;
}

export function decideListingOrderAcceptability(input: ListingOrderAcceptabilityInput): ListingOrderAcceptability {
  // The statuses that always took orders: the live-status rule's own list.
  if (isLiveListingStatus(input.status)) {
    return { acceptable: true, reason: "listing_orderable" };
  }
  if (input.status === "ended") {
    return endedBeforeOrder(input) ? { acceptable: false, reason: "listing_ended" } : { acceptable: true, reason: "ordered_before_listing_ended" };
  }
  if (PUSH_PROGRESS_LISTING_STATUSES.has(input.status)) {
    return isPushProgressListingOnMarketplace(input)
      ? { acceptable: true, reason: "listing_live_on_marketplace" }
      : { acceptable: false, reason: "listing_not_on_marketplace" };
  }
  // `not_listed`, `preview_ready` and any value outside the CHECK (0086:284).
  return { acceptable: false, reason: "listing_status_not_orderable" };
}

/**
 * An ended listing refuses the order unless both times are known and the order came first (no time, no proof). The
 * vendor's end (sync-back) is the listing's current end when it is set: it is cleared by a completed push, so a set
 * value is newer than any Card Shellz end before that push.
 */
function endedBeforeOrder(input: ListingOrderAcceptabilityInput): boolean {
  const endedAt = listingEndTime(input);
  const orderedAt = input.orderedAt ?? null;
  if (endedAt === null || orderedAt === null) return true;
  return orderedAt.getTime() > endedAt.getTime();
}

function listingEndTime(input: Pick<ListingOrderAcceptabilityInput, "marketplaceEndedAt" | "listingEndedAt">): Date | null {
  return input.marketplaceEndedAt ?? input.listingEndedAt ?? null;
}

/**
 * The refusal of an order line whose listing had ended before the order (DC14,
 * PLAN-C v4.1 §8 step 3), for either end: the vendor's (sync-back) or Card
 * Shellz's (PR C). Permanent and for review, never retried: eBay took an
 * order on a listing recorded as ended, and a person decides it (the ops
 * check DROPSHIP_ORDER_LISTING_ENDED_BEFORE_ORDER counts these intakes).
 */
export const ORDER_LISTING_ENDED_BEFORE_ORDER_CODE = "DROPSHIP_ORDER_LISTING_ENDED_BEFORE_ORDER";
// PROPOSED (Stage 4, step 1 plan S2-5) (orderEndedBeforeOrder)
export const ORDER_LISTING_ENDED_BEFORE_ORDER_MESSAGE =
  "This order is for an eBay listing that was ended before the order was placed. Card Shellz will review it.";

/** Which end refused the order: the vendor's on eBay (sync-back), Card Shellz's own, or none recorded (no proof). */
export type ListingEndSource = "marketplace_end" | "card_shellz_end" | "unknown";

export function listingEndedBeforeOrderError(input: {
  context: Readonly<Record<string, unknown>>;
  lineIndex: number;
  listingId: number;
  listingStatus: string;
  marketplaceEndedAt: Date | null;
  listingEndedAt: Date | null;
  orderedAt: Date | null;
}): DropshipError {
  const endSource: ListingEndSource = input.marketplaceEndedAt !== null ? "marketplace_end"
    : input.listingEndedAt !== null ? "card_shellz_end" : "unknown";
  return new DropshipError(ORDER_LISTING_ENDED_BEFORE_ORDER_CODE, ORDER_LISTING_ENDED_BEFORE_ORDER_MESSAGE, {
    ...input.context,
    lineIndex: input.lineIndex,
    listingId: input.listingId,
    listingStatus: input.listingStatus,
    endedAt: listingEndTime(input)?.toISOString() ?? null,
    orderedAt: input.orderedAt?.toISOString() ?? null,
    endSource,
    requiresReview: true,
    retryable: false,
    classification: "permanent",
  });
}

/**
 * A line sold from a multi-variation listing, as its marketplace's mapper
 * marked it (`marketplaceVariation`, review ARCH-10: the eBay mapper sets it
 * for a line with eBay's legacyVariationId, dropship-ebay-order-intake.mapper.ts
 * buildEbayOrderLine). Card Shellz lists each size on its own, so such a line
 * is not one of its listings: refused (plan v4 §7.3 step 7, SB20), permanent
 * and for review. A SKU that differs without the flag ships as today.
 */
export function isUnsupportedMarketplaceVariationLine(line: { marketplaceVariation?: boolean | null }): boolean {
  return line.marketplaceVariation === true;
}

/** The refusal of a variation line (permanent: no retry makes it one of Card Shellz's listings). */
export const ORDER_LINE_VARIATION_UNSUPPORTED_CODE = "DROPSHIP_ORDER_LINE_VARIATION_UNSUPPORTED";
// PROPOSED (sync-back): kept on the intake as its refusal and shown to the vendor.
export const ORDER_LINE_VARIATION_UNSUPPORTED_MESSAGE =
  "This order has an item sold from an eBay listing with several sizes or options. Card Shellz lists each size on its own, so it can't fill this order.";

/**
 * The one variation refusal both order processing and acceptance run before
 * reading listings or money: the first variation line refuses the whole
 * order, permanently (never retried).
 */
export function assertNoMarketplaceVariationLines(
  lines: readonly { marketplaceVariation?: boolean | null; externalListingId?: string | null }[],
  context: Readonly<Record<string, unknown>>,
): void {
  const lineIndex = lines.findIndex(isUnsupportedMarketplaceVariationLine);
  if (lineIndex < 0) return;
  throw new DropshipError(ORDER_LINE_VARIATION_UNSUPPORTED_CODE, ORDER_LINE_VARIATION_UNSUPPORTED_MESSAGE,
    { ...context, lineIndex, externalListingId: lines[lineIndex]!.externalListingId ?? null, retryable: false });
}

/** An intake's order time (normalizedPayload.orderedAt); null when it is missing or not a time (the listing rule then has no proof). */
export function parseIntakeOrderedAt(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** True when the new push-progress rule (not the long-standing one) admitted the order. */
export function admittedWhilePushing(decision: ListingOrderAcceptability): boolean {
  return decision.acceptable && decision.reason === "listing_live_on_marketplace";
}
