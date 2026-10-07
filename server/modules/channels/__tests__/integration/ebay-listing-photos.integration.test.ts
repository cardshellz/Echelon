import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";
import { PgCatalogVariantPublicationPhotoReader, readPublicCatalogImage } from "../../../catalog/catalog-publication-images.reader";
import { ChannelEbayListingPhotoResolver } from "../../ebay-listing-photos.service";
import { buildEbayListingPhotoPlan } from "../../ebay-listing-photos.domain";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced owner fixture: actual SQL, read-only transactions and concurrent commits; no production migrations.
const fixture = `
  CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA inventory;
  CREATE TABLE catalog.products (id integer PRIMARY KEY);
  CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products, sku text NOT NULL UNIQUE);
  CREATE TABLE catalog.product_assets (
    id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products, product_variant_id integer REFERENCES catalog.product_variants,
    asset_type text NOT NULL DEFAULT 'image', url text, position integer NOT NULL DEFAULT 0,
    is_primary integer NOT NULL DEFAULT 0, mime_type text, storage_type text NOT NULL DEFAULT 'url', file_data bytea
  );
  CREATE TABLE channels.channel_asset_overrides (
    channel_id integer NOT NULL, product_asset_id integer NOT NULL REFERENCES catalog.product_assets,
    is_included integer NOT NULL DEFAULT 1, url_override text, position_override integer,
    PRIMARY KEY (channel_id, product_asset_id)
  );
  CREATE TABLE channels.channel_variant_overrides (
    channel_id integer NOT NULL, product_variant_id integer NOT NULL REFERENCES catalog.product_variants,
    sku_override text, PRIMARY KEY (channel_id, product_variant_id)
  );
  CREATE TABLE inventory.inventory_levels (variant_id integer PRIMARY KEY, quantity integer NOT NULL);
  INSERT INTO catalog.products VALUES (1), (2);
  INSERT INTO catalog.product_variants VALUES (10,1,'PACK'), (11,1,'CASE'), (20,2,'OTHER');
  INSERT INTO inventory.inventory_levels VALUES (10,31), (11,9);
`;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const jpeg = Buffer.from("ffd8ffe000104a4649460001", "hex");
const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const imageUrl = (id: number, data = png, extension = "png") => `https://catalog.example.com/api/catalog/images/${id}/${hash(data)}.${extension}`;
const publicUrl = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" });
const variants = [{ variantId: 10, sku: "PACK" }, { variantId: 11, sku: "CASE" }];
const request = { productId: 1, channelId: 67, variants };

