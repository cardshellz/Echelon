import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type {
  CategoryListingSettingValues,
  ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import { DropshipError } from "../../domain/errors";
import { EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import {
  CATEGORY_LISTING_SETTING_VALUE_COLUMNS,
  LISTING_SETTING_VALUE_COLUMN_TYPES,
  PRODUCT_LISTING_SETTING_VALUE_COLUMNS,
  assertListingSettingRequestMatches,
  categoryColumnsToValues,
  categoryListingSettingRowFromColumns,
  categoryValuesToColumns,
  findListingSettingRequestWithClient,
  insertListingSettingRequestWithClient,
  productColumnsToValues,
  productListingSettingRowFromColumns,
  productValuesToColumns,
  type ListingSettingRequestRecord,
  type ProductListingSettingValueColumns,
} from "../../infrastructure/dropship-listing-setting-shared.repository";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const HASH = "b".repeat(64);
const KEY = "listing-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const OWN_TEXT = "Private vendor words that must never reach an error.";

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  constructor(private readonly answer: (sql: string) => unknown[] = () => []) {}

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();
    this.sql.push(sql);
    this.params.push(params);
    return { rows: this.answer(sql) as T[] };
  }
}

function asClient(client: ScriptedClient): Pick<PoolClient, "query"> {
  return client as unknown as Pick<PoolClient, "query">;
}

function fullValues(): ProductListingSettingValues {
  return {
    price: { basis: "catalog_retail", markupBps: 0, flatCents: 2_147_483_647, rounding: "cent" },
    ebayCategory: { categoryId: "183454", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] },
    storeShelf: { mode: "own", shelves: [{ id: "202", name: "Sleeves:Standard" }, { id: "101", name: "Sleeves" }] },
    shippingPolicy: { id: "6200000001", name: "Free shipping" },
    returnPolicy: { id: "6200000002", name: null },
    paymentPolicy: { id: "6200000003", name: "Pay now" },
    textAbove: { mode: "own", text: "Ships in 1 day." },
    textBelow: { mode: "none" },
    mainText: { text: OWN_TEXT, catalogHash: HASH },
  };
}

/** What PostgreSQL hands back: jsonb arrays are parsed again, every other column is as written. */
function throughDatabase<T extends object>(columns: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(columns)) as Record<string, unknown>;
}

function storedColumns(overrides: Partial<Record<keyof ProductListingSettingValueColumns, unknown>> = {}) {
  return { ...throughDatabase(productValuesToColumns(fullValues())), ...overrides } as Record<keyof ProductListingSettingValueColumns, unknown>;
}

function categoryOf(values: ProductListingSettingValues): CategoryListingSettingValues {
  const { mainText: _mainText, ...category } = values;
  return category;
}

