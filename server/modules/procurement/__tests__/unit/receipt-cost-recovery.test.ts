import { describe, expect, it, vi, afterEach } from "vitest";
import { receiptCostRecoveryOutcome, recoveryRetryOutcome, type ReceiptCostRecoveryClaim } from "../../receipt-cost-recovery.domain";
import { runReceiptCostRecoveryBatch, startReceiptCostRecoveryWorker, type ReceiptCostRecoveryDependencies } from "../../receipt-cost-recovery.worker";
import { describeReceiptCostRecovery, receiptCostRecoverySchema } from "@shared/procurement/receipt-cost-recovery";

const now = new Date("2026-09-07T12:00:00.000Z");
const claim: ReceiptCostRecoveryClaim = { requestId: 1, receiptId: 2, purchaseOrderLineId: 3, attemptCount: 1, maxAttempts: 5,
  leaseToken: "22222222-2222-4222-8222-222222222222" };
const response = (state: "applied" | "review_required" | "retry_required") => ({ state,
  requests: [{ requestId: 1, purchaseOrderLineId: 3, state, issues: [], attemptRecorded: true }] });

describe("receipt-cost recovery decisions", () => {
  it.each(["applied", "review_required"] as const)("ends automatic recovery for recorded %s", (state) => {
    expect(receiptCostRecoveryOutcome(claim, response(state), now).state).toBe(state);
  });
  it.each([
    undefined, { state: "applied", requests: [] },
    { state: "applied", requests: [{ requestId: 99, purchaseOrderLineId: 3, state: "applied", issues: [], attemptRecorded: true }] },
    { state: "applied", requests: [{ requestId: 1, purchaseOrderLineId: 99, state: "applied", issues: [], attemptRecorded: true }] },
    { state: "applied", requests: [{ requestId: 1, purchaseOrderLineId: 3, state: "applied", issues: [], attemptRecorded: false }] },
  ])("never treats malformed or unrecorded output as completion", (raw) => {
    expect(receiptCostRecoveryOutcome(claim, raw, now)).toMatchObject({ state: "queued", errorCode: "RECEIPT_COST_RECOVERY_RESULT_INVALID" });
  });
  it("backs off deterministically and exhausts the finite budget", () => {
    const original = structuredClone(claim);
    expect(receiptCostRecoveryOutcome(claim, response("retry_required"), now).nextAttemptAt.toISOString()).toBe("2026-09-07T12:01:00.000Z");
    expect(recoveryRetryOutcome({ ...claim, attemptCount: 2 }, "FAILED", now).nextAttemptAt.toISOString()).toBe("2026-09-07T12:05:00.000Z");
    expect(recoveryRetryOutcome({ ...claim, attemptCount: 5 }, "FAILED", now).state).toBe("exhausted");
    expect(claim).toEqual(original);
    expect(now.toISOString()).toBe("2026-09-07T12:00:00.000Z");
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid request ID %s", (requestId) => {
    expect(() => receiptCostRecoveryOutcome({ ...claim, requestId }, response("applied"), now)).toThrow();
  });
  it("rejects a corrupt clock and exhausted claim", () => {
    expect(() => recoveryRetryOutcome(claim, "FAILED", new Date("invalid"))).toThrow();
    expect(() => recoveryRetryOutcome({ ...claim, attemptCount: 6 }, "FAILED", now)).toThrow();
  });
});

function dependencies(): ReceiptCostRecoveryDependencies {
  return { repository: { prepare: vi.fn().mockResolvedValue(undefined), claimNext: vi.fn().mockResolvedValueOnce(claim).mockResolvedValue(null), complete: vi.fn().mockResolvedValue("applied") },
    receiving: { retryCostsAutomatically: vi.fn().mockResolvedValue(response("applied")) }, clock: () => now,
    leaseToken: () => claim.leaseToken, logger: { info: vi.fn(), error: vi.fn() } };
}