(url && disposable ? describe : describe.skip)("one eBay photo owner (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  let resolver: ChannelEbayListingPhotoResolver;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, fixture); });
  afterAll(async () => { await database?.close(); });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    resolver = new ChannelEbayListingPhotoResolver(database.pool, publicUrl);
    await database.pool.query("TRUNCATE channels.channel_variant_overrides, channels.channel_asset_overrides, catalog.product_assets");
    await database.pool.query(`INSERT INTO catalog.product_assets
      (id,product_id,product_variant_id,url,position,is_primary,storage_type,mime_type,file_data) VALUES
      (1,1,NULL,'https://cdn.example.com/common.jpg',2,0,'url',NULL,NULL),
      (2,1,NULL,NULL,9,1,'file','image/png',$1),
      (3,1,10,'https://cdn.example.com/pack.jpg',1,0,'url',NULL,NULL),
      (4,1,11,NULL,1,0,'file','image/jpeg',$2),
      (5,2,NULL,'https://cdn.example.com/foreign.jpg',0,1,'url',NULL,NULL)`, [png, jpeg]);
  });

  it("resolves URL and uploaded photos with exact size identity, primary order and public readback", async () => {
    const plan = await resolver.resolve(request);
    expect(plan.byVariantId.get(10)).toEqual([imageUrl(2), "https://cdn.example.com/pack.jpg", "https://cdn.example.com/common.jpg"]);
    expect(plan.byVariantId.get(11)).toEqual([imageUrl(2), imageUrl(4,jpeg,"jpg"), "https://cdn.example.com/common.jpg"]);
    expect(plan.groupImageUrls).toEqual([imageUrl(2), "https://cdn.example.com/pack.jpg", imageUrl(4,jpeg,"jpg"), "https://cdn.example.com/common.jpg"]);
    await expect(readPublicCatalogImage(database.pool,2,hash(png))).resolves.toEqual({ data: png, mimeType: "image/png" });
    await expect(resolver.resolve({ ...request, variants: [{ variantId:20,sku:"OTHER" }] })).rejects.toMatchObject({ code: "EBAY_PHOTO_SCOPE_INVALID" });
    await expect(resolver.resolve({ ...request, variants: [{ variantId:10,sku:"CASE" }] })).rejects.toMatchObject({ code: "EBAY_PHOTO_SCOPE_INVALID" });
  });
  it("uses Catalog global order for the group even when the first requested SKU cannot see the earliest primary photo", async () => {
    await database.pool.query("UPDATE catalog.product_assets SET is_primary=1,position=0 WHERE id=4");
    const plan = await resolver.resolve(request);
    expect(plan.byVariantId.get(10)).toEqual([imageUrl(2),"https://cdn.example.com/pack.jpg","https://cdn.example.com/common.jpg"]);
    expect(plan.byVariantId.get(11)).toEqual([imageUrl(4,jpeg,"jpg"),imageUrl(2),"https://cdn.example.com/common.jpg"]);
    expect(plan.groupImageUrls).toEqual([imageUrl(4,jpeg,"jpg"),imageUrl(2),"https://cdn.example.com/pack.jpg","https://cdn.example.com/common.jpg"]);
  });
  it("uses the same Catalog selection for Dropship and direct eBay; overlays apply only to their exact channel", async () => {
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl);
    const photos = await reader.listPublicationPhotos({ productVariantIds:[10,11], maxPhotosPerVariant:12 });
    const images = variants.flatMap(variant => photos.get(variant.variantId)!.photos.map((photo,position) => ({ url:photo.url,position:photo.position,variantSku:variant.sku,altText:null })));
    expect(await resolver.resolve(request)).toEqual(buildEbayListingPhotoPlan(images,variants));
    await database.pool.query(`INSERT INTO channels.channel_asset_overrides VALUES
      (67,2,0,NULL,NULL), (67,3,1,'https://cdn.example.com/channel-pack.jpg',0), (67,1,1,NULL,7),
      (99,1,0,NULL,NULL), (67,5,1,'https://cdn.example.com/wrong-product.jpg',0)`);
    const selected = await resolver.resolve(request);
    expect(selected.byVariantId.get(10)).toEqual(["https://cdn.example.com/channel-pack.jpg","https://cdn.example.com/common.jpg"]);
    expect(selected.byVariantId.get(11)).toEqual([imageUrl(4,jpeg,"jpg"),"https://cdn.example.com/common.jpg"]);
    expect((await resolver.resolve({ ...request,channelId:99 })).byVariantId.get(10)).toEqual([imageUrl(2),"https://cdn.example.com/pack.jpg"]);
    expect(selected.groupImageUrls).not.toContain("https://cdn.example.com/wrong-product.jpg");
  });
  it("honors an explicit channel SKU alias without confusing it with another channel or size", async () => {
    await database.pool.query("INSERT INTO channels.channel_variant_overrides VALUES (67,10,'EBAY-PACK'),(99,11,'OTHER-CASE')");
    const selected = await resolver.resolve({ ...request,variants:[{ variantId:10,sku:"EBAY-PACK" }] });
    expect(selected.byVariantId.get(10)).toEqual([imageUrl(2),"https://cdn.example.com/pack.jpg","https://cdn.example.com/common.jpg"]);
    await expect(resolver.resolve({ ...request,variants:[{ variantId:11,sku:"OTHER-CASE" }] })).rejects.toMatchObject({ code:"EBAY_PHOTO_SCOPE_INVALID" });
  });
  it("applies exclusions before limiting and hashing; unusable excluded and over-limit files cannot block a push", async () => {
    await database.pool.query(`UPDATE catalog.product_assets SET file_data=NULL WHERE id=2;
      INSERT INTO channels.channel_asset_overrides VALUES (67,2,0,NULL,NULL);
      INSERT INTO catalog.product_assets (id,product_id,url,position)
      SELECT 10+i,1,'https://cdn.example.com/extra-' || i || '.jpg',10+i FROM generate_series(1,15) i;
      INSERT INTO catalog.product_assets (id,product_id,storage_type,mime_type,position,file_data) VALUES (99,1,'file','image/png',999,NULL)`);
    const plan = await resolver.resolve(request);
    expect(plan.byVariantId.get(10)).toHaveLength(12);
    expect(plan.groupImageUrls).toHaveLength(12);
    expect(plan.groupImageUrls.every(photo => !photo.includes('/images/2/'))).toBe(true);
  });
  it("rolls back a failed read, preserves quantities/catalog rows and replays after the selected file is repaired", async () => {
    await database.pool.query("UPDATE catalog.product_assets SET file_data=NULL WHERE id=2");
    const before = (await database.pool.query("SELECT * FROM catalog.product_assets ORDER BY id")).rows;
    const readExistingPhotos = vi.fn();
    await expect(resolver.resolve({ ...request,readExistingPhotos })).rejects.toMatchObject({ code:"EBAY_CATALOG_PHOTO_UNAVAILABLE" });
    expect(readExistingPhotos).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT * FROM catalog.product_assets ORDER BY id")).rows).toEqual(before);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY variant_id")).rows).toEqual([{ variant_id:10,quantity:31 },{ variant_id:11,quantity:9 }]);
    await database.pool.query("UPDATE catalog.product_assets SET file_data=$1 WHERE id=2",[png]);
    const [first, replay, simultaneous] = await Promise.all([resolver.resolve(request),resolver.resolve(request),resolver.resolve(request)]);
    expect(replay).toEqual(first); expect(simultaneous).toEqual(first);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'")).rows[0].count).toBe(0);
  });
  it("keeps overlays, ordering and fingerprints on one committed snapshot during a concurrent catalog edit", async () => {
    let concurrentEdit = false;
    const databaseWithConcurrentEdit = { connect: async () => {
      const client = await database.pool.connect();
      return { release: (destroy?: boolean) => client.release(destroy), query: async (sql: string, params?: unknown[]) => {
        const result = await client.query(sql,params);
        if (!concurrentEdit && sql.includes("FROM catalog.products WHERE id")) {
          concurrentEdit = true;
          // A different connection commits after the scope read fixed this transaction's snapshot.
          const writer = await database.pool.connect();
          try {
            await writer.query("BEGIN");
            await writer.query("UPDATE catalog.product_assets SET file_data=$1, mime_type='image/jpeg' WHERE id=2",[jpeg]);
            await writer.query("INSERT INTO channels.channel_asset_overrides VALUES (67,3,0,NULL,NULL)");
            await writer.query("COMMIT");
          } catch (error) { await writer.query("ROLLBACK"); throw error; }
          finally { writer.release(); }
        }
        return result;
      } } as unknown as PoolClient;
    } };
    const inFlight = await new ChannelEbayListingPhotoResolver(databaseWithConcurrentEdit as Pool,publicUrl).resolve(request);
    expect(inFlight.byVariantId.get(10)).toEqual([imageUrl(2),"https://cdn.example.com/pack.jpg","https://cdn.example.com/common.jpg"]);
    const next = await resolver.resolve(request);
    expect(next.byVariantId.get(10)).toEqual([imageUrl(2,jpeg,"jpg"),"https://cdn.example.com/common.jpg"]);
    // A stale URL must never serve the replacement's different bytes.
    await expect(readPublicCatalogImage(database.pool,2,hash(png))).resolves.toBeNull();
  });
  it("resolves concurrent requests with one available connection and releases it before provider fallback", async () => {
    const oneSlot = new Pool({ connectionString:database.connectionString,max:1,connectionTimeoutMillis:2000 });
    try {
      const bounded = new ChannelEbayListingPhotoResolver(oneSlot,publicUrl);
      const plans = await Promise.all([bounded.resolve(request),bounded.resolve(request),bounded.resolve(request)]);
      expect(plans[1]).toEqual(plans[0]);expect(plans[2]).toEqual(plans[0]);
      expect(oneSlot.waitingCount).toBe(0);
      await database.pool.query("TRUNCATE channels.channel_asset_overrides, catalog.product_assets");
      const plan = await bounded.resolve({ ...request,readExistingPhotos:async () => {
        // This query can finish only if the resolver returned the sole connection before the callback.
        await oneSlot.query("SELECT 1");
        return { byVariantId:new Map([[10,[]],[11,[]]]),groupImageUrls:["https://i.ebayimg.com/existing.jpg"] };
      } });
      expect(plan.groupImageUrls).toEqual(["https://i.ebayimg.com/existing.jpg"]);
    } finally { await oneSlot.end(); }
  });
  it("never revives a deliberately excluded gallery or another size's only photos", async () => {
    await database.pool.query("INSERT INTO channels.channel_asset_overrides SELECT 67,id,0,NULL,NULL FROM catalog.product_assets WHERE product_id=1");
    const readExistingPhotos = vi.fn();
    await expect(resolver.resolve({ ...request,readExistingPhotos })).rejects.toMatchObject({ code:"EBAY_CATALOG_PHOTO_REQUIRED" });
    expect(readExistingPhotos).not.toHaveBeenCalled();
    await database.pool.query("TRUNCATE channels.channel_asset_overrides");
    await database.pool.query("DELETE FROM catalog.product_assets WHERE product_id=1 AND product_variant_id IS DISTINCT FROM 11");
    await expect(resolver.resolve({ ...request,variants:[variants[0]],readExistingPhotos })).rejects.toMatchObject({ code:"EBAY_CATALOG_PHOTO_REQUIRED" });
    expect(readExistingPhotos).not.toHaveBeenCalled();
  });
});
