/**
 * Catalog step 3, "Publish", on publish runs (step 1 plan S2-5, PR A, §4.10):
 * the optional chunked Check, the two publish choices from the selection
 * summary, a run's progress and outcome in the vendor's words, the poll
 * schedule, and how a run create's refusal is handled. Pure: no React, no
 * network, no clock (every time is passed in), so each rule runs in a test.
 *
 * A run is the server's own snapshot of the vendor's selection (D10): the
 * page sends a scope and the selection revision it counted from, never ids.
 */
import { z } from "zod";
import { ebayCategorySourceValues } from "@shared/dropship/ebay-category-rules";
import { dropshipListingEconomicsSchema, dropshipListingPresentationSchema } from "@shared/dropship/listing-presentation";
import {
  LISTING_PUSH_RUN_ERROR_CODES,
  type ListingPushRunCounts,
  type ListingPushRunProblem,
  type ListingPushRunScope,
  type ListingPushRunView,
} from "@shared/dropship/listing-push-runs";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
  dropshipCatalogReadSummarySchema,
  type DropshipCatalogSelectionSummary,
} from "@shared/dropship/vendor-catalog-reads";
import {
  DROPSHIP_SITE_UPDATING_CODE,
  DropshipApiError,
  type DropshipListingPreviewResult,
  type DropshipListingPreviewRow,
} from "./dropship-ops-surface";
import {
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
  EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE,
} from "@shared/dropship/ebay-publication-account";
import {
  DROPSHIP_STOCK_LINK_REFUSAL_WORDS,
  isDropshipStockLinkRefusalCode,
  type DropshipStockLinkRefusalCode,
} from "@shared/dropship/stock-link-refusals";
import { isPausedStockRefusal, listingPushBlockedReasons, listingPushRefusalWords } from "./dropship-listing-push-status";
import { PUBLISH_WORDS, type RunCountParts } from "./dropship-catalog-publish-words";

// ---------------------------------------------------------------------------
// Limits and schedules
// ---------------------------------------------------------------------------

/**
 * The catalog code version this page was built for (§4.8, CHK7): every catalog
 * read sends it, and a server older than the page answers 503 "try again".
 * Equals the server's `DROPSHIP_CATALOG_CODE_VERSION`
 * (server/modules/dropship/domain/catalog-code-version.ts): 2 since PR B
 * (one-time picks), set with the server's in one commit (PLAN-B v4.1 V9).
 */
export const CATALOG_PAGE_CLIENT_VERSION = 2;
/** Sizes per Check request: under the preview's 500 cap (createListingPushJobInputSchema), as the redesign asks (RD:568-570). */
export const CHECK_CHUNK_SIZE = 200;
/** "Selected items" reads 200 rows a page (the catalog read's `limit` cap) and shows at most 1,000 (as step 1 does). */
export const SELECTED_LIST_PAGE_SIZE = 200;
export const SELECTED_LIST_MAX_ROWS = 1_000;
/** A run is polled every 3 s for its first 2 minutes, then every 15 s (RD:573). */
export const RUN_POLL_FAST_MS = 3_000;
export const RUN_POLL_SLOW_MS = 15_000;
export const RUN_POLL_FAST_WINDOW_MS = 120_000;
/** A run create is sent at most this many times with the same key, pausing before the second and third send. */
export const RUN_CREATE_MAX_TRIES = 3;
export const RUN_CREATE_BACKOFF_MS: readonly number[] = Object.freeze([1_000, 2_000]);
/**
 * A step 3 read answered "try again" (site updating, a 5xx, a 429, no answer) is read again on the run poll's
 * schedule, this many times (2 minutes fast, then 5 minutes slow), before the page shows the failure with Try again.
 */
export const PUBLISH_READ_MAX_RETRIES = 60;
/** A Check chunk answered "try again" is sent once more after this pause; a second failure stops the check. */
export const CHECK_RETRY_PAUSE_MS = 1_000;

/** The poll pause after `elapsedMs` of watching a run. */
export function runPollDelayMs(elapsedMs: number): number {
  return elapsedMs < RUN_POLL_FAST_WINDOW_MS ? RUN_POLL_FAST_MS : RUN_POLL_SLOW_MS;
}

/** The pause before retry `attempt` (0-based) of a step 3 read: the run poll's schedule, counted in retries. */
export function publishReadRetryDelayMs(attempt: number): number {
  return runPollDelayMs(Math.max(0, attempt) * RUN_POLL_FAST_MS);
}

// ---------------------------------------------------------------------------
// Errors (CLAUDE.md §6)
// ---------------------------------------------------------------------------

/**
 * Nothing came back that says the request was refused: no answer (fetch's TypeError), a JSON answer cut short
 * (response.json()'s SyntaxError: the request was sent, so a create may have made its run; verify VC11), a 5xx, a
 * limiter's 429, a 408, or an answer from code older than this page (DROPSHIP_SITE_UPDATING, §4.9 item 3). Sending
 * the same request again is safe: a read changes nothing and a create replays by its key. An abort is never
 * transient: the page asked for it.
 */
export function isTransientPublishError(error: unknown): boolean {
  if (error instanceof DropshipApiError) {
    return error.status >= 500 || error.status === 408 || error.status === 429
      || error.code === DROPSHIP_SITE_UPDATING_CODE || error.code === LISTING_PUSH_RUN_ERROR_CODES.busy;
  }
  return error instanceof TypeError || error instanceof SyntaxError;
}

