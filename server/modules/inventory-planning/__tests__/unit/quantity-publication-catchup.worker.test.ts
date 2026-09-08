import { afterEach, describe, expect, it, vi } from "vitest";
import { startQuantityPublicationCatchupWorker } from "../../application/quantity-publication-catchup.worker";

afterEach(() => vi.useRealTimers());
describe("quantity publication catch-up worker", () => {
  it("never overlaps a batch and shutdown waits for it without starting another", async () => {
    vi.useFakeTimers();
    let complete!: (result: { completed: number; failed: number }) => void;
    const processDue = vi.fn(() => new Promise<{ completed: number; failed: number }>(resolve => { complete = resolve; }));
    const log = vi.fn();
    const worker = startQuantityPublicationCatchupWorker({ processDue }, { intervalMs: 100, log });
    expect(processDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(processDue).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    complete({ completed: 1, failed: 0 });
    await stopping;
    await vi.advanceTimersByTimeAsync(1000);
    expect(processDue).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith({ event: "quantity_publication_catchup_batch", completed: 1, failed: 0 });
  });
  it("retains scheduling after failure and does not expose unchecked error details", async () => {
    vi.useFakeTimers();
    const processDue = vi.fn().mockRejectedValueOnce(new Error("private-provider-token"))
      .mockResolvedValue({ completed: 0, failed: 0 });
    const log = vi.fn();
    const worker = startQuantityPublicationCatchupWorker({ processDue }, { intervalMs: 100, log });
    await vi.advanceTimersByTimeAsync(300);
    await worker.stop();
    expect(processDue.mock.calls.length).toBeGreaterThan(1);
    expect(log).toHaveBeenCalledExactlyOnceWith({ event: "quantity_publication_catchup_failed", code: "PUBLICATION_CATCHUP_WORKER_FAILED" });
  });
  it("stops before startup without processing any work", async () => {
    vi.useFakeTimers();
    const processDue = vi.fn();
    const worker = startQuantityPublicationCatchupWorker({ processDue });
    await worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processDue).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity, 1.2, 3_600_001])("rejects unsafe interval %s before scheduling", intervalMs => {
    expect(() => startQuantityPublicationCatchupWorker({ processDue: vi.fn() }, { intervalMs })).toThrow("supported range");
  });
});
