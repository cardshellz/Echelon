import { afterEach, describe, expect, it, vi } from "vitest";

import { startNonOverlappingScheduler } from "../non-overlapping-scheduler";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("startNonOverlappingScheduler", () => {
  it("waits for the configured initial phase before running", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = startNonOverlappingScheduler({
      taskName: "test-task",
      initialDelayMs: 250,
      intervalMs: 1_000,
      run,
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledOnce();
    handle.stop();
  });

  it("schedules the next run only after the current run completes", async () => {
    vi.useFakeTimers();
    const firstRun = deferred();
    const run = vi.fn()
      .mockImplementationOnce(() => firstRun.promise)
      .mockResolvedValue(undefined);
    const handle = startNonOverlappingScheduler({
      taskName: "test-task",
      initialDelayMs: 100,
      intervalMs: 1_000,
      run,
    });

    await vi.advanceTimersByTimeAsync(10_100);
    expect(run).toHaveBeenCalledOnce();

    firstRun.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(999);
    expect(run).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("continues after an escaped failure and logs the task identity", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("unexpected failure"))
      .mockResolvedValue(undefined);
    const handle = startNonOverlappingScheduler({
      taskName: "test-task",
      initialDelayMs: 0,
      intervalMs: 1_000,
      run,
      logger: { error },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith({
      code: "NON_OVERLAPPING_SCHEDULED_TASK_FAILED",
      message: "A scheduled task escaped its task-level error boundary.",
      context: {
        taskName: "test-task",
        error: "unexpected failure",
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("stops pending and future runs", async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(undefined);
    const handle = startNonOverlappingScheduler({
      taskName: "test-task",
      initialDelayMs: 500,
      intervalMs: 1_000,
      run,
    });

    handle.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invalid scheduling inputs", () => {
    expect(() => startNonOverlappingScheduler({
      taskName: " ",
      initialDelayMs: 0,
      intervalMs: 1,
      run: async () => undefined,
    })).toThrow("taskName must be a non-blank string");
    expect(() => startNonOverlappingScheduler({
      taskName: "test-task",
      initialDelayMs: -1,
      intervalMs: 1,
      run: async () => undefined,
    })).toThrow("initialDelayMs must be a non-negative integer");
    expect(() => startNonOverlappingScheduler({
      taskName: "test-task",
      initialDelayMs: 0,
      intervalMs: 0,
      run: async () => undefined,
    })).toThrow("intervalMs must be a positive integer");
  });
});
