/**
 * Bounds how long boot-time fallback DDL may wait for a table lock.
 *
 * 2026-11-11 outage: a web dyno died mid-transaction and its backend stayed
 * "idle in transaction" holding a share lock on oms.oms_orders. Every new
 * dyno's boot ran `ALTER TABLE oms.oms_orders ADD COLUMN IF NOT EXISTS ...`,
 * which needs an exclusive lock and waited forever (lock_timeout was 0). No
 * dyno could finish booting, and the queued ALTER also blocked every other
 * query on that table. The same shape as the 2026-10-01 DBeaver outage.
 *
 * Boot DDL is a safety net for schema that tracked migrations already
 * applied, so skipping it is safe; hanging on it is not. With this guard:
 *   1. each statement waits at most STARTUP_MIGRATION_LOCK_TIMEOUT_MS;
 *   2. the first lock timeout trips a breaker, so the remaining statements
 *      fail immediately instead of each waiting again (the caller's nested
 *      try/catch blocks would otherwise retry ~170 statements one by one).
 */

/** Long enough for normal short transactions to finish, far below Heroku's
 * 60-second boot limit even with connection setup around it. */
export const STARTUP_MIGRATION_LOCK_TIMEOUT_MS = 5_000;

/** PostgreSQL lock_not_available: raised when lock_timeout expires. */
const PG_LOCK_NOT_AVAILABLE = "55P03";

export class StartupMigrationLockBlockedError extends Error {
  readonly code = "STARTUP_MIGRATION_LOCK_BLOCKED";
  /** transient: a later boot retries the same idempotent DDL. */
  readonly classification = "transient" as const;
  constructor(readonly statement: string, options?: { cause?: unknown }) {
    super(
      "Startup schema fallback could not get a table lock within "
      + `${STARTUP_MIGRATION_LOCK_TIMEOUT_MS}ms; remaining fallbacks are skipped for this boot. `
      + "Another session is holding a transaction open on that table.",
      options,
    );
    this.name = "StartupMigrationLockBlockedError";
  }
}

export interface StartupMigrationQueryClient {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface StartupMigrationLogger {
  error(event: Record<string, unknown>): void;
}

const defaultLogger: StartupMigrationLogger = { error: event => console.error(JSON.stringify(event)) };

function summarize(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Wrap the dedicated startup-migration connection. Call once, right after
 * connect; the session-level lock_timeout dies with that connection.
 */
export async function guardStartupMigrationClient(
  client: StartupMigrationQueryClient,
  logger: StartupMigrationLogger = defaultLogger,
): Promise<StartupMigrationQueryClient> {
  // Integer milliseconds from a named constant; not user input.
  await client.query(`SET lock_timeout = ${STARTUP_MIGRATION_LOCK_TIMEOUT_MS}`);
  let blockedBy: StartupMigrationLockBlockedError | null = null;
  return {
    async query(text, values) {
      if (blockedBy) throw new StartupMigrationLockBlockedError(summarize(text), { cause: blockedBy });
      try {
        return await client.query(text, values);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== PG_LOCK_NOT_AVAILABLE) throw error;
        blockedBy = new StartupMigrationLockBlockedError(summarize(text), { cause: error });
        logger.error({
          level: "error", action: "startup_migration.lock_blocked", outcome: "skipped",
          error_code: blockedBy.code, statement: blockedBy.statement,
          lock_timeout_ms: STARTUP_MIGRATION_LOCK_TIMEOUT_MS,
        });
        throw blockedBy;
      }
    },
  };
}
