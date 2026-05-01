import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import { createDropshipListingPushWorkerServiceFromEnv } from "./dropship-listing-push-worker.factory";

export interface DropshipListingPushJobQueueRepository {
  listQueuedJobIds(limit: number): Promise<number[]>;
}

interface JobIdRow {
  id: number;
}

const DROPSHIP_LISTING_PUSH_WORKER_LOCK_ID = 736204;
const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_BATCH_SIZE = 10;

export class PgDropshipListingPushJobQueueRepository implements DropshipListingPushJobQueueRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listQueuedJobIds(limit: number): Promise<number[]> {
    const result = await this.dbPool.query<JobIdRow>(
      `SELECT id
       FROM dropship.dropship_listing_push_jobs
       WHERE status = 'queued'
       ORDER BY created_at ASC, id ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }
}

export async function runDropshipListingPushJob(input: {
  jobId: number;
  workerId?: string;
  idempotencyKey?: string;
}): Promise<void> {
  const workerId = input.workerId ?? defaultWorkerId();
  await createDropshipListingPushWorkerServiceFromEnv().processJob({
    jobId: input.jobId,
    workerId,
    idempotencyKey: input.idempotencyKey ?? `${workerId}:job:${input.jobId}`,
  });
}

export async function runDropshipListingPushSweep(input: {
  repository?: DropshipListingPushJobQueueRepository;
  batchSize?: number;
  workerId?: string;
} = {}): Promise<{ processed: number; failed: number }> {
  const repository = input.repository ?? new PgDropshipListingPushJobQueueRepository();
  const batchSize = input.batchSize ?? envPositiveInteger("DROPSHIP_LISTING_PUSH_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const workerId = input.workerId ?? defaultWorkerId();
  const jobIds = await repository.listQueuedJobIds(batchSize);
  let processed = 0;
  let failed = 0;
  for (const jobId of jobIds) {
    try {
      await runDropshipListingPushJob({
        jobId,
        workerId,
        idempotencyKey: `${workerId}:job:${jobId}`,
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
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_LISTING_PUSH_WORKER_LOCK_ID, async () => {
        const result = await runDropshipListingPushSweep();
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
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  };

  setTimeout(runLockedSweep, Math.min(intervalMs, 5_000));
  setInterval(runLockedSweep, intervalMs);
  console.info(JSON.stringify({
    code: "DROPSHIP_LISTING_PUSH_WORKER_STARTED",
    message: "Dropship listing push worker started.",
    context: { intervalMs },
  }));
}

function defaultWorkerId(): string {
  return `dropship-listing-push-${process.pid}`;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
