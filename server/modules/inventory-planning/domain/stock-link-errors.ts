import { isDatabaseUnavailableError } from "../../../infrastructure/database-unavailable-error";
import type { StockLinkErrorClass } from "@shared/types/stock-link";

/**
 * Every failure the stock-link engine meets, classified (channels PR2, PLAN-CH2 v4.1 §4.6, §10; CLAUDE.md §6). Pure:
 * it reads only an error's code, message, name and retry hint. Built as a superset of Dropship's sets
 * (DS/domain/stock-link-readiness.ts TRANSIENT_STOCK_LINK_CODES, TRANSIENT_SQLSTATES, TRANSIENT_FENCE_MESSAGES), which
 * classify the same writer's failures for the push link; a Dropship unit test pins the superset (SAF-4).
 *
 * Kinds (each maps to one CLAUDE.md class):
 * - busy (transient): a lock, the fence or a budget was taken. The row is released; no attempt is counted, its
 *   `busy_since` streak is kept, it is due again in 60-180 s (DV4-4).
 * - transient: a race or a provider outcome that may pass. An attempt is counted; backoff (STOCK_LINK_RETRY).
 * - database_unavailable (transient): the connection is gone. The tick stops and writes nothing more; leases expire.
 * - cleanup_uncertain (transient): the store could not confirm its scope unlock after COMMIT or ROLLBACK; the
 *   command's receipt decides whether it applied (§4.3, TST-7).
 * - pause (transient, destination): the store refused the login or is unavailable, or a safety stop found no control.
 * - permanent (row): the row turns `error` and is never retried until Check again.
 * - fatal (destination): the destination halts with one ERROR (DV4-13). Any error this table does not know is fatal
 *   (STOCK_LINK_UNCLASSIFIED), so a misread transient is loud instead of a silently never-retried row.
 */

export type StockLinkFailureKind =
  | "busy" | "transient" | "database_unavailable" | "cleanup_uncertain" | "pause" | "permanent" | "fatal";

/** row = this check row; destination = every row of the destination (provider reads are batch reads, SAF-9);
 * tick = the whole tick stops (the database is gone). */
export type StockLinkFailureScope = "row" | "destination" | "tick";

export const STOCK_LINK_ERROR_CODES = Object.freeze({
  // Busy: taken by someone else or a budget is used up (§4.6, §4.7, §7.2 step 5).
  pairBusy: "STOCK_LINK_PAIR_BUSY",
  scopeBusy: "STOCK_LINK_SCOPE_BUSY",
  /** 40001 / 40P01 / 55P03 that reached the engine raw (outside the mapping store, which folds them). */
  databaseBusy: "STOCK_LINK_DATABASE_BUSY",
  fenceBudgetUsed: "STOCK_LINK_FENCE_BUDGET_USED",
  callBudgetUsed: "STOCK_LINK_CALL_BUDGET_USED",
  /** The store's cost bucket is below STOCK_LINK_COST_FLOOR_RATIO (§6.1): stop reading, count nothing. */
  providerCostFloor: "STOCK_LINK_PROVIDER_COST_FLOOR",
  // Transient.
  lookupIncomplete: "STOCK_LINK_LOOKUP_INCOMPLETE",
  lookupMissed: "STOCK_LINK_LOOKUP_MISSED",
  providerUnavailable: "STOCK_LINK_PROVIDER_UNAVAILABLE",
  providerThrottled: "STOCK_LINK_PROVIDER_THROTTLED",
  /** Invalid JSON or GraphQL envelope (§6.1 "invalid JSON/envelope → transient"). */
  providerResponseInvalid: "STOCK_LINK_PROVIDER_RESPONSE_INVALID",
  connectionChanged: "STOCK_LINK_CONNECTION_CHANGED",
  skuChangedSinceRead: "STOCK_LINK_SKU_CHANGED_SINCE_READ",
  headChanged: "STOCK_LINK_HEAD_CHANGED",
  claimLost: "STOCK_LINK_CLAIM_LOST",
  evidenceStale: "STOCK_LINK_EVIDENCE_STALE",
  /** SQLSTATE 57014 (the store's statement_timeout 60 s, TST-2). */
  statementTimeout: "STOCK_LINK_STATEMENT_TIMEOUT",
  databaseUnavailable: "STOCK_LINK_DATABASE_UNAVAILABLE",
  // Pause (destination).
  storeAuthRefused: "STOCK_LINK_STORE_AUTH_REFUSED",
  storeUnavailable: "STOCK_LINK_STORE_UNAVAILABLE",
  storeNotAnswering: "STOCK_LINK_STORE_NOT_ANSWERING",
  // Permanent (row).
  checkViolation: "STOCK_LINK_CHECK_VIOLATION",
  // Fatal (destination halt).
  adapterContract: "STOCK_LINK_ADAPTER_CONTRACT",
  idInvalid: "STOCK_LINK_ID_INVALID",
  policyMissing: "STOCK_LINK_POLICY_MISSING",
  rollbackFailed: "STOCK_LINK_ROLLBACK_FAILED",
  stateInvalid: "STOCK_LINK_STATE_INVALID",
  providerRejected: "STOCK_LINK_PROVIDER_REJECTED",
  unclassified: "STOCK_LINK_UNCLASSIFIED",
});

