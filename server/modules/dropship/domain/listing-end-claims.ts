import { z } from "zod";
import { listingMemberIdentitySchema, type ListingMemberIdentity } from "../../../../shared/types/listing-member-lifecycle";
import {
  LISTING_END_CODES,
  LISTING_END_DEFERRAL_DELAY_MS,
  withdrawOutcomeLeftUncertain,
  type ListingEndCode,
  type ListingEndDeferralCode,
} from "./listing-end-errors";
import { MARKETPLACE_IDENTITY_ISSUE_CODES } from "./marketplace-sync-decision";
import type { ListingEndReason, ListingEndRequestedIdentity } from "./vendor-selection-ends";

/**
 * Which end requests a tick may start and send (PR C, PLAN-C v4.1 §5.3, D42), and the claim's decision (§5.4). Pure:
 * the repository reads the facts (indexes of §3) and the service keeps the tick's own counters.
 *
 * - Breakers gate every withdraw, not only claims (SAF-6): while the store's or the global breaker is open nothing is
 *   claimed, and an `ending` row continues only when it can send nothing (its withdraw already went through, so it
 *   only verifies, or the crash check, which fails without sending); every other `ending` row waits for the breaker.
 * - Store breaker: the store's three newest decided ends all `failed`, the newest younger than 6 h → open; older →
 *   half-open (a claim only while the store has no `ending` row) until a verified end closes it.
 * - Global breaker: 10 or more failures decided in the last hour → open until an hour after the newest; then
 *   half-open (one claim per tick in all) until a verified end, or until those failures are two hours old
 *   (BUILD-NOTES D-C4-3).
 * - Canary: a store with no verified end yet is half-open from the start: one end at a time until its first verified
 *   end (`ended`, withdraw `ok`, no code; NOT_PUBLISHED_ON_EBAY and ENDED_BY_STAFF are not verified).
 * - Caps: 25 claims a tick; withdraw calls of the last hour ≤ 600 per store and ≤ 3,000 in all, counted as rows whose
 *   newest call started in the last hour and passed admission. A row makes at most 3 calls, so a row is undercounted
 *   by at most two (SAF-2).
 * Waiting is safe: stock is `zero` while an end is open (§7).
 */

export const LISTING_END_DUE_BATCH = 200;
/** At most this many due rows of one store are read per tick, so one store's long queue never hides the others (D-C4-2). */
export const LISTING_END_DUE_PER_STORE = 25;
export const LISTING_END_CLAIMS_PER_TICK = 25;
export const LISTING_END_STORE_BREAKER_FAILURES = 3;
export const LISTING_END_STORE_BREAKER_COOLDOWN_MS = 21_600_000;
export const LISTING_END_GLOBAL_BREAKER_FAILURES = 10;
export const LISTING_END_GLOBAL_BREAKER_WINDOW_MS = 3_600_000;
export const LISTING_END_CAP_WINDOW_MS = 3_600_000;
export const LISTING_END_MAX_PER_STORE_PER_HOUR = 600;
export const LISTING_END_MAX_PER_HOUR = 3_000;
export const LISTING_END_MAX_WITHDRAW_CALLS = 3;
/** A tick starts no new request after this long (the scheduler never overlaps ticks). */
export const LISTING_END_TICK_BUDGET_MS = 120_000;

/**
 * A store's standing (§5.3). `newestDecided`: its newest decided ends that move the breaker, newest first, at most
 * three: `failed` rows and verified ends. An end that withdrew nothing (NOT_PUBLISHED_ON_EBAY) or that staff marked
 * ended is neither a failure nor proof that a withdraw works, so it never closes a half-open breaker (review WRK-6).
 */
export interface ListingEndStoreFacts {
  storeConnectionId: number;
  newestDecided: ReadonlyArray<{ state: "ended" | "failed"; decidedAt: Date }>;
  hasVerifiedEnd: boolean;
  endingCount: number;
  /** Rows of the store whose newest withdraw call started in the cap window and passed admission. */
  callsInWindow: number;
  /** The oldest of those calls (when the window frees a place), or null. */
  oldestCallInWindowAt: Date | null;
}

export interface ListingEndGlobalFacts {
  failuresInWindow: number;
  failuresInTwoWindows: number;
  newestFailureAt: Date | null;
  verifiedEndSinceNewestFailure: boolean;
  callsInWindow: number;
  oldestCallInWindowAt: Date | null;
}

