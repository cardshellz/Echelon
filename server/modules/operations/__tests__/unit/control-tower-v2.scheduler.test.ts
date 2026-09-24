import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../../infrastructure/scheduler-lock", () => ({ withAdvisoryLock: vi.fn() }));
vi.mock("../../control-tower-flow-snapshot.service", () => ({ refreshControlTowerFlowSnapshotIfDue: vi.fn() }));
vi.mock("../../control-tower-v2.job", () => ({ runControlTowerProjectionJob: vi.fn() }));

import { withAdvisoryLock } from "../../../../infrastructure/scheduler-lock";
import {
  controlTowerProjectorInitialDelayMs,
  startControlTowerProjectionScheduler,
} from "../../control-tower-v2.scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(withAdvisoryLock).mockReset();
});

describe("Control Tower projector schedule", () => {
  it("starts halfway through short intervals and caps long-interval startup delay", () => {
    expect(controlTowerProjectorInitialDelayMs(30_000)).toBe(15_000);
    expect(controlTowerProjectorInitialDelayMs(60_000)).toBe(30_000);
    expect(controlTowerProjectorInitialDelayMs(300_000)).toBe(120_000);
    expect(controlTowerProjectorInitialDelayMs(60 * 60_000)).toBe(120_000);
    expect(() => controlTowerProjectorInitialDelayMs(29_999)).toThrow();
    expect(() => controlTowerProjectorInitialDelayMs(Number.NaN)).toThrow();
  });

  it("keeps every five-minute run off the startup-aligned shipping cadence", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runProjection = vi.mocked(withAdvisoryLock).mockResolvedValue(null);
    const handle = startControlTowerProjectionScheduler({
      environment: { CONTROL_TOWER_PROJECTOR_INTERVAL_MS: "300000" },
    });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(runProjection).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(runProjection).toHaveBeenCalledTimes(1);
    expect(runProjection).toHaveBeenCalledWith(736207, expect.any(Function));

    await vi.advanceTimersByTimeAsync(180_000);
    expect(runProjection).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runProjection).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runProjection).toHaveBeenCalledTimes(2);
  });

  it("does not run if stopped before the initial delay", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runProjection = vi.mocked(withAdvisoryLock).mockResolvedValue(null);
    const handle = startControlTowerProjectionScheduler({
      environment: { CONTROL_TOWER_PROJECTOR_INTERVAL_MS: "300000" },
    });

    handle.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runProjection).not.toHaveBeenCalled();
  });

  it("reports a failed run and continues on the next interval", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runProjection = vi.mocked(withAdvisoryLock)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(null);
    const handle = startControlTowerProjectionScheduler({
      environment: { CONTROL_TOWER_PROJECTOR_INTERVAL_MS: "300000" },
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runProjection).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});
