import { describe, expect, it, vi } from "vitest";

import { PostgresInventoryAvailabilityRuntimeAtpExecutor } from "../../infrastructure/inventory-availability-runtime-atp.repository";

describe("PostgresInventoryAvailabilityRuntimeAtpExecutor", () => {
  it("locks one validated legacy authority revision until the selected read commits", async () => {
    const client = fakeClient({
      authority: "legacy",
      authority_revision: "1",
      activation_run_id: null,
    });
    const executor = new PostgresInventoryAvailabilityRuntimeAtpExecutor({
      connect: vi.fn(async () => client),
    } as never);

    const result = await executor.execute(async (context) => ({
      authority: context.authority,
      authorityRevision: context.authorityRevision,
      activationRunId: context.activationRunId,
    }));

    expect(result).toEqual({ authority: "legacy", authorityRevision: "1", activationRunId: null });
    expect(client.query.mock.calls.map((call) => String(call[0]).trim())).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("FOR SHARE"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and fails closed when the authority singleton is invalid", async () => {
    const client = fakeClient(null);
    const executor = new PostgresInventoryAvailabilityRuntimeAtpExecutor({
      connect: vi.fn(async () => client),
    } as never);

    await expect(executor.execute(async () => "unreachable")).rejects.toMatchObject({
      code: "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
    });
    expect(client.query.mock.calls.map((call) => String(call[0]).trim())).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("FOR SHARE"),
      "ROLLBACK",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

function fakeClient(authority: Record<string, unknown> | null) {
  const query = vi.fn(async (statement: unknown) => {
    const sql = String(statement).trim();
    if (sql.startsWith("SELECT authority")) return { rows: authority ? [authority] : [] };
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}
