import { logger } from "../../../platform/observability/logger";
import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import type { CatalogArrivalsTickResult } from "../application/dropship-catalog-arrivals-service";
import { CATALOG_ARRIVALS_ERROR_CODES } from "../domain/catalog-arrivals";
import { createDropshipCatalogArrivalsServiceFromEnv } from "./dropship-catalog-arrivals.factory";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";

/**
 * The catalog arrivals worker (step 1 plan S2-5, PR B; PLAN-B v4.1 §11.1,
 * the eBay sync-back worker's pattern, dropship-marketplace-sync-runner.ts):
 * one tick a minute, in every web process, run by one process at a time
 * through the pinned-client advisory lock runner (CLAUDE.md §9;
 * server/infrastructure/scheduler-lock.ts: `pg_try_advisory_lock` on one
 * pinned connection of the scheduler lock pool, so a busy tick is skipped,
 * never queued across dynos; V3), scheduled without overlap like every other
 * dropship worker. Each tick runs the conversion follow-up, and at most once
 * an hour the arrivals ledger and the new-items notice
 * (dropship-catalog-arrivals-service.ts). Default on (nobody has to turn it
 * on, decision 7): DISABLE_SCHEDULERS or
 * DROPSHIP_CATALOG_ARRIVALS_WORKER_DISABLED stops it in a process (§4.4).
 * Every line goes through the platform logger.
 */

/** What the worker runs each tick: the service, kept for the process (its ledger hour and failure streak live in it). */
export interface CatalogArrivalsTickService {
  runTick(): Promise<CatalogArrivalsTickResult>;
  recordTickFailure(error: unknown, extra?: Record<string, unknown>): void;
}

/**
 * Unused by any other lock (V3, TESTS-14): before this worker a word grep of non-test server/ for it found nothing,
 * and a unit test keeps it on this one line (736210 is sync-back's, 736216 the first-mark job's, 736217 the rules
 * conversion's).
 */
export const DROPSHIP_CATALOG_ARRIVALS_LOCK_ID = 736219;
/** A tick a minute (§11.1): the follow-up runs about a minute after boot; the ledger stage paces itself hourly. */
export const DROPSHIP_CATALOG_ARRIVALS_INTERVAL_MS = 60_000;

/** Default on: only an explicit "true" in either switch turns it off (§4.4). */
export function isDropshipCatalogArrivalsWorkerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DISABLE_SCHEDULERS !== "true" && environment.DROPSHIP_CATALOG_ARRIVALS_WORKER_DISABLED !== "true";
}

/**
 * One locked tick. Null from the lock: another process holds it and runs
 * this minute's tick. The service classifies and logs every failure of its
 * own stages; a failure of the lock runner itself (the lock pool, the
 * server) is handed to it with the scheduler's failure context, so it counts
 * in the same failed-tick streak (FIDELITY-4). Never throws to the scheduler.
 */
export async function runLockedDropshipCatalogArrivalsTick(input: {
  service: CatalogArrivalsTickService;
  lock?: (lockId: number, fn: () => Promise<unknown>) => Promise<unknown>;
}): Promise<void> {
  const lock = input.lock ?? withAdvisoryLock;
  try {
    await lock(DROPSHIP_CATALOG_ARRIVALS_LOCK_ID, () => input.service.runTick());
  } catch (error) {
    input.service.recordTickFailure(error, {
      lock_id: DROPSHIP_CATALOG_ARRIVALS_LOCK_ID,
      // The error as it was thrown (its name, message and code), with both pools' state.
      context: buildSchedulerFailureContext(error),
    });
  }
}

export function startDropshipCatalogArrivalsWorker(
  environment: NodeJS.ProcessEnv = process.env,
  createService: () => CatalogArrivalsTickService = () => createDropshipCatalogArrivalsServiceFromEnv(environment),
): void {
  if (!isDropshipCatalogArrivalsWorkerEnabled(environment)) return;

  // Built on the first tick, then kept: a failed build is retried next tick and never stops the server's boot.
  let service: CatalogArrivalsTickService | null = null;
  const runLockedSweep = async () => {
    try {
      service ??= createService();
    } catch (error) {
      logger.error("dropship.catalog_arrivals.tick_failed", {
        outcome: "failed",
        error_code: CATALOG_ARRIVALS_ERROR_CODES.tickFailed,
        error_class: "fatal",
        lock_id: DROPSHIP_CATALOG_ARRIVALS_LOCK_ID,
        context: buildSchedulerFailureContext(error),
      });
      return;
    }
    await runLockedDropshipCatalogArrivalsTick({ service });
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "catalogArrivals",
    intervalMs: DROPSHIP_CATALOG_ARRIVALS_INTERVAL_MS,
    run: runLockedSweep,
    environment,
  });
  logger.info("dropship.catalog_arrivals.worker_started", {
    outcome: "started",
    interval_ms: DROPSHIP_CATALOG_ARRIVALS_INTERVAL_MS,
    initial_delay_ms: initialDelayMs,
    lock_id: DROPSHIP_CATALOG_ARRIVALS_LOCK_ID,
    // The key's spelling is the scheduling guard's (dropship-worker-runner-scheduling.test.ts), shared by every worker.
    schedulingMode: "completion_delayed_non_overlapping",
  });
}
