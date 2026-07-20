import type { PoolClient } from "pg";
import pg from "pg";
import { databaseSsl, resolveDatabaseUrl } from "../config/database";

const { Pool } = pg;

interface AdvisoryLockPool {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
}

interface AdvisoryLockLogger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
}

let lockPool: AdvisoryLockPool | null = null;
let defaultRunner: ReturnType<typeof createAdvisoryLockRunner> | null = null;

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
  defaultRunner ??= createAdvisoryLockRunner(getLockPool(), console);
  return defaultRunner(lockId, fn);
}

export function createAdvisoryLockRunner(
  advisoryLockPool: AdvisoryLockPool,
  logger: AdvisoryLockLogger,
): <T>(lockId: number, fn: () => Promise<T>) => Promise<T | null> {
  return async function runWithAdvisoryLock<T>(lockId: number, fn: () => Promise<T>): Promise<T | null> {
    const client = await advisoryLockPool.connect();
    let acquired = false;
    try {
      const result = await client.query("SELECT pg_try_advisory_lock($1) as acquired", [lockId]);
      acquired = result.rows[0]?.acquired === true;
      if (!acquired) {
        logger.log(`[AdvisoryLock] Lock ${lockId} is already held by another worker. Skipping execution.`);
        return null;
      }

      return await fn();
    } catch (err: any) {
      logger.error(`[AdvisoryLock] Error running locked function for ${lockId}:`, err.message);
      throw err;
    } finally {
      if (acquired) {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]).catch((error: Error) => {
          logger.error(`[AdvisoryLock] Failed to release lock ${lockId}:`, error.message);
        });
      }
      client.release();
    }
  };
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function getLockPool(): AdvisoryLockPool {
  if (lockPool) return lockPool;

  const connectionString = resolveDatabaseUrl();

  const pgPool = new Pool({
    connectionString,
    ssl: databaseSsl(connectionString),
    max: envPositiveInteger("SCHEDULER_LOCK_POOL_MAX", 2),
    idleTimeoutMillis: envPositiveInteger("SCHEDULER_LOCK_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: envPositiveInteger("SCHEDULER_LOCK_CONNECTION_TIMEOUT_MS", 10_000),
  });

  pgPool.on("error", (error) => {
    console.error("[AdvisoryLock] Unexpected idle lock client error:", error);
  });

  lockPool = pgPool;
  return lockPool;
}
