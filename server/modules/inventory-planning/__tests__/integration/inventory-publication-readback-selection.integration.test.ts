import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { PostgresInventoryPublicationReadbackRepository } from "../../infrastructure/inventory-publication-readback.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced owner schemas prove real query/transaction behavior. Full migration
// and quantity-write coverage remains in the publication integration suites.
const ddl = `CREATE SCHEMA inventory; CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA dropship;
CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,product_type text,category text,ebay_listing_excluded boolean);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer,sku text,uom_type text,is_active boolean,requires_shipping boolean,track_inventory boolean,sales_eligibility text,ebay_listing_excluded boolean);
CREATE TABLE catalog.product_line_products(product_id integer,product_line_id integer);
CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text);
CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer);
CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,is_listed integer);
CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,is_listed integer);
CREATE TABLE channels.channel_feeds(channel_id integer,product_variant_id integer,is_active integer,quarantined_at timestamptz,channel_variant_id text,channel_inventory_item_id text,channel_sku text,last_synced_qty integer);
CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer,sync_status text,external_product_id text,external_variant_id text,external_sku text);
CREATE TABLE dropship.dropship_store_connections(id integer PRIMARY KEY,platform text);
CREATE TABLE inventory.inventory_publication_targets(id integer PRIMARY KEY,revision bigint,destination_kind text,channel_id integer,channel_connection_id integer,
 dropship_store_connection_id integer,provider_scope_type text,external_scope_id text,publication_authority text,state text,membership_mode text);
CREATE TABLE inventory.publication_variant_mapping_heads(publication_target_id integer,product_variant_id integer,active_mapping_id integer,draft_mapping_id integer);
CREATE TABLE inventory.publication_variant_mapping_versions(id integer PRIMARY KEY,external_inventory_item_id text,external_sku text);
CREATE TABLE inventory.publication_membership_versions(id integer PRIMARY KEY,included boolean);
CREATE TABLE inventory.publication_membership_heads(publication_target_id integer,product_variant_id integer,active_version_id integer);
CREATE TABLE inventory.inventory_publication_readback_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),state text,idempotency_key text UNIQUE,
 request_hash text,requested_by text,reason text,started_at timestamptz,result_payload jsonb);`;

describe.skipIf(!url || !disposable)("readback listing selection with real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let store: PostgresInventoryPublicationReadbackRepository;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, ddl); store = new PostgresInventoryPublicationReadbackRepository(database.pool); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE inventory.inventory_publication_readback_runs,channels.channel_feeds,channels.channel_variant_overrides,
      channels.channel_connections,channels.channels,catalog.products,catalog.product_variants,inventory.inventory_publication_targets,
      inventory.publication_variant_mapping_heads,inventory.publication_variant_mapping_versions,inventory.publication_membership_heads,inventory.publication_membership_versions;
      INSERT INTO channels.channels VALUES(36,'walmart'); INSERT INTO channels.channel_connections VALUES(8,36);
      INSERT INTO catalog.products VALUES(20,true,'active','holder','supplies',false);
      INSERT INTO catalog.product_variants VALUES(101,20,'P5','pack',true,true,true,'sellable',false);
      INSERT INTO channels.channel_feeds VALUES(36,101,1,NULL,'P5','P5','P5',7);
      INSERT INTO inventory.inventory_publication_targets VALUES(2,3,'channel_connection',36,8,NULL,'location','ship-node','echelon','preview','explicit');
      INSERT INTO inventory.publication_variant_mapping_versions VALUES(1,'P5','P5');
      INSERT INTO inventory.publication_variant_mapping_heads VALUES(2,101,1,1);
      INSERT INTO inventory.publication_membership_versions VALUES(1,false);
      INSERT INTO inventory.publication_membership_heads VALUES(2,101,1);`);
  });
  const begin = () => store.begin({ idempotencyKey: randomUUID(), requestHash: "a".repeat(64), requestedBy: "operator", reason: "Verify selected listing stock", startedAt: new Date("2026-10-12T12:00:00Z") });
  it("reads a selected listing even when the retired inventory selection is false", async () => {
    const result = await begin();
    expect(result).toMatchObject({ kind: "started", targets: [{ publicationTargetId: 2, productVariantId: 101, externalInventoryItemId: "P5", channelConnectionId: 8 }] });
    expect((await database.pool.query("SELECT included FROM inventory.publication_membership_versions")).rows).toEqual([{ included: false }]);
  });
  it("retains a deselected saved identity for zero-stock verification", async () => {
    await database.pool.query("UPDATE channels.channel_feeds SET is_active=0");
    expect(await begin()).toMatchObject({ kind: "started", targets: [{ productVariantId: 101, externalInventoryItemId: "P5" }] });
  });
  it("a retired included flag cannot enroll an unselected destination", async () => {
    await database.pool.query("DELETE FROM channels.channel_feeds; UPDATE inventory.publication_membership_versions SET included=true");
    expect(await begin()).toMatchObject({ kind: "started", targets: [] });
  });
  it("rolls back the new run when exact connection selection cannot be established", async () => {
    await database.pool.query("INSERT INTO channels.channel_connections VALUES(9,36)");
    await expect(begin()).rejects.toMatchObject({ code: "CHANNEL_SELECTION_CONNECTION_UNRESOLVED" });
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_readback_runs")).rows).toEqual([]);
  });
});
