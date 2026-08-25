import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipEbayOrderIntakePollServiceFromEnv } from "./dropship-ebay-order-intake.factory";
import { createDropshipOrderIntakeHealthServiceFromEnv } from "./dropship-order-intake-health.factory";

const DROPSHIP_EBAY_ORDER_INTAKE_WORKER_LOCK_ID = 736206;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 4 * 60;
const DEFAULT_OVERLAP_MINUTES = 15;
const DEFAULT_HEALTH_MONITOR_LIMIT = 1000;

export async function runDropshipEbayOrderIntakeSweep(input: {
  batchSize?: number;
  initialLookbackMinutes?: number;
  overlapMinutes?: number;
} = {}) {
  const batchSize = input.batchSize
    ?? envPositiveInteger("DROPSHIP_EBAY_ORDER_INTAKE_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const initialLookbackMinutes = input.initialLookbackMinutes
    ?? envPositiveInteger("DROPSHIP_EBAY_ORDER_INTAKE_INITIAL_LOOKBACK_MINUTES", DEFAULT_INITIAL_LOOKBACK_MINUTES);
  const overlapMinutes = input.overlapMinutes
    ?? envPositiveInteger("DROPSHIP_EBAY_ORDER_INTAKE_OVERLAP_MINUTES", DEFAULT_OVERLAP_MINUTES);

  return createDropshipEbayOrderIntakePollServiceFromEnv().pollConnectedStores({
    limit: batchSize,
    initialLookbackMinutes,
    overlapMinutes,
  });
}

export async function runDropshipEbayOrderIntakeHealthMonitor(input: {
  limit?: number;
} = {}) {
  return createDropshipOrderIntakeHealthServiceFromEnv().monitorStalePolls({
    platform: "ebay",
    limit: input.limit ?? DEFAULT_HEALTH_MONITOR_LIMIT,
  });
}

export function startDropshipEbayOrderIntakeWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_EBAY_ORDER_INTAKE_WORKER_DISABLED === "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger("DROPSHIP_EBAY_ORDER_INTAKE_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const runLockedSweep = async () => {
    // Check the previous heartbeat before polling. This preserves evidence of a
    // complete worker/dyno outage across restart instead of letting the first
    // successful poll erase the missed-heartbeat interval.
    try {
      await withAdvisoryLock(DROPSHIP_EBAY_ORDER_INTAKE_WORKER_LOCK_ID, async () => {
        const result = await runDropshipEbayOrderIntakeHealthMonitor();
        if (result.storesTransitioned > 0) {
          console.warn(JSON.stringify({
            code: "DROPSHIP_ORDER_INTAKE_HEALTH_MONITOR_TRANSITIONED",
            message: "Dropship order-intake health monitor changed one or more store states.",
            context: result,
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_ORDER_INTAKE_HEALTH_MONITOR_FAILED",
        message: "Dropship order-intake health monitor failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }

    try {
      await withAdvisoryLock(DROPSHIP_EBAY_ORDER_INTAKE_WORKER_LOCK_ID, async () => {
        const result = await runDropshipEbayOrderIntakeSweep();
        if (
          result.storesScanned > 0
          || result.storesFailed > 0
          || result.ordersCreated > 0
          || result.ordersUpdated > 0
          || result.ordersRejected > 0
          || result.ordersConflicted > 0
        ) {
          console.info(JSON.stringify({
            code: "DROPSHIP_EBAY_ORDER_INTAKE_SWEEP_COMPLETED",
            message: "Dropship eBay order intake sweep completed.",
            context: result,
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_EBAY_ORDER_INTAKE_SWEEP_FAILED",
        message: "Dropship eBay order intake sweep failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "ebayOrderIntake",
    intervalMs,
    run: runLockedSweep,
  });
  console.info(JSON.stringify({
    code: "DROPSHIP_EBAY_ORDER_INTAKE_WORKER_STARTED",
    message: "Dropship eBay order intake worker started.",
    context: { intervalMs, initialDelayMs, schedulingMode: "completion_delayed_non_overlapping" },
  }));
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
