import { describe, expect, it } from "vitest";
import { DEFAULT_COST_DETECTION_VENDORS_PER_TICK, emptyEventCounts, type DropshipCostDetectionTickResult } from "../../application/dropship-cost-detection-service";
import { isDropshipCostDetectionWorkerEnabled } from "../../infrastructure/dropship-cost-detection-config";
import { runDropshipCostDetectionTick } from "../../infrastructure/dropship-cost-detection-runner";

const tick: DropshipCostDetectionTickResult = {
  outcome: "completed", passNumber: 1, vendorsProcessed: 2, variantsRead: 3, unavailableReadings: 0, changesRecorded: 3,
  events: { ...emptyEventCounts(), baseline: 3 }, sourceReadFailures: 0,
};

describe("runDropshipCostDetectionTick", () => {
  it("runs one tick with the worker id and vendors per tick it was given", async () => {
    const inputs: unknown[] = [];
    const result = await runDropshipCostDetectionTick({
      workerId: "worker-test",
      vendorsPerTick: 7,
      service: { runTick: async (input) => { inputs.push(input); return tick; } },
    });
    expect(inputs).toEqual([{ workerId: "worker-test", vendorsPerTick: 7 }]);
    expect(result).toEqual(tick);
  });

  it("derives a worker id from the process and the default batch when none is given", async () => {
    const inputs: { workerId: string; vendorsPerTick: number }[] = [];
    await runDropshipCostDetectionTick({ service: { runTick: async (input) => { inputs.push(input); return tick; } } });
    expect(inputs[0]?.workerId).toMatch(/^dropship-cost-detection-\d+$/);
    expect(inputs[0]?.vendorsPerTick).toBe(DEFAULT_COST_DETECTION_VENDORS_PER_TICK);
  });

  it("lets a tick failure surface to the scheduler's error boundary", async () => {
    await expect(runDropshipCostDetectionTick({
      workerId: "worker-test",
      service: { runTick: async () => { throw new Error("database down"); } },
    })).rejects.toThrow("database down");
  });
});

describe("isDropshipCostDetectionWorkerEnabled", () => {
  it("is opt-in, and every off switch wins", () => {
    expect(isDropshipCostDetectionWorkerEnabled({})).toBe(false);
    expect(isDropshipCostDetectionWorkerEnabled({ DROPSHIP_COST_DETECTION_WORKER_ENABLED: "true" })).toBe(true);
    expect(isDropshipCostDetectionWorkerEnabled({ DROPSHIP_COST_DETECTION_WORKER_ENABLED: "TRUE" })).toBe(false);
    expect(isDropshipCostDetectionWorkerEnabled({ DROPSHIP_COST_DETECTION_WORKER_ENABLED: "true", DISABLE_SCHEDULERS: "true" })).toBe(false);
    expect(isDropshipCostDetectionWorkerEnabled({
      DROPSHIP_COST_DETECTION_WORKER_ENABLED: "true", DROPSHIP_COST_DETECTION_WORKER_DISABLED: "true",
    })).toBe(false);
  });
});
