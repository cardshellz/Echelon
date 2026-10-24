import {
  MARKETPLACE_IDENTITY_ISSUE_CODES,
  MARKETPLACE_ISSUE_CODES,
  type MarketplaceIssueCode,
  type MarketplaceSyncDecision,
} from "./marketplace-sync-decision";
import type { MarketplaceQuantityDecision, QuantityBaseline } from "./marketplace-quantity-decision";
import { DEMOTED_LIVE_LISTING_STATUSES, LIVE_LISTING_STATUSES } from "./listing-live-status";

/**
 * eBay sync-back's scheduled sweep (plan v4 §6.1, §6.2, §6.4): how much it
 * reads per store and tick, Card Shellz's quantity baseline B, and what one
 * quantity decision writes on the listing. Pure: no clock, database or
 * network; callers pass every fact.
 */

/** One tick every 15 minutes (§6.1, SB14). */
export const MARKETPLACE_SYNC_INTERVAL_MS = 15 * 60_000;
/** No new store or listing is started after this much of a tick (§6.2): the next tick resumes in the same order. */
export const MARKETPLACE_SYNC_TICK_BUDGET_MS = 10 * 60_000;
/** Every store gets at least this many eBay reads per tick (§6.2, SB14). */
export const MARKETPLACE_SYNC_MIN_LISTINGS_PER_STORE_TICK = 50;
/** A store's listings are all read once in this many ticks (24 × 15 minutes = 6 hours, §6.2). */
export const MARKETPLACE_SYNC_TICKS_PER_FULL_PASS = 24;
/** Saved quantity observations decided per store per tick; deciding one reads nothing from eBay (a bound, PROPOSED). */
export const MARKETPLACE_SYNC_MAX_OBSERVATIONS_PER_STORE_TICK = 500;
/** Distinct live shipping policies checked per store per tick, oldest check first (a bound on eBay calls, PROPOSED). */
export const MARKETPLACE_SYNC_MAX_POLICY_CHECKS_PER_STORE_TICK = 20;
/** Notice batches sent per tick; the rest go next tick (a bound, PROPOSED). */
export const MARKETPLACE_SYNC_MAX_NOTICE_BATCHES_PER_TICK = 200;
/** The preview service's own limit on sizes per call (generateVendorListingPreviewInputSchema, createListingPushJobInputSchema). */
export const MARKETPLACE_SYNC_PREVIEW_CHUNK = 500;

/**
 * The listing statuses the sweep reads (§6.2): for sale on eBay, live or
 * demoted by a queue or a failed update. `paused` is a saved draft that was
 * never published, so it is not read; a listing a read ended (`ended` with
 * marketplace_ended_at) is read by its own condition, to see a relist.
 */
export const MARKETPLACE_SYNC_SWEPT_STATUSES: readonly string[] = Object.freeze([
  ...LIVE_LISTING_STATUSES.filter((status) => status !== "paused"), ...DEMOTED_LIVE_LISTING_STATUSES,
]);

/**
 * eBay reads per store and tick: max(50, ceil(live listings / 24)), so a
 * store of any size is read through in about six hours and a small one every
 * tick (§6.2): 10,000 live listings read 417 per tick, 100 read 50.
 */
export function marketplaceSyncStoreListingCap(liveCount: number): number {
  if (!Number.isSafeInteger(liveCount) || liveCount < 0) return MARKETPLACE_SYNC_MIN_LISTINGS_PER_STORE_TICK;
  return Math.max(MARKETPLACE_SYNC_MIN_LISTINGS_PER_STORE_TICK, Math.ceil(liveCount / MARKETPLACE_SYNC_TICKS_PER_FULL_PASS));
}

/** What inventory planning last published for one size (canonical authority), as its published reader answers it. */
export interface PublishedQuantityFact {
  desiredQuantity: number;
  /** When eBay confirmed it (acknowledged) or a read-back proved it (verified); null while it is not settled. */
  settledAt: Date | null;
}

