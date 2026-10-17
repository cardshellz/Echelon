import { ZodError } from "zod";
import { LISTING_SETTING_WRITE_ERROR_CODES } from "../../../../../shared/dropship/listing-setting-writes";
import { listingSettingIssues } from "../../application/dropship-listing-setting-write-support";
import { CONVERSION_CHECK_RETRY_AFTER_SECONDS } from "../../application/dropship-listing-settings-service";
import { DropshipError } from "../../domain/errors";

/**
 * How the listing-settings write routes answer a failure (plan PR 9, section
 * 3.3): one status per code, one class per answer, and a public context that
 * passes only identifiers, counts and classifications, never vendor text,
 * provider messages or internal detail.
 */

export type ListingSettingWriteErrorClass = "permanent" | "transient" | "fatal";

const CODES_BY_STATUS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [400, ["DROPSHIP_LISTING_SETTINGS_INVALID_INPUT", "DROPSHIP_REQUEST_JSON_INVALID", "DROPSHIP_LISTING_SETTINGS_BULK_INVALID"]],
  [401, ["DROPSHIP_AUTH_REQUIRED"]],
  [403, [
    "DROPSHIP_LISTING_VENDOR_BLOCKED", "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED",
    "DROPSHIP_LISTING_SETTINGS_EBAY_SIGN_IN_REQUIRED",
    // The three eBay providers' sign-in refusals, if a store loses its grant mid-request.
    "DROPSHIP_EBAY_LISTING_SETUP_PERMISSION_REQUIRED", "DROPSHIP_EBAY_STORE_CATEGORIES_PERMISSION_REQUIRED",
    "DROPSHIP_EBAY_CATEGORIES_PERMISSION_REQUIRED",
    // eBay refused the store's grant for the read (the setup routes answer the first two 403).
    "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_DENIED", "DROPSHIP_EBAY_STORE_CATEGORIES_ACCESS_DENIED", "DROPSHIP_EBAY_CATEGORIES_ACCESS_DENIED",
  ]],
  [404, [
    "DROPSHIP_STORE_CONNECTION_REQUIRED", "DROPSHIP_LISTING_SETTINGS_PRODUCT_NOT_FOUND", "DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND",
    "DROPSHIP_LISTING_PRICE_NOT_AVAILABLE", "DROPSHIP_PRICING_REVIEW_NOT_FOUND",
    // The one-time notice's [Got it] (PR 11e1, plan 3.4): no system conversion with that id on this store.
    LISTING_SETTING_WRITE_ERROR_CODES.conversionNoticeNotFound,
  ]],
  [409, [
    "DROPSHIP_IDEMPOTENCY_CONFLICT", "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
    "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT", "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
    "DROPSHIP_LISTING_PRICES_MOVED", "DROPSHIP_LISTING_SETTINGS_OLDER_RULES_PRESENT",
    // The rules conversion's apply (PR 11, plan 3.4): the plan recomputed under the store lock is not the one shown.
    LISTING_SETTING_WRITE_ERROR_CODES.conversionChanged,
    // The store was paused or disconnected while the eBay step ran, or has no token for it (the setup routes' 409s).
    "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED", "DROPSHIP_EBAY_LISTING_SETUP_ACCESS_TOKEN_REQUIRED",
    // Card Shellz shipping cannot back a new shipping policy until the setup is fixed (the capability check, W2's 409s).
    "DROPSHIP_EBAY_FULFILLMENT_MARKETPLACE_UNSUPPORTED", "DROPSHIP_EBAY_FULFILLMENT_SERVICES_REQUIRED",
    "DROPSHIP_EBAY_FULFILLMENT_ROUTING_REQUIRED", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_MISMATCH",
    "DROPSHIP_EBAY_FULFILLMENT_WAREHOUSE_REQUIRED", "DROPSHIP_EBAY_FULFILLMENT_SLA_REQUIRED",
    "DROPSHIP_EBAY_FULFILLMENT_RATE_TABLE_REQUIRED", "DROPSHIP_EBAY_FULFILLMENT_DESTINATION_COVERAGE_REQUIRED",
    // Built from selectRateBookAssignment's failure code (`DROPSHIP_EBAY_FULFILLMENT_${code}`, the capability provider),
    // so a literal grep misses them; the error-map test builds them the same way.
    "DROPSHIP_EBAY_FULFILLMENT_NO_RATE_BOOK", "DROPSHIP_EBAY_FULFILLMENT_AMBIGUOUS_RATE_BOOK",
  ]],
  [413, ["DROPSHIP_REQUEST_TOO_LARGE"]],
  [422, [
    "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST", "DROPSHIP_LISTING_PRICE_OUTSIDE_LIMIT", "DROPSHIP_PRICING_RULES_NOT_CONFIGURED",
    "DROPSHIP_LISTING_PRICE_RELEASE_LIMIT", "DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    "DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
    // The rules conversion's apply (PR 11, plan D9b): a listed size that can be sent today would be blocked after the move.
    LISTING_SETTING_WRITE_ERROR_CODES.conversionWouldBlockListing,
    // eBay values the vendor chose that eBay or the stored contract refuses.
    "DROPSHIP_EBAY_LISTING_SETUP_SELECTION_INVALID", "DROPSHIP_EBAY_FULFILLMENT_POLICY_INCOMPATIBLE",
    "DROPSHIP_EBAY_STORE_CATEGORY_INVALID", "DROPSHIP_EBAY_CATEGORY_RULE_INVALID", "DROPSHIP_EBAY_CATEGORY_MARKETPLACE_UNSUPPORTED",
  ]],
  [429, ["DROPSHIP_LISTING_SETTINGS_RATE_LIMITED"]],
  // eBay unavailable or answering out of contract: the lists of dropship-ebay-category-rules.routes.ts and dropship-ebay-listing-setup.routes.ts.
  [502, [
    "DROPSHIP_EBAY_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_CATEGORIES_INVALID_RESPONSE",
    "DROPSHIP_EBAY_LISTING_SETUP_UNAVAILABLE", "DROPSHIP_EBAY_LISTING_SETUP_INVALID_RESPONSE",
    "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_UNAVAILABLE", "DROPSHIP_EBAY_FULFILLMENT_SHIPSTATION_INVALID_RESPONSE",
    "DROPSHIP_EBAY_MANAGED_LOCATION_UNAVAILABLE", "DROPSHIP_EBAY_MANAGED_LOCATION_INVALID_RESPONSE",
    "DROPSHIP_EBAY_MANAGED_LOCATION_CREATE_CONFLICT",
    "DROPSHIP_EBAY_STORE_CATEGORIES_UNAVAILABLE", "DROPSHIP_EBAY_STORE_CATEGORIES_INVALID_RESPONSE",
  ]],
  [503, [
    "DROPSHIP_LISTING_SETTINGS_BUSY", "DROPSHIP_EBAY_FULFILLMENT_ROUTING_UNAVAILABLE",
    "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", "DROPSHIP_EBAY_REFRESH_LOCK_UNAVAILABLE", "DROPSHIP_CREDENTIAL_CHANGED",
    "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE", "DROPSHIP_EBAY_OAUTH_NOT_CONFIGURED",
    // The rules conversion's apply (PR 11, plan 3.4, D14): the .ops costs could not be read; Retry-After from the error.
    LISTING_SETTING_WRITE_ERROR_CODES.conversionCheckUnavailable,
  ]],
  // A broken contract: a human looks, nothing was saved.
  [500, ["DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE", "DROPSHIP_LISTING_PRICE_INVARIANT_FAILED"]],
];

