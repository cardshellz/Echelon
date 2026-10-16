import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingRulesConversionTransaction } from "../../application/dropship-listing-rules-conversion-service";
import { DropshipError } from "../../domain/errors";
import { listingConversionChildKey } from "../../domain/listing-setting-values";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import {
  CATEGORY_LOCK_SQL,
  LISTING_SELECTION_LOCK_SQL,
  PRODUCT_LOCK_SQL,
  REQUEST_LOCK_SQL,
  STORE_LOCK_SQL,
  SYSTEM_OWNER_SQL,
  VARIANT_LOCK_SQL,
  VENDOR_OWNER_SQL,
} from "../../infrastructure/dropship-listing-setting-writes.repository";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

type QueryClient = Pick<PoolClient, "query">;

/**
 * The rules conversion's transaction (plan 7.B.3, 7.B.4 "DI repository"; the
 * WRT pattern). Every reader and writer behind it is mocked: their SQL is
 * pinned by their own tests and the PostgreSQL suite. Each mock writes one
 * marker statement through the client it was given, so the order of the
 * transaction's statements, and that each got the transaction's own
 * connection, are visible here; each records what it was called with, so the
 * actor, the actor type and the keys on every row are too.
 */
const mocks = vi.hoisted(() => {
  const marker = (name: string, result: unknown) => async (client: { query: (sql: string) => Promise<unknown> }) => {
    await client.query(`-- ${name}`);
    return typeof result === "function" ? (result as () => unknown)() : result;
  };
  return {
    marker,
    insertRuleConversionWithClient: vi.fn(),
    findRuleConversionByKeyWithClient: vi.fn(),
    hasRuleConversionWithClient: vi.fn(),
    saveCategoryListingSettingWithClient: vi.fn(),
    saveProductListingSettingsPerProductWithClient: vi.fn(),
    savePricingProfileWithClient: vi.fn(),
    saveContentProfileWithClient: vi.fn(),
    saveEbayCategoryRulesProfileWithClient: vi.fn(),
    insertFirstCategoryMarksWithClient: vi.fn(),
    readPricingProfile: vi.fn(),
    readContentProfile: vi.fn(),
    readEbayCategoryRules: vi.fn(),
    readCatalogCategoriesByName: vi.fn(),
    loadSelectedCandidates: vi.fn(),
    loadConversionInputsWithClient: vi.fn(),
  };
});

vi.mock("../../infrastructure/dropship-listing-rule-conversions.writer", () => ({
  insertRuleConversionWithClient: mocks.insertRuleConversionWithClient,
  findRuleConversionByKeyWithClient: mocks.findRuleConversionByKeyWithClient,
  hasRuleConversionWithClient: mocks.hasRuleConversionWithClient,
}));
vi.mock("../../infrastructure/dropship-category-listing-settings.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-category-listing-settings.repository")>()),
  saveCategoryListingSettingWithClient: mocks.saveCategoryListingSettingWithClient,
}));
vi.mock("../../infrastructure/dropship-product-listing-settings.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-product-listing-settings.repository")>()),
  saveProductListingSettingsPerProductWithClient: mocks.saveProductListingSettingsPerProductWithClient,
}));
vi.mock("../../infrastructure/dropship-pricing-profile.writer", () => ({ savePricingProfileWithClient: mocks.savePricingProfileWithClient }));
vi.mock("../../infrastructure/dropship-listing-content.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-listing-content.repository")>()),
  saveContentProfileWithClient: mocks.saveContentProfileWithClient,
}));
vi.mock("../../infrastructure/dropship-ebay-category-rules.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-ebay-category-rules.repository")>()),
  saveEbayCategoryRulesProfileWithClient: mocks.saveEbayCategoryRulesProfileWithClient,
}));
vi.mock("../../infrastructure/dropship-product-category-marks.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-product-category-marks.repository")>()),
  insertFirstCategoryMarksWithClient: mocks.insertFirstCategoryMarksWithClient,
}));
vi.mock("../../infrastructure/dropship-pricing-profile.reader", () => ({ readPricingProfile: mocks.readPricingProfile }));
vi.mock("../../infrastructure/dropship-listing-content.reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-listing-content.reader")>()),
  readContentProfile: mocks.readContentProfile,
}));
vi.mock("../../infrastructure/dropship-ebay-category-rules.reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-ebay-category-rules.reader")>()),
  readEbayCategoryRules: mocks.readEbayCategoryRules,
}));
vi.mock("../../infrastructure/dropship-listing-setting-layers.reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-listing-setting-layers.reader")>()),
  readCatalogCategoriesByName: mocks.readCatalogCategoriesByName,
}));
vi.mock("../../application/dropship-selected-catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../application/dropship-selected-catalog")>()),
  loadSelectedCandidates: mocks.loadSelectedCandidates,
}));
vi.mock("../../infrastructure/dropship-listing-settings.repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infrastructure/dropship-listing-settings.repository")>()),
  loadConversionInputsWithClient: mocks.loadConversionInputsWithClient,
}));

import { PgDropshipListingRulesConversionRepository } from "../../infrastructure/dropship-listing-rules-conversion.repository";

