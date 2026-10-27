import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import { readDropshipSelectionEffectsFacts } from "../../infrastructure/dropship-selection-effects.reader";
import {
  DROPSHIP_STOCK_LISTING_ROWS_SQL,
  dropshipStockListingRowSchema,
  readDropshipListingStockSelection,
} from "../../infrastructure/dropship-stock-publication-selection.reader";

/**
 * One listing-row SQL for the stock publication reader (SPR) and the step 1
 * selection effects reader (PLAN-B v4.1 §7.7, V21; R5): the two read a
 * listing from the same text, so the confirm can never count a listing SPR
 * decides differently; SPR still parses exactly the keys it parsed before the
 * text was shared, so its fingerprint does not move (R6; the PostgreSQL golden
 * `MAIN_FINGERPRINT` pins the bytes).
 */

const VENDOR = 41;
const STORE = 7;
const OTHER_STORE = 8;
const NOW = new Date("2026-10-24T12:00:00.000Z");
const ENDED_AT = new Date("2026-10-20T08:00:00.000Z");

type Row = Record<string, unknown>;
interface Recorded { text: string; values: readonly unknown[] }

/** Answers each statement the two readers make by its table, and records every statement in order. */
function fakeClient(listingRows: Row[]): StockSelectionQueryClient & { queries: Recorded[] } {
  const queries: Recorded[] = [];
  const store = (id: number) => ({ id, vendorId: VENDOR, platform: "ebay", externalAccountId: "acct", providerEnvironment: "production",
    status: "connected", storeName: `Store ${id}`, config: { listingMode: "live", inventoryMode: "managed_quantity_sync", isActive: true } });
  return {
    queries,
    async query<R = Row>(text: string, values: readonly unknown[] = []): Promise<{ rows: R[] }> {
      queries.push({ text, values });
      const rows = ((): Row[] => {
        if (text === DROPSHIP_STOCK_LISTING_ROWS_SQL) return listingRows;
        if (text.includes("WHERE sc.id=$1")) return [store(STORE)];
        if (text.includes("WHERE sc.vendor_id=$1")) return [store(STORE), store(OTHER_STORE)];
        if (text.includes("FROM catalog.products p WHERE p.id=$1")) {
          return [{ id: 3, isActive: true, status: null, productType: null, category: "Supplies", ebayListingExcluded: null, productLineIds: [] }];
        }
        if (text.includes("FROM catalog.product_variants WHERE product_id=$1")) {
          return [101, 102].map((id) => ({ id, productId: 3, sku: null, uomType: "pack", isActive: true, requiresShipping: true,
            trackInventory: true, salesEligibility: "sellable", ebayListingExcluded: null }));
        }
        if (text.includes("FROM catalog.product_variants pv INNER JOIN catalog.products p")) {
          return [101, 102].map((id) => ({ id, productId: 3, sku: null, uomType: "pack", isActive: true, requiresShipping: true,
            trackInventory: true, salesEligibility: "sellable", ebayListingExcluded: null,
            product: { id: 3, isActive: true, status: null, productType: null, category: "Supplies", ebayListingExcluded: null, productLineIds: [] } }));
        }
        if (text.includes("FROM dropship.dropship_catalog_rules")) return [{ id: 1, scopeType: "catalog", action: "include", productLineId: null,
          productId: null, productVariantId: null, category: null, startsAt: null, endsAt: null }];
        if (text.includes("FROM dropship.dropship_vendor_selected_variants")) return [{ productVariantId: 101 }];
        if (text.includes("FROM dropship.dropship_vendor_variant_overrides")) return [];
        throw new Error(`Unexpected statement: ${text}`);
      })();
      return { rows: rows as R[] };
    },
  };
}

/**
 * A listing row as the shared SQL returns it: today's keys first, then the store, #1900's end facts and PR C's end
 * request facts (node-postgres returns the bigint end id as text).
 */
