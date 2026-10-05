import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { reorderCatalogAssets } from "../../product-asset-order.repository";
import { readProductImageDownload } from "../../product-image-download.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced catalog fixture: proves ordering transactions and media reads, not a migration rollout.
const fixture = `
  CREATE SCHEMA catalog;
  CREATE TABLE catalog.products (id integer PRIMARY KEY, sku text);
  CREATE TABLE catalog.product_assets (
    id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products(id),
    product_variant_id integer, asset_type text NOT NULL DEFAULT 'image', position integer NOT NULL,
    is_primary integer NOT NULL DEFAULT 0, url text, mime_type text, storage_type text NOT NULL DEFAULT 'url', file_data bytea
  );
  INSERT INTO catalog.products VALUES (1, 'PACK-100'), (2, 'OTHER');
`;

(url && disposable ? describe : describe.skip)("catalog image PostgreSQL guarantees", () => {
  let database: InventoryCutoverTestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, fixture); db = drizzle(database.pool, { schema }); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE catalog.product_assets;
      INSERT INTO catalog.product_assets(id, product_id, product_variant_id, position, is_primary, url) VALUES
      (1,1,NULL,0,0,'https://example.com/1.png'), (2,1,NULL,0,1,'https://example.com/2.png'),
      (3,1,10,2,0,'https://example.com/3.png'), (4,2,NULL,0,1,'https://example.com/4.png');`);
  });
  async function rows() { return (await database.pool.query("SELECT id, position, is_primary, product_variant_id FROM catalog.product_assets ORDER BY product_id, position, id")).rows; }

  it("persists a complete order and preserves primary choice, variant scope and other products", async () => {
    await reorderCatalogAssets(db, 1, { orderedIds: [3, 1, 2], expectedOrderedIds: [1, 2, 3] });
    expect(await rows()).toEqual([
      { id: 3, position: 0, is_primary: 0, product_variant_id: 10 },
      { id: 1, position: 1, is_primary: 0, product_variant_id: null },
      { id: 2, position: 2, is_primary: 1, product_variant_id: null },
      { id: 4, position: 0, is_primary: 1, product_variant_id: null },
    ]);
    await reorderCatalogAssets(db, 1, { orderedIds: [3, 1, 2], expectedOrderedIds: [1, 2, 3] });
    expect((await rows()).map(row => row.id)).toEqual([3, 1, 2, 4]);
  });
  it.each([[1, 2], [1, 2, 4], [1, 2, 3, 4]])("rejects omitted or foreign images %j without any write", async (...orderedIds) => {
    const before = await rows();
    await expect(reorderCatalogAssets(db, 1, { orderedIds })).rejects.toMatchObject({ code: "ASSET_ORDER_CHANGED" });
    expect(await rows()).toEqual(before);
  });
  it("rejects duplicate IDs, missing products and stale membership", async () => {
    await expect(reorderCatalogAssets(db, 1, { orderedIds: [1, 1, 2] })).rejects.toMatchObject({ status: 400 });
    await expect(reorderCatalogAssets(db, 999, { orderedIds: [] })).rejects.toMatchObject({ status: 404 });
    await database.pool.query("DELETE FROM catalog.product_assets WHERE id=3");
    await expect(reorderCatalogAssets(db, 1, { orderedIds: [3, 1, 2] })).rejects.toMatchObject({ status: 409 });
    expect((await rows()).map(row => row.id)).toEqual([1, 2, 4]);
  });
  it("serializes two editors and rejects the stale snapshot", async () => {
    const results = await Promise.allSettled([
      reorderCatalogAssets(db, 1, { orderedIds: [3, 1, 2], expectedOrderedIds: [1, 2, 3] }),
      reorderCatalogAssets(db, 1, { orderedIds: [2, 3, 1], expectedOrderedIds: [1, 2, 3] }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "ASSET_ORDER_CHANGED" });
    expect((await rows()).filter(row => row.id !== 4).map(row => row.position)).toEqual([0, 1, 2]);
  });
  it("rolls back all positions when a later write fails", async () => {
    const before = await rows();
    await database.pool.query(`CREATE FUNCTION catalog.fail_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id=2 THEN RAISE EXCEPTION 'test order write failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_order BEFORE UPDATE ON catalog.product_assets FOR EACH ROW EXECUTE FUNCTION catalog.fail_order();`);
    try {
      await expect(reorderCatalogAssets(db, 1, { orderedIds: [3, 1, 2] })).rejects.toThrow();
      expect(await rows()).toEqual(before);
    } finally { await database.pool.query("DROP TRIGGER fail_order ON catalog.product_assets; DROP FUNCTION catalog.fail_order()"); }
  });
  it("reads stored and URL images by exact ID and excludes other asset types", async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await database.pool.query("UPDATE catalog.product_assets SET file_data=$1, mime_type='image/png', storage_type='both' WHERE id=2", [bytes]);
    expect(await readProductImageDownload(db, 2)).toEqual({ sku: "PACK-100", data: bytes, mimeType: "image/png", fileBytes: 8, url: "https://example.com/2.png" });
    expect(await readProductImageDownload(db, 1)).toMatchObject({ sku: "PACK-100", data: null, fileBytes: null, url: "https://example.com/1.png" });
    await database.pool.query("UPDATE catalog.product_assets SET asset_type='document' WHERE id=2");
    expect(await readProductImageDownload(db, 2)).toBeNull();
    expect(await readProductImageDownload(db, 999)).toBeNull();
  });
});
