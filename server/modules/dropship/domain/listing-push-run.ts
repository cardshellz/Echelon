import { createHash } from "node:crypto";
import { ZodError } from "zod";
import {
  LISTING_PUSH_RUN_CHUNK_SIZE,
  MAX_LISTING_PUSH_RUN_TARGETS,
  emptyListingPushRunCounts,
  type ListingPushRunCounts,
  type ListingPushRunScope,
  type ListingPushRunStatus,
  type ListingPushRunTargetOutcome,
} from "../../../../shared/dropship/listing-push-runs";
import { DropshipError } from "./errors";
import { AUTOMATIC_REQUEUE_CODES, STOCK_LINK_RESEND_CODE } from "./listing-push-automatic-requeue";
import { hasMarketplaceListing, isLiveListingStatus, LIVE_LISTING_STATUSES } from "./listing-live-status";

/**
 * Publish runs (step 1 plan S2-5, PR A, §4.2-§4.5): the pure rules. A run is
 * one vendor press of "Publish" on one store; the push sweep sends it one
 * chunk of 500 sizes at a time through an ordinary push job and copies each
 * job item's outcome back to its target. Nothing here reads a clock or the
 * database: callers pass `now` and the facts.
 */

export { LISTING_PUSH_RUN_CHUNK_SIZE as RUN_CHUNK_SIZE, MAX_LISTING_PUSH_RUN_TARGETS };

/** Runs one sweep starts expanding at most, oldest first (D11). */
export const RUN_EXPANSIONS_PER_SWEEP = 2;
/** A sweep starts no new expansion once it has spent this long on expansions (TESTS10). */
export const RUN_EXPANSION_SWEEP_BUDGET_MS = 20_000;
/** A chunk refused as changed (content or price moved while queueing) this many times becomes `stale`. */
export const RUN_CHUNK_MAX_CONFLICT_ATTEMPTS = 3;
/** A chunk that failed for a passing reason this many times fails, retryable, for a human to look at. */
export const RUN_CHUNK_MAX_TRANSIENT_ATTEMPTS = 5;
/**
 * The price review pre-filter measures "moved after the press" from the run's
 * `created_at` less this margin (review round 2 MC6). The run and every price
 * input's revision take their times from the clock of whichever dyno wrote
 * them, so a revision saved just before the press on a dyno whose clock runs
 * behind would otherwise read as older than the press. Holding a size saved
 * within the margin before the press for the vendor's review is the safe side.
 */
export const RUN_PRICE_INPUT_CLOCK_MARGIN_MS = 5_000;
/** A run's finish notice names at most this many problem sizes; the portal shows all of them. */
export const MAX_RUN_NOTIFICATION_ITEMS = 25;
/**
 * A finished run whose notice step a dead process never completed is picked
 * up by a later sweep within this window (verify V9). Past it the notice
 * would be stale; the page still shows the run's problems.
 */
export const RUN_NOTICE_RECOVERY_WINDOW_MS = 24 * 60 * 60_000;
/** Recovered notices one sweep sends at most, oldest first; the rest go at the next sweeps. */
export const MAX_RUN_NOTICES_RECOVERED_PER_SWEEP = 25;
/**
 * Child jobs whose activity the reconcile reads besides those of unfinished
 * runs: a job of a finished run that Card Shellz staff retry moves its own
 * updated_at, so a day after its last move it has nothing left to copy.
 */
export const RUN_RECONCILE_JOB_ACTIVITY_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Push job keys the vendor job route refuses (SAFETY14): only a run's chunk
 * job carries one, and the sweep adopts a chunk's job by (run_id,
 * run_chunk_index), never by its key.
 */
export const RESERVED_JOB_KEY_PREFIX = "dropship-run:";

/**
 * A listing that is on the marketplace now: the statuses an eBay listing id
 * stays valid in. Re-exported from the live-status rule
 * (domain/listing-live-status), its one definition, which order acceptance,
 * the queue upsert and the worker's status writes read too.
 */
export { LIVE_LISTING_STATUSES };

/**
 * Backoff before a paused job is tried again, by how many times in a row it
 * has paused (1st pause: 1 minute ... 5th and later: 30 minutes).
 */
