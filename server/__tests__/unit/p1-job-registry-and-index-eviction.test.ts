import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { withAdvisoryLockMock, getSchedulerLockPoolSnapshotMock } = vi.hoisted(() => ({
  withAdvisoryLockMock: vi.fn(),
  getSchedulerLockPoolSnapshotMock: vi.fn(() => ({
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  })),
}));

vi.mock("../../infrastructure/scheduler-lock", () => ({
  withAdvisoryLock: withAdvisoryLockMock,
  getSchedulerLockPoolSnapshot: getSchedulerLockPoolSnapshotMock,
}));

import {
  getRegisteredJobsStatusSnapshot,
  registerScheduledJob,
  resetJobRegistryForTest,
} from "../../infrastructure/job-registry";
import { runOneShotIfNeverCompleted } from "../../infrastructure/scheduler-run-registry";
import {
  EBAY_LISTING_RECONCILE_LOCK_ID,
  ECHELON_SYNC_SWEEP_LOCK_ID,
  SHOPIFY_MAPPING_RECONCILE_LOCK_ID,
} from "../../modules/channels/runtime-schedulers.api";
import { EBAY_FULFILLMENT_RECONCILE_LOCK_ID } from "../../modules/oms/channel-order-intake.api";
import {
  OMS_WMS_CANCEL_RECONCILE_LOCK_ID,
  ONE_SHOT_DUPLICATE_SHIPMENT_CLEANUP_LOCK_ID,
  ONE_SHOT_SORT_RANK_RECOMPUTE_LOCK_ID,
} from "../../modules/orders/reconciliation-and-repair.api";
import { WMS_SHIPSTATION_RECONCILE_LOCK_ID } from "../../modules/shipping/engine-and-reconcile.api";

const REPO_ROOT = path.resolve(__dirname, "../../..");

