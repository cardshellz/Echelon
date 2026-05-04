import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipEbayOrderIntakePollServiceFromEnv } from "./dropship-ebay-order-intake.factory";

const DROPSHIP_EBAY_ORDER_INTAKE_WORKER_LOCK_ID = 736206;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 4 * 60;
const DEFAULT_OVERLAP_MINUTES = 15;

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

export function startDropshipEbayOrderIntakeWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_EBAY_ORDER_INTAKE_WORKER_DISABLED === "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger("DROPSHIP_EBAY_ORDER_INTAKE_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_EBAY_ORDER_INTAKE_WORKER_LOCK_ID, async () => {
        const result = await runDropshipEbayOrderIntakeSweep();
        if (
          result.storesScanned > 0
          || result.storesFailed > 0
          || result.ordersCreated > 0
          || result.ordersUpdated > 0
          || result.ordersRejected > 0
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
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  setTimeout(runLockedSweep, Math.min(intervalMs, 5_000));
  setInterval(runLockedSweep, intervalMs);
  console.info(JSON.stringify({
    code: "DROPSHIP_EBAY_ORDER_INTAKE_WORKER_STARTED",
    message: "Dropship eBay order intake worker started.",
    context: { intervalMs },
  }));
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
