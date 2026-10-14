import { describe, expect, it } from "vitest";

import { resolveDropshipWorkerSchedule } from "../../infrastructure/dropship-worker-schedule";

describe("resolveDropshipWorkerSchedule", () => {
  it("assigns deterministic and separated default startup phases", () => {
    const environment = {};

    expect(resolveDropshipWorkerSchedule("listingPush", environment).initialDelayMs).toBe(2_000);
    expect(resolveDropshipWorkerSchedule("orderProcessing", environment).initialDelayMs).toBe(7_000);
    expect(resolveDropshipWorkerSchedule("ebayOrderIntake", environment).initialDelayMs).toBe(30_000);
    expect(resolveDropshipWorkerSchedule("returnIntake", environment).initialDelayMs).toBe(90_000);
    expect(resolveDropshipWorkerSchedule("returnsMaintenance", environment).initialDelayMs).toBe(150_000);
    expect(resolveDropshipWorkerSchedule("usdcWatcher", environment).initialDelayMs).toBe(45_000);
    // The first-mark job (plan PR 9, 10.5): hourly, after the 150 s maintenance phase, on a delay no other worker uses.
    expect(resolveDropshipWorkerSchedule("categoryMarks", environment)).toEqual({
      initialDelayMs: 180_000, initialDelayEnvironmentVariable: "DROPSHIP_CATEGORY_MARKS_WORKER_INITIAL_DELAY_MS",
    });
  });

  it("accepts a non-negative per-worker environment override", () => {
    const resolved = resolveDropshipWorkerSchedule("ebayOrderIntake", {
      DROPSHIP_EBAY_ORDER_INTAKE_WORKER_INITIAL_DELAY_MS: "12345",
    });

    expect(resolved).toEqual({
      initialDelayMs: 12_345,
      initialDelayEnvironmentVariable: "DROPSHIP_EBAY_ORDER_INTAKE_WORKER_INITIAL_DELAY_MS",
    });
  });

  it("uses the safe default for blank, negative, fractional, or nonnumeric overrides", () => {
    for (const configured of ["", "   ", "-1", "1.5", "not-a-number"]) {
      expect(resolveDropshipWorkerSchedule("returnIntake", {
        DROPSHIP_RETURN_INTAKE_WORKER_INITIAL_DELAY_MS: configured,
      }).initialDelayMs).toBe(90_000);
    }
  });
});