/**
 * An answer from code older than this page, while it is read again (the site-updating line, §12.2): the client-made
 * `DROPSHIP_SITE_UPDATING` (an older server's HTML, or JSON without a field this page needs), or an older catalog
 * server's own refusal of this page's version, 503 `DROPSHIP_SELECTION_WRITES_PAUSED` with reason
 * `page_newer_than_server` (cea5cb027 dropship-vendor-catalog.routes.ts `assertPageNotNewerThanServer`: an A dyno
 * answers every step 1 and step 3 catalog read of this page so; plan §4 row 3, §12.6; review round 1 CLI-2). Nothing
 * else: no answer or a plain 5xx is not "Card Shellz is updating the site" (B2a deviation 4).
 */
export function isOlderCatalogServerError(error: unknown): boolean {
  if (!(error instanceof DropshipApiError)) return false;
  if (error.code === DROPSHIP_SITE_UPDATING_CODE) return true;
  return error.status === 503 && error.code === DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused
    && error.context?.reason === DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON;
}

export function isAbortError(error: unknown): boolean {
  return typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError";
}

/** The run routes' answer to a fault on Card Shellz's side that a retry does not fix (dropship-listing.routes.ts). */
export const LISTING_PUSH_RUN_INTERNAL_ERROR_CODE = "DROPSHIP_LISTING_PUSH_RUN_INTERNAL_ERROR";

/**
 * A step 3 read the server answered with its internal error (the run routes' `…_RUN_INTERNAL_ERROR`, the catalog
 * reads' `DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR`: any code ending `_INTERNAL_ERROR`, which the server logs at ERROR
 * each time) is tried this many more times, not 60 (review round 2 CT7; verify VC4).
 */
export const PUBLISH_READ_INTERNAL_MAX_RETRIES = 3;

function isRunReadError(error: unknown, code: string): boolean {
  return error instanceof DropshipApiError && error.code === code;
}

/** The server's answer to a fault on its side that a retry does not fix: a code ending `_INTERNAL_ERROR`. */
export function isInternalServerError(error: unknown): boolean {
  return error instanceof DropshipApiError && typeof error.code === "string" && error.code.endsWith("_INTERNAL_ERROR");
}

/**
 * Whether the run card should keep polling after its read gave up (review round 2 CT7): only while the failure is
 * transient. A run that is gone (404 NOT_FOUND: drop the card, §4.12) or an answer the server could not build
 * (`…_INTERNAL_ERROR`, which the server logs at ERROR each time) is not asked about again by itself; the vendor's
 * reload or a new press reads it again.
 */
export function runReadCanRecover(error: unknown): boolean {
  if (isRunReadError(error, LISTING_PUSH_RUN_ERROR_CODES.notFound) || isInternalServerError(error)) return false;
  return isTransientPublishError(error);
}


/** react-query's `retry` for every step 3 read: transient failures only, on the run poll's schedule. */
export function retryPublishRead(failureCount: number, error: unknown): boolean {
  if (isRunReadError(error, LISTING_PUSH_RUN_ERROR_CODES.notFound)) return false;
  // A passing fault the server could not classify (a dropped connection) is tried a few times; one that repeats is not
  // polled into the log every 3 s, whichever read it is (the run's, the count's or the selected list's; verify VC4).
  if (isInternalServerError(error)) return failureCount < PUBLISH_READ_INTERNAL_MAX_RETRIES;
  return isTransientPublishError(error) && failureCount < PUBLISH_READ_MAX_RETRIES;
}

export const STEP_UP_REQUIRED_CODE = "DROPSHIP_STEP_UP_REQUIRED";
/**
 * The step-up middleware's two refusals (server/modules/dropship/interfaces/http/dropship-auth.routes.ts): no proof
 * is current, or the proof's method is no longer the one the account must use (a passkey added in another tab).
 * Either way the page reads the sign-in again and asks for a new proof (review round 2 CT4; the page before A
 * handled both through isStepUpRequiredError).
 */
export const STEP_UP_REFUSAL_CODES: ReadonlySet<string> = new Set([STEP_UP_REQUIRED_CODE, "DROPSHIP_STEP_UP_METHOD_REQUIRED"]);

/**
 * What a run create's failure means for the press (§4.12):
 * - `transient`: send the same request again (same key); the old dyno, a busy lock or the network wrote nothing that
 *   a replay would not answer.
 * - `reread`: the selection moved since the page counted it; read the count again, and the next press gets a new key.
 * - `showRun`: a run is already going on this store; follow it.
 * - `stepUp`: the proof the page held is no longer accepted; ask for a new one.
 * - `rateLimited`: the create's budget (6 a minute) is spent; nothing was made by this answer, so it is not sent again
 *   now (another try only spends the budget), and the vendor waits a minute. The page keeps the press's key, since an
 *   earlier try of it may have gone unanswered (verify VC6).
 * - `permanent`: shown in words, never sent again.
 */
export type RunCreateErrorClass =
  | { kind: "transient" }
  | { kind: "reread"; message: string }
  | { kind: "showRun"; runId: number | null; message: string }
  | { kind: "stepUp"; message: string }
  | { kind: "rateLimited"; message: string }
  | { kind: "permanent"; message: string };