describe("listing setting column mappers", () => {
  it("writes every column of its table once and only those", () => {
    expect(Object.keys(productValuesToColumns(fullValues()))).toEqual([...PRODUCT_LISTING_SETTING_VALUE_COLUMNS]);
    expect(Object.keys(categoryValuesToColumns(categoryOf(fullValues())))).toEqual([...CATEGORY_LISTING_SETTING_VALUE_COLUMNS]);
    expect(CATEGORY_LISTING_SETTING_VALUE_COLUMNS).not.toContain("body_text");
    expect(Object.keys(LISTING_SETTING_VALUE_COLUMN_TYPES)).toEqual([...PRODUCT_LISTING_SETTING_VALUE_COLUMNS]);
    expect(Object.entries(LISTING_SETTING_VALUE_COLUMN_TYPES).filter(([, type]) => type === "jsonb").map(([column]) => column))
      .toEqual(["ebay_category_path", "shelf_ids", "shelf_names"]);
  });

  it("maps a fully set product to its columns, shelves in order", () => {
    expect(productValuesToColumns(fullValues())).toEqual({
      price_basis: "catalog_retail", price_markup_bps: 0, price_flat_cents: 2_147_483_647, price_rounding: "cent",
      ebay_category_id: "183454", ebay_category_name: "Card Sleeves", ebay_category_path: ["Collectibles", "Card Sleeves"],
      shelf_mode: "own", shelf_ids: ["202", "101"], shelf_names: ["Sleeves:Standard", "Sleeves"],
      fulfillment_policy_id: "6200000001", fulfillment_policy_name: "Free shipping",
      return_policy_id: "6200000002", return_policy_name: null,
      payment_policy_id: "6200000003", payment_policy_name: "Pay now",
      text_above_mode: "own", text_above: "Ships in 1 day.",
      text_below_mode: "none", text_below: null,
      body_text: OWN_TEXT, body_catalog_hash: HASH,
    });
  });

  it("maps every setting following the default to all-null columns", () => {
    const columns = productValuesToColumns({ ...EMPTY_PRODUCT_LISTING_SETTING_VALUES });
    expect(Object.values(columns).every((value) => value === null)).toBe(true);
    expect(productColumnsToValues(throughDatabase(columns) as Record<keyof ProductListingSettingValueColumns, unknown>))
      .toEqual(EMPTY_PRODUCT_LISTING_SETTING_VALUES);
  });

  it.each<[string, Partial<ProductListingSettingValues>]>([
    ["everything set", {}],
    ["one shelf", { storeShelf: { mode: "own", shelves: [{ id: "9", name: "Toploaders" }] } }],
    ["shelf none", { storeShelf: { mode: "none" } }],
    ["shelf follows", { storeShelf: null }],
    ["text above none, text below own", { textAbove: { mode: "none" }, textBelow: { mode: "own", text: "Thanks!\nSee you." } }],
    ["both texts follow", { textAbove: null, textBelow: null }],
    ["no price, no eBay category", { price: null, ebayCategory: null }],
    ["policies follow", { shippingPolicy: null, returnPolicy: null, paymentPolicy: null }],
    ["main text is the Card Shellz text", { mainText: null }],
  ])("round-trips a product: %s", (_label, patch) => {
    const values = { ...fullValues(), ...patch };
    const stored = throughDatabase(productValuesToColumns(values)) as Record<keyof ProductListingSettingValueColumns, unknown>;
    expect(productColumnsToValues(stored)).toEqual(values);
  });

  it("round-trips a category, which has no main text", () => {
    const values = categoryOf({ ...fullValues(), storeShelf: { mode: "none" }, textAbove: null });
    const stored = throughDatabase(categoryValuesToColumns(values)) as Record<(typeof CATEGORY_LISTING_SETTING_VALUE_COLUMNS)[number], unknown>;
    expect(categoryColumnsToValues(stored)).toEqual(values);
    expect("mainText" in categoryColumnsToValues(stored)).toBe(false);
  });

  it.each<[string, Partial<Record<keyof ProductListingSettingValueColumns, unknown>>, string]>([
    ["a price basis alone", { price_markup_bps: null, price_flat_cents: null, price_rounding: null }, "price"],
    ["a recipe without its rounding", { price_rounding: null }, "price"],
    ["an eBay category id without its name and path", { ebay_category_name: null, ebay_category_path: null }, "ebayCategory"],
    ["own shelves without names", { shelf_names: null }, "storeShelf"],
    ["shelf ids without a mode", { shelf_mode: null }, "storeShelf"],
    ["more names than ids", { shelf_names: ["A", "B", "C"] }, "storeShelf"],
    ["shelf ids that are not a list", { shelf_ids: "101", shelf_names: "Sleeves" }, "storeShelf"],
    ["none with shelves", { shelf_mode: "none" }, "storeShelf"],
    ["an unknown shelf mode", { shelf_mode: "all", shelf_ids: null, shelf_names: null }, "storeShelf"],
    ["own text above without text", { text_above: null }, "textAbove"],
    ["text below without a mode", { text_below_mode: null, text_below: "Stray words" }, "textBelow"],
    ["none with text", { text_above_mode: "none" }, "textAbove"],
    ["a policy name without its id", { fulfillment_policy_id: null }, "shippingPolicy"],
    ["main text without its catalog hash", { body_catalog_hash: null }, "mainText"],
    ["a catalog hash without main text", { body_text: null }, "mainText"],
  ])("refuses a stored row with %s", (_label, overrides, group) => {
    let thrown: unknown;
    try { productColumnsToValues(storedColumns(overrides)); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { group, classification: "fatal", retryable: false },
    });
  });

  it("refuses a complete group outside the stored contract, naming the path but never the text", () => {
    let thrown: unknown;
    try { productColumnsToValues(storedColumns({ price_markup_bps: -1, body_text: `${OWN_TEXT}\u0007` })); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { classification: "fatal", retryable: false },
    });
    const context = JSON.stringify((thrown as { context: unknown }).context);
    expect(context).toContain("price.markupBps");
    expect(context).toContain("mainText.text");
    expect(context).not.toContain("Private vendor words");
  });

  it("refuses a row read without one of its value columns", () => {
    const { body_catalog_hash: _hash, ...withoutHash } = storedColumns();
    expect(() => productColumnsToValues(withoutHash as Record<keyof ProductListingSettingValueColumns, unknown>))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: expect.objectContaining({ missing: ["body_catalog_hash"] }) }));
  });
});

