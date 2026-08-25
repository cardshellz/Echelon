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
