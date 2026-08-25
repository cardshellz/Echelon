import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipCollectionSweepServiceFromEnv } from "./dropship-collection-sweep.factory";
import { createDropshipNoInspectionWatcherServiceFromEnv } from "./dropship-no-inspection-watcher.factory";
import type {
  DropshipCollectionSweepResult,
  RunDropshipCollectionSweepInput,
} from "../application/dropship-collection-sweep-service";
import type { DropshipNoInspectionWatcherResult } from "../application/dropship-no-inspection-watcher-service";

/**
 * Dropship returns maintenance runner (stack 3/4): nightly cadence worker
 * covering the two D3/D5 sweeps that share a schedule:
 *
 *  1. Collection sweep (D5): charge saved funding methods for negative
 *     wallet balances past grace. Idempotent per (vendor, period).
 *  2. No-inspection watcher (D3): queue lost-in-transit RMAs for human
 *     review. Idempotent per RMA.
 *
 * Both follow the existing worker patterns (payment-hold expiration /
 * order-processing): advisory-locked, env-gated, structured logging.
 */

interface CollectionSweepRunnerService {
  runSweep(input: RunDropshipCollectionSweepInput): Promise<DropshipCollectionSweepResult>;
}

interface NoInspectionWatcherRunnerService {
  runWatcher(input: { workerId: string; limit?: number }): Promise<DropshipNoInspectionWatcherResult>;
}

const DROPSHIP_RETURNS_MAINTENANCE_LOCK_ID = 736211;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly tick; the sweep itself is cadence-gated per period
const DEFAULT_BATCH_SIZE = 100;

export async function runDropshipReturnsMaintenanceSweep(input: {
  collectionSweepService?: CollectionSweepRunnerService;
  noInspectionWatcherService?: NoInspectionWatcherRunnerService;
  batchSize?: number;
  workerId?: string;
} = {}): Promise<{
  collection: DropshipCollectionSweepResult;
  noInspection: DropshipNoInspectionWatcherResult;
}> {
  const workerId = input.workerId ?? defaultWorkerId();
  const batchSize = input.batchSize
    ?? envPositiveInteger("DROPSHIP_RETURNS_MAINTENANCE_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const collectionSweepService = input.collectionSweepService
    ?? createDropshipCollectionSweepServiceFromEnv();
  const noInspectionWatcherService = input.noInspectionWatcherService
    ?? createDropshipNoInspectionWatcherServiceFromEnv();

  const collection = await collectionSweepService.runSweep({
    workerId,
    limit: batchSize,
  });
  const noInspection = await noInspectionWatcherService.runWatcher({
    workerId,
    limit: batchSize,
  });
  return { collection, noInspection };
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
        if (
          result.collection.chargedCount > 0
          || result.collection.failedCount > 0
          || result.collection.escalatedCount > 0
          || result.noInspection.queuedCount > 0
        ) {
          console.info(JSON.stringify({
            code: "DROPSHIP_RETURNS_MAINTENANCE_SWEEP_COMPLETED",
            message: "Dropship returns maintenance sweep completed.",
            context: {
              collection: {
                scannedCount: result.collection.scannedCount,
                chargedCount: result.collection.chargedCount,
                failedCount: result.collection.failedCount,
                escalatedCount: result.collection.escalatedCount,
                skippedCount: result.collection.skippedCount,
              },
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
        message: "Dropship returns maintenance sweep failed.",
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
    message: "Dropship returns maintenance worker started.",
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
