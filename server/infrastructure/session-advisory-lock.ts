import type { PoolClient } from "pg";

/**
 * Pinned-client session advisory locks.
 *
 * WHY THIS EXISTS. `pg_advisory_lock()` is a SESSION-level lock. Running it
 * through the pooled drizzle handle (`db.execute(sql\`SELECT pg_advisory_lock\`)`)
 * checks out an arbitrary pool connection per statement, so:
 *   - the acquire and the unlock can land on different connections: the unlock
 *     returns false and the lock is stranded on the first connection;
 *   - pg-pool hands idle clients out LIFO, so a second caller usually receives
 *     the very connection the first caller just released, and session locks are
 *     re-entrant within a session, so the second caller "acquires" instantly.
 * Net effect: zero mutual exclusion. Two concurrent ShipStation pushes both took
 * the CREATE path and ShipStation ended up with two orders for one shipment.
 *
 * This helper pins ONE connection for the whole critical section: acquire, run,
 * unlock all happen on that client. Acquisition runs inside a transaction only
 * so that `SET LOCAL lock_timeout` scopes the wait bound to the acquisition; the
 * session lock itself survives the COMMIT (session-level advisory locks ignore
 * transaction boundaries).
 *
 * Contract:
 *   - NOT re-entrant. Never nest two calls for the same key on one code path;
 *     each call pins its own client, so nesting the same key blocks until the
 *     lock timeout fires.
 *   - The pinned connection is held for the whole duration of `fn`, including
 *     any HTTP calls inside it. Bound those with their own timeouts.
 *   - A failed unlock destroys the connection (`client.release(err)`) so a
 *     stranded lock dies with its session instead of blocking future callers.
 *   - Lock timeout and acquisition failures are `transient`: callers on a
 *     durable retry ladder simply retry later.
 *
 * Prefer `pg_advisory_xact_lock` inside an existing transaction when the
 * critical section is purely database work. Use this helper only when the
 * section must span statements outside one transaction, e.g. an external API
 * call between the read and the write-back.
 */

export interface SessionAdvisoryLockPool {
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
}

export interface SessionAdvisoryLockKey {
  /** First int4 argument of pg_advisory_lock: the lock namespace. */
  namespace: number;
  /** Second int4 argument of pg_advisory_lock: the row-scoped key. */
  key: number;
  /** Human-readable label carried on logs and errors, e.g. "shipstation.shipment_push". */
  label: string;
}

export type SessionAdvisoryLockRunner = <T>(
  lock: SessionAdvisoryLockKey,
  fn: () => Promise<T>,
) => Promise<T>;

export type SessionAdvisoryLockClassification = "transient" | "permanent";

export interface SessionAdvisoryLockErrorContext {
  code: string;
  classification: SessionAdvisoryLockClassification;
  label: string;
  namespace: number;
  key: number;
  lockTimeoutMs?: number;
  cause?: string;
}

export class SessionAdvisoryLockError extends Error {
  constructor(
    message: string,
    public readonly context: SessionAdvisoryLockErrorContext,
  ) {
    super(message);
    this.name = "SessionAdvisoryLockError";
  }

  get classification(): SessionAdvisoryLockClassification {
    return this.context.classification;
  }
}

export const SESSION_ADVISORY_LOCK_TIMEOUT = "SESSION_ADVISORY_LOCK_TIMEOUT";
export const SESSION_ADVISORY_LOCK_ACQUIRE_FAILED = "SESSION_ADVISORY_LOCK_ACQUIRE_FAILED";
export const SESSION_ADVISORY_LOCK_INVALID_KEY = "SESSION_ADVISORY_LOCK_INVALID_KEY";

/**
 * Bound on how long a caller waits for a contended key. Pushes normally hold
 * the lock for a few seconds (one or two ShipStation round trips), so a wait
 * this long means the holder is stuck; failing transient lets the retry ladder
 * come back later instead of pinning a second pool slot indefinitely.
 */
export const DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS = 30_000;
const MIN_LOCK_TIMEOUT_MS = 1_000;
const MAX_LOCK_TIMEOUT_MS = 600_000;

/** Postgres SQLSTATE raised when lock_timeout expires while waiting for a lock. */
const PG_LOCK_NOT_AVAILABLE = "55P03";

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;

export interface SessionAdvisoryLockLogger {
  error(line: string): void;
}

export interface SessionAdvisoryLockRunnerOptions {
  lockTimeoutMs?: number;
  logger?: SessionAdvisoryLockLogger;
}

export function createSessionAdvisoryLockRunner(
  pool: SessionAdvisoryLockPool,
  options: SessionAdvisoryLockRunnerOptions = {},
): SessionAdvisoryLockRunner {
  const lockTimeoutMs = normalizeLockTimeoutMs(
    options.lockTimeoutMs ?? DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS,
  );
  const logger = options.logger ?? console;

  return async function withSessionAdvisoryLock<T>(
    lock: SessionAdvisoryLockKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    assertValidLockKey(lock);

    const client = await pool.connect();
    let acquired = false;
    let releaseError: Error | undefined;
    try {
      await acquireSessionLock(client, lock, lockTimeoutMs);
      acquired = true;
      return await fn();
    } catch (error) {
      if (!acquired) {
        // An aborted acquisition leaves the session in an unknown state (an
        // open or aborted transaction, possibly a half-taken lock). Destroying
        // the client is the only way to guarantee nothing leaks into the pool.
        releaseError = toError(error);
      }
      throw error;
    } finally {
      if (acquired) {
        releaseError = await releaseSessionLock(client, lock, logger);
      }
      // Passing an Error tells pg-pool to destroy the connection instead of
      // returning it to the idle set.
      client.release(releaseError);
    }
  };
}