/** Every code the write routes answer, with its status. A code not listed is a fault: 500. */
export const LISTING_SETTING_WRITE_STATUS: ReadonlyMap<string, number> = new Map(
  CODES_BY_STATUS.flatMap(([status, codes]) => codes.map((code) => [code, status] as const)),
);

export const LISTING_SETTINGS_INTERNAL_ERROR_CODE = LISTING_SETTING_WRITE_ERROR_CODES.internal;
/**
 * Every 500 says only this. Not "Nothing was saved": an answer that breaks its
 * contract fails after the commit, and a dropped COMMIT has an unknown
 * outcome. The page answers a 5xx with these words and [Check again], which
 * resends the same key (classifyWriteFailure,
 * client/src/lib/dropship-listing-settings-drafts.ts); the replay probe
 * answers it (plan P16), so it can never save twice.
 */
export const LISTING_SETTINGS_INTERNAL_MESSAGE = "Something went wrong. We couldn't confirm your save.";
const BUSY_CODE = LISTING_SETTING_WRITE_ERROR_CODES.busy;
/** When a busy answer names no wait of its own. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;
/**
 * The codes answered with `Retry-After`, and the wait when the error names
 * none of its own: a busy write's 5 seconds, and a cost read that failed
 * the rules conversion's apply the check's minute (plan 3.4, D14), so the
 * page never retries it sooner than the dry run would.
 */
