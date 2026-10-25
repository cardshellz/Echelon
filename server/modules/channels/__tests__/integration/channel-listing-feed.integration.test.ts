import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { EbaySyncSelectionReader } from "../../infrastructure/ebay-sync-selection.reader";
import { EbayListingFeedReader } from "../../infrastructure/ebay-listing-feed.reader";
import { EbayListingFeedInventoryService } from "../../application/ebay-listing-feed-inventory.service";
import { ChannelReadCoordinator } from "../../../marketplace-listings/application/channel-read-coordinator";
import { readEbayListingPhotoReadiness } from "../../ebay-listing-photo-readiness";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";

// Supporting read-model fixture. Durable queue/index tests live in the sync
// recovery suite, which installs the actual production migrations unchanged.
const schema = `
CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay;
CREATE TABLE catalog.products(id integer PRIMARY KEY,name text,sku text,product_type text,is_active boolean DEFAULT true,
 ebay_listing_excluded boolean DEFAULT false,ebay_browse_category_id text,ebay_browse_category_name text,
 ebay_fulfillment_policy_override text,ebay_return_policy_override text,ebay_payment_policy_override text);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer REFERENCES catalog.products(id),sku text,name text,
 is_active boolean DEFAULT true,sales_eligibility text DEFAULT 'sellable',price_cents integer DEFAULT 1000,position integer DEFAULT 0,
 requires_shipping boolean DEFAULT true,track_inventory boolean DEFAULT true,ebay_listing_excluded boolean DEFAULT false,
 ebay_fulfillment_policy_override text,ebay_return_policy_override text,ebay_payment_policy_override text);
CREATE TABLE catalog.product_types(slug text PRIMARY KEY,name text,sort_order integer);
CREATE TABLE ebay.ebay_category_mappings(channel_id integer,product_type_slug text,listing_enabled boolean,
 ebay_browse_category_id text,ebay_browse_category_name text,ebay_store_category_id text,ebay_store_category_name text,
 PRIMARY KEY(channel_id,product_type_slug));
CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer REFERENCES catalog.products(id),is_listed integer,
 PRIMARY KEY(channel_id,product_id));
CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer REFERENCES catalog.product_variants(id),is_listed integer,
 PRIMARY KEY(channel_id,product_variant_id));
CREATE TABLE channels.channel_listings(id integer PRIMARY KEY,channel_id integer,product_variant_id integer REFERENCES catalog.product_variants(id),
 external_product_id text,external_variant_id text,sync_status text,sync_error text,UNIQUE(channel_id,product_variant_id));
CREATE TABLE channels.ebay_listing_sync_jobs(channel_id integer,product_id integer,state text);
CREATE TABLE channels.ebay_listing_sync_admission_failures(channel_id integer,product_id integer);
CREATE TABLE ebay.ebay_category_aspects(category_id text,aspect_name text,aspect_required boolean);
CREATE TABLE ebay.ebay_type_aspect_defaults(product_type_slug text,aspect_name text);
CREATE TABLE ebay.ebay_product_aspect_overrides(product_id integer,aspect_name text);
CREATE TABLE catalog.product_assets(id integer PRIMARY KEY,product_id integer,product_variant_id integer,asset_type text,url text,
 position integer,is_primary integer,storage_type text,mime_type text,file_data bytea);
CREATE TABLE channels.channel_asset_overrides(channel_id integer,product_asset_id integer,is_included integer,url_override text,position_override integer);
INSERT INTO catalog.product_types VALUES('cards','Cards',1),('disabled','Disabled',2);
INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,listing_enabled,ebay_browse_category_id)
 VALUES(67,'cards',true,'123'),(67,'disabled',false,'456');
INSERT INTO catalog.products(id,name,sku,product_type) SELECT id,'Product '||id,'SKU-'||id,
 CASE WHEN id IN(1,5,8,11) THEN 'cards' WHEN id=9 THEN 'disabled' ELSE NULL END FROM generate_series(1,11) id;
UPDATE catalog.products SET is_active=false WHERE id IN(6,11);
UPDATE catalog.products SET ebay_listing_excluded=true WHERE id=5;
UPDATE catalog.products SET ebay_browse_category_id='789' WHERE id=10;
INSERT INTO catalog.product_variants(id,product_id,sku) SELECT id*100,id,'SKU-'||id||'-P1' FROM catalog.products WHERE id NOT IN(2,7,8);
UPDATE catalog.product_variants SET is_active=false WHERE product_id=4;
INSERT INTO channels.channel_product_overrides VALUES(67,3,1);
INSERT INTO channels.channel_listings VALUES(4,67,400,'retained-4','offer-4','listed',NULL),(6,67,600,'retained-6','offer-6','listed',NULL);
INSERT INTO channels.ebay_listing_sync_admission_failures VALUES(67,7);
INSERT INTO catalog.product_assets VALUES(1,1,NULL,'image','https://example.com/one.jpg',0,1,'url',NULL,NULL);
`;
const configured = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(configured ? describe : describe.skip).sequential("canonical feed selection and bounded PostgreSQL read leases", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: pg.Pool;
  const inventoryFailures = vi.fn();
  const inventoryReads = vi.fn();
  const publicUrl = createCatalogPublicImageUrl({ PUBLIC_APP_URL: "https://example.com" });
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, schema);
    pool = new pg.Pool({ connectionString: database.connectionString, max: 1, connectionTimeoutMillis: 250,
      options: "-c search_path=catalog,channels,ebay,public" });
  });
  beforeEach(() => { inventoryFailures.mockClear(); inventoryReads.mockClear(); });
  afterAll(async () => { await pool?.end(); await database?.close(); });
  function reader(databaseQueries: Pick<pg.Pool, "query"> = pool, channelId = 67, nestedPool = pool) {
    return new EbayListingFeedReader(databaseQueries, channelId, {
      inventory: new EbayListingFeedInventoryService({ getAtpPerVariant: async productId => {
        inventoryReads(productId);
        // Exercise the nested owner's actual pool acquisition without changing
        // or asserting ATP calculations; quantity semantics are a separate task.
        const rows = await nestedPool.query('SELECT id AS "productVariantId", 7 AS "atpUnits" FROM catalog.product_variants WHERE product_id=$1 AND is_active', [productId]);
        return rows.rows;
      } }, { createReference: () => "read-reference", reportFailure: inventoryFailures }),
      readPhotos: input => readEbayListingPhotoReadiness(nestedPool, input, publicUrl),
      resolvePrice: async (_productId, variantId) => (await nestedPool.query("SELECT price_cents FROM catalog.product_variants WHERE id=$1", [variantId])).rows[0].price_cents,
    });
  }
  it("uses identical bulk/feed membership while retaining archived identities and failed catalog work", async () => {
    const selection = await new EbaySyncSelectionReader(pool, 67).read();
    const feed = await reader().read();
    expect(selection.filter(row => row.selection.syncIncluded).map(row => row.productId)).toEqual([1,3,4,8,10]);
    expect(feed.feed.map(row => row.id).sort((a,b) => a-b)).toEqual([1,3,4,5,6,7,8,9,10]);
    expect(feed.feed.filter(row => row.syncIncluded).map(row => row.id).sort((a,b) => a-b))
      .toEqual(selection.filter(row => row.selection.syncIncluded).map(row => row.productId));
    expect(feed.syncIncludedCount).toBe(5);
    expect(feed.feed.find(row => row.id === 4)?.variants).toEqual([]);
    expect(feed.feed.find(row => row.id === 7)).toMatchObject({ syncIncluded: false, variantCount: 0 });
    expect(feed.feed.find(row => row.id === 1)).toMatchObject({ imageCount: 1, inventoryIssue: null,
      inventoryReadState: "not_requested", variants: [{ inventoryQuantity: null }] });
    expect(inventoryReads).not.toHaveBeenCalled();
    expect(await reader().readInventory(1)).toMatchObject({ productId: 1, quantities: [{ variantId: 100, quantity: 7 }], issue: null });
    expect(inventoryReads.mock.calls).toEqual([[1]]);
    expect(inventoryFailures).not.toHaveBeenCalled();
  });
  it("coalesces 32 overlapping reads and leaves the sole connection available for unrelated work", async () => {
    const owner = reader(); const load = vi.fn(() => owner.read());
    const coordinator = new ChannelReadCoordinator<Awaited<ReturnType<typeof owner.read>>>();
    const reads = Array.from({ length: 32 }, () => coordinator.read(67, load));
    const otherWork = pool.query("SELECT 42 AS value");
    const results = await Promise.all(reads);
    expect(load).toHaveBeenCalledTimes(1);
    expect(results.every(result => result === results[0])).toBe(true);
    expect((await otherWork).rows[0].value).toBe(42);
    expect(pool.waitingCount).toBe(0); expect(pool.idleCount).toBe(1);
    expect(inventoryFailures).not.toHaveBeenCalled();
  });
  it("reproduces the prior nested lease starvation and recovers using the production reader without that lease", async () => {
    const held = await pool.connect();
    try {
      // This is the old route's lifetime: hold a session while nested owners
      // acquire the same pool. The timeout is from real pg-pool, not a mock.
      await expect(reader(held).read()).rejects.toThrow("timeout exceeded when trying to connect");
      // The nested photo owner still proves why retaining a lease is unsafe.
      // The current feed must not invoke the inventory owner at all.
      expect(inventoryReads).not.toHaveBeenCalled();
    } finally { held.release(); }
    inventoryFailures.mockClear();
    await expect(reader().read()).resolves.toMatchObject({ syncIncludedCount: 5 });
    expect(inventoryFailures).not.toHaveBeenCalled();
  });
  it("does not cache a failed read or share results across channels", async () => {
    const coordinator = new ChannelReadCoordinator<number>();
    const load = vi.fn(async () => { await pool.query("SELECT 1/0"); return 1; });
    const failed = await Promise.allSettled([coordinator.read(67, load), coordinator.read(67, load)]);
    expect(failed.every(result => result.status === "rejected")).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await Promise.all([coordinator.read(67, async () => 67),coordinator.read(68, async () => 68)])).toEqual([67,68]);
  });
  it("reproduces full 20-connection starvation with overlapping legacy reads, then handles that concurrency without starvation", async () => {
    const shared = new pg.Pool({ connectionString: database.connectionString, max: 20, connectionTimeoutMillis: 2000,
      options: "-c search_path=catalog,channels,ebay,public", application_name: "channel-feed-pool-reproduction" });
    try {
      const held = await Promise.all(Array.from({ length: 20 }, () => shared.connect()));
      try {
        const legacy = Promise.allSettled(held.map(client => reader(client, 67, shared).read()));
        await vi.waitFor(() => expect(shared.waitingCount).toBe(80), { timeout: 1500, interval: 5 });
        expect(shared.totalCount - shared.idleCount).toBe(20);
        const snapshot = (await database.pool.query("SELECT state,count(*)::int AS sessions FROM pg_stat_activity WHERE application_name='channel-feed-pool-reproduction' GROUP BY state")).rows;
        expect(snapshot).toEqual([{ state: "idle", sessions: 20 }]);
        console.info(JSON.stringify({ event: "channel_feed_pool_reproduction", checkedOut: 20, waiting: 80, databaseSessions: snapshot }));
        const outcomes = await legacy;
        expect(outcomes.every(result => result.status === "rejected" && result.reason.message === "timeout exceeded when trying to connect")).toBe(true);
      } finally { for (const client of held) client.release(); }
      const owner = reader(shared, 67, shared);
      const coordinator = new ChannelReadCoordinator<Awaited<ReturnType<typeof owner.read>>>();
      const load = vi.fn(() => owner.read()); inventoryFailures.mockClear();
      await Promise.all(Array.from({ length: 32 }, () => coordinator.read(67, load)));
      expect(load).toHaveBeenCalledTimes(1); expect(inventoryFailures).not.toHaveBeenCalled();
      expect(shared.waitingCount).toBe(0); expect(shared.idleCount).toBe(shared.totalCount);
    } finally { await shared.end(); }
  });
  it("recomputes membership after archival and reactivation without losing the retained listing", async () => {
    try {
      await pool.query("UPDATE catalog.products SET is_active=true WHERE id=6");
      const active = await reader().read();
      expect(active.feed.find(row => row.id === 6)?.syncIncluded).toBe(true);
      await pool.query("UPDATE catalog.products SET is_active=false WHERE id=6");
      const archived = await reader().read();
      expect(archived.feed.find(row => row.id === 6)?.syncIncluded).toBe(false);
      expect(archived.syncIncludedCount).toBe(active.syncIncludedCount - 1);
      expect((await pool.query("SELECT external_product_id FROM channels.channel_listings WHERE id=6")).rows[0].external_product_id).toBe("retained-6");
    } finally { await pool.query("UPDATE catalog.products SET is_active=false WHERE id=6"); }
  });

  it("keeps a 433-product feed bounded and leaves slow inventory outside the feed's critical path", async () => {
    // Match the measured production cardinality without depending on its SKUs.
    await pool.query(`INSERT INTO catalog.products(id,name,sku,product_type)
      SELECT id,'Additional '||id,'ADDITIONAL-'||id,'cards' FROM generate_series(1000,1423) id;
      INSERT INTO catalog.product_variants(id,product_id,sku)
      SELECT id*100,id,'ADDITIONAL-'||id FROM catalog.products WHERE id>=1000;`);
    let active = 0, peak = 0, photoReads = 0;
    const inventory = { readProduct: vi.fn(async () => { throw new Error("Inventory must be a scoped read"); }) };
    try {
      const owner = new EbayListingFeedReader(pool, 67, {
        inventory,
        readPhotos: async input => {
          photoReads++; active++; peak = Math.max(peak, active);
          try {
            await pool.query("SELECT pg_sleep(0.001)");
            return await readEbayListingPhotoReadiness(pool, input, publicUrl);
          } finally { active--; }
        },
        resolvePrice: async (_productId, variantId) => (await pool.query(
          "SELECT price_cents FROM catalog.product_variants WHERE id=$1", [variantId])).rows[0].price_cents,
      });
      const result = await owner.read();
      expect(result.feed).toHaveLength(433);
      expect(photoReads).toBe(433); expect(peak).toBe(4); expect(active).toBe(0);
      expect(inventory.readProduct).not.toHaveBeenCalled();
      expect(result.feed.every(row => row.variants.every(variant => variant.inventoryQuantity === null))).toBe(true);
      expect(pool.waitingCount).toBe(0);
    } finally {
      await pool.query("DELETE FROM catalog.product_variants WHERE product_id>=1000; DELETE FROM catalog.products WHERE id>=1000");
    }
  });

  it("bounds distinct inventory reads and coalesces duplicates with a real two-connection pool", async () => {
    const shared = new pg.Pool({ connectionString: database.connectionString, max: 2, connectionTimeoutMillis: 2000 });
    const coordinator = new ChannelReadCoordinator<number>(2);
    let active = 0, peak = 0;
    const load = vi.fn(async () => {
      active++; peak = Math.max(peak, active);
      try { return (await shared.query("SELECT 7 AS quantity, pg_sleep(0.005)")).rows[0].quantity; }
      finally { active--; }
    });
    try {
      const reads = Array.from({ length: 32 }, (_, index) => coordinator.read(index % 16 + 1, load));
      expect(await Promise.all(reads)).toEqual(Array(32).fill(7));
      expect(load).toHaveBeenCalledTimes(16); expect(peak).toBe(2); expect(active).toBe(0);
      expect(shared.waitingCount).toBe(0);
      await expect(coordinator.read(1, async () => { await shared.query("SELECT 1/0"); return 0; })).rejects.toThrow();
      expect(await coordinator.read(1, load)).toBe(7);
    } finally { await shared.end(); }
  });

  it("scopes inventory read failures to included active members and retains an actionable reference", async () => {
    let fail = false;
    const quantities = vi.fn(async () => (await pool.query(fail ? "SELECT 1/0" :
      'SELECT id AS "productVariantId",0 AS "atpUnits" FROM catalog.product_variants WHERE false')).rows);
    const reportFailure = vi.fn();
    const inventory = new EbayListingFeedInventoryService({ getAtpPerVariant: quantities }, {
      createReference: () => "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775", reportFailure,
    });
    const owner = new EbayListingFeedReader(pool, 67, {
      inventory, readPhotos: input => readEbayListingPhotoReadiness(pool, input, publicUrl), resolvePrice: async () => 1000,
    });
    expect(await owner.readInventory(1)).toMatchObject({ quantities: [{ variantId: 100, quantity: null }],
      issue: { code: "EBAY_FEED_QUANTITY_MISSING" } });
    // Excluded product, archived product and archived variant are displayable
    // history, not new obligations to manufacture a destination quantity.
    expect(await owner.readInventory(5)).toMatchObject({ issue: null });
    expect(await owner.readInventory(6)).toMatchObject({ issue: null });
    const beforeArchivedRead = quantities.mock.calls.length;
    expect(await owner.readInventory(4)).toEqual({ productId: 4, quantities: [], issue: null });
    expect(quantities).toHaveBeenCalledTimes(beforeArchivedRead);
    fail = true;
    expect(await owner.readInventory(1)).toMatchObject({ quantities: [{ variantId: 100, quantity: null }],
      issue: { code: "EBAY_FEED_QUANTITY_UNAVAILABLE", reference: "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775" } });
    expect(reportFailure).toHaveBeenLastCalledWith(expect.objectContaining({ productId: 1, error: expect.objectContaining({ code: "22012" }) }));
    await expect(owner.read()).resolves.toMatchObject({ syncIncludedCount: 5 });
  });
});
