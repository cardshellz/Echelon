import { createHash } from "node:crypto";
import type { EbayListingInspection } from "../../marketplace-listings/domain/ebay-listing-inspection";
import {
  decideDueRowAction,
  decideGlobalBreaker,
  decideStoreBreaker,
  decideWithdrawCap,
  LISTING_END_MAX_WITHDRAW_CALLS,
  withdrawCallCountedInWindow,
  LISTING_END_TICK_BUDGET_MS,
  listingEndQuantityScope,
  parseListingEndResolvedIdentity,
  type ListingEndClaimDecision,
  type ListingEndGlobalFacts,
  type ListingEndResolvedIdentity,
  type ListingEndStoreFacts,
} from "../domain/listing-end-claims";
import {
  admissionSentNothing,
  classifyAdmissionRefusal,
  classifyCredentialError,
  classifyWithdrawNotSent,
  classifyWithdrawRejection,
  decideTransientRetry,
  deferralDueAt,
  LISTING_END_CODES,
  LISTING_END_DEFERRAL_WARN_AFTER,
  LISTING_END_READBACK_DELAY_MS,
  listingEndClassOf,
  listingEndErrorFacts,
  withdrawOutcomeLeftUncertain,
  withdrawOutcomeText,
  classifyInspectionThrow,
  type ListingEndCode,
  type ListingEndDeferralCode,
  type ListingEndFailure,
} from "../domain/listing-end-errors";
import { resolveListingEndObservation, type ListingEndObservation } from "../domain/listing-end-observation";
import type { ListingEndReason, ListingEndRequestedIdentity } from "../domain/vendor-selection-ends";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type { DropshipClock, DropshipLogger, DropshipNotificationSender } from "./dropship-ports";

/**
 * The listing end worker (PR C, PLAN-C v4.1 §5; owner decisions D17, D19, D32, D35, D36, D42): ends on eBay the
 * listings a step 1 save asked to end, one listing (one size on one store) per request. One tick every 10 s under
 * the runner's advisory lock (dropship-listing-end-runner.ts):
 *
 * 1. Gates (§5.2), before any claim or any remote work: nothing under DRY_RUN (the eBay client would fake a
 *    successful withdraw), nothing while a process of an older catalog code version reported within the grace, and
 *    nothing until version 3 has been running long enough (dropship-process-heartbeat.repository.ts).
 * 2. The due requests and the breaker, canary and cap facts (§5.3). A failure of these reads is fatal for the tick.
 * 3. Per due row, in order, until the tick budget: a `pending` row is claimed (§5.4: one short transaction under the
 *    vendor's selection lock, the save's key) and, once `ending`, worked at once; an `ending` row is worked (§5.5):
 *    under the shared remote-member lock (marketplace-listings' tryLockListingMemberRemote, so retirement and this
 *    worker never remove one eBay member at once), credentials → crash check → observe → resume rule → reconcile →
 *    withdraw (at most once successfully, at most three calls) → verify → finish. No row lock is held across an eBay
 *    call: every write is a short transaction guarded by the row's id, state and version, and the worker's own side
 *    writes never change the version (§3).
 * 4. One critical vendor notification per vendor that had ends fail this tick (§5.7), after commit.
 *
 * Every outcome is classified (listing-end-errors.ts; CLAUDE.md §6): deferrals wait without counting, transient
 * outcomes back off and exhaust to review, permanent ones fail for review and are never retried, and only the
 * tick's own reads are fatal. Explicitly stateful only within a tick (its counters); the clock is injected. The
 * tick's start time is for its reads, caps and breaker decisions only: every write carries the clock read when it is
 * made, and the finish reads it inside its transaction after the listing lock, so `ended_at` is never earlier than
 * the withdraw it records nor than a push created while the end was open (review DB-2, FEN-1).
 */

/** A due end request as the worker reads it. */
export interface ListingEndRow {
  id: number;
  vendorId: number;
  storeConnectionId: number;
  listingId: number;
  productId: number;
  productVariantId: number;
  reason: ListingEndReason;
  state: "pending" | "ending";
  version: number;
  code: string | null;
  context: Record<string, unknown>;
  requestedIdentity: ListingEndRequestedIdentity;
  /** Set by the claim; parsed by the worker before any remote work (a row that does not parse is poison, §5.6). */
  resolvedIdentity: unknown;
  attemptCount: number;
  deferralCount: number;
  withdrawCallCount: number;
  withdrawRequestedAt: Date | null;
  withdrawReturnedAt: Date | null;
  withdrawOutcome: string | null;
  createdAt: Date;
}

/** A due row, or one whose stored values do not parse (poison, SAF-11 c): failed INVARIANT_BROKEN by id and state. */
export type ListingEndDueEntry =
  | { kind: "row"; row: ListingEndRow }
  | { kind: "poison"; id: number; state: "pending" | "ending"; vendorId: number | null; storeConnectionId: number | null; error: string };

export interface ListingEndTickFacts {
  due: ListingEndDueEntry[];
  stores: ListingEndStoreFacts[];
  /** The stores' display names (for the vendor notification), null when a store has none. */
  storeNames: ReadonlyMap<number, string | null>;
  global: ListingEndGlobalFacts;
}

export type ListingEndClaimResult =
  | { kind: "moved" }
  | { kind: "lock_busy"; causeCode: string }
  | { kind: "decided"; decision: ListingEndClaimDecision; row: ListingEndRow | null };

export type ListingEndFinishResult =
  | { kind: "ended"; listingWritten: boolean }
  | { kind: "identity_moved" }
  | { kind: "moved" }
  | { kind: "lock_busy"; causeCode: string };

/**
 * The worker's reads and writes (dropship-listing-end.repository.ts). Every write is its own short transaction,
 * guarded by the row's id, state and version, with its audit row; false (or `moved`) means another writer moved
 * the row first, and the worker stops working it.
 */