async function acquireSessionLock(
  client: Pick<PoolClient, "query">,
  lock: SessionAdvisoryLockKey,
  lockTimeoutMs: number,
): Promise<void> {
  try {
    await client.query("BEGIN");
    // SET LOCAL cannot take bind parameters. lockTimeoutMs is a validated,
    // bounded integer (normalizeLockTimeoutMs), so interpolation is safe.
    await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await client.query("SELECT pg_advisory_lock($1, $2)", [lock.namespace, lock.key]);
    await client.query("COMMIT");
  } catch (error) {
    const sqlState = (error as { code?: unknown } | null)?.code;
    if (sqlState === PG_LOCK_NOT_AVAILABLE) {
      throw new SessionAdvisoryLockError(
        `Timed out after ${lockTimeoutMs}ms waiting for advisory lock ${describeLock(lock)}`,
        {
          code: SESSION_ADVISORY_LOCK_TIMEOUT,
          classification: "transient",
          label: lock.label,
          namespace: lock.namespace,
          key: lock.key,
          lockTimeoutMs,
          cause: errorMessage(error),
        },
      );
    }
    throw new SessionAdvisoryLockError(
      `Failed to acquire advisory lock ${describeLock(lock)}: ${errorMessage(error)}`,
      {
        code: SESSION_ADVISORY_LOCK_ACQUIRE_FAILED,
        classification: "transient",
        label: lock.label,
        namespace: lock.namespace,
        key: lock.key,
        lockTimeoutMs,
        cause: errorMessage(error),
      },
    );
  }
}

/**
 * Returns the error that should destroy the client, or undefined when the lock
 * was released cleanly. Never throws: the caller's result (or its own error)
 * must not be masked by release bookkeeping.
 */
async function releaseSessionLock(
  client: Pick<PoolClient, "query">,
  lock: SessionAdvisoryLockKey,
  logger: SessionAdvisoryLockLogger,
): Promise<Error | undefined> {
  try {
    const result = await client.query(
      "SELECT pg_advisory_unlock($1, $2) AS unlocked",
      [lock.namespace, lock.key],
    );
    if (result.rows?.[0]?.unlocked === true) {
      return undefined;
    }
    logger.error(JSON.stringify({
      level: "error",
      action: "session_advisory_lock_unlock",
      outcome: "not_held",
      label: lock.label,
      namespace: lock.namespace,
      key: lock.key,
    }));
    return new Error(
      `pg_advisory_unlock reported advisory lock ${describeLock(lock)} was not held by the pinned session`,
    );
  } catch (error) {
    logger.error(JSON.stringify({
      level: "error",
      action: "session_advisory_lock_unlock",
      outcome: "failed",
      label: lock.label,
      namespace: lock.namespace,
      key: lock.key,
      error: errorMessage(error),
    }));
    return toError(error);
  }
}

function assertValidLockKey(lock: SessionAdvisoryLockKey): void {
  const fields: Array<["namespace" | "key", unknown]> = [
    ["namespace", lock?.namespace],
    ["key", lock?.key],
  ];
  for (const [field, value] of fields) {
    if (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < INT4_MIN
      || value > INT4_MAX
    ) {
      throw new SessionAdvisoryLockError(
        `advisory lock ${field} must be an int4 integer, got ${String(value)}`,
        {
          code: SESSION_ADVISORY_LOCK_INVALID_KEY,
          classification: "permanent",
          label: String(lock?.label ?? ""),
          namespace: Number(lock?.namespace),
          key: Number(lock?.key),
        },
      );
    }
  }
  if (typeof lock.label !== "string" || lock.label.trim().length === 0) {
    throw new SessionAdvisoryLockError("advisory lock label must be a non-empty string", {
      code: SESSION_ADVISORY_LOCK_INVALID_KEY,
      classification: "permanent",
      label: String(lock.label ?? ""),
      namespace: lock.namespace,
      key: lock.key,
    });
  }
}

function normalizeLockTimeoutMs(value: number): number {
  if (!Number.isInteger(value) || value < MIN_LOCK_TIMEOUT_MS || value > MAX_LOCK_TIMEOUT_MS) {
    throw new Error(
      `lockTimeoutMs must be an integer between ${MIN_LOCK_TIMEOUT_MS} and ${MAX_LOCK_TIMEOUT_MS}, got ${String(value)}`,
    );
  }
  return value;
}

export function resolveSessionAdvisoryLockTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(environment.SESSION_ADVISORY_LOCK_TIMEOUT_MS);
  return Number.isInteger(raw) && raw >= MIN_LOCK_TIMEOUT_MS && raw <= MAX_LOCK_TIMEOUT_MS
    ? raw
    : DEFAULT_SESSION_ADVISORY_LOCK_TIMEOUT_MS;
}

let defaultRunnerPromise: Promise<SessionAdvisoryLockRunner> | null = null;

/**
 * Runner bound to the application pool (`server/db.ts`). The pool is imported
 * lazily on first use so that importing a module which merely references this
 * runner (e.g. in unit tests with a fake db) never opens a database pool.
 */
export function getDefaultSessionAdvisoryLockRunner(): SessionAdvisoryLockRunner {
  return async function withDefaultPoolSessionAdvisoryLock<T>(
    lock: SessionAdvisoryLockKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    defaultRunnerPromise ??= import("../db").then(({ pool }) =>
      createSessionAdvisoryLockRunner(pool, {
        lockTimeoutMs: resolveSessionAdvisoryLockTimeoutMs(),
      }),
    );
    const runner = await defaultRunnerPromise;
    return runner(lock, fn);
  };
}

function describeLock(lock: SessionAdvisoryLockKey): string {
  return `${lock.label} (${lock.namespace}, ${lock.key})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
