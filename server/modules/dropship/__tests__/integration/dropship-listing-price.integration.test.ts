import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDropshipListingPriceRepository } from "../../infrastructure/dropship-listing-price.repository";
import { PgDropshipListingPreviewRepository } from "../../infrastructure/dropship-listing-preview.repository";
import { PgDropshipPricingRulesRepository } from "../../infrastructure/dropship-pricing-rules.repository";
import type { StoredPricingReview } from "../../application/dropship-pricing-rules-service";
import type { CreateDropshipListingPushJobRepositoryInput } from "../../application/dropship-listing-preview-service";
import type { SaveListingPriceInput } from "../../../../../shared/dropship/listing-price";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const now = new Date("2026-09-06T16:00:00.000Z");

describeDatabase.sequential("listing price PostgreSQL transaction guarantees", () => {
  const schema = `dropship_listing_price_${process.pid}`;
  let pool: pg.Pool | undefined;
  let repository: PgDropshipListingPriceRepository;
  let previews: PgDropshipListingPreviewRepository;
  let pricingRules: PgDropshipPricingRulesRepository;
  let created = false;
  const qualify = (sql: string) => sql.replaceAll("dropship.", `"${schema}".`).replaceAll("catalog.", `"${schema}".`);
  beforeAll(async () => {
    if (!testUrl || !disposable || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(testUrl)) {
      throw new Error("Listing-price tests require a distinct explicitly disposable PostgreSQL database.");
    }
    if (!/^dropship_listing_price_\d+$/.test(schema)) throw new Error("Invalid isolated schema.");
    pool = new pg.Pool({ connectionString: testUrl, max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(testUrl) ? false : { rejectUnauthorized: false } });
    await pool.query(`CREATE SCHEMA "${schema}"`); created = true;
    await pool.query(qualify(`
      CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY, member_id text);
      CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY, vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id));
      CREATE TABLE catalog.products (id integer PRIMARY KEY);
      CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer REFERENCES catalog.products(id));
      CREATE TABLE catalog.product_line_products (product_id integer);
      CREATE TABLE dropship.dropship_catalog_rules (id integer);
      CREATE TABLE dropship.dropship_vendor_selection_rules (id integer);
      CREATE TABLE dropship.dropship_vendor_variant_overrides (id integer);
      CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, entity_type text, entity_id text,
        event_type text, actor_type text, actor_id text, severity text, payload jsonb, created_at timestamptz);
      CREATE TABLE dropship.dropship_listing_push_jobs (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, job_type text, status text, requested_scope jsonb,
        requested_by text, idempotency_key text, request_hash text, error_message text, created_at timestamptz, updated_at timestamptz);
      CREATE TABLE dropship.dropship_vendor_listings (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        vendor_id integer, store_connection_id integer, product_variant_id integer, platform text, status text,
        vendor_retail_price_cents integer, pushed_quantity integer, quantity_cap integer, last_preview_hash text,
        metadata jsonb, created_at timestamptz, updated_at timestamptz, UNIQUE(store_connection_id,product_variant_id));
      CREATE TABLE dropship.dropship_listing_push_job_items (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        job_id integer, listing_id integer, product_variant_id integer, action text, status text, preview_hash text,
        error_code text, error_message text, result jsonb, idempotency_key text, created_at timestamptz, updated_at timestamptz);
      INSERT INTO dropship.dropship_vendors VALUES (10,'member-1'), (11,'member-2');
      INSERT INTO dropship.dropship_store_connections VALUES (22,10), (23,11);
      INSERT INTO catalog.products VALUES (7);
      INSERT INTO catalog.product_variants VALUES (101,7), (102,7);
    `));
    await pool.query(qualify(readFileSync(resolve(process.cwd(), "migrations/0657_dropship_listing_price_settings.sql"), "utf8")));
    await pool.query(qualify(readFileSync(resolve(process.cwd(), "migrations/0659_dropship_store_pricing_rules.sql"), "utf8")));
    const scopedPool = { connect: async () => { const client = await pool!.connect();
      return { query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values), release: () => client.release() }; } } as unknown as Pool;
    repository = new PgDropshipListingPriceRepository(scopedPool);
    previews = new PgDropshipListingPreviewRepository(scopedPool);
    pricingRules = new PgDropshipPricingRulesRepository(scopedPool);
  });
  beforeEach(async () => { await pool!.query(qualify(`TRUNCATE dropship.dropship_listing_price_settings,
    dropship.dropship_listing_price_revisions, dropship.dropship_audit_events,
    dropship.dropship_listing_push_jobs, dropship.dropship_vendor_listings,
    dropship.dropship_listing_push_job_items, dropship.dropship_pricing_profiles,
    dropship.dropship_pricing_profile_revisions, dropship.dropship_pricing_reviews,
    dropship.dropship_pricing_applications RESTART IDENTITY`)); });
  afterAll(async () => { if (created && pool) await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool?.end(); });

  function save(key: string, priceCents: number | null = 1299, expectedRevisionId: number | null = null, variant = 101, store = 22) {
    const input: SaveListingPriceInput = { idempotencyKey: key, priceCents, expectedRevisionId };
    return repository.execute({ memberId: "member-1", storeConnectionId: store, productVariantId: variant, idempotencyKey: key },
      (tx) => tx.save({ ...input, now, requestHash: createHash("sha256").update(JSON.stringify({ ...input, variant, store })).digest("hex") }));
  }
  async function state() {
    const settings = await pool!.query(qualify("SELECT * FROM dropship.dropship_listing_price_settings ORDER BY product_variant_id"));
    const revisions = await pool!.query(qualify("SELECT * FROM dropship.dropship_listing_price_revisions ORDER BY id"));
    const audits = await pool!.query(qualify("SELECT payload FROM dropship.dropship_audit_events ORDER BY id"));
    return { settings: settings.rows, revisions: revisions.rows, audits: audits.rows };
  }
  function ruleReview(ids = [101, 102]): StoredPricingReview {
    return { id: "a1d45010-ded1-4428-a5c4-67367f8f5f39", createdAt: now, hash: "a".repeat(64),
      input: { expectedRevisionId: null, releaseFixedOverrides: false,
        profile: { defaultRecipe: { basis: "product_cost", markupBps: 3000, flatCents: 100, rounding: "cent" }, groups: [] } },
      rows: ids.map((productVariantId) => ({ productVariantId, title: "Mailer", sku: `SKU-${productVariantId}`,
        previousPriceCents: 899, priceCents: 1152, productCostCents: 809, ruleName: "Store default rule", preserved: false,
        issues: [], settingRevisionId: null, evidenceHash: "b".repeat(64) })) };
  }
  async function storeRuleReview(review: StoredPricingReview) {
    await pricingRules.execute("member-1", 22, (tx) => tx.storeReview(review));
  }
  async function applyRuleReview(review: StoredPricingReview, key = "rule-apply") {
    const input = { reviewId: review.id, reviewHash: review.hash, idempotencyKey: key };
    return pricingRules.execute("member-1", 22, async (tx) => {
      const replay = await tx.findApplication(input);
      return replay ? { ...replay, replay: true } : { revisionId: await tx.applyReview(review, input, now), replay: false };
    });
  }
  it("adopts 1,000 rule-owned listings atomically using the real migration and repository", async () => {
    await pool!.query(qualify("INSERT INTO catalog.product_variants (id, product_id) SELECT x,7 FROM generate_series(103,1100) x ON CONFLICT DO NOTHING"));
    const review = ruleReview(Array.from({ length: 1000 }, (_, index) => index + 101));
    await storeRuleReview(review);
    expect(await applyRuleReview(review)).toEqual({ revisionId: 1, replay: false });
    const result = await state();
    expect(result.settings).toHaveLength(1000); expect(result.revisions).toHaveLength(1000);
    expect(result.settings.every((row) => row.pricing_mode === "rules" && row.override_price_cents === null)).toBe(true);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0].payload).toMatchObject({ adoptedCount: 1000, preservedCount: 0, marketplaceWrite: false });
    const current = await pricingRules.execute("member-1", 22, (tx) => tx.loadProfile());
    expect(current).toMatchObject({ revisionId: 1, profile: review.input.profile });
  });
  it("keeps fixed exceptions and records rule inheritance as a distinct setting", async () => {
    await save("fixed-exception", 1999);
    const review = ruleReview(); review.rows[0] = { ...review.rows[0], preserved: true, settingRevisionId: 1 };
    await storeRuleReview(review); await applyRuleReview(review);
    const result = await state();
    expect(result.settings[0]).toMatchObject({ product_variant_id: 101, pricing_mode: "fixed", override_price_cents: 1999 });
    expect(result.settings[1]).toMatchObject({ product_variant_id: 102, pricing_mode: "rules", override_price_cents: null });
  });
  it("replays rule approval without duplicate revisions or audit entries", async () => {
    const review = ruleReview(); await storeRuleReview(review); await applyRuleReview(review);
    const before = await state();
    expect(await applyRuleReview(review)).toEqual({ revisionId: 1, replay: true });
    expect(await state()).toEqual(before);
    await expect(applyRuleReview(review, "different-key")).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
  });
  it("rolls back profile, bindings and application when the audit cannot be recorded", async () => {
    const review = ruleReview(); await storeRuleReview(review);
    await pool!.query(qualify("ALTER TABLE dropship.dropship_audit_events ADD CONSTRAINT reject_rule_audit CHECK (event_type <> 'pricing_rules_applied')"));
    try {
      await expect(applyRuleReview(review)).rejects.toMatchObject({ code: "23514" });
      expect(await state()).toEqual({ settings: [], revisions: [], audits: [] });
      expect((await pool!.query(qualify("SELECT * FROM dropship.dropship_pricing_profiles"))).rows).toHaveLength(0);
      expect((await pool!.query(qualify("SELECT * FROM dropship.dropship_pricing_applications"))).rows).toHaveLength(0);
    } finally { await pool!.query(qualify("ALTER TABLE dropship.dropship_audit_events DROP CONSTRAINT reject_rule_audit")); }
  });
  it("enforces immutable rule evidence and exact price-mode coherence", async () => {
    const review = ruleReview(); await storeRuleReview(review); await applyRuleReview(review);
    for (const table of ["dropship_pricing_reviews", "dropship_pricing_profile_revisions", "dropship_pricing_applications"]) {
      await expect(pool!.query(qualify(`DELETE FROM dropship.${table}`))).rejects.toMatchObject({ code: "23514" });
    }
    await expect(pool!.query(qualify("UPDATE dropship.dropship_listing_price_settings SET pricing_mode = 'catalog_default' WHERE product_variant_id = 101")))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pool!.query(qualify("UPDATE dropship.dropship_pricing_profiles SET revision_id = revision_id"))).resolves.toBeDefined();
  });
  it("isolates reviews and profiles by vendor and store", async () => {
    const review = ruleReview(); await storeRuleReview(review);
    expect(await pricingRules.execute("member-2", 23, (tx) => tx.loadReview(review.id))).toBeNull();
    const operation = vi.fn();
    await expect(pricingRules.execute("member-2", 22, operation)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(operation).not.toHaveBeenCalled();
  });
  it("allows only one of two concurrent rule approvals and safely retries the winner", async () => {
    const review = ruleReview(); await storeRuleReview(review);
    const results = await Promise.allSettled([applyRuleReview(review), applyRuleReview(review)]);
    expect(results.some((row) => row.status === "fulfilled")).toBe(true);
    expect((await state()).revisions).toHaveLength(2);
    expect(await applyRuleReview(review)).toEqual({ revisionId: 1, replay: true });
    expect((await state()).audits).toHaveLength(1);
  });
  it("persists a reset as a real current revision with before/after audit", async () => {
    const first = await save("first"); await save("reset", null, first.saved.revisionId);
    const result = await state();
    expect(result.settings[0]).toMatchObject({ override_price_cents: null, revision_id: 2 });
    expect(result.revisions).toHaveLength(2);
    expect(result.audits[1].payload).toMatchObject({ before: { overridePriceCents: 1299 }, after: { overridePriceCents: null } });
  });
  it("allows one writer for concurrent first saves and rejects the stale writer", async () => {
    const result = await Promise.allSettled([save("one"), save("two", 1599)]);
    expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const rejected = result.find((row) => row.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    expect((await state()).revisions).toHaveLength(1);
  });
  it("serializes identical retries to one revision and one audit", async () => {
    const result = await Promise.all([save("same"), save("same")]);
    expect(result.map((row) => row.idempotentReplay).sort()).toEqual([false, true]);
    expect((await state()).audits).toHaveLength(1);
  });
  it("rejects key reuse for a different price or variant", async () => {
    await save("reuse"); const before = await state();
    await expect(save("reuse", 1599)).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    await expect(save("reuse", 1299, null, 102)).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("replays an old revision without overwriting a newer edit", async () => {
    const original = await save("original"); await save("newer", 1599, original.saved.revisionId);
    const before = await state(); const replay = await save("original");
    expect(replay).toMatchObject({ idempotentReplay: true, saved: { overridePriceCents: 1299 } });
    expect(await state()).toEqual(before);
  });
  it("rolls back setting and revision if audit insertion fails", async () => {
    await pool!.query(qualify("ALTER TABLE dropship.dropship_audit_events ADD CONSTRAINT reject_audit CHECK (event_type <> 'listing_price_saved')"));
    try { await expect(save("audit-fail")).rejects.toMatchObject({ code: "23514" });
      expect(await state()).toEqual({ settings: [], revisions: [], audits: [] });
    } finally { await pool!.query(qualify("ALTER TABLE dropship.dropship_audit_events DROP CONSTRAINT reject_audit")); }
  });
  it("rejects another vendor's store before invoking transaction operations", async () => {
    const operation = vi.fn();
    await expect(repository.execute({ memberId: "member-1", storeConnectionId: 23, productVariantId: 101 }, operation))
      .rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_REQUIRED" });
    expect(operation).not.toHaveBeenCalled();
  });
  it("enforces revision immutability and projection coherence in PostgreSQL", async () => {
    await save("immutable");
    await expect(pool!.query(qualify("UPDATE dropship.dropship_listing_price_settings SET updated_at = updated_at"))).resolves.toBeDefined();
    await expect(pool!.query(qualify("UPDATE dropship.dropship_listing_price_revisions SET override_price_cents = 1"))).rejects.toMatchObject({ code: "23514" });
    await expect(pool!.query(qualify("DELETE FROM dropship.dropship_listing_price_revisions"))).rejects.toMatchObject({ code: "23514" });
    await expect(pool!.query(qualify("UPDATE dropship.dropship_listing_price_settings SET override_price_cents = 1"))).rejects.toMatchObject({ code: "23514" });
    await expect(pool!.query(qualify("DELETE FROM dropship.dropship_listing_price_settings"))).rejects.toMatchObject({ code: "23514" });
  });
  it("cannot link a price revision to a different store owner or product", async () => {
    await save("lineage");
    await expect(pool!.query(qualify(`INSERT INTO dropship.dropship_listing_price_settings
      (vendor_id,store_connection_id,product_variant_id,revision_id,override_price_cents,updated_at)
      VALUES (11,23,102,1,1299,$1)`), [now])).rejects.toMatchObject({ code: "23514" });
  });
  it("cannot move a current setting to another target even with a valid target revision", async () => {
    await save("first-target");
    const revision = await pool!.query(qualify(`INSERT INTO dropship.dropship_listing_price_revisions
      (vendor_id,store_connection_id,product_variant_id,override_price_cents,idempotency_key,request_hash,actor_id,created_at)
      VALUES (10,22,102,1299,'new-target',$1,'member-1',$2) RETURNING id`), ["a".repeat(64), now]);
    await expect(pool!.query(qualify(`UPDATE dropship.dropship_listing_price_settings
      SET product_variant_id=102, revision_id=$1 WHERE product_variant_id=101`), [revision.rows[0].id]))
      .rejects.toMatchObject({ code: "23514" });
    expect((await state()).settings[0].product_variant_id).toBe(101);
  });
  it("blocks a price save that occurred after preview generation but before queue transaction", async () => {
    const first = await save("before-preview");
    await save("after-preview", 1599, first.saved.revisionId);
    await expect(previews.createListingPushJob(queueInput(first.saved.revisionId))).rejects.toMatchObject({ code: "DROPSHIP_LISTING_PRICE_VERSION_CONFLICT" });
    expect((await pool!.query(qualify("SELECT * FROM dropship.dropship_listing_push_jobs"))).rows).toEqual([]);
  });
  it("saves do not rewrite an already queued publication snapshot or applied listing price", async () => {
    const first = await save("queue-price");
    await previews.createListingPushJob(queueInput(first.saved.revisionId));
    await save("later-local-draft", 1999, first.saved.revisionId);
    const item = await pool!.query(qualify("SELECT result FROM dropship.dropship_listing_push_job_items"));
    const listing = await pool!.query(qualify("SELECT vendor_retail_price_cents FROM dropship.dropship_vendor_listings"));
    expect(item.rows[0].result.listingIntent.priceCents).toBe(1299);
    expect(listing.rows[0].vendor_retail_price_cents).toBe(1299);
    expect((await state()).settings[0].override_price_cents).toBe(1999);
  });
});

function queueInput(revisionId: number): CreateDropshipListingPushJobRepositoryInput {
  return { vendorId: 10, storeConnectionId: 22, platform: "ebay", productVariantIds: [101],
    requestedRetailPricesByVariantId: {}, idempotencyKey: "queue-price-snapshot", requestHash: "queue-hash",
    requestedBy: { actorType: "vendor", actorId: "member-1" }, now,
    preview: { vendorId: 10, storeConnectionId: 22, platform: "ebay", generatedAt: now,
      summary: { total: 1, ready: 1, blocked: 0, warning: 0 },
      rows: [{ productVariantId: 101, productId: 7, priceSettingRevisionId: revisionId,
        priceCents: 1299, marketplaceQuantity: 2, previewStatus: "ready", blockers: [], warnings: [],
        listingMode: "draft_first", previewHash: "preview-hash", businessPolicySelection: null,
        listingIntent: { priceCents: 1299 } } as CreateDropshipListingPushJobRepositoryInput["preview"]["rows"][number]],
    } };
}
