import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../../../inventory-planning/__tests__/fixtures/ebay-publication-inventory.fixture";
import { reviewEbayPublicationReadiness } from "../../../inventory-planning/infrastructure/ebay-publication-readiness.repository";
import { PostgresEbayPublicationStockRepository } from "../../infrastructure/ebay-publication-stock.repository";
import { PostgresEbayListingPushRepository } from "../../infrastructure/ebay-listing-push.repository";
import { EbayPublicationStockService, type EbayStockPublicationSource } from "../../ebay-publication-stock.service";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../../ebay-listing-workflow-lock";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(enabled ? describe : describe.skip).sequential("stock enrollment and durable publication atomic composition", () => {
  let database: InventoryCutoverTestDatabase;
  let store: PostgresEbayPublicationStockRepository;
  let service: EbayPublicationStockService;
  let preparedGroup: string | null;
  const now = new Date("2026-10-12T12:00:00Z");
  const inventorySource = { channelId: 67, connectionId: 9, productId: 20, accountId: "seller-36", environment: "production" as const,
    variants: [{ productVariantId: 101, sku: "P5" }] };
  async function readSource(productId: number, client: PoolClient): Promise<EbayListingSyncIdentity> {
    const repository = new PostgresEbayListingPushRepository(database.pool, 67, () => now, () => 20);
    await repository.readProduct(productId, client);
    const variants = await repository.readVariants(productId, client);
    const account = (await client.query("SELECT external_account_id FROM ebay.ebay_oauth_tokens WHERE channel_id=67")).rows[0];
    return { channelId: 67, connectionId: 9, productId, accountId: account.external_account_id, marketplaceId: "EBAY_US", groupKey: null,
      variants: variants.map(member => ({ variantId: member.id, sku: member.sku, catalogSku: member.catalog_sku,
        externalSku: member.external_sku, offerId: member.external_variant_id, listingId: member.external_product_id,
        mappingExists: member.mapping_exists, contentSyncEnabled: true })) };
  }
  async function prepare(): Promise<EbayStockPublicationSource> {
    const client = await database.pool.connect();
    try {
      const identity = await readSource(20, client);
      return { sourceIdentity: identity, targetIdentity: { ...identity, groupKey: preparedGroup,
        variants: identity.variants.map(member => ({ ...member, externalSku: member.sku })) }, productName: "Test stock", inventorySource,
        inspection: { providerAccount: { provider: "ebay", accountNamespace: "production", externalAccountId: "seller-36", identityScheme: "provider_user_id",
          externalDisplayNameSnapshot: null, evidenceHash: "a".repeat(64) }, observedAt: now, skus: [], publication: null,
          publicationIssue: null, groupKey: null, groupSkus: null } };
    } finally { client.release(); }
  }
  const command = async () => ({ commandKey: randomUUID(), expectedReviewHash: (await service.review(20)).reviewHash });
  const counts = async () => (await database.pool.query(`SELECT
    (SELECT count(*)::int FROM inventory.publication_variant_mapping_heads WHERE publication_target_id=3) AS mappings,
    (SELECT count(*)::int FROM inventory.publication_membership_heads WHERE publication_target_id=3) AS members,
    (SELECT count(*)::int FROM inventory.ebay_publication_readiness_applications) AS receipts,
    (SELECT count(*)::int FROM channels.ebay_listing_sync_jobs) AS jobs`)).rows[0];
  beforeEach(async () => {
    preparedGroup = null;
    database = await createInventoryCutoverTestDatabase(url, true, cutoverCompositionBaseSql);
    await installEbayPublicationInventoryFixture(database.pool);
    await database.pool.query(`
      ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS product_type text, ADD COLUMN IF NOT EXISTS description text, ADD COLUMN IF NOT EXISTS brand text,
        ADD COLUMN IF NOT EXISTS ebay_browse_category_id text, ADD COLUMN IF NOT EXISTS ebay_fulfillment_policy_override text, ADD COLUMN IF NOT EXISTS ebay_return_policy_override text,
        ADD COLUMN IF NOT EXISTS ebay_payment_policy_override text, ADD COLUMN IF NOT EXISTS ebay_listing_excluded boolean DEFAULT false;
      ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS position integer DEFAULT 0, ADD COLUMN IF NOT EXISTS option1_name text, ADD COLUMN IF NOT EXISTS option1_value text,
        ADD COLUMN IF NOT EXISTS option2_name text, ADD COLUMN IF NOT EXISTS option2_value text, ADD COLUMN IF NOT EXISTS price_cents integer, ADD COLUMN IF NOT EXISTS compare_at_price_cents integer,
        ADD COLUMN IF NOT EXISTS weight_grams numeric, ADD COLUMN IF NOT EXISTS barcode text, ADD COLUMN IF NOT EXISTS ebay_listing_excluded boolean DEFAULT false,
        ADD COLUMN IF NOT EXISTS ebay_fulfillment_policy_override text, ADD COLUMN IF NOT EXISTS ebay_return_policy_override text, ADD COLUMN IF NOT EXISTS ebay_payment_policy_override text;
      ALTER TABLE channels.channel_variant_overrides ADD COLUMN IF NOT EXISTS id integer GENERATED ALWAYS AS IDENTITY,
        ADD COLUMN IF NOT EXISTS is_listed integer, ADD COLUMN IF NOT EXISTS weight_override numeric;
      CREATE TABLE channels.channel_product_overrides(id integer GENERATED ALWAYS AS IDENTITY,channel_id integer,product_id integer,is_listed integer);
      CREATE TABLE ebay.ebay_category_mappings(id integer GENERATED ALWAYS AS IDENTITY,channel_id integer,product_type_slug text);
      ALTER TABLE channels.channel_listings ADD COLUMN IF NOT EXISTS external_variant_id text, ADD COLUMN IF NOT EXISTS external_product_id text;
      UPDATE channels.channel_listings SET external_variant_id='offer-101';
      UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id<>101;
      CREATE SCHEMA marketplace;
      CREATE TABLE marketplace.provider_accounts(id integer PRIMARY KEY,owner_kind text,channel_id integer,provider text,account_namespace text,external_account_id text);
      CREATE TABLE marketplace.listing_scopes(id integer PRIMARY KEY,owner_kind text,provider text,marketplace_id text,product_id integer);
      CREATE TABLE marketplace.channel_listing_scopes(scope_id integer,channel_id integer,product_id integer,marketplace_id text);
      CREATE TABLE marketplace.listing_publications(id integer PRIMARY KEY,scope_id integer,status text,external_listing_id text,provider_publication_key text);
      CREATE TABLE marketplace.provider_identity_claims(provider_account_id integer,identity_namespace text,external_id text);
      CREATE TABLE marketplace.listing_replacement_operations(scope_id integer,status text);
      CREATE TABLE marketplace.listing_registrations(scope_id integer);
    `);
    const migration = readFileSync(resolve("migrations/0729_ebay_listing_sync_recovery.sql"), "utf8");
    await database.pool.query(migration.slice(migration.indexOf("CREATE TABLE channels.ebay_listing_sync_jobs"), migration.indexOf("CREATE TRIGGER publication_response_recoveries_no_truncate")));
    for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql", "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql", "0741_ebay_durable_withdrawal.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    store = new PostgresEbayPublicationStockRepository(database.pool, 67, readSource);
    service = new EbayPublicationStockService({ channelId: 67, prepare,
      reviewInventory: source => reviewEbayPublicationReadiness(database.pool, source), findApplied: input => store.findApplied(input),
      commit: input => store.commit(input), reject: input => store.reject(input), now: () => now });
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  it("saves the real publication job, stock mapping and membership in one transaction, replaying after source changes", async () => {
    const request = await command(); const result = await service.apply(20, "operator", request);
    expect(result).toMatchObject({ replayed: false, job: { operation: "publish", state: "queued" } });
    expect(await counts()).toEqual({ mappings: 1, members: 1, receipts: 1, jobs: 1 });
    await database.pool.query("UPDATE catalog.products SET ebay_listing_excluded=true WHERE id=20");
    expect(await service.apply(20, "operator", request)).toMatchObject({ replayed: true, job: { id: result.job.id } });
    await expect(service.apply(20, "other", request)).rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT" });
  });
  it("rolls everything back if the actual queue insert fails", async () => {
    const request = await command();
    await database.pool.query(`CREATE FUNCTION fail_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'job unavailable'; END $$;
      CREATE TRIGGER fail_job BEFORE INSERT ON channels.ebay_listing_sync_jobs FOR EACH ROW EXECUTE FUNCTION fail_job();`);
    await expect(service.apply(20, "operator", request)).rejects.toThrow("job unavailable");
    expect(await counts()).toEqual({ mappings: 0, members: 0, receipts: 0, jobs: 0 });
    expect(await service.getReceipt(20, request.commandKey)).toBeNull();
    await database.pool.query("DROP TRIGGER fail_job ON channels.ebay_listing_sync_jobs");
    expect(await service.apply(20, "operator", request)).toMatchObject({ job: { state: "queued" } });
  });
  it("converges concurrent clicks on one durable job and preserves raw saved SKU identity", async () => {
    const request = await command();
    const results = await Promise.all([service.apply(20, "operator", request), service.apply(20, "operator", request)]);
    expect(new Set(results.map(row => row.job.id)).size).toBe(1);
    expect(await counts()).toEqual({ mappings: 1, members: 1, receipts: 1, jobs: 1 });
    expect((await database.pool.query("SELECT identity FROM channels.ebay_listing_sync_jobs")).rows[0].identity.variants[0])
      .toMatchObject({ externalSku: null, offerId: "offer-101", mappingExists: true });
  });
  it("pins the reviewed preparation target and recovers it without guessing the catalog group", async () => {
    preparedGroup = "original-ebay-group";
    const request = await command();
    await service.apply(20, "operator", request);
    const saved = (await database.pool.query("SELECT identity,publication_target,provider_identity,publication_accepted FROM channels.ebay_listing_sync_jobs")).rows[0];
    expect(saved.identity.variants[0].externalSku).toBeNull();
    expect(saved.publication_target).toMatchObject({ groupKey: preparedGroup, variants: [{ sku: "P5", externalSku: "P5", offerId: "offer-101" }] });
    expect(saved.provider_identity).toBeNull();
    expect(saved.publication_accepted).toBeNull();
    expect(await store.readPreparationTarget((await prepare()).sourceIdentity)).toEqual(saved.publication_target);
    const changed = structuredClone((await prepare()).sourceIdentity);
    changed.variants[0].sku = "different-sku";
    await expect(store.readPreparationTarget(changed)).rejects.toMatchObject({ code: "EBAY_SYNC_IDENTITY_CHANGED" });
  });
  it("does not wait for a provider worker while holding the inventory fence", async () => {
    const request = await command(); const worker = await database.pool.connect();
    try {
      await worker.query("SELECT pg_advisory_lock($1,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey(67, 20)]);
      await expect(service.apply(20, "operator", request)).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
      expect(await counts()).toEqual({ mappings: 0, members: 0, receipts: 0, jobs: 0 });
    } finally { await worker.query("SELECT pg_advisory_unlock_all()"); worker.release(); }
    expect(await service.apply(20, "operator", request)).toMatchObject({ job: { state: "queued" } });
  });
  it("durably refuses a stale stock review, leaving no partial setup", async () => {
    const request = await command();
    await database.pool.query("UPDATE inventory.inventory_levels SET variant_qty=variant_qty+1 WHERE product_variant_id=101");
    await expect(service.apply(20, "operator", request)).rejects.toMatchObject({ code: "EBAY_PUBLICATION_STOCK_REVIEW_STALE", definitiveRejected: true });
    await expect(service.getReceipt(20, request.commandKey)).rejects.toMatchObject({ definitiveRejected: true });
    expect(await counts()).toEqual({ mappings: 0, members: 0, receipts: 0, jobs: 0 });
  });
});