describe("receipt recovery worker", () => {
  afterEach(() => vi.useRealTimers());
  it("calls only the one claimed receipt request through the receiving owner", async () => {
    const deps = dependencies();
    expect(await runReceiptCostRecoveryBatch(deps)).toMatchObject({ claimed: 1, applied: 1 });
    expect(deps.receiving.retryCostsAutomatically).toHaveBeenCalledExactlyOnceWith(2, 1);
    expect(deps.repository.complete).toHaveBeenCalledWith(claim, expect.objectContaining({ state: "applied" }), now);
  });
  it("records a thrown owner failure as bounded retry", async () => {
    const deps = dependencies(); vi.mocked(deps.receiving.retryCostsAutomatically).mockRejectedValue(new Error("sensitive driver detail"));
    vi.mocked(deps.repository.complete).mockResolvedValue("queued");
    expect(await runReceiptCostRecoveryBatch(deps)).toMatchObject({ claimed: 1, retried: 1 });
    expect(JSON.stringify(vi.mocked(deps.logger.error).mock.calls)).not.toContain("sensitive");
  });
  it("does not report success after losing the lease", async () => {
    const deps = dependencies(); vi.mocked(deps.repository.complete).mockResolvedValue(null);
    expect(await runReceiptCostRecoveryBatch(deps)).toMatchObject({ applied: 0, leaseLost: 1 });
  });
  it("stops on failed claim/completion persistence so a crash can recover the lease", async () => {
    const deps = dependencies(); vi.mocked(deps.repository.complete).mockRejectedValue(new Error("DB unavailable"));
    await expect(runReceiptCostRecoveryBatch(deps)).rejects.toThrow("DB unavailable");
    expect(deps.repository.claimNext).toHaveBeenCalledTimes(1);
  });
  it.each([0, 26, 1.5])("rejects unbounded batch size %s before touching persistence", async (batchSize) => {
    const deps = dependencies(); await expect(runReceiptCostRecoveryBatch(deps, batchSize)).rejects.toThrow();
    expect(deps.repository.prepare).not.toHaveBeenCalled();
  });
  it.each([{}, { RECEIPT_COST_RECOVERY_ENABLED: "false" }, { RECEIPT_COST_RECOVERY_ENABLED: "true", DISABLE_SCHEDULERS: "true" },
    { RECEIPT_COST_RECOVERY_ENABLED: "true", RECEIPT_COST_RECOVERY_DISABLED: "true" }])("honors explicit activation and scheduler shutdown", (environment) => {
    vi.useFakeTimers(); expect(startReceiptCostRecoveryWorker(dependencies(), environment)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("starts a stoppable loop only when enabled", () => {
    vi.useFakeTimers(); const handle = startReceiptCostRecoveryWorker(dependencies(), { RECEIPT_COST_RECOVERY_ENABLED: "true" });
    expect(handle).not.toBeNull(); expect(vi.getTimerCount()).toBe(1);
    handle!.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("receipt recovery display contract", () => {
  const recovery = { state: "queued" as const, attemptCount: 2, maxAttempts: 5, nextAttemptAt: now.toISOString(), leaseExpiresAt: null,
    lastErrorCode: "FAILED", updatedAt: now.toISOString() };
  it("shows exhaustion and the human recovery path", () => {
    expect(describeReceiptCostRecovery({ ...recovery, state: "exhausted", attemptCount: 5 }, "retry_required")).toContain("retry receipt costs manually");
  });
  it("lets verified financial outcomes supersede stale scheduler metadata", () => {
    expect(describeReceiptCostRecovery(recovery, "applied")).toContain("no further work");
    expect(describeReceiptCostRecovery(recovery, "review_required")).toContain("Resolve the cost evidence");
  });
  it("rejects mismatched leases and budgets", () => {
    expect(receiptCostRecoverySchema.safeParse({ ...recovery, state: "processing" }).success).toBe(false);
    expect(receiptCostRecoverySchema.safeParse({ ...recovery, attemptCount: 6 }).success).toBe(false);
  });
});
