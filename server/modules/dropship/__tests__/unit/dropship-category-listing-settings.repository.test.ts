import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type {
  CategoryListingSettingPatch,
  CategoryListingSettingValues,
} from "../../../../../shared/dropship/listing-setting-values";
import type { CategoryListingSettingSaveInput } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import {
  listingSettingsCategoryNotFound,
  readCategoryListingSettings,
  saveCategoryListingSettingWithClient,
} from "../../infrastructure/dropship-category-listing-settings.repository";
import {
  CATEGORY_LISTING_SETTING_VALUE_COLUMNS,
  categoryValuesToColumns,
  type ListingSettingWriteScope,
} from "../../infrastructure/dropship-listing-setting-shared.repository";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const EARLIER = new Date("2026-10-01T08:30:00.000Z");
const KEY = "listing-settings:3b8f6a52-1f0e-4c5a-9a77-2d4c6e8f0a1b";
const HASH = "c".repeat(64);
const OTHER_HASH = "d".repeat(64);
const VENDOR_ID = 10;
const STORE_ID = 44;
const CATEGORY_ID = 31;

const SCOPE: ListingSettingWriteScope = {
  vendorId: VENDOR_ID, storeConnectionId: STORE_ID, actor: { actorType: "vendor", actorId: "member-1" }, requestKey: KEY,
};

const SLEEVES: CategoryListingSettingValues = {
  price: { basis: "product_cost", markupBps: 2_500, flatCents: 99, rounding: "up_99" },
  ebayCategory: { categoryId: "183454", categoryName: "Card Sleeves", path: ["Collectibles", "Card Sleeves"] },
  storeShelf: { mode: "own", shelves: [{ id: "202", name: "Sleeves:Standard" }] },
  shippingPolicy: { id: "6200000001", name: "Free shipping" },
  returnPolicy: null,
  paymentPolicy: null,
  textAbove: { mode: "own", text: "Ships in 1 day." },
  textBelow: { mode: "none" },
};

/** What PostgreSQL hands back for a stored revision: jsonb arrays parsed again, timestamps as Dates. */
function storedColumns(values: CategoryListingSettingValues): Record<string, unknown> {
  return JSON.parse(JSON.stringify(categoryValuesToColumns(values))) as Record<string, unknown>;
}

function currentRow(revisionId: number, values: CategoryListingSettingValues, categoryId = CATEGORY_ID): Record<string, unknown> {
  return { category_id: categoryId, revision_id: revisionId, ...storedColumns(values), created_at: EARLIER };
}

function storedRevision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revision_id: 9, store_connection_id: STORE_ID, category_id: CATEGORY_ID, category_name: "Card Sleeves (old name)",
    request_hash: HASH, ...storedColumns(SLEEVES), created_at: EARLIER, ...overrides,
  };
}

const oneLine = (sql: string) => sql.replace(/\s+/g, " ").trim();

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  replay: Record<string, unknown> | null = null;
  category: Record<string, unknown> | null = { id: CATEGORY_ID, name: "Card Sleeves" };
  current: Record<string, unknown>[] = [];
  insertedRevisionId: unknown = 12;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = oneLine(text);
    this.sql.push(sql);
    this.params.push(params);
    if (sql.startsWith("SELECT r.id AS revision_id")) return rows<T>(this.replay ? [this.replay] : []);
    if (sql.startsWith("SELECT id, name FROM catalog.product_categories")) return rows<T>(this.category ? [this.category] : []);
    if (sql.startsWith("SELECT s.category_id")) return rows<T>(this.current);
    if (sql.startsWith("INSERT INTO dropship.dropship_category_listing_setting_revisions")) {
      return rows<T>([{ id: this.insertedRevisionId }]);
    }
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

