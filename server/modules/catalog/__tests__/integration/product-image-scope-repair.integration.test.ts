import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { repairCatalogImageScope, type ImageScopeRepair } from "../../product-image-scope-repair";
import { readCatalogVariantPublicationImages } from "../../catalog-publication-images.reader";
vi.mock("../../../../db", () => ({ db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const ddl = `CREATE SCHEMA catalog;
CREATE TABLE catalog.products(id integer PRIMARY KEY);
CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products(id),UNIQUE(id,product_id));
CREATE TABLE catalog.product_assets(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 product_variant_id integer REFERENCES catalog.product_variants(id) ON DELETE CASCADE,asset_type text NOT NULL DEFAULT 'image',url text,
 position integer NOT NULL,is_primary integer NOT NULL,storage_type text NOT NULL DEFAULT 'url',mime_type text,file_data bytea);
CREATE TABLE public.audit_events(id bigserial PRIMARY KEY,timestamp timestamptz NOT NULL,level text NOT NULL,actor text NOT NULL,
 action text NOT NULL,target text,changes jsonb,context jsonb);
INSERT INTO catalog.products VALUES(39),(103);
INSERT INTO catalog.product_variants VALUES(78,39),(265,103),(207,103);`;
const command: ImageScopeRepair = { productId: 103,
  expected: Array.from({ length: 5 }, (_, position) => ({ id: 7192 + position, url: `https://cdn.example.com/${position}.jpg`,
    productVariantId: 78, position, isPrimary: position === 0 ? 1 : 0 })),
  actor: "test:operator", reason: "Source confirms these five images are shared product photos",
  evidenceReference: "test-source-snapshot", now: new Date("2026-10-07T00:00:00Z") };
const migration = readFileSync(new URL("../../../../../migrations/0727_product_asset_variant_ownership.sql", import.meta.url), "utf8");

(url && disposable ? describe : describe.skip).sequential("catalog image scope repair PostgreSQL guarantees", () => {
  let database: InventoryCutoverTestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, ddl); db = drizzle(database.pool, { schema }); });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`ALTER TABLE catalog.product_assets DROP CONSTRAINT IF EXISTS product_assets_variant_product_fk;
      TRUNCATE catalog.product_assets,public.audit_events;
      INSERT INTO catalog.product_assets(id,product_id,product_variant_id,url,position,is_primary)
        SELECT 7192+i,103,78,'https://cdn.example.com/'||i||'.jpg',i,CASE WHEN i=0 THEN 1 ELSE 0 END FROM generate_series(0,4) i;
      INSERT INTO catalog.product_assets(id,product_id,product_variant_id,url,position,is_primary) VALUES
        (8000,103,207,'https://cdn.example.com/case.jpg',5,0),(9000,39,78,'https://cdn.example.com/pack.jpg',0,1);`);
  });
  const rows = async () => (await database.pool.query("SELECT * FROM catalog.product_assets ORDER BY id")).rows;
  const audits = async () => (await database.pool.query("SELECT * FROM public.audit_events ORDER BY id")).rows;

  it("dry-runs without writes, then restores all five inherited photos and preserves valid variant photos", async () => {
    const before = await rows();
    const imagesBefore = await readCatalogVariantPublicationImages(database.pool, { productVariantIds: [78,265,207], maxPhotosPerVariant: 20 });
    expect(imagesBefore.get(265)).toEqual([]);
    expect((await repairCatalogImageScope(db, command)).applied).toBe(false);
    expect(await rows()).toEqual(before);
    expect(await audits()).toEqual([]);
    // The actual migration tolerates old invalid rows but protects every new write.
    await database.pool.query(migration);
    expect((await repairCatalogImageScope(db, command, true)).applied).toBe(true);
    const images = await readCatalogVariantPublicationImages(database.pool, { productVariantIds: [78,265,207], maxPhotosPerVariant: 20 });
    expect(images.get(265)?.map(image => image.url)).toEqual(command.expected.map(image => image.url));
    expect(images.get(78)).toEqual(imagesBefore.get(78));
    expect(images.get(207)?.map(image => image.id)).toEqual([7192,7193,7194,7195,7196,8000]);
    const after = await rows();
    expect(after).toEqual(before.map(asset => asset.id < 8000 ? { ...asset, product_variant_id: null } : asset));
    expect(await audits()).toEqual([expect.objectContaining({ actor: command.actor, timestamp: command.now,
      action: "catalog.image_variant_scope_repaired", changes: { before: { assets: expect.any(Array) }, after: { assets: expect.any(Array) } } })]);
    expect((await repairCatalogImageScope(db, command, true)).alreadyApplied).toBe(true);
    expect(await audits()).toHaveLength(1);
    await database.pool.query("ALTER TABLE catalog.product_assets VALIDATE CONSTRAINT product_assets_variant_product_fk");
  });
  it("rejects stale repairs and valid sibling-specific photos without writing", async () => {
    const before = await rows();
    const changed = { ...command, expected: command.expected.map((asset, i) => i ? asset : { ...asset, url: "https://cdn.example.com/new.jpg" }) };
    await expect(repairCatalogImageScope(db, changed, true)).rejects.toMatchObject({ code: "IMAGE_SCOPE_REPAIR_STALE" });
    await expect(repairCatalogImageScope(db, { ...command, expected: [{ id: 8000, url: "https://cdn.example.com/case.jpg", productVariantId: 207, position: 5, isPrimary: 0 }] }, true))
      .rejects.toMatchObject({ code: "IMAGE_SCOPE_REPAIR_STALE" });
    expect(await rows()).toEqual(before);
    expect(await audits()).toEqual([]);
  });
  it("serializes concurrent retries with one audit event", async () => {
    const results = await Promise.all([repairCatalogImageScope(db, command, true), repairCatalogImageScope(db, command, true)]);
    expect(results.filter(result => result.applied)).toHaveLength(1);
    expect(results.filter(result => result.alreadyApplied)).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });
  it("rolls the correction back if its audit cannot be written", async () => {
    const before = await rows();
    await database.pool.query("ALTER TABLE public.audit_events ADD CONSTRAINT test_reject_audit CHECK (action <> 'catalog.image_variant_scope_repaired')");
    try { await expect(repairCatalogImageScope(db, command, true)).rejects.toThrow(); }
    finally { await database.pool.query("ALTER TABLE public.audit_events DROP CONSTRAINT test_reject_audit"); }
    expect(await rows()).toEqual(before);
    expect(await audits()).toEqual([]);
  });
  it("guards inserts, asset reassignment and variant moves while retaining shared photos and cascading deletes", async () => {
    await repairCatalogImageScope(db, command, true);
    await database.pool.query(migration);
    await expect(database.pool.query("INSERT INTO catalog.product_assets(id,product_id,product_variant_id,position,is_primary) VALUES(9999,103,78,0,0)"))
      .rejects.toMatchObject({ code: "23503", constraint: "product_assets_variant_product_fk" });
    await expect(database.pool.query("UPDATE catalog.product_assets SET product_variant_id=78 WHERE id=7192"))
      .rejects.toMatchObject({ code: "23503" });
    await expect(database.pool.query("UPDATE catalog.product_variants SET product_id=39 WHERE id=207"))
      .rejects.toMatchObject({ code: "23503" });
    await database.pool.query("DELETE FROM catalog.product_variants WHERE id=207");
    expect((await rows()).map(asset => asset.id)).toEqual([7192,7193,7194,7195,7196,9000]);
    await database.pool.query("INSERT INTO catalog.product_variants VALUES(207,103)");
  });
});