function readRepoFile(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("P1.5 & P1.7 — Canonical Job Registry & server/index.ts Reconciler Eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetJobRegistryForTest();
    withAdvisoryLockMock.mockReset();
    withAdvisoryLockMock.mockImplementation(async <T>(_lockId: number, fn: () => Promise<T>) => {
      return await fn();
    });
  });

  afterEach(() => {
    resetJobRegistryForTest();
    vi.useRealTimers();
  });

  describe("P1.5 — Job Registry contract (mandatory advisory locks, metadata, observability, one-shot ledger)", () => {
    it("enforces mandatory positive 32-bit advisoryLockId and rejects duplicate lock IDs across jobs", () => {
      expect(() =>
        registerScheduledJob({
          name: "invalid.zero_lock",
          cadenceMs: 60_000,
          advisoryLockId: 0,
          writableStates: ["wms.orders.warehouse_status"],
          deadLetterPolicy: "none",
          run: async () => {},
        }),
      ).toThrow(/advisoryLockId/);

      registerScheduledJob({
        name: "jobs.alpha",
        cadenceMs: 60_000,
        advisoryLockId: 991001,
        writableStates: ["wms.orders.warehouse_status"],
        deadLetterPolicy: "review_flag",
        run: async () => {},
      });

      expect(() =>
        registerScheduledJob({
          name: "jobs.beta_duplicate_lock",
          cadenceMs: 60_000,
          advisoryLockId: 991001,
          writableStates: ["oms.oms_orders.status"],
          deadLetterPolicy: "review_flag",
          run: async () => {},
        }),
      ).toThrow(/already registered to 'jobs\.alpha'/);
    });

    it("acquires the PostgreSQL advisory lock on every tick, records telemetry, and surfaces skipped_lock_held when another node holds the lock", async () => {
      const runSpy = vi.fn().mockResolvedValue(undefined);
      const dbExec = vi.fn().mockResolvedValue({ rows: [] });

      const handle = registerScheduledJob({
        name: "jobs.locked_reconciler",
        cadenceMs: 60_000,
        initialDelayMs: 1_000,
        advisoryLockId: 991002,
        writableStates: ["wms.outbound_shipments.status:shipped|cancelled|voided"],
        deadLetterPolicy: "review_flag",
        db: { execute: dbExec },
        run: runSpy,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(withAdvisoryLockMock).toHaveBeenCalledWith(991002, expect.any(Function));
      expect(runSpy).toHaveBeenCalledTimes(1);

      let snapshot = await getRegisteredJobsStatusSnapshot({
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              job_key: "jobs.locked_reconciler",
              last_started_at: new Date("2026-11-19T12:00:00Z"),
              last_completed_at: new Date("2026-11-19T12:00:02Z"),
            },
          ],
        }),
      });
      const entry = snapshot.find((j) => j.name === "jobs.locked_reconciler");
      expect(entry).toBeDefined();
      expect(entry?.advisoryLockId).toBe(991002);
      expect(entry?.lastOutcome).toBe("succeeded");
      expect(entry?.runCount).toBe(1);
      expect(entry?.writableStates).toEqual([
        "wms.outbound_shipments.status:shipped|cancelled|voided",
      ]);
      expect(entry?.deadLetterPolicy).toBe("review_flag");
      expect(entry?.persistedLastCompletedAt).toBe("2026-11-19T12:00:02.000Z");

      // Simulate another dyno holding the advisory lock on the next cadence tick
      withAdvisoryLockMock.mockResolvedValueOnce(null);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runSpy).toHaveBeenCalledTimes(1);

      snapshot = await getRegisteredJobsStatusSnapshot();
      const afterSkip = snapshot.find((j) => j.name === "jobs.locked_reconciler");
      expect(afterSkip?.lastOutcome).toBe("skipped_lock_held");
      expect(afterSkip?.skippedLockHeldCount).toBe(1);

      handle.stop();
    });

    it("gates run-once jobs via public.scheduler_runs so completed one-shot repairs never re-execute", async () => {
      let completedAtIso: string | null = null;
      const dbMock = {
        execute: vi.fn(async () => {
          if (completedAtIso) {
            return {
              rows: [{ last_completed_at: completedAtIso }],
            };
          }
          return { rows: [] };
        }),
      };

      const body = vi.fn(async () => {
        completedAtIso = "2026-11-19T10:00:00.000Z";
      });

      const first = await runOneShotIfNeverCompleted({
        db: dbMock,
        oneShotKey: "oneshot.test_migration_v1",
        logPrefix: "[TestOneShot]",
        run: body,
      });
      expect(first).toEqual({ executed: true, alreadyCompletedAt: null });
      expect(body).toHaveBeenCalledTimes(1);

      const second = await runOneShotIfNeverCompleted({
        db: dbMock,
        oneShotKey: "oneshot.test_migration_v1",
        logPrefix: "[TestOneShot]",
        run: body,
      });
      expect(second.executed).toBe(false);
      expect(second.alreadyCompletedAt).toBe("2026-11-19T10:00:00.000Z");
      expect(body).toHaveBeenCalledTimes(1);
    });
  });

  describe("P1.7 — server/index.ts reconciler & raw SQL eviction contract", () => {
    const serverIndexSrc = readRepoFile("server/index.ts");

    it("eliminates all raw setInterval loops, inline sql`` queries, and raw client.query calls from server/index.ts", () => {
      expect(serverIndexSrc).not.toContain("setInterval(");
      expect(serverIndexSrc).not.toContain("sql`");
      expect(serverIndexSrc).not.toContain("client.query(");
    });

    it("evicts one-shot boot repairs out of server/index.ts into ledger-gated maintenance entrypoints", () => {
      expect(serverIndexSrc).not.toContain("ENABLE_DUP_SHIPMENT_CLEANUP");
      expect(serverIndexSrc).not.toContain("recomputeAllActiveSortRanksDetailed");
      expect(
        fs.existsSync(path.join(REPO_ROOT, "scripts/maintenance/run-one-shot-order-repairs.ts")),
      ).toBe(true);
    });

    it("wires all evicted reconcilers with globally unique advisory lock IDs and exposes job registry status in /api/sync/status", () => {
      const lockIds = [
        ECHELON_SYNC_SWEEP_LOCK_ID,
        EBAY_LISTING_RECONCILE_LOCK_ID,
        EBAY_FULFILLMENT_RECONCILE_LOCK_ID,
        OMS_WMS_CANCEL_RECONCILE_LOCK_ID,
        SHOPIFY_MAPPING_RECONCILE_LOCK_ID,
        WMS_SHIPSTATION_RECONCILE_LOCK_ID,
        918507, // orders.zombie_order_reconcile
        ONE_SHOT_SORT_RANK_RECOMPUTE_LOCK_ID,
        ONE_SHOT_DUPLICATE_SHIPMENT_CLEANUP_LOCK_ID,
      ];
      expect(new Set(lockIds).size).toBe(lockIds.length);

      expect(serverIndexSrc).toContain("startEchelonSyncScheduler(");
      expect(serverIndexSrc).toContain("startEbayListingReconciliationScheduler(");
      expect(serverIndexSrc).toContain("startEbayFulfillmentStuckOrderScheduler(");
      expect(serverIndexSrc).toContain("startOmsWmsCancelReconcileScheduler(");
      expect(serverIndexSrc).toContain("startShopifyMappingReconcileScheduler(");
      expect(serverIndexSrc).toContain("startWmsShipStationReconcileScheduler(");
      expect(serverIndexSrc).toContain('name: "orders.zombie_order_reconcile"');
      expect(serverIndexSrc).toContain("services.inventoryAlerts.warnNegativeInventoryBalances()");

      const syncControlRoutesSrc = readRepoFile(
        "server/modules/channels/interfaces/http/sync-control.routes.ts",
      );
      expect(syncControlRoutesSrc).toContain("getRegisteredJobsStatusSnapshot(");
      expect(syncControlRoutesSrc).toContain("registeredJobs,");
      expect(syncControlRoutesSrc).toContain("schedulerLockPool:");
    });
  });
});