export type ListingEndBreaker = { state: "closed" } | { state: "half_open" } | { state: "open"; until: Date };

export function decideStoreBreaker(facts: Pick<ListingEndStoreFacts, "newestDecided">, now: Date): ListingEndBreaker {
  const newest = facts.newestDecided.slice(0, LISTING_END_STORE_BREAKER_FAILURES);
  if (newest.length < LISTING_END_STORE_BREAKER_FAILURES || newest.some((row) => row.state !== "failed")) return { state: "closed" };
  const until = new Date(newest[0]!.decidedAt.getTime() + LISTING_END_STORE_BREAKER_COOLDOWN_MS);
  return until.getTime() > now.getTime() ? { state: "open", until } : { state: "half_open" };
}

export function decideGlobalBreaker(facts: Pick<ListingEndGlobalFacts, "failuresInWindow" | "failuresInTwoWindows"
  | "newestFailureAt" | "verifiedEndSinceNewestFailure">, now: Date): ListingEndBreaker {
  if (facts.failuresInWindow >= LISTING_END_GLOBAL_BREAKER_FAILURES && facts.newestFailureAt !== null) {
    const until = new Date(facts.newestFailureAt.getTime() + LISTING_END_GLOBAL_BREAKER_WINDOW_MS);
    if (until.getTime() > now.getTime()) return { state: "open", until };
  }
  if (facts.failuresInTwoWindows >= LISTING_END_GLOBAL_BREAKER_FAILURES && !facts.verifiedEndSinceNewestFailure) return { state: "half_open" };
  return { state: "closed" };
}

/** What the tick has done so far, kept by the service (a row's own claim or send moves these). */
export interface ListingEndTickCounters {
  claims: number;
  claimsByStore: ReadonlyMap<number, number>;
  /** `ending` rows per store: the store's count at the tick's start, plus claims, minus rows the tick closed. */
  endingByStore: ReadonlyMap<number, number>;
  /** Stores whose first verified end this tick made. */
  verifiedStores: ReadonlySet<number>;
  callsByStore: ReadonlyMap<number, number>;
  calls: number;
}

/** A due row as the tick plans it: its state and its withdraw fields. */
export interface ListingEndDueRowFacts {
  storeConnectionId: number;
  state: "pending" | "ending";
  withdrawOutcome: string | null;
  withdrawRequestedAt: Date | null;
  withdrawReturnedAt: Date | null;
}

export type ListingEndDueAction =
  | { action: "claim" }
  | { action: "work" }
  | { action: "skip"; reason: "breaker_open" | "one_at_a_time" | "claims_per_tick" | "cap" }
  | { action: "defer"; code: ListingEndDeferralCode; until: Date };

/**
 * An `ending` row that can send nothing: its withdraw went through (verify only), the crash check (sent, never
 * recorded), or a recorded outcome that may have applied (it fails WITHDRAW_UNCERTAIN without a call; review WRK-2)
 * (SAF-2, SAF-6).
 */
export function endingRowSendsNothing(row: Pick<ListingEndDueRowFacts, "withdrawOutcome" | "withdrawRequestedAt" | "withdrawReturnedAt">): boolean {
  return row.withdrawOutcome === "ok" || (row.withdrawRequestedAt !== null && row.withdrawReturnedAt === null)
    || withdrawOutcomeLeftUncertain(row.withdrawOutcome);
}

function latest(...dates: Array<Date | null>): Date | null {
  return dates.reduce<Date | null>((best, date) => (date && (!best || date.getTime() > best.getTime()) ? date : best), null);
}

/**
 * What the tick does with one due row (§5.3). A `pending` row is claimed only when no breaker is open, the store's
 * half-open or canary allows one more, the tick has claims left and the caps have room; otherwise it is left as it
 * is for a later tick (nothing written). An `ending` row is worked unless a breaker is open and it could send.
 */
