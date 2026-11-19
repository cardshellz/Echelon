import { logger } from "../../../platform/observability/logger";
import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { DropshipError } from "../domain/errors";
import { classifyMarketplaceSyncError } from "../domain/marketplace-sync-errors";
import { MARKETPLACE_SYNC_INTERVAL_MS } from "../domain/marketplace-sync-sweep";
import { createDropshipMarketplaceSyncServiceFromEnv } from "./dropship-marketplace-sync.factory";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";

/**
 * eBay sync-back's worker (plan v4 §6.1, the rules conversion worker's
 * pattern, dropship-rules-conversion-runner.ts): one tick every 15 minutes, in
 * every web process, run by one process at a time through the pinned-client
 * advisory lock runner (CLAUDE.md §9; server/infrastructure/scheduler-lock.ts:
 * a session lock on one pinned connection of the scheduler lock pool, never
 * pg_advisory_lock on the pooled handle), scheduled without overlap like every
 * other dropship worker. Each listing's writes take the store lock as
 * pg_advisory_xact_lock inside their own transaction (the sync repository).
 * Default on (nobody has to turn it on): DISABLE_SCHEDULERS or
 * DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_DISABLED stops it in a process. Every
 * line goes through the platform logger.
 */

/** Unused by any other lock (plan v4 SB15; `grep -rn 7362 server` finds 736204, 736207, 736211, 736216, 736217 before this). */
export const DROPSHIP_MARKETPLACE_SYNC_BACK_LOCK_ID = 736210;
const INTERVAL_ENVIRONMENT_VARIABLE = "DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_INTERVAL_MS";
/**
 * The longest interval the override may set: one day. Node runs a timer over
 * 2,147,483,647 ms after 1 ms instead, so an unbounded value would make the
 * job loop; the two disable variables are the only off switches.
 */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TICK_FAILED_CODE = "DROPSHIP_MARKETPLACE_SYNC_TICK_FAILED";

/** Default on: only an explicit "true" in either switch turns it off. */
export function isDropshipMarketplaceSyncBackWorkerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DISABLE_SCHEDULERS !== "true" && environment.DROPSHIP_MARKETPLACE_SYNC_BACK_WORKER_DISABLED !== "true";
}

/** The interval: a whole number of milliseconds from 1 to one day from the environment, else 15 minutes. */
export function resolveDropshipMarketplaceSyncBackIntervalMs(environment: NodeJS.ProcessEnv = process.env): number {
  const value = Number(environment[INTERVAL_ENVIRONMENT_VARIABLE]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_INTERVAL_MS ? value : MARKETPLACE_SYNC_INTERVAL_MS;
}

/**
 * One locked tick with its error boundary. Null from the lock: another process
 * holds it and runs this interval's tick. A tick that failed as a whole (the
 * store list, the lock pool, a broken invariant) is retried at the next
 * interval: a database busy or unreachable is transient (WARN); anything else
 * would fail every tick, so it needs a human (ERROR).
 */
export async function runLockedDropshipMarketplaceSyncBackTick(input: {
  run?: () => Promise<unknown>;
  lock?: (lockId: number, fn: () => Promise<unknown>) => Promise<unknown>;
} = {}): Promise<void> {
  const run = input.run ?? (() => createDropshipMarketplaceSyncServiceFromEnv().runSweepTick());
  const lock = input.lock ?? withAdvisoryLock;
  try {
    await lock(DROPSHIP_MARKETPLACE_SYNC_BACK_LOCK_ID, run);
  } catch (error) {
    // An unknown error classifies as transient but at ERROR (marketplace-sync-errors.ts): it needs a human, so it is "failed".
    const classified = classifyMarketplaceSyncError(error);
    const transient = classified.classification === "transient" && classified.logLevel !== "error";
    const entry = {
      outcome: transient ? "deferred" : "failed",
      error_code: error instanceof DropshipError ? error.code : classified.code === "UNEXPECTED_ERROR" ? TICK_FAILED_CODE : classified.code,
      error_class: transient ? "transient" : "fatal",
      lock_id: DROPSHIP_MARKETPLACE_SYNC_BACK_LOCK_ID,
      // The error as it was thrown (its name, message and code), with both pools' state.
      context: buildSchedulerFailureContext(error),
    };
    if (transient) logger.warn("dropship.marketplace_sync.tick_failed", entry);
    else logger.error("dropship.marketplace_sync.tick_failed", entry);
  }
}

export function startDropshipMarketplaceSyncBackWorker(environment: NodeJS.ProcessEnv = process.env): void {
  if (!isDropshipMarketplaceSyncBackWorkerEnabled(environment)) return;

  const intervalMs = resolveDropshipMarketplaceSyncBackIntervalMs(environment);
  const runLockedSweep = () => runLockedDropshipMarketplaceSyncBackTick();
  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "marketplaceSyncBack",
    intervalMs,
    run: runLockedSweep,
    environment,
  });
  logger.info("dropship.marketplace_sync.worker_started", {
    outcome: "started",
    interval_ms: intervalMs,
    initial_delay_ms: initialDelayMs,
    lock_id: DROPSHIP_MARKETPLACE_SYNC_BACK_LOCK_ID,
    // The key's spelling is the scheduling guard's (dropship-worker-runner-scheduling.test.ts), shared by every worker.
    schedulingMode: "completion_delayed_non_overlapping",
  });
}
