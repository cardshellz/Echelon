import { describe, expect, it } from "vitest";
import { runDropshipReturnsMaintenanceSweep } from "../../infrastructure/dropship-returns-maintenance-runner";
import type { DropshipWalletMaintenanceResult } from "../../application/dropship-wallet-maintenance-service";
import type { DropshipNoInspectionWatcherResult } from "../../application/dropship-no-inspection-watcher-service";

describe("runDropshipReturnsMaintenanceSweep", () => {
  it("runs wallet maintenance and the no-inspection watcher with the same worker id and batch size", async () => {
    const maintenanceInputs: unknown[] = [];
    const watcherInputs: unknown[] = [];
    const walletMaintenance: DropshipWalletMaintenanceResult = {
      runDate: "2026-05-01",
      scannedCount: 3,
      reloadedCount: 1,
      notNeededCount: 2,
      retryPendingCount: 0,
      attentionCount: 0,
      declinedCount: 0,
      failedCount: 0,
      replayedCount: 0,
      runs: [],
    };
    const noInspection = { scannedCount: 0, queuedCount: 0, skippedCount: 0 } as unknown as DropshipNoInspectionWatcherResult;

    const result = await runDropshipReturnsMaintenanceSweep({
      workerId: "worker-test",
      batchSize: 25,
      walletMaintenanceService: {
        runMaintenance: async (input) => {
          maintenanceInputs.push(input);
          return walletMaintenance;
        },
      },
      noInspectionWatcherService: {
        runWatcher: async (input) => {
          watcherInputs.push(input);
          return noInspection;
        },
      },
    });

    expect(maintenanceInputs).toEqual([{ workerId: "worker-test", limit: 25 }]);
    expect(watcherInputs).toEqual([{ workerId: "worker-test", limit: 25 }]);
    expect(result).toEqual({ walletMaintenance, noInspection });
  });
});