export function decideDueRowAction(input: {
  row: ListingEndDueRowFacts;
  store: ListingEndStoreFacts;
  global: ListingEndGlobalFacts;
  counters: ListingEndTickCounters;
  now: Date;
}): ListingEndDueAction {
  const storeBreaker = decideStoreBreaker(input.store, input.now);
  const globalBreaker = decideGlobalBreaker(input.global, input.now);
  if (input.row.state === "ending") {
    if (endingRowSendsNothing(input.row)) return { action: "work" };
    if (storeBreaker.state === "open" || globalBreaker.state === "open") {
      const until = latest(storeBreaker.state === "open" ? storeBreaker.until : null,
        globalBreaker.state === "open" ? globalBreaker.until : null)!;
      return { action: "defer", code: LISTING_END_CODES.breakerOpen, until };
    }
    return { action: "work" };
  }
  if (storeBreaker.state === "open" || globalBreaker.state === "open") return { action: "skip", reason: "breaker_open" };
  const storeId = input.row.storeConnectionId;
  const claimedHere = input.counters.claimsByStore.get(storeId) ?? 0;
  const ending = input.counters.endingByStore.get(storeId) ?? input.store.endingCount;
  const canary = !input.store.hasVerifiedEnd && !input.counters.verifiedStores.has(storeId);
  if ((storeBreaker.state === "half_open" || canary) && (ending > 0 || claimedHere > 0)) return { action: "skip", reason: "one_at_a_time" };
  if (globalBreaker.state === "half_open" && input.counters.claims > 0) return { action: "skip", reason: "one_at_a_time" };
  if (input.counters.claims >= LISTING_END_CLAIMS_PER_TICK) return { action: "skip", reason: "claims_per_tick" };
  if (!hasCapRoom(input)) return { action: "skip", reason: "cap" };
  return { action: "claim" };
}

function hasCapRoom(input: { row: { storeConnectionId: number }; store: ListingEndStoreFacts; global: ListingEndGlobalFacts;
  counters: ListingEndTickCounters }): boolean {
  const storeCalls = input.store.callsInWindow + (input.counters.callsByStore.get(input.row.storeConnectionId) ?? 0);
  const calls = input.global.callsInWindow + input.counters.calls;
  return storeCalls < LISTING_END_MAX_PER_STORE_PER_HOUR && calls < LISTING_END_MAX_PER_HOUR;
}

/**
 * The row's newest withdraw call already counts in the cap window: it started in the last hour and reached eBay (not
 * refused by the admission, `admission_*`, nor failed on the offer read before the send, `unsent_*`).
 */
export function withdrawCallCountedInWindow(row: Pick<ListingEndDueRowFacts, "withdrawRequestedAt" | "withdrawOutcome">, now: Date): boolean {
  return row.withdrawRequestedAt !== null && row.withdrawRequestedAt.getTime() > now.getTime() - LISTING_END_CAP_WINDOW_MS
    && (row.withdrawOutcome === null || (!row.withdrawOutcome.startsWith("admission_") && !row.withdrawOutcome.startsWith("unsent_")));
}

/**
 * Before a withdraw call (§5.3 caps): a row whose newest call already counts in the window (it started in the last
 * hour and passed admission) adds nothing; any other call needs room, or the row waits until the window frees a
 * place (CAP_REACHED, a deferral; D-C4-4).
 */
export function decideWithdrawCap(input: {
  row: ListingEndDueRowFacts & { storeConnectionId: number };
  store: ListingEndStoreFacts;
  global: ListingEndGlobalFacts;
  counters: ListingEndTickCounters;
  now: Date;
}): { outcome: "send" } | { outcome: "defer"; code: ListingEndDeferralCode; until: Date } {
  if (withdrawCallCountedInWindow(input.row, input.now) || hasCapRoom(input)) return { outcome: "send" };
  const frees = latest(input.store.oldestCallInWindowAt, input.global.oldestCallInWindowAt);
  const until = frees ? new Date(frees.getTime() + LISTING_END_CAP_WINDOW_MS) : new Date(input.now.getTime() + LISTING_END_DEFERRAL_DELAY_MS[LISTING_END_CODES.capReached]);
  return { outcome: "defer", code: LISTING_END_CODES.capReached, until };
}

// ---------------------------------------------------------------------------------------------------------------
// The claim (§5.4)

/** What the save recorded of the listing's eBay identity (§3 requested_identity); ids may be null. */
export const listingEndRequestedIdentitySchema = z.object({
  externalListingId: z.string().nullable(),
  externalOfferId: z.string().nullable(),
  externalAccountId: z.string().nullable(),
  providerEnvironment: z.string().nullable(),
}).strict();