/**
 * B from Card Shellz's own last write of the quantity (§6.4), the newer of:
 * - the last completed push (`pushed_quantity` at `last_pushed_at`): every
 *   push writes the quantity, under either authority
 *   (dropship-listing-push-worker.repository.ts completeItem);
 * - under canonical authority, inventory planning's newest published row for
 *   the size: IP publishes stock changes without a push, so without it an IP
 *   publish would read as the vendor's change.
 * Never settled while a push of the listing is queued or running, after a
 * push attempt that never completed (its quantity may or may not have reached
 * eBay, hasUnsettledPushAttempt), or while IP's newest row is not yet
 * acknowledged or verified: a write in flight may still land, so nothing is
 * decided against it. Null when Card Shellz has no write to compare with.
 */
export function marketplacePublishBaseline(input: {
  authority: "legacy" | "canonical";
  push: { pushedQuantity: number; lastPushedAt: Date | null; hasOpenPushItem: boolean; hasUnsettledAttempt?: boolean };
  published: PublishedQuantityFact | null;
}): QuantityBaseline | null {
  const { push } = input;
  const pushed = push.lastPushedAt === null ? null : { quantity: push.pushedQuantity, at: push.lastPushedAt };
  const published = input.authority === "canonical" ? input.published : null;
  if (published !== null && published.settledAt === null) {
    // IP's newest row is still being written: nothing is settled, whatever the push says.
    return { quantity: published.desiredQuantity, at: pushed?.at ?? new Date(0), settled: false };
  }
  const outbox = published === null ? null : { quantity: published.desiredQuantity, at: published.settledAt! };
  const newest = pushed === null ? outbox : outbox === null ? pushed : outbox.at.getTime() > pushed.at.getTime() ? outbox : pushed;
  return newest === null ? null : { ...newest, settled: !push.hasOpenPushItem && push.hasUnsettledAttempt !== true };
}

/** What Echelon publishes for the listing after a limit change (rule 1): min(ATP, limit), ATP without a limit. */
export function publishableQuantity(atpQuantity: number, vendorQuantityLimit: number | null): number {
  const atp = Number.isSafeInteger(atpQuantity) && atpQuantity > 0 ? atpQuantity : 0;
  return vendorQuantityLimit === null ? atp : Math.min(atp, Math.max(0, vendorQuantityLimit));
}

/** A decided vendor limit change, as the sync-state writer takes it (applyVendorQuantityLimitWithClient). */
export type QuantityLimitChange = { kind: "set"; limit: number } | { kind: "clear" };

/** What one decided quantity observation writes, in one transaction with the observation's compare-and-set. */
export interface QuantityDecisionWrites {
  /** The limit set, raised or cleared; its writer also clears the observation and writes the new baseline. */
  limitChange: QuantityLimitChange | null;
  /** eBay's number as the new limit baseline B; null when a restore follows (that publish becomes B). */
  baseline: { quantity: number; at: Date } | null;
  /** Without a limit change: clear the decided observation. */
  clearObservation: boolean;
  /**
   * `queue`: Echelon's number goes back with the store's restore push this
   * tick. `blocked`: that number is 0, which a push cannot send
   * (dropship-config-driven-marketplace-listing.provider.ts): staff are told
   * through quantity_restore_blocked, the vendor is not (owner rule 1).
   */
  restore: "none" | "queue" | "blocked";
  issues: { add: MarketplaceIssueCode[]; remove: MarketplaceIssueCode[] };
}

/**
 * Clears an observation nothing can be decided on (a dropped one, or one whose
 * listing Card Shellz has no preview row for): the next read saves a fresh one.
 * An earlier blocked restore stays flagged until a decision says otherwise.
 */
export function dropObservationWrites(): QuantityDecisionWrites {
  return { limitChange: null, baseline: null, clearObservation: true, restore: "none", issues: { add: [], remove: [] } };
}

/**
 * The writes of a quantity decision (§6.4). `wait` writes nothing (the
 * observation stays for a later tick): null. Every decided outcome but a
 * blocked restore clears quantity_restore_blocked.
 */