const RETRY_AFTER_DEFAULTS: ReadonlyMap<string, number> = new Map([
  [BUSY_CODE, DEFAULT_RETRY_AFTER_SECONDS],
  [LISTING_SETTING_WRITE_ERROR_CODES.conversionCheckUnavailable, CONVERSION_CHECK_RETRY_AFTER_SECONDS],
]);
const MAX_RETRY_AFTER_SECONDS = 60;
const MAX_LISTED_ITEMS = 100;
/** A fatal failure's context on its ERROR line is cut at this many JSON characters. */
export const MAX_LOGGED_CONTEXT_CHARS = 4_096;

export interface ListingSettingWriteErrorAnswer {
  status: number;
  errorClass: ListingSettingWriteErrorClass;
  code: string;
  body: { error: { code: string; message: string; context?: Record<string, unknown> } };
  /** Set only for a busy answer or a conversion's cost read failure: the `Retry-After` header. */
  retryAfterSeconds: number | null;
  /** The failure's own message, for the ERROR line of a fatal failure only; never sent. */
  internalMessage: string | null;
  /** The failure's own structured context, for the ERROR line of a fatal failure only; never sent. */
  internalContext: Record<string, unknown> | null;
}

/**
 * The answer to one failure. Status from the code table; anything unlisted,
 * a plain error and a bare ZodError are 500. Input a service parses with
 * parseListingSettingInput is already DROPSHIP_LISTING_SETTINGS_INVALID_INPUT
 * (400), so a ZodError that reaches here came from a contract inside the
 * operation and is fatal. Class: a 500 is always fatal; otherwise the error's
 * own `context.classification` when it has one, else from the status (429,
 * 502 and 503 transient, other 4xx permanent).
 */
export function listingSettingWriteErrorAnswer(error: unknown): ListingSettingWriteErrorAnswer {
  const mapped = error instanceof DropshipError ? LISTING_SETTING_WRITE_STATUS.get(error.code) : undefined;
  if (!(error instanceof DropshipError) || mapped === undefined || mapped >= 500 && mapped !== 502 && mapped !== 503) {
    const code = error instanceof DropshipError && mapped !== undefined ? error.code : LISTING_SETTINGS_INTERNAL_ERROR_CODE;
    return {
      status: 500, errorClass: "fatal", code, retryAfterSeconds: null,
      internalMessage: internalMessageOf(error),
      internalContext: internalContextOf(error),
      body: { error: { code, message: LISTING_SETTINGS_INTERNAL_MESSAGE } },
    };
  }
  const context = publicListingSettingContext(error.context);
  return {
    status: mapped,
    errorClass: classOf(error.context?.classification) ?? classForStatus(mapped),
    code: error.code,
    retryAfterSeconds: retryAfterFor(error),
    internalMessage: null,
    internalContext: null,
    body: { error: { code: error.code, message: error.message, ...(context ? { context } : {}) } },
  };
}

/** A ZodError's own message quotes the values it refused, so its line carries the issues' paths and codes instead. */
function internalMessageOf(error: unknown): string {
  if (error instanceof ZodError) return `ZodError: ${error.issues.length} issue(s) in a listing settings contract.`;
  if (error instanceof DropshipError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Unknown failure";
}

/**
 * What a human needs beside the message (CLAUDE.md §6, §10): a DropshipError's
 * own context (an invariant's source and column, a CHECK's constraint and
 * table), a database or Node error's code (SQLSTATE or errno) and
 * constraint, a ZodError's issues.
 */
function internalContextOf(error: unknown): Record<string, unknown> | null {
  if (error instanceof ZodError) return { issues: listingSettingIssues(error.issues) };
  if (error instanceof DropshipError) return loggableContext(error.context);
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    const fields = error as { code: string; constraint?: unknown; table?: unknown };
    return {
      code: fields.code,
      ...(typeof fields.constraint === "string" ? { constraint: fields.constraint } : {}),
      ...(typeof fields.table === "string" ? { table: fields.table } : {}),
    };
  }
  return null;
}

