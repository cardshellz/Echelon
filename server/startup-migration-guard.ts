/**
 * Bounds for the boot-time schema fallbacks in runStartupMigrations().
 *
 * The web process does not listen until that routine returns, and Heroku kills
 * a web dyno that has not bound its port within 60 seconds. The routine issues
 * ALTER TABLE statements against live tables (oms.oms_orders among them), each
 * of which waits indefinitely for an exclusive lock by default. On 2026-11-10
 * one such statement waited 55 seconds, the dyno was killed twice and the whole
 * application stayed down until it was restarted by hand.
 *
 * Release-phase migrations are the schema authority; these fallbacks are a
 * safety net whose documented failure mode is "skip the rest and log loudly".
 * The limits below make a slow or blocked fallback take that path instead of
 * consuming the boot window.
 */

/** Longest a single fallback statement may wait for a lock. */
export const STARTUP_MIGRATION_LOCK_TIMEOUT_MS = 3_000;
/** Longest a single fallback statement may run once it has its locks. */
export const STARTUP_MIGRATION_STATEMENT_TIMEOUT_MS = 10_000;
/**
 * Total time the fallbacks may take before the remainder is skipped. With the
 * statement limit, the routine returns within 30 seconds in the worst case,
 * leaving half of Heroku's 60-second boot window for the rest of startup.
 */
export const STARTUP_MIGRATION_BUDGET_MS = 20_000;

export class StartupMigrationBudgetExceededError extends Error {
  readonly code = "STARTUP_MIGRATION_BUDGET_EXCEEDED";
  constructor(readonly budgetMs: number) {
    super(
      `Startup schema fallbacks exceeded their ${budgetMs}ms budget; the remaining fallbacks were skipped.`,
    );
    this.name = "StartupMigrationBudgetExceededError";
  }
}

interface QueryClient {
  query(...args: any[]): Promise<any>;
}

export interface StartupMigrationLimits {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  budgetMs: number;
}

export const STARTUP_MIGRATION_LIMITS: StartupMigrationLimits = {
  lockTimeoutMs: STARTUP_MIGRATION_LOCK_TIMEOUT_MS,
  statementTimeoutMs: STARTUP_MIGRATION_STATEMENT_TIMEOUT_MS,
  budgetMs: STARTUP_MIGRATION_BUDGET_MS,
};

function assertTimeout(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive integer of milliseconds.`);
  return value;
}

/**
 * Applies the per-statement limits to the dedicated migration connection and
 * returns a client that refuses to start another statement once the total
 * budget is spent. The connection must not be shared: the limits are set for
 * the whole session and the caller closes it when the routine ends.
 */
export async function boundStartupMigrationClient<T extends QueryClient>(
  connection: T,
  limits: StartupMigrationLimits = STARTUP_MIGRATION_LIMITS,
  now: () => number = Date.now,
): Promise<Pick<T, "query">> {
  const lockTimeoutMs = assertTimeout("lockTimeoutMs", limits.lockTimeoutMs);
  const statementTimeoutMs = assertTimeout(
    "statementTimeoutMs",
    limits.statementTimeoutMs,
  );
  const budgetMs = assertTimeout("budgetMs", limits.budgetMs);
  const deadline = now() + budgetMs;
  // SET takes no bind parameters; both values are validated integers.
  await connection.query(`SET lock_timeout = ${lockTimeoutMs}`);
  await connection.query(`SET statement_timeout = ${statementTimeoutMs}`);
  return {
    query: ((...args: any[]) => {
      if (now() >= deadline)
        return Promise.reject(new StartupMigrationBudgetExceededError(budgetMs));
      return connection.query(...args);
    }) as T["query"],
  };
}
