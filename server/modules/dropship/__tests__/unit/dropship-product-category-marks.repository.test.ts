import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { CategoryMovesAcknowledgeInput } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import type { ListingSettingWriteScope } from "../../infrastructure/dropship-listing-setting-shared.repository";
import {
  acknowledgeCategoryMovesWithClient,
  insertFirstCategoryMarksWithClient,
  readProductCategoryMarks,
  type ListingSettingSystemScope,
} from "../../infrastructure/dropship-product-category-marks.repository";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const EARLIER = new Date("2026-10-01T08:30:00.000Z");
const KEY = "category-moves:5e0c9d1a-7b42-4f8e-a1c3-9d8e7f6a5b4c";
const HASH = "e".repeat(64);
const OTHER_HASH = "f".repeat(64);
const VENDOR_ID = 10;
const STORE_ID = 44;
const JOB_KEY = "first-category-marks:2026-10-10T12";

const SCOPE: ListingSettingWriteScope = {
  vendorId: VENDOR_ID, storeConnectionId: STORE_ID, actor: { actorType: "vendor", actorId: "member-1" }, requestKey: KEY,
};
const SYSTEM_SCOPE: ListingSettingSystemScope = {
  vendorId: VENDOR_ID, storeConnectionId: STORE_ID, actor: { actorType: "system", actorId: JOB_KEY },
};

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** Catalog products by id with their current category; the scripted upsert joins them as PostgreSQL would. */
type Catalog = Map<number, number | null>;

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  ledger: Record<string, unknown> | null = null;
  marks: Array<{ product_id: unknown; category_id: unknown; seen_at: unknown }> = [];
  catalog: Catalog = new Map();
  /** Products whose mark already exists: first marks skip them (ON CONFLICT DO NOTHING). */
  marked = new Set<number>();
  upsertReturns: Array<{ product_id: unknown; category_id: unknown }> | null = null;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = oneLine(text);
    this.sql.push(sql);
    this.params.push(params);
    if (sql.startsWith("SELECT id, vendor_id, store_connection_id, operation")) return rows<T>(this.ledger ? [this.ledger] : []);
    if (sql.startsWith("SELECT product_id, category_id, seen_at")) return rows<T>(this.marks);
    if (sql.startsWith("INSERT INTO dropship.dropship_product_category_seen AS m")) {
      if (this.upsertReturns) return rows<T>(this.upsertReturns);
      const items = JSON.parse(String(params[3])) as Array<{ product_id: number; shown_category_id: number | null }>;
      return rows<T>(items
        .filter((item) => this.catalog.has(item.product_id) && this.catalog.get(item.product_id) === item.shown_category_id)
        .map((item) => ({ product_id: item.product_id, category_id: item.shown_category_id })));
    }
    if (sql.startsWith("INSERT INTO dropship.dropship_product_category_seen")) {
      const ids = params[3] as number[];
      return rows<T>(ids.filter((id) => this.catalog.has(id) && !this.marked.has(id)).map((id) => ({ product_id: id })));
    }
    if (sql.startsWith("SELECT id AS product_id FROM catalog.products")) {
      return rows<T>((params[0] as number[]).filter((id) => this.catalog.has(id)).map((id) => ({ product_id: id })));
    }
    if (sql.startsWith("INSERT INTO dropship.dropship_product_listing_setting_requests")) return rows<T>([{ id: "77" }]);
    return rows<T>([]);
  }

  writes(): string[] {
    return this.sql.filter((sql) => /^(INSERT|UPDATE|DELETE)\b/.test(sql));
  }

  indexOf(prefix: string): number {
    return this.sql.findIndex((sql) => sql.startsWith(prefix));
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function asClient(client: ScriptedClient): Pick<PoolClient, "query"> {
  return client as unknown as Pick<PoolClient, "query">;
}

function acknowledgeInput(items: CategoryMovesAcknowledgeInput["items"], overrides: Partial<CategoryMovesAcknowledgeInput> = {}): CategoryMovesAcknowledgeInput {
  return { items, requestHash: HASH, now: NOW, ...overrides };
}

function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "77", vendor_id: VENDOR_ID, store_connection_id: STORE_ID, operation: "category_moves_acknowledge",
    idempotency_key: KEY, request_hash: HASH, product_count: 2, actor_type: "vendor", actor_id: "member-1",
    created_at: EARLIER, ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

describe("readProductCategoryMarks", () => {
  it("reads nothing for no ids", async () => {
    const client = new ScriptedClient();
    await expect(readProductCategoryMarks(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, productIds: [] }))
      .resolves.toEqual(new Map());
    expect(client.sql).toEqual([]);
  });

  it("reads the store's marks for distinct ids ascending, without a lock unless asked", async () => {
    const client = new ScriptedClient();
    client.marks = [{ product_id: 5, category_id: 31, seen_at: EARLIER }, { product_id: 9, category_id: null, seen_at: NOW }];

    const marks = await readProductCategoryMarks(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, productIds: [9, 5, 9] });

    expect([...marks.values()]).toEqual([
      { storeConnectionId: STORE_ID, productId: 5, categoryId: 31, seenAt: EARLIER.toISOString() },
      { storeConnectionId: STORE_ID, productId: 9, categoryId: null, seenAt: NOW.toISOString() },
    ]);
    expect(client.sql[0]).toBe("SELECT product_id, category_id, seen_at FROM dropship.dropship_product_category_seen "
      + "WHERE vendor_id = $1 AND store_connection_id = $2 AND product_id = ANY($3::int[]) ORDER BY product_id");
    expect(client.params[0]).toEqual([VENDOR_ID, STORE_ID, [5, 9]]);

    await readProductCategoryMarks(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, productIds: [5], forUpdate: true });
    expect(client.sql[1]).toMatch(/ORDER BY product_id FOR UPDATE$/);
  });

  it("refuses a stored mark that breaks its contract, naming the product", async () => {
    const client = new ScriptedClient();
    client.marks = [{ product_id: 5, category_id: 0, seen_at: EARLIER }];

    const error = await failure(readProductCategoryMarks(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, productIds: [5] }));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ storeConnectionId: STORE_ID, productId: "5", classification: "fatal" });
  });

  it("refuses an id that is not a positive whole number before any SQL", async () => {
    const client = new ScriptedClient();
    const error = await failure(readProductCategoryMarks(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, productIds: [5, 0] }));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.sql).toEqual([]);
  });
});