/** JSON only and bounded, so a context the logger cannot write (a bigint, a cycle) never breaks the answer. */
function loggableContext(context: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!context) return null;
  let text: string;
  try {
    text = JSON.stringify(context);
  } catch (error) {
    return { unloggable: error instanceof Error ? error.message : "not JSON" };
  }
  return text.length <= MAX_LOGGED_CONTEXT_CHARS
    ? JSON.parse(text) as Record<string, unknown>
    : { truncated: text.slice(0, MAX_LOGGED_CONTEXT_CHARS) };
}

function classOf(value: unknown): ListingSettingWriteErrorClass | null {
  return value === "permanent" || value === "transient" || value === "fatal" ? value : null;
}

function classForStatus(status: number): ListingSettingWriteErrorClass {
  if (status >= 500 && status !== 502 && status !== 503) return "fatal";
  return status === 429 || status === 502 || status === 503 ? "transient" : "permanent";
}

/** The error's own wait when it names one in bounds, else its code's default; null for a code answered without one. */
function retryAfterFor(error: DropshipError): number | null {
  const fallback = RETRY_AFTER_DEFAULTS.get(error.code);
  if (fallback === undefined) return null;
  const value = error.context?.retryAfterSeconds;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_RETRY_AFTER_SECONDS
    ? value : fallback;
}

/** Scalars that may leave the server: ids, counts, flags and our own enum words. */
const SCALAR_KEYS = [
  "storeConnectionId", "productId", "categoryId", "productVariantId", "reviewId", "conflictCount", "sizeCount", "productCount",
  "pricingGroups", "contentGroups", "ebayCategoryRules", "textBytes", "maxTextBytes", "releaseCount", "maxReleases",
  "retryable", "classification",
] as const;
/**
 * `reason` passes only as one of our own enum words (plan 3.3: "our enum words
 * only"). Some providers put a sentence there: the capability provider's rate
 * book refusal names the pricing channel and the warehouse id, and the
 * taxonomy's invalid-response reasons are sentences. Those stay out of the body.
 */
const REASON_WORD = /^[a-z][a-z0-9_]{0,63}$/;
/** Lists of field names. */
const NAME_LIST_KEYS = ["fields", "invalidFields"] as const;
const CONFLICT_KEYS = ["productVariantId", "productId", "categoryId", "expectedRevisionId", "actualRevisionId"] as const;
const SIZE_KEYS = ["productVariantId", "expectedPriceCents", "priceCents", "beforePriceCents", "afterPriceCents", "refusal"] as const;

/** Only the allow-listed keys (plan 3.3), lists capped; anything else is dropped. Undefined when nothing is left. */
export function publicListingSettingContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const safe: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (isScalar(context[key])) safe[key] = context[key];
  }
  if (typeof context.reason === "string" && REASON_WORD.test(context.reason)) safe.reason = context.reason;
  for (const key of NAME_LIST_KEYS) {
    const names = context[key];
    if (Array.isArray(names)) safe[key] = names.filter((name): name is string => typeof name === "string").slice(0, MAX_LISTED_ITEMS);
  }
  if (Array.isArray(context.productIds)) {
    safe.productIds = context.productIds.filter(isWholeNumber).slice(0, MAX_LISTED_ITEMS);
  }
  if (Array.isArray(context.conflicts)) safe.conflicts = pickEach(context.conflicts, CONFLICT_KEYS);
  if (Array.isArray(context.sizes)) {
    safe.sizes = context.sizes.slice(0, MAX_LISTED_ITEMS).filter(isRecord).map((size) => ({
      ...pick(size, SIZE_KEYS),
      ...(Array.isArray(size.blockers) ? { blockers: size.blockers.filter((code): code is string => typeof code === "string") } : {}),
    }));
  }
  // Rebuilt, never passed through: an issue's other fields can quote what was sent (plan P5).
  if (Array.isArray(context.issues)) safe.issues = listingSettingIssues(context.issues);
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function pickEach(values: readonly unknown[], keys: readonly string[]): Array<Record<string, unknown>> {
  return values.slice(0, MAX_LISTED_ITEMS).filter(isRecord).map((value) => pick(value, keys));
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => isScalar(value[key])).map((key) => [key, value[key]]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "boolean" || typeof value === "string" || isWholeNumber(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}