/**
 * The identity a claim resolves (§5.4): the retirement view's Dropship identity (migration
 * 900000013000018480001 :88-92) under the shared strict schema, narrowed to what an end needs: an eBay Dropship
 * store, its vendor, its account, the stored offer and the push's SKU.
 */
export const listingEndResolvedIdentitySchema = listingMemberIdentitySchema.superRefine((identity, context) => {
  if (identity.destinationKind !== "dropship_store_connection" || identity.provider !== "ebay" || identity.vendorId === null
    || identity.channelId !== null || identity.accountId === null || identity.externalVariantId === null
    || identity.externalSku === null || identity.identityConflict) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Not a complete Dropship eBay end identity." });
  }
});
export type ListingEndResolvedIdentity = ListingMemberIdentity & {
  destinationKind: "dropship_store_connection"; vendorId: number; accountId: string; externalVariantId: string; externalSku: string;
};

export function parseListingEndResolvedIdentity(value: unknown): ListingEndResolvedIdentity {
  return listingEndResolvedIdentitySchema.parse(value) as ListingEndResolvedIdentity;
}

/** The listing issue codes that mean sync-back cannot prove the live offer is this SKU's (§5.4 h; SDD:42-44). */
export const LISTING_END_IDENTITY_ISSUE_CODES: readonly string[] = Object.freeze([...MARKETPLACE_IDENTITY_ISSUE_CODES, "sync_requires_review"]);

export interface ListingEndClaimListing {
  status: string;
  marketplaceEndedAt: Date | null;
  externalOfferId: string | null;
  externalListingId: string | null;
  marketplaceIssueCodes: readonly string[];
}

export interface ListingEndClaimStore {
  platform: string;
  status: string;
  externalAccountId: string | null;
  externalAccountVerifiedAt: Date | null;
  providerEnvironment: string | null;
}

/**
 * The claim's facts, read in its transaction. Check (a) is read before the listing lock: an archived size is
 * superseded without ever waiting on retirement's locks (SAF-10). The other facts are read after it; some only when
 * an earlier check needs them, as the comments say (the decision never reads them otherwise).
 */
export type ListingEndClaimFacts =
  | { archived: true }
  | {
    archived: false;
    reason: ListingEndReason;
    ids: { vendorId: number; storeConnectionId: number; productId: number; productVariantId: number };
    /** size_removed: the size is picked again; product_removed: the product has a visible pick again (§4.3). */
    rePicked: boolean;
    listing: ListingEndClaimListing;
    /** A push item of the listing is `processing` (queued items are not waited for: the fence refuses them). */
    pushProcessing: boolean;
    /** Read only when the listing has no ids: a push attempt with no completion after it (sync-back's own test). */
    unsettledPushAttempt: boolean;
    /** Read only when the listing has no ids: a queued item stale recovery put back after a worker died mid-send. */
    staleRecoveredItem: boolean;
    store: ListingEndClaimStore;
    /** The newest completed push's intent: its SKU (trimmed, storedIntentSku) and marketplace, or null. */
    intent: { sku: string | null; marketplaceId: string | null } | null;
    requested: ListingEndRequestedIdentity;
    /** Read only when the offer id, SKU and account are known (§5.4 j). */
    sharedWith: "dropship_listing" | "card_shellz_channel" | null;
  };

export type ListingEndClaimDecision =
  | { outcome: "superseded"; code: ListingEndCode }
  | { outcome: "deferred"; code: ListingEndDeferralCode }
  | { outcome: "failed"; code: ListingEndCode; context: Record<string, unknown> }
  | { outcome: "ending"; resolvedIdentity: ListingEndResolvedIdentity; context: Record<string, unknown> };

const EBAY_DEFAULT_MARKETPLACE = "EBAY_US";

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/**
 * The claim's table (§5.4 a-k), first match wins, with (d) checked before (b) and (c) (review DB-1): every outcome
 * but a deferral changes the request's state, whose trigger re-plans the product (its work row) while the claim holds
 * the listing `FOR UPDATE`. A push completion of that listing takes the work row first (its item's status) and the
 * listing after (WR completeItem), so a state change then would close a lock cycle in which PostgreSQL may roll the
 * completion back and lose a push eBay accepted. While an item of the listing is `processing` the claim only waits.
 */
