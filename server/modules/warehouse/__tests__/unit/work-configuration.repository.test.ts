import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { readWarehouseWorkActor } from "../../../identity/infrastructure/work-access.repository";

function transactionFixture() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const release = vi.fn();
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { query, release, client, repository: new WorkConfigurationRepository(pool) };
}
describe("warehouse work transaction safety", () => {
  it("commits once and releases the client after success", async () => {
    const f = transactionFixture();
    expect(await f.repository.transaction(async () => "saved")).toBe("saved");
    expect(f.query.mock.calls.map((args) => args[0])).toEqual(["BEGIN", "COMMIT"]);
    expect(f.release).toHaveBeenCalledWith(undefined);
  });
  it("rolls back partial work and preserves the original error", async () => {
    const f = transactionFixture(); const error = new Error("station insert failed");
    await expect(f.repository.transaction(async () => { throw error; })).rejects.toBe(error);
    expect(f.query.mock.calls.map((args) => args[0])).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("rolls back an uncertain commit and keeps the command retryable", async () => {
    const f = transactionFixture(); f.query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.repository.transaction(async () => "saved")).rejects.toThrow("connection lost");
    expect(f.query.mock.calls.map((args) => args[0])).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
  });
  it("discards a broken connection and preserves both rollback errors", async () => {
    const f = transactionFixture(); f.query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("rollback failed"));
    await expect(f.repository.transaction(async () => { throw new Error("write failed"); })).rejects.toBeInstanceOf(AggregateError);
    expect(f.release.mock.calls[0][0]).toBeInstanceOf(AggregateError);
  });
  it("reads identity-owned grants and refuses unsupported constraints", async () => {
    const f = transactionFixture();
    f.query.mockResolvedValueOnce({ rows: [{ id: "user", active: 1 }] }).mockResolvedValueOnce({ rows: [
      { action: "view", constraints: null }, { action: "configure", constraints: { warehouseId: 1 } }, { action: "picking", constraints: {} },
    ] });
    expect(await readWarehouseWorkActor(f.client, "user")).toEqual({ id: "user", active: true, permissions: ["warehouse_work:view"] });
    expect(f.query.mock.calls[0][1]).toEqual(["user"]);
    expect(f.query.mock.calls[1][0]).toContain("FOR SHARE OF ur, rp, p");
  });
});
