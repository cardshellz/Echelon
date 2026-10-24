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
    // The rules conversion job (PR 11e2, plan 9.2): hourly, after the first-mark job's 180 s phase, on a delay no other worker uses.
    expect(resolveDropshipWorkerSchedule("rulesConversion", environment)).toEqual({
      initialDelayMs: 240_000, initialDelayEnvironmentVariable: "DROPSHIP_RULES_CONVERSION_WORKER_INITIAL_DELAY_MS",
    });
    expect(resolveDropshipWorkerSchedule("rulesConversion", { DROPSHIP_RULES_CONVERSION_WORKER_INITIAL_DELAY_MS: "5" }).initialDelayMs).toBe(5);
    // eBay sync-back (plan v4 §6.1): every 15 minutes, after the rules conversion job's 240 s phase, on a delay no other worker uses.
    expect(resolveDropshipWorkerSchedule("marketplaceSyncBack", environment)).toEqual({
      initialDelayMs: 300_000, initialDelayEnvironmentVariable: "DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_INITIAL_DELAY_MS",
    });
    // The catalog arrivals job (PLAN-B v4.1 §11.1): a tick a minute, its first about a minute after boot, on a delay
    // no other worker uses.
    expect(resolveDropshipWorkerSchedule("catalogArrivals", environment)).toEqual({
      initialDelayMs: 60_000, initialDelayEnvironmentVariable: "DROPSHIP_CATALOG_ARRIVALS_WORKER_INITIAL_DELAY_MS",
    });
    expect(resolveDropshipWorkerSchedule("catalogArrivals", { DROPSHIP_CATALOG_ARRIVALS_WORKER_INITIAL_DELAY_MS: "0" }).initialDelayMs).toBe(0);
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
