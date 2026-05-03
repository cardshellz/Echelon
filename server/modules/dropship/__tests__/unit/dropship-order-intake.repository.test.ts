import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { resolveDropshipOmsChannelIdWithClient } from "../../infrastructure/dropship-order-intake.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const ORIGINAL_ENV = process.env;

describe("resolveDropshipOmsChannelIdWithClient", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DROPSHIP_OMS_CHANNEL_ID;
    delete process.env.DROPSHIP_OMS_CHANNEL_NAME;
    delete process.env.DROPSHIP_OMS_CHANNEL_PROVIDER;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("uses an explicitly configured active channel id", async () => {
    process.env.DROPSHIP_OMS_CHANNEL_ID = "42";
    const query = vi.fn(async () => ({
      rows: [{ id: 42, status: "active" }],
    }));
    const client = { query } as unknown as PoolClient;

    await expect(resolveDropshipOmsChannelIdWithClient(client)).resolves.toBe(42);

    expect(String(query.mock.calls[0]?.[0])).toContain("WHERE id = $1");
    expect(query.mock.calls[0]?.[1]).toEqual([42]);
  });

  it("resolves one active channel marked by dropship OMS feature config", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: 77, status: "active" }],
    }));
    const client = { query } as unknown as PoolClient;

    await expect(resolveDropshipOmsChannelIdWithClient(client)).resolves.toBe(77);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("c.shipping_config #>> '{dropship,role}'");
    expect(sql).toContain("channels.channel_connections");
    expect(sql).toContain("cc.metadata #>> '{features,dropshipOms}'");
  });

  it("rejects ambiguous Dropship OMS feature config", async () => {
    const query = vi.fn(async () => ({
      rows: [
        { id: 77, status: "active" },
        { id: 88, status: "active" },
      ],
    }));
    const client = { query } as unknown as PoolClient;

    await expect(resolveDropshipOmsChannelIdWithClient(client)).rejects.toMatchObject({
      code: "DROPSHIP_OMS_CHANNEL_CONFIG_AMBIGUOUS",
      context: { channelIds: [77, 88] },
    });
  });

  it("does not fall back to legacy name/provider guesses", async () => {
    process.env.DROPSHIP_OMS_CHANNEL_NAME = "Dropship OMS";
    process.env.DROPSHIP_OMS_CHANNEL_PROVIDER = "manual";
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query } as unknown as PoolClient;

    await expect(resolveDropshipOmsChannelIdWithClient(client)).rejects.toMatchObject({
      code: "DROPSHIP_OMS_CHANNEL_CONFIG_REQUIRED",
      context: {
        envChannelId: "DROPSHIP_OMS_CHANNEL_ID",
        channelShippingConfig: { dropship: { role: "oms" } },
      },
    });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toContain("LOWER(name)");
    expect(sql).not.toContain("provider = $2");
  });

  it("rejects invalid explicit channel id config before DB access", async () => {
    process.env.DROPSHIP_OMS_CHANNEL_ID = "not-an-id";
    const query = vi.fn();
    const client = { query } as unknown as PoolClient;

    await expect(resolveDropshipOmsChannelIdWithClient(client)).rejects.toMatchObject({
      code: "DROPSHIP_OMS_CHANNEL_ID_INVALID",
      context: { env: "DROPSHIP_OMS_CHANNEL_ID", value: "not-an-id" },
    });
    expect(query).not.toHaveBeenCalled();
  });
});
