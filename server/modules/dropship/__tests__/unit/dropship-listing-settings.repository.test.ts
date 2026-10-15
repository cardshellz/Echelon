import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import { categoryValuesToColumns } from "../../infrastructure/dropship-listing-setting-shared.repository";
import { readCatalogCategoriesByName } from "../../infrastructure/dropship-listing-setting-layers.reader";
import { readStoreListingTextBytesWithClient } from "../../infrastructure/dropship-listing-setting-writes.repository";
import {
  PgDropshipListingSettingsRepository,
  loadConversionInputsWithClient,
  loadListingSettingsInputsWithClient,
} from "../../infrastructure/dropship-listing-settings.repository";
import { COST_PLUS_10, COST_PLUS_40 } from "../fixtures/listing-rules-conversion.fixture";

/*
 * The listing-settings read load and the rules conversion's dry run load
 * (PR 11, plan 4.B.1, 4.B.4 "Loader"), against a scripted client: which
 * statements run, on which client, in which transaction. The rows are the
 * fewest the readers accept (a store with no chosen sizes), so what is
 * pinned is the statement order, the snapshot and the reads the conversion
 * adds; RSU runs the same loads against PostgreSQL.
 */

// The production pool is never reached: everything runs on the client each test hands over.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const VENDOR = 7;
const STORE = 5;
const MEMBER = "member-1";
const NOW = new Date("2026-10-15T09:30:00.000Z");
const SAVED_AT = new Date("2026-10-01T12:00:00.000Z");
const SNAPSHOT_BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

/** Statements that open, end or nest a transaction. */
const TRANSACTION_STATEMENT = /^\s*(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|SET\s+TRANSACTION)\b/i;
const READ_STATEMENT = /^\s*(SELECT|WITH)\b/i;
const ROW_LOCK = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
/** The views' owner read: the owner and the fingerprint of everything they read. */
const FINGERPRINT_READ = /^\s*WITH owner AS/;
/** The dry run's owner read: the owner alone (the dry run is never cached, so it reads no fingerprint). */
const OWNER_READ = /^SELECT v\.id AS vendor_id\s+FROM dropship\.dropship_vendors v\s+JOIN dropship\.dropship_store_connections sc/;
const NAMES_READ = /FROM catalog\.product_categories WHERE name = ANY/;
const CATEGORY_SETTINGS_READ = /JOIN dropship\.dropship_category_listing_setting_revisions r ON r\.id = s\.revision_id/;
const TEXT_BYTES_READ = /current_setting\('server_encoding'\)/;

interface Scenario {
  owner: boolean;
  platform: string;
  /** The stored pricing profile, or none. */
  pricingProfile: unknown;
  categoriesNamed: Array<{ id: unknown; name: unknown }>;
  categorySettings: Array<Record<string, unknown>>;
  textBytes: Record<string, unknown> | null;
  /** A statement that fails when it is sent. */
  failOn: RegExp | null;
  /** The error that statement fails with, so a test can tell it from any other; a "connection reset" when null. */
  failure: Error | null;
  /** The ROLLBACK fails too (a dropped connection). */
  rollbackFails: boolean;
}

/** Records every statement and its parameters, answers the store's few rows, and an empty result for every other read. */
class ScriptedClient {
  readonly statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  released = 0;
  constructor(private readonly scenario: Scenario) {}

  asPgClient(): Pick<PoolClient, "query"> {
    return this as unknown as Pick<PoolClient, "query">;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    this.statements.push({ sql, params });
    const scenario = this.scenario;
    if (scenario.failOn?.test(sql)) throw scenario.failure ?? new Error("connection reset");
    if (scenario.rollbackFails && /^ROLLBACK$/.test(sql)) throw new Error("rollback failed");
    if (TRANSACTION_STATEMENT.test(sql)) return { rows: [] };
    if (FINGERPRINT_READ.test(sql)) return { rows: scenario.owner ? [{ vendor_id: VENDOR, parts: [] }] : [] };
    if (OWNER_READ.test(sql)) return { rows: scenario.owner ? [{ vendor_id: VENDOR }] : [] };
    if (/INNER JOIN dropship\.dropship_store_connections sc ON sc\.vendor_id = v\.id/.test(sql)) {
      return { rows: [{ vendor_id: VENDOR, vendor_status: "active", entitlement_status: "active", store_connection_id: STORE,
        store_status: "connected", setup_status: "ready", platform: scenario.platform, access_token_ref: "a", refresh_token_ref: "r" }] };
    }
    if (/FROM dropship\.dropship_pricing_profiles p/.test(sql)) {
      return { rows: scenario.pricingProfile === null ? [] : [{ id: 41, profile: structuredClone(scenario.pricingProfile), created_at: SAVED_AT }] };
    }
    if (NAMES_READ.test(sql)) return { rows: structuredClone(scenario.categoriesNamed) };
    if (CATEGORY_SETTINGS_READ.test(sql)) return { rows: structuredClone(scenario.categorySettings) };
    if (TEXT_BYTES_READ.test(sql)) return { rows: scenario.textBytes === null ? [] : [structuredClone(scenario.textBytes)] };
    return { rows: [] };
  }

