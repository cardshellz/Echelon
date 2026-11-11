import { describe, expect, it, vi } from "vitest";
import {
  STARTUP_MIGRATION_LOCK_TIMEOUT_MS,
  StartupMigrationLockBlockedError,
  guardStartupMigrationClient,
} from "../startup-migration-guard";

const lockTimeout = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

describe("startup migration lock guard", () => {
  it("sets a bounded session lock_timeout before any DDL runs", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await guardStartupMigrationClient({ query }, { error: vi.fn() });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(`SET lock_timeout = ${STARTUP_MIGRATION_LOCK_TIMEOUT_MS}`);
    expect(STARTUP_MIGRATION_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(STARTUP_MIGRATION_LOCK_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("passes statements and their results through while no lock is blocked", async () => {
    const query = vi.fn(async (text: string) => ({ rows: [{ text }] }));
    const guarded = await guardStartupMigrationClient({ query }, { error: vi.fn() });
    await expect(guarded.query("SELECT 1", [7])).resolves.toEqual({ rows: [{ text: "SELECT 1" }] });
    expect(query).toHaveBeenLastCalledWith("SELECT 1", [7]);
  });

  it("after one lock timeout, skips every later statement without touching the database", async () => {
    const logger = { error: vi.fn() };
    const query = vi.fn(async (text: string) => {
      if (text.includes("oms_orders")) throw lockTimeout();
      return { rows: [] };
    });
    const guarded = await guardStartupMigrationClient({ query }, logger);
    await guarded.query("ALTER TABLE wms.returns ADD COLUMN IF NOT EXISTS status VARCHAR(20)");
    const blocked = await guarded.query("ALTER TABLE oms.oms_orders\n  ADD COLUMN IF NOT EXISTS shipstation_order_id INTEGER")
      .catch(error => error);
    expect(blocked).toBeInstanceOf(StartupMigrationLockBlockedError);
    expect(blocked).toMatchObject({ code: "STARTUP_MIGRATION_LOCK_BLOCKED", classification: "transient",
      statement: "ALTER TABLE oms.oms_orders ADD COLUMN IF NOT EXISTS shipstation_order_id INTEGER" });
    const callsBefore = query.mock.calls.length;
    // The caller's nested try/catch blocks keep issuing statements; none may wait again.
    for (const statement of ["CREATE INDEX IF NOT EXISTS a ON t(x)", "ALTER TABLE t ADD COLUMN IF NOT EXISTS y int"]) {
      await expect(guarded.query(statement)).rejects.toBeInstanceOf(StartupMigrationLockBlockedError);
    }
    expect(query.mock.calls.length).toBe(callsBefore);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
      action: "startup_migration.lock_blocked", outcome: "skipped", error_code: "STARTUP_MIGRATION_LOCK_BLOCKED" }));
  });

  it("does not trip on other errors, which keep their original identity", async () => {
    const duplicate = Object.assign(new Error("relation already exists"), { code: "42P07" });
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce({ rows: [{ ok: true }] });
    const guarded = await guardStartupMigrationClient({ query }, { error: vi.fn() });
    await expect(guarded.query("CREATE TABLE x()")).rejects.toBe(duplicate);
    await expect(guarded.query("SELECT 1")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("fails boot DDL setup loudly if the timeout itself cannot be set", async () => {
    const query = vi.fn(async () => { throw new Error("connection lost"); });
    await expect(guardStartupMigrationClient({ query }, { error: vi.fn() })).rejects.toThrow("connection lost");
  });
});
