import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import {
  createDropshipEbayReturnIntakePollServiceFromEnv,
  createDropshipShopifyReturnIntakePollServiceFromEnv,
} from "./dropship-return-intake.factory";
import type { DropshipReturnIntakeSweepResult } from "../application/dropship-return-intake-poll-service";

/**
 * Channel return-intake runner (stack 4/4; design spec D2a): polls connected
 * eBay + Shopify stores for channel returns and feeds the RMA draft pipeline.
 * Follows the eBay order-intake worker pattern: advisory-locked, env-gated,
 * structured logging.
 */

interface ReturnIntakePollRunnerService {
  pollConnectedStores(input: {
    limit: number;
    initialLookbackMinutes: number;
    overlapMinutes: number;
  }): Promise<DropshipReturnIntakeSweepResult>;
}

const DROPSHIP_RETURN_INTAKE_WORKER_LOCK_ID = 736212;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_INITIAL_LOOKBACK_MINUTES = 4 * 60;
const DEFAULT_OVERLAP_MINUTES = 15;

export async function runDropshipReturnIntakeSweep(input: {
  ebayPollService?: ReturnIntakePollRunnerService;
  shopifyPollService?: ReturnIntakePollRunnerService;
  batchSize?: number;
  initialLookbackMinutes?: number;
  overlapMinutes?: number;
} = {}): Promise<{
  ebay: DropshipReturnIntakeSweepResult;
  shopify: DropshipReturnIntakeSweepResult;
}> {
  const batchSize = input.batchSize
    ?? envPositiveInteger("DROPSHIP_RETURN_INTAKE_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const initialLookbackMinutes = input.initialLookbackMinutes
    ?? envPositiveInteger("DROPSHIP_RETURN_INTAKE_INITIAL_LOOKBACK_MINUTES", DEFAULT_INITIAL_LOOKBACK_MINUTES);
  const overlapMinutes = input.overlapMinutes
    ?? envPositiveInteger("DROPSHIP_RETURN_INTAKE_OVERLAP_MINUTES", DEFAULT_OVERLAP_MINUTES);

  const ebay = await (input.ebayPollService ?? createDropshipEbayReturnIntakePollServiceFromEnv())
    .pollConnectedStores({ limit: batchSize, initialLookbackMinutes, overlapMinutes });
  const shopify = await (input.shopifyPollService ?? createDropshipShopifyReturnIntakePollServiceFromEnv())
    .pollConnectedStores({ limit: batchSize, initialLookbackMinutes, overlapMinutes });
  return { ebay, shopify };
}

export function startDropshipReturnIntakeWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_RETURN_INTAKE_WORKER_DISABLED === "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger("DROPSHIP_RETURN_INTAKE_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_RETURN_INTAKE_WORKER_LOCK_ID, async () => {
        const result = await runDropshipReturnIntakeSweep();
        for (const perPlatform of [result.ebay, result.shopify]) {
          if (
            perPlatform.storesScanned > 0
            || perPlatform.storesFailed > 0
            || perPlatform.returnsCreated > 0
            || perPlatform.returnsExcepted > 0
            || perPlatform.returnsFailed > 0
          ) {
            console.info(JSON.stringify({
              code: "DROPSHIP_RETURN_INTAKE_SWEEP_COMPLETED",
              message: "Dropship channel return intake sweep completed.",
              context: perPlatform,
            }));
          }
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_RETURN_INTAKE_SWEEP_FAILED",
        message: "Dropship channel return intake sweep failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "returnIntake",
    intervalMs,
    run: runLockedSweep,
  });
  console.info(JSON.stringify({
    code: "DROPSHIP_RETURN_INTAKE_WORKER_STARTED",
    message: "Dropship channel return intake worker started.",
    context: { intervalMs, initialDelayMs, schedulingMode: "completion_delayed_non_overlapping" },
  }));
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