describe("listing setting row mappers", () => {
  it("builds a product row with the revision time as updatedAt", () => {
    expect(productListingSettingRowFromColumns(44, { ...storedColumns(), product_id: 7, revision_id: 3, created_at: NOW })).toEqual({
      storeConnectionId: 44, productId: 7, revisionId: 3, updatedAt: "2026-10-10T12:00:00.000Z", values: fullValues(),
    });
  });

  it("builds a category row", () => {
    const stored = throughDatabase(categoryValuesToColumns(categoryOf(fullValues())));
    expect(categoryListingSettingRowFromColumns(44, { ...stored, category_id: 2, revision_id: 9, created_at: NOW } as Parameters<typeof categoryListingSettingRowFromColumns>[1]))
      .toEqual({ storeConnectionId: 44, categoryId: 2, revisionId: 9, updatedAt: NOW.toISOString(), values: categoryOf(fullValues()) });
  });

  it.each([
    ["a missing time", { created_at: null }],
    ["an invalid time", { created_at: new Date("not a time") }],
    ["a time as text", { created_at: "2026-10-10T12:00:00.000Z" }],
    ["a zero revision id", { revision_id: 0 }],
    ["a revision id as text", { revision_id: "3" }],
    ["a missing product id", { product_id: null }],
  ])("refuses %s", (_label, overrides) => {
    expect(() => productListingSettingRowFromColumns(44, { ...storedColumns(), product_id: 7, revision_id: 3, created_at: NOW, ...overrides }))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" }));
  });

  it("names the row it refuses by its ids, never by its text", () => {
    let product: unknown;
    try {
      productListingSettingRowFromColumns(44, { ...storedColumns({ text_above: null }), product_id: 7, revision_id: "12", created_at: NOW });
    } catch (error) { product = error; }
    expect(product).toBeInstanceOf(DropshipError);
    expect(product).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { group: "textAbove", storeConnectionId: 44, productId: "7", revisionId: "12", classification: "fatal", retryable: false },
    });

    const stored = throughDatabase(categoryValuesToColumns({ ...categoryOf(fullValues()), textAbove: { mode: "own", text: `${OWN_TEXT}\u0007` } }));
    let category: unknown;
    try {
      categoryListingSettingRowFromColumns(44, { ...stored, category_id: 2, revision_id: 9, created_at: NOW } as Parameters<typeof categoryListingSettingRowFromColumns>[1]);
    } catch (error) { category = error; }
    expect(category).toMatchObject({
      code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
      context: { storeConnectionId: 44, categoryId: "2", revisionId: "9", classification: "fatal", retryable: false },
    });
    expect(JSON.stringify((category as { context: unknown }).context)).toContain("values.textAbove.text");
    expect(JSON.stringify((category as { context: unknown }).context)).not.toContain("Private vendor words");
  });
});

