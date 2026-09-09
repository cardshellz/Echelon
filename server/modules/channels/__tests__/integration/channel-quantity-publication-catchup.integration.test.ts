import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresChannelQuantityPublicationCatchupRepository } from "../../infrastructure/channel-quantity-publication-catchup.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced read-only mapping SQL fixture, not migration or provider authorization proof.
const ddl = `CREATE SCHEMA channels; CREATE SCHEMA catalog; CREATE SCHEMA warehouse;
 CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text,status text,sync_enabled boolean);
 CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer NOT NULL REFERENCES channels.channels(id));
 CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL,sku text);
 CREATE TABLE channels.channel_feeds(id integer PRIMARY KEY,channel_id integer,product_variant_id integer,
  channel_inventory_item_id text,channel_sku text,is_active integer,quarantined_at timestamptz,UNIQUE(channel_id,product_variant_id));
 CREATE TABLE channels.channel_listings(id integer PRIMARY KEY,channel_id integer,product_variant_id integer,external_sku text,UNIQUE(channel_id,product_variant_id));
 CREATE TABLE warehouse.warehouses(id integer PRIMARY KEY,shopify_location_id text);
 CREATE TABLE channels.channel_warehouse_assignments(id integer PRIMARY KEY,channel_id integer,warehouse_id integer,enabled boolean,UNIQUE(channel_id,warehouse_id));`;
const seed = `TRUNCATE channels.channel_warehouse_assignments,warehouse.warehouses,channels.channel_feeds,channels.channel_listings,catalog.product_variants,channels.channel_connections,channels.channels;
 INSERT INTO channels.channels VALUES(36,'shopify','active',true),(67,'ebay','active',true),(103,'manual','active',true);
 INSERT INTO channels.channel_connections VALUES(7,36),(8,67),(9,103);
 INSERT INTO catalog.product_variants VALUES(101,20,'P5'),(102,20,'P10'),(103,30,'EXT-P5');
 INSERT INTO channels.channel_feeds VALUES(1,36,101,'1111','SHOP-P5',1,NULL),(2,67,101,NULL,'FEED-P5',1,NULL),(3,103,103,'1111','EXT-P5',1,NULL);
 INSERT INTO channels.channel_listings VALUES(1,67,101,'EXT-P5');
 INSERT INTO warehouse.warehouses VALUES(1,'2222');
 INSERT INTO channels.channel_warehouse_assignments VALUES(1,36,1,true);`;
const shopify = { destinationKind: "channel_connection", connectionId: 7, providerKey: "shopify", providerScopeType: "location",
  externalScopeId: "2222", externalInventoryItemId: "1111", productId: null, productVariantId: null };
const ebay = { ...shopify, connectionId: 8, providerKey: "ebay", providerScopeType: "account", externalScopeId: "verified-account", externalInventoryItemId: "EXT-P5" };

(url && disposable ? describe : describe.skip).sequential("legacy channel catch-up actual mapping SQL", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: PostgresChannelQuantityPublicationCatchupRepository;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, ddl);
    repository = new PostgresChannelQuantityPublicationCatchupRepository(database.pool);
  });
  beforeEach(async () => { await database.pool.query(seed); });
  afterAll(async () => { await database?.close(); });
  it("resolves a valid Shopify feed absent all canonical/history mappings, ignoring another channel's same item ID", async () => {
    await expect(repository.resolve(shopify)).resolves.toMatchObject({ channelId: 36, productId: 20, productVariantId: 101 });
  });
  it("matches correct-kind stored Shopify GIDs to the journal's numeric REST identity", async () => {
    await database.pool.query("UPDATE channels.channel_feeds SET channel_inventory_item_id='gid://shopify/InventoryItem/1111' WHERE id=1; UPDATE warehouse.warehouses SET shopify_location_id='gid://shopify/Location/2222'");
    await expect(repository.resolve(shopify)).resolves.toMatchObject({ productVariantId: 101 });
  });
  it.each(["UPDATE channels.channel_feeds SET is_active=0 WHERE id=1", "UPDATE channels.channel_feeds SET quarantined_at=now() WHERE id=1",
    "UPDATE channels.channel_warehouse_assignments SET enabled=false", "UPDATE warehouse.warehouses SET shopify_location_id='3333'"])("rejects unavailable Shopify destination: %s", async sql => {
    await database.pool.query(sql);
    await expect(repository.resolve(shopify)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_MISSING" });
  });
  it("rejects two assigned warehouses exposing the same location rather than double publishing", async () => {
    await database.pool.query("INSERT INTO warehouse.warehouses VALUES(2,'2222'); INSERT INTO channels.channel_warehouse_assignments VALUES(2,36,2,true)");
    await expect(repository.resolve(shopify)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_AMBIGUOUS" });
  });
  it("uses eBay listing SKU ahead of feed SKU, ignoring catalog-wide duplicates and unrelated manual channel", async () => {
    await expect(repository.resolve(ebay)).resolves.toMatchObject({ channelId: 67, productId: 20, productVariantId: 101 });
    await expect(repository.resolve({ ...ebay, externalInventoryItemId: "FEED-P5" })).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_MISSING" });
  });
  it("supports feed-only eBay mapping and catalog SKU only when a current mapping actually exists", async () => {
    await database.pool.query("DELETE FROM channels.channel_listings WHERE id=1");
    await expect(repository.resolve({ ...ebay, externalInventoryItemId: "FEED-P5" })).resolves.toMatchObject({ productVariantId: 101 });
    await database.pool.query("UPDATE channels.channel_feeds SET channel_sku=NULL WHERE id=2");
    await expect(repository.resolve({ ...ebay, externalInventoryItemId: "P5" })).resolves.toMatchObject({ productVariantId: 101 });
    await database.pool.query("DELETE FROM channels.channel_feeds WHERE id=2");
    await expect(repository.resolve({ ...ebay, externalInventoryItemId: "P5" })).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_MISSING" });
  });
  it("rejects two variants owning the same effective eBay SKU", async () => {
    await database.pool.query("INSERT INTO channels.channel_listings VALUES(2,67,102,'EXT-P5')");
    await expect(repository.resolve(ebay)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_AMBIGUOUS" });
  });
  it("rejects a quarantined eBay feed even if its listing row survives", async () => {
    await database.pool.query("UPDATE channels.channel_feeds SET quarantined_at=now() WHERE id=2");
    await expect(repository.resolve(ebay)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_MAPPING_MISSING" });
  });
  it("rejects multiple channel connections rather than choosing whichever credentials are read first", async () => {
    await database.pool.query("INSERT INTO channels.channel_connections VALUES(10,67)");
    await expect(repository.resolve(ebay)).rejects.toMatchObject({ code: "PUBLICATION_CATCHUP_CONNECTION_AMBIGUOUS" });
  });
});
