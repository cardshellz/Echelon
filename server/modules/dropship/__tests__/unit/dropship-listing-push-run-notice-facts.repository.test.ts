import { describe, expect, it } from "vitest";
import { PgDropshipListingPushRunSweepRepository } from "../../infrastructure/dropship-listing-push-run-sweep.repository";

/**
 * The run notice's reads (listRunsAwaitingNotice → readRunNoticeFacts): the sizes only waiting for stock are decided
 * by isListingPushItemWaitingForStock over the rows read, counted, and left out of the problem rows by id. A fake pool
 * answers by statement; no database.
 */
const NOW = new Date("2026-11-08T12:00:00.000Z");
const runRow = {
  id: "4", vendor_id: 10, store_connection_id: 22, scope: "all", status: "partial", stop_reason: null, selection_revision_id: null,
  idempotency_key: "run-key", request_hash: "hash", target_count: 5, chunk_size: 100, chunk_count: 1, next_chunk_index: 1,
  chunk_attempts: 0, actor_type: "vendor", actor_id: "member-1", cancel_requested_at: null, created_at: NOW, updated_at: NOW,
  completed_at: NOW,
};

function fakePool(input: { platform: string; blockedRows: Array<Record<string, unknown>> }) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const query = async (text: string, values: unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("r.notified_at IS NULL")) return { rows: [runRow] };
    if (text.includes("GROUP BY run_id, outcome")) return { rows: [{ run_id: "4", outcome: "blocked", count: "3" }, { run_id: "4", outcome: "failed", count: "1" }] };
    if (text.includes("FROM dropship.dropship_store_connections")) return { rows: [{ external_display_name: "marz_cards", platform: input.platform }] };
    if (text.includes("JOIN dropship.dropship_vendor_listings l")) return { rows: input.blockedRows };
    if (text.includes("LEFT JOIN catalog.product_variants")) return { rows: [] };
    if (text.includes("t.code = ANY($2::text[])")) return { rows: [] };
    throw new Error(`unexpected statement: ${text}`);
  };
  return { pool: { query, connect: async () => { throw new Error("no transaction expected"); } }, queries };
}

const blocked = (productVariantId: number, errorMessage: string, externalListingId: string | null = null) => ({
  product_variant_id: productVariantId, status: "blocked", code: "DROPSHIP_LISTING_PREVIEW_BLOCKED", error_message: errorMessage,
  external_listing_id: externalListingId,
});

describe("PgDropshipListingPushRunSweepRepository run notice facts", () => {
  it("counts the eBay sizes only waiting for stock and leaves them out of the problem rows", async () => {
    const { pool, queries } = fakePool({ platform: "ebay", blockedRows: [
      blocked(101, "marketplace_quantity_unavailable"),
      blocked(102, "marketplace_quantity_unavailable, variant_not_selected"),
      blocked(103, "marketplace_quantity_unavailable", "110100"),
      blocked(104, "marketplace_quantity_unavailable"),
    ] });
    const repository = new PgDropshipListingPushRunSweepRepository(pool as never);
    const [facts] = await repository.listRunsAwaitingNotice({ now: NOW, windowMs: 60_000, limit: 5, problemLimit: 25 });
    expect(facts).toMatchObject({ storeName: "marz_cards", waitingForStockCount: 2, counts: { blocked: 3, failed: 1 } });
    const waitingRead = queries.find((entry) => entry.text.includes("JOIN dropship.dropship_vendor_listings l"))!;
    expect(waitingRead.text).toContain("t.outcome = 'blocked' AND t.code = $2");
    expect(waitingRead.values).toEqual([4, "DROPSHIP_LISTING_PREVIEW_BLOCKED"]);
    const problemsRead = queries.find((entry) => entry.text.includes("LEFT JOIN catalog.product_variants"))!;
    expect(problemsRead.text).toContain("AND NOT (t.product_variant_id = ANY($4::int[]))");
    expect(problemsRead.values[3]).toEqual([101, 104]);
  });

  it("finds none waiting off eBay, and excludes nothing", async () => {
    const { pool, queries } = fakePool({ platform: "shopify", blockedRows: [blocked(101, "marketplace_quantity_unavailable")] });
    const repository = new PgDropshipListingPushRunSweepRepository(pool as never);
    const [facts] = await repository.listRunsAwaitingNotice({ now: NOW, windowMs: 60_000, limit: 5, problemLimit: 25 });
    expect(facts.waitingForStockCount).toBe(0);
    expect(queries.find((entry) => entry.text.includes("LEFT JOIN catalog.product_variants"))!.values[3]).toEqual([]);
  });
});