export interface DropshipListingEndRepository {
  hasLiveOlderCatalogProcess(): Promise<boolean>;
  catalogVersionSettled(): Promise<boolean>;
  readTickFacts(now: Date): Promise<ListingEndTickFacts>;
  claim(input: { row: ListingEndRow; now: Date }): Promise<ListingEndClaimResult>;
  defer(input: { row: ListingEndRow; code: ListingEndDeferralCode; dueAt: Date; now: Date }): Promise<boolean>;
  retry(input: { row: ListingEndRow; code: ListingEndCode; attemptCount: number; nextAttemptAt: Date;
    context: Record<string, unknown>; now: Date }): Promise<boolean>;
  fail(input: { row: ListingEndRow; code: ListingEndCode; context: Record<string, unknown>; now: Date }): Promise<boolean>;
  markWithdrawSent(input: { row: ListingEndRow; now: Date }): Promise<boolean>;
  /** `sentNothing`: an admission refusal (nothing reached eBay), so the call is not one of the row's three (D-C4-5). */
  markWithdrawReturned(input: { row: ListingEndRow; outcome: string; sentNothing: boolean; now: Date }): Promise<boolean>;
  /** `clock` is read inside the finish's transaction, after the listing lock: the time the end is recorded at. */
  finish(input: { row: ListingEndRow; identity: ListingEndResolvedIdentity; verified: boolean; clock: () => Date }): Promise<ListingEndFinishResult>;
  /** The row's version after the write (it names the failure in the vendor notification's key), or null when it moved. */
  markInvariantBroken(input: { id: number; state: "pending" | "ending"; error: string; now: Date }): Promise<number | null>;
  /** The claim's shared-listing check (§5.4 j) run again on the resolved identity, on a short read of its own (review WRK-3). */
  readSharedWith(input: { row: ListingEndRow; identity: ListingEndResolvedIdentity }): Promise<"dropship_listing" | "card_shellz_channel" | null>;
  /** One pinned transaction holding only the remote-member lock while `work` runs; `acquired: false` when another holds it. */
  withRemoteMemberLock<T>(identity: ListingEndResolvedIdentity, work: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }>;
}

/** The store's eBay credential as the worker sees it; the adapter keeps the token itself out of this shape. */
export interface ListingEndCredential {
  externalAccountId: string | null;
  externalAccountVerifiedAt: Date | null;
  /** The environment the credential's calls go to, or null when it cannot be resolved. */
  environment: "production" | "sandbox" | null;
  /** The opaque vault reference of the access token (never the token): a rejected one is refreshed on the next load. */
  accessTokenRef: string;
}

/**
 * The withdraw's outcome, classified by the adapter from the shared eBay client's errors (§5.5 step 6). `not_sent`:
 * the call failed before the admitted send (the offer read the client makes first), so nothing reached eBay and no
 * inventory attempt was opened (review WRK-4).
 */
export type ListingEndWithdrawResult =
  | { outcome: "ok" }
  | { outcome: "admission"; code: string; context: Readonly<Record<string, unknown>> }
  | { outcome: "rejected"; rejectionCode: string; status: number | null }
  | { outcome: "uncertain"; status: number | null; detail: Readonly<Record<string, unknown>> }
  | { outcome: "network"; detail: Readonly<Record<string, unknown>> }
  | { outcome: "not_sent"; status: number | null; code: string | null };

/** eBay and inventory planning, behind Dropship's adapter (dropship-ebay-listing-end.adapter.ts; §5.8). */
export interface DropshipListingEndProvider {
  loadCredential(input: { vendorId: number; storeConnectionId: number; rejectedAccessTokenRef?: string }): Promise<ListingEndCredential>;
  inspect(input: { storeConnectionId: number; productId: number; productVariantId: number; marketplaceId: string; sku: string }): Promise<EbayListingInspection>;
  reconcile(scope: ReturnType<typeof listingEndQuantityScope>): Promise<{ resolved: string[]; unresolved: string[]; busy: boolean }>;
  withdraw(input: { credential: ListingEndCredential; storeConnectionId: number; offerId: string }): Promise<ListingEndWithdrawResult>;
  recordAccessTokenRejection(input: { credential: ListingEndCredential; status: number; failureCode: string; message: string; now: Date }): Promise<void>;
}

/** The worker's lines through the platform logger (CLAUDE.md §10): `action` plus structured fields. */
export interface ListingEndJobLog {
  debug(action: string, fields: Record<string, unknown>): void;
  info(action: string, fields: Record<string, unknown>): void;
  warn(action: string, fields: Record<string, unknown>): void;
  error(action: string, fields: Record<string, unknown>): void;
}

export interface DropshipListingEndServiceDependencies {
  repository: DropshipListingEndRepository;
  provider: DropshipListingEndProvider;
  notificationSender?: DropshipNotificationSender;
  clock: DropshipClock;
  /** Monotonic milliseconds, for the tick budget and `elapsed_ms`. */
  timer: () => number;
  log: ListingEndJobLog;
  /** `process.env.DRY_RUN === "true"`, read once at composition (§5.2 gate 1; DC17). */
  dryRun: boolean;
}

export interface ListingEndTickResult {
  outcome: "completed" | "gated" | "failed";
  gate: "dry_run" | "older_process" | "version_settling" | null;
  due: number;
  claimed: number;
  ended: number;
  failed: number;
  superseded: number;
  deferred: number;
  retried: number;
  skipped: number;
  elapsedMs: number;
}

/** The vendor's words (§11; endFailedTitle, endFailedBody). */
export const LISTING_END_FAILED_WORDS = Object.freeze({
  // PROPOSED (Stage 4, step 1 plan S2-5) (endFailedTitle)
  title: "Some eBay listings couldn't be ended yet",
  // PROPOSED (Stage 4, step 1 plan S2-5) (endFailedBody; singular and plural forms, D-C4-6)
  body: (count: number, store: string): string => count === 1
    ? `Card Shellz couldn't end 1 eBay listing on ${store} yet. It stays at quantity 0, so it can't sell. Card Shellz is looking into it.`
    : `Card Shellz couldn't end ${count} eBay listings on ${store} yet. They stay at quantity 0, so they can't sell. Card Shellz is looking into it.`,
  // PROPOSED (Stage 3/5, step 1 plan S2-5): the store name the selection effects use when a store has none.
  defaultStore: "your eBay store",
});

