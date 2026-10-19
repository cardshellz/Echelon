import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { AutomaticSyncEbayProvider } from "../fixtures/ebay-automatic-sync-provider.fixture";
import { EbayPolicyCatalogHttp, providerPolicyCatalog } from "../fixtures/ebay-business-policies.fixture";

const runtime = vi.hoisted(() => ({ pool: null as Pool | null, provider: null as AutomaticSyncEbayProvider | null }));
vi.mock("../../../../db", () => ({
  pool: new Proxy({} as Pool, { get(_target, key) {
    if (!runtime.pool) throw new Error("Disposable policy-source database is not initialized.");
    const value = Reflect.get(runtime.pool, key);
    return typeof value === "function" ? value.bind(runtime.pool) : value;
  } }),
  db: {}, getDatabasePoolSnapshot: () => ({ maximumConnections: 10 }),
}));
// Policy/configuration reads, source capture, provider observation, draft building
// and hashing are production code. Unrelated ATP, media and pricing inputs are
// deterministic fixtures; durable job/journal recovery has its own PG suite.
vi.mock("../../infrastructure/ebay-api-runtime", () => ({
  EBAY_CHANNEL_ID: 67,
  getAuthService: () => ({
    getVerifiedProviderAccount: async () => ({ externalAccountId: "seller-36" }),
    getAccessToken: async () => "synthetic-policy-source-token", getEnvironment: () => "production",
  }),
  atpService: { getAtpPerVariant: async () => [
    { productVariantId: 101, atpUnits: 17 }, { productVariantId: 102, atpUnits: 23 },
  ] },
  ebayListingPhotoResolver: { resolve: async () => ({
    byVariantId: new Map([[101, ["https://example.test/current.jpg"]], [102, ["https://example.test/current.jpg"]]]),
    groupImageUrls: ["https://example.test/current.jpg"],
  }) },
  ebayApiRequest: (method: string, path: string, _token: string, body: unknown) => runtime.provider!.request({ method, path, body }),
  ebayApiRequestWithRateNotify: (method: string, path: string, _token: string, body: unknown) => runtime.provider!.request({ method, path, body }),
}));
vi.mock("../../infrastructure/ebay-listing-helpers", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/ebay-listing-helpers")>(),
  resolveChannelPrice: async () => 1149,
}));
vi.mock("../../ebay-listing-sync", () => ({ readExistingEbayListingIdentityForProduct: vi.fn(() => {
  throw new Error("Unpublished preparation must not use the published-listing reader.");
}) }));
vi.mock("../../adapters/ebay/ebay-marketplace-registration.factory", async () => {
  const { EbayMarketplaceRegistrationObserver } = await import("../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer");
  return { createEbayMarketplaceRegistrationAdapters: () => {
    const observer = new EbayMarketplaceRegistrationObserver({
      loadFreshCredential: async () => ({ accessToken: "synthetic-policy-source-token", environment: "production" }),
    }, { get: async request => ({ status: 200, body: await runtime.provider!.request({ method: "GET", path: request.path }) }) },
    { now: () => new Date("2026-10-18T12:00:00Z") });
    return { observer, inspector: observer };
  } };
});

