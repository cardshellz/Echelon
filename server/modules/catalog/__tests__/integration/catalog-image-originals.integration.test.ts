import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { createCatalogImageOriginalsService, type CatalogOriginalReplacement } from "../../catalog-image-originals.service";
import { createCatalogImageInspector } from "../../catalog-image-inspection";
import { createSharedProductPhotoImporter } from "../../shared-product-photos.service";
import { PgCatalogVariantPublicationPhotoReader, readPublicCatalogImage, readCatalogPublicationImages, resolveCatalogPublicationPhotos } from "../../catalog-publication-images.reader";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
import { pinCatalogPublicationMediaVersions } from "../../catalog-publication-media-versions";
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
const fixture = `CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA marketplace;
CREATE FUNCTION marketplace.capture_listing_intent_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
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
    for (const migration of ["0727_product_asset_variant_ownership.sql", "900000017000018580001_catalog_publication_media_versions.sql", "900000047000019770001_catalog_publication_renditions.sql"])
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
      expectedPriorHash: hash(thumbnail),
      reason: "Restore the reviewed original after thumbnail publication", evidenceReference: "photo-review/1" };
  });
  const replace = (input = command, bytes = original) => service.replace(input, { data: bytes, mimeType: "image/png" }, { data: thumbnail, mimeType: "image/png" });
  const assets = async () => (await database.pool.query("SELECT id,url,product_variant_id,position,is_primary,width,height,storage_type,file_data,encode(sha256(file_data),'hex') AS hash FROM catalog.product_assets ORDER BY id")).rows;

  it("restores one original without changing identity, assignment, order, import URL or channel overlays, and replays without another audit", async () => {
    expect(await service.preview(command,{data:original,mimeType:"image/png"},{data:thumbnail,mimeType:"image/png"})).toEqual({wouldApply:true,contentHash:hash(original)});
    expect((await assets())[0].hash).toBeNull();
    expect((await database.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([]);
    expect(await replace()).toEqual({ applied: true, contentHash: hash(original) });
    expect(await service.preview(command,{data:original,mimeType:"image/png"},{data:thumbnail,mimeType:"image/png"})).toEqual({wouldApply:false,contentHash:hash(original)});
    expect(await replace()).toEqual({ applied: false, contentHash: hash(original) });
    expect((await assets())[0]).toMatchObject({ id: 1, url: command.expected.url, product_variant_id: null, position: 0, is_primary: 1,
      width: 640, height: 640, storage_type: "both", hash: hash(original) });
    expect((await database.pool.query("SELECT * FROM channels.channel_asset_overrides")).rows).toEqual([
      { channel_id: 67, product_asset_id: 1, is_included: 1, url_override: null, position_override: 3 },
    ]);
    expect((await database.pool.query("SELECT action,context FROM public.audit_events")).rows).toEqual([
      { action: "catalog.image_original.replaced", context: expect.objectContaining({ productId: 1, evidenceReference: "photo-review/1" }) },
    ]);
    expect((await readPublicCatalogImage(database.pool, 1, hash(thumbnail)))?.data).toEqual(thumbnail);
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
  it("keeps the small original and publishes one immutable enlarged copy only to a channel requesting it", async () => {
    const small = { ...command, source: { kind: "external_url" as const, url: command.expected.url! },
      expectedOriginalHash: hash(thumbnail), expectedPriorHash: undefined };
    const results = await Promise.all([service.replace(small,{data:thumbnail,mimeType:"image/png"}), service.replace(small,{data:thumbnail,mimeType:"image/png"})]);
    expect(results.map(result => result.applied).sort()).toEqual([false,true]);
    expect((await assets())[0].hash).toBe(hash(thumbnail));
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool,publicUrl);
    const selection = { productId: 1, productVariantIds: [10,11], maxPhotosPerVariant: 12 };
    const normal = await reader.listPublicationPlan(selection);
    const smallerRequirement = await reader.listPublicationPlan({...selection,minimumLongestSide:300});
    const sized = await reader.listPublicationPlan({...selection, minimumLongestSide:500});
    expect(normal.group.selected[0].versionHash).toBe(hash(thumbnail));
    expect(smallerRequirement.group.selected[0].versionHash).toBe(hash(thumbnail));
    const published = sized.group.selected[0];
    expect(published.versionHash).not.toBe(hash(thumbnail));
    expect(sized.variants.map(row => row.gallery.selected[0].versionHash)).toEqual([published.versionHash,published.versionHash]);
    const copy = await readPublicCatalogImage(database.pool,1,published.versionHash!);
    expect(copy).not.toBeNull();
    expect((await import("../../catalog-image-inspection")).inspectCatalogImage(copy!)).toMatchObject({width:500,height:500});
    expect((await readPublicCatalogImage(database.pool,1,hash(thumbnail)))?.data).toEqual(thumbnail);
    const mapping = await database.pool.query("SELECT source_hash,rendition_hash FROM catalog.product_asset_renditions WHERE asset_id=1 AND source_hash=$1",[hash(thumbnail)]);
    expect(mapping.rows).toEqual([{source_hash:hash(thumbnail),rendition_hash:published.versionHash}]);
    await expect(database.pool.query("DELETE FROM catalog.product_asset_renditions WHERE asset_id=1")).rejects.toMatchObject({code:"23514"});
    const inspector = createCatalogImageInspector(async url => {
      const parts = new URL(url).pathname.split("/");
      const image = await readPublicCatalogImage(database.pool,Number(parts[4]),parts[5].split(".")[0]);
      if (!image) throw new Error("Published rendition is missing");
      return image;
    });
    const resolved = await new ChannelEbayListingPhotoResolver(database.pool,publicUrl,inspector).resolve({
      productId:1,channelId:67,variants:[{variantId:10,sku:"PACK"},{variantId:11,sku:"CASE"}],
    });
    expect(resolved.groupImageUrls).toEqual([published.url]);
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await pinCatalogPublicationMediaVersions(client,{owner:"channels",referenceKey:"rendition-test",kind:"pending",plan:sized,now});
      await client.query("COMMIT");
    } finally { client.release(); }
    const old = { ...command, expected: {...command.expected,storedHash:hash(thumbnail),storageType:"both" as const,
      mimeType:"image/png",width:400,height:400,fileSize:thumbnail.length} };
    await replace(old);
    expect((await reader.listPublicationPlan({...selection,minimumLongestSide:500})).group.selected[0].versionHash).toBe(hash(original));
    expect((await readPublicCatalogImage(database.pool,1,published.versionHash!))?.data).toEqual(copy!.data);
    expect((await database.pool.query("SELECT content_hash FROM catalog.publication_media_version_pins WHERE reference_key='rendition-test'")).rows)
      .toEqual([{content_hash:published.versionHash}]);
  });
  it("refuses to replace a URL-only photo until its prior bytes have been captured", async () => {
    const { expectedPriorHash: _unused, ...withoutPrior } = command;
    await expect(service.replace(withoutPrior,{data:original,mimeType:"image/png"})).rejects.toMatchObject({code:"CATALOG_PRIOR_IMAGE_REQUIRED"});
    await expect(service.replace(command,{data:original,mimeType:"image/png"},{data:minimum,mimeType:"image/png"})).rejects.toMatchObject({code:"CATALOG_PRIOR_IMAGE_CHANGED"});
    expect((await assets())[0].hash).toBeNull();
  });
  it("adds a missing rendition for an already stored original once, including concurrent recovery", async () => {
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,url,is_primary,storage_type,mime_type,file_data,width,height,file_size)
      OVERRIDING SYSTEM VALUE VALUES(333,1,'https://cdn.example.com/small.png',0,'both','image/png',$1,400,400,$2)`,[thumbnail,thumbnail.length]);
    const existing = {...command,assetId:333,expected:{...command.expected,url:"https://cdn.example.com/small.png",isPrimary:0 as const,
      storedHash:hash(thumbnail),storageType:"both" as const,mimeType:"image/png",width:400,height:400,fileSize:thumbnail.length},
      source:{kind:"external_url" as const,url:"https://cdn.example.com/small.png"},expectedOriginalHash:hash(thumbnail),expectedPriorHash:undefined};
    const image = {data:thumbnail,mimeType:"image/png"};
    expect(await service.preview(existing,image)).toMatchObject({wouldApply:true});
    const results = await Promise.all([service.replace(existing,image),service.replace(existing,image)]);
    expect(results.map(result=>result.applied).sort()).toEqual([false,true]);
    expect(await service.preview(existing,image)).toMatchObject({wouldApply:false});
    expect((await database.pool.query("SELECT count(*)::int AS count FROM catalog.product_asset_renditions WHERE asset_id=333")).rows[0].count).toBe(1);
    expect((await database.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([{action:"catalog.image_recovery.completed"}]);
    expect((await assets()).find(row=>row.id===333).hash).toBe(hash(thumbnail));
  });
  it("retains the reviewed prior photo even if the desired original was installed before recovery", async () => {
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,url,is_primary,storage_type,mime_type,file_data,width,height,file_size)
      OVERRIDING SYSTEM VALUE VALUES(913,1,'https://cdn.example.com/previous.png',0,'both','image/png',$1,640,640,$2)`,[original,original.length]);
    const replay = {...command,assetId:913,expected:{...command.expected,url:"https://cdn.example.com/previous.png",isPrimary:0 as const}};
    const image = {data:original,mimeType:"image/png"}, prior = {data:thumbnail,mimeType:"image/png"};
    expect(await service.preview(replay,image,prior)).toMatchObject({wouldApply:true});
    expect(await service.replace(replay,image,prior)).toMatchObject({applied:true});
    expect(await service.replace(replay,image,prior)).toMatchObject({applied:false});
    expect((await readPublicCatalogImage(database.pool,913,hash(thumbnail)))?.data).toEqual(thumbnail);
    expect((await assets()).find(row=>row.id===913).hash).toBe(hash(original));
    expect((await database.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([{action:"catalog.image_recovery.completed"}]);
  });
  it("prepares small uploads and imported photos through the same original owner", async () => {
    const upload = {productId:1,productVariantId:10,actor:"user:operator",altText:"Pack front"};
    const image = {data:thumbnail,mimeType:"image/png"};
    const uploaded = await Promise.all([service.create(upload,image),service.create(upload,image)]);
    expect(uploaded[0].id).toBe(uploaded[1].id);
    const importer = createSharedProductPhotoImporter(drizzle(database.pool,{schema}),()=>now,async()=>image);
    const input = {productId:1,actor:"service:import",photos:[{url:"https://cdn.example.com/import.png",position:0}]};
    expect((await Promise.all([importer.append(input),importer.append(input)])).map(result=>result.created).sort()).toEqual([0,1]);
    const imported = (await assets()).find(row=>row.url===input.photos[0].url)!;
    for (const id of [uploaded[0].id,imported.id]) {
      expect((await readPublicCatalogImage(database.pool,id,hash(thumbnail)))?.data).toEqual(thumbnail);
      const result = await database.pool.query("SELECT rendition_hash FROM catalog.product_asset_renditions WHERE asset_id=$1 AND source_hash=$2",[id,hash(thumbnail)]);
      expect(result.rows).toHaveLength(1);
      const copy = await readPublicCatalogImage(database.pool,id,result.rows[0].rendition_hash);
      expect((await import("../../catalog-image-inspection")).inspectCatalogImage(copy!)).toMatchObject({width:500,height:500});
    }
  });
  it("selects an enlarged copy only when a channel's own minimum exceeds the source size", async () => {
    const bytes = await sharp({create:{width:200,height:100,channels:3,background:"#dd2233"}}).png().toBuffer();
    const asset = await service.create({productId:1,productVariantId:10,actor:"user:operator"},{data:bytes,mimeType:"image/png"});
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool,publicUrl);
    const select = async (minimumLongestSide:number) => (await reader.listPublicationPlan({productId:1,productVariantIds:[10],
      maxPhotosPerVariant:12,minimumLongestSide})).group.selected.find(photo=>photo.assetId===asset.id)!;
    expect((await select(150)).versionHash).toBe(hash(bytes));
    const larger = await select(300);
    expect(larger.versionHash).not.toBe(hash(bytes));
    expect((await import("../../catalog-image-inspection")).inspectCatalogImage((await readPublicCatalogImage(database.pool,asset.id,larger.versionHash!))!))
      .toMatchObject({width:500,height:250});
  });
  it("saves a valid original and records a warning when a publication copy exceeds processing limits", async () => {
    const raw = Buffer.alloc(10*170*3);
    for (let frame=0;frame<17;frame++) raw.fill(frame*12,frame*10*10*3,(frame+1)*10*10*3);
    const bytes = await sharp(raw,{raw:{width:10,height:170,pageHeight:10,channels:3}}).gif({delay:Array(17).fill(100)}).toBuffer();
    expect((await sharp(bytes,{animated:true}).metadata()).pages).toBe(17);
    const result = await service.create({productId:1,actor:"user:operator"},{data:bytes,mimeType:"image/gif"});
    expect(result).toMatchObject({publicationWarning:{code:"CATALOG_IMAGE_RENDITION_FAILED"}});
    expect((await readPublicCatalogImage(database.pool,result.id,hash(bytes)))?.data).toEqual(bytes);
    expect((await database.pool.query("SELECT * FROM catalog.product_asset_renditions WHERE asset_id=$1 AND source_hash=$2",[result.id,hash(bytes)])).rows).toHaveLength(0);
    const audit = await database.pool.query("SELECT context FROM public.audit_events WHERE action='catalog.image_original.created'");
    expect(audit.rows[0].context.renditionWarning.code).toBe("CATALOG_IMAGE_RENDITION_FAILED");
  });
  it("rolls back an original and its rendition when the recovery audit fails", async () => {
    await database.pool.query("INSERT INTO catalog.product_assets(id,product_id,url) OVERRIDING SYSTEM VALUE VALUES(777,1,'https://cdn.example.com/atomic.png')");
    const small = {...command,assetId:777,expected:{...command.expected,url:"https://cdn.example.com/atomic.png",isPrimary:0 as const},
      source:{kind:"external_url" as const,url:"https://cdn.example.com/atomic.png"},expectedOriginalHash:hash(thumbnail),expectedPriorHash:undefined};
    await database.pool.query(`CREATE FUNCTION public.fail_rendition_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;
      CREATE TRIGGER fail_rendition_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.fail_rendition_audit()`);
    try {
      await expect(service.replace(small,{data:thumbnail,mimeType:"image/png"})).rejects.toThrow("audit unavailable");
      expect((await assets()).find(row=>row.id===777).hash).toBeNull();
      expect((await database.pool.query("SELECT * FROM catalog.product_asset_versions WHERE asset_id=777")).rows).toHaveLength(0);
      expect((await database.pool.query("SELECT * FROM catalog.product_asset_renditions WHERE asset_id=777")).rows).toHaveLength(0);
    } finally { await database.pool.query("DROP TRIGGER fail_rendition_audit ON public.audit_events; DROP FUNCTION public.fail_rendition_audit()"); }
  });
  it("recovers a product's entire gallery atomically, and replays concurrent batches once", async () => {
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,url,is_primary,position)
      OVERRIDING SYSTEM VALUE VALUES(711,1,'https://cdn.example.com/a.png',0,1),(712,1,'https://cdn.example.com/b.png',0,2)`);
    const first = {...command,assetId:711,expected:{...command.expected,url:"https://cdn.example.com/a.png",isPrimary:0 as const,position:1}};
    const second = {...command,assetId:712,expected:{...command.expected,url:"https://cdn.example.com/b.png",isPrimary:0 as const,position:2}};
    const batch = [first,second].map(command => ({command,image:{data:original,mimeType:"image/png"},priorImage:{data:thumbnail,mimeType:"image/png"}}));
    await database.pool.query("UPDATE catalog.product_assets SET position=9 WHERE id=712");
    await expect(service.replaceBatch(batch)).rejects.toMatchObject({code:"CATALOG_ORIGINAL_SOURCE_CHANGED"});
    expect((await assets()).filter(row=>[711,712].includes(row.id)).map(row=>row.hash)).toEqual([null,null]);
    expect((await database.pool.query("SELECT * FROM catalog.product_asset_versions WHERE asset_id IN (711,712)")).rows).toHaveLength(0);
    expect((await database.pool.query("SELECT * FROM public.audit_events")).rows).toHaveLength(0);
    await database.pool.query("UPDATE catalog.product_assets SET position=2 WHERE id=712");
    const results = await Promise.all([service.replaceBatch(batch),service.replaceBatch(batch)]);
    expect(results.map(group=>group.map(item=>item.applied))).toEqual(expect.arrayContaining([[true,true],[false,false]]));
    expect((await assets()).filter(row=>[711,712].includes(row.id)).map(row=>row.hash)).toEqual([hash(original),hash(original)]);
    expect((await database.pool.query("SELECT * FROM public.audit_events")).rows).toHaveLength(2);
    for (const id of [711,712]) expect((await readPublicCatalogImage(database.pool,id,hash(thumbnail)))?.data).toEqual(thumbnail);
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
