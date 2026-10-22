import { WalmartConnectionRepository } from "../../../channels/adapters/walmart/walmart-connection.repository";
import { WalmartChannelService } from "../../../channels/adapters/walmart/walmart-channel.service";
import { WalmartListingProvider } from "../../../channels/adapters/walmart/walmart-listing.provider";
import { WalmartListingApi } from "../../../channels/adapters/walmart/walmart-listing-api";
import { WalmartClient } from "../../../channels/adapters/walmart/walmart-client";
import { listingDraftItemSchema } from "@shared/types/channel-listing-publication";
import { publicationSnapshot } from "../fixtures/listing-publication.fixture";
import createSchema from "../../../channels/__tests__/fixtures/walmart-listing-sleeves.schema.json";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../../../inventory-planning/__tests__/fixtures/ebay-publication-inventory.fixture";
import { PgCatalogVariantPublicationPhotoReader } from "../../../catalog/catalog-publication-images.reader";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";
import { prepareEbayChannelIntent, ebayIntentAccount } from "../../../channels/ebay-prepared-intent";
import { PostgresEbayListingSyncRepository } from "../../../channels/infrastructure/ebay-listing-sync.repository";
import { syncProviderFixture, syncIdentity } from "../../../channels/__tests__/fixtures/ebay-listing-sync.fixture";
import { prepareChannelIntent } from "../../prepared-channel-intent";
import type { ChannelPreparedIntent } from "@shared/types/channel-prepared-intent";
import type { EbayListingSyncClaim } from "../../../channels/ebay-listing-sync.service";
import type { EbayListingSyncIdentity } from "../../../channels/ebay-listing-sync.domain";
vi.mock("../../../../db", () => ({ pool: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-10-19T18:00:00Z");
const mediaMigration = "migrations/900000017000018580001_catalog_publication_media_versions.sql";

(url && disposable ? describe : describe.skip).sequential("prepared channel intent: real Catalog source and fenced eBay receipt", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: PostgresEbayListingSyncRepository;
  let claim: EbayListingSyncClaim | null;
  const identity: EbayListingSyncIdentity = { ...syncIdentity, channelId: 67, connectionId: 9, accountId: "seller-36" };
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayPublicationInventoryFixture(database.pool, { includePreflightRecoveryMigrations: true, seedPublicationJob: false });
    for (const name of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql", "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql", "0741_ebay_durable_withdrawal.sql", "900000021000018880001_channel_lifecycle_recovery.sql", "900000023000018880003_listing_work_settlement.sql"])
      await database.pool.query(readFileSync(`migrations/${name}`, "utf8"));
    await database.pool.query(`CREATE TABLE catalog.product_assets(id integer PRIMARY KEY,product_id integer NOT NULL,
      product_variant_id integer,asset_type text NOT NULL DEFAULT 'image',url text,position integer NOT NULL DEFAULT 0,
      is_primary integer NOT NULL DEFAULT 0,mime_type text,storage_type text NOT NULL DEFAULT 'url',file_data bytea);
      UPDATE channels.channel_connections SET metadata='{"marketplaceId":"EBAY_US","merchantLocationKey":"HQ"}' WHERE id=9;`);
    await database.pool.query(readFileSync(mediaMigration, "utf8"));
    repository = new PostgresEbayListingSyncRepository(database.pool);
  }, 60_000);
  afterEach(async () => { await claim?.release(); claim = null; await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,product_variant_id,storage_type,mime_type,file_data)
      VALUES(1,20,101,'file','image/png',$1)`, [Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")]);
  });
  async function prepare(): Promise<ChannelPreparedIntent> {
    const mediaPlan = await new PgCatalogVariantPublicationPhotoReader(database.pool,
      createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" }))
      .listPublicationPlan({ productId: 20, productVariantIds: [101], maxPhotosPerVariant: 12, maxGroupPhotos: 12 });
    const draft = (await syncProviderFixture().prepare()).draft;
    draft.inventoryItems[0].payload.product.imageUrls = mediaPlan.variants[0].gallery.selected.map(photo => photo.url);
    draft.itemGroup!.payload.imageUrls = mediaPlan.group.selected.map(photo => photo.url);
    return prepareEbayChannelIntent({ draft, account: ebayIntentAccount({ channelId: 67, connectionId: 9,
      accountId: "seller-36", marketplaceId: "EBAY_US", environment: "production", merchantLocationKey: "HQ" }),
      operation: "maintenance", mediaPlan, prices: new Map([[101, { priceCents: 1149, basePriceCents: 1149,
        source: "catalog_variant", provenance: { kind: "catalog_variant", variantId: 101 }, appliedRule: null }]]),
      settings: { policyOwner: "channels.ebay_business_policies", fulfillmentPolicyId: "fulfillment" } });
  }
  async function own() {
    const job = await repository.enqueue(identity, randomUUID(), "user:intent-review", now);
    claim = await repository.claim(now, randomUUID(), job.id);
    if (!claim) throw new Error("The real saved listing job was not claimed");
    await repository.bindProviderIdentity(claim.job, identity, now);
    return claim.job;
  }
  async function evidence() {
    return {
      events: (await database.pool.query("SELECT evidence FROM channels.ebay_listing_sync_events WHERE evidence->>'key'='prepared_intent' ORDER BY id")).rows,
      pins: (await database.pool.query("SELECT owner,reference_key,asset_id,content_hash FROM catalog.publication_media_version_pins ORDER BY reference_key,asset_id")).rows,
      references: (await database.pool.query("SELECT owner,reference_key,source_revision FROM catalog.publication_media_references ORDER BY reference_key")).rows,
    };
  }
  it("commits immutable preparation plus exact byte pins once without stock side effects", async () => {
    const intent = await prepare(), job = await own();
    const stock = (await database.pool.query("SELECT to_jsonb(o) AS row FROM inventory.inventory_publication_outbox o ORDER BY id")).rows;
    await repository.persistPreparedIntent(job, intent, now);
    await repository.persistPreparedIntent(job, structuredClone(intent), new Date(now.getTime()+1000));
    const saved = await evidence();
    expect(saved.events).toEqual([{ evidence: { key: "prepared_intent", preparedIntentHash: intent.intentHash, intent } }]);
    expect(saved.pins).toHaveLength(1); expect(saved.references).toHaveLength(1);
    expect(saved.pins[0]).toMatchObject({ owner: "channels", asset_id: 1, content_hash: intent.input.mediaPlan!.group.selected[0].versionHash });
    expect((await database.pool.query("SELECT to_jsonb(o) AS row FROM inventory.inventory_publication_outbox o ORDER BY id")).rows).toEqual(stock);
    await expect(database.pool.query("UPDATE channels.ebay_listing_sync_events SET evidence='{}' WHERE evidence->>'key'='prepared_intent'")).rejects.toThrow();
  });
  it.each(["owner", "account", "environment", "connection", "marketplace", "configuration", "member"])("rejects a recomputed but wrong %s scope before pinning", async changed => {
    const original = await prepare(), input = structuredClone(original.input), job = await own();
    if (changed === "owner") input.account.owner = { kind: "channel", channelId: 36 };
    if (changed === "account") input.account.accountId = "another-seller";
    if (changed === "environment") input.account.environment = "sandbox";
    if (changed === "connection") input.account.connectionId = 8;
    if (changed === "marketplace") input.account.marketplaceId = "EBAY_CA";
    if (changed === "configuration") input.account.configurationRevision = "stale";
    if (changed === "member") input.members[0].sku = "OTHER-SKU";
    await expect(repository.persistPreparedIntent(job, prepareChannelIntent(input), now)).rejects.toThrow();
    expect(await evidence()).toEqual({ events: [], pins: [], references: [] });
  });
  it("rolls image retention back if the immutable event cannot commit", async () => {
    const intent = await prepare(), job = await own();
    await database.pool.query(`CREATE OR REPLACE FUNCTION channels.test_reject_prepared() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.evidence->>'key'='prepared_intent' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_reject_prepared BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_reject_prepared();`);
    await expect(repository.persistPreparedIntent(job, intent, now)).rejects.toMatchObject({ code: "EBAY_SYNC_PERSISTENCE_FAILED" });
    expect(await evidence()).toEqual({ events: [], pins: [], references: [] });
  });
  it("keeps prior preparations and byte versions when a corrected source produces a new intent", async () => {
    const first = await prepare(), job = await own(); await repository.persistPreparedIntent(job, first, now);
    await database.pool.query("UPDATE catalog.product_assets SET file_data=$1 WHERE id=1", [Buffer.from("89504e470d0a1a0a0000000d4948445300", "hex")]);
    const second = await prepare(); expect(second.intentHash).not.toBe(first.intentHash);
    await repository.persistPreparedIntent(job, second, new Date(now.getTime()+1000));
    const saved = await evidence(); expect(saved.events).toHaveLength(2); expect(saved.pins).toHaveLength(2);
    expect(new Set(saved.pins.map(pin => pin.content_hash)).size).toBe(2);
  });
  it("rejects stale claimed ownership without retaining media", async () => {
    const intent = await prepare(), job = await own(); await claim!.release(); claim = null;
    await expect(repository.persistPreparedIntent(job, intent, now)).rejects.toMatchObject({ code: "EBAY_SYNC_OWNER_LOST" });
    expect(await evidence()).toEqual({ events: [], pins: [], references: [] });
  });
  it("fences account changes until the preparation and image pins commit", async () => {
    const intent = await prepare(), job = await own();
    const testFenceNamespace = 1_897_351;
    const blocker = await database.pool.connect();
    let pending: Promise<void> | undefined;
    try {
      await blocker.query("SELECT pg_advisory_lock($1,1)", [testFenceNamespace]);
      await database.pool.query(`CREATE FUNCTION channels.test_pause_prepared() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.evidence->>'key'='prepared_intent' THEN PERFORM pg_advisory_xact_lock(${testFenceNamespace},1); END IF; RETURN NEW; END $$;
        CREATE TRIGGER test_pause_prepared BEFORE INSERT ON channels.ebay_listing_sync_events FOR EACH ROW EXECUTE FUNCTION channels.test_pause_prepared();`);
      pending = repository.persistPreparedIntent(job,intent,now);
      let blocked = false;
      for (let attempt=0;attempt<50;attempt++) {
        blocked = (await database.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=$1 AND objid=1 AND NOT granted",[testFenceNamespace])).rowCount === 1;
        if (blocked) break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      const contender = await database.pool.connect();
      try {
        await contender.query("SET lock_timeout='100ms'");
        await expect(contender.query("UPDATE channels.channel_connections SET metadata='{}' WHERE id=9")).rejects.toMatchObject({code:"55P03"});
      } finally { contender.release(); }
      expect((await evidence()).events).toEqual([]);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1,1)",[testFenceNamespace]); blocker.release();
      await pending;
    }
    expect((await evidence()).events).toHaveLength(1);
  });
  it("prepares Walmart from a real account and the same immutable Catalog photo plan through only mocked HTTP", async () => {
    await database.pool.query(`ALTER TABLE channels.walmart_connections ADD COLUMN partner_name text NOT NULL DEFAULT 'Synthetic seller',
      ADD COLUMN encrypted_credentials jsonb NOT NULL DEFAULT '{"connectionId":8,"keyId":"fixture","ciphertext":"fixture","iv":"fixture","authTag":"fixture"}',
      ADD COLUMN orders_enabled boolean NOT NULL DEFAULT false,ADD COLUMN import_since timestamptz NOT NULL DEFAULT '2026-10-01',
      ADD COLUMN checkpoint_at timestamptz,ADD COLUMN last_poll_at timestamptz,ADD COLUMN last_success_at timestamptz,
      ADD COLUMN last_error_code text,ADD COLUMN revision integer NOT NULL DEFAULT 1;`);
    const calls: Array<{ method: string; path: string }> = [];
    const http: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname, method = init?.method ?? "GET"; calls.push({method,path});
      if (path === "/v3/token") return new Response(JSON.stringify({ access_token: "synthetic-test-token", expires_in: 3600 }), {status:200});
      if (path === "/v3/items/P5" && method === "GET") return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND", description: "Missing fixture SKU" }] }), {status:404});
      if (path === "/v3/items/spec" && method === "POST") return new Response(JSON.stringify({schema:createSchema}), {status:200});
      throw new Error(`Unexpected provider request ${method} ${path}`);
    };
    const channels = new WalmartChannelService(new WalmartConnectionRepository(database.pool), {
      open: () => JSON.stringify({clientId:"synthetic-client",clientSecret:"synthetic-secret",environment:"production",market:"us"}),
      seal: () => { throw new Error("This read-only preparation cannot save credentials"); },
    }, {liveEnabled:true,productionServer:false}, () => now, undefined,
      credentials => new WalmartListingApi(new WalmartClient(credentials, {fetch:http,now:()=>now,correlationId:randomUUID})));
    const provider = new WalmartListingProvider(channels), account = await provider.account(36);
    const mediaPlan = await new PgCatalogVariantPublicationPhotoReader(database.pool,
      createCatalogPublicImageUrl({CATALOG_PUBLIC_BASE_URL:"https://catalog.example.com"}))
      .listPublicationPlan({productId:20,productVariantIds:[101],maxPhotosPerVariant:20});
    const catalog = { ...publicationSnapshot([101]).catalog[0], sku:"P5", alreadyLinked:false, mediaPlan,
      images:mediaPlan.group.selected.map(photo=>photo.url), priceProvenance:{kind:"catalog_variant" as const,variantId:101} };
    const draft = listingDraftItemSchema.parse({variantId:101,productType:"Trading Card Sleeves & Holders",attributes:{
      Orderable:{ShippingWeight:0.1,country_of_origin_substantial_transformation:"United States"},
      Visible:{condition:"New",keyFeatures:["Clear protection","One hundred sleeves","Trading cards"],countPerPack:100,multipackQuantity:1,
        isProp65WarningRequired:"No",has_written_warranty:"No",netContent:{productNetContentUnit:"Each",productNetContentMeasure:100},pieceCount:100},
    }});
    const prepared = await provider.prepare(account,{catalog,draft,priceCents:1299});
    expect(prepared.issues).toEqual([]);
    expect(prepared.preparedIntent?.input).toMatchObject({account:{owner:{kind:"channel",channelId:36},connectionId:8,
      accountId:"partner-36",inventoryScope:{kind:"location",locationId:"test-location"}},capability:{protocol:"feed",mediaVerification:"unavailable"},
      mediaPlan:{group:{selected:[{assetId:1,uploaded:true,versionHash:mediaPlan.group.selected[0].versionHash}]}}});
    const visible = prepared.payload.Visible as Record<string,{mainImageUrl:string}>;
    expect(visible[draft.productType].mainImageUrl).toBe(prepared.preparedIntent!.input.mediaPlan!.group.selected[0].url);
    const before = calls.length;
    await database.pool.query("UPDATE channels.walmart_connections SET revision=revision+1 WHERE channel_id=36");
    await expect(provider.prepare(account,{catalog,draft,priceCents:1299})).rejects.toMatchObject({code:"WALMART_LISTING_ACCOUNT_CHANGED"});
    expect(calls).toHaveLength(before);
    expect(calls.every(call=>call.method==="GET" || call.path==="/v3/token" || call.path==="/v3/items/spec")).toBe(true);
  });

});