function saveInput(patch: CategoryListingSettingPatch, overrides: Partial<CategoryListingSettingSaveInput> = {}): CategoryListingSettingSaveInput {
  return { categoryId: CATEGORY_ID, expectedRevisionId: null, patch, requestHash: HASH, now: NOW, ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

/** The 0737 revision columns in table order, the generated identity left out. */
function migrationRevisionColumns(): string[] {
  const sql = readFileSync(resolve(process.cwd(), "migrations/0737_dropship_category_listing_settings.sql"), "utf8");
  const body = /CREATE TABLE IF NOT EXISTS dropship\.dropship_category_listing_setting_revisions \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
  return body.split("\n").map((line) => /^\s+([a-z_]+) (integer|bigint|varchar|text|jsonb|timestamptz)\b/.exec(line)?.[1])
    .filter((column): column is string => column !== undefined && column !== "id");
}

describe("readCategoryListingSettings", () => {
  it("reads nothing for no ids", async () => {
    const client = new ScriptedClient();
    await expect(readCategoryListingSettings(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, categoryIds: [] }))
      .resolves.toEqual(new Map());
    expect(client.sql).toEqual([]);
  });

  it("joins each current row to its own revision, distinct ids ascending, and takes no lock unless asked", async () => {
    const client = new ScriptedClient();
    client.current = [currentRow(7, SLEEVES, 31), currentRow(3, EMPTY_CATEGORY_LISTING_SETTING_VALUES, 40)];

    const settings = await readCategoryListingSettings(asClient(client), {
      vendorId: VENDOR_ID, storeConnectionId: STORE_ID, categoryIds: [40, 31, 40],
    });

    expect([...settings.keys()]).toEqual([31, 40]);
    expect(settings.get(31)).toEqual({
      storeConnectionId: STORE_ID, categoryId: 31, revisionId: 7, updatedAt: EARLIER.toISOString(), values: SLEEVES,
    });
    expect(settings.get(40)?.values).toEqual(EMPTY_CATEGORY_LISTING_SETTING_VALUES);
    expect(client.params[0]).toEqual([VENDOR_ID, STORE_ID, [31, 40]]);
    expect(client.sql[0]).toContain("FROM dropship.dropship_category_listing_settings s "
      + "JOIN dropship.dropship_category_listing_setting_revisions r ON r.id = s.revision_id "
      + "AND r.vendor_id = s.vendor_id AND r.store_connection_id = s.store_connection_id AND r.category_id = s.category_id "
      + "WHERE s.vendor_id = $1 AND s.store_connection_id = $2 AND s.category_id = ANY($3::int[]) ORDER BY s.category_id");
    for (const column of CATEGORY_LISTING_SETTING_VALUE_COLUMNS) expect(client.sql[0]).toContain(`r.${column}`);
    expect(client.sql[0]).not.toMatch(/\bFOR (UPDATE|SHARE)\b/);
    expect(client.sql[0]).not.toContain("body_");
  });

  it("locks only the settings rows when asked", async () => {
    const client = new ScriptedClient();
    await readCategoryListingSettings(asClient(client), { vendorId: VENDOR_ID, storeConnectionId: STORE_ID, categoryIds: [31], forUpdate: true });
    expect(client.sql[0]).toMatch(/ORDER BY s\.category_id FOR UPDATE OF s$/);
  });

  it("refuses a stored row with a partial value group, naming the row and never its text", async () => {
    const client = new ScriptedClient();
    client.current = [{ ...currentRow(7, SLEEVES), text_above: null }];

    const error = await failure(readCategoryListingSettings(asClient(client), {
      vendorId: VENDOR_ID, storeConnectionId: STORE_ID, categoryIds: [CATEGORY_ID],
    }));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ group: "textAbove", categoryId: "31", revisionId: "7", classification: "fatal" });
    expect(JSON.stringify(error.context)).not.toContain("Ships in 1 day.");
  });

  it.each([[0], [-1], [1.5], [2_147_483_648], [Number.NaN]])("refuses id %s before any SQL", async (id) => {
    const client = new ScriptedClient();
    const error = await failure(readCategoryListingSettings(asClient(client), {
      vendorId: VENDOR_ID, storeConnectionId: STORE_ID, categoryIds: [CATEGORY_ID, id],
    }));
    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.sql).toEqual([]);
  });
});