export function classifyRunCreateError(error: unknown, scope: ListingPushRunScope): RunCreateErrorClass {
  if (error instanceof DropshipApiError && error.status === 429) return { kind: "rateLimited", message: PUBLISH_WORDS.runRateLimited };
  if (isTransientPublishError(error)) return { kind: "transient" };
  if (!(error instanceof DropshipApiError)) {
    // A programming error before anything was sent (a body the schema refuses); nothing to retry.
    return { kind: "permanent", message: PUBLISH_WORDS.notSent };
  }
  if (error.code !== null && STEP_UP_REFUSAL_CODES.has(error.code)) return { kind: "stepUp", message: PUBLISH_WORDS.stepUpExpired };
  switch (error.code) {
    case LISTING_PUSH_RUN_ERROR_CODES.selectionRevisionConflict:
      return { kind: "reread", message: PUBLISH_WORDS.selectionChanged };
    case LISTING_PUSH_RUN_ERROR_CODES.runActive: {
      const runId = error.context?.runId;
      return { kind: "showRun", runId: typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0 ? runId : null,
        message: PUBLISH_WORDS.runActive };
    }
    case LISTING_PUSH_RUN_ERROR_CODES.empty: {
      const liveCount = error.context?.liveCount;
      return { kind: "permanent",
        message: scope === "not_live" && typeof liveCount === "number" && liveCount > 0 ? PUBLISH_WORDS.runEmptyNew : PUBLISH_WORDS.runEmpty };
    }
    case LISTING_PUSH_RUN_ERROR_CODES.tooLarge:
      return { kind: "permanent", message: PUBLISH_WORDS.runTooLarge };
    case LISTING_PUSH_RUN_ERROR_CODES.invalidInput:
    case LISTING_PUSH_RUN_ERROR_CODES.keyRequired:
    case LISTING_PUSH_RUN_ERROR_CODES.idempotencyConflict:
      return { kind: "permanent", message: PUBLISH_WORDS.notSent };
    default:
      // The account and store refusals carry their own words and fix (the page shows the notice from them).
      return { kind: "permanent", message: error.message.trim() || PUBLISH_WORDS.notSent };
  }
}

// ---------------------------------------------------------------------------
// The two publish choices
// ---------------------------------------------------------------------------

export type PublishChoiceBlock = "tooLarge" | "empty" | null;

export interface PublishChoices {
  /** "Publish {n} new": the selected sizes not live on this store; null hides the button (nothing is new). */
  newCount: number | null;
  /** "Publish all {n}": every selected size. */
  allCount: number;
  /** Selected sizes already live on this store (the "Publish all" hint). */
  live: number;
  /** Why neither button can be pressed, when the count says so before the server would. */
  block: PublishChoiceBlock;
  /** The revision a run is bound to: what the counts were read at. */
  selectionRevisionId: number | null;
}

/**
 * The buttons from `GET /catalog/selection?storeConnectionId=` (§4.10). Null while the summary is not this store's
 * (loading, or the previous store's answer kept on screen during a switch), so a press never publishes a count the
 * vendor did not see for this store.
 */
export function describePublishChoices(summary: DropshipCatalogSelectionSummary | null | undefined, storeConnectionId: number): PublishChoices | null {
  if (!summary || summary.store === null || summary.store.storeConnectionId !== storeConnectionId) return null;
  const block: PublishChoiceBlock = summary.overCap ? "tooLarge" : summary.selectedTotal === 0 ? "empty" : null;
  return {
    newCount: summary.store.notLive > 0 ? summary.store.notLive : null,
    allCount: summary.selectedTotal,
    live: summary.store.live,
    block,
    selectionRevisionId: summary.selectionRevisionId,
  };
}

/** The count the vendor saw on the button they pressed, for the snapshot difference after the run is made. */
export function pressedCount(choices: PublishChoices, scope: ListingPushRunScope): number {
  return scope === "not_live" ? choices.newCount ?? 0 : choices.allCount;
}

/** How many of the sizes the button counted the run left out (no longer offered when the server took its snapshot). */
export function runSnapshotDiff(expectedCount: number | null, targetCount: number): number {
  if (expectedCount === null) return 0;
  return Math.max(0, expectedCount - targetCount);
}

/** The press's identity: the same store, scope and selection revision may reuse an unconfirmed press's key. */
export function publishRequestFingerprint(input: { storeConnectionId: number; scope: ListingPushRunScope; expectedSelectionRevisionId: number | null }): string {
  return `${input.storeConnectionId}:${input.scope}:${input.expectedSelectionRevisionId ?? "none"}`;
}

// ---------------------------------------------------------------------------
// A run, in the vendor's words
// ---------------------------------------------------------------------------

/** Sizes the run has decided (published, refused, skipped or held for review); pending, queued and cancelled are not. */
export function runDoneCount(counts: ListingPushRunCounts): number {
  return counts.completed + counts.failed + counts.blocked + counts.skipped + counts.price_review + counts.stale;
}

/** Sizes the "Didn't publish" list shows (the server's problem outcomes). */
export function runProblemCount(counts: ListingPushRunCounts): number {
  return counts.failed + counts.blocked + counts.price_review + counts.stale;
}

