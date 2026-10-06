import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
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
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, fixture); });
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
    expect(images.get(10)?.map((image) => image.id)).toEqual([2, 4, 1, 6, 7, 8]);
    expect(images.get(11)?.map((image) => image.id)).toEqual([2, 5, 1, 6, 7, 8]);
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

  it("returns only the first photos of each size and fingerprints each kept photo once", async () => {
    const query = vi.fn(database.pool.query.bind(database.pool));
    const images = await readCatalogVariantPublicationImages({ query } as never, { productVariantIds: [10, 11], maxPhotosPerVariant: 3 });
    expect(images.get(10)?.map((image) => image.id)).toEqual([2, 4, 1]);
    expect(images.get(11)?.map((image) => image.id)).toEqual([2, 5, 1]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    const plan = (await database.pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)).rows[0]["QUERY PLAN"];
    const fingerprinted = findPlanNode(plan[0].Plan, (node) => node["Subplan Name"] === "CTE photos");
    // Photos 1, 2, 4 and 5 are kept; photo 2 is shared by both sizes and read once.
    expect(fingerprinted?.["Actual Rows"]).toBe(4);
  });

  it("resolves marketplace URLs the public route serves, and reports photos it cannot publish", async () => {
    const reader = new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl);
    const photos = await reader.listPublicationPhotos({ productVariantIds: [10, 20], maxPhotosPerVariant: 20 });
    expect(photos.get(10)?.photos).toEqual([
      { assetId: 2, url: `https://catalog.example.com/api/catalog/images/2/${sha256(png)}.png`, uploaded: true },
      { assetId: 4, url: "https://cdn.example.com/size-10.jpg", uploaded: false },
      { assetId: 1, url: "https://cdn.example.com/p-2.jpg", uploaded: false },
      { assetId: 7, url: "https://cdn.example.com/both-4.jpg", uploaded: false },
      { assetId: 8, url: `https://catalog.example.com/api/catalog/images/8/${sha256(gif)}.gif`, uploaded: true },
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
