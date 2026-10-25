import { describe, expect, it } from "vitest";
import {
  emptyListingPushRunCounts,
  LISTING_PUSH_RUN_ERROR_CODES,
  type ListingPushRunCounts,
  type ListingPushRunProblem,
  type ListingPushRunView,
} from "@shared/dropship/listing-push-runs";
import {
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON,
  type DropshipCatalogSelectionSummary,
} from "@shared/dropship/vendor-catalog-reads";
import {
  CATALOG_PAGE_CLIENT_VERSION,
  CHECK_CHUNK_SIZE,
  PUBLISH_READ_MAX_RETRIES,
  RUN_CREATE_BACKOFF_MS,
  RUN_CREATE_MAX_TRIES,
  SELECTED_LIST_MAX_ROWS,
  checkContextKey,
  checkPreviewAnswerSchema,
  checkResult,
  chunkIds,
  classifyRunCreateError,
  describePublishChoices,
  describeRun,
  describeRunProblem,
  isOlderCatalogServerError,
  isRunFinished,
  isTransientPublishError,
  mergeSelectedPages,
  pressedCount,
  publishReadRetryDelayMs,
  publishRequestFingerprint,
  retryPublishRead,
  runCounts,
  runDoneCount,
  runPollDelayMs,
  runProblemCount,
  runReadCanRecover,
  runSnapshotDiff,
  runSnapshotDiffWords,
  selectedListNextPage,
  shouldShowFoundRun,
  FINISHED_RUN_SHOWN_MS,
  PUBLISH_READ_INTERNAL_MAX_RETRIES,
  hiddenRunExpired,
  hiddenRunIdFromStorageKey,
  hiddenRunStorageKey,
  isInternalServerError,
  selectedListPageSchema,
  sumCheck,
  toCheckRow,
  type SelectedListPage,
} from "../dropship-catalog-publish";
import { PUBLISH_WORDS } from "../dropship-catalog-publish-words";
import { isPausedStockRefusal, listingPushRefusalWords } from "../dropship-listing-push-status";
import {
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE,
  EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE,
  EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE,
} from "@shared/dropship/ebay-publication-account";
import { DROPSHIP_SITE_UPDATING_CODE, DropshipApiError, type DropshipListingPreviewRow } from "../dropship-ops-surface";
import { DROPSHIP_CATALOG_CODE_VERSION } from "../../../../server/modules/dropship/domain/catalog-code-version";
import { RUN_NOTICE_SHIP_FROM_REASON } from "../../../../server/modules/dropship/domain/listing-push-run-words";
import { STOCK_LINK_REFUSAL_POLICY } from "../../../../server/modules/dropship/domain/stock-link-readiness";
import {
  DROPSHIP_STOCK_LINK_REFUSAL_CODES,
  DROPSHIP_STOCK_LINK_REFUSAL_WORDS,
  dropshipStockLinkServerMessage,
  type DropshipStockLinkRefusalCode,
} from "@shared/dropship/stock-link-refusals";

/**
 * Catalog step 3 on publish runs (step 1 plan S2-5, PR A, §4.10, §4.12): the
 * pure rules. Every time is passed in; nothing reads the clock.
 */

const STAMP = "2026-10-20T12:00:00.000Z";

function run(overrides: Partial<ListingPushRunView> = {}): ListingPushRunView {
  return {
    runId: 7, storeConnectionId: 5, scope: "not_live", status: "processing", stopReason: null, selectionRevisionId: 3,
    targetCount: 1_234, chunkSize: 500, chunkCount: 3, nextChunkIndex: 1, cancelRequestedAt: null,
    createdAt: STAMP, updatedAt: STAMP, completedAt: null, ...overrides,
  };
}

function counts(overrides: Partial<ListingPushRunCounts> = {}): ListingPushRunCounts {
  return { ...emptyListingPushRunCounts(), ...overrides };
}

function apiError(status: number, code: string | null = null, message = "Refused.", context: Record<string, unknown> | null = null) {
  return new DropshipApiError({ status, code, message, context });
}

function summary(overrides: Partial<DropshipCatalogSelectionSummary> = {}): DropshipCatalogSelectionSummary {
  return { selectionRevisionId: 3, selectedTotal: 1_234, cap: 10_000, overCap: false,
    store: { storeConnectionId: 5, live: 234, notLive: 1_000 }, ...overrides };
}

describe("limits and schedules", () => {
  it("pins the page version to the server's B version, the check chunk under the preview cap, and the run poll", () => {
    // PR B set both this and DROPSHIP_CATALOG_CODE_VERSION (server/modules/dropship/domain/catalog-code-version.ts) to 2.
    expect(CATALOG_PAGE_CLIENT_VERSION).toBe(2);
    // One release's page and server carry one version: raising one without the other fails here (review round 2 CT6).
    expect(CATALOG_PAGE_CLIENT_VERSION).toBe(DROPSHIP_CATALOG_CODE_VERSION);
    expect(CHECK_CHUNK_SIZE).toBe(200);
    expect(RUN_CREATE_MAX_TRIES).toBe(3);
    expect(RUN_CREATE_BACKOFF_MS).toEqual([1_000, 2_000]);
    expect(runPollDelayMs(0)).toBe(3_000);
    expect(runPollDelayMs(119_999)).toBe(3_000);
    expect(runPollDelayMs(120_000)).toBe(15_000);
    expect(runPollDelayMs(3_600_000)).toBe(15_000);
  });

  it("retries a read on the run poll's schedule: 40 fast retries (2 minutes), then slow, then it stops", () => {
    expect(publishReadRetryDelayMs(0)).toBe(3_000);
    expect(publishReadRetryDelayMs(39)).toBe(3_000);
    expect(publishReadRetryDelayMs(40)).toBe(15_000);
    expect(publishReadRetryDelayMs(-1)).toBe(3_000);
    const updating = apiError(503, DROPSHIP_SITE_UPDATING_CODE);
    expect(retryPublishRead(0, updating)).toBe(true);
    expect(retryPublishRead(PUBLISH_READ_MAX_RETRIES - 1, updating)).toBe(true);
    expect(retryPublishRead(PUBLISH_READ_MAX_RETRIES, updating)).toBe(false);
    // A refusal is never read again by itself.
    expect(retryPublishRead(0, apiError(404, LISTING_PUSH_RUN_ERROR_CODES.notFound))).toBe(false);
  });
});

