import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";
import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipListingPushWorkerServiceFromEnv } from "./dropship-listing-push-worker.factory";
import { createDropshipListingPushRecoveryFromEnv } from "./dropship-listing-push-recovery.factory";
import type { DropshipListingPushRecoveryResult } from "../application/dropship-listing-push-recovery-service";
import { makeDropshipListingPushWorkerLogger } from "../application/dropship-listing-push-worker-service";
import type { DropshipLogger } from "../application/dropship-ports";
import { logger } from "../../../platform/observability/logger";
import { createDropshipListingPushRunSweepServiceFromEnv } from "./dropship-listing-push-run.factory";

/** Repairs the sweep runs before claiming jobs (dropship-listing-push-recovery-service). */
export interface DropshipListingPushSweepRecovery {
  run(input: { workerId: string }): Promise<DropshipListingPushRecoveryResult>;
}

/**
 * The publish run steps of a sweep (step 1 plan S2-5, §4.3-§4.4), run before
 * any job under the sweep's own lock: reconcile and finish, then expand.
 */
export interface DropshipListingPushRunSweepSteps {
  reconcileAndFinish(): Promise<{ changed: number; finished: number }>;
  expandRuns(): Promise<{ attempted: number; queued: number }>;
}

export interface DropshipListingPushJobQueueRepository {
  listClaimableJobIds(input: {
    limit: number;
    now: Date;
    staleAfterMinutes: number;
  }): Promise<number[]>;
}

interface JobIdRow {
  id: number;
}

const DROPSHIP_LISTING_PUSH_WORKER_LOCK_ID = 736204;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_STALE_PROCESSING_MINUTES = 30;

export class PgDropshipListingPushJobQueueRepository implements DropshipListingPushJobQueueRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listClaimableJobIds(input: {
    limit: number;
    now: Date;
    staleAfterMinutes: number;
  }): Promise<number[]> {
    // A queued job paused while the marketplace was busy waits for its next attempt (§4.3, §4.5). A run's chunk job is
    // claimed only once its chunk is recorded (no target of the chunk still pending): the record step decides a stop
    // that raced the queue, so no item may start before it, whoever runs the sweep (review MC10).
    const result = await this.dbPool.query<JobIdRow>(
      `SELECT j.id
       FROM dropship.dropship_listing_push_jobs j
       WHERE ((
            j.status = 'queued'
            AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= $2::timestamptz)
          )
          OR (
            j.status = 'processing'
            AND j.updated_at <= $2::timestamptz - ($3::text)::interval
          ))
         AND NOT EXISTS (SELECT 1 FROM dropship.dropship_listing_push_run_targets t
                         WHERE t.run_id = j.run_id AND t.chunk_index = j.run_chunk_index AND t.outcome = 'pending')
       ORDER BY j.created_at ASC, j.id ASC
       LIMIT $1`,
      [input.limit, input.now, `${input.staleAfterMinutes} minutes`],
    );
    return result.rows.map((row) => row.id);
  }
}

export async function runDropshipListingPushJob(input: {
  jobId: number;
  workerId?: string;
  idempotencyKey?: string;
  staleProcessingMinutes?: number;
}): Promise<void> {
  const workerId = input.workerId ?? defaultWorkerId();
  await createDropshipListingPushWorkerServiceFromEnv().processJob({
    jobId: input.jobId,
    workerId,
    idempotencyKey: input.idempotencyKey ?? defaultListingPushJobIdempotencyKey(input.jobId),
    staleProcessingMinutes: input.staleProcessingMinutes,
  });
}

