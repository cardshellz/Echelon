import { describe, expect, it } from "vitest";
import { z } from "zod";
import { emptyListingPushRunCounts } from "../../../../../shared/dropship/listing-push-runs";
import { DropshipError } from "../../domain/errors";
import {
  LISTING_PUSH_RUN_CODES,
  MAX_ITEM_TRANSIENT_PAUSES,
  MAX_JOB_CONSECUTIVE_PAUSES,
  PUSH_PAUSE_BACKOFF_MS,
  RESERVED_JOB_KEY_PREFIX,
  RUN_UNREQUEUED_STOCK_LINK_CODES,
  RUN_CHUNK_SIZE,
  assignListingPushRunChunks,
  classifyChunkExpansionError,
  countListingPushRunTargets,
  decideListingPushPauseAction,
  decideListingPushRunFinish,
  decideListingPushRunPrefilter,
  decideListingPushTransientPause,
  hashListingPushRunRequest,
  isDefiniteMarketplaceAnswer,
  isItemInFlightAtStop,
  isLiveListing,
  isReservedListingPushJobKey,
  isSelectionBlocker,
  itemTransientPauses,
  listingPushRunChunkCount,
  listingPushRunChunkJobKey,
  listingPushRunProblemCount,
  pushPauseBackoffMs,
  runTargetOutcomeForItem,
} from "../../domain/listing-push-run";
import { RUN_NOTICE_SHIP_FROM_REASON, describeListingPushRunProblems, runNoticeProblemReason } from "../../domain/listing-push-run-words";
import { AUTOMATIC_REQUEUE_CODES, STOCK_LINK_RESEND_CODE } from "../../domain/listing-push-automatic-requeue";

describe("publish run chunks", () => {
  it("puts each size in exactly one chunk of 500, in ascending id order: chunk = floor(rank / 500)", () => {
    const ids = Array.from({ length: 1_234 }, (_, index) => 5_000 - index * 3);
    const chunks = assignListingPushRunChunks(ids);
    expect(chunks).toHaveLength(1_234);
    expect(new Set(chunks.map((row) => row.productVariantId)).size).toBe(1_234);
    const sorted = [...ids].sort((left, right) => left - right);
    chunks.forEach((row, rank) => {
      expect(row.productVariantId).toBe(sorted[rank]);
      expect(row.chunkIndex).toBe(Math.floor(rank / RUN_CHUNK_SIZE));
    });
    expect(chunks.filter((row) => row.chunkIndex === 2)).toHaveLength(234);
    expect(listingPushRunChunkCount(1_234)).toBe(3);
    expect(listingPushRunChunkCount(500)).toBe(1);
    expect(listingPushRunChunkCount(501)).toBe(2);
    expect(listingPushRunChunkCount(10_000)).toBe(20);
  });

  it("refuses a size twice and an empty run", () => {
    expect(() => assignListingPushRunChunks([7, 8, 7])).toThrow("distinct");
    expect(() => listingPushRunChunkCount(0)).toThrow();
  });
});