describe("errors (§4.12)", () => {
  it("classes no answer, a 5xx, 408, 429, busy and site updating as transient, and an abort never", () => {
    expect(isTransientPublishError(new TypeError("Failed to fetch"))).toBe(true);
    for (const status of [500, 502, 503]) expect(isTransientPublishError(apiError(status))).toBe(true);
    expect(isTransientPublishError(apiError(408))).toBe(true);
    expect(isTransientPublishError(apiError(429, LISTING_PUSH_RUN_ERROR_CODES.rateLimited))).toBe(true);
    expect(isTransientPublishError(apiError(409, LISTING_PUSH_RUN_ERROR_CODES.busy))).toBe(true);
    expect(isTransientPublishError(apiError(503, DROPSHIP_SITE_UPDATING_CODE))).toBe(true);
    expect(isTransientPublishError(new DOMException("The operation was aborted.", "AbortError"))).toBe(false);
    expect(isTransientPublishError(apiError(409, LISTING_PUSH_RUN_ERROR_CODES.runActive))).toBe(false);
    expect(isTransientPublishError(new Error("boom"))).toBe(false);
  });

  it("(review round 1 CLI-2) an answer from code older than this page: site updating, or an older catalog server's 503 for a newer page; nothing else", () => {
    expect(isOlderCatalogServerError(apiError(503, DROPSHIP_SITE_UPDATING_CODE))).toBe(true);
    // What an A dyno answers every step 1 and step 3 read of this page (clientVersion 2 > its 1; §4 row 3, §12.6).
    const newerPage = apiError(503, DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused, "x", { reason: DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON });
    expect(isOlderCatalogServerError(newerPage)).toBe(true);
    // Another paused reason, a plain 503, the same reason on another status or code, and no answer are not "updating".
    expect(isOlderCatalogServerError(apiError(503, DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused, "x", { reason: "older_version_running" }))).toBe(false);
    expect(isOlderCatalogServerError(apiError(503, DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused))).toBe(false);
    expect(isOlderCatalogServerError(apiError(503))).toBe(false);
    expect(isOlderCatalogServerError(apiError(500, DROPSHIP_CATALOG_READ_ERROR_CODES.writesPaused, "x", { reason: DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON }))).toBe(false);
    expect(isOlderCatalogServerError(apiError(503, "DROPSHIP_ALLOCATION_UNAVAILABLE", "x", { reason: DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON }))).toBe(false);
    expect(isOlderCatalogServerError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isOlderCatalogServerError(null)).toBe(false);
    // It is still retried like every transient read.
    expect(retryPublishRead(0, newerPage)).toBe(true);
  });

  it("maps every run create refusal to what the press does, in the plan's words", () => {
    expect(classifyRunCreateError(apiError(409, LISTING_PUSH_RUN_ERROR_CODES.busy), "all")).toEqual({ kind: "transient" });
    expect(classifyRunCreateError(apiError(503, DROPSHIP_SITE_UPDATING_CODE), "all")).toEqual({ kind: "transient" });
    expect(classifyRunCreateError(apiError(409, LISTING_PUSH_RUN_ERROR_CODES.selectionRevisionConflict), "all"))
      .toEqual({ kind: "reread", message: PUBLISH_WORDS.selectionChanged });
    expect(classifyRunCreateError(apiError(409, LISTING_PUSH_RUN_ERROR_CODES.runActive, "x", { runId: 41 }), "all"))
      .toEqual({ kind: "showRun", runId: 41, message: PUBLISH_WORDS.runActive });
    // A run id the page can't use: it reads the store's newest run instead.
    expect(classifyRunCreateError(apiError(409, LISTING_PUSH_RUN_ERROR_CODES.runActive, "x", { runId: "41" }), "all"))
      .toEqual({ kind: "showRun", runId: null, message: PUBLISH_WORDS.runActive });
    expect(classifyRunCreateError(apiError(403, "DROPSHIP_STEP_UP_REQUIRED"), "all"))
      .toEqual({ kind: "stepUp", message: PUBLISH_WORDS.stepUpExpired });
    expect(classifyRunCreateError(apiError(422, LISTING_PUSH_RUN_ERROR_CODES.tooLarge), "all"))
      .toEqual({ kind: "permanent", message: PUBLISH_WORDS.runTooLarge });
    for (const code of [LISTING_PUSH_RUN_ERROR_CODES.invalidInput, LISTING_PUSH_RUN_ERROR_CODES.keyRequired, LISTING_PUSH_RUN_ERROR_CODES.idempotencyConflict]) {
      expect(classifyRunCreateError(apiError(400, code), "all")).toEqual({ kind: "permanent", message: PUBLISH_WORDS.notSent });
    }
    // An account refusal keeps the server's words (its notice carries the fix).
    expect(classifyRunCreateError(apiError(403, "DROPSHIP_LISTING_VENDOR_BLOCKED", "Selling is paused."), "all"))
      .toEqual({ kind: "permanent", message: "Selling is paused." });
    expect(classifyRunCreateError(apiError(404, "DROPSHIP_STORE_CONNECTION_REQUIRED", "   "), "all"))
      .toEqual({ kind: "permanent", message: PUBLISH_WORDS.notSent });
    expect(classifyRunCreateError(new Error("schema"), "all")).toEqual({ kind: "permanent", message: PUBLISH_WORDS.notSent });
  });

  it("says Publish all when nothing is new but something is live, and step 1 otherwise", () => {
    const empty = (scope: "not_live" | "all", liveCount: unknown) =>
      classifyRunCreateError(apiError(422, LISTING_PUSH_RUN_ERROR_CODES.empty, "x", { scope, liveCount }), scope);
    expect(empty("not_live", 12)).toEqual({ kind: "permanent", message: PUBLISH_WORDS.runEmptyNew });
    expect(empty("not_live", 0)).toEqual({ kind: "permanent", message: PUBLISH_WORDS.runEmpty });
    expect(empty("not_live", undefined)).toEqual({ kind: "permanent", message: PUBLISH_WORDS.runEmpty });
    expect(empty("all", 12)).toEqual({ kind: "permanent", message: PUBLISH_WORDS.runEmpty });
  });
});

