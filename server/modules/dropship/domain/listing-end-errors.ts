import { LISTING_END_SUPERSEDED_BY_SELECTION } from "./vendor-selection-ends";

/**
 * The end worker's codes and the class of each (PR C, PLAN-C v4.1 §5.6, §12; CLAUDE.md §6). Pure: the service and
 * the repository pass the facts they hold (an error's code and HTTP status, an admission refusal's code and context)
 * and get one class back. Every code has exactly one class, pinned code by code by listing-end-errors.test.ts.
 *
 * - deferral: a wait that is not a try at the eBay listing (the store, an inventory gate, a lock, a breaker). The row
 *   keeps its state, waits the code's fixed delay, counts a deferral, never an attempt; no breaker, no email; DEBUG.
 *   An open end older than 7 days is counted by the ops check DROPSHIP_LISTING_END_STUCK (§5.7).
 * - transient: an eBay or provider outcome that may pass. An attempt is counted and the row waits the backoff (or the
 *   code's fixed delay); past LISTING_END_MAX_ATTEMPTS it fails RETRIES_EXHAUSTED with `lastCode`.
 * - permanent: `failed`, review (`requiresReview`), ERROR, counted by the breakers, a vendor email; never retried.
 * - fatal: the tick's own reads failed; the tick is aborted and the next one starts from the database.
 * - superseded / ended: terminal outcomes that are not failures (INFO).
 */

export type ListingEndClass = "deferral" | "transient" | "permanent" | "fatal" | "superseded" | "ended";

export const LISTING_END_CODES = Object.freeze({
  // Deferrals.
  waitingForPush: "DROPSHIP_LISTING_END_WAITING_FOR_PUSH",
  storeNotConnected: "DROPSHIP_LISTING_END_STORE_NOT_CONNECTED",
  storeAccountUnverified: "DROPSHIP_LISTING_END_STORE_ACCOUNT_UNVERIFIED",
  remoteBusy: "DROPSHIP_LISTING_END_REMOTE_BUSY",
  quantityBusy: "DROPSHIP_LISTING_END_QUANTITY_BUSY",
  publicationStopped: "DROPSHIP_LISTING_END_PUBLICATION_STOPPED",
  providerCooldown: "DROPSHIP_LISTING_END_PROVIDER_COOLDOWN",
  breakerOpen: "DROPSHIP_LISTING_END_BREAKER_OPEN",
  lockBusy: "DROPSHIP_LISTING_END_LOCK_BUSY",
  /** The hourly withdraw cap of the store or of every store is used up (BUILD-NOTES D-C4-4). */
  capReached: "DROPSHIP_LISTING_END_CAP_REACHED",
  // Transient.
  readFailed: "DROPSHIP_LISTING_END_READ_FAILED",
  priorQuantityUnresolved: "DROPSHIP_LISTING_END_PRIOR_QUANTITY_UNRESOLVED",
  quantityRefused: "DROPSHIP_LISTING_END_QUANTITY_REFUSED",
  providerThrottled: "DROPSHIP_LISTING_END_PROVIDER_THROTTLED",
  readbackPending: "DROPSHIP_LISTING_END_READBACK_PENDING",
  transient: "DROPSHIP_LISTING_END_TRANSIENT",
  // Permanent (review).
  rejected: "DROPSHIP_LISTING_END_REJECTED",
  accountChanged: "DROPSHIP_LISTING_END_ACCOUNT_CHANGED",
  identityMismatch: "DROPSHIP_LISTING_END_IDENTITY_MISMATCH",
  identityMissing: "DROPSHIP_LISTING_END_IDENTITY_MISSING",
  sharedListing: "DROPSHIP_LISTING_END_SHARED_LISTING",
  readRefused: "DROPSHIP_LISTING_END_READ_REFUSED",
  withdrawUncertain: "DROPSHIP_LISTING_END_WITHDRAW_UNCERTAIN",
  retriesExhausted: "DROPSHIP_LISTING_END_RETRIES_EXHAUSTED",
  invariantBroken: "DROPSHIP_LISTING_END_INVARIANT_BROKEN",
  /** The store's credential cannot be used and trying again will not change that (`retryable: false`; review WRK-5). */
  credentialUnusable: "DROPSHIP_LISTING_END_CREDENTIAL_UNUSABLE",
  // Fatal.
  tickFailed: "DROPSHIP_LISTING_END_TICK_FAILED",
  // Terminal, superseded.
  archived: "DROPSHIP_LISTING_END_ARCHIVED",
  rePicked: "DROPSHIP_LISTING_END_RE_PICKED",
  alreadyEnded: "DROPSHIP_LISTING_END_ALREADY_ENDED",
  nothingListed: "DROPSHIP_LISTING_END_NOTHING_LISTED",
  supersededBySelection: LISTING_END_SUPERSEDED_BY_SELECTION,
  // Terminal, ended (not a verified end: the canary waits for one with no code).
  notPublishedOnEbay: "DROPSHIP_LISTING_END_NOT_PUBLISHED_ON_EBAY",
  endedByStaff: "DROPSHIP_LISTING_END_ENDED_BY_STAFF",
});

