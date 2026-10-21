import { describe, expect, it } from "vitest";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import {
  DropshipListingPushRecoveryService,
  LISTING_RECOVERY_BATCH_SIZE,
  type AccountVerificationRequeueResult,
  type DemotedLiveListingRepairResult,
  type DropshipAccountVerificationRequeuePort,
  type DropshipLiveListingStatusRepairPort,
} from "../../application/dropship-listing-push-recovery-service";
import { DropshipError } from "../../domain/errors";
import { classifyRecoveryError, recoveryErrorCode } from "../../infrastructure/dropship-listing-recovery-errors";

const NOW = new Date("2026-10-20T12:00:00.000Z");

class FakeRepair implements DropshipLiveListingStatusRepairPort {
  calls: Array<{ now: Date; workerId: string; limit: number }> = [];
  order: string[];
  error: Error | null = null;
  result: DemotedLiveListingRepairResult = { restored: [], reviewRequired: [], failed: [], skipped: 0 };
  constructor(order: string[]) { this.order = order; }
  async restoreDemotedLiveListings(input: { now: Date; workerId: string; limit: number }) {
    this.order.push("repair");
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.result;
  }
}

class FakeRequeue implements DropshipAccountVerificationRequeuePort {
  calls: Array<{ now: Date; workerId: string; limit: number }> = [];
  order: string[];
  error: Error | null = null;
  result: AccountVerificationRequeueResult = { requeued: [], failed: [] };
  constructor(order: string[]) { this.order = order; }
  async requeueAccountVerificationFailures(input: { now: Date; workerId: string; limit: number }) {
    this.order.push("requeue");
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.result;
  }
}

function setup() {
  const order: string[] = [];
  const repair = new FakeRepair(order);
  const requeue = new FakeRequeue(order);
  const logs: Array<DropshipLogEvent & { level: string }> = [];
  const service = new DropshipListingPushRecoveryService({
    liveStatusRepair: repair,
    accountVerificationRequeue: requeue,
    clock: { now: () => NOW },
    logger: {
      info: (event) => logs.push({ level: "info", ...event }),
      warn: (event) => logs.push({ level: "warn", ...event }),
      error: (event) => logs.push({ level: "error", ...event }),
    },
  });
  return { order, repair, requeue, logs, service };
}

