import { describe, expect, it, vi } from "vitest";
import {
  SyncRecoveryService,
  type StageResult,
} from "../../sync-recovery.service";

function stage(name: string, data: Record<string, number> = {}): StageResult {
  return { name, ok: true, data };
}

describe("SyncRecoveryService ordering", () => {
  it("drains the local pipeline before source polling and completes recovered source rows", async () => {
    const service = new SyncRecoveryService({}, {});
    const calls: string[] = [];

    vi.spyOn(service, "runShopifyToOmsBackfill").mockImplementation(
      async () => {
        calls.push("shopify_to_oms");
        return stage("shopify_to_oms", { bridged: 17 });
      },
    );
    vi.spyOn(service, "runOmsToWmsBackfill").mockImplementation(
      async (name = "oms_to_wms") => {
        calls.push(name);
        return stage(name, { synced: 17 });
      },
    );
    vi.spyOn(service, "runWmsToShipStationBackfill").mockImplementation(
      async (name = "wms_to_shipstation") => {
        calls.push(name);
        return stage(name, { pushed: 17 });
      },
    );
    vi.spyOn(service, "runShopifyReconcile").mockImplementation(async () => {
      calls.push("shopify_reconcile");
      return stage("shopify_reconcile", { reconciled: 1 });
    });

    const result = await service.runAll();

    expect(calls).toEqual([
      "shopify_to_oms",
      "oms_to_wms",
      "wms_to_shipstation",
      "shopify_reconcile",
      "oms_to_wms_after_shopify_reconcile",
      "wms_to_shipstation_after_shopify_reconcile",
    ]);
    expect(result.allOk).toBe(true);
  });
  it("continues downstream recovery when Shopify readiness advances an existing order", async () => {
    const service = new SyncRecoveryService({}, {});
    const calls: string[] = [];

    vi.spyOn(service, "runShopifyToOmsBackfill").mockResolvedValue(
      stage("shopify_to_oms"),
    );
    vi.spyOn(service, "runOmsToWmsBackfill").mockImplementation(
      async (name = "oms_to_wms") => {
        calls.push(name);
        return stage(name);
      },
    );
    vi.spyOn(service, "runWmsToShipStationBackfill").mockImplementation(
      async (name = "wms_to_shipstation") => {
        calls.push(name);
        return stage(name);
      },
    );
    vi.spyOn(service, "runShopifyReconcile").mockResolvedValue(
      stage("shopify_reconcile", { readinessAdvanced: 4, wmsSyncRequested: 1 }),
    );

    await service.runAll();

    expect(calls).toEqual([
      "oms_to_wms",
      "wms_to_shipstation",
      "oms_to_wms_after_shopify_reconcile",
      "wms_to_shipstation_after_shopify_reconcile",
    ]);
  });

  it("reports skipped: true and allOk: false when overlapping an in-flight run", async () => {
    const service = new SyncRecoveryService({}, {});
    let releaseFirstRun!: () => void;
    vi.spyOn(service, "runShopifyToOmsBackfill").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirstRun = () => resolve(stage("shopify_to_oms"));
        }),
    );
    vi.spyOn(service, "runOmsToWmsBackfill").mockResolvedValue(stage("oms_to_wms"));
    vi.spyOn(service, "runWmsToShipStationBackfill").mockResolvedValue(stage("wms_to_shipstation"));
    vi.spyOn(service, "runShopifyReconcile").mockResolvedValue(stage("shopify_reconcile"));

    const firstRunPromise = service.runAll();
    const overlappingResult = await service.runAll();

    expect(overlappingResult.skipped).toBe(true);
    expect(overlappingResult.allOk).toBe(false);
    expect(overlappingResult.stages[0]?.name).toBe("skipped");

    releaseFirstRun();
    const firstResult = await firstRunPromise;
    expect(firstResult.allOk).toBe(true);
    expect(firstResult.skipped).toBeUndefined();
  });

  it("stamps scheduler_runs completion only when boot and interval runs succeed without skipping", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn().mockResolvedValue({ rows: [] });
      const service = new SyncRecoveryService({ execute }, {});

      // 1st run (boot catch-up): stage fails -> must NOT stamp scheduler_runs
      const runAllSpy = vi
        .spyOn(service, "runAll")
        .mockResolvedValueOnce({
          startedAt: new Date().toISOString(),
          durationMs: 5,
          stages: [{ name: "shopify_to_oms", ok: false, error: "db error" }],
          allOk: false,
        })
        // 2nd run (first interval tick): skipped -> must NOT stamp scheduler_runs
        .mockResolvedValueOnce({
          startedAt: new Date().toISOString(),
          durationMs: 0,
          stages: [{ name: "skipped", ok: true, data: { reason: 0 } }],
          allOk: false,
          skipped: true,
        })
        // 3rd run (second interval tick): allOk -> MUST stamp scheduler_runs
        .mockResolvedValueOnce({
          startedAt: new Date().toISOString(),
          durationMs: 5,
          stages: [{ name: "shopify_to_oms", ok: true }],
          allOk: true,
        });

      const handle = service.startScheduled(1, 100);

      // Boot catch-up fires at 100ms: 1 DB execute for getLastRunAt, 0 for recordRunCompleted
      await vi.advanceTimersByTimeAsync(100);
      expect(runAllSpy).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);

      // First interval tick at +60_000ms: skipped -> 0 additional DB executes
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runAllSpy).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(1);

      // Second interval tick at +60_000ms: succeeded -> 1 additional DB execute for recordRunCompleted
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runAllSpy).toHaveBeenCalledTimes(3);
      expect(execute).toHaveBeenCalledTimes(2);

      handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
