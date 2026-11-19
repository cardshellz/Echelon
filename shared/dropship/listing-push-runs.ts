import { z } from "zod";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";

/**
 * Route contracts of publish runs (step 1 plan S2-5, PR A, §4.2 and §4.6):
 * `POST /api/dropship/listing-push-runs`, `GET /api/dropship/listing-push-runs`,
 * `GET /api/dropship/listing-push-runs/:runId` and
 * `POST /api/dropship/listing-push-runs/:runId/stop`. The server parses every
 * answer with these schemas before it sends it, and the page parses the same
 * schemas when it reads one, so a field that changes on one side fails on both.
 *
 * The request body is strict. Answers are not: a field a later release adds is
 * dropped, never refused, so a page left open across a release keeps working;
 * a field the page needs that is missing still fails (CHK7; review DUX13). The
 * server sends what its parse returns, so nothing unlisted ever leaves it.
 *
 * A run is one press of "Publish" on one store: the server's own snapshot of
 * the vendor's selection, never a list the page sends.
 */

/** "Publish {n} new" sends the selected sizes not live on this store; "Publish all" sends every selected size. */
export const LISTING_PUSH_RUN_SCOPES = ["not_live", "all"] as const;
export type ListingPushRunScope = (typeof LISTING_PUSH_RUN_SCOPES)[number];

export const LISTING_PUSH_RUN_STATUSES = ["processing", "completed", "partial", "failed", "cancelled"] as const;
export type ListingPushRunStatus = (typeof LISTING_PUSH_RUN_STATUSES)[number];

/** Why a run stopped before every size was sent: the vendor pressed Stop, or eBay stayed unavailable. */
export const LISTING_PUSH_RUN_STOP_REASONS = ["vendor_stop", "provider_unavailable"] as const;
export type ListingPushRunStopReason = (typeof LISTING_PUSH_RUN_STOP_REASONS)[number];

/**
 * What became of one size of a run. `pending`: not yet handed to a push job;
 * `queued`: in a push job that has not finished it; the rest are final for the
 * run (a later retry of the job by Card Shellz staff is still copied in).
 */
export const LISTING_PUSH_RUN_TARGET_OUTCOMES = [
  "pending", "queued", "completed", "failed", "blocked", "skipped", "price_review", "stale", "cancelled",
] as const;
export type ListingPushRunTargetOutcome = (typeof LISTING_PUSH_RUN_TARGET_OUTCOMES)[number];

/** The outcomes the run's "Didn't publish" list shows. */
export const LISTING_PUSH_RUN_PROBLEM_OUTCOMES = ["failed", "blocked", "price_review", "stale"] as const;
export type ListingPushRunProblemOutcome = (typeof LISTING_PUSH_RUN_PROBLEM_OUTCOMES)[number];

/** A run holds at most this many sizes: the selected-catalog cap (shared/dropship/catalog-scope.ts). */
export const MAX_LISTING_PUSH_RUN_TARGETS = MAX_NAMED_CATALOG_GROUP_ITEMS;
/** Sizes per push job a run creates: the push job cap (createListingPushJobInputSchema, 500). */
export const LISTING_PUSH_RUN_CHUNK_SIZE = 500;
/** Runs one list read returns at most, newest first. */
export const MAX_LISTING_PUSH_RUNS_LISTED = 20;
/** Problem sizes one detail read returns, by size id. */
export const LISTING_PUSH_RUN_PROBLEMS_PAGE_SIZE = 50;

/**
 * Every code a run route answers with, besides the existing store and account
 * codes (DROPSHIP_STORE_CONNECTION_REQUIRED, DROPSHIP_LISTING_*_BLOCKED) and
 * the step-up proof's two refusals (DROPSHIP_STEP_UP_REQUIRED, and
 * DROPSHIP_STEP_UP_METHOD_REQUIRED when the account's proof method changed;
 * dropship-auth.routes.ts).
 */
export const LISTING_PUSH_RUN_ERROR_CODES = {
  invalidInput: "DROPSHIP_LISTING_PUSH_RUN_INVALID_INPUT",
  keyRequired: "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED",
  idempotencyConflict: "DROPSHIP_IDEMPOTENCY_CONFLICT",
  selectionRevisionConflict: "DROPSHIP_SELECTION_REVISION_CONFLICT",
  runActive: "DROPSHIP_LISTING_PUSH_RUN_ACTIVE",
  busy: "DROPSHIP_LISTING_PUSH_RUN_BUSY",
  empty: "DROPSHIP_LISTING_PUSH_RUN_EMPTY",
  tooLarge: "DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE",
  notFound: "DROPSHIP_LISTING_PUSH_RUN_NOT_FOUND",
  rateLimited: "DROPSHIP_LISTING_PUSH_RUN_RATE_LIMITED",
  /** 503: a passing database failure; nothing was done and the same request may be sent again (review CT9). */
  unavailable: "DROPSHIP_LISTING_PUSH_RUN_UNAVAILABLE",
} as const;

