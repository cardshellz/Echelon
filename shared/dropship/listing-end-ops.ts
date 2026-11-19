import { z } from "zod";

/**
 * Route contracts of the staff list of listing end requests (PR C, PLAN-C v4.1 §10, D36): Card Shellz staff operating
 * Dropship see the eBay listings Card Shellz could not end and Retry or Mark resolved each one.
 *
 * - `GET /api/dropship/admin/listing-ends?state=&vendorId=&storeConnectionId=&page=&limit=` (`dropship:view`)
 * - `POST /api/dropship/admin/listing-ends/:id/retry` `{ reason?, idempotencyKey }` (`dropship:manage_operations`)
 * - `POST /api/dropship/admin/listing-ends/:id/resolve` `{ outcome, reason, idempotencyKey }` (`dropship:manage_operations`)
 *
 * The idempotency key comes from the body or the `Idempotency-Key` header. The server parses every answer with these
 * schemas before it sends it and the admin page parses the same schemas when it reads one, so a field that changes on
 * one side fails on both. Answers are not strict: a field a later release adds is dropped, never refused; a field the
 * page needs that is missing makes the answer "the site is updating" (readDropshipAnswer, TST-9).
 */

/** Every state of an end request (the migration's CHECK). `pending`/`ending` are the worker's; `failed` waits for staff. */
export const LISTING_END_REQUEST_STATES = ["pending", "ending", "ended", "failed", "superseded", "resolved"] as const;
export type ListingEndRequestState = (typeof LISTING_END_REQUEST_STATES)[number];

export const LISTING_END_REQUEST_REASONS = ["size_removed", "product_removed"] as const;

/** What a staff member did about a failed end: Retry, or Mark resolved with one of two outcomes (SAF-8, DC27). */
export const LISTING_END_STAFF_ACTIONS = ["retry", "resolve_ended", "resolve_left"] as const;
export type ListingEndStaffAction = (typeof LISTING_END_STAFF_ACTIONS)[number];

/** "Ended on eBay": staff ended it (or saw it ended) on eBay, a Card Shellz end. "Left on sale": the end is closed. */
export const LISTING_END_STAFF_OUTCOMES = ["ended_on_ebay", "left_on_sale"] as const;
export type ListingEndStaffOutcome = (typeof LISTING_END_STAFF_OUTCOMES)[number];

/** The state the list shows when none is asked for: the ends that wait for staff. */
export const LISTING_END_OPS_DEFAULT_STATE: ListingEndRequestState = "failed";
/** Offset paging, the push-ops list's bounds (dropship-listing-push-ops-dtos.ts). */
export const LISTING_END_OPS_MAX_PAGE = 10_000;
export const LISTING_END_OPS_MAX_LIMIT = 200;
export const LISTING_END_OPS_DEFAULT_LIMIT = 50;
/** A staff reason is required to resolve and optional to retry; 1-500 characters after trimming (SAF-8). */
export const LISTING_END_STAFF_REASON_MAX_LENGTH = 500;
/** The key bounds of every Dropship admin action (dropship-listing-push-ops-dtos.ts). */
export const LISTING_END_STAFF_KEY_MIN_LENGTH = 8;
export const LISTING_END_STAFF_KEY_MAX_LENGTH = 200;

/** Every code these routes answer with besides their 2xx answers. */
export const LISTING_END_OPS_ERROR_CODES = Object.freeze({
  /** 400: a list query outside its bounds. */
  listInvalidInput: "DROPSHIP_LISTING_END_OPS_LIST_INVALID_INPUT",
  /** 400: a Retry or Resolve without a key, a resolve without a reason or outcome, a bad id. */
  actionInvalidInput: "DROPSHIP_LISTING_END_OPS_ACTION_INVALID_INPUT",
  /** 404 */
  notFound: "DROPSHIP_LISTING_END_NOT_FOUND",
  /** 409: the request is not `failed` (and the key is not this request's own). */
  staffStateInvalid: "DROPSHIP_LISTING_END_STAFF_STATE_INVALID",
  /** 409: the key answered another action on this request (TST-5: keys are scoped by action). */
  staffKeyReused: "DROPSHIP_LISTING_END_STAFF_KEY_REUSED",
  /** 409: an inventory request on this SKU is not settled, so a retried withdraw could never be admitted (SAF-3 b). */
  quantityRecoveryRequired: "DROPSHIP_LISTING_END_QUANTITY_RECOVERY_REQUIRED",
  /** 503: a lock or the inventory gate was busy; nothing was written; the same request may be sent again. */
  staffBusy: "DROPSHIP_LISTING_END_STAFF_BUSY",
});