describe("publish run keys and identity", () => {
  it("names each chunk's job with the reserved prefix, unique per vendor, run and chunk", () => {
    expect(listingPushRunChunkJobKey({ vendorId: 10, runId: 77, chunkIndex: 3 })).toBe("dropship-run:10:77:3");
    expect(RESERVED_JOB_KEY_PREFIX).toBe("dropship-run:");
    expect(isReservedListingPushJobKey("dropship-run:10:77:3")).toBe(true);
    expect(isReservedListingPushJobKey("  dropship-run:anything")).toBe(true);
    expect(isReservedListingPushJobKey("listing-push-0001")).toBe(false);
    expect(isReservedListingPushJobKey("my-dropship-run:1")).toBe(false);
  });

  it("hashes the request from vendor, store, scope and expected revision only", () => {
    const base = { vendorId: 10, storeConnectionId: 22, scope: "not_live" as const, expectedSelectionRevisionId: 5 };
    const hash = hashListingPushRunRequest(base);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashListingPushRunRequest({ ...base })).toBe(hash);
    expect(hashListingPushRunRequest({ ...base, scope: "all" })).not.toBe(hash);
    expect(hashListingPushRunRequest({ ...base, storeConnectionId: 23 })).not.toBe(hash);
    expect(hashListingPushRunRequest({ ...base, expectedSelectionRevisionId: null })).not.toBe(hash);
    expect(hashListingPushRunRequest({ ...base, vendorId: 11 })).not.toBe(hash);
  });

  it("counts a listing as live with a live status and a listing id", () => {
    expect(isLiveListing({ status: "active", externalListingId: "123" })).toBe(true);
    expect(isLiveListing({ status: "paused", externalListingId: "123" })).toBe(true);
    expect(isLiveListing({ status: "drift_detected", externalListingId: "123" })).toBe(true);
    for (const status of ["queued", "pushing", "failed", "blocked", "ended", "not_listed", "preview_ready"]) {
      expect(isLiveListing({ status, externalListingId: "123" })).toBe(false);
    }
    expect(isLiveListing({ status: "active", externalListingId: null })).toBe(false);
    expect(isLiveListing({ status: "active", externalListingId: "  " })).toBe(false);
    expect(isLiveListing(null)).toBe(false);
  });
});

