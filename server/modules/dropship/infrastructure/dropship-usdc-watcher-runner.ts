import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";
import { createDropshipUsdcDepositServiceFromEnv } from "./dropship-usdc-deposit.factory";
import type {
  DropshipUsdcScanResult,
  DropshipUsdcSettlementResult,
} from "../application/dropship-usdc-deposit-service";

/**
 * USDC chain watcher (funding design phase 6): every tick scans the next
 * block range for USDC transfers to vendor deposit addresses and credits
 * them, then judges the pending credits against the safe head. Opt-in by
 * environment, advisory-locked so one process scans at a time, scheduled
 * without overlap like every other dropship worker. When no node or key is
 * configured the ticks report `not_configured` and do nothing.
 */

interface UsdcWatcherRunnerService {
  runScan(input: { workerId: string }): Promise<DropshipUsdcScanResult>;
  runSettlement(input: { workerId: string }): Promise<DropshipUsdcSettlementResult>;
}

const DROPSHIP_USDC_WATCHER_LOCK_ID = 736213;
/** Base produces a block every two seconds; half a minute keeps a deposit's wait short without hammering the node. */
const DEFAULT_INTERVAL_MS = 30_000;

export async function runDropshipUsdcWatcherTick(input: {
  service?: UsdcWatcherRunnerService;
  workerId?: string;
} = {}): Promise<{ scan: DropshipUsdcScanResult; settlement: DropshipUsdcSettlementResult }> {
  const workerId = input.workerId ?? defaultWorkerId();
  const service = input.service ?? createDropshipUsdcDepositServiceFromEnv();
  // Scan first, then settle: a transfer already at or below the safe head
  // is credited settled by the scan and never waits for a second tick.
  const scan = await service.runScan({ workerId });
  const settlement = await service.runSettlement({ workerId });
  return { scan, settlement };
}

export function startDropshipUsdcWatcherWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_USDC_WATCHER_DISABLED === "true"
    || process.env.DROPSHIP_USDC_WATCHER_ENABLED !== "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger("DROPSHIP_USDC_WATCHER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_USDC_WATCHER_LOCK_ID, async () => {
        const result = await runDropshipUsdcWatcherTick();
        const { scan, settlement } = result;
        if (
          scan.observedCount > 0
          || scan.failedCount > 0
          || settlement.settledCount > 0
          || settlement.movedCount > 0
          || settlement.voidedCount > 0
          || settlement.failedCount > 0
        ) {
          console.info(JSON.stringify({
            code: "DROPSHIP_USDC_WATCHER_TICK_COMPLETED",
            message: "Dropship USDC watcher tick completed.",
            context: { scan, settlement },
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_USDC_WATCHER_TICK_FAILED",
        message: "Dropship USDC watcher tick failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "usdcWatcher",
    intervalMs,
    run: runLockedSweep,
  });
  console.info(JSON.stringify({
    code: "DROPSHIP_USDC_WATCHER_STARTED",
    message: "Dropship USDC watcher started.",
    context: { intervalMs, initialDelayMs, schedulingMode: "completion_delayed_non_overlapping" },
  }));
}

function defaultWorkerId(): string {
  return `dropship-usdc-watcher-${process.pid}`;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
