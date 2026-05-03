import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipOmsChannelConfigRepository } from "../../infrastructure/dropship-oms-channel-config.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-03T18:30:00.000Z");

describe("PgDropshipOmsChannelConfigRepository", () => {
  it("atomically clears previous OMS markers before marking the selected active channel", async () => {
    const { pool, query } = makePool(async (sql) => {
      if (sql.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
        return { rows: [{ id: 101 }] };
      }
      if (sql.includes("SELECT id, name, type, provider, status") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 7, name: "Dropship OMS", type: "internal", provider: "manual", status: "active" }] };
      }
      if (sql.includes("UPDATE channels.channels") && sql.includes("RETURNING")) {
        return { rows: [makeChannelRow({ id: 7, channel_role_marked: true, channel_flag_marked: true })] };
      }
      if (sql.includes("FROM channels.channels c")) {
        return { rows: [makeChannelRow({ id: 7, channel_role_marked: true, channel_flag_marked: true })] };
      }
      return { rows: [] };
    });
    const repository = new PgDropshipOmsChannelConfigRepository(pool);

    const result = await repository.configure({
      channelId: 7,
      idempotencyKey: "oms-channel-config-001",
      requestHash: "hash-1",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    });

    const sql = query.mock.calls.map((call) => String(call[0])).join("\n\n");
    expect(result.config.currentChannelId).toBe(7);
    expect(result.config.currentChannelCount).toBe(1);
    expect(sql).toContain("BEGIN");
    expect(sql).toContain("UPDATE channels.channels");
    expect(sql).toContain("#- '{dropship,role}'");
    expect(sql).toContain("UPDATE channels.channel_connections");
    expect(sql).toContain("'{features,dropshipOms}'");
    expect(sql).toContain("'{features,dropship_oms}'");
    expect(sql).toContain("INSERT INTO dropship.dropship_audit_events");
    expect(sql).toContain("COMMIT");
  });

  it("rolls back without marking a paused channel", async () => {
    const { pool, query } = makePool(async (sql) => {
      if (sql.includes("INSERT INTO dropship.dropship_admin_config_commands")) {
        return { rows: [{ id: 102 }] };
      }
      if (sql.includes("SELECT id, name, type, provider, status") && sql.includes("FOR UPDATE")) {
        return { rows: [{ id: 8, name: "Paused OMS", type: "internal", provider: "manual", status: "paused" }] };
      }
      return { rows: [] };
    });
    const repository = new PgDropshipOmsChannelConfigRepository(pool);

    await expect(repository.configure({
      channelId: 8,
      idempotencyKey: "oms-channel-config-002",
      requestHash: "hash-2",
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    })).rejects.toMatchObject({ code: "DROPSHIP_OMS_CHANNEL_NOT_ACTIVE" });

    const sql = query.mock.calls.map((call) => String(call[0])).join("\n\n");
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("'{dropship,role}',\n                 to_jsonb('oms'::text)");
  });
});

function makePool(
  onQuery: (sql: string, params: unknown[] | undefined) => Promise<{ rows: unknown[] }>,
): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [] };
    }
    return onQuery(String(sql), params);
  });
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, query };
}

function makeChannelRow(overrides: Partial<Record<keyof ChannelRowForTest, unknown>> = {}): ChannelRowForTest {
  return {
    id: 7,
    name: "Dropship OMS",
    type: "internal",
    provider: "manual",
    status: "active",
    updated_at: now,
    channel_role_marked: false,
    channel_flag_marked: false,
    connection_role_marked: false,
    connection_feature_marked: false,
    ...overrides,
  } as ChannelRowForTest;
}

interface ChannelRowForTest {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
  updated_at: Date;
  channel_role_marked: boolean;
  channel_flag_marked: boolean;
  connection_role_marked: boolean;
  connection_feature_marked: boolean;
}
