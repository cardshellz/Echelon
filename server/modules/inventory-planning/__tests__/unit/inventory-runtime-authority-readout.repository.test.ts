import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresInventoryRuntimeAuthorityReadoutRepository } from "../../infrastructure/inventory-runtime-authority-readout.repository";

function createPool(query: (sql: string) => Promise<{ rows: unknown[] }>) {
  const spy = vi.fn(query);
  return { pool: { query: spy } as unknown as Pick<Pool, "query">, spy };
}

describe("PostgresInventoryRuntimeAuthorityReadoutRepository", () => {
  it("reads the singleton with bigint text casts and hands back ISO timestamps", async () => {
    const changedAt = new Date("2026-09-12T14:00:00.000Z");
    const { pool, spy } = createPool(async () => ({ rows: [{
      authority: "canonical", revision: "7", activation_run_id: "42",
      changed_by: "operator-9", change_reason: "Cutover commit.", changed_at: changedAt,
    }] }));

    const records = await new PostgresInventoryRuntimeAuthorityReadoutRepository(pool).read();

    expect(records).toEqual([{
      authority: "canonical", revision: "7", activationRunId: "42",
      changedBy: "operator-9", changeReason: "Cutover commit.", changedAt: "2026-09-12T14:00:00.000Z",
    }]);
    const statement = String(spy.mock.calls[0][0]);
    expect(statement).toContain("FROM inventory.availability_runtime_authority");
    expect(statement).toContain("WHERE singleton_key = true");
    expect(statement).toContain("revision::text");
    expect(statement).toContain("activation_run_id::text");
    expect(statement).not.toMatch(/FOR (SHARE|UPDATE)/i);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns every row unchanged so the domain, not the driver layer, decides validity", async () => {
    const { pool } = createPool(async () => ({ rows: [] }));
    await expect(new PostgresInventoryRuntimeAuthorityReadoutRepository(pool).read()).resolves.toEqual([]);
  });

  it("classifies a driver failure as a transient read failure without leaking it into the message", async () => {
    const { pool } = createPool(async () => { throw new Error("connection to host db-private refused"); });

    await expect(new PostgresInventoryRuntimeAuthorityReadoutRepository(pool).read()).rejects.toMatchObject({
      status: 503,
      code: "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED",
      classification: "transient",
      message: "The inventory runtime authority could not be read.",
      context: { cause: "connection to host db-private refused" },
    });
  });
});