export type ListingEndCode = (typeof LISTING_END_CODES)[keyof typeof LISTING_END_CODES];

const C = LISTING_END_CODES;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The codes of each class; every code is in exactly one list (pinned code by code by listing-end-errors.test.ts). */
export const LISTING_END_DEFERRAL_CODES = Object.freeze([C.waitingForPush, C.storeNotConnected, C.storeAccountUnverified,
  C.remoteBusy, C.quantityBusy, C.publicationStopped, C.providerCooldown, C.breakerOpen, C.lockBusy, C.capReached] as const);
export const LISTING_END_TRANSIENT_CODES = Object.freeze([C.readFailed, C.priorQuantityUnresolved, C.quantityRefused,
  C.providerThrottled, C.readbackPending, C.transient] as const);
export const LISTING_END_PERMANENT_CODES = Object.freeze([C.rejected, C.accountChanged, C.identityMismatch, C.identityMissing,
  C.sharedListing, C.readRefused, C.withdrawUncertain, C.retriesExhausted, C.invariantBroken, C.credentialUnusable] as const);
export const LISTING_END_FATAL_CODES = Object.freeze([C.tickFailed] as const);
export const LISTING_END_SUPERSEDED_CODES = Object.freeze([C.archived, C.rePicked, C.alreadyEnded, C.nothingListed,
  C.supersededBySelection] as const);
export const LISTING_END_ENDED_CODES = Object.freeze([C.notPublishedOnEbay, C.endedByStaff] as const);

export type ListingEndDeferralCode = (typeof LISTING_END_DEFERRAL_CODES)[number];

/** Every code's class. */
export const LISTING_END_CODE_CLASSES: Readonly<Record<ListingEndCode, ListingEndClass>> = Object.freeze(Object.fromEntries([
  ...LISTING_END_DEFERRAL_CODES.map((code) => [code, "deferral"]),
  ...LISTING_END_TRANSIENT_CODES.map((code) => [code, "transient"]),
  ...LISTING_END_PERMANENT_CODES.map((code) => [code, "permanent"]),
  ...LISTING_END_FATAL_CODES.map((code) => [code, "fatal"]),
  ...LISTING_END_SUPERSEDED_CODES.map((code) => [code, "superseded"]),
  ...LISTING_END_ENDED_CODES.map((code) => [code, "ended"]),
]) as Record<ListingEndCode, ListingEndClass>);

/**
 * The fixed wait of each deferral (§5.6). PROVIDER_COOLDOWN waits until eBay's own retry time, BREAKER_OPEN until the
 * breaker half-opens and CAP_REACHED until the hour's oldest counted call leaves the window; their value here is the
 * wait when that time is unknown or already past.
 */
export const LISTING_END_DEFERRAL_DELAY_MS: Readonly<Record<ListingEndDeferralCode, number>> = Object.freeze({
  [C.waitingForPush]: MINUTE_MS,
  [C.storeNotConnected]: 6 * HOUR_MS,
  [C.storeAccountUnverified]: 6 * HOUR_MS,
  [C.remoteBusy]: 30_000,
  [C.quantityBusy]: MINUTE_MS,
  [C.publicationStopped]: 15 * MINUTE_MS,
  [C.providerCooldown]: MINUTE_MS,
  [C.breakerOpen]: MINUTE_MS,
  [C.lockBusy]: MINUTE_MS,
  [C.capReached]: MINUTE_MS,
});

/** A deferral that waited this many times in a row is worth one WARN (§5.4 d: "WARN once past 60 deferrals"). */
export const LISTING_END_DEFERRAL_WARN_AFTER = 60;