const id = z.number().int().positive().max(2_147_483_647);
/** Run ids are bigint in the database; any value a JavaScript number holds exactly. */
const runIdSchema = z.number().int().positive().safe();
const count = z.number().int().nonnegative().max(MAX_LISTING_PUSH_RUN_TARGETS);
const isoTime = z.string().datetime({ offset: true });

/** The same bounds as every other dropship request key (createListingPushJobInputSchema). */
export const listingPushRunIdempotencyKeySchema = z.string().trim().min(8).max(200);

/**
 * The body of a run create. `expectedSelectionRevisionId` is the selection the
 * page counted from (null: the vendor never saved one); a run is refused when
 * the selection moved since, so the vendor never publishes a count they did
 * not see. The key may also come in the Idempotency-Key header.
 */
export const createListingPushRunRequestSchema = z.object({
  storeConnectionId: id,
  scope: z.enum(LISTING_PUSH_RUN_SCOPES),
  idempotencyKey: listingPushRunIdempotencyKeySchema,
  expectedSelectionRevisionId: id.nullable(),
}).strict();
export type CreateListingPushRunRequest = z.infer<typeof createListingPushRunRequestSchema>;

export const listingPushRunCountsSchema = z.object({
  pending: count,
  queued: count,
  completed: count,
  failed: count,
  blocked: count,
  skipped: count,
  price_review: count,
  stale: count,
  cancelled: count,
});
export type ListingPushRunCounts = z.infer<typeof listingPushRunCountsSchema>;

export const listingPushRunSchema = z.object({
  runId: runIdSchema,
  storeConnectionId: id,
  scope: z.enum(LISTING_PUSH_RUN_SCOPES),
  status: z.enum(LISTING_PUSH_RUN_STATUSES),
  stopReason: z.enum(LISTING_PUSH_RUN_STOP_REASONS).nullable(),
  selectionRevisionId: id.nullable(),
  targetCount: z.number().int().min(1).max(MAX_LISTING_PUSH_RUN_TARGETS),
  chunkSize: z.number().int().min(1).max(LISTING_PUSH_RUN_CHUNK_SIZE),
  chunkCount: z.number().int().min(1),
  nextChunkIndex: z.number().int().nonnegative(),
  cancelRequestedAt: isoTime.nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
  completedAt: isoTime.nullable(),
});
export type ListingPushRunView = z.infer<typeof listingPushRunSchema>;

export const listingPushRunProblemSchema = z.object({
  productVariantId: id,
  productId: id.nullable(),
  productName: z.string().nullable(),
  variantName: z.string().nullable(),
  sku: z.string().nullable(),
  outcome: z.enum(LISTING_PUSH_RUN_PROBLEM_OUTCOMES),
  code: z.string().nullable(),
  message: z.string().nullable(),
  retryable: z.boolean().nullable(),
});
export type ListingPushRunProblem = z.infer<typeof listingPushRunProblemSchema>;

export const createListingPushRunResponseSchema = z.object({
  run: listingPushRunSchema,
  idempotentReplay: z.boolean(),
});

export const listListingPushRunsResponseSchema = z.object({
  runs: z.array(z.object({ run: listingPushRunSchema, counts: listingPushRunCountsSchema }))
    .max(MAX_LISTING_PUSH_RUNS_LISTED),
});

export const listingPushRunDetailResponseSchema = z.object({
  run: listingPushRunSchema,
  counts: listingPushRunCountsSchema,
  problems: z.object({
    items: z.array(listingPushRunProblemSchema).max(LISTING_PUSH_RUN_PROBLEMS_PAGE_SIZE),
    /** The size id to read the next page after; null on the last page. */
    nextCursor: id.nullable(),
  }),
  /**
   * When the run's paused push job is tried again (eBay was busy or not answering, §4.5); null while nothing waits.
   * The page says the run is waiting instead of looking frozen (review DUX5).
   */
  waitingUntil: isoTime.nullable(),
  /** Published sizes the store saved as unpublished drafts (its listing mode is not live); buyers can't see them (review DUX7). */
  drafts: count,
});
export type ListingPushRunDetail = z.infer<typeof listingPushRunDetailResponseSchema>;

export const stopListingPushRunResponseSchema = z.object({
  run: listingPushRunSchema,
  counts: listingPushRunCountsSchema,
});

/** An empty count for every outcome; counts read from the database fill it. */
export function emptyListingPushRunCounts(): ListingPushRunCounts {
  return { pending: 0, queued: 0, completed: 0, failed: 0, blocked: 0, skipped: 0, price_review: 0, stale: 0, cancelled: 0 };
}
