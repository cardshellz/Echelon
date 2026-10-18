import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropshipEbayCategoryRulesService,
  type EbayCategoryRulesRepository,
  type EbayCategoryTaxonomy,
} from "../../application/dropship-ebay-category-rules-service";
import { PgDropshipEbayCategoryRulesRepository } from "../../infrastructure/dropship-ebay-category-rules.repository";
import type { EbayCategoryOption } from "../../../../../shared/dropship/ebay-category-rules";
import { MAILERS, SLEEVES, TOPLOADERS, categoryOption } from "../fixtures/ebay-category-rules.fixture";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-09-30T12:00:00Z");

(testUrl && disposable ? describe : describe.skip).sequential("eBay category rules PostgreSQL guarantees", () => {
  const schema = `dropship_category_rules_${process.pid}`;
  let pool: pg.Pool;
  let service: DropshipEbayCategoryRulesService;
  let repository: PgDropshipEbayCategoryRulesRepository;
  let created = false;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`).replaceAll("catalog.", `"${schema}".`);
  const query = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);

  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Distinct disposable database required.");
    }
    if (!/^dropship_category_rules_\d+$/.test(schema)) throw new Error("Invalid test schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 6, ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: false } });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await query(`
      CREATE TABLE dropship.dropship_vendors (id int PRIMARY KEY, member_id text);
      CREATE TABLE dropship.dropship_store_connections (id int PRIMARY KEY, vendor_id int REFERENCES dropship.dropship_vendors(id), UNIQUE(id, vendor_id));
      CREATE TABLE dropship.dropship_audit_events (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id int, store_connection_id int, entity_type text, entity_id text, event_type text,
        actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz);
      INSERT INTO dropship.dropship_vendors VALUES (10, 'member-1'), (11, 'member-2');
      INSERT INTO dropship.dropship_store_connections VALUES (22, 10), (23, 11), (24, 10);
    `);
    await query(readFileSync(resolve(process.cwd(), "migrations/0717_dropship_ebay_category_rules.sql"), "utf8"));
    const scoped = { connect: async () => {
      const client = await pool.connect();
      return { query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values), release: () => client.release() };
    } } as unknown as Pool;
    repository = new PgDropshipEbayCategoryRulesRepository(scoped);
    // Real ownership, locks, revisions, triggers and audits. Store context is a
    // deterministic fixture; the service tests cover the access policy itself.
    const withStoreFixture: EbayCategoryRulesRepository = { execute: (input, operation) => repository.execute(input, (tx) => operation({
      ...tx,
      catalog: { ...tx.catalog,
        loadStoreContext: async () => ({ vendorId: tx.vendorId, storeConnectionId: input.storeConnectionId, vendorStatus: "active",
          entitlementStatus: "active", storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }),
      },
      loadStoreListingConfig: async () => null,
    })) };
    const options = new Map<string, EbayCategoryOption>([TOPLOADERS, SLEEVES, MAILERS].map((category) => [category.categoryId, categoryOption(category)]));
    const taxonomy: EbayCategoryTaxonomy = {
      search: async () => [...options.values()],
      describe: async (_identity, ids) => new Map(ids.flatMap((id) => options.has(id) ? [[id, options.get(id)!] as const] : [])),
      browse: async () => ({ parent: null, children: [...options.values()] }),
    };
    service = new DropshipEbayCategoryRulesService({ repository: withStoreFixture, taxonomy, clock: { now: () => now },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });

  beforeEach(async () => {
    await query(`TRUNCATE dropship.dropship_ebay_category_rule_profiles, dropship.dropship_ebay_category_rule_revisions,
      dropship.dropship_audit_events RESTART IDENTITY`);
  });

  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  // The store default's history, heads, concurrency, stores and rollback; no rule, since Listing settings PR 12 refuses a
  // new one (D9). The rule cases below seed the rule first, as an older group save made it, and resend it.
  function save(key: string, defaultCategoryId: string | null, expectedRevisionId: number | null = null, store = 22, member = "member-1") {
    return service.saveForMember(member, store, { expectedRevisionId, idempotencyKey: key, draft: { defaultCategoryId, rules: [] } });
  }

  const MAILERS_RULE = { id: "mailers", name: "Mailers", scope: { type: "category" as const, category: "Mailers" }, categoryId: MAILERS.categoryId };

  /** The Mailers rule stored through the real writer, as an older group save made it before PR 12; its revision. */
  async function seedMailersRule(key = "seed-mailers"): Promise<number> {
    await repository.execute({ memberId: "member-1", storeConnectionId: 22, mode: "write", idempotencyKey: key }, (tx) => tx.saveProfile({
      expectedRevisionId: null, idempotencyKey: key, requestHash: "e".repeat(64), now,
      profile: { version: 1, defaultCategory: null, rules: [{ id: "mailers", name: "Mailers", scope: { type: "category", category: "Mailers" },
        category: MAILERS }] } }));
    return (await service.getForMember("member-1", 22)).revisionId!;
  }

  async function counts() {
    const result = await query(`SELECT (SELECT count(*)::int FROM dropship.dropship_ebay_category_rule_revisions) AS revisions,
      (SELECT count(*)::int FROM dropship.dropship_ebay_category_rule_profiles) AS heads,
      (SELECT count(*)::int FROM dropship.dropship_audit_events) AS audits`);
    return result.rows[0];
  }

  it("saves immutable history, the current head and a before/after audit together", async () => {
    const first = await save("first", SLEEVES.categoryId);
    expect(first.state).toMatchObject({ revisionId: 1, profile: { defaultCategory: SLEEVES } });
    const second = await save("second", TOPLOADERS.categoryId, 1);
    expect(second.state.profile?.defaultCategory).toEqual(TOPLOADERS);
    expect(await service.getForMember("member-1", 22)).toEqual(second.state);
    expect(await counts()).toEqual({ revisions: 2, heads: 1, audits: 2 });
    const audits = await query("SELECT payload FROM dropship.dropship_audit_events ORDER BY id");
    expect(audits.rows[1].payload).toMatchObject({ revisionId: 2, previousRevisionId: 1,
      before: { defaultCategory: { categoryId: SLEEVES.categoryId } }, after: { defaultCategory: { categoryId: TOPLOADERS.categoryId } } });
    await expect(query("UPDATE dropship.dropship_ebay_category_rule_revisions SET profile = '{}'")).rejects.toMatchObject({ code: "23514" });
    await expect(query("DELETE FROM dropship.dropship_ebay_category_rule_revisions")).rejects.toMatchObject({ code: "23514" });
    await expect(query("DELETE FROM dropship.dropship_ebay_category_rule_profiles")).rejects.toMatchObject({ code: "23514" });
  });

  it("serializes simultaneous first saves and refuses the lost update", async () => {
    const outcomes = await Promise.allSettled([save("one", SLEEVES.categoryId), save("two", TOPLOADERS.categoryId)]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" }) }),
    ]);
    expect(await counts()).toEqual({ revisions: 1, heads: 1, audits: 1 });
  });

  it("deduplicates concurrent retries and never replays over a later save", async () => {
    const first = await Promise.all([save("same", SLEEVES.categoryId), save("same", SLEEVES.categoryId)]);
    expect(first.filter((result) => result.idempotentReplay)).toHaveLength(1);
    const later = await save("later", TOPLOADERS.categoryId, 1);
    expect((await save("same", SLEEVES.categoryId)).state.revisionId).toBe(later.state.revisionId);
    await expect(save("same", MAILERS.categoryId)).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(await counts()).toEqual({ revisions: 2, heads: 1, audits: 2 });
  });

  it("keeps stores apart and refuses another vendor's store", async () => {
    await save("store-22", SLEEVES.categoryId);
    expect(await service.getForMember("member-1", 24)).toEqual({ revisionId: null, profile: null, updatedAt: null });
    await expect(save("foreign", SLEEVES.categoryId, null, 23)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    await expect(save("store-22", SLEEVES.categoryId, null, 24)).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    await expect(query("UPDATE dropship.dropship_ebay_category_rule_profiles SET vendor_id = 11")).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls back the revision and head when the audit insert fails", async () => {
    await query("ALTER TABLE dropship.dropship_audit_events ADD CONSTRAINT reject_category_audit CHECK (event_type <> 'ebay_category_rules_saved')");
    try {
      await expect(save("audit-failure", SLEEVES.categoryId)).rejects.toMatchObject({ code: "23514" });
      expect(await counts()).toEqual({ revisions: 0, heads: 0, audits: 0 });
    } finally {
      await query("ALTER TABLE dropship.dropship_audit_events DROP CONSTRAINT reject_category_audit");
    }
  });

  it("refuses to point the head back at an older revision or at another store's revision", async () => {
    await save("first", SLEEVES.categoryId);
    await save("second", TOPLOADERS.categoryId, 1);
    await expect(query("UPDATE dropship.dropship_ebay_category_rule_profiles SET revision_id = 1")).rejects.toMatchObject({ code: "23514" });
    await expect(query(`INSERT INTO dropship.dropship_ebay_category_rule_profiles (vendor_id, store_connection_id, revision_id)
      VALUES (10, 24, 1)`)).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a save that adds a rule with the permanent code, writing no revision, head or audit (PR 12, D9, T7)", async () => {
    await save("first", SLEEVES.categoryId);
    const before = await counts();
    await expect(service.saveForMember("member-1", 22, { expectedRevisionId: 1, idempotencyKey: "adds-rule",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [MAILERS_RULE] } }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_GROUP_RULES_CLOSED", context: { kind: "ebay_category", addedIds: ["mailers"] } });
    expect(await counts()).toEqual(before);
    expect(await counts()).toEqual({ revisions: 1, heads: 1, audits: 1 });
    // Nothing was recorded under the key: the same key takes the next request.
    await expect(service.saveForMember("member-1", 22, { expectedRevisionId: 1, idempotencyKey: "adds-rule",
      draft: { defaultCategoryId: TOPLOADERS.categoryId, rules: [] } })).resolves.toMatchObject({ state: { revisionId: 2 } });
  });

  it("refuses a review that adds a rule at the current revision and answers a stale one with the version conflict, writing nothing (PR 12, D9-D10, verify VS5)", async () => {
    const seeded = await seedMailersRule();
    const TOPLOADERS_RULE = { id: "toploaders", name: "Toploaders", scope: { type: "category" as const, category: "Toploaders" },
      categoryId: TOPLOADERS.categoryId };
    const review = (expectedRevisionId: number) => service.reviewForMember("member-1", 22, { expectedRevisionId,
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [MAILERS_RULE, TOPLOADERS_RULE] } });
    const before = await counts();
    await expect(review(seeded)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_GROUP_RULES_CLOSED",
      context: { kind: "ebay_category", addedIds: ["toploaders"], changedIds: [], reordered: false, retryable: false } });
    expect(await counts()).toEqual(before);

    // Another window removes the rule; this tab still sends its draft at the old revision: the conflict (Load latest).
    const later = await service.saveForMember("member-1", 22, { expectedRevisionId: seeded, idempotencyKey: "removes-mailers",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [] } });
    const afterSave = await counts();
    await expect(review(seeded)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    // At the current revision both rules are new.
    await expect(review(later.state.revisionId!)).rejects.toMatchObject({ code: "DROPSHIP_LISTING_GROUP_RULES_CLOSED",
      context: { addedIds: ["mailers", "toploaders"] } });
    expect(await counts()).toEqual(afterSave);
  });

  it("saves the stored rule sent back unchanged with a new store default, and keeps eBay's stored value for it", async () => {
    const seeded = await seedMailersRule();
    const saved = await service.saveForMember("member-1", 22, { expectedRevisionId: seeded, idempotencyKey: "keeps-rule",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [MAILERS_RULE] } });
    expect(saved.state).toMatchObject({ revisionId: seeded + 1, profile: { defaultCategory: SLEEVES, rules: [{ id: "mailers", category: MAILERS }] } });
    expect(await counts()).toEqual({ revisions: 2, heads: 1, audits: 2 });
    // Removing it saves too.
    await expect(service.saveForMember("member-1", 22, { expectedRevisionId: seeded + 1, idempotencyKey: "removes-rule",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [] } })).resolves.toMatchObject({ state: { profile: { rules: [] } } });
  });

  it("answers an old-revision resend of the rules a move emptied with the version conflict, not the refusal (D10)", async () => {
    const seeded = await seedMailersRule();
    // The move: a newer revision with the rules emptied and the default kept.
    const moved = await service.saveForMember("member-1", 22, { expectedRevisionId: seeded, idempotencyKey: "the-move",
      draft: { defaultCategoryId: null, rules: [] } });
    const before = await counts();
    // A tab opened before the move sends the old rule back at the old revision.
    await expect(service.saveForMember("member-1", 22, { expectedRevisionId: seeded, idempotencyKey: "old-tab",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [MAILERS_RULE] } }))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_RULES_VERSION_CONFLICT" });
    // Reloaded, the same rule at the current revision is a new rule.
    await expect(service.saveForMember("member-1", 22, { expectedRevisionId: moved.state.revisionId, idempotencyKey: "old-tab-reloaded",
      draft: { defaultCategoryId: SLEEVES.categoryId, rules: [MAILERS_RULE] } }))
      .rejects.toMatchObject({ code: "DROPSHIP_LISTING_GROUP_RULES_CLOSED" });
    expect(await counts()).toEqual(before);
  });
});
