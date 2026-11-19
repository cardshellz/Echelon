import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usesChannelMerchandiseQuantities } from "../../domain/channel-merchandise-policy";
import {
  channelMerchandiseCapabilitySql,
  readChannelMerchandiseCapability,
} from "../../infrastructure/channel-merchandise-policy";

afterEach(() => vi.unstubAllEnvs());

describe("provider-owned merchandise quantity policy", () => {
  it.each([
    ["shopify", true], ["ebay", false], ["walmart", false],
    ["dropship", false], [null, false], [undefined, false],
  ] as const)("uses the %s provider contract: %s", (provider, supported) => {
    expect(usesChannelMerchandiseQuantities(provider)).toBe(supported);
  });

  it.each([1, 36, 37, 200_000])("uses persisted Shopify identity for channel %s without rollout configuration", async channelId => {
    vi.stubEnv("OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED", "false");
    vi.stubEnv("OMS_CHANNEL_MERCHANDISE_CHANNEL_IDS", "");
    const execute = vi.fn(async (_query: SQL) => ({ rows: [{ provider: "shopify" }] }));
    expect(await readChannelMerchandiseCapability({ execute }, channelId)).toBe(true);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([channelId]);
  });

  it("preserves the provider boundary independently of channel number", async () => {
    const execute = vi.fn(async () => ({ rows: [{ provider: "ebay" }] }));
    expect(await readChannelMerchandiseCapability({ execute }, 36)).toBe(false);
  });

  it.each([{ rows: [] }, { rows: [{ provider: "" }] }, { rows: [{ provider: "shopify" }, { provider: "ebay" }] }])(
    "fails explicitly on missing or ambiguous identity: %j", async ({ rows }) => {
      const execute = vi.fn(async () => ({ rows }));
      await expect(readChannelMerchandiseCapability({ execute }, 36))
        .rejects.toMatchObject({ code: "CHANNEL_MERCHANDISE_PROVIDER_UNAVAILABLE", channelId: 36 });
    },
  );

  it("does not turn a provider read outage into legacy refund cancellation", async () => {
    const execute = vi.fn(async () => { throw new Error("Synthetic provider read outage"); });
    await expect(readChannelMerchandiseCapability({ execute }, 36))
      .rejects.toMatchObject({ code: "CHANNEL_MERCHANDISE_PROVIDER_UNAVAILABLE" });
  });

  it.each([0, -1, 1.5, Number.NaN, 2_147_483_648])("rejects invalid channel identity %s before querying", async channelId => {
    const execute = vi.fn();
    await expect(readChannelMerchandiseCapability({ execute }, channelId)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("builds the SQL capability from persisted provider identity", () => {
    const query = new PgDialect().sqlToQuery(channelMerchandiseCapabilitySql(sql`source.channel_id`));
    expect(query.sql).toContain("merchandise_channel.id=source.channel_id");
    expect(query.params).toEqual(["shopify"]);
  });
});