const NOW = new Date("2026-10-15T09:00:00.000Z");
const MEMBER = "member-1";
const VENDOR = 10;
const STORE = 22;
const KEY = "ls-convert:7f9c2ba4-e88f-4a5e-9d1b-1c2d3e4f5a6b";
const JOB = "rules-conversion:2026-10-15T09";
const SYSTEM_KEY = "rules-conversion:22";
const HASH = "a".repeat(64);
const VENDOR_INPUT = { actorType: "vendor" as const, memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY };
const SYSTEM_INPUT = { actorType: "system" as const, jobKey: JOB, storeConnectionId: STORE };
const RECORD = { id: 9_001 };
const INPUTS_SENTINEL = { sentinel: "the planner's inputs" };

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  release = vi.fn();
  ownerFound = true;
  failRollback = false;
  /** A statement (by its exact text) that fails with this error. */
  failOn: { sql: string; error: unknown } | null = null;
  /** The catalog rows that exist; lockCatalog finds only these. */
  existing = { categories: new Set([12, 13]), products: new Set([1, 2]), variants: new Set([101, 201]) };

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = flat(text);
    this.sql.push(sql);
    this.params.push(params);
    if (this.failOn && sql === flat(this.failOn.sql)) throw this.failOn.error;
    if (sql === "ROLLBACK" && this.failRollback) throw new Error("connection lost during rollback");
    if (sql === flat(VENDOR_OWNER_SQL) || sql === flat(SYSTEM_OWNER_SQL)) return rows<T>(this.ownerFound ? [{ vendor_id: VENDOR }] : []);
    const found = (set: Set<number>) => rows<T>((params[0] as number[]).filter((id) => set.has(id)).map((id) => ({ id })));
    if (sql === flat(CATEGORY_LOCK_SQL)) return found(this.existing.categories);
    if (sql === flat(PRODUCT_LOCK_SQL)) return found(this.existing.products);
    if (sql === flat(VARIANT_LOCK_SQL)) return found(this.existing.variants);
    return rows<T>([]);
  }

  /** Statements after BEGIN, the locks and the owner read. */
  afterOwner(): string[] {
    return this.sql.slice(this.sql.findIndex((sql) => sql.endsWith("FOR SHARE OF v, sc")) + 1);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function setup(report = vi.fn()) {
  const client = new ScriptedClient();
  const connect = vi.fn(async () => client);
  const repository = new PgDropshipListingRulesConversionRepository({ connect } as unknown as Pool, report);
  return { client, connect, repository, report };
}

const pricing = { revisionId: 41, profile: { defaultRecipe: { basis: "product_cost", markupBps: 1_000, flatCents: 0, rounding: "cent" },
  groups: [{ id: "sleeves", name: "Sleeves price", priority: 10, scope: { type: "category", category: "Sleeves" },
    recipe: { basis: "product_cost", markupBps: 4_000, flatCents: 0, rounding: "cent" } }] }, updatedAt: "2026-10-01T12:00:00.000Z" };
const content = { revisionId: null, profile: null, updatedAt: null };
const ebayRules = { revisionId: 61, profile: { version: 1, defaultCategory: null, rules: [{ id: "e-top", name: "Toploaders eBay",
  scope: { type: "category", category: "Toploaders" }, category: { categoryId: "183439", categoryName: "Card Toploaders", path: ["C"] } }] },
updatedAt: "2026-10-01T12:00:00.000Z" };
const candidates = [
  { productVariantId: 201, productId: 2, categoryId: null },
  { productVariantId: 101, productId: 1, categoryId: 12 },
];

const RECORD_INPUT = {
  requestHash: HASH, planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: true, changedSizeCount: 0, categoryCount: 2,
  productCount: 1, pricingGroupsRemoved: 1, contentGroupsRemoved: 0, ebayRulesRemoved: 1, now: NOW,
};
const AUDIT = {
  conversionId: RECORD.id, requestKey: KEY, planHash: "b".repeat(64), writesHash: "c".repeat(64), clean: true,
  counts: { categories: 2, products: 1, changedSizes: 0, firstMarks: 2 },
  removed: { pricingGroups: [{ id: "sleeves", name: "Sleeves price", scopeType: "category" }], contentGroups: [],
    ebayRules: [{ id: "e-top", name: "Toploaders eBay", scopeType: "category" }] },
  categoryIds: [12, 13], productIds: [2],
  revisions: { pricing: 42, content: 52, ebayRules: 62 },
};
const CATEGORY_WRITES = [
  { categoryId: 13, expectedRevisionId: null, patch: { ebayCategory: { categoryId: "183439", categoryName: "Card Toploaders", path: ["C"] } } },
  { categoryId: 12, expectedRevisionId: 812, patch: { price: { basis: "product_cost", markupBps: 4_000, flatCents: 0, rounding: "cent" } } },
] as const;
const PRODUCT_WRITES = [{ productId: 2, expectedRevisionId: null, patch: { textAbove: { mode: "own", text: "Above" } } }] as const;
const PRICING_PROFILE = { defaultRecipe: pricing.profile.defaultRecipe, groups: [] };
const EBAY_PROFILE = { version: 1 as const, defaultCategory: null, rules: [] };
const CONTENT_PROFILE = { defaultTemplate: { introduction: "Above", footer: "Below" }, groups: [] };

type Tx = ListingRulesConversionTransaction;
const reads = {
  authorize: (tx: Tx) => tx.authorize(),
  findConversionByKey: (tx: Tx) => tx.findConversionByKey(),
  hasAnyConversion: (tx: Tx) => tx.hasAnyConversion(),
  loadOlderGroupRuleCounts: (tx: Tx) => tx.loadOlderGroupRuleCounts(),
  lockSelection: (tx: Tx) => tx.lockSelection(),
  listChosenIds: (tx: Tx) => tx.listChosenIds(NOW),
  lockCatalog: (tx: Tx) => tx.lockCatalog({ categoryIds: [13, 12], productIds: [2, 1, 2], productVariantIds: [201, 101] }),
  loadInputs: (tx: Tx) => tx.loadInputs(NOW),
};
const writes = {
  insertConversion: (tx: Tx) => tx.insertConversion(RECORD_INPUT),
  saveCategories: (tx: Tx) => tx.saveCategories({ categories: CATEGORY_WRITES as never, requestHash: HASH, now: NOW }),
  saveProducts: (tx: Tx) => tx.saveProducts({ products: PRODUCT_WRITES as never, requestHash: HASH, now: NOW }),
  savePricingProfile: (tx: Tx) => tx.savePricingProfile({ expectedRevisionId: 41, profile: PRICING_PROFILE as never, now: NOW }),
  saveContentProfile: (tx: Tx) => tx.saveContentProfile({ expectedRevisionId: 51, profile: CONTENT_PROFILE, requestHash: HASH, now: NOW }),
  saveEbayCategoryRules: (tx: Tx) => tx.saveEbayCategoryRules({ expectedRevisionId: 61, profile: EBAY_PROFILE, requestHash: HASH, now: NOW }),
  insertFirstCategoryMarks: (tx: Tx) => tx.insertFirstCategoryMarks({ productIds: [1, 2], now: NOW }),
  insertStoreAudit: (tx: Tx, requestKey = KEY) => tx.insertStoreAudit({ payload: { ...AUDIT, requestKey }, now: NOW }),
};
type CallName = keyof typeof reads | keyof typeof writes;
const ALL: CallName[] = [...Object.keys(reads), ...Object.keys(writes)] as CallName[];
const call = (tx: Tx, name: CallName, requestKey = KEY) => name === "insertStoreAudit"
  ? writes.insertStoreAudit(tx, requestKey) : ((reads as Record<string, (tx: Tx) => Promise<unknown>>)[name]
    ?? (writes as Record<string, (tx: Tx) => Promise<unknown>>)[name])(tx);

/** Every call in plan 7.B.3's order, as a vendor's converted apply makes them. */
async function vendorBody(tx: Tx): Promise<string> {
  for (const name of ALL.filter((name) => name !== "hasAnyConversion")) await call(tx, name);
  return "converted";
}
async function systemBody(tx: Tx): Promise<string> {
  for (const name of ALL.filter((name) => name !== "findConversionByKey")) await call(tx, name, SYSTEM_KEY);
  return "converted";
}

/** The selected-catalog reader's product line read: the scan's mock sends it through the reader it was given. */
const PRODUCT_LINES_SQL = "SELECT id, name FROM catalog.product_lines WHERE id = ANY($1::int[]) ORDER BY name, id";

// The three profiles are read once (step 6): under the store lock the chosen sizes' rule categories (step 7) come from them.
const VENDOR_STATEMENTS = [
  "-- read: store context", "-- record: find by key", "-- read: pricing", "-- read: content", "-- read: ebay rules", flat(LISTING_SELECTION_LOCK_SQL),
  PRODUCT_LINES_SQL, "-- read: categories by name",
  flat(CATEGORY_LOCK_SQL), flat(PRODUCT_LOCK_SQL), flat(VARIANT_LOCK_SQL), "-- read: conversion inputs", "-- writer: record",
  "-- writer: category", "-- writer: category", "-- writer: products", "-- writer: pricing profile", "-- writer: content profile",
  "-- writer: ebay rules", "-- writer: first marks",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(PgDropshipListingPreviewRepository, "readerForTransaction").mockImplementation((client: QueryClient) => ({
    loadStoreContext: async (target: unknown) => {
      await client.query("-- read: store context");
      return { target, vendorStatus: "active" };
    },
  }) as never);
  mocks.findRuleConversionByKeyWithClient.mockImplementation(mocks.marker("record: find by key", null));
  mocks.hasRuleConversionWithClient.mockImplementation(mocks.marker("record: has any", false));
  mocks.insertRuleConversionWithClient.mockImplementation(mocks.marker("writer: record", RECORD));
  mocks.saveCategoryListingSettingWithClient.mockImplementation(mocks.marker("writer: category", { outcome: "changed" }));
  mocks.saveProductListingSettingsPerProductWithClient.mockImplementation(mocks.marker("writer: products",
    { changed: [{ productId: 2, revisionId: 31 }], unchangedProductIds: [] }));
  mocks.savePricingProfileWithClient.mockImplementation(mocks.marker("writer: pricing profile", { revisionId: 42, previousRevisionId: 41 }));
  mocks.saveContentProfileWithClient.mockImplementation(mocks.marker("writer: content profile", { revisionId: 52 }));
  mocks.saveEbayCategoryRulesProfileWithClient.mockImplementation(mocks.marker("writer: ebay rules", { revisionId: 62 }));
  mocks.insertFirstCategoryMarksWithClient.mockImplementation(mocks.marker("writer: first marks", { insertedProductIds: [1, 2] }));
  mocks.readPricingProfile.mockImplementation(mocks.marker("read: pricing", pricing));
  mocks.readContentProfile.mockImplementation(mocks.marker("read: content", content));
  mocks.readEbayCategoryRules.mockImplementation(mocks.marker("read: ebay rules", ebayRules));
  mocks.readCatalogCategoriesByName.mockImplementation(mocks.marker("read: categories by name",
    () => new Map([["Sleeves", [{ id: 12, name: "Sleeves" }]], ["Toploaders", [{ id: 13, name: "Toploaders" }]]])));
  // The scan gets a reader over the transaction's client: its marker is the reader's own product line read.
  mocks.loadSelectedCandidates.mockImplementation(async (reader: { listProductLines: (ids: number[]) => Promise<unknown> }) => {
    await reader.listProductLines([]);
    return candidates;
  });
  mocks.loadConversionInputsWithClient.mockImplementation(mocks.marker("read: conversion inputs",
    { state: "ok", inputs: INPUTS_SENTINEL, costReadFailure: null }));
});

