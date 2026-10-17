import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ProductListingSettingValues } from "../../../../../shared/dropship/listing-setting-values";
import { EMPTY_LISTING_SETTING_LAYERS } from "../../application/dropship-listing-setting-layers";
import { EMPTY_CATEGORY_LISTING_SETTING_VALUES, EMPTY_PRODUCT_LISTING_SETTING_VALUES } from "../../domain/listing-setting-values";
import { readResolvedEbayCategories } from "../../infrastructure/dropship-ebay-category-rules.reader";
import {
  PgDropshipEbayCategoryRulesRepository,
  saveEbayCategoryRulesProfileWithClient,
} from "../../infrastructure/dropship-ebay-category-rules.repository";
import { productValuesToColumns } from "../../infrastructure/dropship-listing-setting-shared.repository";
import { MAILERS, SLEEVES, TOPLOADERS, categoryCandidate, rulesProfile } from "../fixtures/ebay-category-rules.fixture";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));

const NOW = new Date("2026-09-30T12:00:00.000Z");

class ScriptedClient {
  sql: string[] = [];
  params: unknown[][] = [];
  release = vi.fn();
  headRevision: { id: number; profile: unknown; created_at: Date } | null = null;
  replay: { request_hash: string; store_connection_id: number } | null = null;
  ownerFound = true;
  productSettings: Record<string, unknown>[] = [];

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();
    this.sql.push(sql);
    this.params.push(params);
    if (sql.includes("FROM dropship.dropship_vendors v")) return rows<T>(this.ownerFound ? [{ vendor_id: 10 }] : []);
    if (sql.includes("FROM dropship.dropship_product_listing_settings s")) return rows<T>(this.productSettings);
    if (sql.includes("FROM dropship.dropship_ebay_category_rule_profiles p")) return rows<T>(this.headRevision ? [this.headRevision] : []);
    if (sql.startsWith("SELECT request_hash, store_connection_id")) return rows<T>(this.replay ? [this.replay] : []);
    if (sql.startsWith("INSERT INTO dropship.dropship_ebay_category_rule_revisions")) {
      this.headRevision = { id: 12, profile: JSON.parse(String(params[3])), created_at: NOW };
      return rows<T>([{ id: 12 }]);
    }
    return rows<T>([]);
  }
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

/** A product's current settings as PostgreSQL hands them back: jsonb arrays parsed again, the revision time as a Date. */
function storedProductSettings(productId: number, values: Partial<ProductListingSettingValues>): Record<string, unknown> {
  return { product_id: productId, revision_id: 70 + productId,
    ...(JSON.parse(JSON.stringify(productValuesToColumns({ ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ...values }))) as Record<string, unknown>),
    created_at: NOW };
}

const isLayerRead = (sql: string) => /FROM dropship\.dropship_(product|category)_listing_settings s\b/.test(sql);

