import { describe, expect, it, vi } from "vitest";
import { emptyListingPushRunCounts } from "../../../../../shared/dropship/listing-push-runs";
import { RUN_RECONCILE_JOB_ACTIVITY_WINDOW_MS } from "../../domain/listing-push-run";
import { finishedRun, makeSweepHarness, SWEEP_NOW, sweepRunRecord } from "../fixtures/listing-push-run-sweep.fake";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import { decideChunkFailure, targetOutcomeFromItemSql } from "../../infrastructure/dropship-listing-push-run-sweep.repository";

/** Publish run reconcile and finish (step 1 plan S2-5, §4.4) and the run's one email (§4.5). */
describe("publish run reconcile and finish", () => {
  it("reconciles over the activity window, then finishes, then notifies after the finish has committed", async () => {
    const harness = makeSweepHarness();
    harness.repository.finished = [finishedRun({ storeName: "marz_cards", problems: [{ productVariantId: 102, productId: 1, productName: "Toploader",
      variantName: "Pack of 25", sku: "TL-25", outcome: "failed", code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR",
      message: "eBay listing push failed with HTTP 400.", retryable: false }] })];
    const finishRuns = harness.repository.finishRuns.bind(harness.repository);
    harness.repository.finishRuns = async (input) => { harness.order.push("finishRuns"); return finishRuns(input); };

    expect(await harness.service.reconcileAndFinish()).toEqual({ changed: 0, finished: 1 });
    expect(harness.repository.callsOf("reconcileTargets")).toEqual([{ now: SWEEP_NOW, activityWindowMs: RUN_RECONCILE_JOB_ACTIVITY_WINDOW_MS }]);
    expect(harness.repository.callsOf("finishRuns")).toEqual([{ now: SWEEP_NOW, problemLimit: 25 }]);
    expect(harness.order).toEqual(["finishRuns", "notify"]);
    expect(harness.notices).toEqual([{
      vendorId: 10,
      eventType: "dropship_listing_push_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Some listings didn't publish",
      // The store by name and each problem size with its reason, in the message the email and the portal show (review DUX1).
      message: "2 of 3 listings didn't publish to marz_cards. Catalog step 3 shows each one and why."
        + "\nToploader · Pack of 25 · TL-25: It couldn't be sent.\nAnd 1 more in Catalog step 3.",
      payload: {
        runId: 4, storeConnectionId: 22, status: "partial", stopReason: null,
        counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 2 },
        problems: [{ productVariantId: 102, sku: "TL-25", productName: "Toploader", variantName: "Pack of 25", outcome: "failed",
          code: "DROPSHIP_EBAY_LISTING_PUSH_HTTP_ERROR", message: "eBay listing push failed with HTTP 400." }],
        omittedProblemCount: 1,
      },
      idempotencyKey: "listing-push-run:4:finished",
    }]);
    expect(harness.logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_FINISHED")?.context).toMatchObject({
      runId: 4, status: "partial", counts: { completed: 1, failed: 2 } });
  });

  it("names at most 25 problem sizes and counts the rest", async () => {
    const harness = makeSweepHarness();
    const problem = (productVariantId: number) => ({ productVariantId, productId: 1, productName: "P", variantName: "S", sku: null,
      outcome: "blocked" as const, code: "DROPSHIP_LISTING_PREVIEW_BLOCKED", message: null, retryable: false });
    harness.repository.finished = [finishedRun({
      run: sweepRunRecord({ status: "failed", targetCount: 40, completedAt: SWEEP_NOW }),
      counts: { ...emptyListingPushRunCounts(), blocked: 40 },
      problems: Array.from({ length: 30 }, (_, index) => problem(index + 1)),
    })];
    await harness.service.reconcileAndFinish();
    const payload = harness.notices[0].payload as { problems: unknown[]; omittedProblemCount: number };
    expect(payload.problems).toHaveLength(25);
    expect(payload.omittedProblemCount).toBe(15);
    // The message names the same 25 with plain reasons and counts the rest, inside the notification's limit.
    const lines = harness.notices[0].message!.split("\n");
    expect(lines).toHaveLength(27);
    expect(lines[1]).toBe("P · S: It isn't ready to list yet.");
    expect(lines.at(-1)).toBe("And 15 more in Catalog step 3.");
    expect(harness.notices[0].message!.length).toBeLessThanOrEqual(4_000);
  });

  it("keeps the message inside its budget however long the names are, and words every outcome without a code", async () => {
    const harness = makeSweepHarness();
    const long = "Envelope ".repeat(40);
    const outcomes = ["failed", "blocked", "price_review", "stale"] as const;
    harness.repository.finished = [finishedRun({
      run: sweepRunRecord({ status: "failed", targetCount: 25, completedAt: SWEEP_NOW }),
      counts: { ...emptyListingPushRunCounts(), failed: 25 },
      problems: Array.from({ length: 25 }, (_, index) => ({ productVariantId: index + 1, productId: 1, productName: long, variantName: long,
        sku: null, outcome: outcomes[index % 4], code: index === 0 ? "DROPSHIP_LISTING_PUSH_PROVIDER_UNAVAILABLE" : "DROPSHIP_X",
        message: "operator text", retryable: true })),
    })];
    await harness.service.reconcileAndFinish();
    const message = harness.notices[0].message!;
    expect(message.length).toBeLessThanOrEqual(4_000);
    expect(message).toContain("didn't publish to your eBay store.");
    expect(message).toContain(": eBay wasn't answering.");
    expect(message).toContain(": Its price changed after you pressed Publish, and your cost-change setting waits for your review.");
    expect(message).toContain(": It changed while publishing.");
    expect(message).not.toMatch(/DROPSHIP_|operator text/);
    expect(message.split("\n")[1].split(":")[0]).toHaveLength(80);
  });

  it("sends nothing for a run with no problem: completed, or stopped with only cancelled and skipped sizes", async () => {
    const harness = makeSweepHarness();
    harness.repository.finished = [
      finishedRun({ run: sweepRunRecord({ status: "completed", completedAt: SWEEP_NOW }), counts: { ...emptyListingPushRunCounts(), completed: 3 } }),
      finishedRun({ run: sweepRunRecord({ runId: 5, status: "cancelled", stopReason: "vendor_stop", cancelRequestedAt: SWEEP_NOW, completedAt: SWEEP_NOW }),
        counts: { ...emptyListingPushRunCounts(), completed: 1, cancelled: 5, skipped: 2 } }),
    ];
    expect(await harness.service.reconcileAndFinish()).toEqual({ changed: 0, finished: 2 });
    expect(harness.notices).toEqual([]);
  });

  it("tells the vendor eBay stayed down when the job breaker stopped the run", async () => {
    const harness = makeSweepHarness();
    harness.repository.finished = [finishedRun({
      run: sweepRunRecord({ status: "failed", stopReason: "provider_unavailable", targetCount: 600, completedAt: SWEEP_NOW }),
      counts: { ...emptyListingPushRunCounts(), failed: 600 },
    })];
    await harness.service.reconcileAndFinish();
    expect(harness.notices[0].message).toBe(
      "600 of 600 listings didn't publish to your eBay store. eBay wasn't answering, so publishing stopped. Publish again later. Catalog step 3 shows each one and why.");
    expect(harness.notices[0].payload).toMatchObject({ stopReason: "provider_unavailable" });
  });

  it("keeps going when the email cannot be sent, with a WARN: the run already finished", async () => {
    const harness = makeSweepHarness();
    harness.repository.finished = [finishedRun()];
    harness.notificationSender.error = new Error("email unavailable");
    await expect(harness.service.reconcileAndFinish()).resolves.toEqual({ changed: 0, finished: 1 });
    expect(harness.logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_NOTIFICATION_FAILED")).toMatchObject({
      level: "warn", context: { runId: 4, problemCount: 2, error: "email unavailable" } });
  });

  it("stamps every finished run's notice step as done after it, problems or not (verify V9)", async () => {
    const harness = makeSweepHarness();
    harness.repository.finished = [
      finishedRun(),
      finishedRun({ run: sweepRunRecord({ runId: 5, status: "completed", completedAt: SWEEP_NOW }), counts: { ...emptyListingPushRunCounts(), completed: 3 } }),
    ];
    const markRunNotified = harness.repository.markRunNotified.bind(harness.repository);
    harness.repository.markRunNotified = async (input) => { harness.order.push(`mark:${input.runId}`); return markRunNotified(input); };
    await harness.service.reconcileAndFinish();
    expect(harness.order).toEqual(["notify", "mark:4", "mark:5"]);
    expect(harness.repository.callsOf("markRunNotified")).toEqual([{ runId: 4, now: SWEEP_NOW }, { runId: 5, now: SWEEP_NOW }]);
    // A sender failure is logged and not retried: the step is done.
    const failing = makeSweepHarness();
    failing.repository.finished = [finishedRun()];
    failing.notificationSender.error = new Error("email unavailable");
    await failing.service.reconcileAndFinish();
    expect(failing.repository.notified).toEqual([4]);
  });

  it("sends the notice of a run a dead process finished but never notified, under the same key, with a WARN (verify V9)", async () => {
    const harness = makeSweepHarness();
    harness.repository.awaitingNotice = [finishedRun({ run: sweepRunRecord({ runId: 8, status: "partial", completedAt: new Date(SWEEP_NOW.getTime() - 60_000) }) })];
    await harness.service.reconcileAndFinish();
    expect(harness.repository.callsOf("listRunsAwaitingNotice")).toEqual([{ now: SWEEP_NOW, windowMs: 86_400_000, limit: 25, problemLimit: 25 }]);
    expect(harness.notices.map((notice) => notice.idempotencyKey)).toEqual(["listing-push-run:8:finished"]);
    expect(harness.repository.notified).toEqual([8]);
    expect(harness.logs.find((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_NOTICE_RECOVERED")).toMatchObject({
      level: "warn", context: { runId: 8, status: "partial" } });
    // Done: the next sweep finds nothing to send again.
    await harness.service.reconcileAndFinish();
    expect(harness.notices).toHaveLength(1);
  });

  it("leaves the notice step for the next sweep when its stamp cannot be written, and sends under the same key then", async () => {
    const harness = makeSweepHarness();
    harness.repository.finished = [finishedRun()];
    harness.repository.failMarkRunNotified = new Error("connection terminated");
    await expect(harness.service.reconcileAndFinish()).rejects.toThrow("connection terminated");
    harness.repository.finished = [];
    harness.repository.failMarkRunNotified = null;
    harness.repository.awaitingNotice = [finishedRun()];
    await harness.service.reconcileAndFinish();
    // The notification service replays a key it already holds: never a second email.
    expect(harness.notices.map((notice) => notice.idempotencyKey)).toEqual(["listing-push-run:4:finished", "listing-push-run:4:finished"]);
    expect(harness.repository.notified).toEqual([4]);
  });

  it("logs one WARN per finished run that has sizes a passing stock link condition failed, which a run never re-queues (merge review ADV-RB2-1)", async () => {
    const harness = makeSweepHarness();
    const failures = [{ code: "DROPSHIP_STOCK_LINK_BUSY", count: 2 }, { code: "DROPSHIP_STOCK_UPDATES_PAUSED", count: 1 }];
    harness.repository.finished = [
      finishedRun({ counts: { ...emptyListingPushRunCounts(), completed: 1, failed: 4 }, stockLinkFailuresNotRequeued: failures }),
      finishedRun({ run: sweepRunRecord({ runId: 5, status: "completed", completedAt: SWEEP_NOW }), counts: { ...emptyListingPushRunCounts(), completed: 3 } }),
    ];
    await harness.service.reconcileAndFinish();
    const warned = harness.logs.filter((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED");
    expect(warned).toEqual([{
      level: "warn",
      code: "DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED",
      message: "Sizes of a finished publish run failed for a stock link reason that usually clears by itself. A publish run does not queue them again by itself; the vendor was asked to publish again.",
      context: {
        action: "finish_publish_run", outcome: "not_requeued", runId: 4, vendorId: 10, storeConnectionId: 22, status: "partial",
        failedSizes: 3, failures,
      },
    }]);
    // Right after the run's own finish line, before its notice.
    const codes = harness.logs.map((event) => event.code);
    expect(codes.indexOf("DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED")).toBe(codes.indexOf("DROPSHIP_LISTING_PUSH_RUN_FINISHED") + 1);
  });

  it("logs the same WARN for a run whose finish a dead process committed, when its notice is recovered (merge review ADV-RB2-1)", async () => {
    const harness = makeSweepHarness();
    const failures = [{ code: "PUBLICATION_SCOPE_BUSY", count: 1 }];
    harness.repository.awaitingNotice = [finishedRun({
      run: sweepRunRecord({ runId: 8, status: "partial", completedAt: new Date(SWEEP_NOW.getTime() - 60_000) }), stockLinkFailuresNotRequeued: failures })];
    await harness.service.reconcileAndFinish();
    expect(harness.logs.filter((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED")).toMatchObject([{
      level: "warn", context: { runId: 8, status: "partial", failedSizes: 1, failures } }]);
    // Once: the recovered notice is stamped, so the next sweep logs nothing again.
    await harness.service.reconcileAndFinish();
    expect(harness.logs.filter((event) => event.code === "DROPSHIP_LISTING_PUSH_RUN_STOCK_LINK_NOT_REQUEUED")).toHaveLength(1);
  });

  it("logs a change to a finished run's targets (a staff retry copied in)", async () => {
    const harness = makeSweepHarness();
    harness.repository.reconcileResult = { changed: 3, finishedRunChanges: 1 };
    await harness.service.reconcileAndFinish();
    expect(harness.logs.map((event) => event.code)).toEqual(["DROPSHIP_LISTING_PUSH_RUN_TARGETS_CHANGED_AFTER_FINISH"]);
  });

  it("maps item states to outcomes in SQL by the same rules as TypeScript (the PostgreSQL suite runs it row by row)", () => {
    const sql = targetOutcomeFromItemSql("i");
    expect(sql).toContain("WHEN 'blocked' THEN CASE WHEN i.error_code = 'DROPSHIP_LISTING_NOT_SELECTED' THEN 'skipped' ELSE 'blocked' END");
    expect(sql).toContain("WHEN 'failed' THEN CASE WHEN i.error_code = 'DROPSHIP_LISTING_PRICE_AWAITING_REVIEW' THEN 'price_review' ELSE 'failed' END");
    expect(sql).toContain("WHEN 'processing' THEN 'queued'");
  });

  it("decides a failed chunk's targets only at each failure kind's limit", () => {
    expect(decideChunkFailure({ kind: "conflict", code: "C", maxAttempts: 3 }, 2)).toBeNull();
    expect(decideChunkFailure({ kind: "conflict", code: "C", maxAttempts: 3 }, 3)).toEqual({ outcome: "stale", retryable: false });
    expect(decideChunkFailure({ kind: "transient", code: "T", maxAttempts: 5 }, 4)).toBeNull();
    expect(decideChunkFailure({ kind: "transient", code: "T", maxAttempts: 5 }, 5)).toEqual({ outcome: "failed", retryable: true });
    expect(decideChunkFailure({ kind: "permanent", code: "P" }, 1)).toEqual({ outcome: "failed", retryable: false });
    expect(decideChunkFailure({ kind: "key_conflict", code: "K" }, 1)).toEqual({ outcome: "failed", retryable: false });
  });
});
