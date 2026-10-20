import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
import { pinCatalogPublicationMediaVersions } from "../../catalog-publication-media-versions";
import {
  PgCatalogVariantPublicationPhotoReader,
  readCatalogVariantPublicationImages,
  readPublicCatalogImage,
} from "../../catalog-publication-images.reader";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced catalog fixture: proves the photo projection, ordering and fingerprints, not a migration rollout.
const fixture = `
  CREATE SCHEMA catalog;
  CREATE TABLE catalog.product_variants (id integer PRIMARY KEY, product_id integer NOT NULL);
  CREATE TABLE catalog.product_assets (
    id integer PRIMARY KEY, product_id integer NOT NULL, product_variant_id integer,
    asset_type text NOT NULL DEFAULT 'image', url text, position integer NOT NULL DEFAULT 0,
    is_primary integer NOT NULL DEFAULT 0, mime_type text, storage_type text NOT NULL DEFAULT 'url', file_data bytea
  );
  INSERT INTO catalog.product_variants VALUES (10, 1), (11, 1), (20, 2);
`;
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const jpeg = Buffer.from("ffd8ffe000104a4649460001", "hex");
const gif = Buffer.from("474946383961010001000000", "hex");
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const publicUrl = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" });

(url && disposable ? describe : describe.skip)("catalog size photos for publication (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, fixture); await database.pool.query(await readFile("migrations/900000017000018580001_catalog_publication_media_versions.sql", "utf8")); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE catalog.product_assets");
    await database.pool.query(`INSERT INTO catalog.product_assets
      (id, product_id, product_variant_id, asset_type, url, position, is_primary, mime_type, storage_type, file_data) VALUES
      (1, 1, NULL, 'image', 'https://cdn.example.com/p-2.jpg', 2, 0, NULL, 'url', NULL),
      (2, 1, NULL, 'image', NULL, 5, 1, 'image/png', 'file', $1),
      (3, 1, NULL, 'image', '   ', 0, 0, NULL, 'url', NULL),
      (4, 1, 10, 'image', 'https://cdn.example.com/size-10.jpg', 1, 0, NULL, 'url', NULL),
      (5, 1, 11, 'image', NULL, 1, 0, 'image/jpeg', 'file', $2),
      (6, 1, NULL, 'image', NULL, 3, 0, 'image/png', 'file', NULL),
      (7, 1, NULL, 'image', 'https://cdn.example.com/both-4.jpg', 4, 0, 'image/jpeg', 'both', $2),
      (8, 1, NULL, 'image', '', 6, 0, 'image/gif', 'both', $3),
      (9, 1, NULL, 'video', 'https://cdn.example.com/video.mp4', 0, 1, NULL, 'url', NULL),
      (10, 2, NULL, 'image', NULL, 0, 0, 'image/png', 'file', $4)`, [png, jpeg, gif, Buffer.from("not an image")]);
  });

  it("lists each size's photos primary first, then by position, with only its own size photos", async () => {
    const images = await readCatalogVariantPublicationImages(database.pool, { productVariantIds: [10, 11, 20, 99], maxPhotosPerVariant: 20 });
    expect(images.get(10)?.map((image) => image.id)).toEqual([2, 3, 4, 1, 6, 7, 8]);
    expect(images.get(11)?.map((image) => image.id)).toEqual([2, 3, 5, 1, 6, 7, 8]);
    expect(images.get(20)?.map((image) => image.id)).toEqual([10]);
    expect(images.get(99)).toEqual([]);
    const byId = new Map(images.get(10)?.map((image) => [image.id, image]));
    // A stored file is fingerprinted only when the photo has no usable URL.
    expect(byId.get(2)).toMatchObject({ url: null, fileBytes: png.length, fileHash: sha256(png), mimeType: "image/png" });
    expect(byId.get(2)?.fileHeader?.equals(png.subarray(0, 12))).toBe(true);
    expect(byId.get(7)).toMatchObject({ url: "https://cdn.example.com/both-4.jpg", fileBytes: null, fileHash: null, fileHeader: null });
    expect(byId.get(8)).toMatchObject({ url: null, storageType: "both", fileHash: sha256(gif) });
    expect(byId.get(6)).toMatchObject({ url: null, fileBytes: null, fileHash: null });
  });

  it("reads complete candidates before capacity and fingerprints each shared photo once", async () => {
    const query = vi.fn(database.pool.query.bind(database.pool));
    const images = await readCatalogVariantPublicationImages({ query } as never, { productVariantIds: [10, 11], maxPhotosPerVariant: 3 });
    expect(images.get(10)?.map((image) => image.id)).toEqual([2, 3, 4, 1, 6, 7, 8]);
    expect(images.get(11)?.map((image) => image.id)).toEqual([2, 3, 5, 1, 6, 7, 8]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    const plan = (await database.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]["QUERY PLAN"];
    const fingerprinted = findPlanNode(plan[0].Plan, (node) => node["Subplan Name"] === "CTE photos");
    // All eight candidates are read once, including shared and omitted images.
    expect(fingerprinted?.["Actual Rows"]).toBe(8);
  });

  it("resolves marketplace URLs the public route serves, and reports photos it cannot publish", async () => {
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl);
    const photos = await reader.listPublicationPhotos({ productVariantIds: [10, 20], maxPhotosPerVariant: 20 });
    expect(photos.get(10)?.photos).toEqual([
      { assetId: 2, position: 0, url: `https://catalog.example.com/api/catalog/images/2/${sha256(png)}.png`, uploaded: true },
      { assetId: 4, position: 2, url: "https://cdn.example.com/size-10.jpg", uploaded: false },
      { assetId: 1, position: 4, url: "https://cdn.example.com/p-2.jpg", uploaded: false },
      { assetId: 7, position: 6, url: "https://cdn.example.com/both-4.jpg", uploaded: false },
      { assetId: 8, position: 7, url: `https://catalog.example.com/api/catalog/images/8/${sha256(gif)}.gif`, uploaded: true },
    ]);
    expect(photos.get(10)?.issues).toEqual([expect.objectContaining({ assetId: 6, code: "CATALOG_IMAGE_UNAVAILABLE" })]);
    expect(photos.get(20)).toEqual({ photos: [], issues: [expect.objectContaining({ assetId: 10, code: "IMAGE_FORMAT_UNSUPPORTED" })] });
    // The anonymous route serves exactly the published file.
    await expect(readPublicCatalogImage(database.pool, 2, sha256(png))).resolves.toEqual({ data: png, mimeType: "image/png" });
  });

  it("reads without writing", async () => {
    const before = (await database.pool.query("SELECT * FROM catalog.product_assets ORDER BY id")).rows;
    await new PgCatalogVariantPublicationPhotoReader(database.pool, createCatalogPublicImageUrl({}))
      .listPublicationPhotos({ productVariantIds: [10, 11, 20], maxPhotosPerVariant: 20 });
    expect((await database.pool.query("SELECT * FROM catalog.product_assets ORDER BY id")).rows).toEqual(before);
  });

  it("keeps each independent variant plan identical regardless of other products in the read batch", async () => {
    await database.pool.query("UPDATE catalog.product_assets SET url='https://cdn.example.com/product-two.jpg' WHERE id=10");
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl);
    const alone = (await reader.listPublicationPlansByVariant({ productVariantIds:[20], maxPhotosPerVariant:20 })).get(20);
    const batched = (await reader.listPublicationPlansByVariant({ productVariantIds:[10,11,20], maxPhotosPerVariant:20 })).get(20);
    expect(batched).toEqual(alone);
    await database.pool.query("INSERT INTO catalog.product_assets(id,product_id,url,position) VALUES (500,1,'https://cdn.example.com/unrelated.jpg',-1)");
    const changedOtherProduct = (await reader.listPublicationPlansByVariant({ productVariantIds:[20,10], maxPhotosPerVariant:20 })).get(20);
    expect(changedOtherProduct).toEqual(alone);
    expect(alone?.group.selected[0]).toMatchObject({assetId:10,position:0});
  });

  it("deduplicates before capacity and accounts for every image without letting documents satisfy readiness", async () => {
    await database.pool.query("DELETE FROM catalog.product_assets");
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,asset_type,url,position,is_primary)
      SELECT 100+n,1,'image','https://cdn.example.com/' || CASE WHEN n<3 THEN 'duplicate' ELSE n::text END || '.jpg',n,0
      FROM generate_series(1,14) n;
      INSERT INTO catalog.product_assets(id,product_id,asset_type,url,position) VALUES (200,1,'document','https://cdn.example.com/doc.pdf',0)`);
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl);
    const plan = await reader.listPublicationPlan({ productVariantIds: [10,11], maxPhotosPerVariant: 12, maxGroupPhotos: 12 });
    expect(plan.group.expected).toBe(14);
    expect(plan.group.selected).toHaveLength(12);
    expect(plan.group.omissions).toEqual([
      { assetId: 102, reason: "duplicate", duplicateOfAssetId: 101, blocking: false },
      { assetId: 114, reason: "capacity", blocking: false },
    ]);
    expect(plan.variants.map(v => v.gallery)).toEqual([plan.group,plan.group]);
    const legacy = await reader.listPublicationPhotos({ productVariantIds: [10], maxPhotosPerVariant: 12 });
    expect(legacy.get(10)?.photos.map(photo => photo.url)).toEqual(plan.group.selected.map(photo => photo.url));
    await database.pool.query("UPDATE catalog.product_assets SET url='https://cdn.example.com/omitted-changed.jpg' WHERE id=114");
    const edited = await reader.listPublicationPlan({ productVariantIds: [10,11], maxPhotosPerVariant: 12, maxGroupPhotos: 12 });
    expect(edited.group.selected).toEqual(plan.group.selected);
    expect(edited.sourceRevision).not.toBe(plan.sourceRevision);
  });

  it("fills twelve unique publication photos even when early source rows repeat a URL", async () => {
    await database.pool.query("DELETE FROM catalog.product_assets");
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,url,position)
      SELECT 300+n,1,'https://cdn.example.com/' || CASE WHEN n<3 THEN 'duplicate' ELSE n::text END || '.jpg',n
      FROM generate_series(1,13) n`);
    const photos=await new PgCatalogVariantPublicationPhotoReader(database.pool,publicUrl)
      .listPublicationPhotos({productVariantIds:[10],maxPhotosPerVariant:12});
    expect(photos.get(10)?.photos).toHaveLength(12);
    expect(new Set(photos.get(10)?.photos.map(photo=>photo.url)).size).toBe(12);
    expect(photos.get(10)?.photos.at(-1)?.assetId).toBe(313);
  });

  it("keeps group coverage independent from each variant's capacity and retains exclusions in the plan", async () => {
    await database.pool.query("DELETE FROM catalog.product_assets");
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,product_variant_id,url,position,is_primary) VALUES
      (201,1,10,'https://cdn.example.com/pack.jpg',1,1), (202,1,11,'https://cdn.example.com/case.jpg',2,0),
      (203,1,NULL,'https://cdn.example.com/common.jpg',3,0), (204,1,NULL,'https://cdn.example.com/excluded.jpg',0,0)`);
    const plan = await new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl).listPublicationPlan({
      productVariantIds: [10,11], maxPhotosPerVariant: 1, maxGroupPhotos: 3,
      overrides: [{assetId:204,included:false,urlOverride:null,positionOverride:null}],
    });
    expect(plan.variants.map(v => v.gallery.selected.map(p => p.assetId))).toEqual([[201],[202]]);
    expect(plan.group.selected.map(p => p.assetId)).toEqual([201,202,203]);
    expect(plan.group.omissions).toEqual([{assetId:204,reason:"excluded",blocking:false}]);
  });

  it("retains exact uploaded versions across replacement, deletion and rollback without exposing invalid raster bytes", async () => {
    const original = await readPublicCatalogImage(database.pool,2,sha256(png));
    expect(original).toEqual({data:png,mimeType:"image/png"});
    await database.pool.query("UPDATE catalog.product_assets SET file_data=$1,mime_type='image/gif' WHERE id=2",[gif]);
    expect(await readPublicCatalogImage(database.pool,2,sha256(png))).toEqual(original);
    expect(await readPublicCatalogImage(database.pool,2,sha256(gif))).toEqual({data:gif,mimeType:"image/gif"});
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE catalog.product_assets SET file_data=$1,mime_type='image/jpeg' WHERE id=2",[jpeg]);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await readPublicCatalogImage(database.pool,2,sha256(jpeg))).toBeNull();
    await database.pool.query("DELETE FROM catalog.product_assets WHERE id=2");
    expect(await readPublicCatalogImage(database.pool,2,sha256(png))).toEqual(original);
    expect(await readPublicCatalogImage(database.pool,2,sha256(gif))).toEqual({data:gif,mimeType:"image/gif"});
    expect(await readPublicCatalogImage(database.pool,10,sha256(Buffer.from("not an image")))).toBeNull();
    await expect(database.pool.query("DELETE FROM catalog.product_asset_versions WHERE asset_id=2"))
      .rejects.toMatchObject({constraint:"publication_image_versions_immutable"});
  });

  it("pins exact versions in the acceptance transaction, replays idempotently, and rolls back a failed acceptance", async () => {
    const plan = await new PgCatalogVariantPublicationPhotoReader(database.pool,publicUrl)
      .listPublicationPlan({productVariantIds:[10],maxPhotosPerVariant:1});
    const input = {owner:"channels" as const,referenceKey:"test-operation:1",kind:"pending" as const,plan,now:new Date("2026-10-19T00:00:00Z")};
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await pinCatalogPublicationMediaVersions(client,input);
      await client.query("ROLLBACK");
      expect((await database.pool.query("SELECT * FROM catalog.publication_media_references WHERE reference_key=$1",[input.referenceKey])).rows).toEqual([]);
      await client.query("BEGIN");
      await pinCatalogPublicationMediaVersions(client,input);
      await pinCatalogPublicationMediaVersions(client,input);
      await client.query("COMMIT");
      expect((await database.pool.query("SELECT * FROM catalog.publication_media_version_pins WHERE reference_key=$1",[input.referenceKey])).rowCount).toBe(1);
      await client.query("BEGIN");
      await expect(pinCatalogPublicationMediaVersions(client,{...input,plan:{...plan,sourceRevision:"a".repeat(64)}}))
        .rejects.toMatchObject({code:"CATALOG_MEDIA_REFERENCE_CONFLICT"});
      await client.query("ROLLBACK");
    } finally { client.release(); }
  });

  it("rejects a missing version without partial pins and serializes conflicting acceptance of one reference", async () => {
    const plan=await new PgCatalogVariantPublicationPhotoReader(database.pool,publicUrl)
      .listPublicationPlan({productVariantIds:[10],maxPhotosPerVariant:1});
    const input={owner:"channels" as const,referenceKey:"concurrent-operation",kind:"pending" as const,plan,now:new Date("2026-10-19T00:00:00Z")};
    const commit=async(candidate:typeof input)=>{
      const client=await database.pool.connect();
      try {await client.query("BEGIN");await pinCatalogPublicationMediaVersions(client,candidate);await client.query("COMMIT");}
      catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    };
    const missing=structuredClone(plan);
    missing.group.selected[0].assetId=9999;
    missing.variants[0].gallery.selected[0].assetId=9999;
    await expect(commit({...input,referenceKey:"missing-version",plan:missing})).rejects.toMatchObject({code:"CATALOG_MEDIA_VERSION_UNAVAILABLE"});
    expect((await database.pool.query("SELECT 1 FROM catalog.publication_media_references WHERE reference_key='missing-version'")).rowCount).toBe(0);
    const results=await Promise.allSettled([commit(input),commit({...input,plan:{...plan,sourceRevision:"b".repeat(64)}})]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toEqual([{status:"rejected",reason:expect.objectContaining({code:"CATALOG_MEDIA_REFERENCE_CONFLICT"})}]);
    expect((await database.pool.query("SELECT 1 FROM catalog.publication_media_version_pins WHERE reference_key=$1",[input.referenceKey])).rowCount).toBe(1);
  });
});

interface PlanNode { "Subplan Name"?: string; "Actual Rows"?: number; Plans?: PlanNode[] }
function findPlanNode(node: PlanNode, matches: (node: PlanNode) => boolean): PlanNode | undefined {
  if (matches(node)) return node;
  for (const child of node.Plans ?? []) {
    const found = findPlanNode(child, matches);
    if (found) return found;
  }
  return undefined;
}
