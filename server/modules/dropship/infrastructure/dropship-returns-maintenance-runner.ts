import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipWalletMaintenanceServiceFromEnv } from "./dropship-wallet-maintenance.factory";
import { createDropshipNoInspectionWatcherServiceFromEnv } from "./dropship-no-inspection-watcher.factory";
import { createDropshipVendorStandingServiceFromEnv } from "./dropship-vendor-standing.factory";
import type {
  DropshipWalletMaintenanceResult,
  RunDropshipWalletMaintenanceInput,
} from "../application/dropship-wallet-maintenance-service";
import type {
  DropshipVendorStandingReconcileResult,
  ReconcileDropshipVendorStandingInput,
} from "../application/dropship-vendor-standing-service";
import type { DropshipNoInspectionWatcherResult } from "../application/dropship-no-inspection-watcher-service";

/**
 * Dropship maintenance runner: an hourly tick covering three jobs that share
 * a schedule.
 *
 *  1. Wallet maintenance: once per vendor per UTC day, top every active
 *     vendor's wallet up to its minimum through the routine auto-reload.
 *     Transient provider failures retry on the next tick. Replaces the
 *     weekly collection sweep (D5), which only collected the negative amount.
 *  2. Vendor standing reconcile: resume any vendor paused for funding whose
 *     wallet is funded again, and retry listing holds or releases that were
 *     deferred when the standing changed. Runs after wallet maintenance so a
 *     top-up that just settled resumes the vendor on the same tick.
 *  3. No-inspection watcher (D3): queue lost-in-transit RMAs for human
 *     review. Idempotent per RMA.
 *
 * The worker keeps its historical name and environment variables
 * (`DROPSHIP_RETURNS_MAINTENANCE_*`) so existing deployments do not silently
 * lose the schedule. All jobs follow the existing worker patterns
 * (payment-hold expiration / order-processing): advisory-locked, env-gated,
 * structured logging.
 */

interface WalletMaintenanceRunnerService {
  runMaintenance(input: RunDropshipWalletMaintenanceInput): Promise<DropshipWalletMaintenanceResult>;
}

interface VendorStandingRunnerService {
  reconcileStanding(input: ReconcileDropshipVendorStandingInput): Promise<DropshipVendorStandingReconcileResult>;
}

interface NoInspectionWatcherRunnerService {
  runWatcher(input: { workerId: string; limit?: number }): Promise<DropshipNoInspectionWatcherResult>;
}

const DROPSHIP_RETURNS_MAINTENANCE_LOCK_ID = 736211;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly tick; wallet maintenance is once-per-day per vendor, retries ride the tick
const DEFAULT_BATCH_SIZE = 100;

export async function runDropshipReturnsMaintenanceSweep(input: {
  walletMaintenanceService?: WalletMaintenanceRunnerService;
  vendorStandingService?: VendorStandingRunnerService;
  noInspectionWatcherService?: NoInspectionWatcherRunnerService;
  batchSize?: number;
  workerId?: string;
} = {}): Promise<{
  walletMaintenance: DropshipWalletMaintenanceResult;
  vendorStanding: DropshipVendorStandingReconcileResult;
  noInspection: DropshipNoInspectionWatcherResult;
}> {
  const workerId = input.workerId ?? defaultWorkerId();
  const batchSize = input.batchSize
    ?? envPositiveInteger("DROPSHIP_RETURNS_MAINTENANCE_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const walletMaintenanceService = input.walletMaintenanceService
    ?? createDropshipWalletMaintenanceServiceFromEnv();
  const vendorStandingService = input.vendorStandingService
    ?? createDropshipVendorStandingServiceFromEnv();
  const noInspectionWatcherService = input.noInspectionWatcherService
    ?? createDropshipNoInspectionWatcherServiceFromEnv();

  const walletMaintenance = await walletMaintenanceService.runMaintenance({
    workerId,
    limit: batchSize,
  });
  const vendorStanding = await vendorStandingService.reconcileStanding({
    workerId,
    limit: batchSize,
  });
  const noInspection = await noInspectionWatcherService.runWatcher({
    workerId,
    limit: batchSize,
  });
  return { walletMaintenance, vendorStanding, noInspection };
}

export function startDropshipReturnsMaintenanceWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_RETURNS_MAINTENANCE_WORKER_DISABLED === "true"
    || process.env.DROPSHIP_RETURNS_MAINTENANCE_WORKER_ENABLED !== "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger(
    "DROPSHIP_RETURNS_MAINTENANCE_WORKER_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  );
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_RETURNS_MAINTENANCE_LOCK_ID, async () => {
        const result = await runDropshipReturnsMaintenanceSweep();
        const wallet = result.walletMaintenance;
        const standing = result.vendorStanding;
        if (
          wallet.reloadedCount > 0
          || wallet.retryPendingCount > 0
          || wallet.attentionCount > 0
          || wallet.declinedCount > 0
          || wallet.failedCount > 0
          || standing.restore.scannedCount > 0
          || standing.listingHolds.scannedCount > 0
          || result.noInspection.queuedCount > 0
        ) {
          console.info(JSON.stringify({
            code: "DROPSHIP_RETURNS_MAINTENANCE_SWEEP_COMPLETED",
            message: "Dropship maintenance sweep completed.",
            context: {
              walletMaintenance: {
                runDate: wallet.runDate,
                scannedCount: wallet.scannedCount,
                reloadedCount: wallet.reloadedCount,
                notNeededCount: wallet.notNeededCount,
                retryPendingCount: wallet.retryPendingCount,
                attentionCount: wallet.attentionCount,
                declinedCount: wallet.declinedCount,
                failedCount: wallet.failedCount,
                replayedCount: wallet.replayedCount,
              },
              vendorStanding: standing,
              noInspection: {
                scannedCount: result.noInspection.scannedCount,
                queuedCount: result.noInspection.queuedCount,
                skippedCount: result.noInspection.skippedCount,
              },
            },
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_RETURNS_MAINTENANCE_SWEEP_FAILED",
        message: "Dropship maintenance sweep failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "returnsMaintenance",
    intervalMs,
    run: runLockedSweep,
  });
  console.info(JSON.stringify({
    code: "DROPSHIP_RETURNS_MAINTENANCE_WORKER_STARTED",
    message: "Dropship maintenance worker started.",
    context: { intervalMs, initialDelayMs, schedulingMode: "completion_delayed_non_overlapping" },
  }));
}

function defaultWorkerId(): string {
  return `dropship-returns-maintenance-${process.pid}`;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