describe("the two publish choices", () => {
  it("counts the new ones from the store's not-live sizes and hides Publish new at 0", () => {
    expect(describePublishChoices(summary(), 5)).toEqual({ newCount: 1_000, allCount: 1_234, live: 234, block: null, selectionRevisionId: 3 });
    const allLive = describePublishChoices(summary({ store: { storeConnectionId: 5, live: 1_234, notLive: 0 } }), 5);
    expect(allLive?.newCount).toBeNull();
    expect(allLive?.allCount).toBe(1_234);
  });

  it("is null for another store's summary, no store, or no answer, so a press never uses a count the vendor didn't see", () => {
    expect(describePublishChoices(summary(), 9)).toBeNull();
    expect(describePublishChoices(summary({ store: null }), 5)).toBeNull();
    expect(describePublishChoices(undefined, 5)).toBeNull();
    expect(describePublishChoices(null, 5)).toBeNull();
  });

  it("blocks both buttons over the cap and with nothing selected", () => {
    expect(describePublishChoices(summary({ selectedTotal: 10_001, overCap: true, store: { storeConnectionId: 5, live: 1, notLive: 10_000 } }), 5)?.block)
      .toBe("tooLarge");
    expect(describePublishChoices(summary({ selectedTotal: 0, store: { storeConnectionId: 5, live: 0, notLive: 0 } }), 5)?.block).toBe("empty");
    expect(describePublishChoices(summary({ selectionRevisionId: null }), 5)?.selectionRevisionId).toBeNull();
  });

  it("remembers the pressed count, and how many the server's snapshot left out", () => {
    const choices = describePublishChoices(summary(), 5)!;
    expect(pressedCount(choices, "not_live")).toBe(1_000);
    expect(pressedCount(choices, "all")).toBe(1_234);
    expect(runSnapshotDiff(1_234, 1_232)).toBe(2);
    expect(runSnapshotDiff(1_234, 1_234)).toBe(0);
    // More than counted (a size became offered between the count and the press) is not a difference to report.
    expect(runSnapshotDiff(10, 12)).toBe(0);
    expect(runSnapshotDiff(null, 12)).toBe(0);
  });

  it("gives one fingerprint per store, scope and revision, for reusing an unconfirmed press's key", () => {
    const base = { storeConnectionId: 5, scope: "not_live" as const, expectedSelectionRevisionId: 3 };
    expect(publishRequestFingerprint(base)).toBe("5:not_live:3");
    expect(publishRequestFingerprint({ ...base, scope: "all" })).not.toBe(publishRequestFingerprint(base));
    expect(publishRequestFingerprint({ ...base, expectedSelectionRevisionId: 4 })).not.toBe(publishRequestFingerprint(base));
    expect(publishRequestFingerprint({ ...base, expectedSelectionRevisionId: null })).toBe("5:not_live:none");
  });
});