describe("insertFirstCategoryMarksWithClient", () => {
  it("inserts a mark only for products that have none, from the catalog, and never changes an existing mark", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[3, 31], [5, null], [8, 40]]);
    client.marked = new Set([8]);

    const result = await insertFirstCategoryMarksWithClient(asClient(client), SYSTEM_SCOPE, { productIds: [8, 5, 3, 5, 12], jobKey: JOB_KEY, now: NOW });

    expect(result).toEqual({ insertedProductIds: [3, 5] });
    expect(client.sql[0]).toBe("INSERT INTO dropship.dropship_product_category_seen (vendor_id, store_connection_id, product_id, category_id, seen_at) "
      + "SELECT $1, $2, p.id, p.category_id, $3 FROM catalog.products p WHERE p.id = ANY($4::int[]) ORDER BY p.id "
      + "ON CONFLICT (store_connection_id, product_id) DO NOTHING RETURNING product_id");
    expect(client.sql[0]).not.toMatch(/DO UPDATE|UPDATE dropship|DELETE/);
    expect(client.params[0]).toEqual([VENDOR_ID, STORE_ID, NOW, [3, 5, 8, 12]]);

    const audit = client.indexOf("INSERT INTO dropship.dropship_audit_events");
    expect(client.sql[audit]).toContain("VALUES ($1, $2, 'dropship_store_connection', $3, 'category_marks_seeded', $4, $5, 'info', $6::jsonb, $7)");
    expect(client.params[audit].slice(0, 5)).toEqual([VENDOR_ID, STORE_ID, String(STORE_ID), "system", JOB_KEY]);
    expect(JSON.parse(String(client.params[audit][5]))).toEqual({ jobKey: JOB_KEY, insertedCount: 2, productIds: [3, 5] });
    expect(client.params[audit][6]).toBe(NOW);
  });

  it("audits nothing when every product already has a mark, so a rerun writes nothing", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[3, 31]]);
    client.marked = new Set([3]);

    await expect(insertFirstCategoryMarksWithClient(asClient(client), SYSTEM_SCOPE, { productIds: [3], jobKey: JOB_KEY, now: NOW }))
      .resolves.toEqual({ insertedProductIds: [] });
    expect(client.sql).toHaveLength(1);
  });

  it("issues no query for no products", async () => {
    const client = new ScriptedClient();
    await expect(insertFirstCategoryMarksWithClient(asClient(client), SYSTEM_SCOPE, { productIds: [], jobKey: JOB_KEY, now: NOW }))
      .resolves.toEqual({ insertedProductIds: [] });
    expect(client.sql).toEqual([]);
  });

  it("names at most 100 products in its audit row, with the full count", async () => {
    const client = new ScriptedClient();
    const ids = Array.from({ length: 150 }, (_, index) => index + 1);
    client.catalog = new Map(ids.map((id) => [id, 31]));

    const result = await insertFirstCategoryMarksWithClient(asClient(client), SYSTEM_SCOPE, { productIds: ids, jobKey: JOB_KEY, now: NOW });

    expect(result.insertedProductIds).toHaveLength(150);
    const payload = JSON.parse(String(client.params[client.indexOf("INSERT INTO dropship.dropship_audit_events")][5]));
    expect(payload.insertedCount).toBe(150);
    expect(payload.productIds).toEqual(ids.slice(0, 100));
  });

  it.each<[string, Partial<{ productIds: number[]; jobKey: string; now: Date }>, Partial<ListingSettingSystemScope>]>([
    ["a non-positive product id", { productIds: [3, -3] }, {}],
    ["a blank job key", { jobKey: "  " }, {}],
    ["an invalid clock reading", { now: new Date(Number.NaN) }, {}],
    ["an unknown actor type", {}, { actor: { actorType: "robot" as "system", actorId: JOB_KEY } }],
  ])("refuses %s before any SQL", async (_label, inputOverrides, scopeOverrides) => {
    const client = new ScriptedClient();
    const error = await failure(insertFirstCategoryMarksWithClient(asClient(client), { ...SYSTEM_SCOPE, ...scopeOverrides },
      { productIds: [3], jobKey: JOB_KEY, now: NOW, ...inputOverrides }));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.sql).toEqual([]);
  });

  it("refuses a returned product it was not given", async () => {
    const client = new ScriptedClient();
    client.query = async <T>(text: string, params: unknown[] = []) => {
      client.sql.push(oneLine(text));
      client.params.push(params);
      return rows<T>([{ product_id: 99 }]);
    };
    const error = await failure(insertFirstCategoryMarksWithClient(asClient(client), SYSTEM_SCOPE, { productIds: [3], jobKey: JOB_KEY, now: NOW }));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
  });
});