const C = STOCK_LINK_ERROR_CODES;

/** Codes raised by the mapping store, the draft writer, the sealer, the fence and the enqueue that the engine meets. */
export const STOCK_LINK_UPSTREAM_CODES = Object.freeze({
  mappingConcurrentChange: "STOCK_MAPPING_CONCURRENT_CHANGE",
  mappingProviderBusy: "STOCK_MAPPING_PROVIDER_BUSY",
  mappingReviewStale: "STOCK_MAPPING_REVIEW_STALE",
  mappingNotReady: "STOCK_MAPPING_NOT_READY",
  mappingTargetChanged: "STOCK_MAPPING_TARGET_CHANGED",
  mappingAuthorityChanged: "STOCK_MAPPING_AUTHORITY_CHANGED",
  mappingCleanupUncertain: "STOCK_MAPPING_CLEANUP_UNCERTAIN",
  mappingCommandConflict: "STOCK_MAPPING_COMMAND_CONFLICT",
  mappingLinkChangedAfterApply: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY",
  canonicalAuthorityRequired: "CANONICAL_AUTHORITY_REQUIRED",
  listingTargetMismatch: "STOCK_LISTING_TARGET_MISMATCH",
  targetBusy: "INVENTORY_PUBLICATION_TARGET_BUSY",
  reviewedHeadChanged: "CUTOVER_REVIEWED_HEAD_CHANGED",
  draftIdentityConflict: "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT",
  draftScopeInvalid: "INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID",
  draftStale: "INVENTORY_CHANNEL_EXPOSURE_STALE_VARIANT_MAPPING",
  draftIdempotencyConflict: "INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT",
  draftHistoryInvalid: "INVENTORY_PUBLICATION_VARIANT_MAPPING_HISTORY_INVALID",
});

const U = STOCK_LINK_UPSTREAM_CODES;

export const STOCK_LINK_BUSY_CODES: ReadonlySet<string> = new Set([
  U.mappingConcurrentChange, U.mappingProviderBusy, U.targetBusy,
  C.pairBusy, C.scopeBusy, C.databaseBusy, C.fenceBudgetUsed, C.callBudgetUsed, C.providerCostFloor,
]);

export const STOCK_LINK_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  C.providerUnavailable, C.providerThrottled, C.providerResponseInvalid, C.lookupIncomplete, C.lookupMissed,
  C.connectionChanged, C.skuChangedSinceRead, C.headChanged, C.claimLost, C.evidenceStale, C.statementTimeout,
  U.mappingReviewStale, U.mappingNotReady, U.mappingTargetChanged, U.mappingAuthorityChanged,
  U.canonicalAuthorityRequired, U.reviewedHeadChanged,
  // Races with a manual draft save: the next tick re-decides from current state (SAF-4).
  U.draftIdentityConflict, U.draftScopeInvalid, U.draftStale,
]);

export const STOCK_LINK_CLEANUP_UNCERTAIN_CODE = U.mappingCleanupUncertain;

export const STOCK_LINK_PAUSE_CODES: ReadonlySet<string> = new Set([C.storeAuthRefused, C.storeUnavailable, C.storeNotAnswering]);

/**
 * A row that would only fail the same way again. INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT is the draft writer's
 * own form of a command conflict (its draft key `stock-link:<commandKey>:<variantId>` replayed with another request
 * hash), so it is classified like STOCK_MAPPING_COMMAND_CONFLICT (BUILD-NOTES D-P2-6).
 */
export const STOCK_LINK_PERMANENT_CODES: ReadonlySet<string> = new Set([
  U.mappingCommandConflict, U.mappingLinkChangedAfterApply, C.checkViolation, U.draftHistoryInvalid,
  U.draftIdempotencyConflict,
]);

