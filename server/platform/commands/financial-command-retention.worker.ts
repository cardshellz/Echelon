import type { Pool } from "pg";

import { pool } from "../../db";
import { purgeExpiredFinancialCommandResults } from "./financial-command-operations.service";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 10;
const LOG_PREFIX = "[Financial Command Retention]";

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startFinancialCommandRetentionWorker(): void {
  if (timer) {
    console.warn(`${LOG_PREFIX} Worker already started; ignoring duplicate start`);
    return;
  }
  const intervalMs = positiveIntegerEnv("FINANCIAL_COMMAND_RETENTION_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const run = () => void runFinancialCommandRetentionTick();
  setTimeout(run, Math.min(intervalMs, 10_000));
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