/**
 * The counts line's parts: a stale size failed for the vendor (it changed while publishing), and a size the store
 * saved as an unpublished draft is counted apart from those buyers can see (review round 2 DUX3; the server's
 * `drafts`, never more than the completed).
 */
export function runCounts(counts: ListingPushRunCounts, drafts: number = 0): RunCountParts {
  const savedAsDrafts = Math.min(Math.max(0, Math.trunc(drafts)), counts.completed);
  return { completed: counts.completed - savedAsDrafts, drafts: savedAsDrafts, notReady: counts.blocked, review: counts.price_review,
    failed: counts.failed + counts.stale, skipped: counts.skipped };
}

export function isRunFinished(run: Pick<ListingPushRunView, "status">): boolean {
  return run.status !== "processing";
}

/**
 * `finished`: no size had a problem (green), sizes left out on purpose included. `finishedPartial`: some did not
 * publish, or some were saved as drafts buyers can't see (amber). `finishedNothing`: sizes had problems and none was
 * published (rose; review round 2 DUX6). Read from the counts, not the run's status, so a run whose only left-out
 * sizes were skipped is never amber (verify VC12; the server's own rule since verify V10).
 */
export type RunPhase = "publishing" | "stopping" | "stopped" | "providerDown" | "finished" | "finishedPartial" | "finishedNothing";

export interface RunDescription {
  phase: RunPhase;
  /** The card's first line. */
  title: string;
  /** What the live region says: the phase's words, never the counts that change on every poll (review round 2 DUX10). */
  announcement: string;
  /** When a paused run tries again (ISO), while it is publishing; null otherwise (review round 2 DUX3). */
  waitingUntil: string | null;
  /** The drafts note, when some sizes were saved as unpublished drafts (review round 2 DUX3). */
  draftsLine: string | null;
  /** "12 published · 1 failed", or null when every part is zero. */
  countsLine: string | null;
  /** "Didn't publish (3)" over the list, or null when nothing failed. */
  problemsTitle: string | null;
  /** Stop is offered while the run goes on and no stop was asked for. */
  canStop: boolean;
  /** The page polls while this holds. */
  polling: boolean;
}

export function describeRun(run: ListingPushRunView, counts: ListingPushRunCounts, storeName: string,
  extras: { drafts?: number; waitingUntil?: string | null } = {}): RunDescription {
  const done = runDoneCount(counts);
  const total = run.targetCount;
  const parts = runCounts(counts, extras.drafts ?? 0);
  const line = PUBLISH_WORDS.runCounts(parts);
  const problems = runProblemCount(counts);
  const base = { countsLine: line === "" ? null : line, problemsTitle: problems > 0 ? PUBLISH_WORDS.runProblems(problems) : null,
    waitingUntil: null, draftsLine: (parts.drafts ?? 0) > 0 ? PUBLISH_WORDS.runDrafts : null };
  const ended = (phase: RunPhase, title: string): RunDescription => ({ ...base, phase, title, announcement: title, canStop: false, polling: false });
  if (!isRunFinished(run)) {
    if (run.cancelRequestedAt !== null) {
      return { ...base, phase: "stopping", title: PUBLISH_WORDS.runStopping, announcement: PUBLISH_WORDS.runStopping, canStop: false, polling: true };
    }
    return { ...base, phase: "publishing", title: PUBLISH_WORDS.runProgress(storeName, done, total),
      announcement: PUBLISH_WORDS.runAnnounce(storeName), waitingUntil: extras.waitingUntil ?? null, canStop: true, polling: true };
  }
  // A run that stopped early says how many were published: the sizes eBay's outage failed, or the stop cancelled, are
  // decided but were not done (the counts line names them).
  if (run.stopReason === "provider_unavailable") return ended("providerDown", PUBLISH_WORDS.runProviderDown(counts.completed, total));
  if (run.stopReason === "vendor_stop" || run.status === "cancelled") return ended("stopped", PUBLISH_WORDS.runStopped(counts.completed, total));
  // A skipped size (left out on purpose) is no problem; a problem with nothing published is nothing published.
  if (problems > 0 && counts.completed === 0) return ended("finishedNothing", PUBLISH_WORDS.runNothingPublished);
  if (problems > 0 || (parts.drafts ?? 0) > 0) return ended("finishedPartial", PUBLISH_WORDS.runFinished);
  return ended("finished", PUBLISH_WORDS.runFinished);
}

/** How long a finished run with problems is shown again when step 3 opens, until the vendor hides it (review round 2 DUX1). */
export const FINISHED_RUN_SHOWN_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether step 3, opening, shows the store's newest run (§4.10 shows a processing one; review round 2 DUX1 also a
 * finished one that left problems, for a week, unless the vendor hid it): the run email sends the vendor to step 3
 * for each size that didn't publish, and a reload must not lose them. `nowMs` is passed in (no clock here).
 */
export function shouldShowFoundRun(input: {
  found: { run: Pick<ListingPushRunView, "runId" | "status" | "completedAt">; counts: ListingPushRunCounts } | null | undefined;
  nowMs: number;
  hiddenRunIds: ReadonlySet<number>;
}): boolean {
  const found = input.found;
  if (!found || input.hiddenRunIds.has(found.run.runId)) return false;
  if (!isRunFinished(found.run)) return true;
  if (runProblemCount(found.counts) === 0 || found.run.completedAt === null) return false;
  const completedMs = Date.parse(found.run.completedAt);
  return Number.isFinite(completedMs) && input.nowMs - completedMs <= FINISHED_RUN_SHOWN_MS;
}