export function decideListingEndClaim(facts: ListingEndClaimFacts): ListingEndClaimDecision {
  if (facts.archived) return { outcome: "superseded", code: LISTING_END_CODES.archived };
  if (facts.pushProcessing) return { outcome: "deferred", code: LISTING_END_CODES.waitingForPush };
  if (facts.rePicked) return { outcome: "superseded", code: LISTING_END_CODES.rePicked };
  const listing = facts.listing;
  if (listing.status === "ended" || listing.marketplaceEndedAt !== null) return { outcome: "superseded", code: LISTING_END_CODES.alreadyEnded };
  const offerId = isBlank(listing.externalOfferId) ? null : listing.externalOfferId!.trim();
  const listingId = isBlank(listing.externalListingId) ? null : listing.externalListingId!.trim();
  if (offerId === null && listingId === null) {
    // A send may have reached eBay without its result recorded (SAF-7): a person decides; nothing is assumed.
    if (facts.unsettledPushAttempt || facts.staleRecoveredItem) {
      return { outcome: "failed", code: LISTING_END_CODES.identityMissing,
        context: { reason: facts.unsettledPushAttempt ? "unsettled_push_attempt" : "stale_recovered_push" } };
    }
    return { outcome: "superseded", code: LISTING_END_CODES.nothingListed };
  }
  const store = facts.store;
  if (store.status !== "connected") return { outcome: "deferred", code: LISTING_END_CODES.storeNotConnected };
  if (store.externalAccountVerifiedAt === null) return { outcome: "deferred", code: LISTING_END_CODES.storeAccountUnverified };
  const sku = facts.intent?.sku ?? null;
  const accountId = isBlank(store.externalAccountId) ? null : store.externalAccountId!.trim();
  const environment = store.providerEnvironment ?? "production";
  if (offerId === null || sku === null || accountId === null || store.platform !== "ebay"
    || (environment !== "production" && environment !== "sandbox")) {
    return { outcome: "failed", code: LISTING_END_CODES.identityMissing, context: {
      reason: offerId === null ? "offer_id_missing" : sku === null ? "sku_missing" : accountId === null ? "account_missing"
        : store.platform !== "ebay" ? "not_an_ebay_store" : "environment_invalid" } };
  }
  const issues = listing.marketplaceIssueCodes.filter((code) => LISTING_END_IDENTITY_ISSUE_CODES.includes(code));
  if (issues.length > 0) return { outcome: "failed", code: LISTING_END_CODES.identityMismatch, context: { issueCodes: issues } };
  const requestedAccount = isBlank(facts.requested.externalAccountId) ? null : facts.requested.externalAccountId!.trim();
  if (requestedAccount !== accountId
    || (facts.requested.providerEnvironment !== null && facts.requested.providerEnvironment !== store.providerEnvironment)) {
    return { outcome: "failed", code: LISTING_END_CODES.accountChanged, context: { reason: "store_account_changed_since_save" } };
  }
  if (facts.sharedWith !== null) return { outcome: "failed", code: LISTING_END_CODES.sharedListing, context: { sharedWith: facts.sharedWith } };
  const marketplaceId = isBlank(facts.intent?.marketplaceId ?? null) ? null : facts.intent!.marketplaceId!.trim();
  const resolvedIdentity = parseListingEndResolvedIdentity({
    destinationKind: "dropship_store_connection", connectionId: facts.ids.storeConnectionId, channelId: null,
    vendorId: facts.ids.vendorId, provider: "ebay", accountId, environment,
    market: marketplaceId ?? EBAY_DEFAULT_MARKETPLACE,
    productId: facts.ids.productId, productVariantId: facts.ids.productVariantId, externalSku: sku,
    externalProductId: listingId, externalVariantId: offerId, externalInventoryItemId: null, identityConflict: false,
  });
  return { outcome: "ending", resolvedIdentity, context: marketplaceId === null ? { marketDefaulted: true } : {} };
}

/** The reconcile scope of an end's SKU (§5.5 step 6): the admission's own scope (quantity-publication-runtime.ts). */
export function listingEndQuantityScope(identity: ListingEndResolvedIdentity) {
  return {
    destinationKind: "dropship_store_connection" as const, connectionId: identity.connectionId, providerKey: "ebay" as const,
    providerScopeType: "account" as const, externalScopeId: identity.accountId, externalInventoryItemId: identity.externalSku,
    productId: null, productVariantId: null,
  };
}
