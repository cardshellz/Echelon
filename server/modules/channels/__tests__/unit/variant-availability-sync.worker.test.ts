import { describe, expect, it, vi } from "vitest";
import {
  getVariantAvailabilityWorkerHeartbeat,
  runVariantAvailabilityWorkerTick,
} from "../../variant-availability-sync.worker";

const EMPTY_RESULT = {
  claimed: 0,
  synced: 0,
  retried: 0,
  superseded: 0,
};

describe("variant availability sync worker", () => {
  it("prevents overlapping ticks", async () => {
    let resolveFirst!: (value: typeof EMPTY_RESULT) => void;
    const firstRun = new Promise<typeof EMPTY_RESULT>((resolve) => {
      resolveFirst = resolve;
    });
    const processor = { processDue: vi.fn(() => firstRun) };

    const activeTick = runVariantAvailabilityWorkerTick(processor);
    await expect(runVariantAvailabilityWorkerTick(processor)).resolves.toBe("skipped");
    expect(processor.processDue).toHaveBeenCalledOnce();

    resolveFirst(EMPTY_RESULT);
    await expect(activeTick).resolves.toBe("success");
    expect(getVariantAvailabilityWorkerHeartbeat().inFlight).toBe(false);
  });

  it("records processor failures and releases the in-flight guard", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const processor = {
      processDue: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };

    await expect(runVariantAvailabilityWorkerTick(processor)).resolves.toBe("error");
    expect(getVariantAvailabilityWorkerHeartbeat()).toEqual(expect.objectContaining({
      inFlight: false,
      lastError: "database unavailable",
    }));
    errorSpy.mockRestore();
  });
});