const rowId = z.number().int().positive().max(2_147_483_647);
const requestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative();
const isoDate = z.string().datetime();

const staffReason = z.string().trim().min(1).max(LISTING_END_STAFF_REASON_MAX_LENGTH);
const staffKey = z.string().trim().min(LISTING_END_STAFF_KEY_MIN_LENGTH).max(LISTING_END_STAFF_KEY_MAX_LENGTH);

/** The Retry body (the key may come from the header instead; the route merges it). */
export const listingEndRetryRequestSchema = z.object({
  reason: staffReason.optional(),
  idempotencyKey: staffKey,
}).strict();
export type ListingEndRetryRequest = z.infer<typeof listingEndRetryRequestSchema>;

/** The Mark resolved body: the outcome and the reason are both required (SAF-8). */
export const listingEndResolveRequestSchema = z.object({
  outcome: z.enum(LISTING_END_STAFF_OUTCOMES),
  reason: staffReason,
  idempotencyKey: staffKey,
}).strict();
export type ListingEndResolveRequest = z.infer<typeof listingEndResolveRequestSchema>;

/** One end request as staff see it. Ids, codes and counts only: no token, no eBay body. */
export const listingEndOpsRowSchema = z.object({
  endRequestId: requestId,
  vendor: z.object({ vendorId: rowId, memberId: z.string(), businessName: z.string().nullable(), email: z.string().nullable() }),
  store: z.object({ storeConnectionId: rowId, platform: z.string(), status: z.string(), displayName: z.string().nullable() }),
  listing: z.object({ listingId: rowId, status: z.string(), externalListingId: z.string().nullable(), externalOfferId: z.string().nullable() }),
  productId: rowId,
  productVariantId: rowId,
  /** The size's own SKU from the catalog, or null when the catalog has none. */
  sku: z.string().nullable(),
  reason: z.enum(LISTING_END_REQUEST_REASONS),
  state: z.enum(LISTING_END_REQUEST_STATES),
  code: z.string().nullable(),
  message: z.string().nullable(),
  /** The parts of the row's structured context staff act on (§10): the last code, the open inventory attempts, the evidence. */
  context: z.object({
    lastCode: z.string().nullable(),
    attemptIds: z.array(z.string()),
    evidence: z.string().nullable(),
    requiresReview: z.boolean(),
  }),
  attemptCount: count,
  deferralCount: count,
  withdraw: z.object({
    callCount: count,
    requestedAt: isoDate.nullable(),
    returnedAt: isoDate.nullable(),
    outcome: z.string().nullable(),
  }),
  staffAction: z.enum(LISTING_END_STAFF_ACTIONS).nullable(),
  decidedAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type ListingEndOpsRow = z.infer<typeof listingEndOpsRowSchema>;

export const listingEndOpsListAnswerSchema = z.object({
  items: z.array(listingEndOpsRowSchema),
  total: count,
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  state: z.enum(LISTING_END_REQUEST_STATES),
});
export type ListingEndOpsListAnswer = z.infer<typeof listingEndOpsListAnswerSchema>;

/** A Retry's or a Resolve's answer: the request after the action, and whether this key had already answered it. */
export const listingEndOpsActionAnswerSchema = z.object({
  endRequest: listingEndOpsRowSchema,
  action: z.enum(LISTING_END_STAFF_ACTIONS),
  idempotentReplay: z.boolean(),
});
export type ListingEndOpsActionAnswer = z.infer<typeof listingEndOpsActionAnswerSchema>;
