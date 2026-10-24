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

/** A listing row as the shared SQL returns it: today's keys first, then the store and #1900's end facts. */
function listingRow(patch: Row = {}): Row {
  return { id: 501, storeConnectionId: STORE, productVariantId: 101, status: "active", externalListingId: "L-501", externalOfferId: "O-501",
    livePushItemId: null, vendorQuantityLimit: null, marketplaceEndedAt: null, marketplaceIssueCodes: [], ...patch };
}

/** The same row with only the keys SPR read before the SQL was shared. */
function todaysRow(row: Row): Row {
  const { storeConnectionId: _store, marketplaceEndedAt: _ended, marketplaceIssueCodes: _issues, ...today } = row;
  return today;
}

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
      "externalOfferId", "livePushItemId", "vendorQuantityLimit", "storeConnectionId", "marketplaceEndedAt", "marketplaceIssueCodes"]);
    const facts = await readDropshipSelectionEffectsFacts(
      fakeClient([listingRow({ marketplaceEndedAt: ENDED_AT, marketplaceIssueCodes: ["ended_out_of_stock"], vendorQuantityLimit: 0 })]),
      { vendorId: VENDOR, productVariantIds: [101] });
    expect(facts.stores[0].listings).toEqual([{ id: 501, productVariantId: 101, status: "active", externalListingId: "L-501",
      externalOfferId: "O-501", livePushItemId: null, vendorQuantityLimit: 0, marketplaceEndedAt: ENDED_AT,
      marketplaceIssueCodes: ["ended_out_of_stock"] }]);
    expect(facts.stores[1]).toMatchObject({ storeConnectionId: OTHER_STORE, listings: [] });
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