describe("listing setting request ledger", () => {
  const actor = { actorType: "vendor" as const, actorId: "member-1" };
  const ledgerRow = {
    id: "9007199254740991", vendor_id: 10, store_connection_id: 44, operation: "product_settings_bulk",
    idempotency_key: KEY, request_hash: HASH, product_count: 3, actor_type: "vendor", actor_id: "member-1", created_at: NOW,
  };

  it("finds a request by vendor and key, reading the bigint id", async () => {
    const client = new ScriptedClient(() => [ledgerRow]);

    const found = await findListingSettingRequestWithClient(asClient(client), { vendorId: 10, idempotencyKey: KEY });

    expect(found).toEqual({
      id: 9_007_199_254_740_991, vendorId: 10, storeConnectionId: 44, operation: "product_settings_bulk",
      idempotencyKey: KEY, requestHash: HASH, productCount: 3, actorType: "vendor", actorId: "member-1",
      createdAt: "2026-10-10T12:00:00.000Z",
    });
    expect(client.sql).toHaveLength(1);
    expect(client.sql[0]).toContain("FROM dropship.dropship_product_listing_setting_requests");
    expect(client.sql[0]).toContain("WHERE vendor_id = $1 AND idempotency_key = $2");
    expect(client.sql[0]).not.toMatch(/FOR (UPDATE|SHARE)/);
    expect(client.params[0]).toEqual([10, KEY]);
  });

  it("answers null for a new key", async () => {
    await expect(findListingSettingRequestWithClient(asClient(new ScriptedClient()), { vendorId: 10, idempotencyKey: KEY })).resolves.toBeNull();
  });

  it.each([
    ["an unknown operation", { operation: "price_change_apply" }],
    ["an id past the safe integer range", { id: "9007199254740993" }],
    ["a negative count", { product_count: -1 }],
    ["an unknown actor", { actor_type: "robot" }],
    ["a missing time", { created_at: null }],
  ])("refuses a stored request with %s", async (_label, overrides) => {
    const client = new ScriptedClient(() => [{ ...ledgerRow, ...overrides }]);
    await expect(findListingSettingRequestWithClient(asClient(client), { vendorId: 10, idempotencyKey: KEY }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { classification: "fatal" } });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["an unknown operation", { operation: "price_change_apply" }, {}],
    ["a negative count", { product_count: -1 }, { column: "product_count" }],
    ["a vendor id as a fraction", { vendor_id: 1.5 }, { column: "vendor_id" }],
    ["a missing time", { created_at: null }, { column: "created_at" }],
  ])("names the stored request it refuses for %s by its ledger id", async (_label, overrides, context) => {
    const client = new ScriptedClient(() => [{ ...ledgerRow, ...overrides }]);
    await expect(findListingSettingRequestWithClient(asClient(client), { vendorId: 10, idempotencyKey: KEY }))
      .rejects.toMatchObject({
        code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED",
        context: { ...context, id: "9007199254740991", classification: "fatal", retryable: false },
      });
  });

  it("inserts a request with the injected time and returns its id", async () => {
    const client = new ScriptedClient(() => [{ id: "77" }]);

    const id = await insertListingSettingRequestWithClient(asClient(client), {
      vendorId: 10, storeConnectionId: 44, operation: "category_moves_acknowledge", idempotencyKey: KEY,
      requestHash: HASH, productCount: 0, actor, now: NOW,
    });

    expect(id).toBe(77);
    expect(client.sql).toHaveLength(1);
    expect(client.sql[0]).toMatch(/^INSERT INTO dropship\.dropship_product_listing_setting_requests/);
    expect(client.sql[0]).toContain("RETURNING id");
    expect(client.params[0]).toEqual([10, 44, "category_moves_acknowledge", KEY, HASH, 0, "vendor", "member-1", NOW]);
  });

  it.each([
    ["an unknown operation", { operation: "price_change_apply" }],
    ["a short key", { idempotencyKey: "short" }],
    ["a malformed hash", { requestHash: "B".repeat(64) }],
    ["10,001 products", { productCount: 10_001 }],
    ["a fractional count", { productCount: 1.5 }],
    ["an unknown actor", { actor: { actorType: "robot", actorId: "x" } }],
    ["a blank actor id", { actor: { actorType: "system", actorId: "  " } }],
    ["a 256-character actor id", { actor: { actorType: "system", actorId: "j".repeat(256) } }],
    ["an invalid time", { now: new Date("not a time") }],
  ])("refuses %s before any SQL", async (_label, overrides) => {
    const client = new ScriptedClient(() => [{ id: "1" }]);
    await expect(insertListingSettingRequestWithClient(asClient(client), {
      vendorId: 10, storeConnectionId: 44, operation: "product_settings_bulk", idempotencyKey: KEY,
      requestHash: HASH, productCount: 1, actor, now: NOW, ...overrides,
    } as Parameters<typeof insertListingSettingRequestWithClient>[1])).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(client.sql).toEqual([]);
  });

  it("refuses an insert that returns no identity", async () => {
    await expect(insertListingSettingRequestWithClient(asClient(new ScriptedClient()), {
      vendorId: 10, storeConnectionId: 44, operation: "product_settings_bulk", idempotencyKey: KEY,
      requestHash: HASH, productCount: 1, actor, now: NOW,
    })).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
  });

  it("accepts a replay of the same store, operation and request, and refuses any other use of the key", () => {
    const record: ListingSettingRequestRecord = {
      id: 1, vendorId: 10, storeConnectionId: 44, operation: "category_settings_clear", idempotencyKey: KEY,
      requestHash: HASH, productCount: 2, actorType: "vendor", actorId: "member-1", createdAt: NOW.toISOString(),
    };
    const same = { storeConnectionId: 44, operation: "category_settings_clear" as const, requestHash: HASH };
    expect(() => assertListingSettingRequestMatches(record, same)).not.toThrow();
    for (const [other, field] of [
      [{ ...same, storeConnectionId: 45 }, "storeConnectionId"],
      [{ ...same, operation: "product_settings_bulk" as const }, "operation"],
      [{ ...same, requestHash: "c".repeat(64) }, "requestHash"],
    ] as const) {
      expect(() => assertListingSettingRequestMatches(record, other)).toThrow(expect.objectContaining({
        code: "DROPSHIP_IDEMPOTENCY_CONFLICT",
        context: { mismatched: [field], retryable: false, classification: "permanent" },
      }));
    }
  });
});