function listingRow(patch: Row = {}): Row {
  return { id: 501, storeConnectionId: STORE, productVariantId: 101, status: "active", externalListingId: "L-501", externalOfferId: "O-501",
    livePushItemId: null, vendorQuantityLimit: null, marketplaceEndedAt: null, marketplaceIssueCodes: [],
    openEndId: null, openEndState: null, pushInFlight: false, ...patch };
}

/** The same row with only the keys SPR reads: the ones before the SQL was shared, plus PR C's open end state. */
function todaysRow(row: Row): Row {
  const { storeConnectionId: _store, marketplaceEndedAt: _ended, marketplaceIssueCodes: _issues, openEndId: _endId,
    pushInFlight: _inFlight, ...today } = row;
  return today;
}

/**
 * SPR's fingerprints of this file's fake on origin/main 1ddaf0470 (before PR C), computed by main's own reader over
 * the same fake: a listing without an open end must keep them byte for byte (PLAN-C v4.1 §7 item 2).
 */
const MAIN_FINGERPRINT_NO_LIMIT = "28fe8a1d0fb484b9cbeac837362fa3e81f72b92ba3614761ee7ab7d5e6eeef72";
const MAIN_FINGERPRINT_LIMIT_3 = "43079aa97ba254f93b5638a405b157193021f9fa8be067688444a8ccbc5cb0c4";

const sprInput = { storeConnectionId: STORE, productId: 3, productVariantIds: [102, 101], now: NOW };

