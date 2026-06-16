import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../infrastructure/scheduler-lock", () => ({ withAdvisoryLock: vi.fn() }));

import { getFreezeMaxAgeDays, runCycleCountFreezeGuard } from "../../cycle-count-freeze-guard.scheduler";

describe("getFreezeMaxAgeDays", () => {
  const orig = process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS;
  afterEach(() => {
    if (orig === undefined) delete process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS;
    else process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS = orig;
  });

  it("defaults to 3 days", () => {
    delete process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS;
    expect(getFreezeMaxAgeDays()).toBe(3);
  });
  it("honors a configured value", () => {
    process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS = "7";
    expect(getFreezeMaxAgeDays()).toBe(7);
  });
  it("falls back to default on invalid / non-positive values", () => {
    process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS = "0";
    expect(getFreezeMaxAgeDays()).toBe(3);
    process.env.CYCLE_COUNT_FREEZE_MAX_AGE_DAYS = "nope";
    expect(getFreezeMaxAgeDays()).toBe(3);
  });
});

describe("runCycleCountFreezeGuard", () => {
  it("no-ops (no writes) when nothing is stale", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    const res = await runCycleCountFreezeGuard({ execute } as any);
    expect(res).toEqual({ released: 0 });
    expect(execute).toHaveBeenCalledTimes(1); // only the SELECT, no UPDATEs
  });

  it("releases stale freezes and closes the counts", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { location_id: 1166, location_code: "C-11", cycle_count_id: 108, created_at: "2026-03-22" },
          { location_id: 1187, location_code: "C-06", cycle_count_id: 102, created_at: "2026-03-17" },
        ],
      })
      .mockResolvedValue({});
    const res = await runCycleCountFreezeGuard({ execute } as any);
    expect(res).toEqual({ released: 2 });
    expect(execute).toHaveBeenCalledTimes(3); // SELECT + UPDATE counts + UPDATE locations
  });

  it("swallows errors and reports zero released", async () => {
    const execute = vi.fn().mockRejectedValueOnce(new Error("db down"));
    const res = await runCycleCountFreezeGuard({ execute } as any);
    expect(res).toEqual({ released: 0 });
  });
});
