import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { createCatalogImageOriginalsService, type CatalogOriginalReplacement } from "../../catalog-image-originals.service";
import { createCatalogImageInspector } from "../../catalog-image-inspection";
import { createSharedProductPhotoImporter } from "../../shared-product-photos.service";
import { PgCatalogVariantPublicationPhotoReader, readPublicCatalogImage, readCatalogPublicationImages, resolveCatalogPublicationPhotos } from "../../catalog-publication-images.reader";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
import { ChannelEbayListingPhotoResolver } from "../../../channels/ebay-listing-photos.service";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

vi.mock("../../../../db", () => ({ db: {} }));
const configured = Boolean(process.env.ECHELON_TEST_DATABASE_URL) && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const png = (name: string) => readFileSync(new URL(`../fixtures/photos/${name}.png`, import.meta.url));
const original = png("original"), thumbnail = png("thumbnail"), minimum = png("minimum");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const now = new Date("2026-11-01T12:00:00Z");
const publicUrl = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" });
// Reduced Catalog schema; uses the real ownership constraint and immutable
// image-version migration, including its PK, FK, hash and retention triggers.
const fixture = `CREATE SCHEMA catalog; CREATE SCHEMA channels;
CREATE TABLE catalog.products(id integer PRIMARY KEY);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products,sku text NOT NULL,UNIQUE(id,product_id));
CREATE TABLE catalog.product_assets(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products,
 product_variant_id integer,asset_type text NOT NULL DEFAULT 'image',url text,alt_text text,position integer NOT NULL DEFAULT 0,is_primary integer NOT NULL DEFAULT 0,
 width integer,height integer,file_size integer,mime_type text,storage_type text NOT NULL DEFAULT 'url',file_data bytea,
 created_at timestamp NOT NULL DEFAULT now(),updated_at timestamp NOT NULL DEFAULT now());
CREATE TABLE channels.channel_asset_overrides(channel_id integer NOT NULL,product_asset_id integer NOT NULL REFERENCES catalog.product_assets,
 is_included integer NOT NULL DEFAULT 1,url_override text,position_override integer,PRIMARY KEY(channel_id,product_asset_id));
CREATE TABLE channels.channel_variant_overrides(channel_id integer,product_variant_id integer,sku_override text);
CREATE TABLE public.audit_events(id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL,level text NOT NULL DEFAULT 'AUDIT',actor text NOT NULL,
 action text NOT NULL,target text,changes jsonb,context jsonb);
INSERT INTO catalog.products VALUES(1),(2);
INSERT INTO catalog.product_variants VALUES(10,1,'PACK'),(11,1,'CASE'),(20,2,'OTHER');`;

