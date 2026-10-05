import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORDER_EDIT_SWEEP_INTERVAL_MS,
  startOrderEditScheduler,
} from "../../infrastructure/order-edit-scheduler";
describe("order edit recovery scheduler", () => {
  afterEach(() => vi.useRealTimers());
  it("starts immediately, prevents overlapping sweeps, and stops its timer", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const sweep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = startOrderEditScheduler({ sweep }, vi.fn());
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * ORDER_EDIT_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ORDER_EDIT_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
    release();
    await vi.advanceTimersByTimeAsync(ORDER_EDIT_SWEEP_INTERVAL_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
  it("reports failures and continues subsequent sweeps", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const stop = startOrderEditScheduler({ sweep }, report);
    await vi.advanceTimersByTimeAsync(ORDER_EDIT_SWEEP_INTERVAL_MS);
    expect(report).toHaveBeenCalledWith({ code: "ORDER_EDIT_SWEEP_FAILED" });
    expect(sweep).toHaveBeenCalledTimes(2);
    stop();
  });
});
