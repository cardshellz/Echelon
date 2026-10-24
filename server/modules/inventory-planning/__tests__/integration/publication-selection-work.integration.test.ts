import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresPublicationSelectionWork } from "../../infrastructure/publication-selection-work.repository";
import { publicationSelectionBusyIssue } from "../../publication-selection-work";
import type { InventoryAvailabilityTransactionQueryClient } from "../../application/inventory-availability-transaction-query.port";
import { PICKS_SELECTION_TRIGGERS_SQL } from "../../../dropship/infrastructure/dropship-selection-conversion.sql";

const configured = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const migration = readFileSync(resolve(process.cwd(), "migrations/0743_publication_selection_work.sql"), "utf8");
const fixture = `
CREATE SCHEMA inventory; CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA dropship; CREATE SCHEMA ebay;
CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,product_type text,category text,ebay_listing_excluded boolean);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer,is_active boolean,requires_shipping boolean,track_inventory boolean,
  sales_eligibility text,ebay_listing_excluded boolean,sku text,uom_type text);
CREATE TABLE catalog.product_line_products(product_id integer,product_line_id integer);
CREATE TABLE inventory.publication_variant_mapping_heads(publication_target_id integer,product_variant_id integer,active_mapping_id bigint);
CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,is_listed integer);
CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,is_listed integer);
CREATE TABLE channels.channel_feeds(channel_id integer,product_variant_id integer,is_active integer,quarantined_at timestamptz,
  channel_variant_id text,channel_inventory_item_id text,channel_sku text,last_synced_qty integer);
CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer,external_product_id text,external_variant_id text,external_sku text,last_synced_qty integer);
CREATE TABLE channels.ebay_listing_sync_jobs(product_id integer,operation text,identity jsonb,provider_identity jsonb,state text);
CREATE TABLE ebay.ebay_category_mappings(channel_id integer,product_type_slug text,listing_enabled boolean);
CREATE TABLE dropship.dropship_catalog_rules(scope_type text,action text,product_line_id integer,product_id integer,
 product_variant_id integer,category text,starts_at timestamptz,ends_at timestamptz,is_active boolean,priority integer);
CREATE TABLE dropship.dropship_vendor_selection_rules(vendor_id integer,scope_type text,action text,product_line_id integer,product_id integer,
 product_variant_id integer,category text,auto_connect_new_skus boolean,auto_list_new_skus boolean,is_active boolean,priority integer);
CREATE TABLE dropship.dropship_vendor_variant_overrides(vendor_id integer,product_variant_id integer,enabled_override boolean);
-- The vendor's one-time picks (PLAN-B v4.1 §5), reduced; their triggers follow 0743 (V33).
CREATE TABLE dropship.dropship_vendor_selected_variants(vendor_id integer,product_variant_id integer,PRIMARY KEY(vendor_id,product_variant_id));
CREATE TABLE dropship.dropship_store_listing_configs(store_connection_id integer,listing_mode text,inventory_mode text,is_active boolean);
CREATE TABLE dropship.dropship_store_connections(status text);
CREATE TABLE dropship.dropship_vendor_listings(vendor_id integer,store_connection_id integer,product_variant_id integer,status text,external_listing_id text,external_offer_id text,pushed_quantity integer);
CREATE TABLE dropship.dropship_listing_push_job_items(listing_id integer,product_variant_id integer,action text,status text);
CREATE TABLE dropship.dropship_listing_push_jobs(vendor_id integer,store_connection_id integer,status text);
CREATE TABLE inventory.selection_test_plan_effects(product_id integer,selected boolean);
INSERT INTO catalog.products VALUES(20,true,'active','toploader','supplies',false),(21,true,'active','other','supplies',false);
INSERT INTO catalog.product_variants VALUES(101,20,true,true,true,'sellable',false,'SKU-101','pack'),(102,21,true,true,true,'sellable',false,'SKU-102','pack');
INSERT INTO inventory.publication_variant_mapping_heads VALUES(3,101,401);
INSERT INTO channels.channel_product_overrides VALUES(3,20,1);
INSERT INTO channels.channel_feeds VALUES(3,101,1,NULL,'v101','i101','SKU-101',4);
`;