describe("saveCategoryListingSettingWithClient", () => {
  it("writes a first save: replay check, catalog name, locked current row, then revision, current row and audit", async () => {
    const client = new ScriptedClient();

    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ ...SLEEVES }));

    expect(client.sql.map((sql) => sql.split(" ").slice(0, 4).join(" "))).toEqual([
      "SELECT r.id AS revision_id,",
      "SELECT id, name FROM",
      "SELECT s.category_id, s.revision_id, r.price_basis,",
      "INSERT INTO dropship.dropship_category_listing_setting_revisions (vendor_id,",
      "INSERT INTO dropship.dropship_category_listing_settings (vendor_id,",
      "INSERT INTO dropship.dropship_audit_events (vendor_id,",
    ]);
    // Replay by the transaction's own key; the catalog row is FOR SHARE-locked by lockCatalog, so no lock text here.
    expect(client.params[0]).toEqual([VENDOR_ID, KEY]);
    expect(client.sql[0]).toContain("FROM dropship.dropship_category_listing_setting_revisions r WHERE r.vendor_id = $1 AND r.idempotency_key = $2");
    expect(client.sql[1]).toBe("SELECT id, name FROM catalog.product_categories WHERE id = $1");
    expect(client.params[1]).toEqual([CATEGORY_ID]);
    expect(client.sql[2]).toMatch(/FOR UPDATE OF s$/);
    expect(client.params[2]).toEqual([VENDOR_ID, STORE_ID, [CATEGORY_ID]]);

    expect(result).toEqual({
      outcome: "changed",
      row: { storeConnectionId: STORE_ID, categoryId: CATEGORY_ID, revisionId: 12, updatedAt: NOW.toISOString(), values: SLEEVES },
      before: null,
      changedFields: ["price", "ebayCategory", "storeShelf", "shippingPolicy", "textAbove", "textBelow"],
      categoryName: "Card Sleeves",
    });
  });

  it("stores the category name read at save, every value column once, and SQL NULL (never JSON null) for an unset jsonb value", async () => {
    const client = new ScriptedClient();
    await saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ ...SLEEVES, storeShelf: { mode: "none" } }));

    const index = client.indexOf("INSERT INTO dropship.dropship_category_listing_setting_revisions");
    const columns = /^INSERT INTO [\w.]+ \(([^)]*)\)/.exec(client.sql[index])?.[1]?.split(", ");
    expect(columns).toEqual(migrationRevisionColumns());
    expect(client.sql[index]).toContain("$12::jsonb, $13, $14::jsonb, $15::jsonb, $16,");
    expect(client.sql[index]).toMatch(/RETURNING id$/);
    expect(client.params[index]).toEqual([
      VENDOR_ID, STORE_ID, CATEGORY_ID, "Card Sleeves", null,
      "product_cost", 2_500, 99, "up_99",
      "183454", "Card Sleeves", JSON.stringify(["Collectibles", "Card Sleeves"]),
      "none", null, null,
      "6200000001", "Free shipping", null, null, null, null,
      "own", "Ships in 1 day.", "none", null,
      KEY, HASH, "vendor", "member-1", NOW,
    ]);
  });

  it("chains a change onto the current revision and audits only what the vendor changed, with the category name", async () => {
    const client = new ScriptedClient();
    client.current = [currentRow(7, SLEEVES)];
    const recipe = { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } as const;

    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput({ price: recipe, shippingPolicy: { ...SLEEVES.shippingPolicy! } }, { expectedRevisionId: 7 }));

    expect(result.outcome).toBe("changed");
    expect(result.changedFields).toEqual(["price"]);
    expect(result.before).toEqual({ storeConnectionId: STORE_ID, categoryId: CATEGORY_ID, revisionId: 7, updatedAt: EARLIER.toISOString(), values: SLEEVES });
    expect(result.row?.values).toEqual({ ...SLEEVES, price: recipe });
    const revision = client.params[client.indexOf("INSERT INTO dropship.dropship_category_listing_setting_revisions")];
    expect(revision.slice(0, 9)).toEqual([VENDOR_ID, STORE_ID, CATEGORY_ID, "Card Sleeves", 7, "catalog_retail", 0, 0, "cent"]);

    const upsert = client.indexOf("INSERT INTO dropship.dropship_category_listing_settings");
    expect(client.sql[upsert]).toBe("INSERT INTO dropship.dropship_category_listing_settings (vendor_id, store_connection_id, category_id, revision_id) "
      + "VALUES ($1, $2, $3, $4) ON CONFLICT (store_connection_id, category_id) DO UPDATE SET revision_id = EXCLUDED.revision_id");
    expect(client.params[upsert]).toEqual([VENDOR_ID, STORE_ID, CATEGORY_ID, 12]);

    const audit = client.indexOf("INSERT INTO dropship.dropship_audit_events");
    expect(client.sql[audit]).toContain("VALUES ($1, $2, 'dropship_category_listing_setting', $3, 'category_listing_settings_saved', $4, $5, 'info', $6::jsonb, $7)");
    expect(client.params[audit].slice(0, 5)).toEqual([VENDOR_ID, STORE_ID, String(CATEGORY_ID), "vendor", "member-1"]);
    expect(client.params[audit][6]).toBe(NOW);
    expect(JSON.parse(String(client.params[audit][5]))).toEqual({
      requestKey: KEY, revisionId: 12, previousRevisionId: 7, categoryName: "Card Sleeves",
      before: SLEEVES, after: { ...SLEEVES, price: recipe }, changedFields: ["price"],
    });
  });

  it("clears a setting back to the store default with a new revision, never a delete", async () => {
    const client = new ScriptedClient();
    client.current = [currentRow(7, SLEEVES)];

    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput({ ebayCategory: null, textAbove: null }, { expectedRevisionId: 7 }));

    expect(result.changedFields).toEqual(["ebayCategory", "textAbove"]);
    const revision = client.params[client.indexOf("INSERT INTO dropship.dropship_category_listing_setting_revisions")];
    expect(revision.slice(9, 12)).toEqual([null, null, null]);
    expect(revision.slice(21, 23)).toEqual([null, null]);
    expect(client.writes().every((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
  });

  it("stores own text normalized as the stored contract says", async () => {
    const client = new ScriptedClient();
    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput({ textBelow: { mode: "own", text: "  Thanks for buying.\r\nSee you soon.  " } }));

    expect(result.row?.values.textBelow).toEqual({ mode: "own", text: "Thanks for buying.\nSee you soon." });
    const revision = client.params[client.indexOf("INSERT INTO dropship.dropship_category_listing_setting_revisions")];
    expect(revision.slice(23, 25)).toEqual(["own", "Thanks for buying.\nSee you soon."]);
  });

  it("refuses a missing Card Shellz category before any write", async () => {
    const client = new ScriptedClient();
    client.category = null;

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ ...SLEEVES })));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_CATEGORY_NOT_FOUND");
    expect(error.context).toEqual({ categoryId: CATEGORY_ID, retryable: false, classification: "permanent" });
    expect(client.writes()).toEqual([]);
    expect(listingSettingsCategoryNotFound().context).toEqual({ retryable: false, classification: "permanent" });
  });

  it("refuses a blank Card Shellz category name instead of letting the name CHECK raise", async () => {
    const client = new ScriptedClient();
    client.category = { id: CATEGORY_ID, name: "   " };

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ ...SLEEVES })));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context).toMatchObject({ categoryId: CATEGORY_ID, classification: "fatal" });
    expect(client.writes()).toEqual([]);
  });

  it.each<[string, number | null, Record<string, unknown>[], number | null]>([
    ["a stale revision", 6, [currentRow(7, SLEEVES)], 7],
    ["a first save when a row already exists", null, [currentRow(7, SLEEVES)], 7],
    ["an expected revision when no row exists", 7, [], null],
  ])("refuses %s before any write (compare and set)", async (_label, expectedRevisionId, current, actualRevisionId) => {
    const client = new ScriptedClient();
    client.current = current;

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput({ price: null }, { expectedRevisionId })));

    expect(error.code).toBe("DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT");
    expect(error.context).toEqual({
      categoryId: CATEGORY_ID, expectedRevisionId, actualRevisionId, retryable: false, classification: "permanent",
    });
    expect(client.writes()).toEqual([]);
  });

  it("writes nothing for a change that sets what is already stored", async () => {
    const client = new ScriptedClient();
    client.current = [currentRow(7, SLEEVES)];

    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput({ storeShelf: { mode: "own", shelves: [{ id: "202", name: "Sleeves:Standard" }] }, returnPolicy: null }, { expectedRevisionId: 7 }));

    expect(result).toEqual({
      outcome: "unchanged", row: result.before, before: expect.objectContaining({ revisionId: 7, values: SLEEVES }),
      changedFields: [], categoryName: "Card Sleeves",
    });
    expect(client.writes()).toEqual([]);
  });

  it("writes nothing for a first save that only follows the store default", async () => {
    const client = new ScriptedClient();

    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ price: null, textAbove: null }));

    expect(result).toEqual({ outcome: "unchanged", row: null, before: null, changedFields: [], categoryName: "Card Sleeves" });
    expect(client.writes()).toEqual([]);
  });

  it("replays the revision its key wrote, with the name stored then, and reads or writes nothing else", async () => {
    const client = new ScriptedClient();
    client.replay = storedRevision();

    const result = await saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput({ price: null }, { expectedRevisionId: 3 }));

    expect(result).toEqual({
      outcome: "replayed",
      row: { storeConnectionId: STORE_ID, categoryId: CATEGORY_ID, revisionId: 9, updatedAt: EARLIER.toISOString(), values: SLEEVES },
      before: null, changedFields: [], categoryName: "Card Sleeves (old name)",
    });
    expect(client.sql).toHaveLength(1);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["another request", { request_hash: OTHER_HASH }, "requestHash"],
    ["another store", { store_connection_id: 45 }, "storeConnectionId"],
    ["another category", { category_id: 32 }, "categoryId"],
  ])("refuses the same key for %s", async (_label, overrides, mismatched) => {
    const client = new ScriptedClient();
    client.replay = storedRevision(overrides);

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ price: null })));

    expect(error.code).toBe("DROPSHIP_IDEMPOTENCY_CONFLICT");
    expect(error.context).toEqual({ mismatched: [mismatched], retryable: false, classification: "permanent" });
    expect(client.sql).toHaveLength(1);
  });

  it.each<[string, unknown]>([
    ["an empty change", {}],
    ["the main text, which is product only", { mainText: null }],
    ["an unknown setting", { body: null }],
    ["a partial recipe", { price: { basis: "product_cost", markupBps: 100 } }],
    ["blank own text", { textAbove: { mode: "own", text: "   " } }],
    ["three shelves", { storeShelf: { mode: "own", shelves: [{ id: "1", name: "A" }, { id: "2", name: "B" }, { id: "3", name: "C" }] } }],
  ])("refuses %s before any SQL", async (_label, patch) => {
    const client = new ScriptedClient();

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), SCOPE,
      saveInput(patch as CategoryListingSettingPatch)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context?.classification).toBe("fatal");
    expect(client.sql).toEqual([]);
  });

  it.each<[string, Partial<CategoryListingSettingSaveInput>, Partial<ListingSettingWriteScope>, string]>([
    ["a malformed request hash", { requestHash: "C".repeat(64) }, {}, "requestHash"],
    ["a non-positive category id", { categoryId: 0 }, {}, "categoryId"],
    ["a non-integer expected revision", { expectedRevisionId: 1.5 }, {}, "expectedRevisionId"],
    ["an invalid clock reading", { now: new Date(Number.NaN) }, {}, "now"],
    ["a malformed request key", {}, { requestKey: "short" }, "requestKey"],
    ["a blank actor", {}, { actor: { actorType: "vendor", actorId: " " } }, "actorId"],
  ])("refuses %s before any SQL", async (_label, inputOverrides, scopeOverrides, field) => {
    const client = new ScriptedClient();

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), { ...SCOPE, ...scopeOverrides },
      saveInput({ price: null }, inputOverrides)));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(error.context?.invalid).toEqual([field]);
    expect(client.sql).toEqual([]);
  });

  it("never changes its inputs", async () => {
    const client = new ScriptedClient();
    client.current = [currentRow(7, SLEEVES)];
    const patch = Object.freeze({ textAbove: Object.freeze({ mode: "own", text: " New words " }) }) as CategoryListingSettingPatch;
    const input = Object.freeze(saveInput(patch, { expectedRevisionId: 7 }));

    await saveCategoryListingSettingWithClient(asClient(client), Object.freeze({ ...SCOPE }), input);

    expect(input.patch).toEqual({ textAbove: { mode: "own", text: " New words " } });
  });

  it("refuses a revision insert that returns no identity", async () => {
    const client = new ScriptedClient();
    client.insertedRevisionId = undefined;

    const error = await failure(saveCategoryListingSettingWithClient(asClient(client), SCOPE, saveInput({ ...SLEEVES })));

    expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect(client.writes()).toHaveLength(1);
  });
});
