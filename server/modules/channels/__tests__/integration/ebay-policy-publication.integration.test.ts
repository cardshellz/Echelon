import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../../../inventory-planning/__tests__/fixtures/ebay-publication-inventory.fixture";
import { installPublicationSelectionWorkFixture } from "../../../inventory-planning/__tests__/fixtures/publication-selection-work.fixture";
import { AutomaticSyncEbayProvider, automaticSyncPhotos } from "../fixtures/ebay-automatic-sync-provider.fixture";
import { EbayPolicyCatalogHttp } from "../fixtures/ebay-business-policies.fixture";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null, provider: null as AutomaticSyncEbayProvider | null }));
vi.mock("../../../../db", () => ({ pool: new Proxy({} as Pool, { get(_target, key) {
  if (!runtime.pool) throw new Error("Disposable policy publication pool is unavailable");
  const value = Reflect.get(runtime.pool, key);
  return typeof value === "function" ? value.bind(runtime.pool) : value;
} }), db: {}, getDatabasePoolSnapshot: () => ({ maximumConnections: 4 }) }));
vi.mock("../../infrastructure/ebay-api-runtime", () => ({ EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({ getVerifiedProviderAccount: async () => ({ externalAccountId: "seller-36" }),
    getAccessToken: async () => "synthetic-policy-publication-token", getEnvironment: () => "production" }),
  atpService: { getAtpPerVariant: async (productId: number) => {
    const { createEbayChannelQuantityReader } = await import("../../adapters/ebay/ebay-channel-quantity.reader");
    return createEbayChannelQuantityReader(runtime.pool!).getAtpPerVariant(productId, 67);
  } },
  // This fixture supplies unrelated media and price inputs. Policy resolution,
  // saved publication, identity, stock preparation/admission and journals are real.
  ebayListingPhotoResolver: { resolve: async () => ({ byVariantId: new Map([[101, [...automaticSyncPhotos]]]), groupImageUrls: [...automaticSyncPhotos] }) },
  ebayApiRequest: (method: string, path: string, _token: string, body: unknown) => runtime.provider!.request({ method, path, body }),
  ebayApiRequestWithRateNotify: (method: string, path: string, _token: string, body: unknown) => runtime.provider!.request({ method, path, body }),
}));
vi.mock("../../infrastructure/ebay-listing-helpers", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/ebay-listing-helpers")>(), resolveChannelPriceResolution: async (_db: unknown, _channelId: number, _productId: number, variantId: number) => ({ priceCents: 1149, basePriceCents: 1149, source: "catalog_variant", provenance: { kind: "catalog_variant", variantId }, appliedRule: null }),
}));
vi.mock("../../ebay-listing-sync", () => ({ readExistingEbayListingIdentityForProduct: vi.fn(() => {
  throw new Error("Unpublished policy test must use the publication owner");
}) }));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", async () => {
  const { EbayMarketplaceRegistrationObserver } = await import("../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer");
  return { createEbayMarketplaceRegistrationAdapters: () => {
    const observer = new EbayMarketplaceRegistrationObserver({ loadFreshCredential: async () => ({ accessToken: "synthetic-token", environment: "production" }) },
      { get: async request => ({ status: 200, body: await runtime.provider!.request({ method: "GET", path: request.path }) }) },
      { now: () => new Date("2026-10-18T12:00:00Z") });
    return { observer, inspector: observer };
  } };
});

