import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { MAX_EBAY_CATEGORY_NAME_LENGTH, MAX_EBAY_CATEGORY_PATH_DEPTH } from "../../../../../shared/dropship/ebay-category-rules";
import { MAX_DESCRIPTION_TEXT_LENGTH, MAX_TEMPLATE_TEXT_LENGTH } from "../../../../../shared/dropship/listing-content";
import {
  MAX_LISTING_POLICY_ID_LENGTH,
  MAX_LISTING_POLICY_NAME_LENGTH,
  MAX_LISTING_SHELF_ID_LENGTH,
  MAX_LISTING_SHELF_NAME_LENGTH,
  type ProductListingSettingBulkPatch,
  type ProductListingSettingPatch,
  type ProductListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import type {
  PriceChangeApplyBulkInput,
  ProductListingSettingsBulkInput,
  ProductListingSettingsBulkSaveInput,
} from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import {
  EMPTY_PRODUCT_LISTING_SETTING_VALUES,
  listingConversionChildKey,
  listingSettingChildKey,
} from "../../domain/listing-setting-values";
import {
  LISTING_SETTING_VALUE_COLUMN_TYPES,
  PRODUCT_LISTING_SETTING_VALUE_COLUMNS,
  productValuesToColumns,
  type ListingSettingWriteScope,
} from "../../infrastructure/dropship-listing-setting-shared.repository";
import {
  MAX_BULK_REVISION_PAYLOAD_BYTES,
  readProductListingSettings,
  saveProductListingSettingWithClient,
  saveProductListingSettingsBulkWithClient,
  saveProductListingSettingsPerProductWithClient,
  type ProductListingSettingsPerProductInput,
} from "../../infrastructure/dropship-product-listing-settings.repository";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const EARLIER = new Date("2026-10-01T09:30:00.000Z");
const VENDOR = 10;
const STORE = 44;
const PRODUCT = 7;
const KEY = "listing-settings:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const CATALOG_HASH = "c".repeat(64);
const SCOPE: ListingSettingWriteScope = {
  vendorId: VENDOR, storeConnectionId: STORE, actor: { actorType: "vendor", actorId: "member-1" }, requestKey: KEY,
};

// Whitespace-insensitive: a statement may be re-indented, never re-worded.
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
const VALUE_COLUMNS = PRODUCT_LISTING_SETTING_VALUE_COLUMNS.join(", ");
const JSONB_COLUMNS = new Set(["ebay_category_path", "shelf_ids", "shelf_names"]);
/** The bulk revision insert's payload bound, imported so the test cannot drift from the writer (plan PR 9, P9 (c)). */
const MAX_PAYLOAD_BYTES = MAX_BULK_REVISION_PAYLOAD_BYTES;
const REVISIONS_TABLE = "dropship.dropship_product_listing_setting_revisions";

const SQL = {
  replayByKey: normalize(`SELECT r.id AS revision_id, r.store_connection_id, r.product_id, r.request_id, r.request_hash,
    ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `r.${column}`).join(", ")}, r.created_at
    FROM dropship.dropship_product_listing_setting_revisions r WHERE r.vendor_id = $1 AND r.idempotency_key = $2`),
  readCurrent: (forUpdate: boolean) => normalize(`SELECT s.product_id, s.revision_id,
    ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `r.${column}`).join(", ")}, r.created_at
    FROM dropship.dropship_product_listing_settings s
    JOIN dropship.dropship_product_listing_setting_revisions r ON r.id = s.revision_id
    AND r.vendor_id = s.vendor_id AND r.store_connection_id = s.store_connection_id AND r.product_id = s.product_id
    WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.product_id = ANY($3::int[])
    ORDER BY s.product_id${forUpdate ? " FOR UPDATE OF s" : ""}`),
  insertRevision: normalize(`INSERT INTO dropship.dropship_product_listing_setting_revisions
    (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, ${VALUE_COLUMNS},
    idempotency_key, request_hash, actor_type, actor_id, created_at)
    VALUES ($1, $2, $3, $4, NULL, ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS
      .map((column, index) => `$${5 + index}${JSONB_COLUMNS.has(column) ? "::jsonb" : ""}`).join(", ")},
    $27, $28, $29, $30, $31) RETURNING id`),
  upsertCurrent: normalize(`INSERT INTO dropship.dropship_product_listing_settings
    (vendor_id, store_connection_id, product_id, revision_id) VALUES ($1, $2, $3, $4)
    ON CONFLICT (store_connection_id, product_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`),
  audit: normalize(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    VALUES ($1, $2, 'dropship_product_listing_setting', $3, 'product_listing_settings_saved', $4, $5, 'info', $6::jsonb, $7)`),
  bulkReplay: "SELECT product_id, id FROM dropship.dropship_product_listing_setting_revisions WHERE request_id = $1 ORDER BY product_id",
  bulkRevisionInsert: normalize(`INSERT INTO dropship.dropship_product_listing_setting_revisions
    (vendor_id, store_connection_id, product_id, previous_revision_id, request_id, ${VALUE_COLUMNS},
    idempotency_key, request_hash, actor_type, actor_id, created_at)
    SELECT $1, $2, x.product_id, x.previous_revision_id, $3,
    ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `x.${column}`).join(", ")},
    x.child_key, $4, $5, $6, $7
    FROM jsonb_to_recordset($8::jsonb) AS x(product_id integer, previous_revision_id integer,
    ${PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => `${column} ${LISTING_SETTING_VALUE_COLUMN_TYPES[column]}`).join(", ")},
    child_key text)
    RETURNING id, product_id`),
  bulkCurrentUpsert: normalize(`INSERT INTO dropship.dropship_product_listing_settings
    (vendor_id, store_connection_id, product_id, revision_id)
    SELECT $1, $2, x.product_id, x.revision_id
    FROM jsonb_to_recordset($3::jsonb) AS x(product_id integer, revision_id integer)
    ON CONFLICT (store_connection_id, product_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`),
  bulkAudit: normalize(`INSERT INTO dropship.dropship_audit_events
    (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
    SELECT $1, $2, 'dropship_product_listing_setting', x.product_id::text, 'product_listing_settings_saved', $3, $4, 'info',
    x.payload, $5
    FROM jsonb_to_recordset($6::jsonb) AS x(product_id integer, payload jsonb)`),
};

interface Call { sql: string; params: unknown[] }
interface LedgerRow {
  id: string; vendor_id: number; store_connection_id: number; operation: string; idempotency_key: string;
  request_hash: string; product_count: number; actor_type: string; actor_id: string; created_at: Date;
}

/** What PostgreSQL hands back for a revision's value columns: jsonb arrays parsed again, every other column as written. */
function storedColumns(values: ProductListingSettingValues): Record<string, unknown> {
  return JSON.parse(JSON.stringify(productValuesToColumns(values))) as Record<string, unknown>;
}

function currentRow(productId: number, revisionId: number, values: ProductListingSettingValues): Record<string, unknown> {
  return { product_id: productId, revision_id: revisionId, ...storedColumns(values), created_at: EARLIER };
}

/**
 * Answers the product writers' statements from an in-memory store. Bulk
 * revision ids are returned in reverse order, so the writer must match them
 * by product, not by position.
 */
class ScriptedClient {
  calls: Call[] = [];
  current = new Map<number, Record<string, unknown>>();
  revisionsByKey = new Map<string, Record<string, unknown>>();
  ledger: LedgerRow | null = null;
  replayRows: Array<{ product_id: number; id: number }> = [];
  private nextRevisionId = 500;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = normalize(text);
    this.calls.push({ sql, params });
    if (sql.startsWith("SELECT r.id AS revision_id")) {
      const stored = this.revisionsByKey.get(String(params[1]));
      return rows<T>(stored ? [stored] : []);
    }
    if (sql.startsWith("SELECT s.product_id, s.revision_id")) {
      const ids = params[2] as number[];
      return rows<T>(ids.flatMap((id) => (this.current.has(id) ? [this.current.get(id)] : [])));
    }
    if (sql.includes("FROM dropship.dropship_product_listing_setting_requests")) return rows<T>(this.ledger ? [this.ledger] : []);
    if (sql.startsWith("INSERT INTO dropship.dropship_product_listing_setting_requests")) return rows<T>([{ id: "900" }]);
    if (sql.startsWith("INSERT INTO dropship.dropship_product_listing_setting_revisions") && sql.includes(" VALUES ")) {
      return rows<T>([{ id: this.nextRevisionId++ }]);
    }
    if (sql.startsWith("INSERT INTO dropship.dropship_product_listing_setting_revisions")) {
      const records = JSON.parse(String(params[7])) as Array<{ product_id: number }>;
      return rows<T>(records.map((record) => ({ id: this.nextRevisionId++, product_id: record.product_id })).reverse());
    }
    if (sql.startsWith("SELECT product_id, id FROM")) return rows<T>(this.replayRows);
    return rows<T>([]);
  }

  writes(): Call[] {
    return this.calls.filter((call) => /^(INSERT|UPDATE|DELETE)\b/.test(call.sql));
  }

  /** The table each write statement names, in order. */
  writtenTables(): string[] {
    return this.writes().map((call) => call.sql.split(" ")[2]);
  }

  callTo(prefix: string): Call {
    const call = this.calls.find((entry) => entry.sql.startsWith(prefix));
    if (!call) throw new Error(`No statement starting with ${prefix}`);
    return call;
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function asClient(client: ScriptedClient): Pick<PoolClient, "query"> {
  return client as unknown as Pick<PoolClient, "query">;
}

function storedValues(overrides: Partial<ProductListingSettingValues> = {}): ProductListingSettingValues {
  return {
    price: { basis: "product_cost", markupBps: 3500, flatCents: 25, rounding: "up_99" },
    ebayCategory: { categoryId: "183454", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] },
    storeShelf: { mode: "own", shelves: [{ id: "202", name: "Sleeves:Standard" }, { id: "101", name: "Sleeves" }] },
    shippingPolicy: { id: "6200000001", name: "Free shipping" },
    returnPolicy: { id: "6200000002", name: null },
    paymentPolicy: null,
    textAbove: { mode: "own", text: "Ships in 1 day." },
    textBelow: { mode: "none" },
    mainText: { text: "Private vendor words.", catalogHash: CATALOG_HASH },
    ...overrides,
  };
}

/**
 * A product's values at every bound of the stored contract, in 3-byte UTF-8
 * characters: the largest record a bulk change copies (about 100 KB of JSON).
 */
function largestValues(): ProductListingSettingValues {
  const wide = (length: number, last = "漢") => `${"漢".repeat(length - 1)}${last}`;
  const policy = { id: wide(MAX_LISTING_POLICY_ID_LENGTH), name: wide(MAX_LISTING_POLICY_NAME_LENGTH) };
  return {
    price: { basis: "catalog_retail", markupBps: 1_000_000, flatCents: 25, rounding: "up_99" },
    ebayCategory: {
      categoryId: "183454", categoryName: wide(MAX_EBAY_CATEGORY_NAME_LENGTH),
      path: Array.from({ length: MAX_EBAY_CATEGORY_PATH_DEPTH }, () => wide(MAX_EBAY_CATEGORY_NAME_LENGTH)),
    },
    storeShelf: {
      mode: "own",
      shelves: [
        { id: wide(MAX_LISTING_SHELF_ID_LENGTH, "1"), name: wide(MAX_LISTING_SHELF_NAME_LENGTH) },
        { id: wide(MAX_LISTING_SHELF_ID_LENGTH, "2"), name: wide(MAX_LISTING_SHELF_NAME_LENGTH) },
      ],
    },
    shippingPolicy: policy,
    returnPolicy: policy,
    paymentPolicy: policy,
    textAbove: { mode: "own", text: wide(MAX_TEMPLATE_TEXT_LENGTH) },
    textBelow: { mode: "own", text: wide(MAX_TEMPLATE_TEXT_LENGTH) },
    mainText: { text: wide(MAX_DESCRIPTION_TEXT_LENGTH), catalogHash: CATALOG_HASH },
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function caught(promise: Promise<unknown>): Promise<DropshipError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("Expected a DropshipError.");
}

function saveOne(client: ScriptedClient, patch: ProductListingSettingPatch, overrides: { expectedRevisionId?: number | null; requestHash?: string; productId?: number } = {}) {
  return saveProductListingSettingWithClient(asClient(client), SCOPE, {
    productId: overrides.productId ?? PRODUCT,
    expectedRevisionId: overrides.expectedRevisionId === undefined ? null : overrides.expectedRevisionId,
    patch, requestHash: overrides.requestHash ?? HASH, now: NOW,
  });
}

function bulkInput(
  products: Array<{ productId: number; expectedRevisionId: number | null }>,
  patch: ProductListingSettingBulkPatch,
  overrides: Partial<ProductListingSettingsBulkSaveInput> = {},
): ProductListingSettingsBulkSaveInput {
  return { operation: "product_settings_bulk", products, patch, requestHash: HASH, now: NOW, ...overrides };
}

function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    id: "900", vendor_id: VENDOR, store_connection_id: STORE, operation: "product_settings_bulk", idempotency_key: KEY,
    request_hash: HASH, product_count: 2, actor_type: "vendor", actor_id: "member-1", created_at: EARLIER, ...overrides,
  };
}

describe("readProductListingSettings", () => {
  it("sends no query for no products", async () => {
    const client = new ScriptedClient();
    const result = await readProductListingSettings(asClient(client), { vendorId: VENDOR, storeConnectionId: STORE, productIds: [] });
    expect(result.size).toBe(0);
    expect(client.calls).toEqual([]);
  });

  it("reads current rows with no lock text unless asked, ids distinct and ascending", async () => {
    const client = new ScriptedClient();
    client.current.set(3, currentRow(3, 30, storedValues()));
    client.current.set(9, currentRow(9, 90, { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, storeShelf: { mode: "none" } }));

    const result = await readProductListingSettings(asClient(client), {
      vendorId: VENDOR, storeConnectionId: STORE, productIds: [9, 3, 9, 12],
    });

    expect(client.calls).toEqual([{ sql: SQL.readCurrent(false), params: [VENDOR, STORE, [3, 9, 12]] }]);
    expect(client.calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|LOCK TABLE|FOR UPDATE|FOR SHARE|pg_advisory\w*)\b/i);
    expect([...result.keys()]).toEqual([3, 9]);
    expect(result.get(3)).toEqual({
      storeConnectionId: STORE, productId: 3, revisionId: 30, updatedAt: EARLIER.toISOString(), values: storedValues(),
    });
    expect(result.get(9)?.values.storeShelf).toEqual({ mode: "none" });

    await readProductListingSettings(asClient(client), { vendorId: VENDOR, storeConnectionId: STORE, productIds: [3], forUpdate: true });
    expect(client.calls[1].sql).toBe(SQL.readCurrent(true));
  });

  it("refuses an invalid product id before any query", async () => {
    const client = new ScriptedClient();
    for (const productId of [0, -1, 1.5, 2_147_483_648]) {
      const error = await caught(readProductListingSettings(asClient(client), { vendorId: VENDOR, storeConnectionId: STORE, productIds: [productId] }));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    }
    expect(client.calls).toEqual([]);
  });

  it("refuses a stored row with a partial value, naming the row and never its text", async () => {
    const client = new ScriptedClient();
    client.current.set(3, { ...currentRow(3, 30, storedValues()), body_catalog_hash: null });

    const error = await caught(readProductListingSettings(asClient(client), { vendorId: VENDOR, storeConnectionId: STORE, productIds: [3] }));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ group: "mainText", productId: "3", revisionId: "30", classification: "fatal", retryable: false });
    expect(JSON.stringify(error.context)).not.toContain("Private vendor words");
  });
});

describe("saveProductListingSettingWithClient", () => {
  it("writes the revision, then the current row, then the audit row, with exact parameters", async () => {
    const client = new ScriptedClient();
    const beforeValues = storedValues();
    client.current.set(PRODUCT, currentRow(PRODUCT, 31, beforeValues));
    const patch: ProductListingSettingPatch = {
      storeShelf: { mode: "own", shelves: [{ id: "303", name: "Toploaders" }] },
      mainText: null,
      paymentPolicy: { id: "6200000003", name: "Pay now" },
    };

    const result = await saveOne(client, patch, { expectedRevisionId: 31 });

    const after: ProductListingSettingValues = { ...beforeValues, ...patch } as ProductListingSettingValues;
    expect(client.calls.map((call) => call.sql)).toEqual([
      SQL.replayByKey, SQL.readCurrent(true), SQL.insertRevision, SQL.upsertCurrent, SQL.audit,
    ]);
    expect(client.calls[0].params).toEqual([VENDOR, KEY]);
    expect(client.calls[1].params).toEqual([VENDOR, STORE, [PRODUCT]]);
    const columns = productValuesToColumns(after);
    expect(client.calls[2].params).toEqual([
      VENDOR, STORE, PRODUCT, 31,
      ...PRODUCT_LISTING_SETTING_VALUE_COLUMNS.map((column) => {
        const value = columns[column];
        return JSONB_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value;
      }),
      KEY, HASH, "vendor", "member-1", NOW,
    ]);
    expect(client.calls[2].params.slice(4, 26)).toContain(JSON.stringify(["303"]));
    expect(client.calls[3].params).toEqual([VENDOR, STORE, PRODUCT, 500]);
    expect(client.calls[4].params.slice(0, 5)).toEqual([VENDOR, STORE, String(PRODUCT), "vendor", "member-1"]);
    expect(client.calls[4].params[6]).toBe(NOW);
    expect(JSON.parse(String(client.calls[4].params[5]))).toEqual({
      requestKey: KEY, revisionId: 500, previousRevisionId: 31,
      before: beforeValues, after, changedFields: ["storeShelf", "paymentPolicy", "mainText"],
    });
    expect(result).toEqual({
      outcome: "changed",
      row: { storeConnectionId: STORE, productId: PRODUCT, revisionId: 500, updatedAt: NOW.toISOString(), values: after },
      before: { storeConnectionId: STORE, productId: PRODUCT, revisionId: 31, updatedAt: EARLIER.toISOString(), values: beforeValues },
      changedFields: ["storeShelf", "paymentPolicy", "mainText"],
    });
  });

  it("starts a chain for a product with no row: no predecessor, jsonb nulls stay SQL NULL", async () => {
    const client = new ScriptedClient();

    const result = await saveOne(client, { textBelow: { mode: "own", text: "Thanks!" } });

    const insert = client.callTo("INSERT INTO dropship.dropship_product_listing_setting_revisions");
    expect(insert.params[3]).toBeNull();
    // Every value column but text_below_mode and text_below is NULL, the jsonb ones included (never the JSON text "null").
    const values = insert.params.slice(4, 26);
    expect(values.filter((value) => value !== null)).toEqual(["own", "Thanks!"]);
    expect(values).not.toContain("null");
    expect(result.outcome).toBe("changed");
    expect(result.before).toBeNull();
    expect(result.changedFields).toEqual(["textBelow"]);
    expect(JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_audit_events").params[5]))).toMatchObject({
      previousRevisionId: null, before: null,
    });
  });

  it("replays a key that already wrote a revision, writing nothing", async () => {
    const client = new ScriptedClient();
    const replayed = storedValues({ storeShelf: { mode: "none" } });
    client.revisionsByKey.set(KEY, {
      ...currentRow(PRODUCT, 31, replayed), store_connection_id: STORE, request_id: null, request_hash: HASH,
    });
    // A later edit moved the product on; the replay answers with its own revision and never touches the current row.
    client.current.set(PRODUCT, currentRow(PRODUCT, 40, storedValues()));

    const result = await saveOne(client, { storeShelf: { mode: "none" } }, { expectedRevisionId: 12 });

    expect(result).toEqual({
      outcome: "replayed",
      row: { storeConnectionId: STORE, productId: PRODUCT, revisionId: 31, updatedAt: EARLIER.toISOString(), values: replayed },
      before: null,
      changedFields: [],
    });
    expect(client.calls.map((call) => call.sql)).toEqual([SQL.replayByKey]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["another request", { request_hash: OTHER_HASH }, "requestHash"],
    ["another store", { store_connection_id: 45 }, "storeConnectionId"],
    ["another product", { product_id: 8 }, "productId"],
    ["a row of a many-products request", { request_id: "77" }, "requestId"],
  ])("refuses the same key for %s", async (_label, overrides, mismatched) => {
    const client = new ScriptedClient();
    client.revisionsByKey.set(KEY, {
      ...currentRow(PRODUCT, 31, storedValues()), store_connection_id: STORE, request_id: null, request_hash: HASH, ...overrides,
    });

    const error = await caught(saveOne(client, { storeShelf: { mode: "none" } }));

    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(error.context).toMatchObject({ mismatched: [mismatched], retryable: false, classification: "permanent" });
    expect(client.writes()).toEqual([]);
  });

  it.each<[string, number | null, number | null]>([
    ["a stale revision", 30, 31],
    ["a first save when a row exists", null, 31],
    ["an expected revision when no row exists", 31, null],
  ])("refuses %s before any insert", async (_label, expectedRevisionId, actualRevisionId) => {
    const client = new ScriptedClient();
    if (actualRevisionId !== null) client.current.set(PRODUCT, currentRow(PRODUCT, actualRevisionId, storedValues()));

    const error = await caught(saveOne(client, { storeShelf: { mode: "none" } }, { expectedRevisionId }));

    expect(error.code).toBe("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
    expect(error.context).toEqual({
      storeConnectionId: STORE, conflicts: [{ productId: PRODUCT, expectedRevisionId, actualRevisionId }], conflictCount: 1,
      retryable: false, classification: "permanent",
    });
    expect(client.writes()).toEqual([]);
  });

  it("writes nothing when the change sets what is stored (key order does not count)", async () => {
    const client = new ScriptedClient();
    client.current.set(PRODUCT, currentRow(PRODUCT, 31, storedValues()));

    const result = await saveOne(client, {
      price: { rounding: "up_99", flatCents: 25, markupBps: 3500, basis: "product_cost" },
      paymentPolicy: null,
    }, { expectedRevisionId: 31 });

    expect(result.outcome).toBe("unchanged");
    expect(result.changedFields).toEqual([]);
    expect(result.row).toEqual(result.before);
    expect(result.row?.revisionId).toBe(31);
    expect(client.writes()).toEqual([]);
  });

  it("writes nothing for a first save that only follows the defaults", async () => {
    const client = new ScriptedClient();

    const result = await saveOne(client, { price: null, textAbove: null });

    expect(result).toEqual({ outcome: "unchanged", row: null, before: null, changedFields: [] });
    expect(client.writes()).toEqual([]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ["an empty change", () => saveOne(new ScriptedClient(), {})],
    ["an unknown setting", () => saveOne(new ScriptedClient(), { colour: "red" } as unknown as ProductListingSettingPatch)],
    ["a partial recipe", () => saveOne(new ScriptedClient(), { price: { basis: "product_cost" } } as unknown as ProductListingSettingPatch)],
    ["product id 0", () => saveOne(new ScriptedClient(), { price: null }, { productId: 0 })],
    ["expected revision 0", () => saveOne(new ScriptedClient(), { price: null }, { expectedRevisionId: 0 })],
    ["a request hash that is not sha256 hex", () => saveOne(new ScriptedClient(), { price: null }, { requestHash: "nope" })],
  ])("refuses %s as a programming fault", async (_label, run) => {
    const error = await caught(run());
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ retryable: false, classification: "fatal" });
  });

  it("refuses a scope outside its contract before any SQL", async () => {
    for (const scope of [
      { ...SCOPE, requestKey: "short" },
      { ...SCOPE, actor: { actorType: "vendor" as const, actorId: "  " } },
      { ...SCOPE, actor: { actorType: "robot" as unknown as "vendor", actorId: "member-1" } },
      { ...SCOPE, storeConnectionId: 0 },
    ]) {
      const client = new ScriptedClient();
      const error = await caught(saveProductListingSettingWithClient(asClient(client), scope, {
        productId: PRODUCT, expectedRevisionId: null, patch: { price: null }, requestHash: HASH, now: NOW,
      }));
      expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
      expect(client.calls).toEqual([]);
    }
  });
});

describe("saveProductListingSettingsBulkWithClient", () => {
  const products = (ids: number[]) => ids.map((productId) => ({ productId, expectedRevisionId: null }));

  it.each<[string, ProductListingSettingsBulkInput]>([
    ["no products", bulkInput([], { storeShelf: { mode: "none" } })],
    ["10,001 products", bulkInput(products(Array.from({ length: 10_001 }, (_, index) => index + 1)), { storeShelf: { mode: "none" } })],
    ["a product twice", bulkInput(products([3, 4, 3]), { storeShelf: { mode: "none" } })],
    ["product id 0", bulkInput(products([0]), { storeShelf: { mode: "none" } })],
    ["a price", bulkInput(products([3]), { price: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } } as unknown as ProductListingSettingBulkPatch)],
    ["a price reset", bulkInput(products([3]), { price: null } as unknown as ProductListingSettingBulkPatch)],
    ["own main text", bulkInput(products([3]), { mainText: { text: "Words", catalogHash: CATALOG_HASH } } as unknown as ProductListingSettingBulkPatch)],
    ["an empty change", bulkInput(products([3]), {})],
    // W7's apply needs the review it applies (plan P23): without one it is refused like any bad request.
    ["a price apply with no review", { operation: "price_change_apply", products: products([3]), patch: { price: null },
      requestHash: HASH, now: NOW } as unknown as ProductListingSettingsBulkInput],
  ])("refuses %s before any SQL", async (_label, input) => {
    const client = new ScriptedClient();

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, input));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_BULK_INVALID");
    expect(error.context).toMatchObject({ retryable: false, classification: "permanent" });
    expect((error.context?.issues as unknown[]).length).toBeGreaterThan(0);
    expect(client.calls).toEqual([]);
  });

  it("names the refused field for a price and for own main text", async () => {
    const price = await caught(saveProductListingSettingsBulkWithClient(asClient(new ScriptedClient()), SCOPE,
      bulkInput(products([3]), { price: null } as unknown as ProductListingSettingBulkPatch)));
    expect(price.context?.issues).toEqual([
      { path: "patch.price", code: "custom", message: "Change prices for many products with a price check." },
    ]);
    const mainText = await caught(saveProductListingSettingsBulkWithClient(asClient(new ScriptedClient()), SCOPE,
      bulkInput(products([3]), { mainText: { text: "Words", catalogHash: CATALOG_HASH } } as unknown as ProductListingSettingBulkPatch)));
    expect(mainText.context?.issues).toEqual([
      { path: "patch.mainText", code: "custom", message: "Main text can only be reset for many products." },
    ]);
  });

  it("reports paths and codes, never text the caller sent", async () => {
    // Zod's own messages quote the input: "received 'VENDOR-TYPED-TEXT'", "Unrecognized key(s) in object: 'secret vendor words'".
    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(new ScriptedClient()), SCOPE, bulkInput(
      products([3]),
      { storeShelf: { mode: "none" }, "secret vendor words": true } as unknown as ProductListingSettingBulkPatch,
      { operation: "VENDOR-TYPED-TEXT" as unknown as ProductListingSettingsBulkSaveInput["operation"] },
    )));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_BULK_INVALID");
    expect(error.context?.issues).toEqual([
      { path: "operation", code: "invalid_enum_value" },
      { path: "patch", code: "unrecognized_keys" },
    ]);
    expect(JSON.stringify(error.context)).not.toMatch(/VENDOR-TYPED-TEXT|secret vendor words/);
  });

  it("writes 10,000 products with four statements: ledger, revisions, current rows, audit", async () => {
    const client = new ScriptedClient();
    const ids = Array.from({ length: 10_000 }, (_, index) => index + 1);
    // Every tenth product already has no shelf, so it is unchanged; every other even product has a row.
    for (const id of ids) {
      if (id % 10 === 0) client.current.set(id, currentRow(id, id + 100_000, { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, storeShelf: { mode: "none" } }));
      else if (id % 2 === 0) client.current.set(id, currentRow(id, id + 100_000, storedValues()));
    }
    const input = bulkInput(
      [...ids].reverse().map((productId) => ({ productId, expectedRevisionId: client.current.has(productId) ? productId + 100_000 : null })),
      { storeShelf: { mode: "none" } },
    );

    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, input);

    expect(client.writtenTables()).toEqual([
      "dropship.dropship_product_listing_setting_requests",
      "dropship.dropship_product_listing_setting_revisions",
      "dropship.dropship_product_listing_settings",
      "dropship.dropship_audit_events",
    ]);
    // The current rows are locked in one ascending read.
    const read = client.callTo("SELECT s.product_id");
    expect(read.sql).toBe(SQL.readCurrent(true));
    expect(read.params[2]).toEqual(ids);

    const ledger = client.callTo("INSERT INTO dropship.dropship_product_listing_setting_requests");
    expect(ledger.params).toEqual([VENDOR, STORE, "product_settings_bulk", KEY, HASH, 9_000, "vendor", "member-1", NOW]);

    // x.child_key is the idempotency key and $4 (the parent hash) the request hash of every revision.
    const revisions = client.callTo("INSERT INTO dropship.dropship_product_listing_setting_revisions");
    expect(revisions.sql).toBe(SQL.bulkRevisionInsert);
    expect(revisions.params.slice(0, 7)).toEqual([VENDOR, STORE, 900, HASH, "vendor", "member-1", NOW]);
    // 10,000 products with short stored texts fit the 8 MiB payload bound: one statement (writtenTables above).
    expect(MAX_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
    expect(Buffer.byteLength(String(revisions.params[7]), "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const records = JSON.parse(String(revisions.params[7])) as Array<Record<string, unknown>>;
    expect(records).toHaveLength(9_000);
    expect(records.map((record) => record.product_id)).toEqual(ids.filter((id) => id % 10 !== 0));
    for (const record of records) {
      const productId = record.product_id as number;
      expect(record.child_key).toBe(listingSettingChildKey(KEY, "product", productId));
      expect(record.previous_revision_id).toBe(productId % 2 === 0 ? productId + 100_000 : null);
      expect(record.shelf_mode).toBe("none");
      expect(record.shelf_ids).toBeNull();
    }
    // Copied values are kept: an even product keeps its own price and texts.
    expect(records.find((record) => record.product_id === 2)).toMatchObject({
      price_basis: "product_cost", price_markup_bps: 3500, text_above: "Ships in 1 day.", body_text: "Private vendor words.",
      ebay_category_path: ["Collectibles", "Card Sleeves"],
    });

    const upsert = client.callTo("INSERT INTO dropship.dropship_product_listing_settings");
    expect(upsert.sql).toBe(SQL.bulkCurrentUpsert);
    expect(upsert.params.slice(0, 2)).toEqual([VENDOR, STORE]);
    const heads = JSON.parse(String(upsert.params[2])) as Array<{ product_id: number; revision_id: number }>;
    expect(heads).toHaveLength(9_000);
    expect(new Set(heads.map((head) => head.revision_id)).size).toBe(9_000);
    expect(heads).toEqual(result.changed.map((entry) => ({ product_id: entry.productId, revision_id: entry.revisionId })));

    const audit = client.callTo("INSERT INTO dropship.dropship_audit_events");
    expect(audit.sql).toBe(SQL.bulkAudit);
    expect(audit.params.slice(0, 5)).toEqual([VENDOR, STORE, "vendor", "member-1", NOW]);
    const audits = JSON.parse(String(audit.params[5])) as Array<{ product_id: number; payload: Record<string, unknown> }>;
    expect(audits).toHaveLength(9_000);

    expect(result.outcome).toBe("changed");
    expect(result.requestId).toBe(900);
    expect(result.changed).toHaveLength(9_000);
    expect(result.changed.map((entry) => entry.productId)).toEqual(ids.filter((id) => id % 10 !== 0));
    // The script numbers revisions in record order and returns them reversed: matched by position,
    // product 1 would get the last id.
    const revisionOf = new Map(result.changed.map((entry) => [entry.productId, entry.revisionId]));
    expect(revisionOf.get(1)).toBe(500);
    expect(revisionOf.get(9_999)).toBe(500 + 8_999);
    expect(result.unchangedProductIds).toEqual(ids.filter((id) => id % 10 === 0));
  });

  it("splits the revision insert by payload size when stored values are at the contract's bounds", async () => {
    const client = new ScriptedClient();
    const values = largestValues();
    // One stored-columns object shared by every row, so the test holds each long text once.
    const columns = storedColumns(values);
    // About 92 KB a record: 250 products are over twice the 8 MiB bound.
    const ids = Array.from({ length: 250 }, (_, index) => index + 1);
    for (const id of ids) client.current.set(id, { product_id: id, revision_id: id + 100_000, ...columns, created_at: EARLIER });

    // "Also clear theirs" for one policy: every other stored value is copied into the new revisions.
    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, bulkInput(
      ids.map((productId) => ({ productId, expectedRevisionId: productId + 100_000 })),
      { paymentPolicy: null },
      { operation: "category_settings_clear" },
    ));

    const inserts = client.calls.filter((call) => call.sql.startsWith(`INSERT INTO ${REVISIONS_TABLE}`));
    expect(inserts.length).toBeGreaterThan(1);
    expect(client.writtenTables()).toEqual([
      "dropship.dropship_product_listing_setting_requests",
      ...inserts.map(() => REVISIONS_TABLE),
      "dropship.dropship_product_listing_settings",
      "dropship.dropship_audit_events",
    ]);
    const chunks = inserts.map((call) => {
      // Every chunk is the same statement with the same shared parameters.
      expect(call.sql).toBe(SQL.bulkRevisionInsert);
      expect(call.params.slice(0, 7)).toEqual([VENDOR, STORE, 900, HASH, "vendor", "member-1", NOW]);
      const text = String(call.params[7]);
      return { bytes: Buffer.byteLength(text, "utf8"), records: JSON.parse(text) as Array<Record<string, unknown>> };
    });
    const recordBytes = Buffer.byteLength(JSON.stringify(chunks[0].records[0]), "utf8");
    expect(recordBytes).toBeGreaterThan(90_000);
    // The whole payload is over twice the bound; each statement is under it, and only the last is short.
    expect(chunks.reduce((total, chunk) => total + chunk.bytes, 0)).toBeGreaterThan(2 * MAX_PAYLOAD_BYTES);
    for (const [index, chunk] of chunks.entries()) {
      expect(chunk.bytes).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      if (index < chunks.length - 1) expect(chunk.bytes + recordBytes + 1).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    }

    // Each product exactly once, in product order across the statements, with its stored texts copied unchanged.
    const records = chunks.flatMap((chunk) => chunk.records);
    expect(records.map((record) => record.product_id)).toEqual(ids);
    for (const record of records) {
      const productId = record.product_id as number;
      expect(record.child_key).toBe(listingSettingChildKey(KEY, "product", productId));
      expect(record.previous_revision_id).toBe(productId + 100_000);
      expect(record.payment_policy_id).toBeNull();
      expect(record.body_text).toBe(values.mainText?.text);
      expect(record.text_above).toBe(columns.text_above);
      expect(record.text_below).toBe(columns.text_below);
      expect(record.shelf_names).toEqual(columns.shelf_names);
    }

    // One current-row upsert and one audit insert still cover every product.
    const heads = JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_product_listing_settings").params[2])) as unknown[];
    expect(heads).toHaveLength(ids.length);
    const audits = JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_audit_events").params[5])) as unknown[];
    expect(audits).toHaveLength(ids.length);
    expect(result.outcome).toBe("changed");
    expect(result.changed.map((entry) => entry.productId)).toEqual(ids);
    expect(new Set(result.changed.map((entry) => entry.revisionId)).size).toBe(ids.length);
    expect(result.unchangedProductIds).toEqual([]);
  });

  it("audits only the changed settings, texts by digest", async () => {
    const client = new ScriptedClient();
    const longText = "Own words above. ".repeat(200).trim();
    client.current.set(3, currentRow(3, 30, storedValues({ textAbove: { mode: "own", text: longText } })));
    client.current.set(4, currentRow(4, 40, storedValues({ textAbove: { mode: "own", text: "New words" }, mainText: null })));

    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, bulkInput(
      [{ productId: 3, expectedRevisionId: 30 }, { productId: 4, expectedRevisionId: 40 }, { productId: 5, expectedRevisionId: null }],
      { textAbove: { mode: "own", text: "New words" }, mainText: null },
      { operation: "category_settings_clear" },
    ));

    expect(result.unchangedProductIds).toEqual([4]);
    const audit = client.callTo("INSERT INTO dropship.dropship_audit_events");
    const text = String(audit.params[5]);
    expect(text).not.toContain(longText);
    expect(text).not.toContain("New words");
    expect(text).not.toContain("Private vendor words.");
    const audits = JSON.parse(text) as Array<{ product_id: number; payload: Record<string, unknown> }>;
    const revisionOf = new Map(result.changed.map((entry) => [entry.productId, entry.revisionId]));
    expect(audits).toEqual([
      {
        product_id: 3,
        payload: {
          requestKey: KEY, requestId: 900, operation: "category_settings_clear", revisionId: revisionOf.get(3), previousRevisionId: 30,
          changedFields: ["textAbove", "mainText"],
          before: {
            textAbove: { mode: "own", length: longText.length, sha256: sha256(longText) },
            mainText: { length: "Private vendor words.".length, sha256: sha256("Private vendor words."), catalogHash: CATALOG_HASH },
          },
          after: { textAbove: { mode: "own", length: 9, sha256: sha256("New words") }, mainText: null },
        },
      },
      {
        product_id: 5,
        payload: {
          requestKey: KEY, requestId: 900, operation: "category_settings_clear", revisionId: revisionOf.get(5), previousRevisionId: null,
          changedFields: ["textAbove"],
          before: null,
          after: { textAbove: { mode: "own", length: 9, sha256: sha256("New words") } },
        },
      },
    ]);
    // The revisions carry the full texts the audit rows leave out.
    const records = JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_product_listing_setting_revisions").params[7])) as Array<Record<string, unknown>>;
    expect(records.map((record) => [record.product_id, record.text_above, record.body_text])).toEqual([
      [3, "New words", null], [5, "New words", null],
    ]);
    expect(client.callTo("INSERT INTO dropship.dropship_product_listing_setting_requests").params[2]).toBe("category_settings_clear");
  });

  it("refuses the whole request for one stale product", async () => {
    const client = new ScriptedClient();
    for (const id of [1, 2, 3, 4, 5]) client.current.set(id, currentRow(id, id * 10, storedValues()));

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, bulkInput(
      [1, 2, 3, 4, 5].map((productId) => ({ productId, expectedRevisionId: productId === 3 ? 29 : productId * 10 })),
      { storeShelf: { mode: "none" } },
    )));

    expect(error.code).toBe("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
    expect(error.context).toEqual({
      storeConnectionId: STORE, conflicts: [{ productId: 3, expectedRevisionId: 29, actualRevisionId: 30 }], conflictCount: 1,
      retryable: false, classification: "permanent",
    });
    expect(client.writes()).toEqual([]);
  });

  it("refuses the whole request when many products are stale, naming the first 100 and counting all", async () => {
    const client = new ScriptedClient();
    const ids = Array.from({ length: 200 }, (_, index) => index + 1);
    for (const id of ids) client.current.set(id, currentRow(id, id + 1_000, storedValues()));
    // 150 products were saved again after the vendor read them.
    const input = bulkInput(ids.map((productId) => ({
      productId, expectedRevisionId: productId > 50 ? productId + 999 : productId + 1_000,
    })), { storeShelf: { mode: "none" } });

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, input));

    expect(error.code).toBe("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
    expect(error.context?.conflictCount).toBe(150);
    const conflicts = error.context?.conflicts as Array<{ productId: number }>;
    expect(conflicts).toHaveLength(100);
    expect(conflicts[0]).toEqual({ productId: 51, expectedRevisionId: 1_050, actualRevisionId: 1_051 });
    expect(conflicts.at(-1)?.productId).toBe(150);
    expect(error.context).toMatchObject({ storeConnectionId: STORE, retryable: false, classification: "permanent" });
    expect(client.writes()).toEqual([]);
  });

  it("writes only the ledger row, with a count of 0, when no product changes", async () => {
    const client = new ScriptedClient();
    client.current.set(3, currentRow(3, 30, storedValues({ paymentPolicy: null, mainText: null })));

    // Product 4 has no row: resetting a setting it already follows changes nothing either.
    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE,
      bulkInput([{ productId: 4, expectedRevisionId: null }, { productId: 3, expectedRevisionId: 30 }], { paymentPolicy: null, mainText: null }));

    expect(result).toEqual({ outcome: "unchanged", requestId: 900, changed: [], unchangedProductIds: [3, 4] });
    expect(client.writtenTables()).toEqual(["dropship.dropship_product_listing_setting_requests"]);
    expect(client.writes()[0].params[5]).toBe(0);
  });

  it("replays a request from the ledger without writing", async () => {
    const client = new ScriptedClient();
    client.ledger = ledgerRow({ product_count: 2 });
    client.replayRows = [{ product_id: 3, id: 501 }, { product_id: 5, id: 502 }];

    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE,
      bulkInput(products([5, 4, 3]), { storeShelf: { mode: "none" } }));

    expect(result).toEqual({
      outcome: "replayed", requestId: 900,
      changed: [{ productId: 3, revisionId: 501 }, { productId: 5, revisionId: 502 }],
      unchangedProductIds: [4],
    });
    expect(client.calls.map((call) => call.sql.slice(0, 40))).toEqual([
      "SELECT id, vendor_id, store_connection_i", "SELECT product_id, id FROM dropship.drop",
    ]);
    expect(client.calls[1]).toEqual({ sql: SQL.bulkReplay, params: [900] });
    expect(client.writes()).toEqual([]);
  });

  it.each<[string, Partial<LedgerRow>]>([
    ["another request", { request_hash: OTHER_HASH }],
    ["another operation", { operation: "category_settings_clear" }],
    ["another store", { store_connection_id: 45 }],
  ])("refuses a key already used for %s", async (_label, overrides) => {
    const client = new ScriptedClient();
    client.ledger = ledgerRow(overrides);

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE,
      bulkInput(products([3]), { storeShelf: { mode: "none" } })));

    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(client.calls).toHaveLength(1);
  });

  it("refuses a replay whose revisions do not match the ledger's count", async () => {
    const client = new ScriptedClient();
    client.ledger = ledgerRow({ product_count: 3 });
    client.replayRows = [{ product_id: 3, id: 501 }, { product_id: 5, id: 502 }];

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE,
      bulkInput(products([3, 4, 5]), { storeShelf: { mode: "none" } })));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE");
    expect(error.context).toEqual({ requestId: 900, expectedCount: 3, foundCount: 2, retryable: false, classification: "fatal" });
    expect(client.writes()).toEqual([]);
  });

  it("refuses a revision insert that does not return one row per product", async () => {
    const client = new ScriptedClient();
    const query = client.query.bind(client);
    client.query = async <T>(text: string, params: unknown[] = []) => {
      const result = await query<T>(text, params);
      return normalize(text).includes("jsonb_to_recordset($8::jsonb)") ? { rows: result.rows.slice(1) } : result;
    };

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE,
      bulkInput(products([3, 4]), { storeShelf: { mode: "none" } })));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ expectedCount: 2, returnedCount: 1 });
    expect(client.calls.some((call) => call.sql.startsWith("INSERT INTO dropship.dropship_audit_events"))).toBe(false);
  });
});

describe("saveProductListingSettingsBulkWithClient, W7's price apply (plan PR 9, P23, 9.7)", () => {
  const REVIEW = "7d1b5e0a-3c4f-4a8b-9e2d-0f1a2b3c4d5e";
  const RECIPE = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } as const;
  const products = (ids: number[]) => ids.map((productId) => ({ productId, expectedRevisionId: null }));
  const applyInput = (overrides: Partial<PriceChangeApplyBulkInput> = {}): PriceChangeApplyBulkInput => ({
    operation: "price_change_apply", reviewId: REVIEW, products: products([3, 4]), patch: { price: RECIPE },
    requestHash: HASH, now: NOW, ...overrides,
  });
  /** The apply-only insert: 0738's columns with the review id, the operation a literal. */
  const APPLY_INSERT = normalize(`INSERT INTO dropship.dropship_product_listing_setting_requests
    (vendor_id, store_connection_id, operation, review_id, idempotency_key, request_hash, product_count,
    actor_type, actor_id, created_at)
    VALUES ($1, $2, 'price_change_apply', $3, $4, $5, $6, $7, $8, $9)
    RETURNING id`);

  it("writes a price for the products through the apply-only ledger insert, never 0738's, with the review in each audit row", async () => {
    const client = new ScriptedClient();
    client.current.set(4, currentRow(4, 40, storedValues()));
    const input = Object.freeze(applyInput({ products: Object.freeze([{ productId: 4, expectedRevisionId: 40 }, { productId: 3, expectedRevisionId: null }]) }));

    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, input);

    expect(client.writtenTables()).toEqual([
      "dropship.dropship_product_listing_setting_requests", REVISIONS_TABLE,
      "dropship.dropship_product_listing_settings", "dropship.dropship_audit_events",
    ]);
    const ledger = client.callTo("INSERT INTO dropship.dropship_product_listing_setting_requests");
    expect(ledger.sql).toBe(APPLY_INSERT);
    expect(ledger.params).toEqual([VENDOR, STORE, REVIEW, KEY, HASH, 2, "vendor", "member-1", NOW]);
    // 0738's insert (operation as a parameter, no review id) is never sent.
    expect(client.calls.filter((call) => call.sql.startsWith("INSERT INTO dropship.dropship_product_listing_setting_requests")))
      .toHaveLength(1);
    const records = JSON.parse(String(client.callTo(`INSERT INTO ${REVISIONS_TABLE}`).params[7])) as Array<Record<string, unknown>>;
    expect(records.map((record) => [record.product_id, record.price_basis, record.price_markup_bps, record.price_rounding]))
      .toEqual([[3, "catalog_retail", 2_000, "up_99"], [4, "catalog_retail", 2_000, "up_99"]]);
    // A price-only apply copies every other stored value, texts included (what the text budget counts, plan 3.10 (b)).
    expect(records[1]).toMatchObject({ text_above: "Ships in 1 day.", body_text: "Private vendor words.", shelf_mode: "own" });
    const audits = JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_audit_events").params[5])) as
      Array<{ product_id: number; payload: Record<string, unknown> }>;
    expect(audits.map((audit) => audit.payload)).toEqual([
      expect.objectContaining({ requestKey: KEY, requestId: 900, operation: "price_change_apply", reviewId: REVIEW,
        changedFields: ["price"], previousRevisionId: null, before: null, after: { price: RECIPE } }),
      expect.objectContaining({ operation: "price_change_apply", reviewId: REVIEW, changedFields: ["price"], previousRevisionId: 40,
        before: { price: storedValues().price }, after: { price: RECIPE } }),
    ]);
    // reviewId sits right after the operation, as the plan's correlation join reads it.
    expect(Object.keys(audits[0].payload).slice(0, 4)).toEqual(["requestKey", "requestId", "operation", "reviewId"]);
    expect(result).toMatchObject({ outcome: "changed", requestId: 900, unchangedProductIds: [] });
    expect(input.products.map((product) => product.productId)).toEqual([4, 3]);
  });

  it("resets the products' price (Use default), and an apply that sets what is stored writes only its ledger row", async () => {
    const reset = new ScriptedClient();
    reset.current.set(4, currentRow(4, 40, storedValues()));
    const changed = await saveProductListingSettingsBulkWithClient(asClient(reset), SCOPE,
      applyInput({ products: [{ productId: 4, expectedRevisionId: 40 }], patch: { price: null } }));
    expect(changed.outcome).toBe("changed");
    const record = (JSON.parse(String(reset.callTo(`INSERT INTO ${REVISIONS_TABLE}`).params[7])) as Array<Record<string, unknown>>)[0];
    expect([record.price_basis, record.price_markup_bps, record.price_flat_cents, record.price_rounding]).toEqual([null, null, null, null]);

    const same = new ScriptedClient();
    same.current.set(4, currentRow(4, 40, storedValues({ price: RECIPE })));
    const unchanged = await saveProductListingSettingsBulkWithClient(asClient(same), SCOPE,
      applyInput({ products: [{ productId: 4, expectedRevisionId: 40 }] }));
    expect(unchanged).toEqual({ outcome: "unchanged", requestId: 900, changed: [], unchangedProductIds: [4] });
    expect(same.writtenTables()).toEqual(["dropship.dropship_product_listing_setting_requests"]);
    expect(same.callTo("INSERT INTO dropship.dropship_product_listing_setting_requests").params[5]).toBe(0);
  });

  it("writes the ledger row of an apply that names no product, with an empty patch (v2, C-money-4): no product read", async () => {
    const client = new ScriptedClient();

    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, applyInput({ products: [], patch: {} }));

    expect(result).toEqual({ outcome: "unchanged", requestId: 900, changed: [], unchangedProductIds: [] });
    // The replay read by key, then the apply-only insert: no current-row read for no products.
    expect(client.calls.map((call) => call.sql.split(" ").slice(0, 4).join(" "))).toEqual([
      "SELECT id, vendor_id, store_connection_id,", "INSERT INTO dropship.dropship_product_listing_setting_requests (vendor_id,",
    ]);
    expect(client.callTo("INSERT INTO dropship.dropship_product_listing_setting_requests").params).toEqual([
      VENDOR, STORE, REVIEW, KEY, HASH, 0, "vendor", "member-1", NOW,
    ]);
  });

  it("clears a category apply's settings on its products: the price and other settings, each only as a reset", async () => {
    const client = new ScriptedClient();
    client.current.set(4, currentRow(4, 40, storedValues()));

    const result = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, applyInput({
      products: [{ productId: 4, expectedRevisionId: 40 }],
      patch: { price: null, storeShelf: null, shippingPolicy: null, textAbove: null, mainText: null },
    }));

    expect(result.outcome).toBe("changed");
    const record = (JSON.parse(String(client.callTo(`INSERT INTO ${REVISIONS_TABLE}`).params[7])) as Array<Record<string, unknown>>)[0];
    expect(record).toMatchObject({ price_basis: null, shelf_mode: null, fulfillment_policy_id: null, text_above_mode: null, text_above: null,
      body_text: null, return_policy_id: "6200000002", text_below_mode: "none" });
  });

  it.each<[string, Partial<PriceChangeApplyBulkInput>, Array<Record<string, unknown>>]>([
    ["an empty patch with products", { patch: {} }, [{ path: "patch", code: "custom", message: "Change at least one setting." }]],
    ["own main text", { patch: { mainText: { text: "Words", catalogHash: CATALOG_HASH } } },
      [{ path: "patch.mainText", code: "custom", message: "Main text can only be reset for many products." }]],
    ["a shelf set", { patch: { price: null, storeShelf: { mode: "none" } } },
      [{ path: "patch.storeShelf", code: "custom", message: "A price change sets only prices; other settings can only be reset." }]],
    ["own text above set", { patch: { textAbove: { mode: "own", text: "Words" } } },
      [{ path: "patch.textAbove", code: "custom", message: "A price change sets only prices; other settings can only be reset." }]],
    ["a review id that is not the server's (upper case)", { reviewId: REVIEW.toUpperCase() }, [{ path: "reviewId", code: "invalid_string" }]],
    ["no review id", { reviewId: undefined as unknown as string }, [{ path: "reviewId", code: "invalid_type" }]],
    ["10,001 products", { products: products(Array.from({ length: 10_001 }, (_, index) => index + 1)) },
      [{ path: "products", code: "too_big" }]],
    ["a product twice", { products: products([3, 4, 3]) }, [{ path: "products", code: "custom", message: "Each product once." }]],
    ["an unknown setting", { patch: { price: null, "secret vendor words": true } as unknown as PriceChangeApplyBulkInput["patch"] },
      [{ path: "patch", code: "unrecognized_keys" }]],
  ])("refuses %s before any SQL, naming the field", async (_label, overrides, issues) => {
    const client = new ScriptedClient();

    const error = await caught(saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, applyInput(overrides)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_BULK_INVALID");
    expect(error.context).toMatchObject({ issues, retryable: false, classification: "permanent" });
    expect(JSON.stringify(error.context)).not.toMatch(/secret vendor words|Words/);
    expect(client.calls).toEqual([]);
  });

  it("replays an apply from its ledger row without writing, and refuses another request under the key", async () => {
    const client = new ScriptedClient();
    client.ledger = ledgerRow({ operation: "price_change_apply", product_count: 1 });
    client.replayRows = [{ product_id: 3, id: 501 }];

    const replay = await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, applyInput());
    expect(replay).toEqual({ outcome: "replayed", requestId: 900, changed: [{ productId: 3, revisionId: 501 }], unchangedProductIds: [4] });
    expect(client.writes()).toEqual([]);

    const other = new ScriptedClient();
    other.ledger = ledgerRow({ operation: "price_change_apply", request_hash: OTHER_HASH });
    const conflict = await caught(saveProductListingSettingsBulkWithClient(asClient(other), SCOPE, applyInput()));
    expect(conflict).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { mismatched: ["requestHash"] } });
    // A W6 request under the apply's key is a reuse of the key, never a replay.
    const w6 = new ScriptedClient();
    w6.ledger = ledgerRow({ operation: "product_settings_bulk" });
    expect(await caught(saveProductListingSettingsBulkWithClient(asClient(w6), SCOPE, applyInput())))
      .toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { mismatched: ["operation"] } });
  });

  it("keeps W6's and W12's audit rows without a review id", async () => {
    const client = new ScriptedClient();
    await saveProductListingSettingsBulkWithClient(asClient(client), SCOPE, bulkInput(products([3]), { storeShelf: { mode: "none" } }));
    const audits = JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_audit_events").params[5])) as
      Array<{ payload: Record<string, unknown> }>;
    expect(audits[0].payload).not.toHaveProperty("reviewId");
    expect(client.callTo("INSERT INTO dropship.dropship_product_listing_setting_requests").sql).not.toContain("review_id");
  });
});

describe("saveProductListingSettingsPerProductWithClient, the conversion's product rows (PR 11, plan 7.A.2 row 10)", () => {
  const CONVERSION_KEY = "ls-convert:0b8e7c1d-5f4a-4c3b-9a2e-1d0c9b8a7f6e";
  const CONVERSION_SCOPE: ListingSettingWriteScope = { ...SCOPE, requestKey: CONVERSION_KEY };
  const CONVERSION_ID = 4_000_000_001;
  const RECIPE = { basis: "catalog_retail", markupBps: 2_000, flatCents: 0, rounding: "up_99" } as const;
  const SLEEVES = { categoryId: "261328", categoryName: "Sleeves", path: ["Collectibles", "Sleeves"] };
  const perProduct = (products: ProductListingSettingsPerProductInput["products"],
    overrides: Partial<ProductListingSettingsPerProductInput> = {}): ProductListingSettingsPerProductInput =>
    ({ conversionId: CONVERSION_ID, products, requestHash: HASH, now: NOW, ...overrides });

  it("gives each product its own values, a price included: no ledger, request_id NULL, lc: keys, one audit row each", async () => {
    const client = new ScriptedClient();
    client.current.set(3, currentRow(3, 30, storedValues({ price: null, textAbove: null })));
    client.current.set(4, currentRow(4, 40, storedValues()));

    const result = await saveProductListingSettingsPerProductWithClient(asClient(client), CONVERSION_SCOPE, perProduct([
      // Out of order on purpose: rows are locked, compared and written in ascending product order.
      { productId: 5, expectedRevisionId: null, patch: { ebayCategory: SLEEVES } },
      { productId: 3, expectedRevisionId: 30, patch: { price: RECIPE, textAbove: { mode: "own", text: "From the group." } } },
      // Sets what is stored: nothing is written for it.
      { productId: 4, expectedRevisionId: 40, patch: { price: storedValues().price } },
    ]));

    // No replay probe and no ledger: the conversion's record claimed the key in its own table.
    expect(client.calls.map((call) => call.sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "SELECT s.product_id, s.revision_id,",
      "INSERT INTO dropship.dropship_product_listing_setting_revisions",
      "INSERT INTO dropship.dropship_product_listing_settings",
      "INSERT INTO dropship.dropship_audit_events",
    ]);
    const read = client.callTo("SELECT s.product_id");
    expect(read.sql).toBe(SQL.readCurrent(true));
    expect(read.params).toEqual([VENDOR, STORE, [3, 4, 5]]);

    // W6's statements as they are, with no request (request_id NULL) and the conversion's hash.
    const revisions = client.callTo("INSERT INTO dropship.dropship_product_listing_setting_revisions");
    expect(revisions.sql).toBe(SQL.bulkRevisionInsert);
    expect(revisions.params.slice(0, 7)).toEqual([VENDOR, STORE, null, HASH, "vendor", "member-1", NOW]);
    const records = JSON.parse(String(revisions.params[7])) as Array<Record<string, unknown>>;
    expect(records.map((record) => [record.product_id, record.previous_revision_id, record.child_key])).toEqual([
      [3, 30, listingConversionChildKey(CONVERSION_KEY, "product", 3)],
      [5, null, listingConversionChildKey(CONVERSION_KEY, "product", 5)],
    ]);
    expect(records.every((record) => String(record.child_key).startsWith("lc:"))).toBe(true);
    // Each product its own patch over its own stored values.
    expect(records[0]).toMatchObject({ ...storedColumns(storedValues({ price: RECIPE, textAbove: { mode: "own", text: "From the group." } })),
      product_id: 3 });
    expect(records[1]).toMatchObject({ ...storedColumns({ ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ebayCategory: SLEEVES }), product_id: 5 });

    expect(client.callTo("INSERT INTO dropship.dropship_product_listing_settings").sql).toBe(SQL.bulkCurrentUpsert);
    const revisionOf = new Map(result.changed.map((entry) => [entry.productId, entry.revisionId]));
    expect(JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_product_listing_settings").params[2])))
      .toEqual([{ product_id: 3, revision_id: revisionOf.get(3) }, { product_id: 5, revision_id: revisionOf.get(5) }]);

    const audit = client.callTo("INSERT INTO dropship.dropship_audit_events");
    expect(audit.sql).toBe(SQL.bulkAudit);
    expect(audit.params.slice(0, 5)).toEqual([VENDOR, STORE, "vendor", "member-1", NOW]);
    expect(String(audit.params[5])).not.toContain("From the group.");
    expect(JSON.parse(String(audit.params[5]))).toEqual([
      { product_id: 3, payload: { conversionId: CONVERSION_ID, requestKey: CONVERSION_KEY, revisionId: revisionOf.get(3),
        previousRevisionId: 30, changedFields: ["price", "textAbove"], before: { price: null, textAbove: null },
        after: { price: RECIPE, textAbove: { mode: "own", length: 15, sha256: sha256("From the group.") } } } },
      { product_id: 5, payload: { conversionId: CONVERSION_ID, requestKey: CONVERSION_KEY, revisionId: revisionOf.get(5),
        previousRevisionId: null, changedFields: ["ebayCategory"], before: null, after: { ebayCategory: SLEEVES } } },
    ]);
    expect(result).toEqual({ changed: [{ productId: 3, revisionId: revisionOf.get(3) }, { productId: 5, revisionId: revisionOf.get(5) }],
      unchangedProductIds: [4] });
  });

  it("writes the actor it is given on every revision and audit row: the system for the job", async () => {
    const client = new ScriptedClient();
    const system: ListingSettingWriteScope = { ...CONVERSION_SCOPE, requestKey: "rules-conversion:44",
      actor: { actorType: "system", actorId: "rules-conversion-job" } };

    await saveProductListingSettingsPerProductWithClient(asClient(client), system,
      perProduct([{ productId: 3, expectedRevisionId: null, patch: { price: RECIPE } }]));

    const revisions = client.callTo("INSERT INTO dropship.dropship_product_listing_setting_revisions");
    expect(revisions.params.slice(0, 7)).toEqual([VENDOR, STORE, null, HASH, "system", "rules-conversion-job", NOW]);
    expect((JSON.parse(String(revisions.params[7])) as Array<{ child_key: string }>)[0].child_key)
      .toBe(listingConversionChildKey("rules-conversion:44", "product", 3));
    expect(client.callTo("INSERT INTO dropship.dropship_audit_events").params.slice(2, 4)).toEqual(["system", "rules-conversion-job"]);
  });

  it("writes nothing when every product already holds its patch", async () => {
    const client = new ScriptedClient();
    client.current.set(3, currentRow(3, 30, storedValues()));

    const result = await saveProductListingSettingsPerProductWithClient(asClient(client), CONVERSION_SCOPE,
      perProduct([{ productId: 3, expectedRevisionId: 30, patch: { price: storedValues().price, ebayCategory: storedValues().ebayCategory } }]));

    expect(result).toEqual({ changed: [], unchangedProductIds: [3] });
    expect(client.writes()).toEqual([]);
  });

  it("refuses the whole save when products moved, naming the first 100 and counting all, with nothing written", async () => {
    const client = new ScriptedClient();
    const ids = Array.from({ length: 200 }, (_, index) => index + 1);
    for (const id of ids) client.current.set(id, currentRow(id, id + 1_000, storedValues({ price: null })));

    const error = await caught(saveProductListingSettingsPerProductWithClient(asClient(client), CONVERSION_SCOPE, perProduct(
      ids.map((productId) => ({ productId, expectedRevisionId: productId > 50 ? productId + 999 : productId + 1_000, patch: { price: RECIPE } })))));

    expect(error.code).toBe("DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT");
    expect(error.context).toMatchObject({ storeConnectionId: STORE, conflictCount: 150, retryable: false, classification: "permanent" });
    const conflicts = error.context?.conflicts as Array<{ productId: number; expectedRevisionId: number; actualRevisionId: number }>;
    expect(conflicts).toHaveLength(100);
    expect(conflicts[0]).toEqual({ productId: 51, expectedRevisionId: 1_050, actualRevisionId: 1_051 });
    expect(conflicts.at(-1)?.productId).toBe(150);
    expect(client.writes()).toEqual([]);
  });

  it("splits the revision insert into 8 MiB statements when each product's values are at the contract's bounds", async () => {
    const client = new ScriptedClient();
    const values = largestValues();
    const columns = storedColumns(values);
    const ids = Array.from({ length: 250 }, (_, index) => index + 1);
    for (const id of ids) client.current.set(id, { product_id: id, revision_id: id + 100_000, ...columns, created_at: EARLIER });

    const result = await saveProductListingSettingsPerProductWithClient(asClient(client), CONVERSION_SCOPE, perProduct(
      ids.map((productId) => ({ productId, expectedRevisionId: productId + 100_000,
        patch: { price: { ...RECIPE, markupBps: productId } } }))));

    const inserts = client.calls.filter((call) => call.sql.startsWith(`INSERT INTO ${REVISIONS_TABLE}`));
    expect(inserts.length).toBeGreaterThan(1);
    const records = inserts.flatMap((call) => {
      expect(call.sql).toBe(SQL.bulkRevisionInsert);
      expect(call.params.slice(0, 7)).toEqual([VENDOR, STORE, null, HASH, "vendor", "member-1", NOW]);
      expect(Buffer.byteLength(String(call.params[7]), "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
      return JSON.parse(String(call.params[7])) as Array<Record<string, unknown>>;
    });
    // Each product once, in order, with its own price and its stored texts copied unchanged.
    expect(records.map((record) => [record.product_id, record.price_markup_bps])).toEqual(ids.map((id) => [id, id]));
    expect(records.every((record) => record.body_text === values.mainText?.text && record.text_above === columns.text_above)).toBe(true);
    expect(records.map((record) => record.child_key)).toEqual(ids.map((id) => listingConversionChildKey(CONVERSION_KEY, "product", id)));
    expect(result.changed.map((entry) => entry.productId)).toEqual(ids);
    expect(JSON.parse(String(client.callTo("INSERT INTO dropship.dropship_audit_events").params[5]))).toHaveLength(ids.length);
  });

  it.each<[string, Partial<ProductListingSettingsPerProductInput>]>([
    ["no products", { products: [] }],
    ["10,001 products", { products: Array.from({ length: 10_001 }, (_, index) => ({ productId: index + 1, expectedRevisionId: null,
      patch: { price: null } })) }],
    ["a product twice", { products: [{ productId: 3, expectedRevisionId: null, patch: { price: null } },
      { productId: 3, expectedRevisionId: null, patch: { textAbove: null } }] }],
    ["product id 0", { products: [{ productId: 0, expectedRevisionId: null, patch: { price: null } }] }],
    ["a revision id that is not an id", { products: [{ productId: 3, expectedRevisionId: 1.5, patch: { price: null } }] }],
    ["an empty patch", { products: [{ productId: 3, expectedRevisionId: null, patch: {} }] }],
    ["a patch outside the contract", { products: [{ productId: 3, expectedRevisionId: null,
      patch: { price: { ...RECIPE, markupBps: -1 } } as unknown as ProductListingSettingPatch }] }],
    ["an unknown setting", { products: [{ productId: 3, expectedRevisionId: null,
      patch: { "secret vendor words": true } as unknown as ProductListingSettingPatch }] }],
    ["no conversion id", { conversionId: 0 }],
    ["a request hash that is not one", { requestHash: "not-a-hash" }],
  ])("refuses %s before any SQL, as a fatal fault naming no text", async (_label, overrides) => {
    const client = new ScriptedClient();

    const error = await caught(saveProductListingSettingsPerProductWithClient(asClient(client), CONVERSION_SCOPE,
      perProduct([{ productId: 3, expectedRevisionId: null, patch: { price: RECIPE } }], overrides)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ retryable: false, classification: "fatal" });
    expect(JSON.stringify(error.context)).not.toContain("secret vendor words");
    expect(client.calls).toEqual([]);
  });

  it("refuses a scope outside its contract before any SQL", async () => {
    const client = new ScriptedClient();
    const error = await caught(saveProductListingSettingsPerProductWithClient(asClient(client), { ...CONVERSION_SCOPE, requestKey: "short" },
      perProduct([{ productId: 3, expectedRevisionId: null, patch: { price: RECIPE } }])));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ invalid: ["requestKey"] });
    expect(client.calls).toEqual([]);
  });
});