export function quantityDecisionWrites(decision: MarketplaceQuantityDecision,
  issueCodes: readonly MarketplaceIssueCode[]): QuantityDecisionWrites | null {
  if (decision.kind === "wait") return null;
  const blocked: MarketplaceIssueCode = "quantity_restore_blocked";
  const clearBlocked = { add: [], remove: issueCodes.includes(blocked) ? [blocked] : [] };
  if (decision.kind === "drop_observation") return dropObservationWrites();
  if (decision.kind === "no_change") {
    return { limitChange: null, baseline: null, clearObservation: true, restore: "none", issues: clearBlocked };
  }
  const limitChange: QuantityLimitChange | null = decision.kind === "set_limit" ? { kind: "set", limit: decision.limit }
    : decision.kind === "clear_limit" ? { kind: "clear" } : null;
  const baseline = decision.kind === "restore" ? null : decision.baseline;
  const restore = decision.restore === null ? "none" : decision.restore.blocked ? "blocked" : "queue";
  const issues = restore === "blocked"
    ? { add: issueCodes.includes(blocked) ? [] : [blocked], remove: [] }
    : clearBlocked;
  return { limitChange, baseline, clearObservation: limitChange === null, restore, issues };
}

/**
 * A listing eBay ended for lack of stock comes back with stock (SB-C1): it
 * joins the store's restore push when it is still for sale in Card Shellz,
 * eBay shows it not on sale, the read proved it is ours, eBay's own
 * out-of-stock end is proven (isStockOutEndProven) and Echelon has some to
 * publish after this read's quantity decision (a vendor limit of 0 never
 * republishes it, §6.4 notes).
 */
export function isRepublishWanted(input: {
  issuesAfter: readonly MarketplaceIssueCode[]; listingStatus: string; publishableQuantity: number; stockOutProven: boolean;
}): boolean {
  return input.issuesAfter.includes("ended_out_of_stock") && input.listingStatus !== "ended" && input.publishableQuantity > 0
    && input.stockOutProven && !input.issuesAfter.some((code) => MARKETPLACE_IDENTITY_ISSUE_CODES.includes(code));
}

/**
 * Whether eBay showing a listing not on sale at 0 is eBay's own out-of-stock
 * end (review MS2): only when Card Shellz's own last quantity, settled and no
 * newer than the read, was 0. Any other 0 (sales, a vendor's 0 or a vendor's
 * end of a sold-out listing, or no baseline to compare with) may be the
 * vendor's, so nothing republishes the listing by itself; the vendor's own
 * publish still may. HYPOTHESIS: with eBay's out-of-stock option on, a
 * listing at 0 stays live, so this case is rare; eBay's status semantics are
 * not proven from here.
 */
export function isStockOutEndProven(input: { observedQuantity: number; observedAt: Date; baseline: QuantityBaseline | null }): boolean {
  const baseline = input.baseline;
  return input.observedQuantity === 0 && baseline !== null && baseline.settled && baseline.quantity === 0
    && baseline.at.getTime() <= input.observedAt.getTime();
}

/**
 * A decision whose price adoption W9 refused inside the adoption transaction
 * (plan v4 §6.6):
 * - `outside_limit`: the vendor's price breaks a Card Shellz price limit, so
 *   the listing is flagged price_outside_card_shellz_limit;
 * - `terminal`: the vendor, membership or store may not change prices now.
 * Either way nothing about the price is kept: no below-cost notice, and B for
 * price stays Card Shellz's last one (null when it has none, so the stored
 * intent stays its fallback), so a later read tries again once the price or
 * the block changes. Everything else the decision says stands.
 */
export function decisionWithoutPriceAdoption(decision: MarketplaceSyncDecision, refusal: "outside_limit" | "terminal",
  input: { listingIssueCodes: readonly MarketplaceIssueCode[]; oursPriceBaseline: number | null }): MarketplaceSyncDecision {
  const notices = decision.notices.filter((notice) => notice.kind !== "price_below_cost");
  const syncedBaseline = decision.syncedBaseline === null ? null : { ...decision.syncedBaseline, priceCents: input.oursPriceBaseline };
  const flag: MarketplaceIssueCode = "price_outside_card_shellz_limit";
  const flagged = refusal === "outside_limit" || input.listingIssueCodes.includes(flag);
  const after = MARKETPLACE_ISSUE_CODES.filter((code) => (code === flag ? flagged : decision.issues.after.includes(code)));
  const add = MARKETPLACE_ISSUE_CODES.filter((code) => after.includes(code) && !input.listingIssueCodes.includes(code));
  const remove = MARKETPLACE_ISSUE_CODES.filter((code) => !after.includes(code) && input.listingIssueCodes.includes(code));
  return { ...decision, price: { kind: "unchanged" }, notices, syncedBaseline, issues: { add, remove, after } };
}