/** The per-viewer key that remembers a hidden run (browser storage; a convenience only, never state that must last). */
export function hiddenRunStorageKey(runId: number): string {
  return `${HIDDEN_RUN_STORAGE_PREFIX}${runId}`;
}

export const HIDDEN_RUN_STORAGE_PREFIX = "dropship-publish-run-hidden:";

/** A stored hide's run id, or null when the key is not one (`dropship-publish-run-hidden:{id}`). */
export function hiddenRunIdFromStorageKey(key: string | null): number | null {
  if (!key || !key.startsWith(HIDDEN_RUN_STORAGE_PREFIX)) return null;
  const id = Number(key.slice(HIDDEN_RUN_STORAGE_PREFIX.length));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Whether a stored hide can go (verify VC15): its value is when it was hidden (ms); once that is older than
 * FINISHED_RUN_SHOWN_MS the run is never shown again by itself anyway, and an unreadable value is dropped too, so the
 * stored hides stay bounded instead of growing with every hidden run. `nowMs` is passed in.
 */
export function hiddenRunExpired(value: string | null, nowMs: number): boolean {
  const hiddenAt = value === null ? Number.NaN : Number(value);
  return !Number.isFinite(hiddenAt) || nowMs - hiddenAt > FINISHED_RUN_SHOWN_MS;
}

/** "Publish new" left sizes out (DUX8): its words name both causes; "Publish all" only the one that applies. */
export function runSnapshotDiffWords(scope: ListingPushRunScope, count: number): string {
  return scope === "not_live" ? PUBLISH_WORDS.runSnapshotDiffNew(count) : PUBLISH_WORDS.runSnapshotDiff(count);
}

export interface RunProblemView {
  productVariantId: number;
  /** "Envelope Single Pocket · Pack of 50 · ENV-SGL-P50", or the size id when the catalog no longer has it. */
  name: string;
  reason: string;
  /** What to do about it, when the reason does not already say (review round 2 DUX5); null otherwise. */
  nextStep: string | null;
}

/**
 * One "Didn't publish" row: the reason in the vendor's words, never a code. A blocked size's server message is its
 * blocker codes (insertJobItemForPreview), each read with step 3's issue words; a price held for review gets its own
 * words (§4.11 priceReviewRow). `storeOwnName` is the store's own name, or null when it has none yet
 * (catalogStoreOwnName): the eBay account refusal's step names the store's Reconnect button by it.
 */
export function describeRunProblem(problem: ListingPushRunProblem, storeOwnName: string | null = null): RunProblemView {
  const name = [problem.productName, problem.variantName, problem.sku]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "").join(" · ")
    || PUBLISH_WORDS.sizeFallback(problem.productVariantId);
  const { reason, nextStep } = problemWords(problem, storeOwnName);
  return { productVariantId: problem.productVariantId, name, reason, nextStep };
}

const PREVIEW_BLOCKED_CODE = "DROPSHIP_LISTING_PREVIEW_BLOCKED";

/**
 * Codes whose stored message is written for operators, or names a step the page no longer has ("queue the listing
 * again"): the row gets the vendor's words and the step instead (review round 2 DUX5; HEAD's STOCK_GATE_REFUSALS and
 * listingPushNextStep, client/src/lib/dropship-listing-push-status.ts, re-worded for "Publish").
 */
const PROBLEM_WORDS_BY_CODE: Readonly<Record<string, { reason: string; nextStep: string | null }>> = Object.freeze({
  DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH: { reason: PUBLISH_WORDS.shipFromRow, nextStep: PUBLISH_WORDS.shipFromStep },
  PUBLICATION_PRIOR_OUTCOME_UNRESOLVED: { reason: PUBLISH_WORDS.priorOutcomeRow, nextStep: PUBLISH_WORDS.priorOutcomeStep },
  PUBLICATION_PROVIDER_COOLDOWN: { reason: PUBLISH_WORDS.cooldownRow, nextStep: PUBLISH_WORDS.laterStep },
  // The listing changed between its check and its send (the worker's preview-hash check): as a stale size.
  DROPSHIP_LISTING_PREVIEW_DRIFT: { reason: PUBLISH_WORDS.staleRow, nextStep: null },
  // The worker's catch-all for an unexpected error: its message is the error's own text (a database or code fault),
  // never words for the vendor (verify VC8).
  DROPSHIP_LISTING_PUSH_FAILED: { reason: PUBLISH_WORDS.failedRow, nextStep: null },
  // A product whose stock could not be read failed its sizes (verify V6); the server's message names the product id.
  DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE: { reason: PUBLISH_WORDS.stockUnreadRow, nextStep: PUBLISH_WORDS.retryStep },
  DROPSHIP_ALLOCATION_UNAVAILABLE: { reason: PUBLISH_WORDS.stockUnreadRow, nextStep: PUBLISH_WORDS.retryStep },
});

const ACCOUNT_BLOCK_CODES: ReadonlySet<string> = new Set([
  "DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "DROPSHIP_LISTING_STORE_BLOCKED", "DROPSHIP_LISTING_VENDOR_BLOCKED",
]);