/** Transient backoff by attempt (§5.6): 1 min, 5 min, 15 min, 1 h, then 6 h. */
export const LISTING_END_BACKOFF_MS: readonly number[] = Object.freeze([MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS, 6 * HOUR_MS]);
/** Attempts (the claim counts the first) before a transient outcome fails RETRIES_EXHAUSTED (§5.6). */
export const LISTING_END_MAX_ATTEMPTS = 10;
/** A verify that still reads the offer published waits this long, whatever the attempt (§5.5 step 7). */
export const LISTING_END_READBACK_DELAY_MS = MINUTE_MS;

export function listingEndClassOf(code: ListingEndCode): ListingEndClass {
  return LISTING_END_CODE_CLASSES[code];
}

export function isListingEndCode(value: unknown): value is ListingEndCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LISTING_END_CODE_CLASSES, value);
}

/**
 * What a transient outcome does to a row that has made `attemptCount` attempts (the claim's included): the next
 * attempt and when, or RETRIES_EXHAUSTED once the next attempt would be past the limit. `fixedDelayMs` replaces the
 * backoff (READBACK_PENDING).
 */
export function decideTransientRetry(input: { attemptCount: number; now: Date; fixedDelayMs?: number }):
  { outcome: "retry"; attemptCount: number; nextAttemptAt: Date } | { outcome: "exhausted" } {
  const next = input.attemptCount + 1;
  if (next > LISTING_END_MAX_ATTEMPTS) return { outcome: "exhausted" };
  const delay = input.fixedDelayMs ?? LISTING_END_BACKOFF_MS[Math.min(Math.max(next - 2, 0), LISTING_END_BACKOFF_MS.length - 1)]!;
  return { outcome: "retry", attemptCount: next, nextAttemptAt: new Date(input.now.getTime() + delay) };
}

/** When a deferral is due again: the code's fixed delay, or `until` when it is later than now. */
export function deferralDueAt(code: ListingEndDeferralCode, now: Date, until?: Date | null): Date {
  if (until && Number.isFinite(until.getTime()) && until.getTime() > now.getTime()) return new Date(until.getTime());
  return new Date(now.getTime() + LISTING_END_DEFERRAL_DELAY_MS[code]);
}

/** A failure the worker met, classified. `retryNotBefore` only for PROVIDER_COOLDOWN; attempt ids only where known. */
export interface ListingEndFailure {
  code: ListingEndCode;
  /** The inventory attempts left open on the SKU (WITHDRAW_UNCERTAIN, PRIOR_QUANTITY_UNRESOLVED). */
  attemptIds?: readonly string[];
  /** eBay's own retry time (PROVIDER_COOLDOWN). */
  until?: Date | null;
  /** A 401: the stored access token is recorded as rejected, so the next load refreshes it (FID-10). */
  recordTokenRejection?: boolean;
  /** What failed, for the row's context and the log (an error code and HTTP status, never a body or a token). */
  detail?: Readonly<Record<string, unknown>>;
}

/**
 * The facts of a thrown error the worker classifies: its code and HTTP status, if any, and what the thrower said of
 * it: `retryable` (DropshipError context; false means trying again will not help) and the token owner's
 * `authFailureStatus` (`needs_reauth`: the store must be connected again).
 */
export interface ListingEndErrorFacts {
  code: string | null;
  status: number | null;
  retryable?: boolean | null;
  authFailureStatus?: string | null;
}

/** An error's code, HTTP status and retryability, read without trusting its type (any layer may throw). */
export function listingEndErrorFacts(error: unknown): ListingEndErrorFacts {
  if (!error || typeof error !== "object") return { code: null, status: null, retryable: null, authFailureStatus: null };
  const record = error as { code?: unknown; context?: unknown; status?: unknown; statusCode?: unknown; httpStatus?: unknown;
    providerWrite?: unknown };
  const context = record.context && typeof record.context === "object" ? record.context as Record<string, unknown> : {};
  const providerWrite = record.providerWrite && typeof record.providerWrite === "object"
    ? record.providerWrite as Record<string, unknown> : {};
  // `statusCode` is the shared eBay client's EbayApiRequestError (ebay-api-error.ts).
  const status = [context.status, record.status, record.statusCode, record.httpStatus, providerWrite.httpStatus]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) ?? null;
  return {
    code: typeof record.code === "string" && record.code.length > 0 ? record.code : null, status,
    retryable: typeof context.retryable === "boolean" ? context.retryable : null,
    authFailureStatus: typeof context.authFailureStatus === "string" ? context.authFailureStatus : null,
  };
}

