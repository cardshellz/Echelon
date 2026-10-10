import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresEbayListingPushRepository } from "../../infrastructure/ebay-listing-push.repository";
import { EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey } from "../../ebay-listing-workflow-lock";

const enabled = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(enabled ? describe : describe.skip).sequential("eBay first-publication PostgreSQL boundary", () => {
  let database: InventoryCutoverTestDatabase;
  let pushPool: Pool;
  let repository: PostgresEbayListingPushRepository;
  const timestamp = new Date("2026-10-09T12:00:00Z");
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, `
      CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay;
      CREATE TABLE catalog.products(id integer PRIMARY KEY,name text,sku text,description text,brand text,product_type text,
        ebay_browse_category_id text,ebay_fulfillment_policy_override text,ebay_return_policy_override text,
        ebay_payment_policy_override text,ebay_listing_excluded boolean,is_active boolean);
      CREATE TABLE channels.channel_product_overrides(product_id integer,channel_id integer,is_listed integer);
      CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products,sku text,name text,
        option1_name text,option1_value text,option2_name text,option2_value text,price_cents integer,compare_at_price_cents integer,
        weight_grams numeric,barcode text,ebay_fulfillment_policy_override text,ebay_return_policy_override text,
        ebay_payment_policy_override text,is_active boolean,sales_eligibility text,ebay_listing_excluded boolean,position integer);
      CREATE TABLE channels.channel_variant_overrides(product_variant_id integer,channel_id integer,weight_override numeric,is_listed integer);
      CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer REFERENCES catalog.product_variants,
        external_product_id text,external_variant_id text,external_sku text,external_url text,last_synced_price integer,last_synced_qty integer,
        sync_status text,sync_error text,last_synced_at timestamptz,created_at timestamptz,updated_at timestamptz,
        PRIMARY KEY(channel_id,product_variant_id));
      CREATE TABLE ebay.ebay_category_mappings(channel_id integer,product_type_slug text,ebay_browse_category_id text,
        ebay_store_category_name text,listing_enabled boolean,fulfillment_policy_override text,return_policy_override text,payment_policy_override text);
      CREATE TABLE ebay.ebay_type_aspect_defaults(product_type_slug text,aspect_name text,aspect_value text);
      CREATE TABLE ebay.ebay_product_aspect_overrides(product_id integer,aspect_name text,aspect_value text);
      INSERT INTO catalog.products(id,name,sku,is_active,product_type,brand) VALUES(20,'Pack','PACK-NEW',true,'pack','Brand');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,is_active,sales_eligibility,price_cents,position)
        VALUES(101,20,'PACK-CURRENT','Pack',true,'sellable',999,1),(102,20,'CASE','Case',true,'sellable',1999,2);
      INSERT INTO channels.channel_listings(channel_id,product_variant_id,external_sku,external_variant_id,last_synced_price,last_synced_qty,
        sync_status,last_synced_at) VALUES(67,101,'PACK-OLD','offer-101',777,33,'synced','2026-10-01T00:00:00Z');
      INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,listing_enabled,ebay_browse_category_id) VALUES(67,'pack',true,'123');
    `);
    pushPool = new Pool({ connectionString: database.connectionString, max: 10 });
    repository = new PostgresEbayListingPushRepository(pushPool, 67, () => timestamp, () => 10);
  }, 60000);
  beforeEach(async () => {
    await database.pool.query("DELETE FROM channels.channel_listings WHERE product_variant_id<>101");
    await database.pool.query("UPDATE channels.channel_listings SET external_product_id=NULL,external_sku='PACK-OLD',external_variant_id='offer-101',last_synced_price=777,last_synced_qty=33,sync_status='synced',sync_error=NULL,last_synced_at='2026-10-01T00:00:00Z'");
    await database.pool.query("UPDATE ebay.ebay_category_mappings SET listing_enabled=true");
  });
  afterAll(async () => { await pushPool?.end(); await database?.close(); });

  it("reads exact saved provider aliases while retaining current catalog identity and rejects disabled types", async () => {
    expect(await repository.readProduct(20)).toMatchObject({ id: 20, sku: "PACK-NEW" });
    expect((await repository.readVariants(20))[0]).toMatchObject({ id: 101, sku: "PACK-OLD", catalog_sku: "PACK-CURRENT" });
    expect(await repository.readCategory("pack")).toMatchObject({ ebay_browse_category_id: "123" });
    await database.pool.query("UPDATE ebay.ebay_category_mappings SET listing_enabled=false");
    await expect(repository.readCategory("pack")).rejects.toThrow("product type is disabled");
  });

  it("shares the maintenance lock, refuses concurrency, and releases it after failure", async () => {
    const lock = await database.pool.connect();
    try {
      await lock.query("SELECT pg_advisory_lock($1::integer,hashtext($2))", [EBAY_LISTING_WORKFLOW_LOCK_NAMESPACE, ebayListingWorkflowLockKey(67,20)]);
      await expect(repository.withProductLock(20, async () => "unsafe")).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
    } finally { await lock.query("SELECT pg_advisory_unlock_all()"); lock.release(); }
    await expect(repository.withProductLock(20, async () => { throw new Error("provider interrupted"); })).rejects.toThrow("provider interrupted");
    expect(await repository.withProductLock(20, async () => "recovered")).toBe("recovered");
  });

  it("rejects excess workflows before pool checkout and restores capacity after completion", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    let ready!: () => void;
    const bothEntered = new Promise<void>(resolve => { ready = resolve; });
    const work = async () => { if (++entered === 2) ready(); await waiting; };
    const first = repository.withProductLock(20, work), second = repository.withProductLock(21, work);
    try {
      await bothEntered;
      await expect(repository.withProductLock(22, async () => undefined)).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
    } finally { release(); await Promise.all([first, second]); }
    await expect(repository.withProductLock(22, async () => "done")).resolves.toBe("done");
  });

  it("rolls back every variant projection and removal if any new mapping fails", async () => {
    await database.pool.query("UPDATE channels.channel_listings SET external_product_id='listing-old'");
    const variants = await repository.readVariants(20);
    await database.pool.query(`CREATE FUNCTION channels.reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.product_variant_id=102 THEN RAISE EXCEPTION 'injected projection failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_projection BEFORE INSERT ON channels.channel_listings FOR EACH ROW EXECUTE FUNCTION channels.reject_projection()`);
    try {
      await expect(repository.projectSuccess(20, variants, {
        productId:20,status:"created",published:true,externalProductId:"listing-new",previousExternalListingId:"listing-old",removedSkus:["PACK-OLD"],externalOfferIds:{101:"offer-101",102:"offer-102"},externalVariantIds:{},
      }, new Map([[101,999],[102,1999]]), ["PACK-OLD"])).rejects.toThrow("injected projection failure");
    } finally { await database.pool.query("DROP TRIGGER reject_projection ON channels.channel_listings"); }
    const row = (await database.pool.query("SELECT * FROM channels.channel_listings")).rows[0];
    expect(row).toMatchObject({ external_product_id:"listing-old",external_variant_id:"offer-101",last_synced_price:777,last_synced_qty:33 });
  });

  it("refuses a mapping edited during provider work without overwriting the editor or other variants", async () => {
    const snapshot = await repository.readVariants(20);
    await database.pool.query("UPDATE channels.channel_listings SET external_variant_id='operator-corrected-offer' WHERE product_variant_id=101");
    await expect(repository.projectSuccess(20, snapshot, {
      productId:20,status:"created",published:true,externalProductId:"listing-new",externalOfferIds:{101:"offer-101",102:"offer-102"},externalVariantIds:{},
    }, new Map([[101,999],[102,1999]]))).rejects.toMatchObject({ code:"EBAY_SYNC_PROJECTION_IDENTITY_CHANGED" });
    const rows = (await database.pool.query("SELECT product_variant_id,external_variant_id,last_synced_price FROM channels.channel_listings")).rows;
    expect(rows).toEqual([{ product_variant_id:101, external_variant_id:"operator-corrected-offer", last_synced_price:777 }]);
  });

  it("does not clear a removed SKU that was remapped to a different listing during rebuild", async () => {
    const variants = (await repository.readVariants(20)).filter(variant => variant.id === 102);
    await database.pool.query("UPDATE channels.channel_listings SET external_product_id='operator-remapped-listing' WHERE product_variant_id=101");
    await expect(repository.projectSuccess(20, variants, {
      productId:20,status:"created",published:true,externalProductId:"listing-new",previousExternalListingId:"listing-old",removedSkus:["PACK-OLD"],
      externalOfferIds:{102:"offer-102"},externalVariantIds:{},
    }, new Map([[102,1999]]), ["PACK-OLD"])).rejects.toMatchObject({ code:"EBAY_SYNC_PROJECTION_IDENTITY_CHANGED" });
    expect((await database.pool.query("SELECT product_variant_id,external_product_id FROM channels.channel_listings")).rows)
      .toEqual([{ product_variant_id:101,external_product_id:"operator-remapped-listing" }]);
  });

  it("projects one complete identity atomically without replacing acknowledged quantities with draft ATP", async () => {
    const variants = await repository.readVariants(20);
    await repository.projectSuccess(20, variants, {
      productId:20,status:"created",published:true,externalProductId:"listing-new",externalOfferIds:{101:"offer-101",102:"offer-102"},externalVariantIds:{},
    }, new Map([[101,999],[102,1999]]));
    const rows = (await database.pool.query("SELECT * FROM channels.channel_listings ORDER BY product_variant_id")).rows;
    expect(rows[0]).toMatchObject({ external_product_id:"listing-new",external_sku:"PACK-OLD",last_synced_qty:33,last_synced_price:999,sync_status:"synced" });
    expect(rows[1]).toMatchObject({ external_product_id:"listing-new",external_sku:"CASE",last_synced_qty:null,last_synced_price:1999 });
    expect(rows[0].last_synced_at).toEqual(timestamp);
  });

  it.each([false, true])("projects an in-place change while preserving the old listing ID and retained=%s member", async retained => {
    await database.pool.query("UPDATE channels.channel_listings SET external_product_id='listing-old'");
    const variants = (await repository.readVariants(20)).filter(variant => variant.id === 102);
    const removedSkus = retained ? [] : ["PACK-OLD"];
    await repository.projectSuccess(20, variants, {
      productId:20,status:"updated",published:true,externalProductId:"listing-old",previousExternalListingId:"listing-old",
      removedSkus,externalOfferIds:{102:"offer-102"},externalVariantIds:{102:"offer-102"},
    }, new Map([[102,1999]]), removedSkus);
    const rows = (await database.pool.query("SELECT * FROM channels.channel_listings ORDER BY product_variant_id")).rows;
    expect(rows[0]).toMatchObject({ external_product_id:retained ? "listing-old" : null,
      external_variant_id:retained ? "offer-101" : null,external_sku:"PACK-OLD",last_synced_qty:33,last_synced_price:777 });
    expect(rows[1]).toMatchObject({ external_product_id:"listing-old",external_variant_id:"offer-102",last_synced_qty:null,last_synced_price:1999 });
  });

  it("records errors without clearing verified identity, price, quantity, or last success time", async () => {
    await repository.recordFailure(20,"eBay interrupted");
    const row = (await database.pool.query("SELECT * FROM channels.channel_listings WHERE product_variant_id=101")).rows[0];
    expect(row).toMatchObject({ external_sku:"PACK-OLD",external_variant_id:"offer-101",last_synced_price:777,last_synced_qty:33,
      sync_status:"error",sync_error:"eBay interrupted",last_synced_at:new Date("2026-10-01T00:00:00Z") });
  });
});