function problemWords(problem: ListingPushRunProblem, storeOwnName: string | null): { reason: string; nextStep: string | null } {
  if (problem.outcome === "price_review") return { reason: PUBLISH_WORDS.priceReviewRow, nextStep: null };
  if (problem.outcome === "stale") return { reason: PUBLISH_WORDS.staleRow, nextStep: null };
  const known = problem.code ? PROBLEM_WORDS_BY_CODE[problem.code] : undefined;
  if (known) return known;
  if (problem.code !== null && isDropshipStockLinkRefusalCode(problem.code)) return stockLinkRunWords(problem.code, storeOwnName);
  // The stock gate's and the eBay account check's refusals carry operator text: their reason is the listing push
  // notice's own words (PR 1b listingPushRefusalWords, one source for both surfaces); the step says "publish again",
  // as every step on this card does.
  const refusal = problem.code
    ? listingPushRefusalWords({ errorCode: problem.code, errorMessage: problem.message, retryable: problem.retryable }, storeOwnName)
    : undefined;
  if (refusal) return { reason: asSentence(refusal.reason), nextStep: runRefusalStep(problem, storeOwnName) };
  if (problem.code?.startsWith(EBAY_CONNECTOR_CODE_PREFIX)) return ebayConnectorWords(problem);
  if (problem.code === PREVIEW_BLOCKED_CODE) {
    const reasons = listingPushBlockedReasons(problem.message);
    if (reasons.length > 0) return { reason: reasons.join(" "), nextStep: PUBLISH_WORDS.blockedFixStep };
  }
  const message = problem.message?.trim() ?? "";
  // The server's own words for an item eBay stayed down for, or one no longer chosen, already say what to do.
  if (problem.code === LISTING_PUSH_RUN_PROVIDER_UNAVAILABLE_CODE || problem.code === "DROPSHIP_LISTING_NOT_SELECTED") {
    return { reason: message || PUBLISH_WORDS.failedRow, nextStep: null };
  }
  if (!message) return { reason: PUBLISH_WORDS.failedRow, nextStep: null };
  if (problem.code !== null && ACCOUNT_BLOCK_CODES.has(problem.code)) return { reason: message, nextStep: PUBLISH_WORDS.accountStep };
  if (problem.code === "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR") {
    return { reason: message, nextStep: problem.retryable ? PUBLISH_WORDS.ebayTemporaryStep : PUBLISH_WORDS.ebayFixStep };
  }
  return { reason: message, nextStep: problem.retryable ? PUBLISH_WORDS.retryStep : PUBLISH_WORDS.fixStep };
}

const LISTING_PUSH_RUN_PROVIDER_UNAVAILABLE_CODE = "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE";

/** The stock gate's refusal for a store with no verified eBay account (inventory-planning quantity-publication-runtime). */
const STOCK_GATE_ACCOUNT_UNVERIFIED_CODE = "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED";

/**
 * The step after a refusal listingPushRefusalWords words: the account check's (or the other eBay site's), else a
 * stock-gate refusal's, by the server's class (classifyStockGateRefusal stores retryable false for one only Card
 * Shellz can clear).
 */
function runRefusalStep(problem: ListingPushRunProblem, storeOwnName: string | null): string {
  if (problem.code === EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE
    && problem.message?.trim() === EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE) return PUBLISH_WORDS.ebaySiteStep;
  if (problem.code === EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE || problem.code === STOCK_GATE_ACCOUNT_UNVERIFIED_CODE) {
    return PUBLISH_WORDS.accountCheckStep(storeOwnName);
  }
  // Card Shellz paused stock updates: 1b says "later" for these, though the server retries them (merge review ADV-RB-2).
  if (isPausedStockRefusal(problem.code)) return PUBLISH_WORDS.pausedStockStep;
  return problem.retryable === false ? PUBLISH_WORDS.stockSetupStep : PUBLISH_WORDS.retryStep;
}

/**
 * The automatic stock link's refusals (Fix PR 2a): the reason is 2a's shared vendor words
 * (shared/dropship/stock-link-refusals, the same words the listing push notice shows and the server's message carries),
 * the step 2a's next step for "publish". A run's chunk job is never re-queued by the push sweep (the ops repository's
 * stockLinkCandidateSql selects run_id null only), so the two transient codes get the step the vendor takes, never 2a's
 * "Card Shellz will try this listing again automatically". The item's SKU or details changing after the press reads as
 * PR A's own words for a size that changed while publishing (2a's reason says "queued", which a run never does).
 */
function stockLinkRunWords(code: DropshipStockLinkRefusalCode, storeOwnName: string | null): { reason: string; nextStep: string | null } {
  if (code === "DROPSHIP_STOCK_SKU_CHANGED") return { reason: PUBLISH_WORDS.staleRow, nextStep: null };
  return { reason: asSentence(DROPSHIP_STOCK_LINK_REFUSAL_WORDS[code].reason), nextStep: STOCK_LINK_RUN_STEPS[code](storeOwnName) };
}

/**
 * Each stock link refusal's step on the run card, by 2a's next step: Card Shellz has to act (destination, stock setup,
 * a hold, the store's mode, a SKU conflict, a failed link), the vendor reconnects the store, tries again, checks the
 * selection or the listing eBay already has, or waits (busy: a few minutes; paused: later). Typed over every code, so a
 * new 2a code cannot reach the card without a step.
 */