/**
 * The notification key (idempotency is global per key, P12): the vendor and a digest of the exact failures this tick
 * decided, each as its request id and the version its failure wrote. A request fails again only after a staff Retry
 * moved its version, so a later failure of the same ids, or of a set nested inside an earlier range, is a new key and
 * a new email; replaying one tick's report is the same key (review WRK-8, DB-3; the plan's min-max key collided).
 */
export function listingEndFailedNotificationKey(vendorId: number,
  failures: ReadonlyArray<{ requestId: number; decidedVersion: number }>): string {
  const exact = [...failures].sort((left, right) => left.requestId - right.requestId || left.decidedVersion - right.decidedVersion)
    .map((failure) => `${failure.requestId}:${failure.decidedVersion}`).join(",");
  return `listing-end-failed:${vendorId}:${createHash("sha256").update(exact).digest("hex")}`;
}

/** A failure decided this tick, for the breakers and the vendor notification (its version names it in the key). */
interface TickFailure { vendorId: number; storeConnectionId: number; requestId: number; decidedVersion: number; code: ListingEndCode }

/** The tick's mutable view of the facts it read: stores and the global counts move as this tick decides rows. */
interface TickState {
  now: Date;
  stores: Map<number, ListingEndStoreFacts>;
  global: ListingEndGlobalFacts;
  claims: number;
  claimsByStore: Map<number, number>;
  endingByStore: Map<number, number>;
  verifiedStores: Set<number>;
  callsByStore: Map<number, number>;
  calls: number;
  failures: TickFailure[];
  result: ListingEndTickResult;
}

/** What one row's remote work ended in, for the tick's counters. */
type RowOutcome = "ended" | "failed" | "deferred" | "retried" | "moved";

export class DropshipListingEndService {
  constructor(private readonly deps: DropshipListingEndServiceDependencies) {}

  /** One tick. Never throws: a failure of the tick's own reads is fatal for the tick (ERROR); rows are classified one by one. */
  async runTick(): Promise<ListingEndTickResult> {
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    const result: ListingEndTickResult = { outcome: "completed", gate: null, due: 0, claimed: 0, ended: 0, failed: 0, superseded: 0,
      deferred: 0, retried: 0, skipped: 0, elapsedMs: 0 };
    try {
      const gate = await this.closedGate();
      if (gate !== null) {
        // Expected while a release settles or in a dry run: DEBUG, nothing claimed and no remote work (§5.2, TST-9).
        this.deps.log.debug("dropship.listing_end.gate_closed", { outcome: "skipped", gate });
        return { ...result, outcome: "gated", gate, elapsedMs: this.deps.timer() - started };
      }
      const facts = await this.deps.repository.readTickFacts(now);
      const state = this.tickState(now, facts, result);
      result.due = facts.due.length;
      for (const entry of facts.due) {
        if (this.deps.timer() - started > LISTING_END_TICK_BUDGET_MS) break;
        await this.runEntry(entry, state);
      }
      await this.notifyVendors(state, facts.storeNames);
      result.elapsedMs = this.deps.timer() - started;
      if (result.claimed + result.ended + result.failed + result.superseded > 0) {
        this.deps.log.info("dropship.listing_end.tick_completed", { outcome: "completed", ...countsOf(result) });
      }
      return result;
    } catch (error) {
      this.recordTickFailure(error);
      return { ...result, outcome: "failed", elapsedMs: this.deps.timer() - started };
    }
  }

  /** A failure of the tick itself (its reads, or the lock runner): fatal for this tick, ERROR (needs a human if it repeats). */
  recordTickFailure(error: unknown, extra: Record<string, unknown> = {}): void {
    const facts = listingEndErrorFacts(error);
    this.deps.log.error("dropship.listing_end.tick_failed", {
      outcome: "failed", error_code: LISTING_END_CODES.tickFailed, error_class: "fatal",
      cause_code: facts.code ?? "UNCLASSIFIED", cause_message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      ...extra,
    });
  }

  private async closedGate(): Promise<ListingEndTickResult["gate"]> {
    if (this.deps.dryRun) return "dry_run";
    if (await this.deps.repository.hasLiveOlderCatalogProcess()) return "older_process";
    if (!(await this.deps.repository.catalogVersionSettled())) return "version_settling";
    return null;
  }

  private tickState(now: Date, facts: ListingEndTickFacts, result: ListingEndTickResult): TickState {
    return {
      now, result,
      stores: new Map(facts.stores.map((store) => [store.storeConnectionId, { ...store, newestDecided: [...store.newestDecided] }])),
      global: { ...facts.global },
      claims: 0, claimsByStore: new Map(), endingByStore: new Map(facts.stores.map((store) => [store.storeConnectionId, store.endingCount])),
      verifiedStores: new Set(), callsByStore: new Map(), calls: 0, failures: [],
    };
  }

  private storeOf(state: TickState, storeConnectionId: number): ListingEndStoreFacts {
    let store = state.stores.get(storeConnectionId);
    if (!store) {
      // A due row's store always has facts (the read covers every due row's store); fail closed if it does not:
      // no verified end (canary, one at a time) and nothing known of its calls.
      store = { storeConnectionId, newestDecided: [], hasVerifiedEnd: false, endingCount: 0, callsInWindow: 0, oldestCallInWindowAt: null };
      state.stores.set(storeConnectionId, store);
    }
    return store;
  }

  private counters(state: TickState) {
    return { claims: state.claims, claimsByStore: state.claimsByStore, endingByStore: state.endingByStore,
      verifiedStores: state.verifiedStores, callsByStore: state.callsByStore, calls: state.calls };
  }