describe("a run in the vendor's words", () => {
  it("counts what is decided, what failed and the counts line with zero parts left out", () => {
    const all = counts({ pending: 500, queued: 200, completed: 400, failed: 3, blocked: 2, skipped: 5, price_review: 1, stale: 1, cancelled: 4 });
    expect(runDoneCount(all)).toBe(412);
    expect(runProblemCount(all)).toBe(7);
    expect(runCounts(all)).toEqual({ completed: 400, drafts: 0, notReady: 2, review: 1, failed: 4, skipped: 5 });
    // Drafts are counted apart from published, never more than completed (review round 2 DUX3).
    expect(runCounts(all, 150)).toMatchObject({ completed: 250, drafts: 150 });
    expect(runCounts(all, 9_999)).toMatchObject({ completed: 0, drafts: 400 });
    expect(runCounts(all, -3)).toMatchObject({ completed: 400, drafts: 0 });
    expect(PUBLISH_WORDS.runCounts(runCounts(all, 150))).toBe("250 published · 150 saved as unpublished drafts · 2 not ready · 1 price needs your review · 4 failed · 5 skipped");
    expect(PUBLISH_WORDS.runCounts(runCounts(all))).toBe("400 published · 2 not ready · 1 price needs your review · 4 failed · 5 skipped");
    expect(PUBLISH_WORDS.runCounts(runCounts(counts({ completed: 1_200 })))).toBe("1,200 published");
    expect(PUBLISH_WORDS.runCounts(runCounts(counts()))).toBe("");
  });

  it("shows progress and Stop while a run goes on, and Stopping once a stop was asked for", () => {
    const going = describeRun(run(), counts({ completed: 1_200, queued: 34 }), "marz_cards");
    expect(going).toMatchObject({ phase: "publishing", title: "Publishing to marz_cards: 1,200 of 1,234 done", canStop: true, polling: true,
      countsLine: "1,200 published", problemsTitle: null });
    const stopping = describeRun(run({ cancelRequestedAt: STAMP }), counts({ completed: 10 }), "marz_cards");
    expect(stopping).toMatchObject({ phase: "stopping", title: PUBLISH_WORDS.runStopping, canStop: false, polling: true });
    expect(isRunFinished(run())).toBe(false);
  });

  it("words a finished, stopped and provider-down run, and stops polling", () => {
    const done = describeRun(run({ status: "partial" }), counts({ completed: 1_231, failed: 2, price_review: 1 }), "marz_cards");
    expect(done).toMatchObject({ phase: "finishedPartial", title: "Publishing finished.", polling: false, canStop: false,
      problemsTitle: "Didn't publish (3)" });
    // Review round 2 DUX6: by the server's outcome, never green for a run that published nothing.
    expect(describeRun(run({ status: "completed" }), counts({ completed: 1_234 }), "s")).toMatchObject({ phase: "finished", title: PUBLISH_WORDS.runFinished });
    expect(describeRun(run({ status: "failed" }), counts({ blocked: 1_234 }), "s")).toMatchObject({ phase: "finishedNothing",
      title: PUBLISH_WORDS.runNothingPublished });
    expect(describeRun(run({ status: "completed" }), counts({ completed: 10 }), "s", { drafts: 10 })).toMatchObject({ phase: "finishedPartial",
      draftsLine: PUBLISH_WORDS.runDrafts, countsLine: "10 saved as unpublished drafts" });
    // Review round 2 DUX3 and DUX10: the waiting time while it publishes; the live region says the phase only.
    expect(describeRun(run(), counts({ completed: 1 }), "s", { waitingUntil: "2026-10-20T12:30:00.000Z" }))
      .toMatchObject({ waitingUntil: "2026-10-20T12:30:00.000Z", announcement: PUBLISH_WORDS.runAnnounce("s") });
    expect(describeRun(run({ status: "completed" }), counts({ completed: 1 }), "s", { waitingUntil: "2026-10-20T12:30:00.000Z" }).waitingUntil).toBeNull();
    const stopped = describeRun(run({ status: "cancelled", stopReason: "vendor_stop", targetCount: 1_000 }), counts({ completed: 3, cancelled: 997 }), "s");
    expect(stopped).toMatchObject({ phase: "stopped", title: "Publishing stopped. 3 of 1,000 were done before you stopped.", polling: false });
    const down = describeRun(run({ status: "failed", stopReason: "provider_unavailable", targetCount: 10_000 }), counts({ completed: 1_200, failed: 8_800 }), "s");
    expect(down).toMatchObject({ phase: "providerDown",
      title: "eBay wasn't answering, so publishing stopped. 1,200 of 10,000 were done. Publish again later." });
    expect(isRunFinished(run({ status: "completed" }))).toBe(true);
  });

  it("puts a problem's reason in words, never a code", () => {
    const problem = (overrides: Partial<ListingPushRunProblem>): ListingPushRunProblem => ({
      productVariantId: 101, productId: 11, productName: "Envelope Single Pocket", variantName: "Pack of 50", sku: "ENV-SGL-P50",
      outcome: "failed", code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", message: "eBay refused the price.", retryable: false, ...overrides,
    });
    expect(describeRunProblem(problem({}))).toEqual({ productVariantId: 101, name: "Envelope Single Pocket · Pack of 50 · ENV-SGL-P50",
      reason: "eBay refused the price.", nextStep: PUBLISH_WORDS.ebayFixStep });
    expect(describeRunProblem(problem({ outcome: "price_review", code: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW" })).reason).toBe(PUBLISH_WORDS.priceReviewRow);
    expect(describeRunProblem(problem({ outcome: "stale", code: "DROPSHIP_LISTING_PUSH_CHUNK_CONFLICT" })).reason).toBe(PUBLISH_WORDS.staleRow);
    const blocked = describeRunProblem(problem({ outcome: "blocked", code: "DROPSHIP_LISTING_PREVIEW_BLOCKED", message: "catalog_package_data_required" }));
    expect(blocked.reason).toBe("Card Shellz hasn't added this size's package size yet. Contact support.");
    expect(blocked.reason).not.toMatch(/[a-z]+_[a-z_]+/);
    expect(describeRunProblem(problem({ message: "  " })).reason).toBe(PUBLISH_WORDS.failedRow);
    // Review round 2 DUX5: operator wording and steps the page no longer has get the vendor's words and a next step.
    expect(describeRunProblem(problem({ retryable: true }))).toMatchObject({ nextStep: PUBLISH_WORDS.ebayTemporaryStep });
    expect(describeRunProblem(problem({ code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH",
      message: "…choose Update now under Shipping policy, then queue the listing again." })))
      .toMatchObject({ reason: PUBLISH_WORDS.shipFromRow, nextStep: PUBLISH_WORDS.shipFromStep });
    // The email says the same (listing-push-run-words.ts).
    expect(`${PUBLISH_WORDS.shipFromRow} ${PUBLISH_WORDS.shipFromStep}`).toBe(RUN_NOTICE_SHIP_FROM_REASON);
    expect(describeRunProblem(problem({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", message: "A prior provider quantity outcome requires reconciliation." })))
      .toMatchObject({ reason: PUBLISH_WORDS.priorOutcomeRow, nextStep: PUBLISH_WORDS.priorOutcomeStep });
    expect(describeRunProblem(problem({ code: "PUBLICATION_PROVIDER_COOLDOWN" }))).toMatchObject({ reason: PUBLISH_WORDS.cooldownRow });
    expect(describeRunProblem(problem({ code: "DROPSHIP_LISTING_PREVIEW_DRIFT", message: "Listing preview hash no longer matches the vendor listing." })))
      .toMatchObject({ reason: PUBLISH_WORDS.staleRow, nextStep: null });
    expect(describeRunProblem(problem({ code: "DROPSHIP_LISTING_VENDOR_BLOCKED", message: "Selling is paused." })).nextStep).toBe(PUBLISH_WORDS.accountStep);
    expect(describeRunProblem(problem({ code: "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE", message: "eBay wasn't answering, so this size wasn't sent. Publish again later.", retryable: true })))
      .toMatchObject({ nextStep: null });
    expect(describeRunProblem(problem({ code: "SOMETHING_ELSE", retryable: true })).nextStep).toBe(PUBLISH_WORDS.retryStep);
    expect(describeRunProblem(problem({ code: null, retryable: false })).nextStep).toBe(PUBLISH_WORDS.fixStep);
    for (const words of [PUBLISH_WORDS.ebayFixStep, PUBLISH_WORDS.shipFromStep, PUBLISH_WORDS.retryStep, PUBLISH_WORDS.fixStep, PUBLISH_WORDS.laterStep]) {
      expect(words).not.toMatch(/queue/i);
    }
    // A size the catalog no longer has (its names joined as null).
    expect(describeRunProblem(problem({ productName: null, variantName: null, sku: null })).name).toBe("Variant 101");
  });
});

describe("review round 2 (step 1 plan S2-5, PR A)", () => {
  it("CT4 classes both step-up refusals as a new proof, so the next press asks for one", () => {
    for (const code of ["DROPSHIP_STEP_UP_REQUIRED", "DROPSHIP_STEP_UP_METHOD_REQUIRED"]) {
      expect(classifyRunCreateError(apiError(403, code), "all"), code).toEqual({ kind: "stepUp", message: PUBLISH_WORDS.stepUpExpired });
    }
  });

  it("CT7 never retries or polls a run that is gone, and tries an internal error only a few times", () => {
    const gone = apiError(404, LISTING_PUSH_RUN_ERROR_CODES.notFound);
    const internal = apiError(500, "DROPSHIP_LISTING_PUSH_RUN_INTERNAL_ERROR");
    expect(retryPublishRead(0, gone)).toBe(false);
    expect(runReadCanRecover(gone)).toBe(false);
    expect(PUBLISH_READ_INTERNAL_MAX_RETRIES).toBe(3);
    expect(retryPublishRead(2, internal)).toBe(true);
    expect(retryPublishRead(3, internal)).toBe(false);
    expect(runReadCanRecover(internal)).toBe(false);
    // A passing failure still recovers by itself.
    expect(runReadCanRecover(apiError(503, DROPSHIP_SITE_UPDATING_CODE))).toBe(true);
    expect(retryPublishRead(59, apiError(502))).toBe(true);
  });

  it("DUX1 shows the newest run again when it is processing, or finished with problems this week, unless hidden", () => {
    const now = Date.parse(STAMP);
    const found = (status: ListingPushRunView["status"], completedAt: string | null, problems: Partial<ListingPushRunCounts>) =>
      ({ run: run({ status, completedAt }), counts: counts(problems) });
    const none = new Set<number>();
    expect(shouldShowFoundRun({ found: found("processing", null, {}), nowMs: now, hiddenRunIds: none })).toBe(true);
    expect(shouldShowFoundRun({ found: found("partial", STAMP, { completed: 1, failed: 2 }), nowMs: now + 60_000, hiddenRunIds: none })).toBe(true);
    expect(shouldShowFoundRun({ found: found("partial", STAMP, { failed: 2 }), nowMs: now + FINISHED_RUN_SHOWN_MS, hiddenRunIds: none })).toBe(true);
    expect(shouldShowFoundRun({ found: found("partial", STAMP, { failed: 2 }), nowMs: now + FINISHED_RUN_SHOWN_MS + 1, hiddenRunIds: none })).toBe(false);
    expect(shouldShowFoundRun({ found: found("completed", STAMP, { completed: 5 }), nowMs: now, hiddenRunIds: none })).toBe(false);
    expect(shouldShowFoundRun({ found: found("partial", STAMP, { failed: 2 }), nowMs: now, hiddenRunIds: new Set([7]) })).toBe(false);
    expect(shouldShowFoundRun({ found: found("processing", null, {}), nowMs: now, hiddenRunIds: new Set([7]) })).toBe(false);
    expect(shouldShowFoundRun({ found: null, nowMs: now, hiddenRunIds: none })).toBe(false);
    expect(hiddenRunStorageKey(7)).toBe("dropship-publish-run-hidden:7");
  });

  it("DUX8 words a left-out size by the run's scope", () => {
    expect(runSnapshotDiffWords("not_live", 2)).toBe(PUBLISH_WORDS.runSnapshotDiffNew(2));
    expect(runSnapshotDiffWords("all", 2)).toBe(PUBLISH_WORDS.runSnapshotDiff(2));
  });
});

describe("verify round (step 1 plan S2-5, PR A)", () => {
  it("VC4 gives every read's internal error the short budget, the catalog reads' too", () => {
    for (const code of ["DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR", "DROPSHIP_LISTING_PUSH_RUN_INTERNAL_ERROR"]) {
      const internal = apiError(500, code);
      expect(isInternalServerError(internal), code).toBe(true);
      expect(retryPublishRead(PUBLISH_READ_INTERNAL_MAX_RETRIES - 1, internal), code).toBe(true);
      expect(retryPublishRead(PUBLISH_READ_INTERNAL_MAX_RETRIES, internal), code).toBe(false);
      expect(runReadCanRecover(internal), code).toBe(false);
    }
    // A 5xx without the code keeps the long schedule: it is a passing failure (a proxy, a restart).
    expect(isInternalServerError(apiError(502))).toBe(false);
    expect(retryPublishRead(PUBLISH_READ_INTERNAL_MAX_RETRIES, apiError(502))).toBe(true);
    expect(isInternalServerError(new Error("DROPSHIP_X_INTERNAL_ERROR"))).toBe(false);
  });

  it("VC6 reads the create limiter's 429 as 'wait a minute', in the server's words, never sent again at once", () => {
    expect(classifyRunCreateError(apiError(429, LISTING_PUSH_RUN_ERROR_CODES.rateLimited), "not_live"))
      .toEqual({ kind: "rateLimited", message: PUBLISH_WORDS.runRateLimited });
    expect(classifyRunCreateError(apiError(429), "all")).toEqual({ kind: "rateLimited", message: PUBLISH_WORDS.runRateLimited });
    // Reads stay transient on a 429: they are read again on the poll's schedule.
    expect(retryPublishRead(0, apiError(429, LISTING_PUSH_RUN_ERROR_CODES.rateLimited))).toBe(true);
  });

  it("VC8 never shows the worker's raw error text, or a product id's operator words, as a reason", () => {
    const problem = (code: string, message: string): ListingPushRunProblem => ({ productVariantId: 101, productId: 11, productName: "P",
      variantName: "S", sku: "X", outcome: "failed", code, message, retryable: true });
    const raw = describeRunProblem(problem("DROPSHIP_LISTING_PUSH_FAILED", "duplicate key value violates unique constraint \"x\""));
    expect(raw).toMatchObject({ reason: PUBLISH_WORDS.failedRow, nextStep: null });
    expect(raw.reason).not.toContain("duplicate");
    for (const code of ["DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE", "DROPSHIP_ALLOCATION_UNAVAILABLE"]) {
      expect(describeRunProblem(problem(code, "The canonical Dropship channel quantity could not be resolved for product 11: no rows")), code)
        .toMatchObject({ reason: PUBLISH_WORDS.stockUnreadRow, nextStep: PUBLISH_WORDS.retryStep });
    }
  });

  // Rebase of PR A onto PR 1b: the run card's rows read the listing push notice's refusal words
  // (listingPushRefusalWords), with steps that say "publish again".
  it("words the stock gate's and the eBay account check's refusals with PR 1b's words, and a publish step", () => {
    const problem = (overrides: Partial<ListingPushRunProblem>): ListingPushRunProblem => ({ productVariantId: 101, productId: 11,
      productName: "P", variantName: "S", sku: "X", outcome: "failed", code: null, message: null, retryable: false, ...overrides });
    const pushItem = (overrides: Partial<ListingPushRunProblem>) => {
      const p = problem(overrides);
      return { errorCode: p.code, errorMessage: p.message, retryable: p.retryable };
    };
    const unmapped = { code: "PUBLICATION_LISTING_TARGET_UNMAPPED", message: "Publication listing target is not mapped.", retryable: false };
    expect(describeRunProblem(problem(unmapped), "marz_cards")).toMatchObject({
      reason: listingPushRefusalWords(pushItem(unmapped), "marz_cards")!.reason, nextStep: PUBLISH_WORDS.stockSetupStep });
    const busy = { code: "PUBLICATION_SCOPE_BUSY", message: "Publication scope is busy.", retryable: true };
    expect(describeRunProblem(problem(busy))).toMatchObject({
      reason: listingPushRefusalWords(pushItem(busy), null)!.reason, nextStep: PUBLISH_WORDS.retryStep });
    // A stock-gate code no table names: 1b's general words, the step by the server's class.
    const other = { code: "PUBLICATION_SOMETHING_NEW", message: "operator text", retryable: false };
    expect(describeRunProblem(problem(other))).toMatchObject({ reason: "Card Shellz's stock check stopped this listing update.",
      nextStep: PUBLISH_WORDS.stockSetupStep });
    const account = { code: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, message: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_MESSAGE, retryable: false };
    expect(describeRunProblem(problem(account), "Marz Cards")).toEqual(expect.objectContaining({
      reason: "Card Shellz could not confirm Marz Cards's eBay account for this listing.",
      nextStep: "Publish again. If it fails the same way, choose Reconnect Marz Cards in Settings first, then publish again." }));
    // No name of its own: the words name the button, never a placeholder (1b P2-R6).
    expect(describeRunProblem(problem(account), null).nextStep).toBe(PUBLISH_WORDS.accountCheckStep(null));
    expect(PUBLISH_WORDS.accountCheckStep(null)).toContain("the store's Reconnect button");
    expect(describeRunProblem(problem({ code: "PUBLICATION_PROVIDER_ACCOUNT_UNVERIFIED", message: "x" }), "Marz Cards").nextStep)
      .toBe(PUBLISH_WORDS.accountCheckStep("Marz Cards"));
    // The other eBay site: 1b's reason as a sentence.
    const site = describeRunProblem(problem({ code: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, message: EBAY_PUBLICATION_ENVIRONMENT_MISMATCH_MESSAGE }));
    expect(site).toMatchObject({ nextStep: PUBLISH_WORDS.ebaySiteStep });
    expect(site.reason).toMatch(/^The listing already on eBay belongs to a different eBay site/);
    // An account code with a message the client does not know keeps the server's text, as the push notice does.
    expect(describeRunProblem(problem({ code: EBAY_PUBLICATION_ACCOUNT_UNVERIFIED_CODE, message: "Some new text.", retryable: true })))
      .toMatchObject({ reason: "Some new text.", nextStep: PUBLISH_WORDS.retryStep });
    // PR A's own run words still win for the codes it names (priorOutcome, cooldown).
    expect(describeRunProblem(problem({ code: "PUBLICATION_PROVIDER_COOLDOWN", retryable: true }))).toMatchObject({ reason: PUBLISH_WORDS.cooldownRow });
    for (const words of [PUBLISH_WORDS.accountCheckStep("Marz Cards"), PUBLISH_WORDS.accountCheckStep(null), PUBLISH_WORDS.ebaySiteStep,
      PUBLISH_WORDS.stockSetupStep]) {
      expect(words).not.toMatch(/queue/i);
    }
  });

  // Merge review ADV-RB-2: 1b words "Card Shellz paused stock updates" with "later", not "in a few minutes".
  it("tells the vendor to publish again later, not in a few minutes, when Card Shellz paused stock updates", () => {
    for (const code of ["QUANTITY_PUBLICATION_SUPPRESSED", "PUBLICATION_GLOBAL_STOP_ACTIVE"]) {
      // The server retries these (classifyStockGateRefusal: transient), so the row's step does not come from `retryable`.
      const row = describeRunProblem({ productVariantId: 101, productId: 11, productName: "P", variantName: "S", sku: "X",
        outcome: "failed", code, message: "Quantity publication is suppressed for this scope.", retryable: true });
      expect(row, code).toEqual({ productVariantId: 101, name: "P · S · X", reason: "Card Shellz has paused stock updates for now.",
        nextStep: PUBLISH_WORDS.pausedStockStep });
      expect(row.nextStep, code).not.toMatch(/few minutes|queue/i);
    }
    expect(isPausedStockRefusal("QUANTITY_PUBLICATION_SUPPRESSED")).toBe(true);
    // Busy stock work does clear in a few minutes; codes outside 1b's table are not paused ones.
    for (const code of ["PUBLICATION_SCOPE_BUSY", "PUBLICATION_SOMETHING_NEW", "toString", null]) {
      expect(isPausedStockRefusal(code), String(code)).toBe(false);
    }
    expect(describeRunProblem({ productVariantId: 101, productId: 11, productName: "P", variantName: "S", sku: "X", outcome: "failed",
      code: "PUBLICATION_SCOPE_BUSY", message: "busy", retryable: true }).nextStep).toBe(PUBLISH_WORDS.retryStep);
  });

  // Merge review ADV-1: since #1873 an eBay connector refusal keeps its own EBAY_ code and its message for channel staff.
  it("never shows the eBay connector's own message: support's check when it cannot be retried, the failed words otherwise", () => {
    const problem = (code: string, message: string, retryable: boolean | null): ListingPushRunProblem => ({ productVariantId: 101,
      productId: 11, productName: "P", variantName: "S", sku: "X", outcome: "failed", code, message, retryable });
    // The connector's own messages (ebay-listing.connector.ts pushListing).
    const mapping = "Existing published eBay offers require a complete provider listing identity check before any further write. Use the listing's Sync or reviewed recovery action.";
    const permanent = describeRunProblem(problem("EBAY_SYNC_MAPPING_INVALID", mapping, false));
    expect(permanent).toMatchObject({ reason: PUBLISH_WORDS.ebayCheckRow, nextStep: PUBLISH_WORDS.ebayCheckStep });
    const identity = describeRunProblem(problem("EBAY_SYNC_IDENTITY_CHANGED",
      "The discovered eBay publication does not match this product's exact offers and listing shape. Review its complete mapping before publishing.", false));
    expect(identity).toMatchObject({ reason: PUBLISH_WORDS.ebayCheckRow, nextStep: PUBLISH_WORDS.ebayCheckStep });
    const limited = "eBay is limiting listing identity checks. Wait before checking again.";
    for (const retryable of [true, null]) {
      expect(describeRunProblem(problem("EBAY_PROVIDER_RATE_LIMITED", limited, retryable)), String(retryable))
        .toMatchObject({ reason: PUBLISH_WORDS.failedRow, nextStep: null });
    }
    for (const row of [permanent, identity, describeRunProblem(problem("EBAY_PROVIDER_RATE_LIMITED", limited, true))]) {
      const shown = `${row.reason} ${row.nextStep ?? ""}`;
      for (const operatorText of ["Sync or reviewed recovery", "complete mapping", "Wait before checking"]) expect(shown).not.toContain(operatorText);
      expect(shown).not.toMatch(/queue|EBAY_/i);
    }
    // Card Shellz's own eBay codes start DROPSHIP_ and keep their words.
    expect(describeRunProblem(problem("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "eBay said: title too long", false)))
      .toMatchObject({ reason: "eBay said: title too long", nextStep: PUBLISH_WORDS.ebayFixStep });
  });

  // Rebase of PR A onto Fix PR 2a: the automatic stock link's refusals reach the run card. The reason is 2a's shared
  // vendor words; the step is 2a's next step for "publish". A run's chunk is never re-queued by the push sweep
  // (stockLinkCandidateSql: run_id null), so no row promises an automatic retry.
  it("words every automatic stock link refusal with 2a's shared reason and a publish step, never an automatic retry", () => {
    const row = (code: string, retryable: boolean): ReturnType<typeof describeRunProblem> => describeRunProblem({ productVariantId: 101,
      productId: 11, productName: "P", variantName: "S", sku: "X", outcome: "failed", code,
      // The server's message for these codes is the reason in sentence case (dropshipStockLinkServerMessage).
      message: dropshipStockLinkServerMessage(code as DropshipStockLinkRefusalCode), retryable }, "Marz Cards");
    // Whether the server retries each one (domain/stock-link-readiness STOCK_LINK_REFUSAL_POLICY): only these two.
    const transient = new Set(["DROPSHIP_STOCK_UPDATES_PAUSED", "DROPSHIP_STOCK_LINK_BUSY"]);
    expect(DROPSHIP_STOCK_LINK_REFUSAL_CODES.filter((code) => STOCK_LINK_REFUSAL_POLICY[code].retryable)).toEqual([...transient]);
    const steps: Record<string, string | null> = {
      DROPSHIP_STOCK_DESTINATION_NOT_READY: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_DESTINATION_DUPLICATED: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_ITEM_NOT_READY: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_STORE_ON_HOLD: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_ITEM_ON_HOLD: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED: "Choose Reconnect Marz Cards in Settings, then publish again.",
      DROPSHIP_STOCK_SKU_LINK_CONFLICT: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_ITEM_LINKED_TO_OTHER_SKU: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_SKU_CHANGED: null,
      DROPSHIP_STOCK_LINK_CHANGED: "Publish again. Contact Card Shellz support with this message if it fails the same way.",
      DROPSHIP_STOCK_NOT_OFFERED: "Check that the item is still in your selection in step 1 and your store isn't paused, then publish again.",
      DROPSHIP_STOCK_MODE_NOT_MANAGED: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_UPDATES_PAUSED: PUBLISH_WORDS.pausedStockStep,
      DROPSHIP_STOCK_LINK_BUSY: PUBLISH_WORDS.retryStep,
      DROPSHIP_STOCK_LINK_FAILED: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_READINESS_REQUIRED: PUBLISH_WORDS.stockSetupStep,
      DROPSHIP_STOCK_RESEND_LISTING_FOUND: PUBLISH_WORDS.listingFoundStep,
    };
    expect(Object.keys(steps).sort()).toEqual([...DROPSHIP_STOCK_LINK_REFUSAL_CODES].sort());
    for (const code of DROPSHIP_STOCK_LINK_REFUSAL_CODES) {
      const described = row(code, transient.has(code));
      // The item's SKU or details changed after the press: PR A's own words for a size that changed while publishing.
      const reason = code === "DROPSHIP_STOCK_SKU_CHANGED" ? PUBLISH_WORDS.staleRow : dropshipStockLinkServerMessage(code);
      expect(described, code).toEqual({ productVariantId: 101, name: "P · S · X", reason, nextStep: steps[code] });
      const shown = `${described.reason} ${described.nextStep ?? ""}`;
      expect(shown, code).not.toMatch(/queue|DROPSHIP_/i);
      // A run item has no automatic retry coming, so neither transient row says one is.
      if (transient.has(code)) expect(shown, code).not.toMatch(/automatic/i);
    }
    // 2a's words say the transient retry is automatic; the run card says what the vendor does instead.
    expect(DROPSHIP_STOCK_LINK_REFUSAL_WORDS.DROPSHIP_STOCK_LINK_BUSY.nextStep).toMatch(/automatically/);
    // PUBLICATION_SCOPE_BUSY, the third code the sweep re-queues for a job outside a run, keeps PR 1b's reason and the retry step.
    const scopeBusy = describeRunProblem({ productVariantId: 101, productId: 11, productName: "P", variantName: "S", sku: "X",
      outcome: "failed", code: "PUBLICATION_SCOPE_BUSY", message: "Publication scope is busy.", retryable: true });
    expect(scopeBusy).toMatchObject({ reason: "Card Shellz was busy updating stock for this listing.", nextStep: PUBLISH_WORDS.retryStep });
    // Without a store name of its own the reconnect step names the button (PR 1b P2-R6).
    expect(describeRunProblem({ productVariantId: 101, productId: 11, productName: "P", variantName: "S", sku: "X", outcome: "failed",
      code: "DROPSHIP_STOCK_STORE_ACCOUNT_UNVERIFIED", message: "x", retryable: false }, null).nextStep)
      .toBe("Choose the store's Reconnect button in Settings, then publish again.");
  });

  it("VC11 sends again after a JSON answer cut short (the request reached the server), like no answer", () => {
    expect(isTransientPublishError(new SyntaxError("Unexpected end of JSON input"))).toBe(true);
    expect(classifyRunCreateError(new SyntaxError("Unexpected end of JSON input"), "all")).toEqual({ kind: "transient" });
  });

  it("VC12 colours a finished run by its problems: skipped sizes are no problem; drafts are amber; problems with nothing published are rose", () => {
    expect(describeRun(run({ status: "partial" }), counts({ completed: 10, skipped: 2 }), "s")).toMatchObject({ phase: "finished" });
    expect(describeRun(run({ status: "failed" }), counts({ skipped: 3 }), "s")).toMatchObject({ phase: "finished", title: PUBLISH_WORDS.runFinished });
    expect(describeRun(run({ status: "completed" }), counts({ completed: 10, skipped: 2 }), "s", { drafts: 1 })).toMatchObject({ phase: "finishedPartial" });
    expect(describeRun(run({ status: "partial" }), counts({ completed: 10, failed: 1 }), "s")).toMatchObject({ phase: "finishedPartial" });
    expect(describeRun(run({ status: "failed" }), counts({ skipped: 2, stale: 1 }), "s")).toMatchObject({ phase: "finishedNothing",
      title: PUBLISH_WORDS.runNothingPublished });
  });

  it("VC13 says 'was' when one size was done before a stop or eBay's outage", () => {
    expect(describeRun(run({ status: "cancelled", stopReason: "vendor_stop", targetCount: 1 }), counts({ completed: 1 }), "s").title)
      .toBe("Publishing stopped. 1 of 1 was done before you stopped.");
    expect(describeRun(run({ status: "failed", stopReason: "provider_unavailable", targetCount: 600 }), counts({ completed: 1, failed: 599 }), "s").title)
      .toBe("eBay wasn't answering, so publishing stopped. 1 of 600 was done. Publish again later.");
  });

  it("VC15 keeps a hide only while it matters: stored with its time, dropped after the week or when unreadable", () => {
    const now = Date.parse(STAMP);
    expect(hiddenRunIdFromStorageKey(hiddenRunStorageKey(7))).toBe(7);
    for (const key of [null, "other:7", "dropship-publish-run-hidden:", "dropship-publish-run-hidden:x", "dropship-publish-run-hidden:-1"]) {
      expect(hiddenRunIdFromStorageKey(key), String(key)).toBeNull();
    }
    expect(hiddenRunExpired(String(now - 60_000), now)).toBe(false);
    expect(hiddenRunExpired(String(now - FINISHED_RUN_SHOWN_MS), now)).toBe(false);
    expect(hiddenRunExpired(String(now - FINISHED_RUN_SHOWN_MS - 1), now)).toBe(true);
    for (const value of [null, "1x", "", "not a time"]) expect(hiddenRunExpired(value, now), String(value)).toBe(true);
  });
});

describe("the optional Check (D15)", () => {
  it("chunks ids 200 at a time in order: 1,234 sizes are 7 previews", () => {
    const ids = Array.from({ length: 1_234 }, (_, index) => index + 1);
    const chunks = chunkIds(ids);
    expect(chunks).toHaveLength(7);
    expect(chunks.map((chunk) => chunk.length)).toEqual([200, 200, 200, 200, 200, 200, 34]);
    expect(chunks.flat()).toEqual(ids);
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
    expect(() => chunkIds([1], 0)).toThrow();
  });

  it("keeps every field step 3's table reads and drops the listing's presentation", () => {
    const row = {
      productVariantId: 101, productId: 11, sku: "ENV-SGL-P50", title: "Envelope", platform: "ebay", listingMode: "create",
      currentListingStatus: "not_listed", previewStatus: "ready", blockers: [], warnings: [], marketplaceQuantity: 25, priceCents: 699,
      marketplaceCategoryId: "183435", marketplaceCategoryName: "Card Sleeves", storeCategoryNames: [], businessPolicySelection: null,
      previewHash: "d".repeat(64), priceSettingRevisionId: null, contentEvidenceHash: "c".repeat(64),
      presentation: { source: "catalog_fallback", title: "Envelope", descriptionText: "x".repeat(20_000), productName: "Envelope", variantName: "Pack",
        unitsPerVariant: 50, brand: null, condition: null, itemSpecifics: [], images: [], issues: [] },
    } as unknown as DropshipListingPreviewRow;
    const light = toCheckRow(row);
    expect(light).not.toHaveProperty("presentation");
    expect(light).toMatchObject({ productVariantId: 101, title: "Envelope", sku: "ENV-SGL-P50", previewStatus: "ready", priceCents: 699, marketplaceQuantity: 25 });
    // The answer schema drops unknown fields too (the worker-only listing intent never reaches here, but would go).
    const parsed = checkPreviewAnswerSchema.parse({ preview: { vendorId: 1, storeConnectionId: 5, platform: "ebay", generatedAt: STAMP,
      rows: [{ ...row, listingIntent: { secret: true } }], summary: { total: 1, ready: 1, blocked: 0, warning: 0 } } });
    expect(parsed.preview.rows[0]).not.toHaveProperty("listingIntent");
    expect(parsed.preview.rows[0]).not.toHaveProperty("presentation");
  });

  it("sums the chunks and builds one preview result for the store and revision it was made for", () => {
    const rows = (["ready", "ready", "warning", "blocked"] as const).map((previewStatus, index) => toCheckRow({
      productVariantId: index + 1, productId: 1, sku: null, title: "T", platform: "ebay", listingMode: null, currentListingStatus: "not_listed",
      previewStatus, blockers: [], warnings: [], marketplaceQuantity: 0, priceCents: null, marketplaceCategoryId: null,
      marketplaceCategoryName: null, storeCategoryNames: [], businessPolicySelection: null, previewHash: "h",
    }));
    expect(sumCheck(rows)).toEqual({ total: 4, ready: 2, warnings: 1, blocked: 1 });
    expect(PUBLISH_WORDS.checkSummary(4, 2, 1, 1)).toBe("Checked 4: 2 ready · 1 with warnings · 1 not ready");
    const result = checkResult({ contextKey: checkContextKey(5, 3), vendorId: 1, storeConnectionId: 5, platform: "ebay", generatedAt: STAMP, rows });
    expect(result.contextKey).toBe("5:3");
    expect(result.preview.summary).toEqual({ total: 4, ready: 2, blocked: 1, warning: 1 });
    expect(result.preview.rows).toHaveLength(4);
    expect(checkContextKey(5, null)).toBe("5:none");
  });
});

describe("Selected items (server-paged)", () => {
  function page(pageNumber: number, ids: number[], total: number): SelectedListPage {
    return { rows: ids.map((id) => ({ productVariantId: id, productName: "P", variantName: "V", variantSku: null, selectionDecision: { marketplaceQuantity: 1 } })),
      total, page: pageNumber, limit: 200, summary: { matching: total, matchingSelected: total } };
  }

  it("requires the summary, so a stage 1 server's answer is not taken for this one's (CHK7)", () => {
    const stageOne = { rows: [], total: 0, page: 1, limit: 200, facets: { categories: [], productLines: [], products: [] } };
    expect(selectedListPageSchema.safeParse(stageOne).success).toBe(false);
    expect(selectedListPageSchema.safeParse({ ...stageOne, summary: { matching: 0, matchingSelected: 0 } }).success).toBe(true);
  });

  it("pages 200 at a time, stops at the total, a short page or 1,000 shown, and merges by size", () => {
    const first = page(1, Array.from({ length: 200 }, (_, index) => index + 1), 1_500);
    expect(selectedListNextPage(first, [first])).toBe(2);
    const short = page(2, [201], 1_500);
    expect(selectedListNextPage(short, [first, short])).toBeUndefined();
    const pages = Array.from({ length: 5 }, (_, index) => page(index + 1, Array.from({ length: 200 }, (__, row) => index * 200 + row + 1), 1_500));
    expect(selectedListNextPage(pages[4], pages)).toBeUndefined();
    expect(mergeSelectedPages(pages).rows).toHaveLength(SELECTED_LIST_MAX_ROWS);
    const last = page(1, [1, 2], 2);
    expect(selectedListNextPage({ ...last, limit: 2 }, [{ ...last, limit: 2 }])).toBeUndefined();
    // A size on two pages (the order shifted between reads) shows once.
    expect(mergeSelectedPages([page(1, [1, 2], 3), page(2, [2, 3], 3)]).rows.map((row) => row.productVariantId)).toEqual([1, 2, 3]);
    expect(mergeSelectedPages([])).toEqual({ rows: [], total: 0 });
  });
});
