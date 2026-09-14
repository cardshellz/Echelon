import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createDropshipOmsChannelResolver,
  isWarehouseEnabledForChannelWithClient,
  listEnabledWarehouseIdsForChannelWithClient,
  PgDropshipOmsWarehouseAssignmentReader,
} from "../../infrastructure/dropship-oms-warehouse-assignments.reader";

function fakePool(handler: (sql: string, params: unknown[]) => unknown[]) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: handler(sql, params) }));
  return { pool: { query } as unknown as Pick<Pool, "query">, query };
}

const DROPSHIP_OMS = { id: 103, name: "Dropship OMS", status: "active", type: "internal", provider: "manual" };

describe("Dropship OMS warehouse assignment reader", () => {
  it("lists only enabled assignments of the resolved Dropship OMS channel", async () => {
    const { pool, query } = fakePool((sql, params) => {
      if (sql.includes("FROM channels.channels")) return [DROPSHIP_OMS];
      if (sql.includes("FROM channels.channel_warehouse_assignments")) {
        expect(params).toEqual([103]);
        return [{ warehouse_id: 1 }, { warehouse_id: "35" }];
      }
      throw new Error(`unexpected statement: ${sql}`);
    });

    await expect(new PgDropshipOmsWarehouseAssignmentReader(pool).listEnabledWarehouseIds()).resolves.toEqual([1, 35]);
    const assignmentSql = String(query.mock.calls.find(([sql]) => String(sql).includes("channel_warehouse_assignments"))?.[0]);
    expect(assignmentSql).toContain("enabled = true");
  });

  it("propagates a missing Dropship OMS channel instead of returning an empty allowlist", async () => {
    const { pool } = fakePool((sql) => (sql.includes("FROM channels.channels") ? [] : []));
    await expect(new PgDropshipOmsWarehouseAssignmentReader(pool).listEnabledWarehouseIds()).rejects.toMatchObject({
      code: "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED",
    });
  });

  it("answers a single warehouse check with the enabled predicate in SQL", async () => {
    const { pool, query } = fakePool((_sql, params) => (params[1] === 1 ? [{ warehouse_id: 1 }] : []));
    await expect(isWarehouseEnabledForChannelWithClient(pool, { channelId: 103, warehouseId: 1 })).resolves.toBe(true);
    await expect(isWarehouseEnabledForChannelWithClient(pool, { channelId: 103, warehouseId: 35 })).resolves.toBe(false);
    expect(String(query.mock.calls[0][0])).toContain("enabled = true");
    expect(query.mock.calls[0][1]).toEqual([103, 1]);
  });

  it("resolves the channel on its own client and releases it even when resolution fails", async () => {
    const release = vi.fn();
    let rows: unknown[] = [DROPSHIP_OMS];
    const client = { query: vi.fn(async () => ({ rows })), release };
    const connectionPool = { connect: vi.fn(async () => client) } as unknown as Pick<Pool, "connect">;
    const resolver = createDropshipOmsChannelResolver(connectionPool);

    await expect(resolver.resolveChannelId()).resolves.toBe(103);
    expect(release).toHaveBeenCalledTimes(1);

    rows = [];
    await expect(resolver.resolveChannelId()).rejects.toMatchObject({ code: "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED" });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list for a channel with no enabled assignments", async () => {
    const { pool } = fakePool(() => []);
    await expect(listEnabledWarehouseIdsForChannelWithClient(pool, 103)).resolves.toEqual([]);
  });
});
