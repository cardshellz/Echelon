import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readChannelStockSelection } from "../../channel-stock-selection";
import { EbayListingChangeIntentRepository } from "../../infrastructure/ebay-listing-change-intent.repository";

// The real migration, so its constraints and partial unique index are what the repository is tested against.
// Its selection trigger function belongs to migration 0743 (covered by publication-selection-work.integration); a no-op stands in here.
const intentMigration = readFileSync(resolve(process.cwd(), "migrations",
  readdirSync(resolve(process.cwd(), "migrations")).find(file => file.endsWith("_ebay_listing_change_intents.sql"))!), "utf8");
const TOKEN_A = "a".repeat(64), TOKEN_B = "b".repeat(64);
const NOW = new Date("2026-11-13T12:00:00.000Z"), LATER = new Date("2026-11-13T12:05:00.000Z");

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const input = { channelId: 1, channelConnectionId: 11, productId: 10, productVariantIds: [101] };
// Query-shape and transaction proof against real PostgreSQL; not migration proof.
const ddl = `CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay;
CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,product_type text,category text,ebay_listing_excluded boolean);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer,sku text,uom_type text,is_active boolean,requires_shipping boolean,track_inventory boolean,sales_eligibility text,ebay_listing_excluded boolean);
CREATE TABLE catalog.product_line_products(product_id integer,product_line_id integer);
CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text);
CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer);
CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,is_listed integer);
CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,is_listed integer);
CREATE TABLE channels.channel_feeds(channel_id integer,product_variant_id integer,is_active integer,quarantined_at timestamptz,channel_variant_id text,channel_inventory_item_id text,channel_sku text,last_synced_qty integer);
CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer,sync_status text,external_product_id text,external_variant_id text,external_sku text);
CREATE TABLE ebay.ebay_category_mappings(channel_id integer,product_type_slug text,listing_enabled boolean);
CREATE TABLE channels.ebay_listing_sync_jobs(id uuid PRIMARY KEY,channel_id integer,connection_id integer,product_id integer,operation text,state text,identity jsonb,provider_identity jsonb,error_code text,created_at timestamptz DEFAULT now());
CREATE SCHEMA inventory;
CREATE FUNCTION inventory.notify_publication_selection_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END; $$;
${intentMigration}`;
describe.skipIf(!url || !disposable)("Channels selection owner SQL", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, ddl); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE channels.ebay_listing_change_intents,channels.channel_product_overrides,channels.channel_variant_overrides,channels.channel_feeds,channels.channel_listings,
      ebay.ebay_category_mappings,channels.ebay_listing_sync_jobs,catalog.product_line_products,catalog.product_variants,catalog.products,channels.channel_connections,channels.channels;
      INSERT INTO channels.channels VALUES(1,'ebay'),(2,'shopify'),(3,'walmart');
      INSERT INTO channels.channel_connections VALUES(11,1),(22,2),(33,3);
      INSERT INTO catalog.products VALUES(10,true,'active','holder','supplies',false),(20,true,'active','holder','supplies',false);
      INSERT INTO catalog.product_variants VALUES(101,10,'PACK','pack',true,true,true,'sellable',false),(102,10,'CASE','case',true,true,true,'sellable',false),(201,20,'OTHER','pack',true,true,true,'sellable',false);
      INSERT INTO channels.channel_listings VALUES(1,101,'synced','listing','offer','PACK');
      INSERT INTO channels.channel_feeds VALUES(2,101,1,NULL,'remote-variant','stock-item','PACK',17),(3,101,1,NULL,'PACK',NULL,'PACK',17);
      INSERT INTO ebay.ebay_category_mappings VALUES(1,'holder',true);`);
  });
  async function saveJob(operation: "publish"|"withdraw", state: string, variantId = 101) {
    const identity = { channelId: 1, connectionId: 11, productId: 10,
      variants: [{ variantId, sku: variantId === 101 ? "PACK" : "CASE", offerId: operation === "publish" ? null : "offer", listingId: operation === "publish" ? null : "listing" }] };
    await database.pool.query(`INSERT INTO channels.ebay_listing_sync_jobs(id,channel_id,connection_id,product_id,operation,state,identity,provider_identity)
      VALUES($1,1,11,10,$2,$3,$4,$5)`, [randomUUID(),operation,state,identity,operation === "withdraw" ? identity : null]);
  }
  it("selects exact saved destinations without enrolling all catalog variants", async () => {
    const selection = await readChannelStockSelection(database.pool, { ...input, productVariantIds: [101,102,201] });
    expect(selection.variants.map(row => [row.productVariantId,row.action])).toEqual([[101,"publish"],[102,"read_only"],[201,"none"]]);
    expect(selection.variants[2].blockers[0].code).toBe("CHANNEL_SELECTION_CATALOG_IDENTITY_MISSING");
  });
  it("refuses a mismatched or ambiguous channel connection", async () => {
    await expect(readChannelStockSelection(database.pool,{ ...input,channelConnectionId:22 })).rejects.toMatchObject({code:"CHANNEL_SELECTION_CONNECTION_UNRESOLVED"});
    await database.pool.query("INSERT INTO channels.channel_connections VALUES(12,1)");
    await expect(readChannelStockSelection(database.pool,input)).rejects.toMatchObject({code:"CHANNEL_SELECTION_CONNECTION_UNRESOLVED"});
  });
  it("uses exact-channel overrides; retains destination after exclusion", async () => {
    await database.pool.query("INSERT INTO channels.channel_product_overrides VALUES(2,10,0),(1,20,0)");
    expect((await readChannelStockSelection(database.pool,input)).variants[0].action).toBe("publish");
    await database.pool.query("INSERT INTO channels.channel_variant_overrides VALUES(1,101,0)");
    expect((await readChannelStockSelection(database.pool,input)).variants[0].action).toBe("zero");
  });
  it.each([[2,22],[3,33]])("reads saved provider feed selection for channel %s", async (channelId,channelConnectionId) => {
    const scoped = { ...input,channelId,channelConnectionId };
    expect((await readChannelStockSelection(database.pool,scoped)).variants[0].action).toBe("publish");
    await database.pool.query("UPDATE channels.channel_feeds SET is_active=0,quarantined_at=now() WHERE channel_id=$1",[channelId]);
    expect((await readChannelStockSelection(database.pool,scoped)).variants[0]).toMatchObject({action:"zero",blockers:[{code:"CHANNEL_SELECTION_MAPPING_QUARANTINED"}]});
  });
  it("recognizes only the exact persisted publication member", async () => {
    await saveJob("publish","queued",102);
    expect((await readChannelStockSelection(database.pool,{ ...input,productVariantIds:[102,201] })).variants.map(row => row.action)).toEqual(["publish","none"]);
  });
  it("ends the stock duty only after exact verified withdrawal projection", async () => {
    await saveJob("withdraw","completed");
    await database.pool.query("UPDATE catalog.products SET ebay_listing_excluded=true WHERE id=10");
    expect((await readChannelStockSelection(database.pool,input)).variants[0].action).toBe("zero");
    await database.pool.query("UPDATE channels.channel_listings SET sync_status='ended' WHERE channel_id=1");
    expect((await readChannelStockSelection(database.pool,input)).variants[0].action).toBe("none");
    await database.pool.query("UPDATE channels.channel_listings SET external_product_id='replacement' WHERE channel_id=1");
    expect((await readChannelStockSelection(database.pool,input)).variants[0].action).toBe("zero");
  });
  it("uses the supplied transaction and observes rollback; does not write", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO channels.channel_product_overrides VALUES(1,10,0)");
      expect((await readChannelStockSelection(client,input)).variants[0].action).toBe("zero");
      expect((await readChannelStockSelection(database.pool,input)).variants[0].action).toBe("publish");
      await client.query("ROLLBACK");
      await client.query("BEGIN READ ONLY");
      expect((await readChannelStockSelection(client,input)).variants[0].action).toBe("publish");
      await client.query("COMMIT");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("does not invalidate selection proof when only a quantity projection changes", async () => {
    const scoped = { ...input,channelId:2,channelConnectionId:22 };
    const first = await readChannelStockSelection(database.pool,scoped);
    await database.pool.query("UPDATE channels.channel_feeds SET last_synced_qty=999 WHERE channel_id=2");
    expect((await readChannelStockSelection(database.pool,scoped)).fingerprint).toBe(first.fingerprint);
  });

  describe("a size added by a reviewed listing change", () => {
    const intents = () => new EbayListingChangeIntentRepository(database.pool);
    const added = { channelId: 1, channelConnectionId: 11, productId: 10, productVariantIds: [101, 102] };
    const open = (reviewToken = TOKEN_A, members = [{ productVariantId: 102, sku: "CASE" }]) => intents().open({ kind: "listing_update",
      channelId: 1, connectionId: 11, productId: 10, externalListingId: "listing", reviewToken, actor: "user:operator", members }, NOW);
    const actions = async () => Object.fromEntries((await readChannelStockSelection(database.pool, added)).variants
      .map(variant => [variant.productVariantId, variant.action]));
    const rows = async () => (await database.pool.query(`SELECT product_variant_id AS variant,review_token AS token,close_reason AS reason,
      closed_at IS NULL AS open FROM channels.ebay_listing_change_intents ORDER BY id`)).rows;

    it("is selected only while its reviewed change is on record", async () => {
      // CASE (102) has no saved eBay identity: a candidate, not a stock destination.
      expect(await actions()).toEqual({ 101: "publish", 102: "read_only" });
      await open();
      expect(await actions()).toEqual({ 101: "publish", 102: "publish" });
      // Refused before anything reached eBay: the size is a candidate again.
      expect(await intents().close({ channelId: 1, productId: 10, reviewToken: TOKEN_A, reason: "refused" }, LATER)).toBe(1);
      expect(await actions()).toEqual({ 101: "publish", 102: "read_only" });
      expect(await rows()).toEqual([{ variant: 102, token: TOKEN_A, reason: "refused", open: false }]);
    });

    it("opens once per review, and closing twice or closing an unknown review changes nothing", async () => {
      await open(); await open();
      await Promise.all([open(), open()]);
      expect(await rows()).toEqual([{ variant: 102, token: TOKEN_A, reason: null, open: true }]);
      expect(await intents().close({ channelId: 1, productId: 10, reviewToken: TOKEN_B, reason: "applied" }, LATER)).toBe(0);
      expect(await intents().close({ channelId: 1, productId: 10, reviewToken: TOKEN_A, reason: "applied" }, LATER)).toBe(1);
      expect(await intents().close({ channelId: 1, productId: 10, reviewToken: TOKEN_A, reason: "applied" }, LATER)).toBe(0);
      expect(await rows()).toEqual([{ variant: 102, token: TOKEN_A, reason: "applied", open: false }]);
    });

    it("replaces an earlier review of the same product and leaves other products alone", async () => {
      await open();
      await intents().open({ kind: "listing_update", channelId: 1, connectionId: 11, productId: 20, externalListingId: "other-listing",
        reviewToken: TOKEN_A, actor: "user:operator", members: [{ productVariantId: 201, sku: "OTHER" }] }, NOW);
      await open(TOKEN_B);
      expect(await rows()).toEqual([
        { variant: 102, token: TOKEN_A, reason: "superseded", open: false },
        { variant: 201, token: TOKEN_A, reason: null, open: true },
        { variant: 102, token: TOKEN_B, reason: null, open: true },
      ]);
      expect((await actions())[102]).toBe("publish");
    });

    it("refuses a size of another product, bad input and a row that breaks the table's rules, writing nothing", async () => {
      await expect(open(TOKEN_A, [{ productVariantId: 201, sku: "OTHER" }])).rejects.toMatchObject({ code: "EBAY_LISTING_CHANGE_INTENT_NOT_RECORDED" });
      await expect(open("not-a-token")).rejects.toThrow();
      await expect(open(TOKEN_A, [])).rejects.toThrow();
      await expect(open(TOKEN_A, [{ productVariantId: 102, sku: "CASE" }, { productVariantId: 102, sku: "CASE" }])).rejects.toThrow();
      expect(await rows()).toEqual([]);
      await expect(database.pool.query(`INSERT INTO channels.ebay_listing_change_intents(channel_id,connection_id,product_id,product_variant_id,kind,
        external_listing_id,sku,review_token,actor,opened_at,closed_at,close_reason) VALUES(1,11,10,102,'listing_update','listing','CASE',$1,'operator',now(),now(),NULL)`,
      [TOKEN_A])).rejects.toMatchObject({ code: "23514" });
      await expect(database.pool.query(`INSERT INTO channels.ebay_listing_change_intents(channel_id,connection_id,product_id,product_variant_id,kind,
        external_listing_id,sku,review_token,actor,opened_at) VALUES(1,11,10,102,'publish','listing','CASE',$1,'operator',now())`,
      [TOKEN_A])).rejects.toMatchObject({ code: "23514" });
    });

    it("is read for its own channel connection only, and never changes a listing rule", async () => {
      await open();
      await database.pool.query("UPDATE catalog.product_variants SET ebay_listing_excluded=true WHERE id=102");
      expect((await actions())[102]).toBe("none");
      await database.pool.query("UPDATE catalog.product_variants SET ebay_listing_excluded=false WHERE id=102; UPDATE channels.ebay_listing_change_intents SET connection_id=22");
      expect((await actions())[102]).toBe("read_only");
    });
  });
});