  private async runEntry(entry: ListingEndDueEntry, state: TickState): Promise<void> {
    if (entry.kind === "poison") {
      await this.markPoison(entry, state);
      return;
    }
    let row = entry.row;
    try {
      const action = decideDueRowAction({ row, store: this.storeOf(state, row.storeConnectionId), global: state.global,
        counters: this.counters(state), now: state.now });
      if (action.action === "skip") {
        state.result.skipped += 1;
        return;
      }
      if (action.action === "defer") {
        await this.defer(row, action.code, state, action.until);
        return;
      }
      if (action.action === "claim") {
        const claimed = await this.claim(row, state);
        if (claimed === null) return;
        row = claimed;
      }
      await this.work(row, state);
    } catch (error) {
      // An unexpected failure of one row (a database error in its own transaction): the row tries again later, and
      // the tick goes on. If recording that fails too, the tick is aborted (fatal) and the next one starts over.
      const facts = listingEndErrorFacts(error);
      this.deps.log.warn("dropship.listing_end.row_failed", { ...rowFields(row), outcome: "retry", error_code: LISTING_END_CODES.transient,
        error_class: "transient", cause_code: facts.code ?? "UNCLASSIFIED" });
      await this.applyFailure(row, { code: LISTING_END_CODES.transient, detail: { causeCode: facts.code ?? "UNCLASSIFIED" } }, state);
    }
  }

  private async markPoison(entry: Extract<ListingEndDueEntry, { kind: "poison" }>, state: TickState): Promise<void> {
    const decidedVersion = await this.deps.repository.markInvariantBroken({ id: entry.id, state: entry.state, error: entry.error,
      now: this.deps.clock.now() });
    if (decidedVersion === null) return;
    state.result.failed += 1;
    this.deps.log.error("dropship.listing_end.failed", { end_request_id: entry.id, vendor_id: entry.vendorId,
      store_connection_id: entry.storeConnectionId, outcome: "failed", error_code: LISTING_END_CODES.invariantBroken,
      error_class: "permanent", before: { state: entry.state }, after: { state: "failed" }, parse_error: entry.error });
    if (entry.vendorId !== null && entry.storeConnectionId !== null) {
      this.recordFailure(state, { vendorId: entry.vendorId, storeConnectionId: entry.storeConnectionId, requestId: entry.id,
        decidedVersion, code: LISTING_END_CODES.invariantBroken });
    }
    if (entry.state === "ending" && entry.storeConnectionId !== null) {
      state.endingByStore.set(entry.storeConnectionId, Math.max(0, (state.endingByStore.get(entry.storeConnectionId) ?? 1) - 1));
    }
  }

  /** §5.4. Returns the `ending` row to work at once, or null when the claim decided anything else. */
  private async claim(row: ListingEndRow, state: TickState): Promise<ListingEndRow | null> {
    const claimed = await this.deps.repository.claim({ row, now: this.deps.clock.now() });
    if (claimed.kind === "moved") {
      this.deps.log.debug("dropship.listing_end.claim_moved", { ...rowFields(row), outcome: "skipped" });
      return null;
    }
    if (claimed.kind === "lock_busy") {
      // A listing held by a push completion, a sync adoption or retirement past the lock timeout (SAF-10 c).
      await this.defer(row, LISTING_END_CODES.lockBusy, state, null, { causeCode: claimed.causeCode });
      return null;
    }
    const decision = claimed.decision;
    switch (decision.outcome) {
      case "superseded":
        state.result.superseded += 1;
        this.deps.log.info("dropship.listing_end.superseded", { ...rowFields(row), outcome: "superseded", code: decision.code,
          before: { state: "pending" }, after: { state: "superseded" } });
        return null;
      case "deferred":
        state.result.deferred += 1;
        this.logDeferral(row, decision.code);
        return null;
      case "failed":
        state.result.failed += 1;
        this.logFailed(row, decision.code, decision.context);
        this.recordFailure(state, { vendorId: row.vendorId, storeConnectionId: row.storeConnectionId, requestId: row.id,
          decidedVersion: row.version + 1, code: decision.code });
        return null;
      case "ending": {
        if (!claimed.row) throw new Error("A claim that moved a request to ending returned no row.");
        state.result.claimed += 1;
        state.claims += 1;
        increment(state.claimsByStore, row.storeConnectionId, 1);
        increment(state.endingByStore, row.storeConnectionId, 1, this.storeOf(state, row.storeConnectionId).endingCount);
        this.deps.log.info("dropship.listing_end.started", { ...rowFields(row), outcome: "ending", before: { state: "pending" },
          after: { state: "ending" }, market_defaulted: decision.context.marketDefaulted === true });
        return claimed.row;
      }
    }
  }

  /** §5.5: under the remote-member lock, or REMOTE_BUSY. */
  private async work(row: ListingEndRow, state: TickState): Promise<void> {
    let identity: ListingEndResolvedIdentity;
    try {
      identity = parseListingEndResolvedIdentity(row.resolvedIdentity);
      if (identity.connectionId !== row.storeConnectionId || identity.vendorId !== row.vendorId
        || identity.productVariantId !== row.productVariantId || identity.productId !== row.productId) {
        throw new Error("The resolved identity names another store, vendor or size than the request.");
      }
    } catch (error) {
      await this.markPoison({ kind: "poison", id: row.id, state: row.state, vendorId: row.vendorId, storeConnectionId: row.storeConnectionId,
        error: error instanceof Error ? error.message.slice(0, 500) : "The resolved identity does not parse." }, state);
      return;
    }
    const locked = await this.deps.repository.withRemoteMemberLock(identity, () => this.remoteWork(row, identity, state));
    if (!locked.acquired) {
      await this.defer(row, LISTING_END_CODES.remoteBusy, state);
      return;
    }
    if (locked.value === "ended" || locked.value === "failed") {
      const ending = state.endingByStore.get(row.storeConnectionId) ?? 0;
      state.endingByStore.set(row.storeConnectionId, Math.max(0, ending - 1));
    }
  }

