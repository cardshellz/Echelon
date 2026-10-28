import { logger } from "../../../platform/observability/logger";
import { startNonOverlappingScheduler, type NonOverlappingSchedulerHandle, type NonOverlappingSchedulerOptions } from "../../../infrastructure/non-overlapping-scheduler";
import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import type { StockLinkTickSummary } from "../application/stock-link.service";
import { STOCK_LINK_DISABLE_ENV, stockLinkRunnerDisableReason } from "./stock-link-runner-switch";

export { STOCK_LINK_DISABLE_ENV, stockLinkRunnerDisableReason };

/**
 * The stock-link engine's runner (channels PR2, PLAN-CH2 v4.1 §7.1): one tick every 60 s, scheduled in every web
 * process without overlap (the interval is measured from completion), and run by one process of the cluster at a time
 * through the pinned-client advisory lock runner (CLAUDE.md §9; server/infrastructure/scheduler-lock.ts: a held lock
 * skips the tick, it never queues behind another dyno). Default on: nothing has to be turned on (D-A). The kill switches
 * are DISABLE_SCHEDULERS (every scheduler) and STOCK_LINK_AUTO_DISABLED (this one, every store; the first line of the
 * rollback, §21). Existing links keep sending stock either way: the outbox worker is independent of this runner.
 */

export interface StockLinkTickService {
  tick(): Promise<StockLinkTickSummary>;
  recordTickFailure(error: unknown, extra?: Readonly<Record<string, unknown>>): void;
}

/**
 * Unused by any other lock (§7.1, C19): before this runner a word grep of the whole tree found neither it nor its nine
 * successors (BUILD-NOTES P0), and a unit test keeps it on this one line of non-test server/ source.
 */
export const STOCK_LINK_LOCK_ID = 736220;
/** A tick every 60 s (§7.1); the tick itself stops new work at 30 s and provider calls at 45 s (C27). */
export const STOCK_LINK_INTERVAL_MS = 60_000;
/** The first tick 30 s after boot, so a deploy's boot work and its workers' first runs are not all at once. */
export const STOCK_LINK_INITIAL_DELAY_MS = 30_000;

const ACTION = "inventory_availability.stock_link.runner";

/**
 * One locked tick. The service classifies and logs every failure of its own and never throws; a failure of the lock
 * runner itself (its pool, the server) is handed to it with the scheduler's failure context. Never throws to the
 * scheduler.
 */
export async function runLockedStockLinkTick(input: {
  service: StockLinkTickService;
  lock?: (lockId: number, fn: () => Promise<unknown>) => Promise<unknown>;
}): Promise<void> {
  const lock = input.lock ?? withAdvisoryLock;
  try {
    await lock(STOCK_LINK_LOCK_ID, () => input.service.tick());
  } catch (error) {
    input.service.recordTickFailure(error, { lock_id: STOCK_LINK_LOCK_ID, context: buildSchedulerFailureContext(error) });
  }
}

/** Starts the runner unless a kill switch is on; the returned handle stops it (server close hook). */
export function startStockLinkRunner(service: StockLinkTickService, environment: NodeJS.ProcessEnv = process.env,
  schedule: (options: NonOverlappingSchedulerOptions) => NonOverlappingSchedulerHandle = startNonOverlappingScheduler):
  NonOverlappingSchedulerHandle | null {
  const disabled = stockLinkRunnerDisableReason(environment);
  if (disabled !== null) {
    logger.info(ACTION, { outcome: "disabled", reason: disabled, lock_id: STOCK_LINK_LOCK_ID });
    return null;
  }
  const handle = schedule({
    taskName: "stock-link",
    initialDelayMs: STOCK_LINK_INITIAL_DELAY_MS,
    intervalMs: STOCK_LINK_INTERVAL_MS,
    run: () => runLockedStockLinkTick({ service }),
    // Only a failure that escaped runLockedStockLinkTick reaches here (a bug): it needs a person.
    logger: { error: payload => logger.error(ACTION, { outcome: "failed", error_code: payload.code, error_class: "fatal",
      lock_id: STOCK_LINK_LOCK_ID, context: payload.context }) },
  });
  logger.info(ACTION, { outcome: "started", interval_ms: STOCK_LINK_INTERVAL_MS, initial_delay_ms: STOCK_LINK_INITIAL_DELAY_MS,
    lock_id: STOCK_LINK_LOCK_ID, schedulingMode: "completion_delayed_non_overlapping" });
  return handle;
}