/** The store cannot be used: the token owner's refusals and the credential adapter's (§5.5 steps 2 and 4). */
const STORE_NOT_CONNECTED_ERROR_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED",
  "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED",
  "DROPSHIP_EBAY_REGISTRATION_STORE_NOT_CONNECTED",
]);

/**
 * The store's credential could not be loaded (§5.5 step 2). The store not connected, or a refresh grant eBay no
 * longer honours (the token owner marks the store `needs_reauth`), waits like a store that is not connected. A
 * refusal its thrower calls not retryable (a store with no usable environment, a credential of another store, OAuth
 * not configured) fails for review at once: retrying it ten times would change nothing (CLAUDE.md §6; review WRK-5).
 * Anything else is tried again.
 */
export function classifyCredentialError(facts: ListingEndErrorFacts): ListingEndFailure {
  const detail = { causeCode: facts.code ?? "UNCLASSIFIED", ...(facts.status !== null ? { status: facts.status } : {}) };
  if ((facts.code !== null && STORE_NOT_CONNECTED_ERROR_CODES.has(facts.code)) || facts.authFailureStatus === "needs_reauth") {
    return { code: C.storeNotConnected, detail };
  }
  if (facts.retryable === false) return { code: C.credentialUnusable, detail };
  return { code: C.transient, detail };
}

/**
 * A throw from the inspection (§5.5 step 4, "Thrown"; FID-9): the credential and account reads run before the
 * observer's per-SKU `try`. The store not connected waits; a marketplace the store does not list is an identity
 * mismatch; anything else (401/403, 429, 5xx, a network failure, an unknown error) is a read that may pass.
 */
export function classifyInspectionThrow(facts: ListingEndErrorFacts): ListingEndFailure {
  if (facts.code !== null && STORE_NOT_CONNECTED_ERROR_CODES.has(facts.code)) {
    return { code: C.storeNotConnected, detail: { causeCode: facts.code } };
  }
  if (facts.code === "DROPSHIP_EBAY_REGISTRATION_MARKETPLACE_MISMATCH") {
    return { code: C.identityMismatch, detail: { causeCode: facts.code } };
  }
  return {
    code: C.readFailed, recordTokenRejection: facts.status === 401,
    detail: { causeCode: facts.code ?? "UNCLASSIFIED", ...(facts.status !== null ? { status: facts.status } : {}) },
  };
}

/** The observer's per-SKU issue codes that say the offer is not provably this SKU's on this marketplace. */
const IDENTITY_ISSUE_CODES: ReadonlySet<string> = new Set([
  "EBAY_REGISTRATION_OFFER_MARKETPLACE_MISMATCH",
  "EBAY_REGISTRATION_OFFER_SKU_MISMATCH",
  "EBAY_REGISTRATION_INVENTORY_SKU_MISMATCH",
]);

/**
 * The SKU's read issue (§5.5 step 4, "Result"): an identity issue fails for review; 401/403/429/5xx or no status is
 * a read that may pass; any other 4xx is a refusal that would only repeat (READ_REFUSED, review; SAF-11 a).
 */
export function classifyInspectionIssue(issue: { code: string; status?: number }): ListingEndFailure {
  if (IDENTITY_ISSUE_CODES.has(issue.code)) return { code: C.identityMismatch, detail: { causeCode: issue.code } };
  const status = issue.status ?? null;
  const detail = { causeCode: issue.code, ...(status !== null ? { status } : {}) };
  if (status === null || status === 401 || status === 403 || status === 429 || status >= 500) {
    return { code: C.readFailed, recordTokenRejection: status === 401, detail };
  }
  if (status >= 400) return { code: C.readRefused, detail };
  return { code: C.readFailed, detail };
}

const ADMISSION_QUANTITY_BUSY: ReadonlySet<string> = new Set([
  "PUBLICATION_SCOPE_BUSY", "QUANTITY_PUBLICATION_DRAIN_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY",
]);
const ADMISSION_STOPPED: ReadonlySet<string> = new Set(["PUBLICATION_GLOBAL_STOP_ACTIVE", "QUANTITY_PUBLICATION_SUPPRESSED"]);

/**
 * A refusal of inventory planning's admission (§5.5 step 6; SAF-5): nothing was sent, and every admission refusal is
 * `retryable` (quantity-publication-admission.ts). Busy gates and the global stop wait without counting; eBay's
 * cooldown waits until its retry time; an unverified account waits like the store; another writer's unsettled
 * request on the SKU is a transient that exhausts to review; anything else is a transient refusal.
 */
