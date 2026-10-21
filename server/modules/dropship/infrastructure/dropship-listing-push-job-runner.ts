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

/** Repairs the sweep runs before claiming jobs (dropship-listing-push-recovery-service). */
export interface DropshipListingPushSweepRecovery {
  run(input: { workerId: string }): Promise<DropshipListingPushRecoveryResult>;
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
    const result = await this.dbPool.query<JobIdRow>(
      `SELECT id
       FROM dropship.dropship_listing_push_jobs
       WHERE status = 'queued'
          OR (
            status = 'processing'
            AND updated_at <= $2::timestamptz - ($3::text)::interval
          )
       ORDER BY created_at ASC, id ASC
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
} = {}): Promise<{ processed: number; failed: number }> {
  const repository = input.repository ?? new PgDropshipListingPushJobQueueRepository();
  const batchSize = input.batchSize ?? envPositiveInteger("DROPSHIP_LISTING_PUSH_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const staleProcessingMinutes = input.staleProcessingMinutes
    ?? envPositiveInteger("DROPSHIP_LISTING_PUSH_STALE_PROCESSING_MINUTES", DEFAULT_STALE_PROCESSING_MINUTES);
  const now = input.now ?? new Date();
  const workerId = input.workerId ?? defaultWorkerId();
  if (input.recovery) await runRecoveryBeforeJobs(input.recovery, workerId, input.logger ?? makeDropshipListingPushWorkerLogger());
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
  }
  return { processed, failed };
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
async function runRecoveryBeforeJobs(recovery: DropshipListingPushSweepRecovery, workerId: string, logger: DropshipLogger): Promise<void> {
  try {
    const result = await recovery.run({ workerId });
    const stockLinkMarks = result.stockLink ? result.stockLink.itemsExhausted + result.stockLink.itemsSkipped : 0;
    if (result.listingsRestored + result.listingsNeedingReview + result.jobsRequeued + result.rowFailures + result.stepFailures
      + stockLinkMarks > 0) {
      logger.info({
        code: "DROPSHIP_LISTING_PUSH_RECOVERY_COMPLETED",
        message: "Dropship listing push recovery pass completed.",
        context: { action: "listing_push_recovery", outcome: "completed", workerId, ...result },
      });
    }
  } catch (error) {
    const thrownCode = typeof (error as { code?: unknown } | null)?.code === "string" ? (error as { code: string }).code : null;
    logger.error({
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