const STOCK_LINK_RUN_STEPS: Readonly<Record<Exclude<DropshipStockLinkRefusalCode, "DROPSHIP_STOCK_SKU_CHANGED">,
  (storeOwnName: string | null) => string>> = Object.freeze({
  DROPSHIP_STOCK_DESTINATION_NOT_READY: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_DESTINATION_DUPLICATED: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_ITEM_NOT_READY: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_STORE_ON_HOLD: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_ITEM_ON_HOLD: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED: (storeOwnName) => PUBLISH_WORDS.reconnectStep(storeOwnName),
  DROPSHIP_STOCK_SKU_LINK_CONFLICT: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_LINK_CHANGED: () => PUBLISH_WORDS.publishAgainStep,
  DROPSHIP_STOCK_NOT_OFFERED: () => PUBLISH_WORDS.notOfferedStep,
  DROPSHIP_STOCK_MODE_NOT_MANAGED: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_UPDATES_PAUSED: () => PUBLISH_WORDS.pausedStockStep,
  DROPSHIP_STOCK_LINK_BUSY: () => PUBLISH_WORDS.retryStep,
  DROPSHIP_STOCK_LINK_FAILED: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_READINESS_REQUIRED: () => PUBLISH_WORDS.stockSetupStep,
  DROPSHIP_STOCK_RESEND_LISTING_FOUND: () => PUBLISH_WORDS.listingFoundStep,
});

/**
 * The shared eBay connector's own codes (server/modules/channels). Since #1873 the eBay push provider stores its
 * refusals with that code and message (translateEbayConnectorError, dropship-ebay-connector-errors.ts) instead of the
 * worker's DROPSHIP_LISTING_PUSH_FAILED; Card Shellz's own codes start DROPSHIP_.
 */
const EBAY_CONNECTOR_CODE_PREFIX = "EBAY_";

/**
 * A connector refusal's row. Its message is written for Card Shellz's channel staff ("Review the saved account, SKU,
 * offer and listing mappings"), so the row never shows it (verify VC8). One the server marks not retryable (its
 * PERMANENT_EBAY_CONNECTOR_CODES) is support's to check; any other is worded as before #1873, when it was stored as
 * DROPSHIP_LISTING_PUSH_FAILED (merge review ADV-1).
 */
function ebayConnectorWords(problem: ListingPushRunProblem): { reason: string; nextStep: string | null } {
  return problem.retryable === false
    ? { reason: PUBLISH_WORDS.ebayCheckRow, nextStep: PUBLISH_WORDS.ebayCheckStep }
    : { reason: PUBLISH_WORDS.failedRow, nextStep: null };
}

/** The push notice shows these reasons after "Could not list: ", so some start in lower case; a row is a sentence. */
function asSentence(text: string): string {
  return /^[a-z]/.test(text) && !text.startsWith("eBay") ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

// ---------------------------------------------------------------------------
// The optional Check (D15)
// ---------------------------------------------------------------------------

export function chunkIds(ids: readonly number[], size: number = CHECK_CHUNK_SIZE): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error("chunkIds needs a whole chunk size of at least 1.");
  const chunks: number[][] = [];
  for (let start = 0; start < ids.length; start += size) chunks.push(ids.slice(start, start + size));
  return chunks;
}

const id = z.number().int().positive();

/**
 * One previewed size as the Check keeps it (§4.10 toCheckRow): the fields step 3's table rows and counts read,
 * without the listing's `presentation` (its description text and images, the heavy part at 10,000 sizes, MP §1).
 * Opening a row's preview reads that one size's full preview (`checkDetailAnswerSchema`; review round 2 DUX2). The
 * server's worker-only `listingIntent` never reaches the page (toDropshipVendorListingPreview); unknown fields are
 * dropped.
 */
export const checkPreviewRowSchema = z.object({
  productVariantId: id,
  // 0 when the size is no longer in the catalog (listingPreviewSettingsLink).
  productId: z.number().int().nonnegative(),
  sku: z.string().nullable(),
  title: z.string(),
  platform: z.string(),
  listingMode: z.string().nullable(),
  currentListingStatus: z.string(),
  previewStatus: z.enum(["ready", "blocked", "warning"]),
  blockers: z.array(z.string()),
  warnings: z.array(z.string()),
  marketplaceQuantity: z.number().int(),
  priceCents: z.number().int().nullable(),
  marketplaceCategoryId: z.string().nullable(),
  marketplaceCategoryName: z.string().nullable(),
  storeCategoryNames: z.array(z.string()),
  businessPolicySelection: z.object({
    fulfillmentPolicyId: z.string().nullable(),
    returnPolicyId: z.string().nullable(),
    paymentPolicyId: z.string().nullable(),
    overriddenFields: z.array(z.enum(["fulfillmentPolicyId", "returnPolicyId", "paymentPolicyId"])),
  }).nullable(),
  previewHash: z.string(),
  priceSettingRevisionId: z.number().int().positive().nullable().optional(),
  rulePriceEvidenceHash: z.string().nullable().optional(),
  contentEvidenceHash: z.string().optional(),
  pricingRuleName: z.string().nullable().optional(),
  marketplaceCategorySource: z.enum(ebayCategorySourceValues).optional(),
  marketplaceCategoryRuleName: z.string().nullable().optional(),
  // Kept (small: a few cents values): step 3's table shows the vendor's product cost from it.
  economics: dropshipListingEconomicsSchema.optional(),
});
export type CheckRow = z.infer<typeof checkPreviewRowSchema>;