(configured ? describe : describe.skip).sequential("durable selection invalidation transactions", () => {
  let database: InventoryCutoverTestDatabase;
  let now: Date;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, "SELECT 1;"); }, 60_000);
  beforeEach(async () => {
    await database.pool.query("DROP SCHEMA IF EXISTS inventory,catalog,channels,dropship,ebay CASCADE");
    await database.pool.query(fixture);
    await database.pool.query(migration);
    await database.pool.query(PICKS_SELECTION_TRIGGERS_SQL);
    now = new Date(Date.now() + 1_000);
  });
  afterAll(async () => { await database?.close(); });
  const plan = async (client: InventoryAvailabilityTransactionQueryClient, productId: number) => {
    await client.query(`INSERT INTO inventory.selection_test_plan_effects SELECT $1,is_listed=1
      FROM channels.channel_product_overrides WHERE product_id=$1`, [productId]);
  };
  const processor = () => new PostgresPublicationSelectionWork(database.pool, () => now, plan);
  const state = async () => (await database.pool.query(`SELECT revision::text,acknowledged_revision::text,attempt_count,last_error_code
    FROM inventory.publication_selection_work WHERE product_id=20`)).rows[0];

  it("seeds existing mapped products only, then coalesces repeated changes in the same transaction", async () => {
    expect((await database.pool.query("SELECT product_id FROM inventory.publication_selection_work")).rows).toEqual([{ product_id: 20 }]);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE channels.channel_product_overrides SET is_listed=0 WHERE product_id=20");
      await client.query("UPDATE channels.channel_feeds SET is_active=0 WHERE product_variant_id=101");
      await client.query("COMMIT");
    } finally { client.release(); }
    expect((await state()).revision).toBe("2");
    expect(await processor().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect((await state()).acknowledged_revision).toBe("2");
    expect((await database.pool.query("SELECT * FROM inventory.selection_test_plan_effects")).rows).toEqual([{ product_id: 20, selected: false }]);
  });

  it("rolls invalidation back with the source selection", async () => {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE channels.channel_product_overrides SET is_listed=0");
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await state()).revision).toBe("1");
    expect((await database.pool.query("SELECT is_listed FROM channels.channel_product_overrides")).rows[0].is_listed).toBe(1);
  });

  it("holds business selection while provider publication is admitted, but lets unchanged ACKs commit", async () => {
    const provider = await database.pool.connect();
    try {
      await provider.query("SELECT pg_advisory_lock_shared(918419,0)");
      const failure = await database.pool.query("UPDATE channels.channel_product_overrides SET is_listed=0").catch(error => error);
      expect(publicationSelectionBusyIssue(failure)).toMatchObject({ code: "PUBLICATION_SELECTION_BUSY", retryable: true });
      await expect(database.pool.query("UPDATE channels.channel_feeds SET is_active=0")).rejects.toMatchObject({ code: "55P03", message: "PUBLICATION_SELECTION_BUSY" });
      await database.pool.query("UPDATE channels.channel_feeds SET is_active=1,quarantined_at=NULL,last_synced_qty=8");
      expect((await state()).revision).toBe("1");
    } finally { await provider.query("SELECT pg_advisory_unlock_shared(918419,0)"); provider.release(); }
    await database.pool.query("UPDATE channels.channel_feeds SET is_active=0");
    expect((await database.pool.query("SELECT is_active FROM channels.channel_feeds")).rows[0].is_active).toBe(0);
  });

  it("gates a vendor pick and invalidates only the picked size's product, as the overrides do (PLAN-B v4.1 V33)", async () => {
    const work = async () => (await database.pool.query(`SELECT product_id, revision::text
      FROM inventory.publication_selection_work ORDER BY product_id`)).rows;
    const before = await work();
    expect(before).toEqual([{ product_id: 20, revision: "1" }]);
    // A pick of an unmapped product's size (102 of 21) queues nothing; a pick of 101 bumps its mapped product 20 once.
    await database.pool.query("INSERT INTO dropship.dropship_vendor_selected_variants VALUES(10,102)");
    expect(await work()).toEqual(before);
    await database.pool.query("INSERT INTO dropship.dropship_vendor_selected_variants VALUES(10,101)");
    expect(await work()).toEqual([{ product_id: 20, revision: "2" }]);
    // An update that touches no watched column changes nothing; a removal bumps the product again.
    await database.pool.query("UPDATE dropship.dropship_vendor_selected_variants SET vendor_id=vendor_id WHERE product_variant_id=101");
    expect(await work()).toEqual([{ product_id: 20, revision: "2" }]);
    const provider = await database.pool.connect();
    try {
      await provider.query("SELECT pg_advisory_lock_shared(918419,0)");
      const failure = await database.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE product_variant_id=101")
        .catch(error => error);
      expect(publicationSelectionBusyIssue(failure)).toMatchObject({ code: "PUBLICATION_SELECTION_BUSY", retryable: true });
    } finally { await provider.query("SELECT pg_advisory_unlock_shared(918419,0)"); provider.release(); }
    await database.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE product_variant_id=101");
    expect(await work()).toEqual([{ product_id: 20, revision: "3" }]);
  });

  it("re-plans exactly the mapped products a many-row pick statement touches, as a row at a time would (PLAN-B v4.1 R4)", async () => {
    const work = async () => Object.fromEntries((await database.pool.query<{ product_id: number; revision: string }>(`SELECT product_id,
      revision::text FROM inventory.publication_selection_work ORDER BY product_id`)).rows.map((row) => [row.product_id, row.revision]));
    // Products 22 (sizes 103, 104) and 23 (sizes 105, 106) are mapped through one size each; 21 (size 102) is not.
    await database.pool.query(`INSERT INTO catalog.products VALUES(22,true,'active','toploader','supplies',false),(23,true,'active','toploader','supplies',false);
      INSERT INTO catalog.product_variants VALUES(103,22,true,true,true,'sellable',false,'SKU-103','pack'),(104,22,true,true,true,'sellable',false,'SKU-104','pack'),
        (105,23,true,true,true,'sellable',false,'SKU-105','pack'),(106,23,true,true,true,'sellable',false,'SKU-106','pack');
      INSERT INTO inventory.publication_variant_mapping_heads VALUES(3,103,403),(3,105,405);`);
    expect(await work()).toEqual({ 20: "1", 22: "1", 23: "1" });
    // One statement adds both sizes of 22, one of 23, the unmapped 102, and 103 for a second vendor.
    await database.pool.query(`INSERT INTO dropship.dropship_vendor_selected_variants VALUES(10,103),(10,104),(10,105),(10,102),(11,103)`);
    expect(await work()).toEqual({ 20: "1", 22: "2", 23: "2" });
    // A replayed add that inserts no row re-plans nothing.
    await database.pool.query(`INSERT INTO dropship.dropship_vendor_selected_variants VALUES(10,103),(11,103) ON CONFLICT DO NOTHING`);
    expect(await work()).toEqual({ 20: "1", 22: "2", 23: "2" });
    // Moving a pick to another product's size re-plans both products (0743's row path).
    await database.pool.query("UPDATE dropship.dropship_vendor_selected_variants SET product_variant_id=101 WHERE vendor_id=10 AND product_variant_id=105");
    expect(await work()).toEqual({ 20: "2", 22: "2", 23: "3" });
    // One statement removes picks of 20, 22 and 21; 23 has none left and is not touched.
    await database.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants");
    expect(await work()).toEqual({ 20: "3", 22: "3", 23: "3" });
    // A removal that deletes no row re-plans nothing.
    await database.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE product_variant_id=105");
    expect(await work()).toEqual({ 20: "3", 22: "3", 23: "3" });
  });

  it("keeps quantity and progress-only projections out of the invalidation loop", async () => {
    await database.pool.query(`INSERT INTO channels.channel_listings VALUES(3,101,'listing','offer','SKU-101',4);
      INSERT INTO dropship.dropship_vendor_listings VALUES(10,22,101,'active','listing','offer',4);
      INSERT INTO channels.ebay_listing_sync_jobs VALUES(20,'sync','{}',NULL,'queued');`);
    const before = await state();
    await database.pool.query(`UPDATE channels.channel_listings SET last_synced_qty=9;
      UPDATE dropship.dropship_vendor_listings SET pushed_quantity=9;
      UPDATE channels.ebay_listing_sync_jobs SET state='running';
      UPDATE channels.channel_feeds SET last_synced_qty=9;`);
    expect(await state()).toEqual(before);
  });

  it("rolls a failed plan back, records a safe blocker, and retries current selection after restart", async () => {
    const failing = new PostgresPublicationSelectionWork(database.pool, () => now, async (client, productId) => {
      await plan(client, productId);
      throw Object.assign(new Error("private details must not be journaled"), { code: "CANONICAL_PUBLICATION_TARGET_BLOCKED" });
    });
    expect(await failing.processDue()).toEqual({ planned: 0, blocked: 1, skipped: 0 });
    expect((await database.pool.query("SELECT * FROM inventory.selection_test_plan_effects")).rows).toEqual([]);
    expect(await state()).toMatchObject({ acknowledged_revision: "0", attempt_count: 1, last_error_code: "CANONICAL_PUBLICATION_TARGET_BLOCKED" });
    expect(await processor().processDue()).toEqual({ planned: 0, blocked: 0, skipped: 0 });
    now = new Date(now.getTime() + 30_001);
    expect(await processor().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect((await database.pool.query("SELECT outcome,error_code FROM inventory.publication_selection_attempts ORDER BY id")).rows)
      .toEqual([{ outcome: "blocked", error_code: "CANONICAL_PUBLICATION_TARGET_BLOCKED" }, { outcome: "planned", error_code: null }]);
    expect(await processor().processDue()).toEqual({ planned: 0, blocked: 0, skipped: 0 });
  });

  it("serializes concurrent workers and keeps a newer committed selection pending", async () => {
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const first = new PostgresPublicationSelectionWork(database.pool, () => now, async (client, productId) => {
      entered(); await wait; await plan(client, productId);
    }).processDue();
    await ready;
    expect(await processor().processDue()).toEqual({ planned: 0, blocked: 0, skipped: 1 });
    await expect(database.pool.query("UPDATE channels.channel_product_overrides SET is_listed=0")).rejects.toMatchObject({ code: "55P03" });
    release();
    await first;
    await database.pool.query("UPDATE channels.channel_product_overrides SET is_listed=0");
    expect(await state()).toMatchObject({ revision: "2", acknowledged_revision: "1" });
    expect(await processor().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
  });

  it("retains the pending revision when its transaction fails after planning", async () => {
    await database.pool.query(`CREATE FUNCTION inventory.reject_test_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected audit failure'; END; $$;
      CREATE TRIGGER injected_failure BEFORE INSERT ON inventory.publication_selection_attempts FOR EACH ROW EXECUTE FUNCTION inventory.reject_test_attempt();`);
    await expect(processor().processDue()).rejects.toThrow("injected audit failure");
    expect((await state()).acknowledged_revision).toBe("0");
    expect((await database.pool.query("SELECT * FROM inventory.selection_test_plan_effects")).rows).toEqual([]);
    await database.pool.query("DROP TRIGGER injected_failure ON inventory.publication_selection_attempts");
    expect(await processor().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
  });

  it("replans scheduled exposure boundaries without another source mutation", async () => {
    const boundary = new Date(now.getTime() + 60_000);
    await database.pool.query(`INSERT INTO dropship.dropship_catalog_rules(scope_type,action,is_active,ends_at)
      VALUES('catalog','include',true,$1)`, [boundary]);
    await processor().processDue();
    const acknowledged = (await state()).revision;
    now = boundary;
    expect(await processor().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect((await state()).revision).toBe((BigInt(acknowledged) + BigInt(1)).toString());
    expect(await processor().processDue()).toEqual({ planned: 0, blocked: 0, skipped: 0 });
  });

  it("activating an exact new mapping queues its current selection", async () => {
    await database.pool.query("INSERT INTO inventory.publication_variant_mapping_heads VALUES(3,102,402)");
    expect((await database.pool.query("SELECT product_id FROM inventory.publication_selection_work ORDER BY product_id")).rows)
      .toEqual([{ product_id: 20 }, { product_id: 21 }]);
  });

  it("a newly due rule boundary supersedes backoff for the previous blocked intent", async () => {
    const boundary = new Date(now.getTime() + 1_000);
    await database.pool.query(`INSERT INTO dropship.dropship_catalog_rules(scope_type,action,is_active,ends_at)
      VALUES('catalog','include',true,$1)`, [boundary]);
    const failing = new PostgresPublicationSelectionWork(database.pool, () => now, async () => { throw new Error("blocked"); });
    await failing.processDue();
    now = boundary;
    expect(await processor().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
  });

  it("keeps attempt evidence immutable", async () => {
    await processor().processDue();
    await expect(database.pool.query("DELETE FROM inventory.publication_selection_attempts")).rejects.toThrow("PUBLICATION_SELECTION_AUDIT_IMMUTABLE");
  });
});
