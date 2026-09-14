import { afterEach, describe, expect, it, vi } from "vitest";

import { startInventoryPublicationSweepScheduler } from "../../inventory-publication-sweep.scheduler";

afterEach(() => {
  vi.useRealTimers();
});

describe("inventory publication sweep scheduler", () => {
  it("keeps supervising while disabled and starts without a process restart", async () => {
    vi.useFakeTimers();
    let enabled = false;
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = startInventoryPublicationSweepScheduler({
      readControl: vi.fn(async () => ({ globalEnabled: enabled, sweepIntervalMinutes: 15 })),
      runSweep,
      logger: { info: vi.fn(), error: vi.fn() },
    }, { controlPollIntervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(runSweep).not.toHaveBeenCalled();

    enabled = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSweep).toHaveBeenCalledOnce();

    scheduler.stop();
  });

  it("reschedules from the last sweep when the durable interval changes", async () => {
    vi.useFakeTimers();
    let intervalMinutes = 2;
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const scheduler = startInventoryPublicationSweepScheduler({
      readControl: vi.fn(async () => ({ globalEnabled: true, sweepIntervalMinutes: intervalMinutes })),
      runSweep,
      logger: { info: vi.fn(), error: vi.fn() },
    }, { controlPollIntervalMs: 10_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(runSweep).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_000);
    intervalMinutes = 1;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runSweep).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("does not overlap a running control check and stops all future work", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const firstSweep = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runSweep = vi.fn().mockImplementationOnce(() => firstSweep).mockResolvedValue(undefined);
    const scheduler = startInventoryPublicationSweepScheduler({
      readControl: vi.fn(async () => ({ globalEnabled: true, sweepIntervalMinutes: 1 })),
      runSweep,
      logger: { info: vi.fn(), error: vi.fn() },
    }, { controlPollIntervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    await scheduler.refresh();
    expect(runSweep).toHaveBeenCalledOnce();

    release();
    await Promise.resolve();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(runSweep).toHaveBeenCalledOnce();
  });

  it("fails closed on malformed durable control and retries supervision", async () => {
    vi.useFakeTimers();
    const readControl = vi.fn()
      .mockResolvedValueOnce({ globalEnabled: true, sweepIntervalMinutes: 0 })
      .mockResolvedValue({ globalEnabled: true, sweepIntervalMinutes: 1 });
    const runSweep = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    const scheduler = startInventoryPublicationSweepScheduler({
      readControl,
      runSweep,
      logger: { info: vi.fn(), error },
    }, { controlPollIntervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(0);
    expect(runSweep).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("integer between 1 and 1440"));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runSweep).toHaveBeenCalledOnce();

    scheduler.stop();
  });
});