async function failure(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(DropshipError);
  return error as DropshipError;
}

async function expectInvariant(promise: Promise<unknown>): Promise<DropshipError> {
  const error = await failure(promise);
  expect(error.code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
  expect(error.context).toMatchObject({ retryable: false, classification: "fatal" });
  return error;
}

describe("PgDropshipListingRulesConversionRepository.executeConversion: the vendor", () => {
  it("BEGIN, the request lock, the store lock and the owner rows by member, then plan 7.B.3's calls in order, then COMMIT", async () => {
    const { client, repository } = setup();
    await expect(repository.executeConversion(VENDOR_INPUT, vendorBody)).resolves.toBe("converted");

    expect(client.sql.slice(0, 4)).toEqual(["BEGIN", flat(REQUEST_LOCK_SQL), flat(STORE_LOCK_SQL), flat(VENDOR_OWNER_SQL)]);
    expect(client.params.slice(1, 4)).toEqual([[`${MEMBER}:${KEY}`], [STORE], [MEMBER, STORE]]);
    expect(REQUEST_LOCK_SQL).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_settings_request'), hashtext($1))");
    expect(STORE_LOCK_SQL).toBe("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)");
    expect(flat(VENDOR_OWNER_SQL)).toMatch(/FOR SHARE OF v, sc$/);
    const body = client.afterOwner();
    expect(body).toEqual([...VENDOR_STATEMENTS,
      flat(`INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, 'listing_rules_converted', $4, $5, 'info', $6::jsonb, $7)`), "COMMIT"]);
    // Never a session advisory lock on a pooled handle, never a savepoint or a second transaction of its own.
    expect(client.sql.filter((sql) => /pg_advisory_lock|pg_advisory_unlock|SAVEPOINT|^BEGIN/.test(sql))).toEqual(["BEGIN"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("locks categories, products and sizes ascending and distinct, and answers what it found", async () => {
    const { client, repository } = setup();
    client.existing.products = new Set([2]);
    const locked = await repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      await tx.lockSelection();
      return reads.lockCatalog(tx);
    });
    expect(locked).toEqual({ categoryIds: [12, 13], productIds: [2], productVariantIds: [101, 201] });
    const at = (sql: string) => client.params[client.sql.indexOf(flat(sql))];
    expect([at(CATEGORY_LOCK_SQL), at(PRODUCT_LOCK_SQL), at(VARIANT_LOCK_SQL)]).toEqual([[[12, 13]], [[1, 2]], [[101, 201]]]);
    expect(flat(CATEGORY_LOCK_SQL)).toMatch(/ORDER BY id FOR SHARE$/);
    // No writer ran: nothing to commit.
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("skips an empty id list's lock statement", async () => {
    const { client, repository } = setup();
    await repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      await tx.lockSelection();
      return tx.lockCatalog({ categoryIds: [], productIds: [], productVariantIds: [] });
    });
    expect(client.sql.filter((sql) => / FOR SHARE$/.test(sql))).toEqual([]);
  });

  it("gives every reader and writer the transaction's own client, and the actor, its type and its keys on every row", async () => {
    const { client, repository, report } = setup();
    await repository.executeConversion(VENDOR_INPUT, vendorBody);
    const actor = { actorType: "vendor", actorId: MEMBER };
    const scope = { vendorId: VENDOR, storeConnectionId: STORE, actor, requestKey: KEY };
    // Each marker ran on the scripted client, so each got a client over this transaction's connection.
    for (const mock of Object.values(mocks).filter((value) => typeof value === "function" && "mock" in value)) {
      for (const args of (mock as ReturnType<typeof vi.fn>).mock.calls) {
        if (mock === mocks.loadSelectedCandidates) continue;
        expect(typeof (args[0] as QueryClient).query).toBe("function");
      }
    }
    expect(mocks.findRuleConversionByKeyWithClient).toHaveBeenCalledWith(expect.anything(), { vendorId: VENDOR, idempotencyKey: KEY });
    expect(mocks.insertRuleConversionWithClient).toHaveBeenCalledWith(expect.anything(), { ...RECORD_INPUT, vendorId: VENDOR,
      storeConnectionId: STORE, idempotencyKey: KEY, actor });
    // Ascending categories, each under its own `lc:` child key, the transaction's actor on its revision and audit row.
    expect(mocks.saveCategoryListingSettingWithClient.mock.calls.map((args) => [args[1], args[2]])).toEqual([
      [{ ...scope, requestKey: listingConversionChildKey(KEY, "category", 12) }, { ...CATEGORY_WRITES[1], requestHash: HASH, now: NOW }],
      [{ ...scope, requestKey: listingConversionChildKey(KEY, "category", 13) }, { ...CATEGORY_WRITES[0], requestHash: HASH, now: NOW }],
    ]);
    expect(mocks.saveProductListingSettingsPerProductWithClient).toHaveBeenCalledWith(expect.anything(), scope,
      { conversionId: RECORD.id, products: PRODUCT_WRITES, requestHash: HASH, now: NOW });
    const profileTarget = { vendorId: VENDOR, storeConnectionId: STORE, actorId: MEMBER, actorType: "vendor" };
    expect(mocks.savePricingProfileWithClient).toHaveBeenCalledWith(expect.anything(), profileTarget,
      { expectedRevisionId: 41, profile: PRICING_PROFILE, conversionId: RECORD.id, now: NOW });
    expect(mocks.saveContentProfileWithClient).toHaveBeenCalledWith(expect.anything(), profileTarget, { expectedRevisionId: 51,
      profile: CONTENT_PROFILE, idempotencyKey: listingConversionChildKey(KEY, "content_profile", STORE) }, HASH, NOW);
    expect(mocks.saveEbayCategoryRulesProfileWithClient).toHaveBeenCalledWith(expect.anything(), profileTarget, { expectedRevisionId: 61,
      profile: EBAY_PROFILE, idempotencyKey: listingConversionChildKey(KEY, "ebay_rules", STORE), requestHash: HASH, now: NOW });
    expect(mocks.insertFirstCategoryMarksWithClient).toHaveBeenCalledWith(expect.anything(),
      { vendorId: VENDOR, storeConnectionId: STORE, actor }, { productIds: [1, 2], jobKey: KEY, now: NOW });
    const audit = client.params[client.sql.findIndex((sql) => sql.includes("'listing_rules_converted'"))];
    expect(audit).toEqual([VENDOR, STORE, String(STORE), "vendor", MEMBER, JSON.stringify(AUDIT), NOW]);
    // The load is composed on this client, with the repository's own cost-read reporter.
    expect(mocks.loadConversionInputsWithClient).toHaveBeenCalledWith(expect.anything(), { vendorId: VENDOR, storeConnectionId: STORE, now: NOW },
      report);
    expect(mocks.loadSelectedCandidates).toHaveBeenCalledWith(expect.objectContaining({ vendorId: VENDOR }), NOW, "listing_settings");
    expect(mocks.readCatalogCategoriesByName).toHaveBeenCalledWith(expect.anything(), ["Sleeves", "Toploaders"]);
  });

  it("names the chosen sizes, their products, and the chosen products' and rules' categories, ascending", async () => {
    const { repository } = setup();
    const chosen = await repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      await tx.loadOlderGroupRuleCounts();
      await tx.lockSelection();
      return tx.listChosenIds(NOW);
    });
    expect(chosen).toEqual({ state: "ok", productVariantIds: [101, 201], productIds: [1, 2], categoryIds: [12, 13] });
  });

  it("answers too_large for more than 10,000 chosen sizes, and passes any other failure of the scan", async () => {
    const { repository } = setup();
    mocks.loadSelectedCandidates.mockRejectedValueOnce(new DropshipError("DROPSHIP_LISTING_SETTINGS_TOO_LARGE", "More than 10,000."));
    await expect(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      await tx.loadOlderGroupRuleCounts();
      await tx.lockSelection();
      return tx.listChosenIds(NOW);
    })).resolves.toEqual({ state: "too_large" });
    expect(mocks.readCatalogCategoriesByName).not.toHaveBeenCalled();
    const other = new DropshipError("DROPSHIP_SOMETHING", "scan failed");
    mocks.loadSelectedCandidates.mockRejectedValueOnce(other);
    await expect(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      await tx.loadOlderGroupRuleCounts();
      await tx.lockSelection();
      return tx.listChosenIds(NOW);
    })).rejects.toBe(other);
  });

  it("rolls back a body that wrote nothing (a replay, nothing to convert, a refusal answered as an outcome)", async () => {
    const { client, repository } = setup();
    await expect(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      return tx.findConversionByKey();
    })).resolves.toBeNull();
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that wrote without its store audit row, rolling it all back", async () => {
    const { client, repository } = setup();
    const error = await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const name of ALL.filter((name) => name !== "hasAnyConversion" && name !== "insertStoreAudit")) await call(tx, name);
      return "incomplete";
    }));
    expect(error.context).toMatchObject({ storeConnectionId: STORE });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe("PgDropshipListingRulesConversionRepository.executeConversion: the system", () => {
  it("takes no request lock, reads the owner by store, and writes as the system under the store's own key", async () => {
    const { client, repository } = setup();
    await expect(repository.executeConversion(SYSTEM_INPUT, systemBody)).resolves.toBe("converted");
    expect(client.sql.slice(0, 3)).toEqual(["BEGIN", flat(STORE_LOCK_SQL), flat(SYSTEM_OWNER_SQL)]);
    expect(client.params.slice(1, 3)).toEqual([[STORE], [STORE]]);
    expect(client.sql).not.toContain(flat(REQUEST_LOCK_SQL));
    expect(client.sql).toContain("-- record: has any");
    expect(client.sql).not.toContain("-- record: find by key");
    expect(client.sql.at(-1)).toBe("COMMIT");
    const actor = { actorType: "system", actorId: JOB };
    expect(mocks.hasRuleConversionWithClient).toHaveBeenCalledWith(expect.anything(), { storeConnectionId: STORE });
    expect(mocks.insertRuleConversionWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      idempotencyKey: SYSTEM_KEY, actor }));
    expect(mocks.saveCategoryListingSettingWithClient.mock.calls.map((args) => args[1])).toEqual([12, 13].map((id) => ({
      vendorId: VENDOR, storeConnectionId: STORE, actor, requestKey: listingConversionChildKey(SYSTEM_KEY, "category", id) })));
    expect(mocks.saveProductListingSettingsPerProductWithClient.mock.calls[0][1]).toEqual({ vendorId: VENDOR, storeConnectionId: STORE,
      actor, requestKey: SYSTEM_KEY });
    const profileTarget = { vendorId: VENDOR, storeConnectionId: STORE, actorId: JOB, actorType: "system" };
    for (const mock of [mocks.savePricingProfileWithClient, mocks.saveContentProfileWithClient, mocks.saveEbayCategoryRulesProfileWithClient]) {
      expect(mock.mock.calls[0][1]).toEqual(profileTarget);
    }
    expect(mocks.saveContentProfileWithClient.mock.calls[0][2]).toMatchObject({
      idempotencyKey: listingConversionChildKey(SYSTEM_KEY, "content_profile", STORE) });
    expect(mocks.insertFirstCategoryMarksWithClient.mock.calls[0].slice(1)).toEqual([{ vendorId: VENDOR, storeConnectionId: STORE, actor },
      { productIds: [1, 2], jobKey: SYSTEM_KEY, now: NOW }]);
    const audit = client.params[client.sql.findIndex((sql) => sql.includes("'listing_rules_converted'"))];
    expect(audit.slice(3, 5)).toEqual(["system", JOB]);
  });

  it("is the same transaction object: the system may read the record by its key too", async () => {
    const { repository } = setup();
    await expect(repository.executeConversion(SYSTEM_INPUT, async (tx) => {
      await tx.authorize();
      return [tx.requestKey, tx.actor, await tx.findConversionByKey()];
    })).resolves.toEqual([SYSTEM_KEY, { actorType: "system", actorId: JOB }, null]);
    expect(mocks.findRuleConversionByKeyWithClient).toHaveBeenCalledWith(expect.anything(), { vendorId: VENDOR, idempotencyKey: SYSTEM_KEY });
  });
});

