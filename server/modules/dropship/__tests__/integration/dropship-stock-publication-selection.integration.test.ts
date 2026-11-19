import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readDropshipListingStockSelection } from "../../stock-publication-selection";
import { LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL } from "../fixtures/listing-end-reduced.fixture";

const configured = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const now = new Date("2026-10-12T12:00:00Z");
/** The fingerprint main's reader (65f26268b) computes for this fixture's first read: a listing without a limit hashes as before. */
const MAIN_FINGERPRINT = "b0ef162dd96302db265a41d5a820f3e73b7d2520f7aece6d3b06a9c3a039adbf";
(configured ? describe : describe.skip).sequential("Dropship stock selection owner SQL", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => {
    // Reduced real named-schema fixture proves owner queries and predicates;
    // it does not claim a full production migration installation.
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, `
      CREATE SCHEMA catalog; CREATE SCHEMA dropship;
      CREATE TABLE catalog.products(id integer PRIMARY KEY,is_active boolean,status text,product_type text,category text,ebay_listing_excluded boolean);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer,sku text,uom_type text,is_active boolean,
        requires_shipping boolean,track_inventory boolean,sales_eligibility text,ebay_listing_excluded boolean);
      CREATE TABLE catalog.product_line_products(product_id integer,product_line_id integer);
      CREATE TABLE dropship.dropship_store_connections(id integer PRIMARY KEY,vendor_id integer,platform text,
        external_account_id text,provider_environment text,status text);
      CREATE TABLE dropship.dropship_store_listing_configs(id integer PRIMARY KEY,store_connection_id integer,platform text,listing_mode text,inventory_mode text,is_active boolean);
      CREATE TABLE dropship.dropship_catalog_rules(id integer PRIMARY KEY,scope_type text,action text,product_line_id integer,
        product_id integer,product_variant_id integer,category text,starts_at timestamptz,ends_at timestamptz,is_active boolean,priority integer);
      -- The vendor's one-time picks (PLAN-B v4.1 §9 row 4), reduced.
      CREATE TABLE dropship.dropship_vendor_selected_variants(vendor_id integer,product_variant_id integer,PRIMARY KEY(vendor_id,product_variant_id));
      CREATE TABLE dropship.dropship_vendor_variant_overrides(vendor_id integer,product_variant_id integer,enabled_override boolean);
      CREATE TABLE dropship.dropship_vendor_listings(id integer PRIMARY KEY,vendor_id integer,store_connection_id integer,
        product_variant_id integer,platform text,status text,external_listing_id text,external_offer_id text,updated_at timestamptz,
        vendor_quantity_limit integer,
        -- #1900's end facts: the shared listing SQL returns them for the effects reader (V21); SPR drops them.
        marketplace_ended_at timestamptz,marketplace_issue_codes text[] NOT NULL DEFAULT '{}');
      CREATE TABLE dropship.dropship_listing_push_jobs(id integer PRIMARY KEY,vendor_id integer,store_connection_id integer,job_type text,status text);
      CREATE TABLE dropship.dropship_listing_push_job_items(id integer PRIMARY KEY,job_id integer,listing_id integer,product_variant_id integer,
        action text,status text,result jsonb,created_at timestamptz);
      -- PR C's end requests (PLAN-C v4.1 §7), reduced: the shared listing SQL reads the open end of each listing.
      ${LISTING_END_REQUESTS_REDUCED_FIXTURE_SQL}
    `);
  }, 60_000);
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE catalog.products,catalog.product_variants,catalog.product_line_products,
      dropship.dropship_store_connections,dropship.dropship_store_listing_configs,dropship.dropship_catalog_rules,
      dropship.dropship_vendor_selected_variants,dropship.dropship_vendor_variant_overrides,dropship.dropship_vendor_listings,
      dropship.dropship_listing_push_jobs,dropship.dropship_listing_push_job_items,dropship.dropship_listing_end_requests;
      INSERT INTO catalog.products VALUES (20,true,'active','Toploader','Supplies',false),(21,true,'active','Toploader','Supplies',false);
      INSERT INTO catalog.product_variants VALUES(101,20,'SKU-101','pack',true,true,true,'sellable',false),
        (102,20,'SKU-102','case',true,true,true,'sellable',false),(103,21,'SKU-103','pack',true,true,true,'sellable',false);
      INSERT INTO catalog.product_line_products VALUES(20,3);
      INSERT INTO dropship.dropship_store_connections VALUES(22,10,'ebay','seller-1','production','connected'),(23,11,'ebay','seller-2','production','connected');
      INSERT INTO dropship.dropship_store_listing_configs VALUES(1,22,'ebay','live','managed_quantity_sync',true),(2,23,'ebay','live','managed_quantity_sync',true);
      INSERT INTO dropship.dropship_catalog_rules VALUES(1,'catalog','include',NULL,NULL,NULL,NULL,NULL,NULL,true,0);
      -- At main a vendor 'catalog' include chose every size; the conversion makes it these picks (§6 step 4).
      INSERT INTO dropship.dropship_vendor_selected_variants VALUES(10,101),(10,102),(10,103);
      INSERT INTO dropship.dropship_vendor_listings VALUES(50,10,22,101,'ebay','active','listing-1','offer-1','2026-10-12T10:00:00Z');`);
  });
  afterAll(async () => { await database?.close(); });
  const read = (productVariantIds: readonly number[] = [101, 102], date = now) => readDropshipListingStockSelection(database.pool,
    { storeConnectionId: 22, productId: 20, productVariantIds, now: date });

  it("reads exact store selection without ATP, pricing, photos or provider dependencies", async () => {
    const result = await read();
    expect(result.variants).toMatchObject([{ productVariantId: 101, action: "publish" }, { productVariantId: 102, action: "read_only" }]);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect((await read([102, 101], new Date("2026-10-12T13:00:00Z"))).fingerprint).toBe(result.fingerprint);
  });

  it("retains deselection zero duty after manual quantity configuration", async () => {
    await database.pool.query(`UPDATE dropship.dropship_store_listing_configs SET inventory_mode='manual_quantity';
      INSERT INTO dropship.dropship_vendor_variant_overrides VALUES(10,101,false);`);
    expect((await read()).variants).toMatchObject([{ action: "zero" }, { action: "read_only" }]);
  });

  it.each([
    { listingMode: "manual_only", inventoryMode: "managed_quantity_sync" },
    { listingMode: "draft_first", inventoryMode: "managed_quantity_sync" },
    { listingMode: "live", inventoryMode: "manual_quantity" },
    { listingMode: "live", inventoryMode: "disabled" },
  ])("clears the retained destination when selected configuration becomes $listingMode/$inventoryMode", async config => {
    const before = await read();
    expect(before.variants.map(row => row.action)).toEqual(["publish", "read_only"]);
    await database.pool.query(`UPDATE dropship.dropship_store_listing_configs
      SET listing_mode=$1,inventory_mode=$2 WHERE store_connection_id=22`, [config.listingMode, config.inventoryMode]);
    const changed = await read();
    expect(changed.variants.map(row => row.action)).toEqual(["zero", "read_only"]);
    expect(changed.fingerprint).not.toBe(before.fingerprint);
    expect((await database.pool.query(`SELECT external_listing_id,external_offer_id
      FROM dropship.dropship_vendor_listings WHERE id=50`)).rows[0])
      .toEqual({ external_listing_id: "listing-1", external_offer_id: "offer-1" });
    await database.pool.query(`UPDATE dropship.dropship_store_listing_configs
      SET listing_mode='live',inventory_mode='managed_quantity_sync' WHERE store_connection_id=22`);
    expect((await read()).variants.map(row => row.action)).toEqual(["publish", "read_only"]);
  });

  it("does not borrow a listing or a pick from another vendor/store", async () => {
    await database.pool.query(`DELETE FROM dropship.dropship_vendor_listings;
      INSERT INTO dropship.dropship_vendor_listings VALUES(51,11,23,101,'ebay','active','other-listing','other-offer',now());
      UPDATE dropship.dropship_vendor_selected_variants SET vendor_id=11;`);
    expect((await read()).variants.map(row => row.action)).toEqual(["none", "none"]);
  });

  // V15 (FIDELITY-12): the listing lifecycle reads `listingSelected` from this reader; it now follows the picks alone.
  it("answers listingSelected from the vendor's picks: a removed pick zeroes its listing and is no longer selected", async () => {
    const picked = await read();
    expect(picked.variants.map(row => [row.productVariantId, row.listingSelected, row.action])).toEqual([
      [101, true, "publish"], [102, true, "read_only"]]);
    await database.pool.query("DELETE FROM dropship.dropship_vendor_selected_variants WHERE vendor_id=10 AND product_variant_id=101");
    const removed = await read();
    expect(removed.variants.map(row => [row.productVariantId, row.listingSelected, row.action, row.reason])).toEqual([
      [101, false, "zero", "missing_vendor_include_rule"], [102, true, "read_only", "selected_catalog_preview"]]);
    expect(removed.fingerprint).not.toBe(picked.fingerprint);
    // Another vendor's pick of the same size changes nothing for this store.
    await database.pool.query("INSERT INTO dropship.dropship_vendor_selected_variants VALUES(11,101)");
    expect((await read()).fingerprint).toBe(removed.fingerprint);
  });

  it("reports a requested variant owned by a different product", async () => {
    expect((await read([103])).variants).toMatchObject([{ action: "none", blockers: [{ code: "DROPSHIP_STOCK_CATALOG_IDENTITY_MISSING" }] }]);
  });

  it.each(["queued", "failed", "blocked"])("keeps a %s live push intent without inventing provider IDs", async status => {
    await database.pool.query(`UPDATE dropship.dropship_vendor_listings SET status=$1,external_listing_id=NULL,external_offer_id=NULL`, [status]);
    await saveIntent(status);
    expect((await read([101])).variants).toMatchObject([{ action: "publish", reason: "saved_live_push" }]);
  });

  it("keeps a failed unpublished row as stock-only preview when there is no live intent", async () => {
    await database.pool.query(`UPDATE dropship.dropship_vendor_listings SET status='failed',external_listing_id=NULL,external_offer_id=NULL`);
    expect((await read([101])).variants[0].action).toBe("read_only");
  });

  it.each(["cancelled_job", "cancelled_item", "draft_intent", "wrong_store", "wrong_listing", "wrong_intent_variant"])(
    "does not use %s as a saved live publication request", async reason => {
      await database.pool.query(`UPDATE dropship.dropship_vendor_listings SET status='failed',external_listing_id=NULL,external_offer_id=NULL`);
      await saveIntent("failed");
      if (reason === "cancelled_job") await database.pool.query(`UPDATE dropship.dropship_listing_push_jobs SET status='cancelled'`);
      if (reason === "cancelled_item") await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET status='cancelled'`);
      if (reason === "draft_intent") await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items
        SET result=jsonb_set(result,'{listingIntent,listingMode}','"draft_first"')`);
      if (reason === "wrong_store") await database.pool.query(`UPDATE dropship.dropship_listing_push_jobs SET store_connection_id=23`);
      if (reason === "wrong_listing") await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET listing_id=999`);
      if (reason === "wrong_intent_variant") await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items
        SET result=jsonb_set(result,'{listingIntent,productVariantId}','999')`);
      expect((await read([101])).variants[0].action).toBe("read_only");
    });

  it("does not resurrect ended listing from a completed historical push", async () => {
    await saveIntent("completed");
    await database.pool.query(`UPDATE dropship.dropship_vendor_listings SET status='ended',updated_at='2026-10-12T12:00:00Z'`);
    expect((await read([101])).variants[0].action).toBe("none");
    await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET created_at='2026-10-12T13:00:00Z',status='queued'`);
    expect((await read([101])).variants[0].action).toBe("publish");
  });

  it("preserves paused retained IDs as zero duty", async () => {
    await database.pool.query(`UPDATE dropship.dropship_vendor_listings SET status='paused'`);
    expect((await read([101])).variants[0].action).toBe("zero");
  });

  it("changes the fingerprint at scheduled rule expiry, without hashing observation time", async () => {
    await database.pool.query(`UPDATE dropship.dropship_catalog_rules SET ends_at='2026-10-12T13:00:00Z'`);
    const before = await read([101]);
    const after = await read([101], new Date("2026-10-12T13:00:00Z"));
    expect(after.variants[0].action).toBe("zero");
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  // eBay sync-back owner rule 1 (plan v4 SB29): the vendor's limit rides on the publish decision; without one, nothing changes.
  it("carries the vendor's limit on the publish decision, and keeps every no-limit fingerprint exactly main's", async () => {
    const before = await read();
    expect(before.fingerprint).toBe(MAIN_FINGERPRINT);
    expect(before.variants[0]).not.toHaveProperty("publishLimitUnits");
    await database.pool.query("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit=5 WHERE id=50");
    const limited = await read();
    expect(limited.variants[0]).toMatchObject({ productVariantId: 101, action: "publish", publishLimitUnits: 5 });
    expect(limited.fingerprint).not.toBe(before.fingerprint);
    await database.pool.query("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit=0 WHERE id=50");
    expect((await read()).variants[0]).toMatchObject({ publishLimitUnits: 0 });
    await database.pool.query("UPDATE dropship.dropship_vendor_listings SET vendor_quantity_limit=NULL WHERE id=50");
    expect((await read()).fingerprint).toBe(before.fingerprint);
  });

  // PR C (PLAN-C v4.1 §7, D42): while an end is open nothing sells on the listing; main's fingerprint holds without one.
  it("zeroes a listing with an open end request, and fingerprints only that an end is open", async () => {
    const before = await read();
    expect(before.fingerprint).toBe(MAIN_FINGERPRINT);
    await database.pool.query("INSERT INTO dropship.dropship_listing_end_requests (listing_id, state) VALUES (50, 'pending')");
    const pending = await read();
    expect(pending.variants[0]).toMatchObject({ productVariantId: 101, action: "zero", reason: "listing_end_in_progress", listingSelected: true });
    expect(pending.variants[1]).toEqual(before.variants[1]);
    expect(pending.fingerprint).not.toBe(MAIN_FINGERPRINT);
    for (const state of ["ending", "failed"]) {
      await database.pool.query("UPDATE dropship.dropship_listing_end_requests SET state=$1 WHERE listing_id=50", [state]);
      expect((await read()).fingerprint).toBe(pending.fingerprint);
    }
    // A closed end (superseded, or Card Shellz's finished end on a listing a push later relisted) is no longer open.
    await database.pool.query("UPDATE dropship.dropship_listing_end_requests SET state='superseded' WHERE listing_id=50");
    expect(await read()).toEqual(before);
    await database.pool.query(`INSERT INTO dropship.dropship_listing_end_requests (listing_id, state, ended_at)
      VALUES (50, 'ended', '2026-10-12T11:00:00Z')`);
    expect((await read()).fingerprint).toBe(MAIN_FINGERPRINT);
  });

  it("rejects duplicate/invalid IDs and a missing store", async () => {
    await expect(read([101, 101])).rejects.toThrow("Variant IDs must be unique");
    await expect(read([-1])).rejects.toThrow();
    await expect(readDropshipListingStockSelection(database.pool, { storeConnectionId: 999, productId: 20,
      productVariantIds: [101], now })).rejects.toMatchObject({ code: "DROPSHIP_STOCK_STORE_NOT_FOUND" });
  });

  async function saveIntent(status: string): Promise<void> {
    await database.pool.query(`INSERT INTO dropship.dropship_listing_push_jobs VALUES(60,10,22,'push','failed');
      INSERT INTO dropship.dropship_listing_push_job_items VALUES(70,60,50,101,'push','queued',
        '{"listingIntent":{"platform":"ebay","productVariantId":101,"listingMode":"live","inventoryMode":"managed_quantity_sync"}}','2026-10-12T11:00:00Z')`);
    await database.pool.query(`UPDATE dropship.dropship_listing_push_job_items SET status=$1`, [status]);
  }
});
