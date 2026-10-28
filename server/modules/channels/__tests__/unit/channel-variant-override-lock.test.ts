import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_VARIANT_OVERRIDES_LOCK_SQL, CHANNEL_VARIANT_OVERRIDE_LOCK_SQL, channelVariantOverrideLockKey,
} from "../../infrastructure/channel-variant-override-lock";

// Channels PR2 review DB-1: a first channel SKU override (an INSERT no row lock covers) is serialized with the
// stock-link SKU confirmation by one advisory key per (channel, size). The real interleaving runs against PostgreSQL in
// stock-link.integration.test.ts ("serializes a first channel SKU override ...").
describe("channel variant override lock", () => {
  it("names one key per channel and size, and refuses ids that are not positive integers", () => {
    expect(channelVariantOverrideLockKey(35, 101)).toBe("channel-variant-override:35:101");
    for (const [channelId, variantId] of [[0, 1], [1, 0], [-1, 1], [1.5, 1], [Number.NaN, 1], [1, Number.MAX_SAFE_INTEGER + 1]])
      expect(() => channelVariantOverrideLockKey(channelId!, variantId!)).toThrow();
  });

  it("builds the same key text in SQL for several sizes, in variant-id order, transaction-scoped only", () => {
    expect(CHANNEL_VARIANT_OVERRIDES_LOCK_SQL).toContain("'channel-variant-override:' || $1::integer::text || ':' || ordered.id::text");
    expect(CHANNEL_VARIANT_OVERRIDES_LOCK_SQL).toContain("ORDER BY id");
    for (const text of [CHANNEL_VARIANT_OVERRIDES_LOCK_SQL, CHANNEL_VARIANT_OVERRIDE_LOCK_SQL]) {
      expect(text).toContain("pg_advisory_xact_lock(hashtextextended(");
      expect(text).not.toMatch(/pg_advisory_lock\(/);
    }
  });

  it("is taken by the only SKU-override writer inside its transaction, and by the stock-link SKU confirmation", () => {
    const storage = readFileSync(join(process.cwd(), "server/modules/channels/channel-catalog.storage.ts"), "utf8");
    const upsert = storage.slice(storage.indexOf("async upsertChannelVariantOverride"), storage.indexOf("async deleteChannelVariantOverride"));
    expect(upsert).toContain("return db.transaction(async (tx) => {");
    expect(upsert).toContain("await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${channelVariantOverrideLockKey(");
    expect(upsert.indexOf("pg_advisory_xact_lock")).toBeLessThan(upsert.indexOf("tx.insert(channelVariantOverrides)"));
    const source = readFileSync(join(process.cwd(), "server/modules/channels/infrastructure/shopify-stock-link-source.ts"), "utf8");
    const confirm = source.slice(source.indexOf("async lockForConfirmation"));
    expect(confirm.indexOf("CHANNEL_VARIANT_OVERRIDES_LOCK_SQL")).toBeGreaterThan(0);
    expect(confirm.indexOf("CHANNEL_VARIANT_OVERRIDES_LOCK_SQL")).toBeLessThan(confirm.indexOf("FOR SHARE`"));
  });
});
