import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { ChannelListingCatalogRepository } from "../../../channels/channel-listing-catalog.repository";
import { createHash } from "node:crypto";
import { createCatalogPublicImageUrl } from "../../../catalog/catalog-public-image";
import { readPublicCatalogImage } from "../../../catalog/catalog-publication-images.reader";
import { MAX_PRODUCT_IMAGE_BYTES } from "../../../catalog/product-image-download.service";

vi.mock("../../../../db", () => ({ db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced owner fixtures preserve the real named schemas, nullable asset URL,
// integer listing flags, bigint cents and decimal pricing contracts. These prove
// SQL projection behavior, not unrelated catalog migration completeness.
const ddl = `CREATE SCHEMA catalog; CREATE SCHEMA channels;
CREATE TABLE catalog.products(id integer PRIMARY KEY,name text,title text,description text,brand text,base_unit varchar(20),product_type text,is_active boolean,status text);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer,sku text,name text,uom_type varchar(20),units_per_variant integer,gtin text,barcode text,
 is_active boolean,requires_shipping boolean,track_inventory boolean,sales_eligibility text,position integer,price_cents bigint,shopify_variant_id varchar(100));
CREATE TABLE catalog.product_assets(id integer PRIMARY KEY,product_id integer,product_variant_id integer,asset_type varchar(20),url text,position integer,
 storage_type varchar(20) NOT NULL DEFAULT 'url',mime_type text,file_data bytea);
CREATE TABLE channels.channel_product_overrides(channel_id integer,product_id integer,title_override text,description_override text,is_listed integer,PRIMARY KEY(channel_id,product_id));
CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,sku_override text,name_override text,barcode_override text,is_listed integer,PRIMARY KEY(channel_id,product_variant_id));
CREATE TABLE channels.channel_asset_overrides(channel_id integer,product_asset_id integer,url_override text,position_override integer,is_included integer,PRIMARY KEY(channel_id,product_asset_id));
CREATE TABLE channels.channel_listings(channel_id integer,product_variant_id integer);
CREATE TABLE channels.channel_pricing(id integer PRIMARY KEY,channel_id integer,product_variant_id integer,price bigint,currency varchar(3) NOT NULL DEFAULT 'USD');
CREATE TABLE channels.channel_pricing_rules(id integer PRIMARY KEY,channel_id integer,scope varchar(20),scope_id varchar(100),rule_type varchar(20),value numeric(10,2),created_at timestamp,updated_at timestamp);
CREATE TABLE public.shopify_variants(id varchar(100) PRIMARY KEY,sku text,price numeric(10,2));`;

(url && disposable ? describe : describe.skip).sequential(
  "Channel listing catalog PostgreSQL projection",
  () => {
    let database: InventoryCutoverTestDatabase;
    let repository: ChannelListingCatalogRepository;
    beforeAll(async () => {
      database = await createInventoryCutoverTestDatabase(url, disposable, ddl);
      repository = new ChannelListingCatalogRepository(database.pool, createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" }));
    });
    afterAll(async () => {
      await database?.close();
    });
    beforeEach(async () => {
      await database.pool
        .query(`TRUNCATE catalog.products,catalog.product_variants,catalog.product_assets,channels.channel_product_overrides,channels.channel_variant_overrides,
      channels.channel_asset_overrides,channels.channel_listings,channels.channel_pricing,channels.channel_pricing_rules,public.shopify_variants;
      INSERT INTO catalog.products VALUES (20,'Sleeves','Catalog title','Catalog description','Card Shellz','piece','Sleeves',true,'active');
      INSERT INTO catalog.product_variants VALUES (10,20,'SKU-10','100 sleeves','pack',100,'00036000291452','036000291452',true,true,true,'sellable',0,999,NULL);
      INSERT INTO catalog.product_assets(id,product_id,product_variant_id,asset_type,url,position) VALUES (1,20,NULL,'image',NULL,0),(2,20,NULL,'image','https://example.com/base.jpg',1),
        (3,20,11,'image','https://example.com/other-variant.jpg',2),(4,20,10,'image','https://example.com/excluded.jpg',3),(5,20,NULL,'video','https://example.com/video.mp4',4);
      INSERT INTO channels.channel_asset_overrides VALUES (104,4,NULL,NULL,0);`);
    });
    it("filters missing and excluded image URLs and resolves channel content and barcode overrides", async () => {
      await database.pool
        .query(`INSERT INTO channels.channel_product_overrides VALUES (104,20,'Walmart title','Walmart description',1);
      INSERT INTO channels.channel_variant_overrides VALUES (104,10,'WM-SKU-10','Retail pack','4006381333931',1);
      INSERT INTO channels.channel_asset_overrides VALUES (104,1,'https://example.com/override.jpg',2,1);
      INSERT INTO channels.channel_pricing_rules VALUES (1,104,'channel',NULL,'fixed',3.00,'2026-09-27','2026-09-27');`);
      const page = await repository.catalog(104, {});
      expect(page.total).toBe(1);
      expect(page.items[0]).toMatchObject({
        sku: "WM-SKU-10",
        title: "Walmart title",
        description: "Walmart description",
        variantName: "Retail pack",
        unitLabel: "1 pack = 100 pieces",
        identifier: { type: "EAN", value: "4006381333931" },
        images: [
          "https://example.com/base.jpg",
          "https://example.com/override.jpg",
        ],
        basePriceCents: 999,
        priceCents: 1299,
        appliedRuleScope: "channel",
        eligible: true,
      });
      const hash = page.items[0].sourceHash;
      await database.pool.query(
        "UPDATE channels.channel_variant_overrides SET barcode_override='' WHERE channel_id=104",
      );
      const changed = (await repository.catalog(104, {})).items[0];
      expect(changed.identifier).toEqual({
        type: "GTIN",
        value: "00036000291452",
      });
      expect(changed.sourceHash).not.toBe(hash);
    });
    it.each(["product", "variant"])(
      "respects the %s channel not-listed override",
      async (level) => {
        await database.pool.query(
          level === "product"
            ? "INSERT INTO channels.channel_product_overrides VALUES (104,20,NULL,NULL,0)"
            : "INSERT INTO channels.channel_variant_overrides VALUES (104,10,NULL,NULL,NULL,0)",
        );
        const item = (await repository.catalog(104, { variantIds: "10" }))
          .items[0];
        expect(item.eligible).toBe(false);
        expect(item.images).toEqual(["https://example.com/base.jpg"]);
      },
    );
    it("revalidates selected inactive variants while hiding them from the browser catalog", async () => {
      const before = (await repository.catalog(104, {})).items[0];
      await database.pool.query(
        "UPDATE catalog.product_variants SET is_active=false WHERE id=10",
      );
      expect((await repository.catalog(104, {})).items).toEqual([]);
      const selected = (await repository.catalog(104, { variantIds: "10" }))
        .items[0];
      expect(selected.eligible).toBe(false);
      expect(selected.sourceHash).not.toBe(before.sourceHash);
    });
    it("uses variant rules over channel defaults and explicit channel cents over all markup", async () => {
      await database.pool
        .query(`INSERT INTO channels.channel_pricing_rules VALUES
      (1,104,'channel',NULL,'percentage',20,'2026-09-27','2026-09-27'),(2,104,'variant','10','fixed',2.50,'2026-09-27','2026-09-27');
      INSERT INTO public.shopify_variants VALUES ('cached-10','SKU-10',12.99);`);
      expect((await repository.catalog(104, {})).items[0]).toMatchObject({
        basePriceCents: 1299,
        priceCents: 1549,
        priceSource: "retail_cache",
        appliedRuleScope: "variant",
      });
      await database.pool.query(
        "INSERT INTO channels.channel_pricing(id,channel_id,product_variant_id,price) VALUES (1,104,10,1799)",
      );
      expect((await repository.catalog(104, {})).items[0]).toMatchObject({
        priceCents: 1799,
        basePriceCents: 1799,
        priceSource: "channel_pricing",
        appliedRule: null,
        appliedRuleScope: null,
      });
    });
    it("rejects a non-USD channel price instead of interpreting its cents as dollars", async () => {
      await database.pool.query(
        "INSERT INTO channels.channel_pricing VALUES (1,104,10,1799,'CAD')",
      );
      await expect(repository.catalog(104, {})).rejects.toMatchObject({
        code: "LISTING_CURRENCY_UNSUPPORTED",
      });
    });

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4ioAAAAASUVORK5CYII=", "base64");
    const fingerprint = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    async function upload(data = png, mime = "image/png", variantId: number | null = null): Promise<void> {
      await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,product_variant_id,asset_type,position,storage_type,mime_type,file_data)
        VALUES (8,20,$1,'image',8,'file',$2,$3)`, [variantId, mime, data]);
    }
    it("adds the uploaded fourth photo to inherited images and invalidates the review source after reorder, replacement and deletion", async () => {
      await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,asset_type,url,position) VALUES
        (6,20,'image','https://example.com/second.jpg',6),(7,20,'image','https://example.com/third.jpg',7)`);
      const before = (await repository.catalog(104, { variantIds: "10" })).items[0];
      expect(before.images).toHaveLength(3);
      await upload();
      const added = (await repository.catalog(104, { variantIds: "10" })).items[0];
      const publicUrl = `https://catalog.example.com/api/catalog/images/8/${fingerprint(png)}`;
      expect(added.images).toEqual([...before.images, publicUrl]);
      expect(added.sourceHash).not.toBe(before.sourceHash);
      expect((await repository.catalog(104, {})).items[0].sourceHash).toBe(added.sourceHash);
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(png))).toEqual({ data: png, mimeType: "image/png" });
      expect(await readPublicCatalogImage(database.pool, 8, "f".repeat(64))).toBeNull();
      expect(await readPublicCatalogImage(database.pool, 999, fingerprint(png))).toBeNull();
      // A predictable ID cannot read an external-only image, even with another file's hash.
      expect(await readPublicCatalogImage(database.pool, 2, fingerprint(png))).toBeNull();

      await database.pool.query("UPDATE catalog.product_assets SET position=-1 WHERE id=8");
      const reordered = (await repository.catalog(104, {})).items[0];
      expect(reordered.images).toEqual([publicUrl, ...before.images]);
      expect(reordered.sourceHash).not.toBe(added.sourceHash);

      const replacement = Buffer.from("GIF89a0102030405");
      await database.pool.query("UPDATE catalog.product_assets SET file_data=$1,mime_type='image/gif' WHERE id=8", [replacement]);
      const replaced = (await repository.catalog(104, {})).items[0];
      expect(replaced.images[0]).toContain(fingerprint(replacement));
      expect(replaced.sourceHash).not.toBe(reordered.sourceHash);
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(png))).toBeNull();
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(replacement))).toEqual({ data: replacement, mimeType: "image/gif" });

      await database.pool.query("DELETE FROM catalog.product_assets WHERE id=8");
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(replacement))).toBeNull();
      expect((await repository.catalog(104, {})).items[0].images).toEqual(before.images);
    });
    it("retains exact variant scope, channel exclusions, URL overrides and override order for uploaded photos", async () => {
      await upload(png, "image/png", 11);
      expect((await repository.catalog(104, {})).items[0].images).toEqual(["https://example.com/base.jpg"]);
      await database.pool.query("UPDATE catalog.product_assets SET product_variant_id=10 WHERE id=8");
      expect((await repository.catalog(104, {})).items[0].images).toHaveLength(2);
      await database.pool.query("INSERT INTO channels.channel_asset_overrides VALUES (104,8,NULL,-1,0)");
      const noPublicOrigin = new ChannelListingCatalogRepository(database.pool, createCatalogPublicImageUrl({}));
      expect((await noPublicOrigin.catalog(104, {})).items[0].images).toEqual(["https://example.com/base.jpg"]);
      await database.pool.query("UPDATE channels.channel_asset_overrides SET is_included=1,url_override='https://example.com/custom.jpg' WHERE product_asset_id=8");
      expect((await noPublicOrigin.catalog(104, {})).items[0].images).toEqual(["https://example.com/custom.jpg", "https://example.com/base.jpg"]);
      await database.pool.query("UPDATE channels.channel_asset_overrides SET url_override=NULL WHERE product_asset_id=8");
      await expect(noPublicOrigin.catalog(104, {})).rejects.toMatchObject({ code: "CATALOG_PUBLIC_URL_REQUIRED", status: 503 });
      // The rejected read rolled back and released its connection; a configured read still works.
      expect((await repository.catalog(104, {})).items[0].images[0]).toContain(`/8/${fingerprint(png)}`);
    });
    it.each([
      ["mislabeled document", Buffer.from("<html>not a photo</html>"), "image/png"],
      ["SVG document", Buffer.from("<svg/>"), "image/svg+xml"],
      ["empty file", Buffer.alloc(0), "image/png"],
      ["oversized file", Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES + 1), "image/png"],
    ])("does not serve or publish a %s", async (_name, data, mime) => {
      await upload(data, mime);
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(data))).toBeNull();
      await expect(repository.catalog(104, {})).rejects.toMatchObject({ status: 422 });
    });
    it("never serves a non-image asset or a URL-only record's retained blob", async () => {
      await upload();
      await database.pool.query("UPDATE catalog.product_assets SET asset_type='document' WHERE id=8");
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(png))).toBeNull();
      await database.pool.query("UPDATE catalog.product_assets SET asset_type='image',storage_type='url' WHERE id=8");
      expect(await readPublicCatalogImage(database.pool, 8, fingerprint(png))).toBeNull();
    });
  },
);