export const STOCK_LINK_FATAL_CODES: ReadonlySet<string> = new Set([
  C.adapterContract, C.idInvalid, C.policyMissing, C.rollbackFailed, C.stateInvalid, U.listingTargetMismatch,
  C.providerRejected, C.unclassified,
]);

/** Serialization failure, deadlock, lock not available (NOWAIT / lock_timeout): someone else holds it. */
export const STOCK_LINK_BUSY_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03"]);
/** Statement timeout: a retry may pass, and it counts (TST-2). */
export const STOCK_LINK_TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(["57014"]);
/** A CHECK constraint refused the write (§4.3 step 7): repeating the same write cannot pass. */
const CHECK_VIOLATION_SQLSTATE = "23514";

/**
 * The cutover fence's SQLSTATE 55000 messages (migrations/236_inventory_cutover_admission.sql): an open activation
 * freeze is a wait; authority moving is a race. CUTOVER_AUTHORITY_INVALID and CUTOVER_ADMISSION_SINGLETON_MISSING
 * are broken invariants and stay fatal.
 */
const FENCE_SQLSTATE = "55000";
export const STOCK_LINK_BUSY_FENCE_MESSAGES: ReadonlySet<string> = new Set([
  "CUTOVER_CONFIGURATION_FREEZE_CHANGED", "CUTOVER_CONFIGURATION_FROZEN",
]);
export const STOCK_LINK_TRANSIENT_FENCE_MESSAGES: ReadonlySet<string> = new Set(["CUTOVER_AUTHORITY_CHANGED"]);

/** Everything the engine tries again by itself (busy, transient, cleanup-uncertain): the Dropship parity superset. */
export const STOCK_LINK_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  ...STOCK_LINK_BUSY_CODES, ...STOCK_LINK_TRANSIENT_CODES, STOCK_LINK_CLEANUP_UNCERTAIN_CODE,
]);
export const STOCK_LINK_RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set([
  ...STOCK_LINK_BUSY_SQLSTATES, ...STOCK_LINK_TRANSIENT_SQLSTATES,
]);
export const STOCK_LINK_RETRYABLE_FENCE_MESSAGES: ReadonlySet<string> = new Set([
  ...STOCK_LINK_BUSY_FENCE_MESSAGES, ...STOCK_LINK_TRANSIENT_FENCE_MESSAGES,
]);

/** Provider-side codes of the adapter: every provider read is a batch read, so each is destination-scoped (SAF-9). */
const DESTINATION_CODES: ReadonlySet<string> = new Set([
  C.providerUnavailable, C.providerThrottled, C.providerResponseInvalid, C.lookupIncomplete, C.callBudgetUsed,
  C.providerCostFloor, C.fenceBudgetUsed,
]);

const KIND_CLASS: Readonly<Record<StockLinkFailureKind, StockLinkErrorClass>> = Object.freeze({
  busy: "transient", transient: "transient", database_unavailable: "transient", cleanup_uncertain: "transient",
  pause: "transient", permanent: "permanent", fatal: "fatal",
});

/** The engine's structured error ({ code, message, errorClass, context }, CLAUDE.md §6). */
export class StockLinkError extends Error {
  /** Derived from the code (an unknown code is fatal), so a thrower cannot mislabel it. */
  readonly errorClass: StockLinkErrorClass;
  readonly retryAfterMs: number | null;
  constructor(readonly code: string, message: string, readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions & { retryAfterMs?: number | null }) {
    super(message, options);
    this.name = "StockLinkError";
    this.errorClass = KIND_CLASS[stockLinkCodeKind(code) ?? "fatal"];
    this.retryAfterMs = validRetryAfter(options?.retryAfterMs);
  }
}

export interface StockLinkFailureClassification {
  readonly kind: StockLinkFailureKind;
  readonly errorClass: StockLinkErrorClass;
  /** The code the check row or destination records (a stock-link code, or the upstream code itself). */
  readonly code: string;
  /** The error's own code (SQLSTATE, upstream code or error name) when it differs from `code`; for logs only. */
  readonly causeCode: string | null;
  readonly scope: StockLinkFailureScope;
  /** Whether the row's attempt_count (and first_failure_at streak) moves: transient only. */
  readonly countsAttempt: boolean;
  /** The provider's own retry time, when it gave one (Retry-After); never shortens the backoff. */
  readonly retryAfterMs: number | null;
}

