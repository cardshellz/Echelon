import { describe, expect, it, vi } from "vitest";
import {
  MIGRATION_ADVISORY_LOCK_NAME,
  acquireMigrationAdvisoryLock,
  executeMigrationWithRetry,
  migrationRetryOptionsFromEnv,
  releaseMigrationAdvisoryLock,
  type MigrationQueryClient,
} from "../../../migrations/migration-executor";

const TEST_OPTIONS = {
  maxAttempts: 3,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 500,
  lockTimeoutMs: 2_000,
};

function postgresError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

describe("migration executor", () => {
  it("rolls back and retries a deadlocked migration transaction", async () => {
    const migrationSql = "CREATE TABLE retry_me (id integer)";
    let migrationAttempts = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql === migrationSql) {
        migrationAttempts += 1;
        if (migrationAttempts === 1) {
          throw postgresError("40P01", "deadlock detected");
        }
      }
      return { rows: [] };
    });
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();

    const result = await executeMigrationWithRetry({
      client: { query },
      file: "0586_test.sql",
      sql: migrationSql,
      contentHash: "test-hash",
      options: TEST_OPTIONS,
      sleep,
      onRetry,
    });

    expect(result).toEqual({ attempts: 2 });
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('lock_timeout', $1, true)",
      migrationSql,
      "ROLLBACK",
      "BEGIN",
      "SELECT set_config('lock_timeout', $1, true)",
      migrationSql,
      "INSERT INTO _migrations (filename, content_hash) VALUES ($1, $2)",
      "COMMIT",
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(100);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({
      file: "0586_test.sql",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      sqlState: "40P01",
      message: "deadlock detected",
    });
  });

  it("does not retry a non-transient migration error", async () => {
    const migrationSql = "INVALID SQL";
    const syntaxError = postgresError("42601", "syntax error");
    const query = vi.fn(async (sql: string) => {
      if (sql === migrationSql) throw syntaxError;
      return { rows: [] };
    });
    const sleep = vi.fn(async () => undefined);

    await expect(executeMigrationWithRetry({
      client: { query },
      file: "bad.sql",
      sql: migrationSql,
      contentHash: "test-hash",
      options: TEST_OPTIONS,
      sleep,
    })).rejects.toBe(syntaxError);

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('lock_timeout', $1, true)",
      migrationSql,
      "ROLLBACK",
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails after the configured number of lock-contention attempts", async () => {
    const migrationSql = "ALTER TABLE busy_table ADD COLUMN value integer";
    const lockError = postgresError("55P03", "canceling statement due to lock timeout");
    const query = vi.fn(async (sql: string) => {
      if (sql === migrationSql) throw lockError;
      return { rows: [] };
    });
    const sleep = vi.fn(async () => undefined);

    await expect(executeMigrationWithRetry({
      client: { query },
      file: "busy.sql",
      sql: migrationSql,
      contentHash: "test-hash",
      options: TEST_OPTIONS,
      sleep,
    })).rejects.toBe(lockError);

    expect(query.mock.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(3);
    expect(query.mock.calls.filter(([sql]) => sql === "ROLLBACK")).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[100], [200]]);
  });

  it("serializes migration runners with a named session advisory lock", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client: MigrationQueryClient = { query };

    await acquireMigrationAdvisoryLock(client);
    await releaseMigrationAdvisoryLock(client);

    expect(query.mock.calls).toEqual([
      ["SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_ADVISORY_LOCK_NAME]],
      ["SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_ADVISORY_LOCK_NAME]],
    ]);
  });

  it("loads bounded retry defaults and rejects unsafe configuration", () => {
    expect(migrationRetryOptionsFromEnv({})).toEqual({
      maxAttempts: 5,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 15_000,
      lockTimeoutMs: 15_000,
    });
    expect(() => migrationRetryOptionsFromEnv({
      MIGRATION_MAX_ATTEMPTS: "0",
    })).toThrow("MIGRATION_MAX_ATTEMPTS must be an integer between 1 and 10");
    expect(() => migrationRetryOptionsFromEnv({
      MIGRATION_RETRY_BASE_DELAY_MS: "2000",
      MIGRATION_RETRY_MAX_DELAY_MS: "1000",
    })).toThrow(
      "MIGRATION_RETRY_MAX_DELAY_MS must be greater than or equal to MIGRATION_RETRY_BASE_DELAY_MS",
    );
  });
});
