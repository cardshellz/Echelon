import { DropshipError } from "./errors";

/**
 * eBay sync-back's error codes and their classification (plan v4 §6.6, root
 * CLAUDE.md §6). Every failure the sync use case, its sweep or its push
 * pre-read meets is one of: transient (retry later, the work is idempotent),
 * permanent (flag or review; never retried as a write), fatal (abort the
 * tick and alert) or expected (a terminal fact, logged at DEBUG). Handlers
 * branch on `handling`, never on message text.
 */
export const MARKETPLACE_SYNC_CODES = {
  /** The vendor ended the listing on eBay; only the vendor's own Publish relists it (SB9). */
  endedOnEbay: "DROPSHIP_LISTING_ENDED_ON_EBAY",
  /** The read does not prove the listing is ours (SKU, offer, variation, unreadable): pushes stop (§4.2). */
  identityUnproven: "DROPSHIP_LISTING_MARKETPLACE_IDENTITY_UNPROVEN",
  /** The connector's last look before writing saw a change since the pre-read (SB5, a vendor edit included): pause, zero writes. */
  changedDuringPush: "DROPSHIP_EBAY_LISTING_CHANGED_DURING_PUSH",
  /** A needed adoption could not commit for a passing reason: pause, zero writes (§5). */
  adoptionRetry: "DROPSHIP_MARKETPLACE_SYNC_ADOPTION_RETRY",
  /** eBay is below what sales explain and the decision waits for the order poll: pause, zero writes (§5). */
  quantityPending: "DROPSHIP_MARKETPLACE_SYNC_QUANTITY_PENDING",
  /** The inventory transport's pre-write refusal for the same reason: a proven no-send (§6.4). */
  quantityVendorChangePending: "DROPSHIP_QUANTITY_VENDOR_CHANGE_PENDING",
  /** A compare-and-set on the saved observation lost to another writer (SB4). */
  observationChanged: "DROPSHIP_MARKETPLACE_SYNC_OBSERVATION_CHANGED",
  /** Card Shellz's ATP is 0 but eBay shows some, and a push cannot send 0 (§6.4 notes): flagged for staff, no vendor notice. */
  quantityRestoreBlocked: "DROPSHIP_LISTING_QUANTITY_RESTORE_BLOCKED",
  /** A push pre-read has no SKU to read the listing by (no stored intent SKU and none in the catalog): the push fails, never retried as is. */
  nothingToCompare: "DROPSHIP_MARKETPLACE_SYNC_NOTHING_TO_COMPARE",
  /**
   * The listing needs Card Shellz's review (sync_requires_review): a sync of
   * it failed for a reason of Card Shellz's own that no retry fixes. A push
   * of it fails, never retried, until a person clears the flag, so nothing
   * the vendor owns on eBay is overwritten unchecked (owner rules 2 and 4).
   */
  requiresReview: "DROPSHIP_MARKETPLACE_SYNC_REQUIRES_REVIEW",
  /** The listing the sync was asked about does not exist (any more). */
  listingNotFound: "DROPSHIP_MARKETPLACE_SYNC_LISTING_NOT_FOUND",
  /**
   * The store cannot be read now (its eBay credentials could not be loaded or
   * refreshed, or what Card Shellz would send for it could not be computed):
   * every listing of the store would fail the same way, so the store waits
   * for the next tick. A store that needs re-authorization is not selected.
   */
  storeUnavailable: "DROPSHIP_MARKETPLACE_SYNC_STORE_UNAVAILABLE",
  /** A sync-back key or input that cannot be built: a defect in the caller. */
  invalidKey: "DROPSHIP_MARKETPLACE_SYNC_KEY_INVALID",
  /** A rule the decision guarantees did not hold (for example live sales above all sales). */
  invariantFailed: "DROPSHIP_MARKETPLACE_SYNC_INVARIANT_FAILED",
} as const;
export type MarketplaceSyncCode = (typeof MARKETPLACE_SYNC_CODES)[keyof typeof MARKETPLACE_SYNC_CODES];

export type MarketplaceSyncErrorClass = "transient" | "permanent" | "fatal" | "expected";
export type MarketplaceSyncErrorHandling =
  /** Network, timeout or 5xx: leave the listing for the next tick. */
  | "skip_listing"
  /** 429: eBay asked this store to slow down; nothing more for it this tick. */
  | "stop_store"
  /** The vendor's token was refused after its one repair: the store waits for re-authorization. */
  | "skip_store"
  /** A race was lost (a version, serialization, deadlock, lock or compare-and-set conflict): decide again next tick. */
  | "retry_next_tick"
  /** W9 refused the vendor's price as outside a Card Shellz limit: flag price_outside_card_shellz_limit. */
  | "flag_price_limit"
  /** A terminal fact (the vendor or store may not list, the size is not available): nothing to do. */
  | "ignore"
  /** A defect or a refusal no retry can fix: requires_review and a human. */
  | "review"
  /** An invariant broke: stop the tick and alert. */
  | "abort_tick";