export const PUSH_PAUSE_BACKOFF_MS: readonly number[] = Object.freeze([60_000, 120_000, 300_000, 900_000, 1_800_000]);
/**
 * An item that paused this many times fails, retryable, as a transient failure
 * did before runs: the next pausable error after the 5th pause fails it.
 */
export const MAX_ITEM_TRANSIENT_PAUSES = 5;
/**
 * A job that paused this many times in a row (about 83 minutes of backoff:
 * 1 + 2 + 5 + 15 + 30 + 30) stops: the next pausable error fails every queued
 * item of the job as PROVIDER_UNAVAILABLE and stops its run.
 */
export const MAX_JOB_CONSECUTIVE_PAUSES = 6;

/**
 * The stock link codes the push sweep queues again by itself for a push outside
 * a publish run (AUTOMATIC_REQUEUE_POLICY: a busy link, a busy publication scope,
 * Card Shellz pausing stock updates) and never for a run's chunk
 * (stockLinkCandidateSql, ops repository; merge review ADV-RB2-1). A run reports
 * its outcome once, when it finishes, and its card asks the vendor to publish
 * again; the finish logs a WARN counting these sizes, so the signal the re-queue
 * and its ERROR at the cap give outside a run is not lost. The one-time re-send
 * code is left out: it applies only to failures from before the automatic stock
 * link, and no run item is one (runs come after it).
 */
export const RUN_UNREQUEUED_STOCK_LINK_CODES: readonly string[] = Object.freeze(
  AUTOMATIC_REQUEUE_CODES.filter((code) => code !== STOCK_LINK_RESEND_CODE));

export const LISTING_PUSH_RUN_CODES = {
  notSelected: "DROPSHIP_LISTING_NOT_SELECTED",
  alreadyLive: "DROPSHIP_LISTING_ALREADY_LIVE",
  priceAwaitingReview: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW",
  chunkConflict: "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT",
  keyConflict: "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT",
  expansionFailed: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_FAILED",
  /** The job schema refused the chunk (a deterministic refusal, so never retried; review CT9). */
  chunkInvalid: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_INVALID",
  /**
   * Transient: another sweep already queued this chunk's job under a different request hash, so the next sweep adopts
   * it by (run, chunk) (review MC5/CT2; listed here in review round 2 CT3, was a literal in the preview repository).
   */
  chunkExists: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_EXISTS",
  targetNotQueued: "DROPSHIP_LISTING_PUSH_RUN_TARGET_NOT_QUEUED",
  providerUnavailable: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE",
  stopped: "DROPSHIP_LISTING_PUSH_RUN_STOPPED",
  keyReserved: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED",
} as const;

/** The request-wide refusals of a push job whose content or prices moved while it was being queued (PR:764-801). */
const CHUNK_CONFLICT_ERROR_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_CONTENT_VERSION_CONFLICT",
  "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT",
]);

export function isReservedListingPushJobKey(key: string): boolean {
  return key.trim().startsWith(RESERVED_JOB_KEY_PREFIX);
}

/** The key of the push job that carries out one chunk of a run. Unique per vendor, as job keys must be. */
export function listingPushRunChunkJobKey(input: { vendorId: number; runId: number; chunkIndex: number }): string {
  return `${RESERVED_JOB_KEY_PREFIX}${input.vendorId}:${input.runId}:${input.chunkIndex}`;
}