describe("DropshipListingPushRecoveryService", () => {
  it("restores live statuses first, then requeues, with the injected clock and a bounded batch", async () => {
    const { order, repair, requeue, service } = setup();

    const result = await service.run({ workerId: "worker-1" });

    expect(order).toEqual(["repair", "requeue"]);
    expect(repair.calls).toEqual([{ now: NOW, workerId: "worker-1", limit: LISTING_RECOVERY_BATCH_SIZE }]);
    expect(requeue.calls).toEqual([{ now: NOW, workerId: "worker-1", limit: LISTING_RECOVERY_BATCH_SIZE }]);
    expect(result).toEqual({ listingsRestored: 0, listingsNeedingReview: 0, jobsRequeued: 0, itemsRequeued: 0, rowFailures: 0, stepFailures: 0 });
  });

  it("logs each restore (WARN, before/after), each review (ERROR, requires_review) and each requeue (INFO)", async () => {
    const { repair, requeue, logs, service } = setup();
    repair.result = {
      restored: [{ listingId: 100, vendorId: 10, storeConnectionId: 22, productVariantId: 101, previousStatus: "failed", status: "active",
        basisItemId: 5, latestItemId: 9, latestItemStatus: "failed", latestItemErrorCode: "DROPSHIP_EBAY_PUBLICATION_ACCOUNT_UNVERIFIED" }],
      reviewRequired: [{ listingId: 200, vendorId: 10, storeConnectionId: 22, productVariantId: 201, status: "queued",
        code: "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH", message: "no completed push" }],
      failed: [{ entity: "dropship_vendor_listing", entityId: 300, code: "40001", message: "serialization", classification: "transient", markedForReview: false }],
      skipped: 2,
    };
    requeue.result = {
      requeued: [{ jobId: 40, vendorId: 10, storeConnectionId: 22, itemIds: [7, 8], listingIds: [100], idempotencyKey: "key-40" }],
      failed: [{ entity: "dropship_listing_push_job", entityId: 41, code: "23514", message: "check", classification: "permanent", markedForReview: true }],
    };

    const result = await service.run({ workerId: "worker-1" });

    expect(result).toEqual({ listingsRestored: 1, listingsNeedingReview: 1, jobsRequeued: 1, itemsRequeued: 2, rowFailures: 2, stepFailures: 0 });
    expect(logs.find((log) => log.code === "DROPSHIP_LISTING_LIVE_STATUS_RESTORED")).toMatchObject({
      level: "warn",
      context: { listingId: 100, basisItemId: 5, latestItemId: 9, before: { status: "failed" }, after: { status: "active" }, outcome: "restored" },
    });
    expect(logs.find((log) => log.code === "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH")).toMatchObject({
      level: "error", context: { listingId: 200, outcome: "requires_review", classification: "permanent", error_code: "DROPSHIP_LISTING_LIVE_STATUS_NO_COMPLETED_PUSH" },
    });
    expect(logs.find((log) => log.code === "DROPSHIP_LISTING_PUSH_ACCOUNT_CHECK_REQUEUED")).toMatchObject({
      level: "info", context: { jobId: 40, itemIds: [7, 8], before: { jobStatus: "failed" }, after: { jobStatus: "queued" } },
    });
    const rowFailures = logs.filter((log) => log.code === "DROPSHIP_LISTING_PUSH_RECOVERY_ROW_FAILED");
    expect(rowFailures.map((log) => [log.level, log.context?.entityId, log.context?.classification])).toEqual([
      ["warn", 300, "transient"],
      ["error", 41, "permanent"],
    ]);
  });

  it("keeps going when one step fails: the failure is logged for a human and the other step still runs", async () => {
    const { order, repair, logs, service } = setup();
    repair.error = new Error("database unavailable");

    const result = await service.run({ workerId: "worker-1" });

    expect(order).toEqual(["repair", "requeue"]);
    expect(result.stepFailures).toBe(1);
    expect(logs.find((log) => log.code === "DROPSHIP_LISTING_PUSH_RECOVERY_STEP_FAILED")).toMatchObject({
      level: "error", context: { action: "restore_live_listing_status", outcome: "failed", error: "database unavailable" },
    });
  });
});

describe("classifyRecoveryError", () => {
  it("never retries a row whose failure repeats, and retries one that clears", () => {
    expect(classifyRecoveryError(Object.assign(new Error("check"), { code: "23514" }))).toBe("permanent");
    expect(classifyRecoveryError(Object.assign(new Error("bad input"), { code: "22P02" }))).toBe("permanent");
    expect(classifyRecoveryError(Object.assign(new Error("missing"), { code: "42P01" }))).toBe("permanent");
    expect(classifyRecoveryError(Object.assign(new Error("serialization"), { code: "40001" }))).toBe("transient");
    expect(classifyRecoveryError(Object.assign(new Error("lock"), { code: "55P03" }))).toBe("transient");
    expect(classifyRecoveryError(new Error("socket hang up"))).toBe("transient");
    expect(classifyRecoveryError(new DropshipError("X", "x", { classification: "permanent" }))).toBe("permanent");
    expect(classifyRecoveryError(new DropshipError("X", "x", { classification: "fatal" }))).toBe("permanent");
    expect(classifyRecoveryError(new DropshipError("X", "x", { classification: "transient" }))).toBe("transient");
    expect(classifyRecoveryError(new DropshipError("X", "x", { retryable: false }))).toBe("permanent");
    expect(classifyRecoveryError(new DropshipError("X", "x"))).toBe("transient");
    expect(recoveryErrorCode(new DropshipError("DROPSHIP_X", "x"))).toBe("DROPSHIP_X");
    expect(recoveryErrorCode(Object.assign(new Error("check"), { code: "23514" }))).toBe("23514");
    expect(recoveryErrorCode("boom")).toBe("DROPSHIP_RECOVERY_STEP_FAILED");
  });
});