import { prepareEbayPublicationCompletion, readEbayPublicationSource } from "../../infrastructure/ebay-listing-push";
import { assertEbayListingSourceIdentityUnchanged } from "../../ebay-existing-listing-identity";
import { syncContentIntentHash } from "../../ebay-listing-sync-content";
import { ebayBusinessPolicies } from "../../ebay-business-policies";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(databaseUrl && disposable ? describe : describe.skip).sequential("eBay policy correction through PostgreSQL publication preparation", () => {
  let database: InventoryCutoverTestDatabase;
  let catalog: EbayPolicyCatalogHttp;
  beforeEach(async () => {
    catalog = new EbayPolicyCatalogHttp();
    vi.stubGlobal("fetch", catalog.fetch);
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, `
      CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay;
      CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer,metadata jsonb,updated_at timestamptz DEFAULT now());
      CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer,environment text,external_account_id text,
        external_account_identity_scheme text,external_account_verified_at timestamptz);
      CREATE TABLE catalog.products(id integer PRIMARY KEY,name text,sku text,description text,brand text,product_type text,
        ebay_browse_category_id text,ebay_fulfillment_policy_override text,ebay_return_policy_override text,
        ebay_payment_policy_override text,ebay_listing_excluded boolean,is_active boolean,updated_at timestamptz DEFAULT now());
      CREATE TABLE channels.channel_product_overrides(product_id integer,channel_id integer,is_listed integer);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products,sku text,name text,
        option1_name text,option1_value text,option2_name text,option2_value text,price_cents integer,compare_at_price_cents integer,
        weight_grams numeric,barcode text,ebay_fulfillment_policy_override text,ebay_return_policy_override text,
        ebay_payment_policy_override text,is_active boolean,sales_eligibility text,ebay_listing_excluded boolean,position integer,updated_at timestamptz DEFAULT now());
      CREATE TABLE channels.channel_variant_overrides(product_variant_id integer,channel_id integer,weight_override numeric,is_listed integer);
      CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer REFERENCES catalog.product_variants,
        external_product_id text,external_variant_id text,external_sku text,PRIMARY KEY(channel_id,product_variant_id));
      CREATE TABLE ebay.ebay_category_mappings(channel_id integer,product_type_slug text,ebay_browse_category_id text,
        ebay_store_category_name text,listing_enabled boolean,fulfillment_policy_override text,return_policy_override text,payment_policy_override text,
        ebay_browse_category_name text,ebay_store_category_id text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        UNIQUE(channel_id,product_type_slug));
      CREATE TABLE ebay.ebay_type_aspect_defaults(product_type_slug text,aspect_name text,aspect_value text);
      CREATE TABLE ebay.ebay_product_aspect_overrides(product_id integer,aspect_name text,aspect_value text);
      INSERT INTO channels.channel_connections(id,channel_id,metadata) VALUES(9,67,'{"marketplaceId":"EBAY_US","fulfillmentPolicyId":"store-shipping","returnPolicyId":"store-returns","paymentPolicyId":"store-payment","merchantLocationKey":"main"}');
      INSERT INTO ebay.ebay_oauth_tokens VALUES(67,'production','seller-36','provider_user_id','2026-10-18T12:00:00Z');
      INSERT INTO catalog.products(id,name,sku,description,brand,product_type,is_active,
        ebay_fulfillment_policy_override,ebay_return_policy_override,ebay_payment_policy_override)
        VALUES(20,'Current pack','CATALOG-PACK','Description','Shellz','packs',true,'unavailable-product-shipping','product-returns','product-payment');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,option1_name,option1_value,price_cents,weight_grams,is_active,sales_eligibility,position)
        VALUES(101,20,'CATALOG-P5','Pack 5','Pack Size','5',1149,100,true,'sellable',1),
              (102,20,'CATALOG-P6','Pack 6','Pack Size','6',1149,120,true,'sellable',2);
      INSERT INTO channels.channel_listings VALUES(67,101,NULL,'offer-P5','P5'),(67,102,NULL,'offer-P6','P6');
      INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,ebay_browse_category_id,listing_enabled)
        VALUES(67,'packs','183454',true);
    `);
    await database.pool.query(readFileSync(resolve("migrations/0107_audit_events.sql"), "utf8"));
    runtime.pool = database.pool;
    runtime.provider = new AutomaticSyncEbayProvider(() => new Date("2026-10-18T12:00:00Z"), true, ["P5", "P6"]);
  }, 60_000);
  afterEach(async () => { await database?.close(); runtime.pool = null; runtime.provider = null; vi.unstubAllGlobals(); });

  it("clears only the product shipping override and rebuilds both exact offers with a fresh content hash", async () => {
    const available = providerPolicyCatalog("fulfillment");
    catalog.catalog.set("fulfillment", { fulfillmentPolicies: [...available.fulfillmentPolicies,
      { fulfillmentPolicyId: "unavailable-product-shipping", name: "Former product shipping", marketplaceId: "EBAY_US" }] });
    const source = await readEbayPublicationSource(20);
    const before = await prepareEbayPublicationCompletion(source, null);
    const mappings = (await database.pool.query("SELECT * FROM channels.channel_listings ORDER BY product_variant_id")).rows;
    expect(before.draft.offers.map(offer => ({ variantId: offer.variantId, sku: offer.sku, policies: offer.payload.listingPolicies })))
      .toEqual([101, 102].map((variantId, index) => ({ variantId, sku: index === 0 ? "P5" : "P6", policies: {
        fulfillmentPolicyId: "unavailable-product-shipping", returnPolicyId: "product-returns", paymentPolicyId: "product-payment",
      } })));

    catalog.catalog.set("fulfillment", available);
    await expect(prepareEbayPublicationCompletion(source, before.identity)).rejects.toMatchObject({
      code: "EBAY_POLICY_UNAVAILABLE", context: { policyKind: "fulfillment", policySource: { scope: "product", productId: 20 } },
    });
    expect(runtime.provider!.writes).toEqual([]);
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "product", productId: 20 },
      patch: { fulfillmentPolicyId: null }, actor: "user:policy-reviewer" });
    const currentSource = await readEbayPublicationSource(20);
    expect(currentSource).toEqual(source);
    expect(() => assertEbayListingSourceIdentityUnchanged(source, currentSource)).not.toThrow();
    const corrected = await prepareEbayPublicationCompletion(source, before.identity);
    expect(corrected.identity).toEqual(before.identity);
    expect(corrected.draft.existingOfferIdsByVariantId).toEqual({ 101: "offer-P5", 102: "offer-P6" });
    expect(corrected.draft.offers.map(offer => offer.payload.listingPolicies)).toEqual([101, 102].map(() => ({
      fulfillmentPolicyId: "store-shipping", returnPolicyId: "product-returns", paymentPolicyId: "product-payment",
    })));
    expect(corrected.draft.inventoryItems).toEqual(before.draft.inventoryItems);
    expect(corrected.draft.itemGroup).toEqual(before.draft.itemGroup);
    expect(syncContentIntentHash(corrected.draft)).not.toBe(syncContentIntentHash(before.draft));
    const replay = await prepareEbayPublicationCompletion(source, corrected.identity);
    expect(syncContentIntentHash(replay.draft)).toBe(syncContentIntentHash(corrected.draft));
    expect((await database.pool.query("SELECT * FROM channels.channel_listings ORDER BY product_variant_id")).rows).toEqual(mappings);
    expect(runtime.provider!.writes).toEqual([]);
  });

  it("preserves variant and product-type policy authority when the product shipping override is cleared", async () => {
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "product", productId: 20 }, patch: { fulfillmentPolicyId: "product-shipping" }, actor: "user:policy-reviewer" });
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "variant", variantId: 101 }, patch: { fulfillmentPolicyId: "variant-shipping" }, actor: "user:policy-reviewer" });
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "category", productTypeSlug: "packs" }, patch: { fulfillmentPolicyId: "type-shipping" }, actor: "user:policy-reviewer" });
    const source = await readEbayPublicationSource(20);
    const before = await prepareEbayPublicationCompletion(source, null);
    expect(before.draft.offers.map(offer => offer.payload.listingPolicies.fulfillmentPolicyId))
      .toEqual(["variant-shipping", "product-shipping"]);
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "product", productId: 20 }, patch: { fulfillmentPolicyId: null }, actor: "user:policy-reviewer" });
    const corrected = await prepareEbayPublicationCompletion(source, before.identity);
    expect(corrected.draft.offers.map(offer => offer.payload.listingPolicies.fulfillmentPolicyId))
      .toEqual(["variant-shipping", "type-shipping"]);
    expect(corrected.identity).toEqual(before.identity);
    expect(corrected.draft.offers[0]).toEqual(before.draft.offers[0]);
    expect(syncContentIntentHash(corrected.draft)).not.toBe(syncContentIntentHash(before.draft));
    expect(runtime.provider!.writes).toEqual([]);
  });

  it.each(["", " "])("reports the exact legacy blank store policy %j and corrects it through the owner", async legacyPolicy => {
    // This is retained malformed input from before the validated writer existed.
    await database.pool.query(`UPDATE channels.channel_connections
      SET metadata=jsonb_set(metadata,'{fulfillmentPolicyId}',to_jsonb($1::text)) WHERE id=9`, [legacyPolicy]);
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "product", productId: 20 },
      patch: { fulfillmentPolicyId: null }, actor: "user:policy-reviewer" });
    const source = await readEbayPublicationSource(20);
    await expect(prepareEbayPublicationCompletion(source, null)).rejects.toMatchObject({
      code: "EBAY_POLICY_UNAVAILABLE", context: { policyId: legacyPolicy, policySource: { scope: "store" } },
    });
    expect(runtime.provider!.writes).toEqual([]);
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "store" }, patch: { fulfillmentPolicyId: null }, actor: "user:policy-reviewer" });
    await expect(prepareEbayPublicationCompletion(source, null)).rejects.toMatchObject({
      code: "EBAY_POLICY_REQUIRED", context: { policySource: { scope: "store" } },
    });
    await ebayBusinessPolicies.patchPolicies({ target: { kind: "store" }, patch: { fulfillmentPolicyId: "store-shipping" }, actor: "user:policy-reviewer" });
    const corrected = await prepareEbayPublicationCompletion(source, null);
    expect(corrected.draft.offers.map(offer => offer.payload.listingPolicies.fulfillmentPolicyId)).toEqual(["store-shipping", "store-shipping"]);
    expect(runtime.provider!.writes).toEqual([]);
    expect((await database.pool.query("SELECT changes FROM public.audit_events WHERE target='channels.channel_connections:9' ORDER BY id")).rows)
      .toMatchObject([{ changes: { before: { fulfillmentPolicyId: legacyPolicy }, after: { fulfillmentPolicyId: null } } },
        { changes: { before: { fulfillmentPolicyId: null }, after: { fulfillmentPolicyId: "store-shipping" } } }]);
  });
});