describe("PgDropshipEbayCategoryRulesRepository", () => {
  it("reads in a read-only snapshot without the store lock or row locks", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    const state = await repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" }, (tx) => tx.loadState());

    expect(state).toEqual({ revisionId: null, profile: null, updatedAt: null });
    expect(client.sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(client.sql.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(client.sql.some((sql) => sql.includes("FOR SHARE"))).toBe(false);
    expect(client.sql.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("writes under the request and store locks, chains the revision and audits before and after", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));
    const profile = rulesProfile({ defaultCategory: SLEEVES });

    const state = await repository.execute(
      { memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:1" },
      async (tx) => {
        await tx.saveProfile({ expectedRevisionId: null, profile, idempotencyKey: "category-rules:1", requestHash: "a".repeat(64), now: NOW });
        return tx.loadState();
      },
    );

    expect(state).toMatchObject({ revisionId: 12, profile });
    expect(client.sql[0]).toBe("BEGIN");
    expect(client.sql[1]).toContain("hashtext('dropship_ebay_category_rules_request')");
    expect(client.sql[2]).toContain("hashtext('dropship_listing_push_job')");
    expect(client.sql.find((sql) => sql.includes("FROM dropship.dropship_vendors v"))).toContain("FOR SHARE OF v, sc");
    const insertIndex = client.sql.findIndex((sql) => sql.startsWith("INSERT INTO dropship.dropship_ebay_category_rule_revisions"));
    expect(client.params[insertIndex]).toEqual([10, 44, null, JSON.stringify(profile), "category-rules:1", "a".repeat(64), "member-1", NOW]);
    expect(client.sql.some((sql) => sql.includes("INSERT INTO dropship.dropship_ebay_category_rule_profiles"))).toBe(true);
    const auditIndex = client.sql.findIndex((sql) => sql.includes("dropship_audit_events"));
    expect(JSON.parse(String(client.params[auditIndex][4]))).toEqual({ revisionId: 12, previousRevisionId: null, before: null, after: profile });
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("refuses a stale expected revision and rolls back without writing", async () => {
    const client = new ScriptedClient();
    client.headRevision = { id: 5, profile: rulesProfile(), created_at: NOW };
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await expect(repository.execute(
      { memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:2" },
      (tx) => tx.saveProfile({ expectedRevisionId: 4, profile: rulesProfile(), idempotencyKey: "category-rules:2", requestHash: "b".repeat(64), now: NOW }),
    )).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    expect(client.sql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(false);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("replays a matching key and refuses the same key for a different request or store", async () => {
    const client = new ScriptedClient();
    client.replay = { request_hash: "c".repeat(64), store_connection_id: 44 };
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));
    const input = { memberId: "member-1", storeConnectionId: 44, mode: "read" as const };

    await expect(repository.execute(input, (tx) => tx.findReplay("category-rules:3", "c".repeat(64)))).resolves.toBe(true);
    await expect(repository.execute(input, (tx) => tx.findReplay("category-rules:3", "d".repeat(64))))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    client.replay = { request_hash: "c".repeat(64), store_connection_id: 45 };
    await expect(repository.execute(input, (tx) => tx.findReplay("category-rules:3", "c".repeat(64))))
      .rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a write from a read transaction or with another request's key", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));
    const save = { expectedRevisionId: null, profile: rulesProfile(), requestHash: "e".repeat(64), now: NOW };

    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" },
      (tx) => tx.saveProfile({ ...save, idempotencyKey: "category-rules:4" }))).rejects.toThrow("write transaction");
    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:4" },
      (tx) => tx.saveProfile({ ...save, idempotencyKey: "category-rules:5" }))).rejects.toThrow("write transaction");
    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "write" }, async () => undefined))
      .rejects.toThrow("requires its request key");
  });

  it("reports a store that is not the member's as not found", async () => {
    const client = new ScriptedClient();
    client.ownerFound = false;
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await expect(repository.execute({ memberId: "member-2", storeConnectionId: 44, mode: "read" }, (tx) => tx.loadState()))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("reads the product and category settings in the review's read-only snapshot, scoped to the member's store", async () => {
    const client = new ScriptedClient();
    client.productSettings = [storedProductSettings(7, { ebayCategory: MAILERS })];
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    const layers = await repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" },
      (tx) => tx.loadListingSettingLayers([{ productId: 7, categoryId: 31 }, { productId: 8, categoryId: null }]));

    expect(layers.products.get(7)?.values.ebayCategory).toEqual(MAILERS);
    expect(layers.categories.size).toBe(0);
    const reads = client.sql.flatMap((sql, index) => isLayerRead(sql) ? [{ sql, params: client.params[index] }] : []);
    expect(reads).toHaveLength(2);
    expect(reads[0].sql).toContain("FROM dropship.dropship_product_listing_settings s");
    expect(reads[0].params).toEqual([10, 44, [7, 8]]);
    expect(reads[1].sql).toContain("FROM dropship.dropship_category_listing_settings s");
    expect(reads[1].params).toEqual([10, 44, [31]]);
    expect(client.sql[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(client.sql.some((sql) => /\bFOR (UPDATE|SHARE)\b|pg_advisory/.test(sql))).toBe(false);
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("refuses persisted rules that no longer satisfy the contract", async () => {
    const client = new ScriptedClient();
    client.headRevision = { id: 5, profile: { version: 2, rules: "broken" }, created_at: NOW };
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "read" }, (tx) => tx.loadState()))
      .rejects.toThrow("failed their contract");
  });
});

// PR 11, plan D11: the conversion writes the rules document as its actor; every other caller passes no type.
describe("saveEbayCategoryRulesProfileWithClient's actor type", () => {
  const AUDIT_VALUES = "VALUES ($1,$2,'dropship_ebay_category_rules',$3,'ebay_category_rules_saved',$7,$4,'info',$5::jsonb,$6)";

  it("audits as a vendor when no actor type is given, and as the type given otherwise", async () => {
    const before = rulesProfile({ defaultCategory: SLEEVES });
    const after = rulesProfile({ defaultCategory: SLEEVES, rules: [] });
    for (const [actorType, expected] of [[undefined, "vendor"], ["vendor", "vendor"], ["system", "system"]] as const) {
      const client = new ScriptedClient();
      client.headRevision = { id: 5, profile: before, created_at: NOW };

      const saved = await saveEbayCategoryRulesProfileWithClient(client as unknown as PoolClient,
        { vendorId: 10, storeConnectionId: 44, actorId: "rules-conversion:44", ...(actorType ? { actorType } : {}) },
        { expectedRevisionId: 5, profile: after, idempotencyKey: "lc:child-ebay-rules-1", requestHash: "a".repeat(64), now: NOW });

      expect(saved).toEqual({ revisionId: 12 });
      const auditIndex = client.sql.findIndex((sql) => sql.includes("dropship_audit_events"));
      expect(client.sql[auditIndex].replace(/\s+/g, " ")).toContain(AUDIT_VALUES);
      expect({ actorType, params: client.params[auditIndex] }).toEqual({ actorType, params: [10, 44, "44", "rules-conversion:44",
        JSON.stringify({ revisionId: 12, previousRevisionId: 5, before, after }), NOW, expected] });
      // The revision table has no actor type: the revision keeps the actor id only, as before.
      const insertIndex = client.sql.findIndex((sql) => sql.startsWith("INSERT INTO dropship.dropship_ebay_category_rule_revisions"));
      expect(client.params[insertIndex]).toEqual([10, 44, 5, JSON.stringify(after), "lc:child-ebay-rules-1", "a".repeat(64),
        "rules-conversion:44", NOW]);
    }
  });

  it("audits as a vendor through the repository's own transaction, which passes no actor type", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayCategoryRulesRepository(poolFor(client));

    await repository.execute({ memberId: "member-1", storeConnectionId: 44, mode: "write", idempotencyKey: "category-rules:6" },
      (tx) => tx.saveProfile({ expectedRevisionId: null, profile: rulesProfile(), idempotencyKey: "category-rules:6",
        requestHash: "a".repeat(64), now: NOW }));

    const auditIndex = client.sql.findIndex((sql) => sql.includes("dropship_audit_events"));
    expect([client.params[auditIndex][3], client.params[auditIndex][6]]).toEqual(["member-1", "vendor"]);
  });
});

