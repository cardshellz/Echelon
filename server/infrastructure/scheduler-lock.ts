import type { PoolClient } from "pg";
import pg from "pg";
import {
  getPostgresPoolSnapshot,
  type PostgresPoolSnapshot,
} from "./postgres-pool-observability";

const { Pool } = pg;

interface AdvisoryLockPool {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
  options?: {
    max?: number;
  };
}

interface AdvisoryLockLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface SchedulerLockPoolSnapshot extends PostgresPoolSnapshot {
  activeLockIds: number[];
}

/**
 * Session-level advisory locks retain one connection for the full job run.
 * Production currently has multiple long-running lock domains plus frequent
 * short sweeps, so two connections cannot keep the independent domains live.
 * The pool remains bounded and environment-overridable for future dyno scaling.
 */
export const DEFAULT_SCHEDULER_LOCK_POOL_MAX = 8;

let lockPool: AdvisoryLockPool | null = null;
let defaultRunner: ReturnType<typeof createAdvisoryLockRunner> | null = null;
const activeLockIds = new Set<number>();

/**
 * Executes a function exactly once across all active dynos
 * by utilizing a session-level Postgres advisory lock.
 * If the lock cannot be acquired (already held by another dyno),
 * the function returns null immediately without executing `fn`.
 *
 * @param lockId A unique integer ID for this specific scheduled task
 * @param fn The async function to execute if the lock is acquired
 */
export async function withAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
  defaultRunner ??= createAdvisoryLockRunner(getLockPool(), console, activeLockIds);
  return defaultRunner(lockId, fn);
}

export function getSchedulerLockPoolSnapshot(): SchedulerLockPoolSnapshot | null {
  if (
    lockPool === null
    || typeof lockPool.totalCount !== "number"
    || typeof lockPool.idleCount !== "number"
    || typeof lockPool.waitingCount !== "number"
  ) {
    return null;
  }

  return {
    ...getPostgresPoolSnapshot({
      totalCount: lockPool.totalCount,
      idleCount: lockPool.idleCount,
      waitingCount: lockPool.waitingCount,
      options: lockPool.options,
    }),
    activeLockIds: [...activeLockIds].sort((left, right) => left - right),
  };
}

export function createAdvisoryLockRunner(
  advisoryLockPool: AdvisoryLockPool,
  logger: AdvisoryLockLogger,
  activeLocks: Set<number> = new Set<number>(),
): <T>(lockId: number, fn: () => Promise<T>) => Promise<T | null> {
  return async function runWithAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
    let client: Pick<PoolClient, "query" | "release">;
    try {
      client = await advisoryLockPool.connect();
    } catch (error) {
      logger.error(
        `[AdvisoryLock] Failed to acquire pooled connection for lock ${lockId}:`,
        errorMessage(error),
      );
      throw error;
    }

    let acquired = false;
    let releaseError: Error | undefined;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock($1) as acquired", [lockId]);
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) {
        logger.log(`[AdvisoryLock] Lock ${lockId} is already held by another worker. Skipping execution.`);
        return null;
      }

      activeLocks.add(lockId);
      return await fn();
    } catch (error) {
      logger.error(
        `[AdvisoryLock] Error running locked function for ${lockId}:`,
        errorMessage(error),
      );
      throw error;
    } finally {
      if (acquired) {
        try {
          await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        } catch (error) {
          releaseError = toError(error);
          logger.error(`[AdvisoryLock] Failed to release lock ${lockId}:`, releaseError.message);
        } finally {
          activeLocks.delete(lockId);
        }
      }
      client.release(releaseError);
    }
  };
}

export function resolveSchedulerLockPoolMax(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  return envPositiveInteger(
    environment,
    "SCHEDULER_LOCK_POOL_MAX",
    DEFAULT_SCHEDULER_LOCK_POOL_MAX,
  );
}

function envPositiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = Number(environment[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function getLockPool(): AdvisoryLockPool {
  if (lockPool) return lockPool;

  const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
  const useSSL = process.env.EXTERNAL_DATABASE_URL
    || (process.env.DATABASE_URL && process.env.DATABASE_URL.includes("amazonaws.com"));

  if (!connectionString) {
    throw new Error(
      "Database connection string must be set. Provide EXTERNAL_DATABASE_URL or DATABASE_URL.",
    );
  }

  const pgPool = new Pool({
    connectionString,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
    max: resolveSchedulerLockPoolMax(),
    idleTimeoutMillis: envPositiveInteger(
      process.env,
      "SCHEDULER_LOCK_IDLE_TIMEOUT_MS",
      30_000,
    ),
    connectionTimeoutMillis: envPositiveInteger(
      process.env,
      "SCHEDULER_LOCK_CONNECTION_TIMEOUT_MS",
      10_000,
    ),
  });

  pgPool.on("error", (error) => {
    console.error("[AdvisoryLock] Unexpected idle lock client error:", error);
  });

  lockPool = pgPool;
  return lockPool;
}