describe("acknowledgeCategoryMovesWithClient", () => {
  it("moves a mark only while the product is still in the shown category, then records the request and one audit row", async () => {
    const client = new ScriptedClient();
    // 5 moved to 31 and is still there; 9 moved to no category; 12 moved again (to 41) after the page read it.
    client.catalog = new Map([[5, 31], [9, null], [12, 41]]);
    client.marks = [{ product_id: 5, category_id: 30, seen_at: EARLIER }, { product_id: 12, category_id: 30, seen_at: EARLIER }];

    const result = await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([
      { productId: 12, shownCategoryId: 40 }, { productId: 5, shownCategoryId: 31 }, { productId: 9, shownCategoryId: null },
    ]));

    expect(result).toEqual({ outcome: "acknowledged", acknowledgedProductIds: [5, 9], movedAgainProductIds: [12] });
    expect(client.sql.map((sql) => sql.split(" ").slice(0, 3).join(" "))).toEqual([
      "SELECT id, vendor_id,",
      "SELECT product_id, category_id,",
      "INSERT INTO dropship.dropship_product_category_seen",
      "SELECT id AS",
      "INSERT INTO dropship.dropship_product_listing_setting_requests",
      "INSERT INTO dropship.dropship_audit_events",
    ]);
    // Replay by the transaction's own key; the marks are locked before the upsert.
    expect(client.params[0]).toEqual([VENDOR_ID, KEY]);
    expect(client.sql[1]).toMatch(/FOR UPDATE$/);
    expect(client.params[1]).toEqual([VENDOR_ID, STORE_ID, [5, 9, 12]]);

    const upsert = client.indexOf("INSERT INTO dropship.dropship_product_category_seen AS m");
    expect(client.sql[upsert]).toBe("INSERT INTO dropship.dropship_product_category_seen AS m "
      + "(vendor_id, store_connection_id, product_id, category_id, seen_at) "
      + "SELECT $1, $2, p.id, p.category_id, $3 "
      + "FROM jsonb_to_recordset($4::jsonb) AS x(product_id integer, shown_category_id integer) "
      + "JOIN catalog.products p ON p.id = x.product_id AND p.category_id IS NOT DISTINCT FROM x.shown_category_id "
      + "ORDER BY p.id "
      + "ON CONFLICT (store_connection_id, product_id) "
      + "DO UPDATE SET category_id = EXCLUDED.category_id, seen_at = GREATEST(m.seen_at, EXCLUDED.seen_at) "
      + "RETURNING product_id, category_id");
    expect(client.params[upsert]).toEqual([VENDOR_ID, STORE_ID, NOW, JSON.stringify([
      { product_id: 5, shown_category_id: 31 }, { product_id: 9, shown_category_id: null }, { product_id: 12, shown_category_id: 40 },
    ])]);

    // Only the products not acknowledged are looked up, after the upsert.
    const catalogRead = client.indexOf("SELECT id AS product_id FROM catalog.products");
    expect(catalogRead).toBe(upsert + 1);
    expect(client.sql[catalogRead]).toBe("SELECT id AS product_id FROM catalog.products WHERE id = ANY($1::int[]) ORDER BY id");
    expect(client.params[catalogRead]).toEqual([[12]]);

    // product_count is the rows the request wrote (plan D12).
    const ledger = client.indexOf("INSERT INTO dropship.dropship_product_listing_setting_requests");
    expect(client.params[ledger]).toEqual([VENDOR_ID, STORE_ID, "category_moves_acknowledge", KEY, HASH, 2, "vendor", "member-1", NOW]);

    const audit = client.indexOf("INSERT INTO dropship.dropship_audit_events");
    expect(client.sql[audit]).toContain("VALUES ($1, $2, 'dropship_store_connection', $3, 'category_moves_acknowledged', $4, $5, 'info', $6::jsonb, $7)");
    expect(client.params[audit].slice(0, 5)).toEqual([VENDOR_ID, STORE_ID, String(STORE_ID), "vendor", "member-1"]);
    expect(JSON.parse(String(client.params[audit][5]))).toEqual({
      requestKey: KEY, requestId: 77,
      // 9 had no mark: `hadMark` tells it from a mark with no category.
      acknowledged: [{ productId: 5, hadMark: true, from: 30, to: 31 }, { productId: 9, hadMark: false, from: null, to: null }],
      acknowledgedCount: 2, movedAgain: [12], movedAgainCount: 1, notInCatalog: [], notInCatalogCount: 0,
    });
    expect(client.params[audit][6]).toBe(NOW);
    expect(client.writes().some((sql) => /^(UPDATE|DELETE)\b/.test(sql))).toBe(false);
  });

  it("tells a mark with no category from no mark at all in the audit's before-state", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[5, 31], [9, 31]]);
    client.marks = [{ product_id: 5, category_id: null, seen_at: EARLIER }];

    await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([
      { productId: 5, shownCategoryId: 31 }, { productId: 9, shownCategoryId: 31 },
    ]));

    const payload = JSON.parse(String(client.params[client.indexOf("INSERT INTO dropship.dropship_audit_events")][5]));
    expect(payload.acknowledged).toEqual([
      { productId: 5, hadMark: true, from: null, to: 31 }, { productId: 9, hadMark: false, from: null, to: 31 },
    ]);
  });

  it("reports a product no longer in the catalog as neither acknowledged nor moved again, and audits it", async () => {
    const client = new ScriptedClient();
    // 5 is acknowledged, 12 moved again, 15 was deleted from the catalog (its mark stays: plan D13).
    client.catalog = new Map([[5, 31], [12, 41]]);
    client.marks = [{ product_id: 15, category_id: 30, seen_at: EARLIER }];

    const result = await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([
      { productId: 15, shownCategoryId: 31 }, { productId: 12, shownCategoryId: 40 }, { productId: 5, shownCategoryId: 31 },
    ]));

    expect(result).toEqual({ outcome: "acknowledged", acknowledgedProductIds: [5], movedAgainProductIds: [12] });
    expect(client.params[client.indexOf("SELECT id AS product_id FROM catalog.products")]).toEqual([[12, 15]]);
    const ledger = client.indexOf("INSERT INTO dropship.dropship_product_listing_setting_requests");
    expect(client.params[ledger][5]).toBe(1);
    const payload = JSON.parse(String(client.params[client.indexOf("INSERT INTO dropship.dropship_audit_events")][5]));
    expect(payload).toMatchObject({
      acknowledgedCount: 1, movedAgain: [12], movedAgainCount: 1, notInCatalog: [15], notInCatalogCount: 1,
    });
  });

  it("does not read the catalog when every product was acknowledged", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[5, 31]]);

    const result = await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([{ productId: 5, shownCategoryId: 31 }]));

    expect(result).toEqual({ outcome: "acknowledged", acknowledgedProductIds: [5], movedAgainProductIds: [] });
    expect(client.indexOf("SELECT id AS product_id FROM catalog.products")).toBe(-1);
  });

  it("refuses a catalog read that returns a product it was not given", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[5, 41]]);
    const query = client.query.bind(client);
    client.query = async <T>(text: string, params: unknown[] = []) => (oneLine(text).startsWith("SELECT id AS product_id FROM catalog.products")
      ? rows<T>([{ product_id: 99 }])
      : query<T>(text, params));

    const error = await failure(acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([{ productId: 5, shownCategoryId: 31 }])));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.indexOf("INSERT INTO dropship.dropship_product_listing_setting_requests")).toBe(-1);
  });

  it("still records the request when nothing could be acknowledged, so its replay is exact", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[5, 41]]);

    const result = await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([{ productId: 5, shownCategoryId: 31 }]));

    expect(result).toEqual({ outcome: "acknowledged", acknowledgedProductIds: [], movedAgainProductIds: [5] });
    const ledger = client.indexOf("INSERT INTO dropship.dropship_product_listing_setting_requests");
    expect(client.params[ledger][5]).toBe(0);
  });

  it("names at most 100 products in each audit list, with the full counts", async () => {
    const client = new ScriptedClient();
    // 1-120 acknowledged, 121-250 moved again, 251-400 no longer in the catalog.
    const ids = Array.from({ length: 400 }, (_, index) => index + 1);
    client.catalog = new Map(ids.filter((id) => id <= 250).map((id) => [id, id <= 120 ? 31 : 41]));

    const result = await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE,
      acknowledgeInput(ids.map((productId) => ({ productId, shownCategoryId: 31 }))));

    expect(result.acknowledgedProductIds).toHaveLength(120);
    expect(result.movedAgainProductIds).toHaveLength(130);
    const payload = JSON.parse(String(client.params[client.indexOf("INSERT INTO dropship.dropship_audit_events")][5]));
    expect(payload.acknowledged).toHaveLength(100);
    expect(payload.acknowledgedCount).toBe(120);
    expect(payload.movedAgain).toEqual(ids.slice(120, 220));
    expect(payload.movedAgainCount).toBe(130);
    expect(payload.notInCatalog).toEqual(ids.slice(250, 350));
    expect(payload.notInCatalogCount).toBe(150);
  });

  it("replays a request by its key and writes nothing", async () => {
    const client = new ScriptedClient();
    client.ledger = ledgerRow();

    await expect(acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([{ productId: 5, shownCategoryId: 31 }])))
      .resolves.toEqual({ outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] });
    expect(client.sql).toHaveLength(1);
    expect(client.writes()).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["another request", { request_hash: OTHER_HASH }, "requestHash"],
    ["another store", { store_connection_id: 45 }, "storeConnectionId"],
    ["another operation", { operation: "product_settings_bulk" }, "operation"],
  ])("refuses the same key for %s", async (_label, overrides, mismatched) => {
    const client = new ScriptedClient();
    client.ledger = ledgerRow(overrides);

    const error = await failure(acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([{ productId: 5, shownCategoryId: 31 }])));

    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(error.context).toEqual({ mismatched: [mismatched], retryable: false, classification: "permanent" });
    expect(client.writes()).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["no items", []],
    ["10,001 items", Array.from({ length: 10_001 }, (_, index) => ({ productId: index + 1, shownCategoryId: null }))],
    ["a product twice", [{ productId: 5, shownCategoryId: 31 }, { productId: 5, shownCategoryId: 40 }]],
    ["a non-positive product id", [{ productId: 0, shownCategoryId: 31 }]],
    ["an unknown field", [{ productId: 5, shownCategoryId: 31, categoryName: "Sleeves" }]],
  ])("refuses %s before any SQL", async (_label, items) => {
    const client = new ScriptedClient();

    const error = await failure(acknowledgeCategoryMovesWithClient(asClient(client), SCOPE,
      acknowledgeInput(items as CategoryMovesAcknowledgeInput["items"])));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_BULK_INVALID");
    expect(error.context).toMatchObject({ retryable: false, classification: "permanent" });
    expect(client.sql).toEqual([]);
  });

  it("accepts exactly 10,000 items", async () => {
    const client = new ScriptedClient();
    const items = Array.from({ length: 10_000 }, (_, index) => ({ productId: index + 1, shownCategoryId: null }));
    client.catalog = new Map(items.map((item) => [item.productId, 31]));

    const result = await acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput(items));

    expect(result.movedAgainProductIds).toHaveLength(10_000);
    expect(client.writes()).toHaveLength(3);
  });

  it.each<[string, Partial<CategoryMovesAcknowledgeInput>, Partial<ListingSettingWriteScope>, string]>([
    ["a malformed request hash", { requestHash: "nope" }, {}, "requestHash"],
    ["an invalid clock reading", { now: new Date(Number.NaN) }, {}, "now"],
    ["a malformed request key", {}, { requestKey: "bad key!" }, "requestKey"],
  ])("refuses %s before any SQL", async (_label, inputOverrides, scopeOverrides, field) => {
    const client = new ScriptedClient();

    const error = await failure(acknowledgeCategoryMovesWithClient(asClient(client), { ...SCOPE, ...scopeOverrides },
      acknowledgeInput([{ productId: 5, shownCategoryId: 31 }], inputOverrides)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context?.invalid).toEqual([field]);
    expect(client.sql).toEqual([]);
  });

  it("refuses an upsert that returns a mark in another category than the one shown", async () => {
    const client = new ScriptedClient();
    client.upsertReturns = [{ product_id: 5, category_id: 40 }];

    const error = await failure(acknowledgeCategoryMovesWithClient(asClient(client), SCOPE, acknowledgeInput([{ productId: 5, shownCategoryId: 31 }])));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.indexOf("INSERT INTO dropship.dropship_product_listing_setting_requests")).toBe(-1);
  });

  it("never changes its inputs", async () => {
    const client = new ScriptedClient();
    client.catalog = new Map([[5, 31], [9, 40]]);
    const items = Object.freeze([Object.freeze({ productId: 9, shownCategoryId: 40 }), Object.freeze({ productId: 5, shownCategoryId: 31 })]);

    await acknowledgeCategoryMovesWithClient(asClient(client), Object.freeze({ ...SCOPE }), Object.freeze(acknowledgeInput(items)));

    expect(items.map((item) => item.productId)).toEqual([9, 5]);
  });
});
