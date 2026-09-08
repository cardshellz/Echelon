import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDropshipListingContentRepository } from "../../infrastructure/dropship-listing-content.repository";
import { DropshipListingContentService, type ContentRepository } from "../../application/dropship-listing-content-service";
import { contentCandidate } from "../fixtures/listing-content.fixture";
import { listingCatalogHash } from "../../application/dropship-listing-content-resolver";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-09-07T12:00:00Z");
const target = { storeConnectionId: 22, productVariantId: 101 };
(testUrl && disposable ? describe : describe.skip).sequential("content PostgreSQL guarantees", () => {
  const schema = `dropship_content_${process.pid}`;
  let pool: pg.Pool; let service: DropshipListingContentService; let created = false;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`).replaceAll("catalog.", `"${schema}".`);
  const query = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);
  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) throw new Error("Distinct disposable database required.");
    if (!/^dropship_content_\d+$/.test(schema)) throw new Error("Invalid test schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 6, ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: false } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await query(`
      CREATE TABLE dropship.dropship_vendors (id int PRIMARY KEY, member_id text);
      CREATE TABLE dropship.dropship_store_connections (id int PRIMARY KEY, vendor_id int REFERENCES dropship.dropship_vendors(id), UNIQUE(id,vendor_id));
      CREATE TABLE catalog.products (id int PRIMARY KEY);
      CREATE TABLE catalog.product_variants (id int PRIMARY KEY, product_id int REFERENCES catalog.products(id));
      CREATE TABLE catalog.product_line_products (product_id int);
      CREATE TABLE dropship.dropship_catalog_rules (id int);
      CREATE TABLE dropship.dropship_vendor_selection_rules (id int);
      CREATE TABLE dropship.dropship_vendor_variant_overrides (id int);
      CREATE TABLE dropship.dropship_audit_events (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id int, store_connection_id int, entity_type text, entity_id text, event_type text,
        actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz);
      INSERT INTO dropship.dropship_vendors VALUES (10,'member-1'),(11,'member-2');
      INSERT INTO dropship.dropship_store_connections VALUES (22,10),(23,11),(24,10);
      INSERT INTO catalog.products VALUES (7);
      INSERT INTO catalog.product_variants VALUES (101,7),(102,7);
    `);
    await query(readFileSync(resolve(process.cwd(), "migrations/0660_dropship_vendor_listing_content.sql"), "utf8"));
    const scoped = { connect: async () => { const client = await pool.connect();
      return { query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values), release: () => client.release() }; } } as unknown as Pool;
    const repository = new PgDropshipListingContentRepository(scoped);
    // Exercise real ownership, locking, revisions and audits. Catalog exposure is
    // a deterministic fixture; its separate resolver/service tests cover policy.
    const withCatalogFixture: ContentRepository = { execute: (input, operation) => repository.execute(input, (tx) => operation({
      ...tx, catalog: { ...tx.catalog,
        loadStoreContext: async () => ({ vendorId: tx.vendorId, storeConnectionId: input.storeConnectionId, vendorStatus: "active",
          entitlementStatus: "active", storeStatus: "connected", setupStatus: "ready", platform: "ebay", storeLaunchReady: true }),
        listCatalogCandidates: async (ids) => ids.map((id) => ({ ...contentCandidate(), productVariantId: id })),
        listCatalogExposureRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
        listSelectionRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
        listVariantOverrides: async () => [], listExistingListings: async () => [],
      },
    })) };
    service = new DropshipListingContentService({ repository: withCatalogFixture, clock: { now: () => now }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
  });
  beforeEach(async () => { await query(`TRUNCATE dropship.dropship_listing_content_settings, dropship.dropship_listing_content_revisions,
    dropship.dropship_content_profiles, dropship.dropship_content_profile_revisions, dropship.dropship_audit_events RESTART IDENTITY`); });
  afterAll(async () => { if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool?.end(); });
  function save(key: string, customText: string | null = "My copy", revision: number | null = null, store = 22) {
    return service.saveForMember("member-1", { ...target, storeConnectionId: store }, {
      customText, expectedRevisionId: revision, expectedProfileRevisionId: null,
      expectedCatalogHash: listingCatalogHash(contentCandidate()), idempotencyKey: key,
    });
  }
  async function counts() {
    const result = await query(`SELECT (SELECT count(*)::int FROM dropship.dropship_listing_content_revisions) AS revisions,
      (SELECT count(*)::int FROM dropship.dropship_listing_content_settings) AS settings,
      (SELECT count(*)::int FROM dropship.dropship_audit_events) AS audits`);
    return result.rows[0];
  }
  it("atomically saves immutable history, current pointer, and before/after audit", async () => {
    const first = await save("first");
    expect(first.content.resolved.descriptionHtml).toBe("<p>My copy</p>");
    expect(first.content.resolved.facts).toContainEqual({ name: "SKU", value: "ARM-50" });
    const reloaded = await service.getForMember("member-1", target);
    expect(reloaded.resolved.descriptionHtml).toBe("<p>My copy</p>");
    expect(reloaded.resolved.facts).toEqual(first.content.resolved.facts);
    const second = await save("second", null, first.content.revisionId);
    expect(second.content.customText).toBeNull(); expect(second.content.resolved.source).toBe("catalog");
    expect(await counts()).toEqual({ revisions: 2, settings: 1, audits: 2 });
    const audits = await query("SELECT payload FROM dropship.dropship_audit_events ORDER BY id");
    expect(audits.rows[1].payload).toMatchObject({ before: { customText: "My copy" }, after: { customText: null } });
    await expect(query("UPDATE dropship.dropship_listing_content_revisions SET custom_text='tamper'")).rejects.toMatchObject({ code: "23514" });
    await expect(query("DELETE FROM dropship.dropship_listing_content_settings")).rejects.toMatchObject({ code: "23514" });
  });
  it("serializes simultaneous first saves and refuses lost updates", async () => {
    const outcomes = await Promise.allSettled([save("one", "One"), save("two", "Two")]);
    expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect(await counts()).toEqual({ revisions: 1, settings: 1, audits: 1 });
  });
  it("deduplicates concurrent retries and cannot replay over a later edit", async () => {
    const first = await Promise.all([save("same"), save("same")]);
    expect(first.filter((row) => row.idempotentReplay)).toHaveLength(1);
    const newer = await save("newer", "Newer", first[0].content.revisionId);
    expect((await save("same")).content.revisionId).toBe(newer.content.revisionId);
    expect(await counts()).toEqual({ revisions: 2, settings: 1, audits: 2 });
    await expect(save("same", "Different")).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });
  it("isolates stores and refuses cross-vendor ownership", async () => {
    await save("store-one");
    expect((await service.getForMember("member-1", { ...target, storeConnectionId: 24 })).customText).toBeNull();
    await expect(save("foreign", "Other", null, 23)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    await expect(query("UPDATE dropship.dropship_listing_content_settings SET vendor_id=11")).rejects.toMatchObject({ code: "23514" });
  });
  it("rolls back the revision and pointer when the audit insert fails", async () => {
    await query("ALTER TABLE dropship.dropship_audit_events ADD CONSTRAINT reject_content_audit CHECK (event_type <> 'listing_content_saved')");
    try { await expect(save("audit-failure")).rejects.toMatchObject({ code: "23514" }); expect(await counts()).toEqual({ revisions: 0, settings: 0, audits: 0 }); }
    finally { await query("ALTER TABLE dropship.dropship_audit_events DROP CONSTRAINT reject_content_audit"); }
  });
  it("prevents revision pointer rollback and cross-listing revision references", async () => {
    const first = await save("first"); await save("second", "New", first.content.revisionId);
    await expect(query("UPDATE dropship.dropship_listing_content_settings SET revision_id=$1", [first.content.revisionId])).rejects.toMatchObject({ code: "23514" });
    await expect(query(`INSERT INTO dropship.dropship_listing_content_settings (vendor_id,store_connection_id,product_variant_id,revision_id)
      VALUES (10,22,102,$1)`, [first.content.revisionId])).rejects.toMatchObject({ code: "23503" });
  });
  it("versions templates without per-listing fanout and prevents stale description save after template changes", async () => {
    const profile = { defaultTemplate: { introduction: "Welcome", footer: "Thanks" }, groups: [] };
    const first = await service.saveProfile("member-1", 22, { profile, expectedRevisionId: null, idempotencyKey: "profile" });
    expect((await service.getForMember("member-1", target)).resolved.descriptionText).toContain("Welcome");
    await expect(save("stale-profile")).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    expect((await counts()).revisions).toBe(0);
    expect((await service.saveProfile("member-1", 22, { profile, expectedRevisionId: null, idempotencyKey: "profile" })).idempotentReplay).toBe(true);
    await expect(service.saveProfile("member-1", 22, { profile, expectedRevisionId: null, idempotencyKey: "other" })).rejects.toMatchObject({ code: "DROPSHIP_CONTENT_VERSION_CONFLICT" });
    await expect(query("UPDATE dropship.dropship_content_profile_revisions SET profile='{}'")).rejects.toMatchObject({ code: "23514" });
    expect(first.state.revisionId).toBe(1);
  });
});