/** `POST /api/dropship/listings/preview`'s answer, as one Check chunk reads it. */
export const checkPreviewAnswerSchema = z.object({
  preview: z.object({
    vendorId: id,
    storeConnectionId: id,
    platform: z.string(),
    generatedAt: z.string(),
    rows: z.array(checkPreviewRowSchema),
  }),
});
export type CheckPreviewAnswer = z.infer<typeof checkPreviewAnswerSchema>;

/**
 * One size's full preview, read when its sheet opens on a checked row (review round 2 DUX2): the Check's row with its
 * `presentation` (images, description, item specifics), checked with the shared presentation schema.
 */
export const checkDetailRowSchema = checkPreviewRowSchema.extend({ presentation: dropshipListingPresentationSchema.optional() });
export const checkDetailAnswerSchema = z.object({
  preview: z.object({ storeConnectionId: id, generatedAt: z.string(), rows: z.array(checkDetailRowSchema) }),
});
export type CheckDetailRow = z.infer<typeof checkDetailRowSchema>;

/** A previewed row as the Check keeps it: `presentation` (and anything unknown) dropped. */
export function toCheckRow(row: DropshipListingPreviewRow | CheckRow): CheckRow {
  const { presentation: _presentation, ...rest } = row as DropshipListingPreviewRow;
  return checkPreviewRowSchema.parse(rest);
}

export interface CheckSummary { total: number; ready: number; warnings: number; blocked: number }

export function sumCheck(rows: readonly Pick<CheckRow, "previewStatus">[]): CheckSummary {
  let ready = 0;
  let warnings = 0;
  let blocked = 0;
  for (const row of rows) {
    if (row.previewStatus === "ready") ready += 1;
    else if (row.previewStatus === "warning") warnings += 1;
    else blocked += 1;
  }
  return { total: rows.length, ready, warnings, blocked };
}

/** A finished Check, for step 3's table (`DropshipListingPreview`), which reads a preview result. */
export interface CheckResult {
  /** The store and selection revision it was made for; it is thrown away when either moves (§4.10). */
  contextKey: string;
  preview: DropshipListingPreviewResult;
  summary: CheckSummary;
}

export function checkContextKey(storeConnectionId: number, selectionRevisionId: number | null): string {
  return `${storeConnectionId}:${selectionRevisionId ?? "none"}`;
}

export function checkResult(input: {
  contextKey: string;
  vendorId: number;
  storeConnectionId: number;
  platform: string;
  generatedAt: string;
  rows: readonly CheckRow[];
}): CheckResult {
  const summary = sumCheck(input.rows);
  return {
    contextKey: input.contextKey,
    summary,
    preview: {
      vendorId: input.vendorId,
      storeConnectionId: input.storeConnectionId,
      platform: input.platform,
      generatedAt: input.generatedAt,
      rows: [...input.rows],
      summary: { total: summary.total, ready: summary.ready, blocked: summary.blocked, warning: summary.warnings },
    },
  };
}

// ---------------------------------------------------------------------------
// "Selected items" (server-paged)
// ---------------------------------------------------------------------------

/**
 * One page of the selected list. `summary` is required: a server of stage 1 ignores `selection=` and answers without
 * it, so its answer fails here and reads as "site updating" (§4.8 item 4, CHK7). Rows keep only what the list shows.
 */
export const selectedListPageSchema = z.object({
  rows: z.array(z.object({
    productVariantId: id,
    productName: z.string(),
    variantName: z.string(),
    variantSku: z.string().nullable(),
    selectionDecision: z.object({ marketplaceQuantity: z.number().int() }),
  })),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().positive(),
  summary: dropshipCatalogReadSummarySchema,
});
export type SelectedListPage = z.infer<typeof selectedListPageSchema>;
export type SelectedListRow = SelectedListPage["rows"][number];

/** The pages read so far, merged by size (first seen wins) and capped at SELECTED_LIST_MAX_ROWS. */
export function mergeSelectedPages(pages: readonly SelectedListPage[]): { rows: SelectedListRow[]; total: number } {
  const seen = new Set<number>();
  const rows: SelectedListRow[] = [];
  for (const page of pages) {
    for (const row of page.rows) {
      if (seen.has(row.productVariantId) || rows.length >= SELECTED_LIST_MAX_ROWS) continue;
      seen.add(row.productVariantId);
      rows.push(row);
    }
  }
  return { rows, total: pages.at(-1)?.total ?? 0 };
}

/** The next page to read, or undefined when every row is read, a page came back short, or 1,000 are shown. */
export function selectedListNextPage(lastPage: SelectedListPage, allPages: readonly SelectedListPage[]): number | undefined {
  const read = allPages.reduce((sum, page) => sum + page.rows.length, 0);
  if (lastPage.rows.length < lastPage.limit || read >= lastPage.total || read >= SELECTED_LIST_MAX_ROWS) return undefined;
  return lastPage.page + 1;
}