export function classifyAdmissionRefusal(input: { code: string; context?: Readonly<Record<string, unknown>> }): ListingEndFailure {
  const detail = { admissionCode: input.code };
  if (ADMISSION_QUANTITY_BUSY.has(input.code)) return { code: C.quantityBusy, detail };
  if (ADMISSION_STOPPED.has(input.code)) return { code: C.publicationStopped, detail };
  if (input.code === "PUBLICATION_PROVIDER_COOLDOWN") {
    const raw = input.context?.retryNotBefore;
    const until = typeof raw === "string" ? new Date(raw) : null;
    return { code: C.providerCooldown, until: until && Number.isFinite(until.getTime()) ? until : null, detail };
  }
  if (input.code === "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED") return { code: C.storeAccountUnverified, detail };
  if (input.code === "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED") return { code: C.priorQuantityUnresolved, detail };
  return { code: C.quantityRefused, detail };
}

/**
 * A withdraw that failed before anything reached eBay (review WRK-4): the shared client reads the offer before the
 * admitted send (quantity-publication-request.ts), and that read failed. Nothing was sent and no inventory attempt was
 * opened, so it is step 4's read rule: 401/403/429/5xx or no status may pass (a 401 also records the token), any other
 * 4xx would only repeat (READ_REFUSED, review).
 */
export function classifyWithdrawNotSent(input: { status: number | null; code: string | null }): ListingEndFailure {
  const failure = classifyInspectionIssue({ code: input.code ?? "UNCLASSIFIED", ...(input.status !== null ? { status: input.status } : {}) });
  return { ...failure, detail: { ...(failure.detail ?? {}), stage: "withdraw_offer_read" } };
}

/**
 * Admission codes the admission raises after the provider call (`PUBLICATION_COMPLETION_CONFLICT` after a success,
 * `PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN` in its `finally`): a withdraw met by those may have gone through
 * (quantity-publication-admission.repository.ts `execute()`; D-C4-5). Every other admission refusal sent nothing.
 */
const ADMISSION_AFTER_SEND_CODES: ReadonlySet<string> = new Set(["PUBLICATION_COMPLETION_CONFLICT", "PUBLICATION_CONNECTION_CLEANUP_UNCERTAIN"]);
export function admissionSentNothing(code: string): boolean {
  return !ADMISSION_AFTER_SEND_CODES.has(code);
}

/**
 * A recorded `withdraw_outcome` (withdrawOutcomeText) after which the withdraw may have applied: an uncertain answer,
 * a transport failure, an admission code raised after the send, or anything unknown. Not: none recorded, `ok` (the
 * resume rule verifies it), `rejected_*` (eBay applied nothing), `unsent_*` and the other `admission_*` (nothing sent).
 * Such a row's inventory attempt stays open and only staff can settle it, so it fails WITHDRAW_UNCERTAIN before any
 * read could finish it or any call could repeat it (SAF-3; review WRK-2).
 */
export function withdrawOutcomeLeftUncertain(outcome: string | null): boolean {
  if (outcome === null || outcome === "ok" || outcome.startsWith("rejected_") || outcome.startsWith("unsent_")) return false;
  if (outcome.startsWith("admission_")) return !admissionSentNothing(outcome.slice("admission_".length));
  return true;
}

/** eBay refused the withdraw (QuantityProviderRejectionError) and applied nothing; which refusal it was. */
export type ListingEndWithdrawRejection = "throttled" | "refused";

/**
 * eBay's refusal of the withdraw (§5.5 step 6): authentication, permission, throttling and the daily limit may pass
 * (the HTTP layer set an account cooldown, so the next admission waits for it); a 401 also records the token as
 * rejected (FID-10). Any other refusal (400 REQUEST/BUSINESS) is re-observed: ended means nothing was published.
 */
export function classifyWithdrawRejection(input: { rejectionCode: string; status: number | null }):
  { kind: ListingEndWithdrawRejection; recordTokenRejection: boolean } {
  const throttled = input.status === 401 || input.status === 403 || input.status === 429
    || ["EBAY_AUTH_REQUIRED", "EBAY_OAUTH_SCOPE_MISSING", "EBAY_PROVIDER_ACCESS_DENIED", "EBAY_PROVIDER_RATE_LIMITED",
      "EBAY_QUANTITY_DAILY_LIMIT"].includes(input.rejectionCode);
  return { kind: throttled ? "throttled" : "refused",
    recordTokenRejection: input.status === 401 || input.rejectionCode === "EBAY_AUTH_REQUIRED" };
}