describe("publish run outcomes", () => {
  it("maps every job item state to a target outcome", () => {
    expect(runTargetOutcomeForItem({ status: "queued", errorCode: null })).toBe("queued");
    expect(runTargetOutcomeForItem({ status: "processing", errorCode: null })).toBe("queued");
    expect(runTargetOutcomeForItem({ status: "completed", errorCode: null })).toBe("completed");
    expect(runTargetOutcomeForItem({ status: "blocked", errorCode: "DROPSHIP_LISTING_PREVIEW_BLOCKED" })).toBe("blocked");
    expect(runTargetOutcomeForItem({ status: "blocked", errorCode: "DROPSHIP_LISTING_NOT_SELECTED" })).toBe("skipped");
    expect(runTargetOutcomeForItem({ status: "failed", errorCode: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" })).toBe("failed");
    expect(runTargetOutcomeForItem({ status: "failed", errorCode: "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW" })).toBe("price_review");
    expect(runTargetOutcomeForItem({ status: "cancelled", errorCode: "DROPSHIP_LISTING_PUSH_RUN_STOPPED" })).toBe("cancelled");
    expect(() => runTargetOutcomeForItem({ status: "exploded", errorCode: null })).toThrow();
  });

  it("finishes a run only when nothing is pending or queued", () => {
    const counts = (overrides: Partial<ReturnType<typeof emptyListingPushRunCounts>>) => ({ ...emptyListingPushRunCounts(), ...overrides });
    expect(decideListingPushRunFinish({ counts: counts({ completed: 3, pending: 1 }), cancelRequested: false })).toBeNull();
    expect(decideListingPushRunFinish({ counts: counts({ completed: 3, queued: 1 }), cancelRequested: true })).toBeNull();
    expect(decideListingPushRunFinish({ counts: counts({ completed: 3 }), cancelRequested: false })).toBe("completed");
    expect(decideListingPushRunFinish({ counts: counts({ completed: 2, failed: 1 }), cancelRequested: false })).toBe("partial");
    // A skipped size is no problem (verify V10): a run that published everything it had to send is completed.
    expect(decideListingPushRunFinish({ counts: counts({ completed: 2, skipped: 1 }), cancelRequested: false })).toBe("completed");
    expect(decideListingPushRunFinish({ counts: counts({ completed: 2, skipped: 1, stale: 1 }), cancelRequested: false })).toBe("partial");
    expect(decideListingPushRunFinish({ counts: counts({ completed: 1, price_review: 1 }), cancelRequested: false })).toBe("partial");
    expect(decideListingPushRunFinish({ counts: counts({ failed: 2, blocked: 1 }), cancelRequested: false })).toBe("failed");
    expect(decideListingPushRunFinish({ counts: counts({ skipped: 2, failed: 1 }), cancelRequested: false })).toBe("failed");
    // Every size left out on purpose: nothing had to be sent, and nothing went wrong.
    expect(decideListingPushRunFinish({ counts: counts({ skipped: 3 }), cancelRequested: false })).toBe("completed");
    expect(decideListingPushRunFinish({ counts: counts({ completed: 3, cancelled: 4 }), cancelRequested: true })).toBe("cancelled");
    expect(decideListingPushRunFinish({ counts: counts({ completed: 3 }), cancelRequested: true })).toBe("cancelled");
  });

  it("counts outcomes from grouped rows and refuses unknown ones", () => {
    expect(countListingPushRunTargets([{ outcome: "completed", count: 3 }, { outcome: "price_review", count: 2 }]))
      .toEqual({ ...emptyListingPushRunCounts(), completed: 3, price_review: 2 });
    expect(() => countListingPushRunTargets([{ outcome: "lost", count: 1 }])).toThrow();
    expect(() => countListingPushRunTargets([{ outcome: "failed", count: -1 }])).toThrow();
    expect(listingPushRunProblemCount({ ...emptyListingPushRunCounts(), failed: 1, blocked: 2, price_review: 3, stale: 4, skipped: 9, cancelled: 9 }))
      .toBe(10);
  });

  it("words the run's email by its counts and why it stopped", () => {
    expect(describeListingPushRunProblems({ problemCount: 3, targetCount: 1_200, stopReason: null }))
      .toBe("3 of 1,200 listings didn't publish to your eBay store. Catalog step 3 shows each one and why.");
    expect(describeListingPushRunProblems({ problemCount: 1, targetCount: 1, stopReason: "provider_unavailable" }))
      .toBe("1 of 1 listing didn't publish to your eBay store. eBay wasn't answering, so publishing stopped. Publish again later. Catalog step 3 shows each one and why.");
    expect(describeListingPushRunProblems({ problemCount: 2, targetCount: 10, stopReason: "vendor_stop" })).toContain("You stopped publishing.");
    // A failure the vendor fixes keeps its step in the email (review round 2 DUX5); the rest stay coarse.
    expect(runNoticeProblemReason({ outcome: "failed", code: "DROPSHIP_EBAY_MANAGED_LOCATION_CONFIG_MISMATCH" })).toBe(RUN_NOTICE_SHIP_FROM_REASON);
    expect(RUN_NOTICE_SHIP_FROM_REASON).not.toMatch(/queue/i);
    expect(runNoticeProblemReason({ outcome: "failed", code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR" })).toBe("It couldn't be sent.");
  });
});

describe("pauses and breakers", () => {
  const httpError = (status: number, method: string, retryable = true) =>
    new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", `HTTP ${status}`, { status, method, retryable, endpoint: `${method} /x` });

  it("pauses only when the marketplace did nothing", () => {
    expect(decideListingPushTransientPause(httpError(429, "PUT"))).toEqual({ pause: true, reason: "rate_limited" });
    expect(decideListingPushTransientPause(httpError(429, "GET"))).toEqual({ pause: true, reason: "rate_limited" });
    expect(decideListingPushTransientPause(httpError(401, "POST"))).toEqual({ pause: true, reason: "token_rejected" });
    expect(decideListingPushTransientPause(httpError(403, "PUT"))).toEqual({ pause: true, reason: "token_rejected" });
    expect(decideListingPushTransientPause(httpError(503, "GET"))).toEqual({ pause: true, reason: "read_unavailable" });
    expect(decideListingPushTransientPause(new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_NETWORK_ERROR", "no answer",
      { network: true, method: "GET", retryable: true }))).toEqual({ pause: true, reason: "read_unanswered" });
    // A write with an unknown outcome keeps failing retryable (the connector checks identity first next time).
    expect(decideListingPushTransientPause(httpError(503, "PUT"))).toEqual({ pause: false });
    expect(decideListingPushTransientPause(new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_NETWORK_ERROR", "no answer",
      { network: true, method: "POST", retryable: true }))).toEqual({ pause: false });
    expect(decideListingPushTransientPause(httpError(400, "GET"))).toEqual({ pause: false });
    expect(decideListingPushTransientPause(httpError(403, "GET", false))).toEqual({ pause: false });
    expect(decideListingPushTransientPause(new Error("socket hang up"))).toEqual({ pause: false });
    expect(decideListingPushTransientPause(new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", "no status", { method: "GET" })))
      .toEqual({ pause: false });
  });

  it("backs off 1, 2, 5, 15 and then 30 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(pushPauseBackoffMs)).toEqual([60_000, 120_000, 300_000, 900_000, 1_800_000, 1_800_000, 1_800_000]);
    expect(PUSH_PAUSE_BACKOFF_MS.slice(0, 5).reduce((sum, value) => sum + value, 0) + 1_800_000).toBe(83 * 60_000);
    expect(() => pushPauseBackoffMs(0)).toThrow();
  });

  it("trips the job breaker after six pauses in a row, fails an item after five of its own, otherwise pauses", () => {
    expect(MAX_ITEM_TRANSIENT_PAUSES).toBe(5);
    expect(MAX_JOB_CONSECUTIVE_PAUSES).toBe(6);
    expect(decideListingPushPauseAction({ itemPauses: 0, jobConsecutivePauses: 0 })).toEqual({ action: "pause" });
    expect(decideListingPushPauseAction({ itemPauses: 4, jobConsecutivePauses: 5 })).toEqual({ action: "pause" });
    expect(decideListingPushPauseAction({ itemPauses: 5, jobConsecutivePauses: 5 })).toEqual({ action: "fail_item" });
    expect(decideListingPushPauseAction({ itemPauses: 0, jobConsecutivePauses: 6 })).toEqual({ action: "trip_job_breaker" });
    expect(decideListingPushPauseAction({ itemPauses: 9, jobConsecutivePauses: 9 })).toEqual({ action: "trip_job_breaker" });
    expect(itemTransientPauses({ transientPauses: 3 })).toBe(3);
    expect(itemTransientPauses({ transientPauses: "3" })).toBe(0);
    expect(itemTransientPauses(null)).toBe(0);
  });

  it("names the stock link codes the sweep re-queues outside a run and a run never does: all but the one-time re-send (merge review ADV-RB2-1)", () => {
    expect([...RUN_UNREQUEUED_STOCK_LINK_CODES]).toEqual(["DROPSHIP_STOCK_LINK_BUSY", "PUBLICATION_SCOPE_BUSY", "DROPSHIP_STOCK_UPDATES_PAUSED"]);
    expect([...RUN_UNREQUEUED_STOCK_LINK_CODES, STOCK_LINK_RESEND_CODE].sort()).toEqual([...AUTOMATIC_REQUEUE_CODES].sort());
    expect(Object.isFrozen(RUN_UNREQUEUED_STOCK_LINK_CODES)).toBe(true);
  });

  it("knows a selection refusal from the push-time refresh", () => {
    expect(isSelectionBlocker(["selection:missing_vendor_include_rule"])).toBe(true);
    expect(isSelectionBlocker(["content:missing_title", "selection:excluded_by_vendor_rule"])).toBe(true);
    expect(isSelectionBlocker(["content:missing_title"])).toBe(false);
    expect(isSelectionBlocker("selection:x")).toBe(false);
    expect(isSelectionBlocker(undefined)).toBe(false);
  });
});

describe("a definite marketplace answer ends a run of pauses (review round 2 MC4)", () => {
  const http = (status: number, method = "PUT", retryable = false) =>
    new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", `HTTP ${status}`, { status, method, retryable });

  it("is a 4xx eBay answered that no pause covers", () => {
    expect(isDefiniteMarketplaceAnswer(http(400))).toBe(true);
    expect(isDefiniteMarketplaceAnswer(http(404, "GET"))).toBe(true);
    expect(isDefiniteMarketplaceAnswer(http(403, "PUT", false))).toBe(true);
  });

  it("is never a pause, a 5xx, a failure with no answer, or an error that is not the marketplace's", () => {
    expect(isDefiniteMarketplaceAnswer(http(429))).toBe(false);
    expect(isDefiniteMarketplaceAnswer(http(401, "PUT", true))).toBe(false);
    expect(isDefiniteMarketplaceAnswer(http(500, "POST", true))).toBe(false);
    expect(isDefiniteMarketplaceAnswer(new DropshipError("DROPSHIP_EBAY_LISTING_PUSH_NETWORK_ERROR", "no answer", { network: true, method: "POST" })))
      .toBe(false);
    expect(isDefiniteMarketplaceAnswer(new DropshipError("DROPSHIP_LISTING_PREVIEW_DRIFT", "drift", {}))).toBe(false);
    expect(isDefiniteMarketplaceAnswer(new Error("HTTP 400"))).toBe(false);
  });
});

describe("an item whose last send's outcome is unknown when the vendor stops (review MC1, verify V2)", () => {
  const recovered = (recoveredAt: unknown, extra: Record<string, unknown> = {}) =>
    ({ staleRecovery: { previousStatus: "processing", status: "queued", recoveredAt }, ...extra });

  it("is one stale recovery put back with no push outcome since, whenever the recovery was (before the stop too)", () => {
    expect(isItemInFlightAtStop(recovered("2026-10-20T12:31:00.000Z"))).toBe(true);
    // Recovered before the stop, then paused (eBay busy): still unknown, still kept (verify V2).
    expect(isItemInFlightAtStop(recovered("2026-10-20T11:00:00.000Z", { transientPauses: 1, lastPause: { code: "HTTP_429" } }))).toBe(true);
    // A push outcome older than the recovery (an earlier try, then a staff retry, then the worker died) is no answer.
    expect(isItemInFlightAtStop(recovered("2026-10-20T12:00:00.000Z", { push: { status: "failed", processedAt: "2026-10-20T11:59:59.999Z" } })))
      .toBe(true);
    expect(isItemInFlightAtStop(recovered("2026-10-20T12:00:00.000Z", { push: { status: "failed", processedAt: "not a time" } }))).toBe(true);
  });

  it("is never one with an outcome recorded since the recovery, one never recovered, or one whose marker is unreadable", () => {
    expect(isItemInFlightAtStop(recovered("2026-10-20T12:00:00.000Z", { push: { status: "failed", processedAt: "2026-10-20T12:00:00.000Z" } })))
      .toBe(false);
    expect(isItemInFlightAtStop(recovered("2026-10-20T12:00:00.000Z", { push: { status: "completed", pushedAt: "2026-10-20T12:05:00.000Z" } })))
      .toBe(false);
    expect(isItemInFlightAtStop(null)).toBe(false);
    expect(isItemInFlightAtStop({})).toBe(false);
    expect(isItemInFlightAtStop({ transientPauses: 2 })).toBe(false);
    expect(isItemInFlightAtStop(recovered("not a time"))).toBe(false);
    expect(isItemInFlightAtStop(recovered(1_000))).toBe(false);
    expect(isItemInFlightAtStop({ staleRecovery: "2026-10-20T12:31:00.000Z" })).toBe(false);
    expect(isItemInFlightAtStop({ staleRecovery: [] })).toBe(false);
  });
});

describe("chunk pre-filter and expansion errors", () => {
  it("skips sizes no longer selected, and live ones for 'Publish new'; checks live moved prices", () => {
    const facts = (overrides: Partial<{ selected: boolean; live: boolean; onMarketplace: boolean; priceMovedAfterPress: boolean }>) => ({
      selected: true, live: false, onMarketplace: false, priceMovedAfterPress: false, ...overrides });
    expect(decideListingPushRunPrefilter({ scope: "all", facts: facts({ selected: false, live: true }) }))
      .toEqual({ outcome: "skipped", code: "DROPSHIP_LISTING_NOT_SELECTED" });
    expect(decideListingPushRunPrefilter({ scope: "not_live", facts: facts({ live: true }) }))
      .toEqual({ outcome: "skipped", code: "DROPSHIP_LISTING_ALREADY_LIVE" });
    expect(decideListingPushRunPrefilter({ scope: "all", facts: facts({ live: true }) })).toBeNull();
    expect(decideListingPushRunPrefilter({ scope: "all", facts: facts({ live: true, priceMovedAfterPress: true }) }))
      .toEqual({ outcome: "needs_price_check" });
    // A price input that moved on a size that is not live yet sends today's price: nothing on eBay to protect.
    expect(decideListingPushRunPrefilter({ scope: "all", facts: facts({ priceMovedAfterPress: true }) })).toBeNull();
    expect(decideListingPushRunPrefilter({ scope: "not_live", facts: facts({}) })).toBeNull();
  });

  it("checks the price of a size eBay still lists while it is re-sent, for both scopes (review MC3)", () => {
    // A failed or queued re-send keeps its eBay listing: not live for 'Publish new', but buyers see its price.
    const facts = (overrides: { onMarketplace: boolean; priceMovedAfterPress?: boolean }) => ({
      selected: true, live: false, priceMovedAfterPress: false, ...overrides });
    for (const scope of ["all", "not_live"] as const) {
      expect(decideListingPushRunPrefilter({ scope, facts: facts({ onMarketplace: true, priceMovedAfterPress: true }) }))
        .toEqual({ outcome: "needs_price_check" });
      expect(decideListingPushRunPrefilter({ scope, facts: facts({ onMarketplace: true }) })).toBeNull();
    }
  });

  it("classifies a failed chunk queue", () => {
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_CONTENT_VERSION_CONFLICT", "moved")))
      .toEqual({ kind: "conflict", code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_LISTING_PRICE_VERSION_CONFLICT", "moved")).kind).toBe("conflict");
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT", "taken")))
      .toEqual({ kind: "key_conflict", code: "DROPSHIP_LISTING_PUSH_RUN_KEY_CONFLICT" });
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "taken")).kind).toBe("key_conflict");
    expect(classifyChunkExpansionError(Object.assign(new Error("duplicate key"), { code: "23505" })).kind).toBe("key_conflict");
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_LISTING_VENDOR_BLOCKED", "paused account")))
      .toEqual({ kind: "permanent", code: "DROPSHIP_LISTING_VENDOR_BLOCKED", message: "paused account" });
    // One product's refusal names it, so only its sizes fail (verify V6); an unusable product id names nothing.
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE", "no stock read", { productId: 77, retryable: false })))
      .toEqual({ kind: "permanent", code: "DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE", message: "no stock read", productId: 77 });
    for (const productId of [0, -1, 1.5, "77", null]) {
      expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_CHANNEL_QUANTITY_UNAVAILABLE", "no stock read", { productId })))
        .not.toHaveProperty("productId");
    }
    // A retryable refusal stays transient for the whole chunk, product or not.
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_ALLOCATION_UNAVAILABLE", "busy", { productId: 77, retryable: true })).kind)
      .toBe("transient");
    expect(LISTING_PUSH_RUN_CODES.chunkExists).toBe("DROPSHIP_LISTING_PUSH_RUN_CHUNK_EXISTS");
    expect(classifyChunkExpansionError(new DropshipError("DROPSHIP_LISTING_PUSH_RUN_CHUNK_EXISTS", "adopt", { retryable: true })).kind)
      .toBe("transient");
    expect(classifyChunkExpansionError(new Error("connection terminated")))
      .toEqual({ kind: "transient", code: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_RETRYING", message: "connection terminated" });
  });

  it("classes a chunk the job schema refuses as permanent: the same chunk is refused every time (review CT9)", () => {
    const refused = z.object({ productVariantIds: z.array(z.number()).max(500) }).safeParse({ productVariantIds: Array(501).fill(1) });
    expect(refused.success).toBe(false);
    const classified = classifyChunkExpansionError(refused.success ? null : refused.error);
    expect(classified).toMatchObject({ kind: "permanent", code: "DROPSHIP_LISTING_PUSH_RUN_CHUNK_INVALID" });
  });
});