  /** The pool the repository connects through: this one client, once per load. */
  pool(): Pick<Pool, "query" | "connect"> {
    return {
      connect: async () => Object.assign(this.asPgClient(), { release: () => { this.released += 1; } }),
      query: async (): Promise<never> => { throw new Error("A load queried the pool instead of its snapshot's client."); },
    } as unknown as Pick<Pool, "query" | "connect">;
  }

  sql(): string[] {
    return this.statements.map((statement) => statement.sql);
  }
}

/** A store default and one category group on the Card Shellz category name "Sleeves". */
const SLEEVES_PROFILE = {
  defaultRecipe: COST_PLUS_10,
  groups: [{ id: "sleeves", name: "Sleeves rule", priority: 1, scope: { type: "category", category: "Sleeves" }, recipe: COST_PLUS_40 }],
};
const SLEEVES_12_ROW = { category_id: 12, revision_id: 812, created_at: SAVED_AT,
  ...categoryValuesToColumns({ ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, price: COST_PLUS_10 }) };

function scenario(patch: Partial<Scenario> = {}): Scenario {
  return {
    owner: true, platform: "ebay", pricingProfile: SLEEVES_PROFILE,
    // Two categories share the name (names are not unique); one is inactive in Card Shellz, which the read never asks.
    categoriesNamed: [{ id: 12, name: "Sleeves" }, { id: 14, name: "Sleeves" }],
    categorySettings: [SLEEVES_12_ROW],
    textBytes: { utf8: true, store_bytes: "1234", kept_store_bytes: "1234", target_bytes: "0" },
    failOn: null,
    failure: null,
    rollbackFails: false,
    ...patch,
  };
}

function reports() {
  return vi.fn<(input: { vendorId: number; storeConnectionId: number; variantCount: number; stage: string; sqlState: string | null }) => void>();
}

