import { afterEach, describe, expect, it, vi } from "vitest";

import { startCarrierTrackingReconciliationScheduler } from "../../carrier-tracking-reconciliation.scheduler";

const emptyResult = {
  hydrationsClaimed: 0,
  hydrationsCompleted: 0,
  hydrationsRetryScheduled: 0,
  hydrationsReviewRequired: 0,
  hydrationClientConfigured: false,
  subscriptionsPrepared: 0,
  subscriptionLabelLinksPrepared: 0,
  subscriptionsClaimed: 0,
  subscriptionsActivated: 0,
  subscriptionsRetryScheduled: 0,
  subscriptionsReviewRequired: 0,
  subscriptionClientConfigured: false,
  labelsScanned: 0,
  labelsLinked: 0,
  scanned: 0,
  matched: 0,
  unresolved: 0,
  attemptsAppended: 0,
  errors: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("carrier tracking reconciliation scheduler", () => {
  it("runs the configured batch after the initial delay", async () => {
    vi.useFakeTimers();
    const reconcileUnresolved = vi.fn().mockResolvedValue(emptyResult);
    const handle = startCarrierTrackingReconciliationScheduler(
      { reconcileUnresolved },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { initialDelayMs: 100, intervalMs: 1_000, batchLimit: 25 },
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(reconcileUnresolved).toHaveBeenCalledOnce();
    expect(reconcileUnresolved).toHaveBeenCalledWith(25);
    handle.stop();
  });

  it("does not overlap sweeps and stops future work", async () => {
    vi.useFakeTimers();
    const first = deferred<typeof emptyResult>();
    const reconcileUnresolved = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(emptyResult);
    const handle = startCarrierTrackingReconciliationScheduler(
      { reconcileUnresolved },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      { initialDelayMs: 100, intervalMs: 1_000, batchLimit: 25 },
    );

    await vi.advanceTimersByTimeAsync(1_100);
    expect(reconcileUnresolved).toHaveBeenCalledOnce();

    first.resolve(emptyResult);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcileUnresolved).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcileUnresolved).toHaveBeenCalledTimes(2);
  });
});