/** The run's request identity: who, which store, which scope, from which selection. */
export function hashListingPushRunRequest(input: {
  vendorId: number;
  storeConnectionId: number;
  scope: ListingPushRunScope;
  expectedSelectionRevisionId: number | null;
}): string {
  const canonical = JSON.stringify({
    expectedSelectionRevisionId: input.expectedSelectionRevisionId,
    scope: input.scope,
    storeConnectionId: input.storeConnectionId,
    vendorId: input.vendorId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function listingPushRunChunkCount(targetCount: number, chunkSize: number = LISTING_PUSH_RUN_CHUNK_SIZE): number {
  if (!Number.isSafeInteger(targetCount) || targetCount < 1 || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new Error("A run needs at least one target and a positive chunk size.");
  }
  return Math.ceil(targetCount / chunkSize);
}

/**
 * The chunk of each target: sizes in ascending id order, `chunkSize` to a
 * chunk, so a size is in exactly one chunk of a run (a later chunk's queue
 * upsert would otherwise make an earlier item drift, map-publish §7.6).
 */
export function assignListingPushRunChunks(
  productVariantIds: readonly number[],
  chunkSize: number = LISTING_PUSH_RUN_CHUNK_SIZE,
): Array<{ productVariantId: number; chunkIndex: number }> {
  const sorted = [...new Set(productVariantIds)].sort((left, right) => left - right);
  if (sorted.length !== productVariantIds.length) throw new Error("A run's targets must be distinct sizes.");
  return sorted.map((productVariantId, rank) => ({ productVariantId, chunkIndex: Math.floor(rank / chunkSize) }));
}

/** Live on this store: a live status and an eBay listing id. */
export function isLiveListing(listing: { status: string; externalListingId: string | null } | null | undefined): boolean {
  return Boolean(listing && isLiveListingStatus(listing.status) && hasMarketplaceListing(listing.externalListingId));
}

/**
 * A target's outcome from its job item: null while the item is not finished
 * (`queued` and `processing` are both `queued` for the run). A size found not
 * selected at push time counts as skipped, and a price that moved under "wait
 * for review" as price review, as the run's own pre-filter counts them.
 */
export function runTargetOutcomeForItem(item: { status: string; errorCode: string | null }): ListingPushRunTargetOutcome {
  switch (item.status) {
    case "queued":
    case "processing":
      return "queued";
    case "completed":
      return "completed";
    case "blocked":
      return item.errorCode === LISTING_PUSH_RUN_CODES.notSelected ? "skipped" : "blocked";
    case "failed":
      return item.errorCode === LISTING_PUSH_RUN_CODES.priceAwaitingReview ? "price_review" : "failed";
    case "cancelled":
      return "cancelled";
    default:
      throw new Error(`Unknown listing push item status: ${item.status}`);
  }
}

export function countListingPushRunTargets(
  rows: ReadonlyArray<{ outcome: string; count: number }>,
): ListingPushRunCounts {
  const counts = emptyListingPushRunCounts();
  for (const row of rows) {
    if (!(row.outcome in counts)) throw new Error(`Unknown listing push run outcome: ${row.outcome}`);
    if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error("A run target count must be a whole number.");
    counts[row.outcome as keyof ListingPushRunCounts] += row.count;
  }
  return counts;
}

/**
 * How a processing run finishes once no target is pending or queued: cancelled
 * after a stop; otherwise completed when no size had a problem (failed, not
 * ready, price review or changed while publishing), failed when some did and
 * none published, partial in between. Null while the run still has work.
 *
 * A skipped size (no longer selected, or already live for "Publish new") is
 * not a problem: it was left out on purpose, the problem list never shows it
 * and no email names it. So a run that published everything it had to send
 * is completed, not partial, and one whose sizes were all left out is
 * completed with nothing to send, not failed (verify V10; plan §4.4 read
 * "completed when all completed", which made a clean run read as a partial
 * one and its finish audit row a warning).
 */
export function decideListingPushRunFinish(input: {
  counts: ListingPushRunCounts;
  cancelRequested: boolean;
}): Exclude<ListingPushRunStatus, "processing"> | null {
  const { counts } = input;
  if (counts.pending > 0 || counts.queued > 0) return null;
  if (input.cancelRequested) return "cancelled";
  if (listingPushRunProblemCount(counts) === 0) return "completed";
  return counts.completed === 0 ? "failed" : "partial";
}

/** How many targets the vendor is told did not publish: failed, not ready, price review and changed while publishing. */
export function listingPushRunProblemCount(counts: ListingPushRunCounts): number {
  return counts.failed + counts.blocked + counts.price_review + counts.stale;
}

/** The backoff after the n-th consecutive pause (n counted after this pause). */
export function pushPauseBackoffMs(consecutivePauseCount: number): number {
  if (!Number.isSafeInteger(consecutivePauseCount) || consecutivePauseCount < 1) {
    throw new Error("A pause backoff needs the job's pause count after the pause.");
  }
  return PUSH_PAUSE_BACKOFF_MS[Math.min(consecutivePauseCount - 1, PUSH_PAUSE_BACKOFF_MS.length - 1)];
}

/**
 * Whether a failed marketplace call did nothing, so the push should wait and
 * try again rather than fail the item (SAFETY18): a 429 on any call; a 401 or
 * 403 token rejection; a 5xx or no answer on a read. A 5xx or no answer on a
 * write keeps failing the item, retryable: its outcome is unknown, and the
 * connector demands an identity check before the next write (CONN:250-268).
 */
export function decideListingPushTransientPause(error: unknown): { pause: true; reason: string } | { pause: false } {
  if (!(error instanceof DropshipError)) return { pause: false };
  const context = error.context ?? {};
  const status = typeof context.status === "number" ? context.status : null;
  const method = typeof context.method === "string" ? context.method.toUpperCase() : null;
  if (status === 429) return { pause: true, reason: "rate_limited" };
  if ((status === 401 || status === 403) && context.retryable === true) return { pause: true, reason: "token_rejected" };
  if (method === "GET" && status !== null && status >= 500) return { pause: true, reason: "read_unavailable" };
  if (method === "GET" && context.network === true) return { pause: true, reason: "read_unanswered" };
  return { pause: false };
}

/**
 * Whether a failed call was a definite marketplace answer that a pause does
 * not cover: eBay answered with a 4xx it did not ask the push to wait for (a
 * validation or policy refusal). eBay is answering, so the job's run of pauses
 * ends, as a completed item ends it (review round 2 MC4); otherwise a store
 * whose items mostly fail with 400s and see an odd 429 would trip the
 * provider breaker and fail the rest of the run as "eBay wasn't answering". A
 * 5xx (its outcome on a write is unknown) or a failure that never reached eBay
 * leaves the count alone.
 */
export function isDefiniteMarketplaceAnswer(error: unknown): boolean {
  if (!(error instanceof DropshipError)) return false;
  const status = error.context?.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499) return false;
  return !decideListingPushTransientPause(error).pause;
}

/** The pauses an item has had, from its stored result. */
export function itemTransientPauses(result: Record<string, unknown> | null): number {
  const value = result?.transientPauses;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Whether a queued item's last send has an unknown outcome on eBay, so a stop
 * must not cancel it blind (review MC1; verify V2): a worker died while
 * sending it, stale recovery put it back in the queue
 * (`result.staleRecovery.recoveredAt`, written by recoverStaleProcessingJob),
 * and no push outcome was recorded since (`result.push.pushedAt` or
 * `processedAt`, written by every terminal write). That holds whenever the
 * recovery happened: before the stop too, when the re-send was paused (eBay
 * busy) and waits in the queue with its backoff, for up to 30 minutes. Such
 * an item is sent once more instead of being cancelled: the connector reads
 * the SKU's offers first and adopts a listing the dead worker published, or
 * stops for an identity check (§4.6 "only an item already processing
 * finishes"). The item breaker (5 pauses) and the job breaker (6) still bound
 * the re-sends. An unreadable recovery marker never exempts; an unreadable
 * push time does not count as an outcome.
 */
export function isItemInFlightAtStop(result: Record<string, unknown> | null): boolean {
  const recoveredAt = timeAt(objectAt(result, "staleRecovery"), "recoveredAt");
  if (recoveredAt === null) return false;
  const push = objectAt(result, "push");
  const outcomeAt = timeAt(push, "pushedAt") ?? timeAt(push, "processedAt");
  return outcomeAt === null || outcomeAt < recoveredAt;
}

function objectAt(value: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const found = value?.[key];
  return found !== null && typeof found === "object" && !Array.isArray(found) ? found as Record<string, unknown> : null;
}

function timeAt(value: Record<string, unknown> | null, key: string): number | null {
  const found = value?.[key];
  if (typeof found !== "string") return null;
  const at = Date.parse(found);
  return Number.isFinite(at) ? at : null;
}

export type ListingPushPauseDecision =
  | { action: "pause" }
  | { action: "fail_item" }
  | { action: "trip_job_breaker" };

/**
 * What a pausable error does to an item: the job breaker first (the whole job
 * has paused too often in a row), then the item breaker, otherwise a pause.
 */
export function decideListingPushPauseAction(input: {
  itemPauses: number;
  jobConsecutivePauses: number;
}): ListingPushPauseDecision {
  if (input.jobConsecutivePauses >= MAX_JOB_CONSECUTIVE_PAUSES) return { action: "trip_job_breaker" };
  if (input.itemPauses >= MAX_ITEM_TRANSIENT_PAUSES) return { action: "fail_item" };
  return { action: "pause" };
}

/** True when a push-time refusal is the size no longer being selected (PS:1284-1286 writes `selection:<reason>`). */
export function isSelectionBlocker(blockers: unknown): boolean {
  return Array.isArray(blockers) && blockers.some((blocker) => typeof blocker === "string" && blocker.startsWith("selection:"));
}

export type ChunkExpansionErrorClass =
  | { kind: "conflict"; code: string }
  | { kind: "key_conflict"; code: string }
  | { kind: "permanent"; code: string; message: string; productId?: number }
  | { kind: "transient"; code: string; message: string };

/**
 * How a failed chunk queue is handled (CLAUDE.md §6): a request-wide content
 * or price move is retried a few times then marked stale; a key collision is
 * permanent and needs a human; a DropshipError that is not marked retryable is
 * permanent for the chunk (or, when it names a product, for that product's
 * sizes only), and so is a chunk the job schema refuses (the same input is
 * refused every time: never retried, review CT9); anything else (the
 * database, the network) passes.
 */
export function classifyChunkExpansionError(error: unknown): ChunkExpansionErrorClass {
  if (error instanceof ZodError) {
    return { kind: "permanent", code: LISTING_PUSH_RUN_CODES.chunkInvalid,
      message: `The publish run chunk was refused by the job's schema: ${error.issues.map((issue) => issue.message).slice(0, 3).join("; ")}` };
  }
  if (error instanceof DropshipError) {
    if (CHUNK_CONFLICT_ERROR_CODES.has(error.code)) return { kind: "conflict", code: error.code };
    if (error.code === LISTING_PUSH_RUN_CODES.keyConflict || error.code === "DROPSHIP_IDEMPOTENCY_CONFLICT") {
      return { kind: "key_conflict", code: LISTING_PUSH_RUN_CODES.keyConflict };
    }
    if (error.context?.retryable === true) return { kind: "transient", code: error.code, message: error.message };
    // A refusal about one product (its stock could not be read, DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE and the like)
    // names it, so only that product's sizes fail and the rest of the chunk is sent (verify V6).
    const productId = error.context?.productId;
    return { kind: "permanent", code: error.code, message: error.message,
      ...(typeof productId === "number" && Number.isSafeInteger(productId) && productId > 0 ? { productId } : {}) };
  }
  if (isUniqueViolation(error)) return { kind: "key_conflict", code: LISTING_PUSH_RUN_CODES.keyConflict };
  return {
    kind: "transient",
    code: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_RETRYING",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

/**
 * Pre-filter facts for one target of a chunk, read before the chunk is queued
 * (§4.3 step 2), and the outcome they give: null keeps the size in the chunk.
 */
export interface ListingPushRunPrefilterFacts {
  selected: boolean;
  /** Live on this store (a live status and a listing id): the `not_live` scope leaves it out. */
  live: boolean;
  /**
   * eBay lists it: live, or being re-sent (a push-progress status) with a listing id. The price review is about
   * what buyers see on eBay, so it applies to every listed size, not only to live statuses (review MC3).
   */
  onMarketplace: boolean;
  /** Under "wait for review": a price input of the size moved after the press. */
  priceMovedAfterPress: boolean;
}

export function decideListingPushRunPrefilter(input: {
  scope: ListingPushRunScope;
  facts: ListingPushRunPrefilterFacts;
}): { outcome: "skipped"; code: string } | { outcome: "needs_price_check" } | null {
  if (!input.facts.selected) return { outcome: "skipped", code: LISTING_PUSH_RUN_CODES.notSelected };
  if (input.scope === "not_live" && input.facts.live) return { outcome: "skipped", code: LISTING_PUSH_RUN_CODES.alreadyLive };
  if ((input.facts.live || input.facts.onMarketplace) && input.facts.priceMovedAfterPress) return { outcome: "needs_price_check" };
  return null;
}
