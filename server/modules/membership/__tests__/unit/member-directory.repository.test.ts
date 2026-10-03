import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { connectionPerQuery } from "../../infrastructure/member-directory.repository";

function fakePool(query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }>) {
  const client = { query: vi.fn(query), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client as unknown as PoolClient) };
  return { pool: pool as unknown as Pick<Pool, "connect">, client, connect: pool.connect };
}

describe("connectionPerQuery", () => {
  it("borrows a connection for the query and returns it", async () => {
    const { pool, client } = fakePool(async () => ({ rows: [{ member_id: "m-1" }] }));

    const result = await connectionPerQuery(pool).query("SELECT 1", ["x"]);

    expect(result.rows).toEqual([{ member_id: "m-1" }]);
    expect(client.query).toHaveBeenCalledWith("SELECT 1", ["x"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns the connection when the query fails, and rethrows", async () => {
    const { pool, client } = fakePool(async () => {
      throw new Error("relation does not exist");
    });

    await expect(connectionPerQuery(pool).query("SELECT 1")).rejects.toThrow("relation does not exist");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("does not release a connection it never got", async () => {
    const { pool, client, connect } = fakePool(async () => ({ rows: [] }));
    connect.mockRejectedValueOnce(new Error("pool exhausted"));

    await expect(connectionPerQuery(pool).query("SELECT 1")).rejects.toThrow("pool exhausted");
    expect(client.release).not.toHaveBeenCalled();
  });
});
