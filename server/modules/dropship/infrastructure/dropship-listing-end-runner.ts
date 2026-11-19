import { logger } from "../../../platform/observability/logger";
import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import type { ListingEndTickResult } from "../application/dropship-listing-end-service";
import { LISTING_END_CODES } from "../domain/listing-end-errors";
import { createDropshipListingEndServiceFromEnv } from "./dropship-listing-end.factory";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";

/**
 * The listing end worker (PR C, PLAN-C v4.1 §5.2; D35): one tick every 10 s (the push worker's cycle), in every web
 * process, run by one process at a time through the pinned-client advisory lock runner (CLAUDE.md §9;
 * server/infrastructure/scheduler-lock.ts: a held lock skips the tick, never queues it across dynos), scheduled
 * without overlap like every other dropship worker. Default on: nobody has to turn it on; DISABLE_SCHEDULERS or
 * DROPSHIP_LISTING_END_WORKER_DISABLED stops it in a process. The service's own gates (DRY_RUN, an older catalog
 * code version still running, version 3 not settled) keep it from claiming or sending anything until they open.
 */

export interface ListingEndTickService {
  runTick(): Promise<ListingEndTickResult>;
  recordTickFailure(error: unknown, extra?: Record<string, unknown>): void;
}

/**
 * Unused by any other lock (§5.2, P11): before this worker a word grep of non-test server/ for it found nothing, and a
 * unit test keeps it on this one line (the rules conversion's and the catalog arrivals' ids are the neighbours).
 */
export const DROPSHIP_LISTING_END_LOCK_ID = 736218;
/** A tick every 10 s: the push worker's interval (dropship-listing-push-job-runner.ts). */
export const DROPSHIP_LISTING_END_INTERVAL_MS = 10_000;

/** Default on: only an explicit "true" in either switch turns it off (D35). */
export function isDropshipListingEndWorkerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DISABLE_SCHEDULERS !== "true" && environment.DROPSHIP_LISTING_END_WORKER_DISABLED !== "true";
}

/**
 * One locked tick. The service classifies and logs every failure of its own; a failure of the lock runner itself
 * (the lock pool, the server) is handed to it with the scheduler's failure context. Never throws to the scheduler.
 */
export async function runLockedDropshipListingEndTick(input: {
  service: ListingEndTickService;
  lock?: (lockId: number, fn: () => Promise<unknown>) => Promise<unknown>;
}): Promise<void> {
  const lock = input.lock ?? withAdvisoryLock;
  try {
    await lock(DROPSHIP_LISTING_END_LOCK_ID, () => input.service.runTick());
  } catch (error) {
    input.service.recordTickFailure(error, {
      lock_id: DROPSHIP_LISTING_END_LOCK_ID,
      context: buildSchedulerFailureContext(error),
    });
  }
}

export function startDropshipListingEndWorker(
  environment: NodeJS.ProcessEnv = process.env,
  createService: () => ListingEndTickService = () => createDropshipListingEndServiceFromEnv(environment),
): void {
  if (!isDropshipListingEndWorkerEnabled(environment)) return;

  // Built on the first tick, then kept: a failed build is retried next tick and never stops the server's boot.
  let service: ListingEndTickService | null = null;
  const runLockedSweep = async () => {
    try {
      service ??= createService();
    } catch (error) {
      logger.error("dropship.listing_end.tick_failed", {
        outcome: "failed",
        error_code: LISTING_END_CODES.tickFailed,
        error_class: "fatal",
        lock_id: DROPSHIP_LISTING_END_LOCK_ID,
        context: buildSchedulerFailureContext(error),
      });
      return;
    }
    await runLockedDropshipListingEndTick({ service });
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "listingEnd",
    intervalMs: DROPSHIP_LISTING_END_INTERVAL_MS,
    run: runLockedSweep,
    environment,
  });
  logger.info("dropship.listing_end.worker_started", {
    outcome: "started",
    interval_ms: DROPSHIP_LISTING_END_INTERVAL_MS,
    initial_delay_ms: initialDelayMs,
    lock_id: DROPSHIP_LISTING_END_LOCK_ID,
    // The key's spelling is the scheduling guard's (dropship-worker-runner-scheduling.test.ts), shared by every worker.
    schedulingMode: "completion_delayed_non_overlapping",
  });
}
