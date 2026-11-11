import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import {
  boundStartupMigrationClient,
  StartupMigrationBudgetExceededError,
  STARTUP_MIGRATION_BUDGET_MS,
  STARTUP_MIGRATION_LIMITS,
  STARTUP_MIGRATION_STATEMENT_TIMEOUT_MS,
} from "../../startup-migration-guard";

/** Heroku kills a web dyno that has not bound its port within this window. */
const HEROKU_BOOT_TIMEOUT_MS = 60_000;

function fakeConnection() {
  const query = vi.fn(async (..._args: unknown[]): Promise<{ rows: unknown[] }> => ({ rows: [] }));
  return { query };
}

describe("startup migration guard", () => {
  it("keeps the worst-case fallback time inside half of the boot window", () => {
    expect(
      STARTUP_MIGRATION_BUDGET_MS + STARTUP_MIGRATION_STATEMENT_TIMEOUT_MS,
    ).toBeLessThanOrEqual(HEROKU_BOOT_TIMEOUT_MS / 2);
  });

  it("sets the lock and statement limits on the session before any fallback runs", async () => {
    const connection = fakeConnection();
    const client = await boundStartupMigrationClient(connection, STARTUP_MIGRATION_LIMITS, () => 0);
    await client.query("ALTER TABLE t ADD COLUMN IF NOT EXISTS c integer");
    expect(connection.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SET lock_timeout = 3000",
      "SET statement_timeout = 10000",
      "ALTER TABLE t ADD COLUMN IF NOT EXISTS c integer",
    ]);
  });

  it("passes statements and their parameters through unchanged while inside the budget", async () => {
    const connection = fakeConnection();
    connection.query.mockResolvedValue({ rows: [{ n: 1 }] });
    let clock = 0;
    const client = await boundStartupMigrationClient(connection, STARTUP_MIGRATION_LIMITS, () => clock);
    clock = STARTUP_MIGRATION_BUDGET_MS - 1;
    await expect(client.query("SELECT $1::int AS n", [1])).resolves.toEqual({ rows: [{ n: 1 }] });
    expect(connection.query).toHaveBeenLastCalledWith("SELECT $1::int AS n", [1]);
  });

  it("refuses to start another statement once the budget is spent", async () => {
    const connection = fakeConnection();
    let clock = 1_000;
    const client = await boundStartupMigrationClient(connection, STARTUP_MIGRATION_LIMITS, () => clock);
    clock = 1_000 + STARTUP_MIGRATION_BUDGET_MS;
    const sent = connection.query.mock.calls.length;
    await expect(client.query("ALTER TABLE t ADD COLUMN c integer")).rejects.toMatchObject({
      code: "STARTUP_MIGRATION_BUDGET_EXCEEDED",
      budgetMs: STARTUP_MIGRATION_BUDGET_MS,
    });
    await expect(client.query("SELECT 1")).rejects.toBeInstanceOf(StartupMigrationBudgetExceededError);
    expect(connection.query).toHaveBeenCalledTimes(sent);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid limit (%s) before touching the connection",
    async (value) => {
      const connection = fakeConnection();
      await expect(
        boundStartupMigrationClient(connection, { ...STARTUP_MIGRATION_LIMITS, lockTimeoutMs: value }),
      ).rejects.toBeInstanceOf(RangeError);
      expect(connection.query).not.toHaveBeenCalled();
    },
  );
});

const url = process.env.ECHELON_TEST_DATABASE_URL;

describe.skipIf(!url)("startup migration guard against PostgreSQL", () => {
  it("fails a fallback that is blocked by another session's lock instead of waiting", async () => {
    const table = `startup_guard_${process.pid}_${Date.now()}`;
    const holder = new pg.Client({ connectionString: url });
    const boot = new pg.Client({ connectionString: url });
    await holder.connect();
    await boot.connect();
    try {
      await holder.query(`CREATE TABLE ${table}(id integer)`);
      // An open transaction that has read the table blocks ALTER TABLE, which
      // needs ACCESS EXCLUSIVE: the situation a busy orders table creates.
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${table}`);
      const client = await boundStartupMigrationClient(boot, {
        lockTimeoutMs: 200,
        statementTimeoutMs: 5_000,
        budgetMs: 5_000,
      });
      const started = Date.now();
      await expect(
        client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS extra integer`),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(3_000);
      await holder.query("ROLLBACK");
      // Once the lock is gone the same fallback succeeds on the same session.
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS extra integer`);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
      await holder.end();
      await boot.end();
    }
  });
});
