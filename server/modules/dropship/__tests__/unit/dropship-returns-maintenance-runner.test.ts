import { describe, expect, it } from "vitest";
import { runDropshipReturnsMaintenanceSweep } from "../../infrastructure/dropship-returns-maintenance-runner";
import type { DropshipWalletMaintenanceResult } from "../../application/dropship-wallet-maintenance-service";
import type { DropshipVendorStandingReconcileResult } from "../../application/dropship-vendor-standing-service";
import type { DropshipNoInspectionWatcherResult } from "../../application/dropship-no-inspection-watcher-service";

describe("runDropshipReturnsMaintenanceSweep", () => {
  it("runs wallet maintenance, the standing reconcile and the no-inspection watcher in that order with one worker id and batch size", async () => {
    const order: string[] = [];
    const maintenanceInputs: unknown[] = [];
    const standingInputs: unknown[] = [];
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
    const vendorStanding: DropshipVendorStandingReconcileResult = {
      restore: { scannedCount: 1, resumedCount: 1, stillShortCount: 0, failedCount: 0 },
      listingHolds: { scannedCount: 0, appliedCount: 0, deferredCount: 0, failedCount: 0, unavailableCount: 0 },
    };
    const noInspection = { scannedCount: 0, queuedCount: 0, skippedCount: 0 } as unknown as DropshipNoInspectionWatcherResult;

    const result = await runDropshipReturnsMaintenanceSweep({
      workerId: "worker-test",
      batchSize: 25,
      walletMaintenanceService: {
        runMaintenance: async (input) => {
          order.push("wallet");
          maintenanceInputs.push(input);
          return walletMaintenance;
        },
      },
      vendorStandingService: {
        reconcileStanding: async (input) => {
          order.push("standing");
          standingInputs.push(input);
          return vendorStanding;
        },
      },
      noInspectionWatcherService: {
        runWatcher: async (input) => {
          order.push("watcher");
          watcherInputs.push(input);
          return noInspection;
        },
      },
    });

    expect(maintenanceInputs).toEqual([{ workerId: "worker-test", limit: 25 }]);
    expect(standingInputs).toEqual([{ workerId: "worker-test", limit: 25 }]);
    expect(watcherInputs).toEqual([{ workerId: "worker-test", limit: 25 }]);
    // A top-up that settled during wallet maintenance resumes the vendor on the same tick.
    expect(order).toEqual(["wallet", "standing", "watcher"]);
    expect(result).toEqual({ walletMaintenance, vendorStanding, noInspection });
  });
});