describe("the transaction object's contract (plan 7.B.3)", () => {
  it.each(ALL.map((name) => [name]))("refuses a second %s, before its SQL", async (name) => {
    const { client, repository } = setup();
    const index = ALL.indexOf(name);
    const error = await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const earlier of ALL.slice(0, index + 1)) {
        if (earlier === "hasAnyConversion" && name !== "hasAnyConversion") continue;
        await call(tx, earlier);
      }
      const sent = client.sql.length;
      await call(tx, name).finally(() => expect(client.sql.length).toBe(sent));
    }));
    expect(error.context).toMatchObject({ call: name });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it.each([
    ["the store audit row before the record", ["authorize", "lockSelection", "lockCatalog", "loadInputs"], "insertStoreAudit", ["insertConversion"]],
    ["a writer before the record", ["authorize", "lockSelection", "lockCatalog", "loadInputs"], "saveCategories", ["insertConversion"]],
    ["the record before the inputs", ["authorize", "lockSelection", "lockCatalog"], "insertConversion", ["loadInputs"]],
    ["the inputs before the catalog lock", ["authorize", "lockSelection"], "loadInputs", ["lockCatalog"]],
    ["the catalog lock before the selection lock", ["authorize"], "lockCatalog", ["lockSelection"]],
    ["the chosen sizes before the selection lock", ["authorize", "loadOlderGroupRuleCounts"], "listChosenIds", ["lockSelection"]],
    ["the chosen sizes before the older rules' profiles", ["authorize", "lockSelection"], "listChosenIds", ["loadOlderGroupRuleCounts"]],
    ["the replay read before the gate", [], "findConversionByKey", ["authorize"]],
    ["the older rules before the gate", [], "loadOlderGroupRuleCounts", ["authorize"]],
  ] as Array<[string, CallName[], CallName, CallName[]]>)("refuses %s", async (_label, before, name, missing) => {
    const { client, repository } = setup();
    const error = await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const earlier of before) await call(tx, earlier);
      await call(tx, name);
    }));
    expect(error.context).toMatchObject({ call: name, missing });
    expect(client.sql).not.toContain("COMMIT");
  });

  it.each([
    ["the older rules after the selection lock", ["authorize", "lockSelection"], "loadOlderGroupRuleCounts"],
    ["the replay read after the older rules", ["authorize", "loadOlderGroupRuleCounts"], "findConversionByKey"],
    ["a category save after the product save", ["authorize", "lockSelection", "lockCatalog", "loadInputs", "insertConversion", "saveProducts"],
      "saveCategories"],
    ["the marks after the store audit row", ["authorize", "lockSelection", "lockCatalog", "loadInputs", "insertConversion", "insertStoreAudit"],
      "insertFirstCategoryMarks"],
  ] as Array<[string, CallName[], CallName]>)("refuses %s: out of plan 7.B.3's order", async (_label, before, name) => {
    const { repository } = setup();
    const error = await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const earlier of before) await call(tx, earlier);
      await call(tx, name);
    }));
    expect(error.context).toMatchObject({ call: name });
  });

  it("refuses every call after the body returns, on a kept transaction object, with no statement", async () => {
    const { client, repository } = setup();
    let kept: Tx | null = null;
    await repository.executeConversion(VENDOR_INPUT, async (tx) => {
      kept = tx;
      await tx.authorize();
    });
    const sent = client.sql.length;
    for (const name of ALL) {
      const error = await expectInvariant(call(kept!, name));
      expect(error.message).toBe("A listing settings transaction was used after it ended.");
    }
    expect(client.sql.length).toBe(sent);
  });

  it("refuses a body that kept the transaction past a failure, too", async () => {
    const { client, repository } = setup();
    let kept: Tx | null = null;
    const boom = new Error("body failed");
    await expect(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      kept = tx;
      throw boom;
    })).rejects.toBe(boom);
    await expectInvariant(kept!.authorize());
    expect(client.sql).toEqual(["BEGIN", flat(REQUEST_LOCK_SQL), flat(STORE_LOCK_SQL), flat(VENDOR_OWNER_SQL), "ROLLBACK"]);
  });

  it.each([
    ["a category it did not lock", (tx: Tx) => tx.saveCategories({ categories: [{ categoryId: 14, expectedRevisionId: null,
      patch: { price: null } }], requestHash: HASH, now: NOW })],
    ["a product it did not lock", (tx: Tx) => tx.saveProducts({ products: [{ productId: 3, expectedRevisionId: null, patch: { price: null } }],
      requestHash: HASH, now: NOW })],
    ["first marks for a product it did not lock", (tx: Tx) => tx.insertFirstCategoryMarks({ productIds: [1, 3], now: NOW })],
  ])("refuses a write to %s, before the writer", async (_label, write) => {
    const { client, repository } = setup();
    client.existing.products = new Set([1, 2]);
    await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const name of ["authorize", "lockSelection", "lockCatalog", "loadInputs", "insertConversion"] as CallName[]) await call(tx, name);
      await write(tx);
    }));
    expect(client.sql.filter((sql) => sql.startsWith("-- writer:"))).toEqual(["-- writer: record"]);
  });

  it.each([
    ["another conversion's id", { conversionId: 9_002 }],
    ["another key", { requestKey: "ls-convert:another-key-0000" }],
    ["a field the contract does not know", { secret: "x" }],
    ["more than 100 product ids", { productIds: Array.from({ length: 101 }, (_, index) => index + 1) }],
  ])("refuses a store audit row naming %s, before its SQL", async (_label, patch) => {
    const { client, repository } = setup();
    await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const name of ["authorize", "lockSelection", "lockCatalog", "loadInputs", "insertConversion"] as CallName[]) await call(tx, name);
      await tx.insertStoreAudit({ payload: { ...AUDIT, ...patch } as never, now: NOW });
    }));
    expect(client.sql.some((sql) => sql.includes("'listing_rules_converted'"))).toBe(false);
  });

  it.each([
    ["a content profile out of its contract", (tx: Tx) => tx.saveContentProfile({ expectedRevisionId: 51,
      profile: { defaultTemplate: CONTENT_PROFILE.defaultTemplate, groups: [], extra: 1 } as never, requestHash: HASH, now: NOW })],
    ["an eBay document of another version", (tx: Tx) => tx.saveEbayCategoryRules({ expectedRevisionId: 61,
      profile: { ...EBAY_PROFILE, version: 2 } as never, requestHash: HASH, now: NOW })],
    ["a content save with no request hash", (tx: Tx) => tx.saveContentProfile({ expectedRevisionId: 51, profile: CONTENT_PROFILE,
      requestHash: "nope", now: NOW })],
  ])("refuses %s before the writer", async (_label, write) => {
    const { client, repository } = setup();
    await expectInvariant(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      for (const name of ["authorize", "lockSelection", "lockCatalog", "loadInputs", "insertConversion"] as CallName[]) await call(tx, name);
      await write(tx);
    }));
    expect(client.sql.filter((sql) => sql.startsWith("-- writer:"))).toEqual(["-- writer: record"]);
  });
});