describe("the shared stock listing rows (PLAN-B v4.1 V21, R5, R6)", () => {
  it("SPR and the effects reader import the one SQL constant and neither has a listings select of its own", () => {
    const read = (path: string) => readFileSync(resolve(process.cwd(), "server/modules/dropship/infrastructure", path), "utf8");
    const spr = read("dropship-stock-publication-selection.reader.ts");
    const effects = read("dropship-selection-effects.reader.ts");
    expect(spr.match(/FROM dropship\.dropship_vendor_listings/g)).toHaveLength(1);
    expect(effects).not.toContain("dropship_vendor_listings");
    expect(effects).toMatch(/import \{[^}]*\bDROPSHIP_STOCK_LISTING_ROWS_SQL\b[^}]*\} from "\.\/dropship-stock-publication-selection\.reader"/);
    expect(effects).toContain("client.query(DROPSHIP_STOCK_LISTING_ROWS_SQL, [input.vendorId, storeIds, productVariantIds])");
    expect(spr).toContain("client.query(DROPSHIP_STOCK_LISTING_ROWS_SQL,\n    [store.vendorId, [store.id], productVariantIds])");
  });

  it("is sent by both readers: SPR with its one store, the effects reader with every store of the vendor", async () => {
    const spr = fakeClient([listingRow()]);
    await readDropshipListingStockSelection(spr, sprInput);
    expect(spr.queries.filter((query) => query.text === DROPSHIP_STOCK_LISTING_ROWS_SQL).map((query) => query.values))
      .toEqual([[VENDOR, [STORE], [101, 102]]]);

    const effects = fakeClient([listingRow(), listingRow({ id: 601, storeConnectionId: OTHER_STORE })]);
    const facts = await readDropshipSelectionEffectsFacts(effects, { vendorId: VENDOR, productVariantIds: [102, 101, 101] });
    expect(effects.queries.filter((query) => query.text === DROPSHIP_STOCK_LISTING_ROWS_SQL).map((query) => query.values))
      .toEqual([[VENDOR, [STORE, OTHER_STORE], [101, 102]]]);
    // Every other read is one statement too: stores, overrides, catalog facts, exposure rules, picks (§7.7).
    expect(effects.queries).toHaveLength(6);
    expect(facts.stores.map((store) => [store.storeConnectionId, store.listings.map((row) => row.id)])).toEqual([[STORE, [501]], [OTHER_STORE, [601]]]);
    expect(facts.pickedBefore).toEqual(new Set([101]));
  });

  it("parses exactly today's keys in SPR: the extra columns never reach its decision or fingerprint", async () => {
    const shared = listingRow({ marketplaceEndedAt: ENDED_AT, marketplaceIssueCodes: ["ended_out_of_stock"] });
    const withExtras = await readDropshipListingStockSelection(fakeClient([shared]), sprInput);
    const withoutExtras = await readDropshipListingStockSelection(fakeClient([todaysRow(shared)]), sprInput);
    expect(withExtras).toEqual(withoutExtras);
    expect(withExtras.fingerprint).toBe(withoutExtras.fingerprint);
    // A limit joins the fingerprint as before (only when set).
    const limited = await readDropshipListingStockSelection(fakeClient([listingRow({ vendorQuantityLimit: 3 })]), sprInput);
    expect(limited.fingerprint).not.toBe(withoutExtras.fingerprint);
  });

  it("gives the effects reader the extended row: the store id grouped out, the end facts kept", async () => {
    expect(Object.keys(dropshipStockListingRowSchema.shape)).toEqual(["id", "productVariantId", "status", "externalListingId",
      "externalOfferId", "livePushItemId", "vendorQuantityLimit", "openEndState", "storeConnectionId", "marketplaceEndedAt",
      "marketplaceIssueCodes", "openEndId", "pushInFlight"]);
    const facts = await readDropshipSelectionEffectsFacts(
      fakeClient([listingRow({ marketplaceEndedAt: ENDED_AT, marketplaceIssueCodes: ["ended_out_of_stock"], vendorQuantityLimit: 0 })]),
      { vendorId: VENDOR, productVariantIds: [101] });
    expect(facts.stores[0].listings).toEqual([{ id: 501, productVariantId: 101, status: "active", externalListingId: "L-501",
      externalOfferId: "O-501", livePushItemId: null, vendorQuantityLimit: 0, openEndState: null, marketplaceEndedAt: ENDED_AT,
      marketplaceIssueCodes: ["ended_out_of_stock"], openEndId: null, pushInFlight: false }]);
    expect(facts.stores[1]).toMatchObject({ storeConnectionId: OTHER_STORE, listings: [] });
  });

  // PLAN-C v4.1 §7 item 2: the one fact SPR adds reaches its fingerprint only when an end is open.
  it("keeps main's fingerprint byte for byte without an open end, and marks an open end only as endOpen", async () => {
    const read = (patch: Row) => readDropshipListingStockSelection(fakeClient([listingRow(patch)]), sprInput);
    expect((await read({})).fingerprint).toBe(MAIN_FINGERPRINT_NO_LIMIT);
    expect((await read({ vendorQuantityLimit: 3 })).fingerprint).toBe(MAIN_FINGERPRINT_LIMIT_3);
    // The end's own id, a push in flight and #1900's facts are the effects reader's: SPR's answer does not move.
    expect((await read({ openEndId: "9", pushInFlight: true })).fingerprint).toBe(MAIN_FINGERPRINT_NO_LIMIT);

    const pending = await read({ openEndId: "9", openEndState: "pending" });
    expect(pending.fingerprint).not.toBe(MAIN_FINGERPRINT_NO_LIMIT);
    expect(pending.variants.find((variant) => variant.productVariantId === 101))
      .toMatchObject({ action: "zero", reason: "listing_end_in_progress", listingSelected: true });
    // Only "an end is open" is fingerprinted: pending, ending and failed all hold the listing at zero.
    for (const state of ["ending", "failed"]) {
      expect((await read({ openEndId: "9", openEndState: state })).fingerprint).toBe(pending.fingerprint);
    }
    await expect(read({ openEndState: "ended" })).rejects.toThrow();
    await expect(read({ openEndState: undefined })).rejects.toThrow();
  });

  it("gives the effects reader the end facts and the same endOpen the stock decision reads", async () => {
    const facts = await readDropshipSelectionEffectsFacts(fakeClient([
      listingRow({ openEndId: "12", openEndState: "failed", pushInFlight: true }),
      listingRow({ id: 502, productVariantId: 102 }),
    ]), { vendorId: VENDOR, productVariantIds: [101, 102] });
    expect(facts.stores[0].listings).toEqual([
      expect.objectContaining({ id: 501, openEndId: 12, openEndState: "failed", pushInFlight: true, endOpen: true }),
      expect.objectContaining({ id: 502, openEndId: null, openEndState: null, pushInFlight: false }),
    ]);
    expect(facts.stores[0].listings[1]).not.toHaveProperty("endOpen");
    await expect(readDropshipSelectionEffectsFacts(fakeClient([listingRow({ openEndId: "0" })]),
      { vendorId: VENDOR, productVariantIds: [101] })).rejects.toThrow();
    await expect(readDropshipSelectionEffectsFacts(fakeClient([listingRow({ pushInFlight: null })]),
      { vendorId: VENDOR, productVariantIds: [101] })).rejects.toThrow();
  });

  it("pins the end facts in the one SQL: the open states, and a push in flight as processing or stale-recovered queued", () => {
    const sql = DROPSHIP_STOCK_LISTING_ROWS_SQL.replace(/\s+/g, " ");
    expect(sql).toContain(`LEFT JOIN dropship.dropship_listing_end_requests open_end ON open_end.listing_id=vl.id AND open_end.state IN ('pending','ending','failed')`);
    expect(sql).toContain(`open_end.id::text AS "openEndId", open_end.state AS "openEndState"`);
    expect(sql).toContain(`AND (fi.status='processing' OR (fi.status='queued' AND fi.result ? 'staleRecovery'))) AS "pushInFlight"`);
    // Joined on vendor, store and size like the intent lateral: job items have no listing index.
    expect(sql).toContain("WHERE fj.vendor_id=vl.vendor_id AND fj.store_connection_id=vl.store_connection_id AND fi.product_variant_id=vl.product_variant_id AND fi.listing_id=vl.id");
    expect(sql.match(/dropship_listing_end_requests/g)).toHaveLength(1);
  });

  it("reads no listing, override or pick for no size, and refuses a malformed request", async () => {
    const client = fakeClient([]);
    const facts = await readDropshipSelectionEffectsFacts(client, { vendorId: VENDOR, productVariantIds: [] });
    expect(facts).toMatchObject({ candidates: [], overrides: [], stores: [{ listings: [] }, { listings: [] }] });
    expect(facts.pickedBefore).toEqual(new Set());
    expect(client.queries.map((query) => query.text).some((text) => text === DROPSHIP_STOCK_LISTING_ROWS_SQL)).toBe(false);
    await expect(readDropshipSelectionEffectsFacts(client, { vendorId: 0, productVariantIds: [1] })).rejects.toThrow();
    await expect(readDropshipSelectionEffectsFacts(client, { vendorId: VENDOR, productVariantIds: [1.5] })).rejects.toThrow();
  });
});