export async function runDropshipListingPushSweep(input: {
  repository?: DropshipListingPushJobQueueRepository;
  processJob?: (input: {
    jobId: number;
    workerId: string;
    idempotencyKey: string;
    staleProcessingMinutes: number;
  }) => Promise<void>;
  batchSize?: number;
  staleProcessingMinutes?: number;
  now?: Date;
  workerId?: string;
  /**
   * Run before jobs are listed, so a listing restored live or a push queued
   * again is handled in this same sweep. Only the scheduled sweep passes it.
   */
  recovery?: DropshipListingPushSweepRecovery;
  /** The structured logger the recovery's outcome is logged through (the worker's by default). */
  logger?: DropshipLogger;
  runs?: DropshipListingPushRunSweepSteps;
  /**
   * Runs the publish run steps under the sweep lock and says whether they ran. The scheduled sweep already holds
   * it (startDropshipListingPushWorker) and passes none; any other caller must (runAdminListingPushSweep).
   */
  runStepsGuard?: (steps: () => Promise<void>) => Promise<boolean>;
} = {}): Promise<{ processed: number; failed: number; runStepsSkipped?: number }> {
  const repository = input.repository ?? new PgDropshipListingPushJobQueueRepository();
  const batchSize = input.batchSize ?? envPositiveInteger("DROPSHIP_LISTING_PUSH_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const staleProcessingMinutes = input.staleProcessingMinutes
    ?? envPositiveInteger("DROPSHIP_LISTING_PUSH_STALE_PROCESSING_MINUTES", DEFAULT_STALE_PROCESSING_MINUTES);
  const now = input.now ?? new Date();
  const workerId = input.workerId ?? defaultWorkerId();
  // One sweep, in this order (both under the 736204 lock in the scheduled sweep):
  // 1. Recovery (PR 1b, then Fix PR 2a's stock link step): a demoted live listing is restored, an account-check refusal
  //    queued again, then a stock link failure re-queued (or re-sent once) when its policy allows. First, so the run
  //    pre-filter below reads the restored status (a `not_live` run then skips a listing eBay already lists as already
  //    live instead of sending it again), and so a requeued job is claimed in this sweep. Neither requeue selects a
  //    publish run's chunk job (run_id null, ops repository): a run reports its sizes once, when it finishes.
  // 2. Publish run steps (PR A, §4.3-§4.4): reconcile and finish, then expand, so a chunk's job is queued and recorded
  //    before any item of it can start (§4.3 step 4).
  // 3. Claims.
  // Each step logs its own failure and the next one still runs.
  if (input.recovery) await runRecoveryBeforeJobs(input.recovery, workerId, input.logger ?? makeDropshipListingPushWorkerLogger());
  const steps = input.runs ?? createDropshipListingPushRunSweepServiceFromEnv();
  const ranSteps = input.runStepsGuard
    ? await input.runStepsGuard(() => runPublishRunSteps(steps))
    : (await runPublishRunSteps(steps), true);
  if (!ranSteps) {
    // Expected while the scheduled sweep runs: its own pass does the run steps (DEBUG, CLAUDE.md §10).
    logger.debug("dropship.listing_push_run.steps_skipped", { outcome: "skipped", reason: "sweep_lock_held" });
  }
  const jobIds = await repository.listClaimableJobIds({
    limit: batchSize,
    now,
    staleAfterMinutes: staleProcessingMinutes,
  });
  let processed = 0;
  let failed = 0;
  const processJob = input.processJob ?? runDropshipListingPushJob;
  for (const jobId of jobIds) {
    try {
      await processJob({
        jobId,
        workerId,
        idempotencyKey: defaultListingPushJobIdempotencyKey(jobId),
        staleProcessingMinutes,
      });
      processed += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({
        code: "DROPSHIP_LISTING_PUSH_SWEEP_JOB_FAILED",
        message: "Dropship listing push sweep failed to process a job.",
        context: {
          jobId,
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
    // A run whose chunk job just ended (or that was stopped while it ran) finishes now, not after the rest of the
    // batch (verify V1): reconcile and finish only, under the same lock as the steps above; it is index-driven.
    if (ranSteps) {
      if (input.runStepsGuard) await input.runStepsGuard(() => runReconcileStep(steps));
      else await runReconcileStep(steps);
    }
  }
  return { processed, failed, ...(ranSteps ? {} : { runStepsSkipped: 1 }) };
}

/**
 * The publish run steps under the push sweep's lock (736204, the pinned-client session lock the scheduled sweep
 * takes): two sweeps never expand, finish or reconcile runs at once (review MC5, CT2). False when the lock is held.
 */
export async function runUnderListingPushSweepLock(steps: () => Promise<void>): Promise<boolean> {
  const ran = await withAdvisoryLock(DROPSHIP_LISTING_PUSH_WORKER_LOCK_ID, async () => {
    await steps();
    return true as const;
  });
  return ran === true;
}

/**
 * A sweep started outside the schedule (staff "run sweep now"): jobs are processed as before, and the run steps
 * only under the sweep lock, so they never race the scheduled sweep's.
 */
export function runAdminListingPushSweep(input: Omit<NonNullable<Parameters<typeof runDropshipListingPushSweep>[0]>, "runStepsGuard">) {
  return runDropshipListingPushSweep({ ...input, runStepsGuard: runUnderListingPushSweepLock });
}

/**
 * Each run step's failure is logged for a human and the sweep goes on: the
 * job processing that follows does not depend on it, and the next sweep
 * retries it (its steps are idempotent).
 */
async function runPublishRunSteps(runs: DropshipListingPushRunSweepSteps): Promise<void> {
  await runReconcileStep(runs);
  try {
    const expanded = await runs.expandRuns();
    if (expanded.attempted > 0) logger.debug("dropship.listing_push_run.expanded", { outcome: "ok", ...expanded });
  } catch (error) {
    logger.error("dropship.listing_push_run.expansion_failed", {
      outcome: "failed", error_code: "DROPSHIP_LISTING_PUSH_RUN_EXPANSION_FAILED",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runReconcileStep(runs: DropshipListingPushRunSweepSteps): Promise<void> {
  try {
    const reconciled = await runs.reconcileAndFinish();
    if (reconciled.changed > 0 || reconciled.finished > 0) {
      logger.debug("dropship.listing_push_run.reconciled", { outcome: "ok", ...reconciled });
    }
  } catch (error) {
    logger.error("dropship.listing_push_run.reconcile_failed", {
      outcome: "failed", error_code: "DROPSHIP_LISTING_PUSH_RUN_RECONCILE_FAILED",
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function startDropshipListingPushWorker(): void {
  if (
    process.env.DISABLE_SCHEDULERS === "true"
    || process.env.DROPSHIP_LISTING_PUSH_WORKER_DISABLED === "true"
  ) {
    return;
  }

  const intervalMs = envPositiveInteger("DROPSHIP_LISTING_PUSH_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  // One recovery for the life of the worker: its stock link re-queue keeps, in
  // process, when it may read a store's destination or a listing's selection again
  // (domain/stock-link-resend-schedule), so a waiting store is not read on every
  // 10-second pass. Its repositories hold no other state.
  const recovery = createDropshipListingPushRecoveryFromEnv();
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_LISTING_PUSH_WORKER_LOCK_ID, async () => {
        const result = await runDropshipListingPushSweep({ recovery });
        if (result.processed > 0 || result.failed > 0) {
          console.info(JSON.stringify({
            code: "DROPSHIP_LISTING_PUSH_SWEEP_COMPLETED",
            message: "Dropship listing push sweep completed.",
            context: result,
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_LISTING_PUSH_SWEEP_FAILED",
        message: "Dropship listing push sweep failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "listingPush",
    intervalMs,
    run: runLockedSweep,
  });
  console.info(JSON.stringify({
    code: "DROPSHIP_LISTING_PUSH_WORKER_STARTED",
    message: "Dropship listing push worker started.",
    context: { intervalMs, initialDelayMs, schedulingMode: "completion_delayed_non_overlapping" },
  }));
}

/**
 * Recovery logs its own outcomes and never throws by design; anything that
 * still escapes is logged for a human here and the sweep goes on to its jobs,
 * because a repair problem must not stop vendors' pushes. The next sweep runs
 * the recovery again.
 */
async function runRecoveryBeforeJobs(recovery: DropshipListingPushSweepRecovery, workerId: string, recoveryLogger: DropshipLogger): Promise<void> {
  try {
    const result = await recovery.run({ workerId });
    const stockLinkMarks = result.stockLink ? result.stockLink.itemsExhausted + result.stockLink.itemsSkipped : 0;
    if (result.listingsRestored + result.listingsNeedingReview + result.jobsRequeued + result.rowFailures + result.stepFailures
      + stockLinkMarks > 0) {
      recoveryLogger.info({
        code: "DROPSHIP_LISTING_PUSH_RECOVERY_COMPLETED",
        message: "Dropship listing push recovery pass completed.",
        context: { action: "listing_push_recovery", outcome: "completed", workerId, ...result },
      });
    }
  } catch (error) {
    const thrownCode = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null;
    recoveryLogger.error({
      code: "DROPSHIP_LISTING_PUSH_RECOVERY_FAILED",
      message: "Dropship listing push recovery failed; the sweep continued with its jobs.",
      context: {
        action: "listing_push_recovery", outcome: "failed", classification: "transient", workerId,
        error: error instanceof Error ? error.message : String(error),
        error_code: thrownCode ?? "DROPSHIP_LISTING_PUSH_RECOVERY_FAILED",
      },
    });
  }
}

function defaultWorkerId(): string {
  return `dropship-listing-push-${process.pid}`;
}

function defaultListingPushJobIdempotencyKey(jobId: number): string {
  return `dropship-listing-push:job:${jobId}`;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
