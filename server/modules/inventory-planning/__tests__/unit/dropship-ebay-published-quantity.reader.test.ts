import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { readDropshipEbayPublishedQuantities } from "../../quantity-publication";

/**
 * What inventory planning last published to a Dropship eBay store (eBay
 * sync-back's quantity baseline under canonical authority): read-only, one
 * statement, the newest row per size, settled only when acknowledged or
 * verified. Over a scripted pool: the SQL's joins run against PostgreSQL in
 * the dropship sync-back suite.
 */
describe("readDropshipEbayPublishedQuantities", () => {
  function pool(rows: Array<Record<string, unknown>>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const scripted = { calls, query: async (sql: string, params: unknown[]) => { calls.push({ sql, params }); return { rows }; } };
    return scripted as typeof scripted & Pick<Pool, "query">;
  }
  const ACK = new Date("2026-10-22T10:00:00.000Z");
  const VERIFIED = new Date("2026-10-22T10:05:00.000Z");

  it("reads the newest row per size on the store's live Card Shellz destination, with each size once", async () => {
    const scripted = pool([]);
    await readDropshipEbayPublishedQuantities(scripted, { storeConnectionId: 22, productVariantIds: [101, 101, 102] });
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]!.params).toEqual([22, [101, 102], false]);
    expect(scripted.calls[0]!.sql).toContain("target.state = 'live' AND target.publication_authority = 'echelon'");
    expect(scripted.calls[0]!.sql).toContain("ORDER BY outbox.product_variant_id, outbox.desired_revision DESC, outbox.id DESC");
    expect(scripted.calls[0]!.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/);
  });

  // Review OR-2: a row every admission attempt proved not sent cannot have changed eBay; the transport's own view skips its write.
  it("skips rows that never reached eBay, and the row being written when the transport asks", async () => {
    const scripted = pool([]);
    await readDropshipEbayPublishedQuantities(scripted, { storeConnectionId: 22, productVariantIds: [101], excludeLeased: true });
    expect(scripted.calls[0]!.params).toEqual([22, [101], true]);
    expect(scripted.calls[0]!.sql).toContain("AND NOT ($3::boolean AND outbox.state = 'leased')");
    expect(scripted.calls[0]!.sql).toContain("attempt.outbox_id = outbox.id AND attempt.state <> 'not_sent'");
  });

  it("settles a row only once eBay acknowledged it or a read-back verified it (verified time first)", async () => {
    const rows = await readDropshipEbayPublishedQuantities(pool([
      { product_variant_id: 101, desired_quantity: "7", state: "verified", verified_at: VERIFIED, acknowledged_at: ACK },
      { product_variant_id: 102, desired_quantity: "4", state: "acknowledged", verified_at: null, acknowledged_at: ACK },
      { product_variant_id: 103, desired_quantity: "9", state: "leased", verified_at: null, acknowledged_at: null },
      { product_variant_id: 104, desired_quantity: "0", state: "dead_letter", verified_at: null, acknowledged_at: ACK },
    ]), { storeConnectionId: 22, productVariantIds: [101, 102, 103, 104] });
    expect(rows).toEqual([
      { productVariantId: 101, desiredQuantity: 7, state: "verified", settledAt: VERIFIED },
      { productVariantId: 102, desiredQuantity: 4, state: "acknowledged", settledAt: ACK },
      { productVariantId: 103, desiredQuantity: 9, state: "leased", settledAt: null },
      { productVariantId: 104, desiredQuantity: 0, state: "dead_letter", settledAt: null },
    ]);
  });

  it("refuses a quantity past 2^53 instead of rounding it, and input outside its contract", async () => {
    await expect(readDropshipEbayPublishedQuantities(pool([{ product_variant_id: 101, desired_quantity: "9007199254740993", state: "verified",
      verified_at: VERIFIED, acknowledged_at: ACK }]), { storeConnectionId: 22, productVariantIds: [101] }))
      .rejects.toMatchObject({ code: "DROPSHIP_PUBLISHED_QUANTITY_INVALID" });
    await expect(readDropshipEbayPublishedQuantities(pool([]), { storeConnectionId: 22, productVariantIds: [] })).rejects.toThrow();
    await expect(readDropshipEbayPublishedQuantities(pool([]), { storeConnectionId: 0, productVariantIds: [1] })).rejects.toThrow();
  });
});