/**
 * PR C (PLAN-C v4.1 §4.2, FID-1, FID-4): a removal widens the effects facts to every size of the removed sizes'
 * products, read through the catalog's published reader with a bound, and reads the picks in two sets.
 */
describe("the widened facts of a removal (PR C)", () => {
  /** Product 3 has sizes 101-104; 201 is product 4's. Picks: 101 (touched) and 103 (a sibling). */
  function wideClient(productSizes: number[] = [101, 102, 103, 104]) {
    const queries: Recorded[] = [];
    const product = { id: 3, isActive: true, status: null, productType: null, category: "Supplies", ebayListingExcluded: null, productLineIds: [] };
    const size = (id: number) => ({ id, productId: id === 201 ? 4 : 3, sku: null, uomType: "pack", isActive: true, requiresShipping: true,
      trackInventory: true, salesEligibility: "sellable", ebayListingExcluded: null, product: { ...product, id: id === 201 ? 4 : 3 } });
    return {
      queries,
      async query<R = Row>(text: string, values: readonly unknown[] = []): Promise<{ rows: R[] }> {
        queries.push({ text, values });
        const rows = ((): Row[] => {
          if (text === DROPSHIP_STOCK_LISTING_ROWS_SQL) return (values[2] as number[]).map((productVariantId) => listingRow({ id: 500 + productVariantId, productVariantId }));
          if (text.includes("WHERE sc.vendor_id=$1")) return [{ id: STORE, platform: "ebay", status: "connected", externalAccountId: "acct",
            providerEnvironment: "production", storeName: "Store", config: { listingMode: "live", inventoryMode: "managed_quantity_sync", isActive: true } }];
          if (text.includes("WHERE pv.product_id=ANY")) return productSizes.slice(0, (values[1] as number)).map(size);
          if (text.includes("WHERE pv.id=ANY")) return (values[0] as number[]).map(size);
          if (text.includes("FROM dropship.dropship_catalog_rules")) return [];
          if (text.includes("FROM dropship.dropship_vendor_selected_variants")) return (values[1] as number[]).filter((id) => id === 101 || id === 103)
            .map((productVariantId) => ({ productVariantId }));
          if (text.includes("FROM dropship.dropship_vendor_variant_overrides")) return [];
          throw new Error(`Unexpected statement: ${text}`);
        })();
        return { rows: rows as R[] };
      },
    } satisfies StockSelectionQueryClient & { queries: Recorded[] };
  }

  it("reads every size of a removed size's product once, the listings of all of them, and the sibling picks apart (FID-1)", async () => {
    const client = wideClient();
    const facts = await readDropshipSelectionEffectsFacts(client, { vendorId: VENDOR, productVariantIds: [101, 201], removedIds: [101] });
    expect(facts.candidates.map((row) => row.productVariantId)).toEqual([101, 102, 103, 104, 201]);
    expect(facts.stores[0]!.listings.map((row) => row.productVariantId)).toEqual([101, 102, 103, 104, 201]);
    expect(facts.pickedBefore).toEqual(new Set([101]));
    expect(facts.siblingPicks).toEqual(new Set([103]));
    expect(facts.stores[0]).toMatchObject({ status: "connected", externalAccountId: "acct", providerEnvironment: "production" });
    // The product read names only the removed size's product, with the bound + 1 as its limit.
    const productRead = client.queries.find((query) => query.text.includes("WHERE pv.product_id=ANY"))!;
    expect(productRead.values).toEqual([[3], 30_001]);
  });

  it("reads no product and no sibling pick for an adds-only change", async () => {
    const client = wideClient();
    const facts = await readDropshipSelectionEffectsFacts(client, { vendorId: VENDOR, productVariantIds: [101], removedIds: [] });
    expect(client.queries.some((query) => query.text.includes("WHERE pv.product_id=ANY"))).toBe(false);
    expect(facts.siblingPicks).toEqual(new Set());
    expect(client.queries).toHaveLength(6);
  });

  it("refuses more than 30,000 fact sizes with 422 REMOVAL_TOO_LARGE before any listing is read (FID-4)", async () => {
    const huge = Array.from({ length: 30_005 }, (_, index) => 100_000 + index);
    const client = wideClient([101, ...huge]);
    await expect(readDropshipSelectionEffectsFacts(client, { vendorId: VENDOR, productVariantIds: [101], removedIds: [101] }))
      .rejects.toMatchObject({ code: "DROPSHIP_SELECTION_REMOVAL_TOO_LARGE", context: { factSizes: 30_001, limit: 30_000, classification: "permanent" } });
    expect(client.queries.some((query) => query.text === DROPSHIP_STOCK_LISTING_ROWS_SQL)).toBe(false);
    // Exactly 30,000 sizes (the touched one among them) is within the bound.
    const atBound = wideClient([101, ...huge.slice(0, 29_999)]);
    const facts = await readDropshipSelectionEffectsFacts(atBound, { vendorId: VENDOR, productVariantIds: [101], removedIds: [101] });
    expect(facts.candidates).toHaveLength(30_000);
  });
});