/**
 * The bounded text of `withdraw_outcome` (varchar 60): ok, rejected_<status>, uncertain_<status>, admission_<code>,
 * network, unsent_<status> (the offer read before the send failed; nothing was sent, review WRK-4).
 */
export function withdrawOutcomeText(outcome:
  | { kind: "ok" } | { kind: "rejected"; status: number | null } | { kind: "uncertain"; status: number | null }
  | { kind: "admission"; code: string } | { kind: "network" } | { kind: "unsent"; status: number | null }): string {
  switch (outcome.kind) {
    case "ok": return "ok";
    case "rejected": return `rejected_${outcome.status ?? "unknown"}`;
    case "uncertain": return `uncertain_${outcome.status ?? "unknown"}`;
    case "admission": return `admission_${outcome.code}`.slice(0, 60);
    case "network": return "network";
    case "unsent": return `unsent_${outcome.status ?? "unknown"}`;
  }
}

/** Staff words stored with a row's code (the staff list shows them; §10). One sentence each. */
export const LISTING_END_MESSAGES: Readonly<Record<ListingEndCode, string>> = Object.freeze({
  // PROPOSED (Stage 4, step 1 plan S2-5): staff words for the end request list (BUILD-NOTES D-C4-6).
  [C.waitingForPush]: "Waiting for a push of this listing that is already being sent to eBay.",
  [C.storeNotConnected]: "Waiting: the store is not connected to eBay.",
  [C.storeAccountUnverified]: "Waiting: the store's eBay account is not verified yet.",
  [C.remoteBusy]: "Waiting: another removal of this eBay offer is running.",
  [C.quantityBusy]: "Waiting: an inventory update of this SKU is running.",
  [C.publicationStopped]: "Waiting: inventory publication is stopped.",
  [C.providerCooldown]: "Waiting: eBay asked to wait before the next request on this account.",
  [C.breakerOpen]: "Waiting: ends on this store paused after repeated failures.",
  [C.lockBusy]: "Waiting: the listing is locked by another update.",
  [C.capReached]: "Waiting: this hour's limit of eBay ends is used up.",
  [C.readFailed]: "eBay could not be read completely; Card Shellz will try again.",
  [C.priorQuantityUnresolved]: "An earlier inventory request on this SKU is not settled; Card Shellz will try again.",
  [C.quantityRefused]: "Inventory publication refused the request; Card Shellz will try again.",
  [C.providerThrottled]: "eBay refused the request for now (sign-in, permission or rate limit); Card Shellz will try again.",
  [C.readbackPending]: "eBay still shows the listing for sale; Card Shellz will check again.",
  [C.transient]: "The end could not finish this time; Card Shellz will try again.",
  [C.rejected]: "eBay refused to end this listing.",
  [C.accountChanged]: "The store is now connected to a different eBay account than when the end was asked.",
  [C.identityMismatch]: "eBay does not show this listing's saved offer as this size's own; nothing was ended.",
  [C.identityMissing]: "Card Shellz has no complete eBay identity for this listing; nothing was ended.",
  [C.sharedListing]: "This eBay listing or account is shared with another listing or a Card Shellz channel; nothing was ended.",
  [C.readRefused]: "eBay refused to show this listing; nothing was ended.",
  [C.withdrawUncertain]: "eBay's answer to the end was not received; settle the open inventory request, then mark this end.",
  [C.retriesExhausted]: "The end failed every automatic try.",
  [C.invariantBroken]: "This end request's saved data could not be read; nothing was ended.",
  // PROPOSED (Stage 4, step 1 plan S2-5): staff words for the end request list (review WRK-5).
  [C.credentialUnusable]: "Card Shellz could not use this store's eBay sign-in, and trying again will not help; nothing was ended.",
  [C.tickFailed]: "The end worker could not read its requests.",
  [C.archived]: "Not ended by this request: the size is archived and its removal is handled by the catalog.",
  [C.rePicked]: "Not ended: the vendor chose this item again.",
  [C.alreadyEnded]: "Not ended by Card Shellz: the listing had already ended on eBay.",
  [C.nothingListed]: "Not ended: nothing of this size was listed on eBay.",
  [C.supersededBySelection]: "Not ended: the vendor chose this item again before the end started.",
  [C.notPublishedOnEbay]: "Ended: eBay already showed the offer as not for sale.",
  [C.endedByStaff]: "Ended: Card Shellz staff ended it on eBay.",
});