  private async remoteWork(input: ListingEndRow, identity: ListingEndResolvedIdentity, state: TickState): Promise<RowOutcome> {
    let row = input;
    // Step 2: credentials. A rejected token named by the last attempt is refreshed instead of reused (FID-10).
    let credential: ListingEndCredential;
    try {
      const rejected = typeof row.context.rejectedAccessTokenRef === "string" ? row.context.rejectedAccessTokenRef : undefined;
      credential = await this.deps.provider.loadCredential({ vendorId: row.vendorId, storeConnectionId: row.storeConnectionId,
        ...(rejected ? { rejectedAccessTokenRef: rejected } : {}) });
    } catch (error) {
      return this.applyFailure(row, classifyCredentialError(listingEndErrorFacts(error)), state);
    }
    if (credential.externalAccountVerifiedAt === null) return this.applyFailure(row, { code: LISTING_END_CODES.storeAccountUnverified }, state);
    if ((credential.externalAccountId ?? "").trim() !== identity.accountId || credential.environment !== identity.environment) {
      return this.applyFailure(row, { code: LISTING_END_CODES.accountChanged, detail: { reason: "credential_account_differs" } }, state);
    }

    // Step 3: the crash check (SAF-2, SAF-3). The newest withdraw was sent and its result never recorded: inventory
    // recovery cannot settle a withdraw, so a person decides. Evidence first, then the attempt ids; never another call.
    if (row.withdrawRequestedAt !== null && row.withdrawReturnedAt === null) {
      return this.failUncertain(row, identity, state, { reason: "withdraw_result_not_recorded" });
    }
    // The same when the result was recorded but the failure it called for was not (a crash, or a failed write, between
    // markWithdrawReturned and the fail): never finished from a read, never sent again (SAF-3; review WRK-2).
    if (withdrawOutcomeLeftUncertain(row.withdrawOutcome)) {
      return this.failUncertain(row, identity, state, { reason: "withdraw_outcome_uncertain", withdrawOutcome: row.withdrawOutcome });
    }

    // Step 4: observe.
    const observed = await this.observe(identity);
    if (observed.kind === "failure") return this.applyFailure(row, observed.failure, state, credential);

    // Step 5: the resume rule. A withdraw that went through is never sent again; this read is its verify. Any other
    // outcome left here applied nothing (rejected_*, unsent_*, an admission refusal), so a listing eBay already shows
    // not for sale finishes without a withdraw (D-C4-1).
    if (row.withdrawOutcome === "ok") return this.verified(row, identity, observed, state);
    if (observed.kind === "unpublished") return this.finish(row, identity, false, state);

    // Step 6: reconcile, then withdraw (the channels withdrawal's order, ebay-listing-withdrawal.service.ts).
    const scope = listingEndQuantityScope(identity);
    let recovered: { resolved: string[]; unresolved: string[]; busy: boolean };
    try {
      recovered = await this.deps.provider.reconcile(scope);
    } catch (error) {
      return this.applyFailure(row, { code: LISTING_END_CODES.transient,
        detail: { stage: "reconcile", causeCode: listingEndErrorFacts(error).code ?? "UNCLASSIFIED" } }, state);
    }
    if (recovered.busy) return this.applyFailure(row, { code: LISTING_END_CODES.quantityBusy, detail: { stage: "reconcile" } }, state);
    if (recovered.unresolved.length > 0) {
      return this.applyFailure(row, { code: LISTING_END_CODES.priorQuantityUnresolved, attemptIds: recovered.unresolved }, state);
    }
    if (row.withdrawCallCount >= LISTING_END_MAX_WITHDRAW_CALLS) {
      return this.fail(row, LISTING_END_CODES.retriesExhausted, state, { lastCode: LISTING_END_CODES.providerThrottled });
    }
    const cap = decideWithdrawCap({ row, store: this.storeOf(state, row.storeConnectionId), global: state.global,
      counters: this.counters(state), now: state.now });
    if (cap.outcome === "defer") return this.defer(row, cap.code, state, cap.until);

    // The claim's shared-listing guard (§5.4 j), again right before the send: a row can wait hours after its claim, and
    // meanwhile a push of a size without its own SKU may adopt this offer (review WRK-3). A plain read, no row lock.
    let sharedWith: "dropship_listing" | "card_shellz_channel" | null;
    try {
      sharedWith = await this.deps.repository.readSharedWith({ row, identity });
    } catch (error) {
      return this.applyFailure(row, { code: LISTING_END_CODES.transient,
        detail: { stage: "shared_check", causeCode: listingEndErrorFacts(error).code ?? "UNCLASSIFIED" } }, state);
    }
    if (sharedWith !== null) return this.fail(row, LISTING_END_CODES.sharedListing, state, { sharedWith, stage: "before_withdraw" });

    const sentAt = this.deps.clock.now();
    if (!(await this.deps.repository.markWithdrawSent({ row, now: sentAt }))) return this.moved(row, "withdraw_sent");
    const counted = withdrawCallCountedInWindow(row, state.now);
    row = { ...row, withdrawCallCount: row.withdrawCallCount + 1, withdrawRequestedAt: sentAt, withdrawReturnedAt: null, withdrawOutcome: null };
    if (!counted) {
      state.calls += 1;
      increment(state.callsByStore, row.storeConnectionId, 1);
    }
    let sent: ListingEndWithdrawResult;
    try {
      sent = await this.deps.provider.withdraw({ credential, storeConnectionId: row.storeConnectionId, offerId: identity.externalVariantId });
    } catch (error) {
      // The adapter classifies the client's errors; a throw of its own after the sent marker is never assumed not sent.
      const facts = listingEndErrorFacts(error);
      sent = { outcome: "uncertain", status: facts.status, detail: { errorCode: facts.code ?? "UNCLASSIFIED", stage: "adapter" } };
    }
    const outcomeText = withdrawOutcomeText(sent.outcome === "ok" ? { kind: "ok" }
      : sent.outcome === "admission" ? { kind: "admission", code: sent.code }
        : sent.outcome === "rejected" ? { kind: "rejected", status: sent.status }
          : sent.outcome === "uncertain" ? { kind: "uncertain", status: sent.status }
            : sent.outcome === "not_sent" ? { kind: "unsent", status: sent.status } : { kind: "network" });
    const sentNothing = (sent.outcome === "admission" && admissionSentNothing(sent.code)) || sent.outcome === "not_sent";
    const returnedAt = this.deps.clock.now();
    if (!(await this.deps.repository.markWithdrawReturned({ row, outcome: outcomeText, sentNothing, now: returnedAt }))) {
      return this.moved(row, "withdraw_returned");
    }
    row = { ...row, withdrawReturnedAt: returnedAt, withdrawOutcome: outcomeText,
      withdrawCallCount: sentNothing ? row.withdrawCallCount - 1 : row.withdrawCallCount };
    if (sentNothing && !counted) {
      // An admission refusal sent nothing: it does not count against the caps either (§5.3).
      state.calls -= 1;
      increment(state.callsByStore, row.storeConnectionId, -1);
    }
    this.deps.log.info("dropship.listing_end.withdraw_returned", { ...rowFields(row), outcome: outcomeText,
      withdraw_call_count: row.withdrawCallCount });

    switch (sent.outcome) {
      case "ok": {
        // Step 7: verify with step 4's rules.
        const verify = await this.observe(identity);
        if (verify.kind === "failure") return this.applyFailure(row, verify.failure, state, credential);
        return this.verified(row, identity, verify, state);
      }
      case "admission": {
        if (!sentNothing) return this.failUncertain(row, identity, state, { reason: "admission_failed_after_send", admissionCode: sent.code });
        return this.applyFailure(row, classifyAdmissionRefusal({ code: sent.code, context: sent.context }), state);
      }
      case "rejected": {
        const rejection = classifyWithdrawRejection({ rejectionCode: sent.rejectionCode, status: sent.status });
        if (rejection.kind === "throttled") {
          // eBay applied nothing; a later call may send again (at most three calls).
          return this.applyFailure(row, { code: LISTING_END_CODES.providerThrottled, recordTokenRejection: rejection.recordTokenRejection,
            detail: { rejectionCode: sent.rejectionCode, ...(sent.status !== null ? { status: sent.status } : {}) } }, state, credential);
        }
        const again = await this.observe(identity);
        if (again.kind === "unpublished") return this.finish(row, identity, false, state);
        return this.fail(row, LISTING_END_CODES.rejected, state, { rejectionCode: sent.rejectionCode,
          ...(sent.status !== null ? { status: sent.status } : {}) });
      }
      case "not_sent":
        // Nothing reached eBay and no inventory attempt was opened: step 4's read rule (review WRK-4).
        return this.applyFailure(row, classifyWithdrawNotSent({ status: sent.status, code: sent.code }), state, credential);
      case "uncertain":
      case "network":
        // Whatever the re-observe says (SAF-3): only an inventory operator can settle the open attempt.
        return this.failUncertain(row, identity, state, { reason: sent.outcome === "network" ? "network" : "uncertain_response",
          ...sent.detail, ...(sent.outcome === "uncertain" && sent.status !== null ? { status: sent.status } : {}) });
    }
  }