(configured ? describe : describe.skip).sequential("Catalog originals, publication and recovery (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ReturnType<typeof createCatalogImageOriginalsService>;
  let command: CatalogOriginalReplacement;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, fixture);
    for (const migration of ["0727_product_asset_variant_ownership.sql", "900000017000018580001_catalog_publication_media_versions.sql"])
      await database.pool.query(readFileSync(`migrations/${migration}`, "utf8"));
    service = createCatalogImageOriginalsService(drizzle(database.pool, { schema }), () => now);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE channels.channel_asset_overrides,catalog.product_assets RESTART IDENTITY CASCADE; TRUNCATE public.audit_events");
    await database.pool.query(`INSERT INTO catalog.product_assets(product_id,url,is_primary) VALUES(1,'https://cdn.example.com/thumbnail.png',1);
      INSERT INTO channels.channel_asset_overrides(channel_id,product_asset_id,position_override) VALUES(67,1,3)`);
    command = { productId: 1, assetId: 1, expected: { url: "https://cdn.example.com/thumbnail.png", productVariantId: null, position: 0, isPrimary: 1, storedHash: null,
      storageType:"url",mimeType:null,width:null,height:null,fileSize:null },
      source: {kind:"external_url",url:"https://originals.example.com/photo.png"}, expectedOriginalHash: hash(original), actor: "operator:photo-recovery",
      reason: "Restore the reviewed original after thumbnail publication", evidenceReference: "photo-review/1" };
  });
  const replace = (input = command, bytes = original) => service.replace(input, { data: bytes, mimeType: "image/png" });
  const assets = async () => (await database.pool.query("SELECT id,url,product_variant_id,position,is_primary,width,height,storage_type,file_data,encode(sha256(file_data),'hex') AS hash FROM catalog.product_assets ORDER BY id")).rows;

  it("restores one original without changing identity, assignment, order, import URL or channel overlays, and replays without another audit", async () => {
    expect(await service.preview(command,{data:original,mimeType:"image/png"})).toEqual({wouldApply:true,contentHash:hash(original)});
    expect((await assets())[0].hash).toBeNull();
    expect((await database.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([]);
    expect(await replace()).toEqual({ applied: true, contentHash: hash(original) });
    expect(await service.preview(command,{data:original,mimeType:"image/png"})).toEqual({wouldApply:false,contentHash:hash(original)});
    expect(await replace()).toEqual({ applied: false, contentHash: hash(original) });
    expect((await assets())[0]).toMatchObject({ id: 1, url: command.expected.url, product_variant_id: null, position: 0, is_primary: 1,
      width: 640, height: 640, storage_type: "both", hash: hash(original) });
    expect((await database.pool.query("SELECT * FROM channels.channel_asset_overrides")).rows).toEqual([
      { channel_id: 67, product_asset_id: 1, is_included: 1, url_override: null, position_override: 3 },
    ]);
    expect((await database.pool.query("SELECT action,context FROM public.audit_events")).rows).toEqual([
      { action: "catalog.image_original.replaced", context: expect.objectContaining({ productId: 1, evidenceReference: "photo-review/1" }) },
    ]);
    const plan = await new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl).listPublicationPlan({ productId: 1, productVariantIds: [10,11], maxPhotosPerVariant: 12 });
    expect(plan.group.selected[0]).toMatchObject({ assetId: 1, uploaded: true, versionHash: hash(original), url: publicUrl(1,hash(original),"image/png") });
  });
  it("checks actual bytes before replacing a live gallery and succeeds after the reviewed original is restored", async () => {
    const inspector = createCatalogImageInspector(async url => {
      if (url === command.expected.url) return { data: thumbnail, mimeType: "image/png" };
      const parsed = new URL(url), parts = parsed.pathname.split("/");
      const result = await readPublicCatalogImage(database.pool, Number(parts[4]), parts[5].split(".")[0]);
      if (!result) throw new Error("Immutable original is missing");
      return result;
    });
    const resolver = new ChannelEbayListingPhotoResolver(database.pool, publicUrl, inspector);
    const request = { productId: 1, channelId: 67, variants: [{ variantId: 10, sku: "PACK" }, { variantId: 11, sku: "CASE" }] };
    await expect(resolver.resolve(request)).rejects.toMatchObject({ code: "EBAY_PHOTO_RESOLUTION_TOO_SMALL", message: expect.stringContaining("400 × 400") });
    expect((await assets())[0].hash).toBeNull();
    await replace();
    const plan = await resolver.resolve(request);
    expect(plan.groupImageUrls).toEqual([publicUrl(1,hash(original),"image/png")]);
    expect(plan.byVariantId.get(10)).toEqual(plan.byVariantId.get(11));
  });
  it("serializes simultaneous identical recoveries and rejects a competing different original", async () => {
    const outcomes = await Promise.all([replace(),replace()]);
    expect(outcomes.map(row=>row.applied).sort()).toEqual([false,true]);
    await expect(replace({ ...command, expectedOriginalHash: hash(minimum) }, minimum)).rejects.toMatchObject({ code: "CATALOG_ORIGINAL_SOURCE_CHANGED" });
    expect((await assets())[0].hash).toBe(hash(original));
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.audit_events")).rows[0].count).toBe(1);
  });
  it.each(["url", "assignment", "order"])("refuses a stale %s snapshot without overwriting the concurrent edit", async field => {
    const mutations = { url: "UPDATE catalog.product_assets SET url='https://cdn.example.com/reviewed.png' WHERE id=1",
      assignment: "UPDATE catalog.product_assets SET product_variant_id=10 WHERE id=1", order: "UPDATE catalog.product_assets SET position=4 WHERE id=1" };
    await database.pool.query(mutations[field as keyof typeof mutations]);
    const before = await assets();
    await expect(replace()).rejects.toMatchObject({ code: "CATALOG_ORIGINAL_SOURCE_CHANGED" });
    expect(await assets()).toEqual(before);
  });
  it("rejects incorrect bytes and cross-product scope before a content update", async () => {
    await expect(replace(command, minimum)).rejects.toMatchObject({ code: "CATALOG_ORIGINAL_CHANGED" });
    await expect(replace({ ...command, productId: 2 })).rejects.toMatchObject({ code: "CATALOG_ORIGINAL_SOURCE_CHANGED" });
    expect((await assets())[0].hash).toBeNull();
  });
  it("does not overwrite changed image metadata and proves a referenced Catalog source exists", async () => {
    await database.pool.query("UPDATE catalog.product_assets SET width=321 WHERE id=1");
    await expect(replace()).rejects.toMatchObject({code:"CATALOG_ORIGINAL_SOURCE_CHANGED"});
    await database.pool.query("UPDATE catalog.product_assets SET width=NULL WHERE id=1");
    const source = {...command,source:{kind:"catalog_asset" as const,assetId:300,contentHash:hash(original)}};
    await expect(replace(source)).rejects.toMatchObject({code:"CATALOG_ORIGINAL_SOURCE_MISSING"});
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,storage_type,mime_type,file_data)
      OVERRIDING SYSTEM VALUE VALUES(300,1,'file','image/png',$1)`,[original]);
    expect(await replace(source)).toMatchObject({applied:true});
    expect((await database.pool.query("SELECT context->'source' AS source FROM public.audit_events")).rows[0].source)
      .toEqual({kind:"catalog_asset",assetId:300,contentHash:hash(original)});
  });
  it("rolls back the image, immutable version and audit together when audit persistence fails", async () => {
    await database.pool.query("INSERT INTO catalog.product_assets(product_id,url) VALUES(1,'https://cdn.example.com/rollback.png')");
    const rollback = { ...command, assetId: 2, expected: { ...command.expected, url: "https://cdn.example.com/rollback.png", isPrimary: 0 as const } };
    await database.pool.query(`CREATE FUNCTION public.fail_photo_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable';END $$;
      CREATE TRIGGER fail_photo_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_photo_audit()`);
    try {
      await expect(replace(rollback)).rejects.toThrow("audit unavailable");
      expect((await assets())[1].hash).toBeNull();
      expect((await database.pool.query("SELECT asset_id FROM catalog.product_asset_versions WHERE asset_id=2 AND content_hash=$1", [hash(original)])).rows).toEqual([]);
    } finally { await database.pool.query("DROP TRIGGER fail_photo_audit ON public.audit_events;DROP FUNCTION public.fail_photo_audit()"); }
    expect(await replace(rollback)).toMatchObject({ applied: true });
  });
  it("creates a measured original once across concurrent uploads and replay, preserving the requested assignment", async () => {
    const input = { productId: 1, productVariantId: 10, actor: "user:operator", altText: "Pack front" };
    const image = { data: original, mimeType: "image/png" };
    const [first, concurrent] = await Promise.all([service.create(input,image), service.create(input,image)]);
    expect(first.id).toBe(concurrent.id);
    expect((await service.create(input,image)).id).toBe(first.id);
    expect((await assets()).find(asset=>asset.id===first.id)).toMatchObject({ product_variant_id: 10, width: 640, height: 640,
      hash: hash(original), storage_type: "file", is_primary: 1 });
    expect((await database.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([{ action: "catalog.image_original.created" }]);
  });
  it("rejects an invalid assignment or corrupt upload before creating metadata, bytes or an audit", async () => {
    const input = { productId: 1, productVariantId: 20, actor: "user:operator" };
    await expect(service.create(input,{data:original,mimeType:"image/png"})).rejects.toMatchObject({ code: "ASSET_VARIANT_MISMATCH", status: 422 });
    await expect(service.create({...input,productVariantId:null},{data:Buffer.from("broken"),mimeType:"image/png"})).rejects.toBeInstanceOf(Error);
    expect(await assets()).toHaveLength(1);
    expect((await database.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([]);
  });
  it("repairs stale metadata for identical bytes while requiring a deliberate primary or caption change", async () => {
    const input = {productId:1,productVariantId:10,actor:"user:operator",altText:"Pack front"};
    const image = {data:original,mimeType:"image/png"};
    const created = await service.create(input,image);
    await database.pool.query("UPDATE catalog.product_assets SET width=1,file_size=1 WHERE id=$1",[created.id]);
    expect((await service.create(input,image)).id).toBe(created.id);
    expect((await assets()).find(asset=>asset.id===created.id)).toMatchObject({width:640,hash:hash(original)});
    await expect(service.create({...input,altText:"Different caption"},image)).rejects.toMatchObject({code:"CATALOG_IMAGE_ALREADY_EXISTS"});
    expect((await database.pool.query("SELECT action FROM public.audit_events ORDER BY id")).rows.map(row=>row.action))
      .toEqual(["catalog.image_original.created","catalog.image_original.metadata_corrected"]);
  });
  it("releases the Catalog snapshot before photo HTTP inspection even with a single available PostgreSQL connection", async () => {
    const { Pool } = await import("pg");
    const single = new Pool({ connectionString: database.connectionString, max: 1, connectionTimeoutMillis: 500 });
    const inspector = createCatalogImageInspector(async () => {
      expect(single.totalCount).toBe(1);
      expect(single.idleCount).toBe(1);
      expect((await single.query("SELECT 1 AS available")).rows[0].available).toBe(1);
      return { data: original, mimeType: "image/png" };
    });
    try {
      const resolver = new ChannelEbayListingPhotoResolver(single,publicUrl,inspector);
      expect((await resolver.resolve({ productId: 1, channelId: 67, variants: [{ variantId: 10, sku: "PACK" }] })).groupImageUrls)
        .toEqual([command.expected.url]);
    } finally { await single.end(); }
  });
  it("retains old published bytes under the real version PK and immutable trigger", async () => {
    await database.pool.query("UPDATE catalog.product_assets SET storage_type='both',mime_type='image/png',file_data=$1 WHERE id=1",[thumbnail]);
    await replace({ ...command, expected: { ...command.expected, storedHash: hash(thumbnail),storageType:"both",mimeType:"image/png" } });
    expect((await readPublicCatalogImage(database.pool,1,hash(thumbnail)))?.data).toEqual(thumbnail);
    expect((await readPublicCatalogImage(database.pool,1,hash(original)))?.data).toEqual(original);
    await expect(database.pool.query("UPDATE catalog.product_asset_versions SET file_data=$1 WHERE asset_id=1",[minimum]))
      .rejects.toMatchObject({ code: "23514", constraint: "publication_image_versions_immutable" });
  });
  it("resolves a product-level original for a product with no variants", async () => {
    await database.pool.query("INSERT INTO catalog.products VALUES(3)");
    await database.pool.query("INSERT INTO catalog.product_assets(product_id,url,storage_type,mime_type,file_data) VALUES(3,'https://cdn.example.com/old-thumb.png','both','image/png',$1)",[original]);
    const gallery = resolveCatalogPublicationPhotos(await readCatalogPublicationImages(database.pool,[3]),publicUrl);
    expect(gallery.issues).toEqual([]);
    expect(gallery.photos).toMatchObject([{uploaded:true,url:publicUrl(2,hash(original),"image/png")}]);
    await database.pool.query("DELETE FROM catalog.product_assets WHERE product_id=3");
    await database.pool.query("DELETE FROM catalog.products WHERE id=3");
  });
  it("keeps a recovered original when the old thumbnail import is replayed", async () => {
    await replace();
    const download = vi.fn(async () => ({ data: thumbnail, mimeType: "image/png" }));
    const importer = createSharedProductPhotoImporter(drizzle(database.pool,{schema}),()=>now,download);
    expect(await importer.append({ productId: 1, actor: "service:import", photos: [{ url: command.expected.url!, position: 0 }] })).toEqual({ created: 0 });
    expect(download).not.toHaveBeenCalled();
    expect((await assets())[0].hash).toBe(hash(original));
  });
});