export interface MarketplaceSyncErrorClassification {
  classification: MarketplaceSyncErrorClass;
  handling: MarketplaceSyncErrorHandling;
  /** The structured code to log (`error_code`): the error's own code, the SQLSTATE, or UNEXPECTED_ERROR. */
  code: string;
  logLevel: "debug" | "warn" | "error";
}

/** A sync-back error with its classification in the context, as the module's other classified errors carry it. */
export function marketplaceSyncError(code: string, message: string, classification: Exclude<MarketplaceSyncErrorClass, "expected">,
  context: Record<string, unknown> = {}): DropshipError {
  return new DropshipError(code, message, { ...context, classification, retryable: classification === "transient" });
}

const FATAL_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED", MARKETPLACE_SYNC_CODES.invariantFailed, MARKETPLACE_SYNC_CODES.invalidKey,
]);
const RACE_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", MARKETPLACE_SYNC_CODES.observationChanged,
]);
const EXPECTED_TERMINAL_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED",
  "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "DROPSHIP_STORE_CONNECTION_REQUIRED", MARKETPLACE_SYNC_CODES.listingNotFound,
]);
/** SQLSTATEs a retry can clear: serialization, deadlock, lock not available, statement timeout. */
const TRANSIENT_SQL_STATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "57014"]);
/** The size policy row's coherence trigger refusing a stale predecessor: another save won the race. */
const PREDECESSOR_CONFLICT = /predecessor conflict/i;

export function classifyMarketplaceSyncError(error: unknown): MarketplaceSyncErrorClassification {
  if (error instanceof DropshipError) return classifyDropshipError(error);
  const sqlState = sqlStateOf(error);
  if (sqlState !== null) return classifySqlState(sqlState, error);
  // A Node I/O error (ECONNRESET, ETIMEDOUT, ...) below the providers' own wrapping: the listing is read again next tick.
  if (systemErrorCodeOf(error) !== null) return { classification: "transient", handling: "skip_listing", code: systemErrorCodeOf(error)!, logLevel: "warn" };
  // Anything else nothing classifies is a defect a retry repeats (review MS4, CLAUDE.md §6): reviewed once, never retried.
  return { classification: "permanent", handling: "review", code: "UNEXPECTED_ERROR", logLevel: "error" };
}

/** A Node system error's code (an E-prefixed errno name), or null. */
function systemErrorCodeOf(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && /^E[A-Z0-9_]{2,40}$/.test(code) ? code : null;
}

function classifyDropshipError(error: DropshipError): MarketplaceSyncErrorClassification {
  const context = error.context ?? {};
  const code = error.code;
  if (FATAL_CODES.has(code) || context.classification === "fatal") return { classification: "fatal", handling: "abort_tick", code, logLevel: "error" };
  if (code === MARKETPLACE_SYNC_CODES.storeUnavailable) return { classification: "transient", handling: "skip_store", code, logLevel: "warn" };
  const status = typeof context.status === "number" ? context.status : null;
  if (status === 429) return { classification: "transient", handling: "stop_store", code, logLevel: "warn" };
  if (status === 401 || status === 403) return { classification: "transient", handling: "skip_store", code, logLevel: "warn" };
  if ((status !== null && status >= 500) || context.network === true) {
    return { classification: "transient", handling: "skip_listing", code, logLevel: "warn" };
  }
  if (RACE_CODES.has(code)) return { classification: "transient", handling: "retry_next_tick", code, logLevel: "debug" };
  if (code === "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT") return { classification: "permanent", handling: "flag_price_limit", code, logLevel: "warn" };
  if (EXPECTED_TERMINAL_CODES.has(code)) return { classification: "expected", handling: "ignore", code, logLevel: "debug" };
  if (status !== null && status >= 400) return { classification: "permanent", handling: "review", code, logLevel: "error" };
  if (context.classification === "transient" || context.retryable === true) {
    return { classification: "transient", handling: "retry_next_tick", code, logLevel: "warn" };
  }
  return { classification: "permanent", handling: "review", code, logLevel: "error" };
}

function classifySqlState(sqlState: string, error: unknown): MarketplaceSyncErrorClassification {
  if (TRANSIENT_SQL_STATES.has(sqlState)) return { classification: "transient", handling: "retry_next_tick", code: sqlState, logLevel: "debug" };
  if (sqlState === "23514" && PREDECESSOR_CONFLICT.test(messageOf(error))) {
    return { classification: "transient", handling: "retry_next_tick", code: sqlState, logLevel: "debug" };
  }
  // Connection loss and resource exhaustion pass; the listing is read again next tick.
  if (sqlState.startsWith("08") || sqlState.startsWith("53") || sqlState.startsWith("57")) {
    return { classification: "transient", handling: "skip_listing", code: sqlState, logLevel: "warn" };
  }
  // A constraint or SQL error is a defect a retry repeats (§6.6: SQLSTATE 23/42 permanent).
  return { classification: "permanent", handling: "review", code: sqlState, logLevel: "error" };
}

function sqlStateOf(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "";
}
