import { logger } from "../../../platform/observability/logger";
import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import type { CategoryMarksTickResult } from "../application/dropship-category-marks-job-service";
import { DropshipError } from "../domain/errors";
import { createDropshipCategoryMarksJobServiceFromEnv } from "./dropship-category-marks.factory";
import { mapListingSettingDatabaseError } from "./dropship-listing-setting-writes.repository";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";

/**
 * The first-mark worker (plan PR 9, P28, 10.5): one tick an hour, in every
 * web process, run by one process at a time through the pinned-client
 * advisory lock runner (CLAUDE.md §9; server/infrastructure/scheduler-lock.ts),
 * scheduled without overlap like every other dropship worker. Default-on, as
 * the owner's rule asks (no opt-in flag): DISABLE_SCHEDULERS or
 * DROPSHIP_CATEGORY_MARKS_WORKER_DISABLED stops it in a process, like the
 * listing push worker's switch. Every line goes through the platform logger.
 */

interface CategoryMarksRunnerService {
  runOnce(): Promise<CategoryMarksTickResult>;
}

/** Unused by any other lock (`grep -rn "7362[0-9][0-9]" server`: 736204-736207, 736211-736215). */
export const DROPSHIP_CATEGORY_MARKS_LOCK_ID = 736216;
/** Hourly (plan P28; R:§8.12 "often enough" is a HYPOTHESIS, decided again from the logged `elapsed_ms`). */
export const DROPSHIP_CATEGORY_MARKS_INTERVAL_MS = 60 * 60 * 1000;
const INTERVAL_ENVIRONMENT_VARIABLE = "DROPSHIP_CATEGORY_MARKS_WORKER_INTERVAL_MS";
/**
 * The longest interval the override may set: one day. Node runs a timer over
 * 2,147,483,647 ms (about 24.8 days) after 1 ms instead, so an unbounded value
 * meant as "rarely" would make the job loop, and a value just under that limit
 * would act as a third off switch; the two disable variables are the only ones.
 */
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TICK_FAILED_CODE = "DROPSHIP_CATEGORY_MARKS_TICK_FAILED";

/** Default-on: only an explicit "true" in either switch turns it off. */
export function isDropshipCategoryMarksWorkerEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DISABLE_SCHEDULERS !== "true" && environment.DROPSHIP_CATEGORY_MARKS_WORKER_DISABLED !== "true";
}

/** The interval: a whole number of milliseconds from 1 to one day from the environment, else hourly. */
export function resolveDropshipCategoryMarksIntervalMs(environment: NodeJS.ProcessEnv = process.env): number {
  const value = Number(environment[INTERVAL_ENVIRONMENT_VARIABLE]);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_INTERVAL_MS ? value : DROPSHIP_CATEGORY_MARKS_INTERVAL_MS;
}

/** One tick. A failure surfaces to the worker's error boundary below. */
export async function runDropshipCategoryMarksTick(input: { service?: CategoryMarksRunnerService } = {}): Promise<CategoryMarksTickResult> {
  const service = input.service ?? createDropshipCategoryMarksJobServiceFromEnv();
  return service.runOnce();
}

export function startDropshipCategoryMarksWorker(environment: NodeJS.ProcessEnv = process.env): void {
  if (!isDropshipCategoryMarksWorkerEnabled(environment)) return;

  const intervalMs = resolveDropshipCategoryMarksIntervalMs(environment);
  const runLockedSweep = async () => {
    try {
      // The tick logs its own lines. Null: another process holds the lock, and that process runs this hour's tick.
      await withAdvisoryLock(DROPSHIP_CATEGORY_MARKS_LOCK_ID, () => runDropshipCategoryMarksTick());
    } catch (error) {
      // A tick that failed as a whole (the store list, the lock pool): retried in an hour. The lock runner
      // rethrows the pool's and the server's raw errors (scheduler-lock.ts), so they are classified as the job's
      // own reads classify theirs: a database busy or unreachable is retryable (WARN); anything else would fail
      // every tick, so it needs a human (ERROR).
      const classified = mapListingSettingDatabaseError(error);
      const transient = classified instanceof DropshipError && classified.context?.classification === "transient";
      const entry = {
        outcome: transient ? "deferred" : "failed",
        error_code: classified instanceof DropshipError ? classified.code : TICK_FAILED_CODE,
        error_class: transient ? "transient" : "fatal",
        lock_id: DROPSHIP_CATEGORY_MARKS_LOCK_ID,
        // The error as it was thrown (its name, message and code), with both pools' state.
        context: buildSchedulerFailureContext(error),
      };
      if (transient) logger.warn("dropship.listing_settings.category_marks_tick_failed", entry);
      else logger.error("dropship.listing_settings.category_marks_tick_failed", entry);
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "categoryMarks",
    intervalMs,
    run: runLockedSweep,
    environment,
  });
  logger.info("dropship.listing_settings.category_marks_worker_started", {
    outcome: "started",
    interval_ms: intervalMs,
    initial_delay_ms: initialDelayMs,
    lock_id: DROPSHIP_CATEGORY_MARKS_LOCK_ID,
    // The key's spelling is the scheduling guard's (dropship-worker-runner-scheduling.test.ts), shared by every worker.
    schedulingMode: "completion_delayed_non_overlapping",
  });
}