describe("loadListingSettingsInputsWithClient: the read model's core load (PR 11, plan 4.B.1)", () => {
  it("runs every read on the client it is given, opening, ending and locking nothing of its own", async () => {
    const client = new ScriptedClient(scenario());
    const report = reports();
    const load = await loadListingSettingsInputsWithClient(client.asPgClient(), { vendorId: VENDOR, storeConnectionId: STORE, now: NOW }, report);

    expect(load).toMatchObject({ state: "ok", costReadFailure: null, inputs: { candidates: [], store: { vendorId: VENDOR, platform: "ebay" },
      pricing: { revisionId: 41 } } });
    expect(client.statements.length).toBeGreaterThan(0);
    expect(client.sql().filter((sql) => TRANSACTION_STATEMENT.test(sql))).toEqual([]);
    expect(client.sql().filter((sql) => !READ_STATEMENT.test(sql) || ROW_LOCK.test(sql))).toEqual([]);
    // The owner was the caller's to resolve; the core never reads it, nor anything the conversion adds.
    expect(client.sql().some((sql) => FINGERPRINT_READ.test(sql) || OWNER_READ.test(sql) || NAMES_READ.test(sql) || TEXT_BYTES_READ.test(sql)))
      .toBe(false);
    // Every read is the vendor's and the store's.
    const storeRead = client.statements.find((statement) => /INNER JOIN dropship\.dropship_store_connections/.test(statement.sql));
    expect(storeRead?.params).toEqual([VENDOR, STORE]);
    expect(report).not.toHaveBeenCalled();
  });

  it("stops at the store's context for a store not on eBay", async () => {
    const client = new ScriptedClient(scenario({ platform: "shopify" }));
    const load = await loadListingSettingsInputsWithClient(client.asPgClient(), { vendorId: VENDOR, storeConnectionId: STORE, now: NOW }, reports());
    expect(load).toMatchObject({ state: "not_ebay", store: { platform: "shopify" } });
    expect(client.statements).toHaveLength(1);
  });

  it("gives the read model's load the same inputs, with the fingerprint read first in the same snapshot", async () => {
    const client = new ScriptedClient(scenario());
    const core = await loadListingSettingsInputsWithClient(new ScriptedClient(scenario()).asPgClient(),
      { vendorId: VENDOR, storeConnectionId: STORE, now: NOW }, reports());
    const load = await new PgDropshipListingSettingsRepository(client.pool()).load({ memberId: MEMBER, storeConnectionId: STORE, now: NOW });
    if (core.state !== "ok") throw new Error("The core did not load.");
    // The views keep only whether the costs were read (they cache nothing then).
    expect(load).toEqual({ state: "ok", inputs: core.inputs, costReadFailed: false, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(client.sql()[0]).toBe(SNAPSHOT_BEGIN);
    expect(client.sql()[1]).toMatch(FINGERPRINT_READ);
    expect(client.statements[1].params).toEqual([MEMBER, STORE]);
    expect(client.sql().at(-1)).toBe("COMMIT");
    expect(client.released).toBe(1);
  });
});

describe("PgDropshipListingSettingsRepository: the views' snapshot reads when a read fails (review DC-4)", () => {
  /** A read in the middle of the views' load (after the fingerprint) and the one product-own-settings read. */
  const PRICING_PROFILE_READ = /FROM dropship\.dropship_pricing_profiles p/;
  const PRODUCT_SETTINGS_READ = /FROM dropship\.dropship_product_listing_settings s\s+JOIN dropship\.dropship_product_listing_setting_revisions r/;
  type SnapshotRead = (repository: PgDropshipListingSettingsRepository) => Promise<unknown>;

  it.each<[string, RegExp, SnapshotRead]>([
    ["load (after its fingerprint)", PRICING_PROFILE_READ,
      (repository) => repository.load({ memberId: MEMBER, storeConnectionId: STORE, now: NOW })],
    ["readProductOwnSettings (its row read)", PRODUCT_SETTINGS_READ,
      (repository) => repository.readProductOwnSettings({ vendorId: VENDOR, storeConnectionId: STORE, productId: 8, productVariantIds: [81] })],
  ])("rolls back and releases its client once when a read in %s fails, keeping that read's own failure", async (_case, failOn, read) => {
    const failure = new Error("connection reset during the read");
    const client = new ScriptedClient(scenario({ failOn, failure }));
    await expect(read(new PgDropshipListingSettingsRepository(client.pool()))).rejects.toBe(failure);
    expect(client.sql()[0]).toBe(SNAPSHOT_BEGIN);
    expect(client.sql().filter((sql) => failOn.test(sql))).toHaveLength(1);
    expect(client.sql().filter((sql) => TRANSACTION_STATEMENT.test(sql))).toEqual([SNAPSHOT_BEGIN, "ROLLBACK"]);
    expect(client.sql().at(-1)).toBe("ROLLBACK");
    expect(client.released).toBe(1);
  });
});

describe("PgDropshipListingSettingsRepository.loadConversionInputs (PR 11, plan 4.B.1, D14, D23)", () => {
  let client: ScriptedClient;
  let report: ReturnType<typeof reports>;
  beforeEach(() => {
    report = reports();
  });

  async function loadConversion(patch: Partial<Scenario> = {}) {
    client = new ScriptedClient(scenario(patch));
    return new PgDropshipListingSettingsRepository(client.pool(), report)
      .loadConversionInputs({ memberId: MEMBER, storeConnectionId: STORE, now: NOW });
  }

  it("reads everything in one read-only snapshot on one client: owner, core, the named categories, their rows, the text bytes", async () => {
    const load = await loadConversion();

    const sql = client.sql();
    expect(sql.filter((statement) => statement === SNAPSHOT_BEGIN)).toHaveLength(1);
    expect(sql[0]).toBe(SNAPSHOT_BEGIN);
    expect(sql.at(-1)).toBe("COMMIT");
    expect(sql.filter((statement) => TRANSACTION_STATEMENT.test(statement))).toEqual([SNAPSHOT_BEGIN, "COMMIT"]);
    expect(sql.slice(1, -1).filter((statement) => !READ_STATEMENT.test(statement) || ROW_LOCK.test(statement))).toEqual([]);
    expect(client.released).toBe(1);
    // The owner by member, first, by the predicate the views' fingerprint uses but without its digests; then the core;
    // then the conversion's three reads, in order.
    expect(sql[1]).toMatch(OWNER_READ);
    expect(sql[1]).toMatch(/WHERE v\.member_id::text = \$1 AND sc\.id = \$2$/);
    expect(sql.some((statement) => FINGERPRINT_READ.test(statement) || /sha256/.test(statement))).toBe(false);
    expect(client.statements[1].params).toEqual([MEMBER, STORE]);
    const names = sql.findIndex((statement) => NAMES_READ.test(statement));
    const rows = sql.findIndex((statement) => CATEGORY_SETTINGS_READ.test(statement));
    const bytes = sql.findIndex((statement) => TEXT_BYTES_READ.test(statement));
    expect(names).toBeGreaterThan(sql.findIndex((statement) => /FROM dropship\.dropship_pricing_profiles p/.test(statement)));
    expect([names < rows, rows < bytes, bytes === sql.length - 2]).toEqual([true, true, true]);
    // Exact names, no `is_active` filter; every named category's row, chosen products or not; no product replaced in the bytes.
    expect(client.statements[names]).toEqual({
      sql: "SELECT id, name FROM catalog.product_categories WHERE name = ANY($1::text[]) ORDER BY id", params: [["Sleeves"]] });
    expect(client.statements[rows].params).toEqual([VENDOR, STORE, [12, 14]]);
    expect(client.statements[bytes].params).toEqual([VENDOR, STORE, [], false, false, false]);

    expect(load).toMatchObject({ state: "ok", costReadFailure: null });
    if (load?.state !== "ok") throw new Error("The conversion load did not load.");
    expect(load.inputs.listing).toMatchObject({ candidates: [], pricing: { revisionId: 41, profile: SLEEVES_PROFILE } });
    expect(load.inputs.categoriesByName).toEqual(new Map([["Sleeves", [{ id: 12, name: "Sleeves" }, { id: 14, name: "Sleeves" }]]]));
    expect([...load.inputs.categoryRows.keys()]).toEqual([12, 14]);
    expect(load.inputs.categoryRows.get(12)).toMatchObject({ categoryId: 12, revisionId: 812, storeConnectionId: STORE,
      values: { price: COST_PLUS_10 } });
    expect(load.inputs.categoryRows.get(14)).toBeNull();
    expect(load.inputs.storeTextBytes).toBe(1_234);
    expect(report).not.toHaveBeenCalled();
  });

  it("gives every name a key, an empty list when no category has it, and reads no settings rows then", async () => {
    const load = await loadConversion({ categoriesNamed: [], categorySettings: [] });
    if (load?.state !== "ok") throw new Error("The conversion load did not load.");
    expect(load.inputs.categoriesByName).toEqual(new Map([["Sleeves", []]]));
    expect(load.inputs.categoryRows).toEqual(new Map());
    expect(client.sql().some((statement) => CATEGORY_SETTINGS_READ.test(statement))).toBe(false);
  });

  it("asks no category name of a store whose rules name none, and still reads its text bytes", async () => {
    const load = await loadConversion({ pricingProfile: null });
    if (load?.state !== "ok") throw new Error("The conversion load did not load.");
    expect(load.inputs.categoriesByName).toEqual(new Map());
    expect(load.inputs.categoryRows).toEqual(new Map());
    expect(client.sql().some((statement) => NAMES_READ.test(statement) || CATEGORY_SETTINGS_READ.test(statement))).toBe(false);
    expect(load.inputs.storeTextBytes).toBe(1_234);
  });

  it("answers null for a store the member's vendor does not own, and a store not on eBay as such, reading nothing more", async () => {
    await expect(loadConversion({ owner: false })).resolves.toBeNull();
    expect(client.sql()).toEqual([SNAPSHOT_BEGIN, expect.stringMatching(OWNER_READ), "COMMIT"]);
    expect(client.released).toBe(1);

    await expect(loadConversion({ platform: "shopify" })).resolves.toEqual({ state: "not_ebay", store: expect.objectContaining({ platform: "shopify" }) });
    expect(client.sql().some((statement) => NAMES_READ.test(statement) || TEXT_BYTES_READ.test(statement))).toBe(false);
    expect(client.sql().at(-1)).toBe("COMMIT");
  });

  it.each([
    ["the names read", NAMES_READ],
    ["the category settings read", CATEGORY_SETTINGS_READ],
    ["the text bytes read", TEXT_BYTES_READ],
    ["the owner read", OWNER_READ],
  ])("rolls the snapshot back and releases its client once when %s fails, keeping the failure", async (_case, failOn) => {
    await expect(loadConversion({ failOn })).rejects.toThrow("connection reset");
    expect(client.sql().filter((statement) => TRANSACTION_STATEMENT.test(statement))).toEqual([SNAPSHOT_BEGIN, "ROLLBACK"]);
    expect(client.sql().at(-1)).toBe("ROLLBACK");
    expect(client.released).toBe(1);
  });

  it("rolls back and releases its client once when COMMIT itself fails, keeping COMMIT's own failure", async () => {
    const commitFailure = new Error("connection reset at COMMIT");
    await expect(loadConversion({ failOn: /^COMMIT$/, failure: commitFailure })).rejects.toBe(commitFailure);
    // Every read ran and the load was built; the snapshot's end failed, so it is rolled back and nothing is answered.
    expect(client.sql().some((statement) => TEXT_BYTES_READ.test(statement))).toBe(true);
    expect(client.sql().filter((statement) => TRANSACTION_STATEMENT.test(statement))).toEqual([SNAPSHOT_BEGIN, "COMMIT", "ROLLBACK"]);
    expect(client.sql().at(-1)).toBe("ROLLBACK");
    expect(client.released).toBe(1);
  });

  it("keeps the read's own failure when the rollback fails too", async () => {
    await expect(loadConversion({ failOn: TEXT_BYTES_READ, rollbackFails: true })).rejects.toThrow("connection reset");
    expect(client.sql().at(-1)).toBe("ROLLBACK");
    expect(client.released).toBe(1);
  });

  it("refuses a category the names read gives under a name it was not asked for (a loose collation), and rolls back", async () => {
    await expect(loadConversion({ categoriesNamed: [{ id: 12, name: "sleeves" }] }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(client.sql().at(-1)).toBe("ROLLBACK");
  });
});

describe("loadConversionInputsWithClient: the conversion's inputs on a caller's client, for the dry run and the apply (review DC-1)", () => {
  it("reads the core, the named categories, their rows and the text bytes on the client it is given, opening, ending and locking nothing", async () => {
    const client = new ScriptedClient(scenario());
    const report = reports();
    const load = await loadConversionInputsWithClient(client.asPgClient(), { vendorId: VENDOR, storeConnectionId: STORE, now: NOW }, report);

    expect(client.sql().filter((sql) => TRANSACTION_STATEMENT.test(sql))).toEqual([]);
    expect(client.sql().filter((sql) => !READ_STATEMENT.test(sql) || ROW_LOCK.test(sql))).toEqual([]);
    // The caller resolved the owner: no owner read of either kind.
    expect(client.sql().some((sql) => FINGERPRINT_READ.test(sql) || OWNER_READ.test(sql))).toBe(false);
    // The same composition as the dry run's snapshot: the same reads in the same order, and the same inputs.
    const viaSnapshot = new ScriptedClient(scenario());
    const snapshotLoad = await new PgDropshipListingSettingsRepository(viaSnapshot.pool(), reports())
      .loadConversionInputs({ memberId: MEMBER, storeConnectionId: STORE, now: NOW });
    expect(viaSnapshot.statements.slice(2, -1)).toEqual(client.statements);
    expect(load).toEqual(snapshotLoad);
    expect(report).not.toHaveBeenCalled();
  });

  it("passes a store not on eBay through with its context, reading none of the conversion's own reads", async () => {
    const client = new ScriptedClient(scenario({ platform: "shopify" }));
    await expect(loadConversionInputsWithClient(client.asPgClient(), { vendorId: VENDOR, storeConnectionId: STORE, now: NOW }, reports()))
      .resolves.toEqual({ state: "not_ebay", store: expect.objectContaining({ platform: "shopify" }) });
    expect(client.statements).toHaveLength(1);
  });
});

describe("readCatalogCategoriesByName (PR 11, plan D8, 4.B.1)", () => {
  function namesClient(rows: Array<{ id: unknown; name: unknown }>) {
    const sent: Array<{ sql: string; params: readonly unknown[] }> = [];
    return { sent, client: { query: async (sql: string, params: readonly unknown[]) => { sent.push({ sql, params }); return { rows }; } } as
      unknown as Pick<PoolClient, "query"> };
  }

  it("makes no query for no names", async () => {
    const { sent, client } = namesClient([]);
    await expect(readCatalogCategoriesByName(client, [])).resolves.toEqual(new Map());
    expect(sent).toEqual([]);
  });

  it("asks each exact name once, in code-unit order, and keys every name asked, by id within each", async () => {
    const { sent, client } = namesClient([{ id: 3, name: "Sleeves" }, { id: 9, name: "Sleeves" }, { id: 11, name: "binders" }]);
    const byName = await readCatalogCategoriesByName(client, ["Sleeves", "binders", "Sleeves", "Binders", " Sleeves"]);
    expect(sent).toEqual([{ sql: "SELECT id, name FROM catalog.product_categories WHERE name = ANY($1::text[]) ORDER BY id",
      params: [[" Sleeves", "Binders", "Sleeves", "binders"]] }]);
    expect(sent[0].sql).not.toMatch(/is_active/);
    expect(byName).toEqual(new Map([
      [" Sleeves", []], ["Binders", []], ["Sleeves", [{ id: 3, name: "Sleeves" }, { id: 9, name: "Sleeves" }]], ["binders", [{ id: 11, name: "binders" }]],
    ]));
  });

  it.each([
    ["a name that was not asked for", [{ id: 3, name: "SLEEVES" }]],
    ["a name that is not text", [{ id: 3, name: null }]],
    ["an id of 0", [{ id: 0, name: "Sleeves" }]],
    ["an id past int4", [{ id: 2_147_483_648, name: "Sleeves" }]],
    ["an id that is not a number", [{ id: "x", name: "Sleeves" }]],
  ])("refuses %s as a broken read", async (_case, rows) => {
    const { client } = namesClient(rows);
    await expect(readCatalogCategoriesByName(client, ["Sleeves"])).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
  });

  it("refuses a blank or non-text name before asking", async () => {
    for (const names of [[""], ["  "], [null as unknown as string]]) {
      const { sent, client } = namesClient([]);
      await expect(readCatalogCategoriesByName(client, names)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
      expect(sent).toEqual([]);
    }
  });
});

describe("readStoreListingTextBytesWithClient (PR 11, plan 4.B.1, D9c)", () => {
  function bytesClient(row: Record<string, unknown> | null) {
    const sent: Array<{ sql: string; params: readonly unknown[] }> = [];
    return { sent, client: { query: async (sql: string, params: readonly unknown[]) => {
      sent.push({ sql, params });
      return { rows: row === null ? [] : [row] };
    } } as unknown as Pick<PoolClient, "query"> };
  }

  it("reads the store's saved product text with the store text cap's statement, no product replaced, on the given client", async () => {
    const { sent, client } = bytesClient({ utf8: true, store_bytes: "40960", kept_store_bytes: "40960", target_bytes: "0" });
    await expect(readStoreListingTextBytesWithClient(client, { vendorId: VENDOR, storeConnectionId: STORE })).resolves.toBe(40_960);
    expect(sent).toHaveLength(1);
    expect(sent[0].params).toEqual([VENDOR, STORE, [], false, false, false]);
    expect(sent[0].sql).toMatch(/current_setting\('server_encoding'\) = 'UTF8' AS utf8/);
    expect(sent[0].sql).toMatch(/AS store_bytes/);
    expect(sent[0].sql).toMatch(/FROM dropship\.dropship_product_listing_settings s\s+JOIN dropship\.dropship_product_listing_setting_revisions r/);
    expect(sent[0].sql).not.toMatch(ROW_LOCK);
  });

  it.each([
    ["a database that is not UTF8", { utf8: false, store_bytes: "1", kept_store_bytes: "1", target_bytes: "0" }],
    ["no answer row", null],
    ["a negative sum", { utf8: true, store_bytes: "-1", kept_store_bytes: "0", target_bytes: "0" }],
    ["a fractional sum", { utf8: true, store_bytes: "1.5", kept_store_bytes: "0", target_bytes: "0" }],
    ["a sum sent as a number", { utf8: true, store_bytes: 12, kept_store_bytes: "0", target_bytes: "0" }],
  ])("refuses %s as a broken read, never a guess", async (_case, row) => {
    const { client } = bytesClient(row);
    await expect(readStoreListingTextBytesWithClient(client, { vendorId: VENDOR, storeConnectionId: STORE }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
  });
});
