import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipCostChangeListingActionRepository } from "../../infrastructure/dropship-cost-change-listing-action.repository";

const NOW = new Date("2026-10-13T00:05:00.000Z");
const EFFECTIVE = new Date("2026-10-13T00:00:00.000Z");

interface Call { sql: string; values: unknown[] | undefined }

/** A pool whose single client records every statement and answers from a queue of results, in order. */
function fakePool(answers: Array<QueryResult<QueryResultRow> | Error> = []) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) return result([]);
      const next = answers.shift();
      if (next === undefined) return result([]);
      if (next instanceof Error) throw next;
      return next;
    }),
    release: vi.fn(),
  };
  const pool = { query: client.query, connect: vi.fn(async () => client as unknown as PoolClient) } as unknown as Pool;
  return { pool, client, calls };
}

function result<T extends QueryResultRow>(rows: T[], rowCount = rows.length): QueryResult<T> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

const catalog = {
  listCatalogCandidates: vi.fn(async (ids: readonly number[]) => ids.map((id) => ({ productVariantId: id, productId: 1, category: "Envelopes", productLineIds: [3], defaultRetailPriceCents: 899 }))),
};

function repository(pool: Pool) {
  return new PgDropshipCostChangeListingActionRepository(pool, catalog);
}

describe("PgDropshipCostChangeListingActionRepository", () => {
  it("lists increases in force without an entry action, oldest first per vendor, with the entry now in force", async () => {
    const { pool, calls } = fakePool([result([{
      id: "11", vendor_id: 5, product_variant_id: 61, from_cents: "809", unit_cost_cents: "999", effective_at: EFFECTIVE, policy_id: 3, in_force_entry_id: "15",
    }])]);
    const entries = await repository(pool).listEffectiveIncreasesWithoutAction({ now: NOW, limit: 50 });
    expect(calls[0]?.sql).toContain("LEFT JOIN dropship.dropship_cost_change_entry_actions a ON a.entry_id = e.id");
    expect(calls[0]?.sql).toContain("WHERE e.kind = 'increase' AND e.withdrawn_at IS NULL AND e.effective_at <= $1 AND a.entry_id IS NULL ORDER BY e.vendor_id ASC, e.id ASC LIMIT $2");
    expect(calls[0]?.sql).toContain("ORDER BY f.effective_at DESC, f.id DESC LIMIT 1) AS in_force_entry_id");
    expect(calls[0]?.values).toEqual([NOW, 50]);
    expect(entries).toEqual([{ entryId: 11, vendorId: 5, productVariantId: 61, fromCents: 809, unitCostCents: 999, effectiveAt: EFFECTIVE, policyId: 3, inForceEntryId: 15 }]);
  });

  it("loads a vendor's listings with their labels, saved prices, store pricing rules and catalog candidates", async () => {
    const profile = { defaultRecipe: { basis: "product_cost", markupBps: 4000, flatCents: 0, rounding: "cent" }, groups: [] };
    const { pool, calls } = fakePool([
      result([{ id: 1, store_connection_id: 9, product_variant_id: 61, status: "active", vendor_retail_price_cents: "1099", platform: "shopify", variant_sku: "SKU-61", variant_name: "Single", product_name: "Armor Envelope" }]),
      result([{ store_connection_id: 9, product_variant_id: 61, override_price_cents: null, pricing_mode: "rules" }]),
      result([{ store_connection_id: 9, revision_id: 7, profile, created_at: EFFECTIVE }]),
    ]);
    const facts = await repository(pool).loadVendorFacts({ vendorId: 5, productVariantIds: [61, 61, 62] });
    expect(calls[0]?.sql).toContain("FROM dropship.dropship_vendor_listings l JOIN catalog.product_variants pv ON pv.id = l.product_variant_id JOIN catalog.products p ON p.id = pv.product_id WHERE l.vendor_id = $1 AND l.product_variant_id = ANY($2::int[])");
    expect(calls[0]?.values).toEqual([5, [61, 62]]);
    expect(calls[1]?.sql).toContain("FROM dropship.dropship_listing_price_settings WHERE vendor_id = $1 AND product_variant_id = ANY($2::int[])");
    expect(calls[2]?.sql).toContain("FROM dropship.dropship_pricing_profiles p JOIN dropship.dropship_pricing_profile_revisions r");
    expect(calls[2]?.values).toEqual([5, [9]]);
    expect(catalog.listCatalogCandidates).toHaveBeenCalledWith([61, 62]);
    expect(facts.listings).toEqual([{ listingId: 1, storeConnectionId: 9, productVariantId: 61, status: "active", vendorRetailPriceCents: 1099, platform: "shopify", variantSku: "SKU-61", variantName: "Single", productName: "Armor Envelope" }]);
    expect(facts.savedPrices).toEqual([{ storeConnectionId: 9, productVariantId: 61, overridePriceCents: null, pricingMode: "rules" }]);
    expect(facts.profiles.get(9)).toEqual({ revisionId: 7, profile, updatedAt: EFFECTIVE.toISOString() });
    expect(facts.candidates.get(62)).toEqual({ productVariantId: 62, productId: 1, category: "Envelopes", productLineIds: [3], defaultRetailPriceCents: 899 });
  });

  it("answers without a query when no variant is named, and skips the profile read when no listing names a store", async () => {
    const { pool, calls } = fakePool([result([]), result([])]);
    expect(await repository(pool).loadVendorFacts({ vendorId: 5, productVariantIds: [] })).toEqual({ listings: [], savedPrices: [], profiles: new Map(), candidates: new Map() });
    expect(calls).toEqual([]);
    const facts = await repository(pool).loadVendorFacts({ vendorId: 5, productVariantIds: [61] });
    expect(calls.map((call) => call.sql.slice(0, 40))).toEqual(["SELECT l.id, l.store_connection_id, l.pr", "SELECT store_connection_id, product_vari"]);
    expect(facts.profiles.size).toBe(0);
  });

  it("refuses a stored pricing mode or profile outside its contract", async () => {
    const bad = fakePool([result([]), result([{ store_connection_id: 9, product_variant_id: 61, override_price_cents: null, pricing_mode: "auction" }]), result([])]);
    await expect(repository(bad.pool).loadVendorFacts({ vendorId: 5, productVariantIds: [61] }))
      .rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE", context: { column: "pricing_mode" } });
  });

  it("records holds, then the listing rows naming them, then the entry rows, in one transaction", async () => {
    const { pool, calls, client } = fakePool([
      result([{ id: "41", store_connection_id: 9, product_variant_id: 62 }]),
      result([], 2),
      result([], 2),
    ]);
    const decidedAt = NOW;
    const written = await repository(pool).recordEntryActions({
      vendorId: 5,
      entries: [
        { entryId: 11, productVariantId: 61, listingCount: 1, actionCounts: { reprice_queued: 1 }, supersededByEntryId: null, policyId: 3, decidedAt },
        { entryId: 12, productVariantId: 62, listingCount: 1, actionCounts: { below_cost_paused: 1 }, supersededByEntryId: null, policyId: 3, decidedAt },
      ],
      listingActions: [
        { entryId: 11, storeConnectionId: 9, productVariantId: 61, listingId: 1, listingStatus: "active", priceSource: "rules_cost", listingPriceCents: 1399, unitCostCents: 999, action: "reprice_queued", detail: null, pushJobId: 100, holdKey: null, policyId: 3, decidedAt },
        { entryId: 12, storeConnectionId: 9, productVariantId: 62, listingId: 2, listingStatus: "active", priceSource: "saved_listing", listingPriceCents: 899, unitCostCents: 999, action: "below_cost_paused", detail: null, pushJobId: null, holdKey: { storeConnectionId: 9, productVariantId: 62 }, policyId: 3, decidedAt },
      ],
      holds: [{ storeConnectionId: 9, productVariantId: 62, listingId: 2, entryId: 12, listingPriceCents: 899, unitCostCents: 999, holdIdempotencyKey: "dropship-cost-change-hold:9:x:y", heldAt: NOW }],
    });
    expect(written).toEqual({ entriesRecorded: 2, listingActionsRecorded: 2, holdsRecorded: 1 });
    expect(calls.map((call) => call.sql.split(" (")[0])).toEqual([
      "BEGIN",
      "INSERT INTO dropship.dropship_cost_change_listing_holds",
      "INSERT INTO dropship.dropship_cost_change_listing_actions",
      "INSERT INTO dropship.dropship_cost_change_entry_actions",
      "COMMIT",
    ]);
    expect(calls[1]?.sql).toContain("ON CONFLICT (store_connection_id, product_variant_id) WHERE released_at IS NULL DO NOTHING RETURNING id, store_connection_id, product_variant_id");
    expect(calls[2]?.sql).toContain("ON CONFLICT (entry_id, listing_id) DO NOTHING");
    expect(calls[2]?.values?.[12]).toEqual([null, 41]);
    expect(calls[2]?.values?.[11]).toEqual([100, null]);
    expect(calls[3]?.sql).toContain("ON CONFLICT (entry_id) DO NOTHING");
    expect(calls[3]?.values?.[4]).toEqual(['{"reprice_queued":1}', '{"below_cost_paused":1}']);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("looks up a hold a replayed pass already placed, so its listing row still names it", async () => {
    const { pool, calls } = fakePool([
      result([]),
      result([{ id: "41", store_connection_id: 9, product_variant_id: 62 }]),
      result([], 1),
      result([], 1),
    ]);
    await repository(pool).recordEntryActions({
      vendorId: 5,
      entries: [{ entryId: 12, productVariantId: 62, listingCount: 1, actionCounts: { below_cost_paused: 1 }, supersededByEntryId: null, policyId: 3, decidedAt: NOW }],
      listingActions: [{ entryId: 12, storeConnectionId: 9, productVariantId: 62, listingId: 2, listingStatus: "active", priceSource: "fixed", listingPriceCents: 899, unitCostCents: 999, action: "below_cost_paused", detail: null, pushJobId: null, holdKey: { storeConnectionId: 9, productVariantId: 62 }, policyId: 3, decidedAt: NOW }],
      holds: [{ storeConnectionId: 9, productVariantId: 62, listingId: 2, entryId: 12, listingPriceCents: 899, unitCostCents: 999, holdIdempotencyKey: "k", heldAt: NOW }],
    });
    expect(calls[2]?.sql).toContain("WHERE released_at IS NULL AND vendor_id = $1 AND store_connection_id = ANY($2::int[]) AND product_variant_id = ANY($3::int[])");
    expect(calls[3]?.values?.[12]).toEqual([41]);
  });

  it("rolls back and reports a write the engine refuses, releasing the client", async () => {
    const violation = Object.assign(new Error("check violation"), { code: "23514" });
    const { pool, calls, client } = fakePool([violation]);
    await expect(repository(pool).recordEntryActions({
      vendorId: 5,
      entries: [{ entryId: 12, productVariantId: 62, listingCount: 0, actionCounts: {}, supersededByEntryId: null, policyId: 3, decidedAt: NOW }],
      listingActions: [], holds: [],
    })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_WRITE_INVALID" });
    expect(calls.map((call) => call.sql.slice(0, 8))).toEqual(["BEGIN", "INSERT I", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("lists live holds oldest first per vendor, and reads the cost in force per variant", async () => {
    const { pool, calls } = fakePool([
      result([{ id: "41", vendor_id: 5, store_connection_id: 9, product_variant_id: 62, listing_id: 2, entry_id: "12", listing_price_cents: "899", unit_cost_cents: "999", held_at: NOW }]),
      result([{ product_variant_id: 62, unit_cost_cents: "999" }]),
    ]);
    const holds = await repository(pool).listActiveHolds({ limit: 200 });
    expect(calls[0]?.sql).toContain("WHERE released_at IS NULL ORDER BY vendor_id ASC, id ASC LIMIT $1");
    expect(holds).toEqual([{ holdId: 41, vendorId: 5, storeConnectionId: 9, productVariantId: 62, listingId: 2, entryId: 12, listingPriceCents: 899, unitCostCents: 999, heldAt: NOW }]);
    const costs = await repository(pool).costInForce({ vendorId: 5, productVariantIds: [62, 62], now: NOW });
    expect(calls[1]?.sql).toContain("SELECT DISTINCT ON (product_variant_id) product_variant_id, unit_cost_cents FROM dropship.dropship_cost_schedule_entries WHERE vendor_id = $1 AND product_variant_id = ANY($2::int[]) AND withdrawn_at IS NULL AND effective_at <= $3 ORDER BY product_variant_id, effective_at DESC, id DESC");
    expect(calls[1]?.values).toEqual([5, [62], NOW]);
    expect(costs).toEqual(new Map([[62, 999]]));
  });

  it("releases live holds in one guarded statement, refusing a reason or detail outside the contract", async () => {
    const { pool, calls } = fakePool([result([], 2)]);
    const repo = repository(pool);
    expect(await repo.releaseHolds({ holdIds: [41, 42], reason: "price_covers_cost", detail: "released", releasedAt: NOW, releaseIdempotencyKey: "dropship-cost-change-release:9:x" })).toBe(2);
    expect(calls[0]?.sql).toContain("SET released_at = $2, release_reason = $3, release_detail = $4, release_idempotency_key = $5 WHERE id = ANY($1::bigint[]) AND released_at IS NULL");
    expect(calls[0]?.values).toEqual([[41, 42], NOW, "price_covers_cost", "released", "dropship-cost-change-release:9:x"]);
    expect(await repo.releaseHolds({ holdIds: [], reason: "price_covers_cost", detail: "released", releasedAt: NOW, releaseIdempotencyKey: "k" })).toBe(0);
    await expect(repo.releaseHolds({ holdIds: [41], reason: "bored" as never, detail: "released", releasedAt: NOW, releaseIdempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_INPUT" });
  });

  it("serves the vendor's recent listing actions and staff pages, with labels and the hold's release", async () => {
    const row = {
      id: "71", entry_id: "11", listing_id: 2, store_connection_id: 9, platform: "shopify", product_variant_id: 62, variant_sku: "SKU-62", variant_name: "Single",
      product_name: "Armor Envelope", action: "below_cost_paused", detail: null, listing_price_cents: "899", unit_cost_cents: "999", push_job_id: null, decided_at: NOW,
      hold_released_at: EFFECTIVE, hold_release_reason: "price_covers_cost", vendor_id: 5, business_name: "Shellz Vendor", listing_status: "active",
      price_source: "saved_listing", policy_id: 3,
    };
    const { pool, calls } = fakePool([result([row]), result([row])]);
    const repo = repository(pool);
    const since = new Date("2026-09-13T00:05:00.000Z");
    const vendorRows = await repo.listVendorListingActions({ vendorId: 5, since, limit: 200 });
    expect(calls[0]?.sql).toContain("LEFT JOIN dropship.dropship_cost_change_listing_holds h ON h.id = a.hold_id WHERE a.vendor_id = $1 AND a.decided_at >= $2 ORDER BY a.id DESC LIMIT $3");
    expect(calls[0]?.values).toEqual([5, since, 200]);
    expect(vendorRows).toEqual([{
      actionId: 71, entryId: 11, listingId: 2, storeConnectionId: 9, platform: "shopify", productVariantId: 62, variantSku: "SKU-62", variantName: "Single",
      productName: "Armor Envelope", action: "below_cost_paused", detail: null, listingPriceCents: 899, unitCostCents: 999, pushJobId: null, decidedAt: NOW,
      holdReleasedAt: EFFECTIVE, holdReleaseReason: "price_covers_cost",
    }]);
    const staffRows = await repo.listListingActions({ limit: 51, beforeId: 80 });
    expect(calls[1]?.sql).toContain("WHERE ($1::bigint IS NULL OR a.id < $1) ORDER BY a.id DESC LIMIT $2");
    expect(calls[1]?.values).toEqual([80, 51]);
    expect(staffRows[0]).toMatchObject({ actionId: 71, vendorId: 5, vendorBusinessName: "Shellz Vendor", listingStatus: "active", priceSource: "saved_listing", policyId: 3 });
    const bad = fakePool([result([{ ...row, action: "ignored" }])]);
    await expect(repository(bad.pool).listListingActions({ limit: 1, beforeId: null }))
      .rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE", context: { column: "action" } });
  });

  it("maps a missing table to the transient code the pass retries on", async () => {
    const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
    const { pool } = fakePool([missing]);
    await expect(repository(pool).listActiveHolds({ limit: 10 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_TABLE_MISSING" });
  });
});