  /** Step 7 (and step 5's resume): unpublished finishes, verified when the withdraw went through; published waits. */
  private async verified(row: ListingEndRow, identity: ListingEndResolvedIdentity, observed: ListingEndObservation,
    state: TickState): Promise<RowOutcome> {
    if (observed.kind === "unpublished") return this.finish(row, identity, row.withdrawOutcome === "ok", state);
    if (observed.kind === "published") return this.applyFailure(row, { code: LISTING_END_CODES.readbackPending }, state);
    return this.applyFailure(row, observed.failure, state);
  }

  private async observe(identity: ListingEndResolvedIdentity): Promise<ListingEndObservation> {
    try {
      const inspection = await this.deps.provider.inspect({ storeConnectionId: identity.connectionId, productId: identity.productId,
        productVariantId: identity.productVariantId, marketplaceId: identity.market, sku: identity.externalSku });
      return resolveListingEndObservation(identity, inspection);
    } catch (error) {
      return { kind: "failure", failure: classifyInspectionThrow(listingEndErrorFacts(error)) };
    }
  }

  /** WITHDRAW_UNCERTAIN (SAF-3): one read for evidence and one reconcile for the attempt ids, then review. */
  private async failUncertain(row: ListingEndRow, identity: ListingEndResolvedIdentity, state: TickState,
    detail: Record<string, unknown>): Promise<RowOutcome> {
    const observed = await this.observe(identity);
    const evidence = observed.kind === "failure" ? "unreadable" : observed.kind;
    let attemptIds: string[] | null = null;
    try {
      const recovered = await this.deps.provider.reconcile(listingEndQuantityScope(identity));
      attemptIds = recovered.busy && recovered.unresolved.length === 0 ? null : recovered.unresolved;
    } catch (error) {
      this.deps.log.warn("dropship.listing_end.reconcile_failed", { ...rowFields(row), outcome: "unknown",
        cause_code: listingEndErrorFacts(error).code ?? "UNCLASSIFIED" });
    }
    return this.fail(row, LISTING_END_CODES.withdrawUncertain, state, { ...detail, evidence,
      attemptIds: attemptIds ?? [], attemptIdsKnown: attemptIds !== null });
  }

  private async finish(row: ListingEndRow, identity: ListingEndResolvedIdentity, verified: boolean, state: TickState): Promise<RowOutcome> {
    const finished = await this.deps.repository.finish({ row, identity, verified, clock: () => this.deps.clock.now() });
    switch (finished.kind) {
      case "moved":
        return this.moved(row, "finish");
      case "lock_busy":
        return this.defer(row, LISTING_END_CODES.lockBusy, state, null, { stage: "finish", causeCode: finished.causeCode });
      case "identity_moved":
        state.result.failed += 1;
        this.logFailed(row, LISTING_END_CODES.identityMismatch, { reason: "listing_ids_moved_before_finish" });
        this.recordFailure(state, { vendorId: row.vendorId, storeConnectionId: row.storeConnectionId, requestId: row.id,
          decidedVersion: row.version + 1, code: LISTING_END_CODES.identityMismatch });
        return "failed";
      case "ended":
        state.result.ended += 1;
        if (verified) {
          state.verifiedStores.add(row.storeConnectionId);
          const store = this.storeOf(state, row.storeConnectionId);
          store.newestDecided = [{ state: "ended" as const, decidedAt: state.now }, ...store.newestDecided].slice(0, 3);
          state.global = { ...state.global, verifiedEndSinceNewestFailure: true };
        }
        this.deps.log.info("dropship.listing_end.ended", { ...rowFields(row), outcome: "ended", verified,
          code: verified ? null : LISTING_END_CODES.notPublishedOnEbay, listing_written: finished.listingWritten,
          before: { state: "ending", listing_status: "live" }, after: { state: "ended", listing_status: "ended" } });
        return "ended";
    }
  }

