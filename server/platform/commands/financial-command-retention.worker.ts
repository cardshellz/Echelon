import type { Pool } from "pg";

import { db, pool } from "../../db";
import {
  recordRunCompleted,
  runBootCatchUpIfBehind,
} from "../../infrastructure/scheduler-run-registry";
import { purgeExpiredFinancialCommandResults } from "./financial-command-operations.service";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 10;
const LOG_PREFIX = "[Financial Command Retention]";
const JOB_KEY = "financial_command_retention";

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startFinancialCommandRetentionWorker(): void {
  if (timer) {
    console.warn(`${LOG_PREFIX} Worker already started; ignoring duplicate start`);
    return;
  }
  const intervalMs = positiveIntegerEnv("FINANCIAL_COMMAND_RETENTION_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  // The scheduled pass records its completion so the boot gate below can tell a
  // genuinely missed run from an ordinary redeploy.
  const run = () => void runFinancialCommandRetentionTick().then(async ({ status }) => {
    if (status === "success") await recordRunCompleted(db, JOB_KEY);
  }).catch((error) => console.error(`${LOG_PREFIX} Could not record run`, error));

  // Boot pass only when a scheduled run was actually missed. This purges up to
  // maxBatches x batchSize rows, and replaying that on every deploy of a 6h job
  // is waste the 512MB dyno cannot spare.
  setTimeout(() => {
    void runBootCatchUpIfBehind({
      db,
      jobKey: JOB_KEY,
      intervalMs,
      logPrefix: LOG_PREFIX,
      run: async () => {
        const { status } = await runFinancialCommandRetentionTick();
        if (status !== "success") {
          // The tick logs its own failure. Throw so the helper does not stamp a
          // completion this job never reached.
          throw new Error(`retention tick did not complete (${status})`);
        }
      },
    }).catch((error) => console.error(`${LOG_PREFIX} Boot catch-up failed`, error));
  }, Math.min(intervalMs, 10_000));

  timer = setInterval(run, intervalMs);
  console.info(`${LOG_PREFIX} Started cleanup worker (interval ${intervalMs}ms)`);
}

export async function runFinancialCommandRetentionTick(
  dependencies: {
    dbPool?: Pool;
    batchSize?: number;
    maxBatches?: number;
  } = {},
): Promise<{ status: "success" | "error" | "skipped"; deleted: number }> {
  if (inFlight) return { status: "skipped", deleted: 0 };
  inFlight = true;
  const dbPool = dependencies.dbPool ?? pool;
  const batchSize = dependencies.batchSize
    ?? positiveIntegerEnv("FINANCIAL_COMMAND_RETENTION_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const maxBatches = dependencies.maxBatches
    ?? positiveIntegerEnv("FINANCIAL_COMMAND_RETENTION_MAX_BATCHES", DEFAULT_MAX_BATCHES);
  let deleted = 0;
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const batchDeleted = await purgeExpiredFinancialCommandResults(dbPool, batchSize);
      deleted += batchDeleted;
      if (batchDeleted < batchSize) break;
    }
    if (deleted > 0) console.info(`${LOG_PREFIX} Deleted ${deleted} expired terminal results`);
    return { status: "success", deleted };
  } catch (error) {
    console.error(`${LOG_PREFIX} Cleanup tick failed`, error);
    return { status: "error", deleted };
  } finally {
    inFlight = false;
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
