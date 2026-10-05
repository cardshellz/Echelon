import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { DropshipError } from "../../domain/errors";
import {
  FINANCE_BUDGET_EXCEEDED_CODE,
  FINANCE_REQUEST_BUDGET_MS,
  FinanceRowError,
  financeCodeForDatabaseError,
  withFinanceReadTransaction,
  type FinanceBudgetClock,
} from "../../infrastructure/dropship-finance-read-transaction";

const T0 = new Date("2026-10-05T13:14:00.000Z");

function pgError(code: string, message = `pg ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A settable clock: tests move it to spend the request budget. */
function manualClock(start = T0): FinanceBudgetClock & { advance(ms: number): void } {
  let now = start.getTime();
  return { now: () => new Date(now), advance: (ms) => { now += ms; } };
}

interface FakeClient {
  sql: string[];
  release: ReturnType<typeof vi.fn>;
  client: PoolClient;
}

/** A pinned client that records every statement; `fail` decides which ones throw. */
function fakeClient(fail: (sql: string) => Error | null = () => null): FakeClient {
  const sql: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (text: string) => {
      sql.push(text);
      const error = fail(text);
      if (error) throw error;
      return { rows: [{ value: 1 }] };
    }),
    release,
  } as unknown as PoolClient;
  return { sql, release, client };
}

const poolOf = (client: PoolClient): Pick<Pool, "connect"> => ({ connect: vi.fn(async () => client) }) as unknown as Pick<Pool, "connect">;

describe("withFinanceReadTransaction", () => {
  it("opens a REPEATABLE READ READ ONLY snapshot with an 8s timeout and UTC, then commits", async () => {
    const fake = fakeClient();
    const result = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, async (tx) => {
      await tx.query("SELECT 1", []);
      return "done";
    });

    expect(result).toBe("done");
    expect(fake.sql).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL statement_timeout = '8s'",
      "SET LOCAL TIME ZONE 'UTC'",
      "SELECT 1",
      "COMMIT",
    ]);
    expect(fake.release).toHaveBeenCalledWith(false);
  });

  it("wraps each section in its own savepoint and releases it", async () => {
    const fake = fakeClient();
    const outcome = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, async (tx) => {
      const first = await tx.section("orders", async (runner) => runner.query<{ value: number }>("SELECT orders", []));
      const second = await tx.section("ledger", async (runner) => runner.query("SELECT ledger", []));
      return { first, second, outcomes: tx.statementOutcomes() };
    });

    expect(fake.sql.slice(3, -1)).toEqual([
      "SAVEPOINT fin_1", "SELECT orders", "RELEASE SAVEPOINT fin_1",
      "SAVEPOINT fin_2", "SELECT ledger", "RELEASE SAVEPOINT fin_2",
    ]);
    expect(outcome.first).toEqual({ status: "ok", data: [{ value: 1 }] });
    expect(outcome.outcomes.map((entry) => [entry.name, entry.status])).toEqual([["orders", "ok"], ["ledger", "ok"]]);
  });

  it("rolls a failing section back to its savepoint, reports its code, and runs the next one", async () => {
    const fake = fakeClient((sql) => (sql === "SELECT products" ? pgError("57014", "canceling statement due to statement timeout") : null));
    const outcome = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, async (tx) => {
      const products = await tx.section("products", async (runner) => runner.query("SELECT products", []));
      const ledger = await tx.section("ledger", async (runner) => runner.query("SELECT ledger", []));
      return { products, ledger, outcomes: tx.statementOutcomes() };
    });

    expect(outcome.products).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    expect(outcome.ledger.status).toBe("ok");
    expect(fake.sql).toContain("ROLLBACK TO SAVEPOINT fin_1");
    expect(fake.sql).toContain("SELECT ledger");
    expect(fake.sql.at(-1)).toBe("COMMIT");
    expect(outcome.outcomes[0]).toMatchObject({ name: "products", status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", sqlState: "57014" });
  });

  it("turns a row the mapper cannot read into that section's DATA_INVALID error", async () => {
    const fake = fakeClient();
    const outcome = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, (tx) =>
      tx.section("orders", async () => {
        throw new FinanceRowError("DROPSHIP_FINANCE_DATA_INVALID", "billed");
      }));

    expect(outcome).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_DATA_INVALID" });
    expect(fake.sql).toContain("ROLLBACK TO SAVEPOINT fin_1");
  });

  it("records which column a mapper refused, or the class of an unexpected error, never its message", async () => {
    const fake = fakeClient();
    const outcomes = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, async (tx) => {
      await tx.section("orders", async () => { throw new FinanceRowError("DROPSHIP_FINANCE_DATA_INVALID", "billed"); });
      await tx.section("products", async () => { throw new TypeError("value 1234 is wrong"); });
      return tx.statementOutcomes();
    });

    expect(outcomes[0]).toMatchObject({ name: "orders", errorCode: "DROPSHIP_FINANCE_DATA_INVALID", detail: "column:billed" });
    expect(outcomes[1]).toMatchObject({ name: "products", errorCode: "DROPSHIP_FINANCE_INTERNAL_ERROR", detail: "TypeError" });
    expect(JSON.stringify(outcomes)).not.toContain("1234");
  });

  it("skips every section once the request budget is spent, without sending SQL for them", async () => {
    const fake = fakeClient();
    const clock = manualClock();
    const outcome = await withFinanceReadTransaction(poolOf(fake.client), { clock }, async (tx) => {
      const first = await tx.section("orders", async (runner) => runner.query("SELECT orders", []));
      clock.advance(FINANCE_REQUEST_BUDGET_MS + 1_000);
      const second = await tx.section("ledger", async (runner) => runner.query("SELECT ledger", []));
      const third = await tx.section("check_K3", async (runner) => runner.query("SELECT k3", []));
      return { first, second, third, outcomes: tx.statementOutcomes() };
    });

    expect(outcome.first.status).toBe("ok");
    expect(outcome.second).toEqual({ status: "skipped", errorCode: FINANCE_BUDGET_EXCEEDED_CODE });
    expect(outcome.third).toEqual({ status: "skipped", errorCode: FINANCE_BUDGET_EXCEEDED_CODE });
    expect(fake.sql).not.toContain("SELECT ledger");
    expect(fake.sql).not.toContain("SAVEPOINT fin_2");
    expect(outcome.outcomes.map((entry) => entry.status)).toEqual(["ok", "skipped", "skipped"]);
  });

  it("records a section not run for a missing table", async () => {
    const fake = fakeClient();
    const outcome = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, async (tx) => ({
      result: tx.notRun("check_D4", "DROPSHIP_FINANCE_TABLE_MISSING"),
      outcomes: tx.statementOutcomes(),
    }));

    expect(outcome.result).toEqual({ status: "error", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING" });
    expect(outcome.outcomes).toEqual([{ name: "check_D4", status: "error", errorCode: "DROPSHIP_FINANCE_TABLE_MISSING", durationMs: 0 }]);
    expect(fake.sql).not.toContain("SAVEPOINT fin_1");
  });

  it("fails the whole request when a statement outside a section fails, and rolls back", async () => {
    const fake = fakeClient((sql) => (sql === "SELECT q0" ? pgError("57014") : null));
    const error = await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, (tx) => tx.query("SELECT q0", []))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DropshipError);
    expect((error as DropshipError).code).toBe("DROPSHIP_FINANCE_QUERY_TIMEOUT");
    expect((error as DropshipError).context).toMatchObject({ stage: "transaction", sqlState: "57014" });
    expect(fake.sql.at(-1)).toBe("ROLLBACK");
    expect(fake.sql).not.toContain("COMMIT");
    expect(fake.release).toHaveBeenCalledWith(false);
  });

  it("passes a DropshipError from the work through unchanged", async () => {
    const fake = fakeClient();
    const notFound = new DropshipError("DROPSHIP_FINANCE_VENDOR_NOT_FOUND", "That vendor does not exist.", { vendorId: 99 });
    await expect(withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, async () => {
      throw notFound;
    })).rejects.toBe(notFound);
    expect(fake.sql.at(-1)).toBe("ROLLBACK");
  });

  it("destroys the client instead of returning it to the pool when ROLLBACK fails", async () => {
    const fake = fakeClient((sql) => (sql === "SELECT q0" ? pgError("57014") : sql === "ROLLBACK" ? pgError("08006") : null));
    await expect(withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, (tx) => tx.query("SELECT q0", [])))
      .rejects.toMatchObject({ code: "DROPSHIP_FINANCE_QUERY_TIMEOUT" });
    expect(fake.release).toHaveBeenCalledWith(true);
  });

  it("fails the request when a savepoint cannot be rolled back, reporting why the rollback failed", async () => {
    const fake = fakeClient((sql) => {
      if (sql === "SELECT products") return pgError("57014");
      if (sql === "ROLLBACK TO SAVEPOINT fin_1") return pgError("08006", "connection lost");
      return null;
    });
    await expect(withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, (tx) =>
      tx.section("products", (runner) => runner.query("SELECT products", []))))
      .rejects.toMatchObject({ code: "DROPSHIP_FINANCE_DB_UNAVAILABLE" });
    expect(fake.sql).toContain("ROLLBACK");
    expect(fake.sql).not.toContain("COMMIT");
  });

  it("maps a pool that cannot connect to DB_UNAVAILABLE", async () => {
    const pool = { connect: vi.fn(async () => { throw new Error("timeout exceeded when trying to connect"); }) } as unknown as Pick<Pool, "connect">;
    await expect(withFinanceReadTransaction(pool, { clock: manualClock() }, async () => 1))
      .rejects.toMatchObject({ code: "DROPSHIP_FINANCE_DB_UNAVAILABLE", context: { stage: "connect" } });
  });

  it("does not leak database messages into the request error", async () => {
    const fake = fakeClient((sql) => (sql === "SELECT q0" ? pgError("42P01", "relation \"dropship.secret\" does not exist") : null));
    const error = (await withFinanceReadTransaction(poolOf(fake.client), { clock: manualClock() }, (tx) => tx.query("SELECT q0", []))
      .then(() => null, (caught: unknown) => caught)) as DropshipError;
    expect(error.code).toBe("DROPSHIP_FINANCE_TABLE_MISSING");
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(error.context)).not.toContain("secret");
  });
});

describe("financeCodeForDatabaseError (contract §5)", () => {
  it.each([
    ["57014", "DROPSHIP_FINANCE_QUERY_TIMEOUT"],
    ["42P01", "DROPSHIP_FINANCE_TABLE_MISSING"],
    ["42703", "DROPSHIP_FINANCE_SCHEMA_MISMATCH"],
    ["22003", "DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE"],
    ["22P02", "DROPSHIP_FINANCE_DATA_INVALID"],
    ["22008", "DROPSHIP_FINANCE_DATA_INVALID"],
    ["08006", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    ["08001", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    ["53300", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    ["57P01", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    ["57P02", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    ["57P03", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    ["40001", "DROPSHIP_FINANCE_DB_UNAVAILABLE"],
    // A write inside READ ONLY can only be a bug.
    ["25006", "DROPSHIP_FINANCE_INTERNAL_ERROR"],
    ["42601", "DROPSHIP_FINANCE_INTERNAL_ERROR"],
  ])("SQLSTATE %s → %s", (sqlState, code) => {
    expect(financeCodeForDatabaseError(pgError(sqlState))).toBe(code);
  });

  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"])("driver error %s → DB_UNAVAILABLE", (code) => {
    expect(financeCodeForDatabaseError(Object.assign(new Error(code), { code }))).toBe("DROPSHIP_FINANCE_DB_UNAVAILABLE");
  });

  it("maps a dropped connection and the pool's connect timeout to DB_UNAVAILABLE", () => {
    expect(financeCodeForDatabaseError(new Error("Connection terminated unexpectedly"))).toBe("DROPSHIP_FINANCE_DB_UNAVAILABLE");
    expect(financeCodeForDatabaseError(new Error("timeout exceeded when trying to connect"))).toBe("DROPSHIP_FINANCE_DB_UNAVAILABLE");
  });

  it("keeps a row mapper's own code, and maps anything else to INTERNAL_ERROR", () => {
    expect(financeCodeForDatabaseError(new FinanceRowError("DROPSHIP_FINANCE_DATA_INVALID", "billed"))).toBe("DROPSHIP_FINANCE_DATA_INVALID");
    expect(financeCodeForDatabaseError(new TypeError("boom"))).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
    expect(financeCodeForDatabaseError("text")).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
    expect(financeCodeForDatabaseError(null)).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
  });
});