  private moved(row: ListingEndRow, stage: string): RowOutcome {
    // Another writer moved the row first (only staff or a save can): this worker stops; nothing to do.
    this.deps.log.debug("dropship.listing_end.row_moved", { ...rowFields(row), outcome: "skipped", stage });
    return "moved";
  }

  /** One classified failure (§5.6): a deferral, a transient retry (or RETRIES_EXHAUSTED), or permanent. */
  private async applyFailure(row: ListingEndRow, failure: ListingEndFailure, state: TickState,
    credential?: ListingEndCredential): Promise<RowOutcome> {
    const tokenContext = failure.recordTokenRejection && credential
      ? await this.recordTokenRejection(row, credential, failure, state) : {};
    switch (listingEndClassOf(failure.code)) {
      case "deferral":
        return this.defer(row, failure.code as ListingEndDeferralCode, state, failure.until ?? null, failure.detail);
      case "transient": {
        const now = this.deps.clock.now();
        const retry = decideTransientRetry({ attemptCount: row.attemptCount, now,
          ...(failure.code === LISTING_END_CODES.readbackPending ? { fixedDelayMs: LISTING_END_READBACK_DELAY_MS } : {}) });
        if (retry.outcome === "exhausted") {
          return this.fail(row, LISTING_END_CODES.retriesExhausted, state, { lastCode: failure.code,
            ...(failure.attemptIds ? { attemptIds: [...failure.attemptIds] } : {}), ...(failure.detail ? { lastDetail: failure.detail } : {}) });
        }
        const context = { ...row.context, ...tokenContext, lastCode: failure.code, lastDetail: failure.detail ?? null,
          ...(failure.attemptIds ? { attemptIds: [...failure.attemptIds] } : {}) };
        if (!(await this.deps.repository.retry({ row, code: failure.code, attemptCount: retry.attemptCount,
          nextAttemptAt: retry.nextAttemptAt, context, now }))) return this.moved(row, "retry");
        state.result.retried += 1;
        const fields = { ...rowFields(row), outcome: "retry", error_code: failure.code, error_class: "transient",
          attempt_count: retry.attemptCount, next_attempt_at: retry.nextAttemptAt.toISOString(), detail: failure.detail ?? null };
        // A verify that still reads the listing for sale is expected for a while (eBay's readback): INFO, not an anomaly.
        if (failure.code === LISTING_END_CODES.readbackPending) this.deps.log.info("dropship.listing_end.retry_scheduled", fields);
        else this.deps.log.warn("dropship.listing_end.retry_scheduled", fields);
        return "retried";
      }
      case "permanent":
        return this.fail(row, failure.code, state, { ...(failure.detail ?? {}),
          ...(failure.attemptIds ? { attemptIds: [...failure.attemptIds] } : {}) });
      default:
        throw new Error(`The listing end code ${failure.code} is not a failure.`);
    }
  }

  /** A 401: the token is recorded as rejected so the next load refreshes it (FID-10); the record is a side channel. */
  private async recordTokenRejection(row: ListingEndRow, credential: ListingEndCredential, failure: ListingEndFailure,
    state: TickState): Promise<Record<string, unknown>> {
    try {
      await this.deps.provider.recordAccessTokenRejection({ credential, status: 401, failureCode: failure.code,
        message: "eBay rejected the access token while ending a listing.", now: this.deps.clock.now() });
    } catch (error) {
      // Deliberate side channel: the row's outcome stands, and the next attempt still names the rejected token.
      // A token that changed meanwhile was already replaced (DEBUG); anything else is an anomaly (WARN).
      const facts = listingEndErrorFacts(error);
      const fields = { ...rowFields(row), outcome: "not_recorded", cause_code: facts.code ?? "UNCLASSIFIED" };
      if (facts.code === "DROPSHIP_CREDENTIAL_CHANGED") this.deps.log.debug("dropship.listing_end.token_rejection_not_recorded", fields);
      else this.deps.log.warn("dropship.listing_end.token_rejection_not_recorded", fields);
    }
    return { rejectedAccessTokenRef: credential.accessTokenRef };
  }

  private async defer(row: ListingEndRow, code: ListingEndDeferralCode, state: TickState, until?: Date | null,
    detail?: Readonly<Record<string, unknown>>): Promise<RowOutcome> {
    const now = this.deps.clock.now();
    const dueAt = deferralDueAt(code, now, until ?? null);
    if (!(await this.deps.repository.defer({ row, code, dueAt, now }))) return this.moved(row, "defer");
    state.result.deferred += 1;
    this.logDeferral(row, code, dueAt, detail);
    return "deferred";
  }

  private logDeferral(row: ListingEndRow, code: ListingEndCode, dueAt?: Date, detail?: Readonly<Record<string, unknown>>): void {
    const deferrals = row.deferralCount + 1;
    const fields = { ...rowFields(row), outcome: "deferred", code, deferral_count: deferrals,
      ...(dueAt ? { next_attempt_at: dueAt.toISOString() } : {}), ...(detail ? { detail } : {}) };
    // Waiting is expected (DEBUG); a wait that keeps repeating is worth one WARN (§5.4 d), and the 7-day ops check.
    if (deferrals === LISTING_END_DEFERRAL_WARN_AFTER + 1) this.deps.log.warn("dropship.listing_end.deferred_repeatedly", fields);
    else this.deps.log.debug("dropship.listing_end.deferred", fields);
  }