describe("a writer's version conflict under the store lock (plan D24)", () => {
  // Each writer's own conflict context, as it throws it (CRR, PRR assertExpectedRevisions, the pricing writer), and what follows it.
  const productConflicts = { storeConnectionId: STORE, conflicts: [{ productId: 2, expectedRevisionId: null, actualRevisionId: 31,
    words: "kept out" }], conflictCount: 1 };
  it.each([
    ["saveCategories", mocks.saveCategoryListingSettingWithClient, "DROPSHIP_CATEGORY_LISTING_SETTINGS_VERSION_CONFLICT",
      { categoryId: 12, expectedRevisionId: 812, actualRevisionId: 813 }, { categoryId: 12, expectedRevisionId: 812, actualRevisionId: 813 }],
    ["saveProducts", mocks.saveProductListingSettingsPerProductWithClient, "DROPSHIP_PRODUCT_LISTING_SETTINGS_VERSION_CONFLICT",
      productConflicts, { conflicts: [{ productId: 2, expectedRevisionId: null, actualRevisionId: 31 }], conflictCount: 1 }],
    ["savePricingProfile", mocks.savePricingProfileWithClient, "DROPSHIP_PRICING_REVIEW_STALE",
      { storeConnectionId: STORE, expectedRevisionId: 41, actualRevisionId: 43 }, { expectedRevisionId: 41, actualRevisionId: 43 }],
    ["saveContentProfile", mocks.saveContentProfileWithClient, "DROPSHIP_CONTENT_VERSION_CONFLICT", {}, {}],
    ["saveEbayCategoryRules", mocks.saveEbayCategoryRulesProfileWithClient, "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT", {}, {}],
  ] as Array<[CallName, ReturnType<typeof vi.fn>, string, Record<string, unknown>, Record<string, unknown>]>)(
    "%s's conflict is the fatal INVARIANT_FAILED with causeCode and its ids, rolled back, never a 409 to retry", async (writer, mock, code,
      context, kept) => {
      const { client, repository } = setup();
      mock.mockImplementationOnce(async (writerClient: QueryClient) => {
        await writerClient.query(`-- conflicted: ${writer}`);
        throw new DropshipError(code, "Changed after you opened it.", { ...context, retryable: false, classification: "permanent",
          secretWords: "kept out" });
      });
      const error = await expectInvariant(repository.executeConversion(VENDOR_INPUT, vendorBody));
      expect(error.context).toEqual({ storeConnectionId: STORE, writer, causeCode: code, ...kept, retryable: false, classification: "fatal" });
      expect(client.sql.slice(-2)).toEqual([`-- conflicted: ${writer}`, "ROLLBACK"]);
      expect(client.sql).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
    });

  it("passes every other writer failure unchanged: a key reuse stays the permanent 409", async () => {
    const { repository } = setup();
    const reuse = new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "Key used.", { classification: "permanent" });
    mocks.saveCategoryListingSettingWithClient.mockRejectedValueOnce(reuse);
    await expect(repository.executeConversion(VENDOR_INPUT, vendorBody)).rejects.toBe(reuse);
  });

  it.each([
    ["saveContentProfile", mocks.saveContentProfileWithClient, "dropship_content_profile_revision_vendor_id_idempotency_key_key"],
    ["saveEbayCategoryRules", mocks.saveEbayCategoryRulesProfileWithClient, "dropship_ebay_category_rule_revis_vendor_id_idempotency_key_key"],
  ] as Array<[CallName, ReturnType<typeof vi.fn>, string]>)(
    "maps %s's insert meeting an older row under its `lc:` key (23505) to the permanent 409, rolled back, never a raw 500", async (writer,
      mock, constraint) => {
      const { client, repository } = setup();
      mock.mockImplementationOnce(async (writerClient: QueryClient) => {
        await writerClient.query(`-- collided: ${writer}`);
        throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", constraint });
      });
      const error = await failure(repository.executeConversion(SYSTEM_INPUT, systemBody));
      expect(error).toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT", context: { constraint, retryable: false, classification: "permanent" } });
      expect(client.sql.slice(-2)).toEqual([`-- collided: ${writer}`, "ROLLBACK"]);
      expect(client.sql).not.toContain("COMMIT");
      expect(client.release).toHaveBeenCalledTimes(1);
    });

  it("does not take the record's own key conflict for a version conflict", async () => {
    const { repository } = setup();
    const reuse = new DropshipError("DROPSHIP_IDEMPOTENCY_CONFLICT", "Key used.", { constraint: "dropship_listing_rule_conversion_key_uk" });
    mocks.insertRuleConversionWithClient.mockRejectedValueOnce(reuse);
    await expect(repository.executeConversion(VENDOR_INPUT, vendorBody)).rejects.toBe(reuse);
  });
});