describe("readResolvedEbayCategories", () => {
  const scope = { vendorId: 10, storeConnectionId: 44 };
  const asClient = (client: ScriptedClient) => client as unknown as Pick<PoolClient, "query">;
  const inMailers = categoryCandidate({ productVariantId: 101, productId: 7, categoryId: 31 });
  const unsorted = categoryCandidate({ productVariantId: 102, productId: 8, categoryId: null, ebayBrowseCategoryId: null, ebayBrowseCategoryName: null });

  it("uses the layers it is given and reads only the rules", async () => {
    const client = new ScriptedClient();
    client.headRevision = { id: 5, profile: rulesProfile({ defaultCategory: SLEEVES }), created_at: NOW };
    const layers = {
      products: new Map([[7, { storeConnectionId: 44, productId: 7, revisionId: 77, updatedAt: NOW.toISOString(),
        values: { ...EMPTY_PRODUCT_LISTING_SETTING_VALUES, ebayCategory: TOPLOADERS } }]]),
      categories: new Map([[31, { storeConnectionId: 44, categoryId: 31, revisionId: 81, updatedAt: NOW.toISOString(),
        values: { ...EMPTY_CATEGORY_LISTING_SETTING_VALUES, ebayCategory: MAILERS } }]]),
    };

    const resolved = await readResolvedEbayCategories(asClient(client), { ...scope, candidates: [inMailers, unsorted], layers });

    expect(client.sql).toHaveLength(1);
    expect(client.sql[0]).toContain("FROM dropship.dropship_ebay_category_rule_profiles p");
    expect(resolved.get(101)).toEqual({ categoryId: TOPLOADERS.categoryId, categoryName: "Toploaders", source: "product",
      ruleId: null, ruleName: null, rulesRevisionId: 5 });
    expect(resolved.get(102)).toMatchObject({ categoryId: SLEEVES.categoryId, source: "store_default" });
  });

  it("reads the layers itself, on the caller's client, when none are given", async () => {
    const client = new ScriptedClient();
    client.productSettings = [storedProductSettings(7, { ebayCategory: TOPLOADERS })];

    const resolved = await readResolvedEbayCategories(asClient(client), { ...scope, candidates: [inMailers, unsorted] });

    expect(client.sql[0]).toContain("FROM dropship.dropship_ebay_category_rule_profiles p");
    expect(client.sql.filter(isLayerRead)).toHaveLength(2);
    expect(client.sql.some((sql) => /\bFOR (UPDATE|SHARE)\b|pg_advisory|^(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
    expect(resolved.get(101)).toMatchObject({ categoryId: TOPLOADERS.categoryId, source: "product", rulesRevisionId: null });
    expect(resolved.get(102)).toEqual({ categoryId: null, categoryName: null, source: "none", ruleId: null, ruleName: null, rulesRevisionId: null });
  });

  it("with no product or category settings resolves exactly as with empty layers, skipping the category read for sizes without one", async () => {
    const read = new ScriptedClient();
    const given = new ScriptedClient();
    for (const client of [read, given]) client.headRevision = { id: 6, profile: rulesProfile({ rules: [
      { id: "mailers", name: "Mailers", scope: { type: "category", category: "Mailers" }, category: MAILERS },
    ] }), created_at: NOW };
    const candidates = [{ ...inMailers, categoryId: null }, unsorted];

    const fromRead = await readResolvedEbayCategories(asClient(read), { ...scope, candidates });
    const fromGiven = await readResolvedEbayCategories(asClient(given), { ...scope, candidates, layers: EMPTY_LISTING_SETTING_LAYERS });

    expect(fromRead).toEqual(fromGiven);
    expect(fromRead.get(101)).toMatchObject({ source: "rule", ruleId: "mailers" });
    expect(read.sql.filter(isLayerRead)).toEqual([expect.stringContaining("FROM dropship.dropship_product_listing_settings s")]);
    expect(given.sql.filter(isLayerRead)).toEqual([]);
  });

  it("sends only the rules read for no candidates", async () => {
    const client = new ScriptedClient();
    await expect(readResolvedEbayCategories(asClient(client), { ...scope, candidates: [] })).resolves.toEqual(new Map());
    expect(client.sql).toHaveLength(1);
  });
});