import { readEbayPublicationSource, prepareEbayPublicationCompletion } from "../../infrastructure/ebay-listing-push";
import { ebayBusinessPolicies } from "../../ebay-business-policies";
import { PostgresEbayListingSyncRepository } from "../../infrastructure/ebay-listing-sync.repository";
import { EbayListingSyncService } from "../../ebay-listing-sync.service";
import { EbayPublicationCompletionExecution } from "../../ebay-publication-completion.service";
import { EbayMarketplaceListingConnector } from "../../listing-connectors/ebay-listing.connector";
import { PgMarketplaceListingRegistrationRepository } from "../../../marketplace-listings/infrastructure/pg-listing-registration.repository";
import { PostgresQuantityProviderResponseRecovery } from "../../../inventory-planning/infrastructure/quantity-provider-response-recovery.repository";
import { ensureEbayPublicationReady } from "../../../inventory-planning/infrastructure/ebay-publication-readiness.repository";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(databaseUrl && disposable ? describe : describe.skip).sequential("current policy correction through a real saved eBay publication", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, cutoverCompositionBaseSql);
    runtime.pool = database.pool;
    await installEbayPublicationInventoryFixture(database.pool, { includePreflightRecoveryMigrations: true, seedPublicationJob: false });
    for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql",
      "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql", "0741_ebay_durable_withdrawal.sql",
      "900000010000018170001_ebay_saved_publication_continuation.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    await installPublicationSelectionWorkFixture(database.pool);
    await database.pool.query(`
      ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS metadata jsonb,ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      -- The admission prerequisite installer supplies the current Catalog and
      -- connection columns from their schemas. Only listing read models need enrichment.
      ALTER TABLE channels.channel_variant_overrides ADD COLUMN weight_override numeric;
      ALTER TABLE channels.channel_listings ADD COLUMN last_synced_price integer,ADD COLUMN last_synced_qty integer,
        ADD COLUMN sync_error text,ADD COLUMN last_synced_at timestamptz,ADD COLUMN updated_at timestamptz;
      ALTER TABLE ebay.ebay_category_mappings ADD COLUMN IF NOT EXISTS ebay_browse_category_id text,ADD COLUMN IF NOT EXISTS ebay_browse_category_name text,
        ADD COLUMN IF NOT EXISTS ebay_store_category_id text,ADD COLUMN IF NOT EXISTS ebay_store_category_name text,ADD COLUMN IF NOT EXISTS fulfillment_policy_override text,
        ADD COLUMN IF NOT EXISTS return_policy_override text,ADD COLUMN IF NOT EXISTS payment_policy_override text,ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now(),
        ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now(),ADD UNIQUE(channel_id,product_type_slug);
      CREATE TABLE ebay.ebay_type_aspect_defaults(product_type_slug text,aspect_name text,aspect_value text);
      CREATE TABLE ebay.ebay_product_aspect_overrides(product_id integer,aspect_name text,aspect_value text);
      CREATE SCHEMA IF NOT EXISTS marketplace;
      CREATE TABLE marketplace.provider_accounts(id integer PRIMARY KEY,owner_kind text,channel_id integer,provider text,account_namespace text,external_account_id text);
      CREATE TABLE marketplace.listing_scopes(id integer PRIMARY KEY,owner_kind text,provider text,marketplace_id text,product_id integer);
      CREATE TABLE marketplace.channel_listing_scopes(scope_id integer,channel_id integer,product_id integer,marketplace_id text);
      CREATE TABLE marketplace.listing_publications(id integer PRIMARY KEY,scope_id integer,status text,external_listing_id text,provider_publication_key text);
      CREATE TABLE marketplace.listing_scope_provider_accounts(scope_id integer,provider_account_id integer);
      CREATE TABLE marketplace.listing_publication_members(id integer PRIMARY KEY,publication_id integer,product_variant_id integer,disposition text,
        sku_snapshot text,external_variant_id text,external_offer_id text,external_inventory_item_id text);
      CREATE TABLE marketplace.provider_identity_claims(provider_account_id integer,scope_id integer,publication_id integer,member_id integer,
        identity_role text,identity_namespace text,external_id text);
      CREATE TABLE marketplace.listing_replacement_operations(scope_id integer,status text);
      CREATE TABLE marketplace.listing_registrations(scope_id integer);
      UPDATE channels.channel_connections SET metadata='{"marketplaceId":"EBAY_US","fulfillmentPolicyId":"store-shipping","returnPolicyId":"store-returns","paymentPolicyId":"store-payment","merchantLocationKey":"main"}' WHERE id=9;
      UPDATE catalog.products SET sku='PACK',name='Current catalog title',description='Description',brand='Shellz',product_type='packs',
        ebay_browse_category_id='183454',ebay_fulfillment_policy_override='deleted-shipping',ebay_return_policy_override='product-returns',
        ebay_payment_policy_override='product-payment' WHERE id=20;
      UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE product_id=20 AND id<>101;
      UPDATE catalog.product_variants SET option1_name='Pack Size',option1_value='5',price_cents=1149,weight_grams=100 WHERE id=101;
      UPDATE channels.channel_listings SET external_sku='P5',external_product_id=NULL,sync_status='pending' WHERE channel_id=67;
      INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,ebay_browse_category_id,listing_enabled) VALUES(67,'packs','183454',true);
    `);
    // Group admission reads the shared archived-member source even when this
    // particular publication contains only active members. Install its actual
    // view and evidence guards, with the reduced owner's missing source columns.
    await database.pool.query(`ALTER TABLE catalog.products ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      ALTER TABLE catalog.product_variants ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
      ALTER TABLE channels.channel_connections ADD COLUMN IF NOT EXISTS shop_domain text;
      ALTER TABLE channels.walmart_connections ADD COLUMN IF NOT EXISTS market text;`);
    for (const file of ["0707_channel_listing_publication.sql", "900000013000018480001_shared_listing_member_lifecycle.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    await ensureEbayPublicationReady(database.pool, { channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production",
      productId: 20, purpose: "publish", variants: [{ productVariantId: 101, sku: "P5" }] },
    { commandKey: randomUUID(), actor: "test-stock-setup", now: new Date() });
  }, 60_000);
  afterAll(async () => { await database?.close(); runtime.pool = null; runtime.provider = null; vi.unstubAllGlobals(); });

  it.each(["price_cents", "compare_at_price_cents"] as const)("rejects unsafe bigint %s before policy or provider requests", async column => {
    const catalog = new EbayPolicyCatalogHttp(); vi.stubGlobal("fetch", catalog.fetch);
    runtime.provider = new AutomaticSyncEbayProvider(() => new Date(), true, ["P5"]);
    await database.pool.query(`UPDATE catalog.product_variants SET ${column}=$1 WHERE id=101`, ["9007199254740992"]);
    try { await expect(readEbayPublicationSource(20)).rejects.toThrow(); }
    finally { await database.pool.query(`UPDATE catalog.product_variants SET ${column}=$1 WHERE id=101`, [column === "price_cents" ? 1149 : null]); }
    expect(catalog.requests).toEqual([]);
    expect(runtime.provider.writes).toEqual([]);
  });

  it("blocks before all mutations, corrects via the policy owner, and completes the same saved publication with current policies", async () => {
    const catalog = new EbayPolicyCatalogHttp(); vi.stubGlobal("fetch", catalog.fetch);
    let timestamp = (await database.pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0].now.getTime() + 1_000;
    const clock = () => new Date(timestamp++);
    runtime.provider = new AutomaticSyncEbayProvider(clock, true, ["P5"]);
    const source = await readEbayPublicationSource(20);
    const store = new PostgresEbayListingSyncRepository(database.pool);
    const registration = new PgMarketplaceListingRegistrationRepository(database.pool);
    const owner = { kind: "channel" as const, channelId: 67, productId: 20, provider: "ebay" as const, marketplaceId: "EBAY_US" };
    const execution = new EbayPublicationCompletionExecution(prepareEbayPublicationCompletion,
      new PostgresQuantityProviderResponseRecovery(database.pool, clock),
      new EbayMarketplaceListingConnector({ delay: async () => {}, inventoryDelayMs: 0, offerDelayMs: 0 }),
      async (_source, inspection, target) => {
        if (inspection.publication) await registration.assertCompatiblePublication({ owner, observation: inspection.publication,
          memberCandidates: [{ productVariantId: 101, sku: "P5", isActive: true, availableQuantity: 17 }] });
        else await registration.assertCompatibleUnpublishedPublication({ owner,
          providerAccount: { provider: "ebay", accountNamespace: "production", externalAccountId: "seller-36" }, groupKey: target.groupKey,
          members: target.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, offerId: member.offerId })) });
      });
    const service = new EbayListingSyncService(store, execution, clock, randomUUID);
    const job = await service.enqueue(source, "user:policy-reviewer", randomUUID(), "publish");
    await service.processDue(1, job.id);
    const blocked = await store.get(job.id);
    expect(blocked, `${blocked.code}: ${blocked.message}`).toMatchObject({ state: "needs_attention", code: "EBAY_POLICY_UNAVAILABLE" });
    expect((await service.get(job.id)).issue?.action?.href).toBe("/channels/ebay#ebay-product-policies-20");
    expect(runtime.provider.writes).toEqual([]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM inventory.quantity_provider_requests")).rows[0].count).toBe(0);

    await ebayBusinessPolicies.patchPolicies({ target: { kind: "product", productId: 20 }, patch: { fulfillmentPolicyId: null }, actor: "user:policy-reviewer" });
    timestamp += 60_000;
    // The existing Sync command resumes the saved publication after correction.
    const retried = await service.enqueue(source, "user:policy-reviewer", randomUUID(), "sync");
    expect(retried.id).toBe(job.id);
    await service.processDue(1, job.id);
    const completed = await store.get(job.id);
    expect(completed, `${completed.code}: ${completed.message}`).toMatchObject({ state: "completed", code: null, operation: "publish" });
    expect(runtime.provider.snapshot().offer).toMatchObject({ status: "PUBLISHED", listingId: "listing-20", availableQuantity: 17,
      listingPolicies: { fulfillmentPolicyId: "store-shipping", returnPolicyId: "product-returns", paymentPolicyId: "product-payment" } });
    expect(runtime.provider.writes.filter(write => write.path === "/sell/inventory/v1/offer/publish_by_inventory_item_group")).toHaveLength(1);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM channels.ebay_listing_sync_jobs")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT actor,changes FROM public.audit_events WHERE action='ebay.business_policies.changed'")).rows)
      .toMatchObject([{ actor: "user:policy-reviewer", changes: { before: { fulfillmentPolicyId: "deleted-shipping" }, after: { fulfillmentPolicyId: null } } }]);
    await service.processDue(1, job.id);
    expect(runtime.provider.writes.filter(write => write.path === "/sell/inventory/v1/offer/publish_by_inventory_item_group")).toHaveLength(1);
  }, 30_000);
});