describe("failures: rollback once, the original error, the client released once", () => {
  it("rejects with the body's own DropshipError and rolls back as the last statement", async () => {
    const { client, repository } = setup();
    const refusal = new DropshipError("DROPSHIP_LISTING_CONVERSION_CHANGED", "Changed.", { classification: "permanent" });
    await expect(repository.executeConversion(VENDOR_INPUT, async (tx) => {
      await tx.authorize();
      throw refusal;
    })).rejects.toBe(refusal);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the original error when the ROLLBACK itself fails", async () => {
    const { client, repository } = setup();
    client.failRollback = true;
    const boom = new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "broken", { classification: "fatal" });
    await expect(repository.executeConversion(VENDOR_INPUT, async () => { throw boom; })).rejects.toBe(boom);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a CHECK or the record's guard (23514)", { code: "23514", constraint: "dropship_listing_rule_conversion_system_clean_chk",
      message: "violates check" }, "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "fatal"],
    ["a deadlock (40P01)", { code: "40P01", message: "deadlock detected" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
    ["a lost connection (08006)", { code: "08006", message: "connection failure" }, "DROPSHIP_LISTING_SETTINGS_BUSY", "transient"],
  ])("maps a database failure at the store audit row, %s, once, after the rollback", async (_label, pgError, code, classification) => {
    const { client, repository } = setup();
    client.failOn = { sql: `INSERT INTO dropship.dropship_audit_events
       (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
     VALUES ($1, $2, 'dropship_store_connection', $3, 'listing_rules_converted', $4, $5, 'info', $6::jsonb, $7)`,
    error: Object.assign(new Error(pgError.message), pgError) };
    const error = await failure(repository.executeConversion(VENDOR_INPUT, vendorBody));
    expect(error).toMatchObject({ code, context: { classification } });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql).not.toContain("COMMIT");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("maps a failed COMMIT once (a lost connection is BUSY: the retry replays from the record)", async () => {
    const { client, repository } = setup();
    client.failOn = { sql: "COMMIT", error: Object.assign(new Error("connection lost"), { code: "57P01" }) };
    expect(await failure(repository.executeConversion(VENDOR_INPUT, vendorBody))).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY" });
    expect(client.sql.slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("answers an owner that is not the member's with the permanent 404, before the body", async () => {
    const { client, repository } = setup();
    client.ownerFound = false;
    const body = vi.fn();
    expect(await failure(repository.executeConversion(VENDOR_INPUT, body))).toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED",
      context: { storeConnectionId: STORE, classification: "permanent" } });
    expect(body).not.toHaveBeenCalled();
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("maps a pool that has no connection in time to BUSY, opening nothing", async () => {
    const repository = new PgDropshipListingRulesConversionRepository({
      connect: vi.fn(async () => { throw new Error("timeout exceeded when trying to connect"); }),
    } as unknown as Pool);
    expect(await failure(repository.executeConversion(VENDOR_INPUT, vi.fn()))).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY",
      context: { failure: "pool_acquire_timeout", classification: "transient" } });
  });

  it.each([
    ["a blank member", { ...VENDOR_INPUT, memberId: " " }],
    ["a key of 7 characters", { ...VENDOR_INPUT, idempotencyKey: "abcdefg" }],
    // Plan D12: the system job's key for another of his stores, and a conversion's own child key, are never a vendor's.
    ["a vendor sending the system job's key", { ...VENDOR_INPUT, idempotencyKey: "rules-conversion:23" }],
    ["a vendor sending a conversion child key", { ...VENDOR_INPUT, idempotencyKey: `lc:${"a".repeat(64)}:category:5` }],
    ["a store id past int4", { ...VENDOR_INPUT, storeConnectionId: 2_147_483_648 }],
    ["a blank job key", { ...SYSTEM_INPUT, jobKey: "" }],
    ["an admin", { actorType: "admin", memberId: MEMBER, storeConnectionId: STORE, idempotencyKey: KEY }],
  ])("refuses %s as the fatal invariant before taking a connection", async (_label, input) => {
    const connect = vi.fn();
    const repository = new PgDropshipListingRulesConversionRepository({ connect } as unknown as Pool);
    await expectInvariant(repository.executeConversion(input as never, vi.fn()));
    expect(connect).not.toHaveBeenCalled();
  });
});