  private async fail(row: ListingEndRow, code: ListingEndCode, state: TickState, detail: Record<string, unknown>): Promise<RowOutcome> {
    const context = { ...row.context, ...detail, lastCode: detail.lastCode ?? code, requiresReview: true };
    if (!(await this.deps.repository.fail({ row, code, context, now: this.deps.clock.now() }))) return this.moved(row, "fail");
    state.result.failed += 1;
    this.logFailed(row, code, detail);
    this.recordFailure(state, { vendorId: row.vendorId, storeConnectionId: row.storeConnectionId, requestId: row.id,
      decidedVersion: row.version + 1, code });
    return "failed";
  }

  private logFailed(row: ListingEndRow, code: ListingEndCode, detail: Record<string, unknown>): void {
    // A person must look (CLAUDE.md §10): permanent, never retried; the staff list and the ops check show it.
    this.deps.log.error("dropship.listing_end.failed", { ...rowFields(row), outcome: "failed", error_code: code, error_class: "permanent",
      requires_review: true, before: { state: row.state }, after: { state: "failed" }, detail });
  }

  /** A failure moves the breakers' facts; a store or the global count that opens now is one ERROR (§5.3 trip log). */
  private recordFailure(state: TickState, failureValue: TickFailure): void {
    state.failures.push(failureValue);
    const store = this.storeOf(state, failureValue.storeConnectionId);
    const storeBefore = decideStoreBreaker(store, state.now).state;
    store.newestDecided = [{ state: "failed" as const, decidedAt: state.now }, ...store.newestDecided].slice(0, 3);
    const storeAfter = decideStoreBreaker(store, state.now).state;
    const globalBefore = decideGlobalBreaker(state.global, state.now).state;
    state.global = { ...state.global, failuresInWindow: state.global.failuresInWindow + 1,
      failuresInTwoWindows: state.global.failuresInTwoWindows + 1, newestFailureAt: state.now, verifiedEndSinceNewestFailure: false };
    const globalAfter = decideGlobalBreaker(state.global, state.now).state;
    const codes = state.failures.filter((entry) => entry.storeConnectionId === failureValue.storeConnectionId).map((entry) => entry.code);
    if (storeBefore !== "open" && storeAfter === "open") {
      this.deps.log.error("dropship.listing_end.breaker_open", { outcome: "breaker_open", scope: "store",
        store_connection_id: failureValue.storeConnectionId, codes, opened_at: state.now.toISOString() });
    }
    if (globalBefore !== "open" && globalAfter === "open") {
      this.deps.log.error("dropship.listing_end.breaker_open", { outcome: "breaker_open", scope: "global",
        codes: state.failures.map((entry) => entry.code), opened_at: state.now.toISOString() });
    }
  }

  /** §5.7: one critical notification per vendor that had ends fail this tick, after commit, as a side channel. */
  private async notifyVendors(state: TickState, storeNames: ReadonlyMap<number, string | null>): Promise<void> {
    const byVendor = new Map<number, TickFailure[]>();
    for (const failureValue of state.failures) {
      const list = byVendor.get(failureValue.vendorId) ?? [];
      list.push(failureValue);
      byVendor.set(failureValue.vendorId, list);
    }
    for (const [vendorId, failures] of byVendor) {
      const byStore = new Map<number, number>();
      for (const failureValue of failures) byStore.set(failureValue.storeConnectionId, (byStore.get(failureValue.storeConnectionId) ?? 0) + 1);
      const stores = [...byStore.entries()].sort(([left], [right]) => left - right);
      const message = stores.map(([storeConnectionId, count]) =>
        LISTING_END_FAILED_WORDS.body(count, storeNames.get(storeConnectionId) ?? LISTING_END_FAILED_WORDS.defaultStore)).join(" ");
      const requestIds = failures.map((failureValue) => failureValue.requestId).sort((left, right) => left - right);
      await sendDropshipNotificationSafely({ notificationSender: this.deps.notificationSender, logger: this.notificationLogger() }, {
        vendorId,
        eventType: DROPSHIP_NOTIFICATION_EVENTS.LISTING_END_FAILED,
        critical: true,
        channels: ["email", "in_app"],
        title: LISTING_END_FAILED_WORDS.title,
        message,
        payload: { vendorId, endRequestIds: requestIds, stores: stores.map(([storeConnectionId, count]) => ({ storeConnectionId, count })),
          codes: [...new Set(failures.map((failureValue) => failureValue.code))].sort() },
        idempotencyKey: listingEndFailedNotificationKey(vendorId, failures),
      }, {
        code: "DROPSHIP_LISTING_END_NOTIFICATION_FAILED",
        message: "The listing end failure notification failed after the ends were recorded failed.",
        context: { vendorId, endRequestIds: requestIds },
      });
    }
  }

  /** The notification helper's logger (code/message/context) over the job log. */
  private notificationLogger(): DropshipLogger {
    const fields = (event: { code: string; message: string; context?: Record<string, unknown> }) =>
      ({ error_code: event.code, message: event.message, ...(event.context ?? {}) });
    return {
      debug: (event) => this.deps.log.debug("dropship.listing_end.notification", fields(event)),
      info: (event) => this.deps.log.info("dropship.listing_end.notification", fields(event)),
      warn: (event) => this.deps.log.warn("dropship.listing_end.notification_failed", fields(event)),
      error: (event) => this.deps.log.error("dropship.listing_end.notification_failed", fields(event)),
    };
  }
}

/** Admission refusals before anything reaches eBay, and the two codes raised after the call (D-C4-5): the domain's rule. */
export { admissionSentNothing };

/** The correlation fields of every line about one request (CLAUDE.md §10). */
function rowFields(row: ListingEndRow): Record<string, unknown> {
  return { end_request_id: row.id, vendor_id: row.vendorId, store_connection_id: row.storeConnectionId, listing_id: row.listingId,
    product_variant_id: row.productVariantId, reason: row.reason, state: row.state };
}

function countsOf(result: ListingEndTickResult): Record<string, number> {
  return { due: result.due, claimed: result.claimed, ended: result.ended, failed: result.failed, superseded: result.superseded,
    deferred: result.deferred, retried: result.retried, skipped: result.skipped, elapsed_ms: Math.round(result.elapsedMs) };
}

function increment(map: Map<number, number>, key: number, by: number, start = 0): void {
  map.set(key, (map.get(key) ?? start) + by);
}