/** The kind of a code the engine records, or null when the code is not one this table knows. */
export function stockLinkCodeKind(code: string): StockLinkFailureKind | null {
  if (STOCK_LINK_BUSY_CODES.has(code)) return "busy";
  if (STOCK_LINK_TRANSIENT_CODES.has(code)) return "transient";
  if (code === STOCK_LINK_CLEANUP_UNCERTAIN_CODE) return "cleanup_uncertain";
  if (code === C.databaseUnavailable) return "database_unavailable";
  if (STOCK_LINK_PAUSE_CODES.has(code)) return "pause";
  if (STOCK_LINK_PERMANENT_CODES.has(code)) return "permanent";
  if (STOCK_LINK_FATAL_CODES.has(code)) return "fatal";
  return null;
}

function scopeOf(kind: StockLinkFailureKind, code: string): StockLinkFailureScope {
  if (kind === "database_unavailable") return "tick";
  if (kind === "fatal" || kind === "pause") return "destination";
  return DESTINATION_CODES.has(code) ? "destination" : "row";
}

function classified(kind: StockLinkFailureKind, code: string, causeCode: string | null, retryAfterMs: number | null):
  StockLinkFailureClassification {
  return Object.freeze({
    kind, errorClass: KIND_CLASS[kind], code, causeCode: causeCode === code ? null : causeCode,
    scope: scopeOf(kind, code), countsAttempt: kind === "transient", retryAfterMs,
  });
}

/**
 * Classify anything the engine caught. Order matters: a code the table knows wins; then SQLSTATEs; then a lost
 * connection (with or without a code, TST-2); then the fence's 55000 messages; a failed rollback (AggregateError) is
 * fatal; anything else is STOCK_LINK_UNCLASSIFIED, fatal for the destination.
 */
export function classifyStockLinkFailure(error: unknown): StockLinkFailureClassification {
  const code = errorCode(error);
  const retryAfterMs = errorRetryAfter(error);
  const known = code === null ? null : stockLinkCodeKind(code);
  if (code !== null && known !== null) return classified(known, code, code, retryAfterMs);
  if (code !== null && STOCK_LINK_BUSY_SQLSTATES.has(code)) return classified("busy", C.databaseBusy, code, null);
  if (code !== null && STOCK_LINK_TRANSIENT_SQLSTATES.has(code)) return classified("transient", C.statementTimeout, code, null);
  if (code === CHECK_VIOLATION_SQLSTATE) return classified("permanent", C.checkViolation, code, null);
  if (isDatabaseUnavailableError(error)) return classified("database_unavailable", C.databaseUnavailable, code, null);
  const message = error instanceof Error ? error.message.trim() : "";
  if (code === FENCE_SQLSTATE && STOCK_LINK_BUSY_FENCE_MESSAGES.has(message)) return classified("busy", message, code, null);
  if (code === FENCE_SQLSTATE && STOCK_LINK_TRANSIENT_FENCE_MESSAGES.has(message)) return classified("transient", message, code, null);
  if (error instanceof AggregateError) return classified("fatal", C.rollbackFailed, code ?? "AggregateError", null);
  const name = error instanceof Error && error.name !== "Error" ? error.name : null;
  return classified("fatal", C.unclassified, code ?? name ?? "UNKNOWN", null);
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const value = (error as { code: unknown }).code;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function errorRetryAfter(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("retryAfterMs" in error)) return null;
  return validRetryAfter((error as { retryAfterMs: unknown }).retryAfterMs);
}

/** A provider retry hint is used only when it is a finite, non-negative whole number of milliseconds. */
function validRetryAfter(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * What the tick does with a failure it meets outside a command (§4.6, §7.2): a provider read, or its own short
 * discovery, claim and record writes. A command classifies and records its own failures (stock-link-shopify-command.ts).
 * - stop_tick: the database is gone; nothing more is written this tick, leases expire;
 * - pause: the destination pauses (paused_until), its claimed rows are left to expire;
 * - release_busy: the rows not yet decided are released busy (no attempt);
 * - release_transient: the rows not yet decided record a transient attempt (backoff, Retry-After);
 * - halt: a permanent or fatal failure is never retried by the tick: the destination halts with one ERROR until a
 *   person presses Check again (CLAUDE.md §6, DV4-13).
 */
export type StockLinkTickFailureAction = "stop_tick" | "pause" | "release_busy" | "release_transient" | "halt";

export function stockLinkTickFailureAction(failure: Pick<StockLinkFailureClassification, "kind">): StockLinkTickFailureAction {
  switch (failure.kind) {
    case "database_unavailable": return "stop_tick";
    case "pause": return "pause";
    case "busy": return "release_busy";
    case "transient": case "cleanup_uncertain": return "release_transient";
    case "permanent": case "fatal": return "halt";
  }
}
