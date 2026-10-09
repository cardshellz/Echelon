import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import type { ProductAssetScopeCommand } from "@shared/catalog/product-asset-scope";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { hashHttpFinancialCommand } from "../../../../platform/commands/http-command";
import { type FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";
import { createProductAssetScopeService } from "../../product-asset-scope.service";
import { createCatalogPublicImageUrl } from "../../catalog-public-image";
import { PgCatalogVariantPublicationPhotoReader } from "../../catalog-publication-images.reader";
import { ChannelEbayListingPhotoResolver } from "../../../channels/ebay-listing-photos.service";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";

// Never connect the application singleton to a production DATABASE_URL.
vi.mock("../../../../db", () => ({ db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const fixture = `
  CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA inventory;
  CREATE TABLE catalog.products (id integer PRIMARY KEY, sku text NOT NULL);
  CREATE TABLE catalog.product_variants (
    id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products,
    sku text NOT NULL UNIQUE, UNIQUE(id,product_id)
  );
  CREATE TABLE catalog.product_assets (
    id integer PRIMARY KEY, product_id integer NOT NULL REFERENCES catalog.products,
    product_variant_id integer REFERENCES catalog.product_variants,
    asset_type text NOT NULL DEFAULT 'image', url text, position integer NOT NULL,
    is_primary integer NOT NULL, mime_type text, storage_type text NOT NULL DEFAULT 'url', file_data bytea
  );
  CREATE TABLE public.audit_events (
    id bigserial PRIMARY KEY, timestamp timestamptz NOT NULL DEFAULT now(), level text NOT NULL DEFAULT 'AUDIT',
    actor text NOT NULL, action text NOT NULL, target text, changes jsonb, context jsonb
  );
  CREATE TABLE public._migrations (filename text PRIMARY KEY, content_hash text NOT NULL);
  CREATE TABLE channels.channel_asset_overrides (
    channel_id integer NOT NULL, product_asset_id integer NOT NULL REFERENCES catalog.product_assets,
    is_included integer NOT NULL DEFAULT 1, url_override text, position_override integer,
    PRIMARY KEY(channel_id,product_asset_id)
  );
  CREATE TABLE channels.channel_variant_overrides (
    channel_id integer NOT NULL, product_variant_id integer NOT NULL REFERENCES catalog.product_variants,
    sku_override text, PRIMARY KEY(channel_id,product_variant_id)
  );
  CREATE TABLE inventory.inventory_levels (variant_id integer PRIMARY KEY, quantity integer NOT NULL);
  INSERT INTO catalog.products VALUES (1,'PRODUCT'),(2,'OTHER');
  INSERT INTO catalog.product_variants VALUES (10,1,'PACK'),(11,1,'CASE'),(20,2,'OTHER');
  INSERT INTO inventory.inventory_levels VALUES (10,31),(11,9);
` + ["136_financial_command_results.sql", "140_financial_command_operations.sql", "0727_product_asset_variant_ownership.sql"]
  .map(name => readFileSync(resolve(process.cwd(), "migrations", name), "utf8")).join("\n");
const publicUrl = createCatalogPublicImageUrl({ CATALOG_PUBLIC_BASE_URL: "https://catalog.example.com" });
const now = new Date("2026-10-07T12:00:00Z");
const defaultsFile = "0730_catalog_existing_photo_defaults.sql";
const defaultsSql = readFileSync(resolve(process.cwd(), "migrations", defaultsFile), "utf8");

(url && disposable ? describe : describe.skip).sequential("audited Catalog photo assignment (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  let service: ReturnType<typeof createProductAssetScopeService>;
  let reader: PgCatalogVariantPublicationPhotoReader;
  let ebay: ChannelEbayListingPhotoResolver;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, fixture);
    service = createProductAssetScopeService(drizzle(database.pool, { schema }), () => now);
    reader = new PgCatalogVariantPublicationPhotoReader(database.pool, publicUrl);
    ebay = new ChannelEbayListingPhotoResolver(database.pool, publicUrl);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE public._migrations;
      TRUNCATE public.financial_command_results CASCADE;
      TRUNCATE public.audit_events, catalog.product_assets CASCADE;
      INSERT INTO catalog.product_assets(id,product_id,product_variant_id,url,position,is_primary) VALUES
      (1,1,10,'https://cdn.example.com/front.jpg',0,1),
      (2,1,10,'https://cdn.example.com/back.jpg',1,0),
      (3,2,NULL,'https://cdn.example.com/foreign.jpg',0,1);
      INSERT INTO catalog.product_assets(id,product_id,product_variant_id,position,is_primary,storage_type,mime_type,file_data)
      VALUES (4,1,10,2,0,'file','image/png',decode('89504e470d0a1a0a0000000d49484452','hex'));`);
  });
  function descriptor(assetId: number, command: ProductAssetScopeCommand, key = randomUUID()): FinancialCommandDescriptor {
    const routeTemplate = "/api/products/:id/assets/:assetId/scope", resourceKey = `product:1:asset:${assetId}`;
    return { actorType: "user", actorId: "operator", method: "PUT", routeTemplate, resourceKey,
      idempotencyKey: key, commandName: "catalog.asset.scope", contractVersion: 1,
      requestHash: hashHttpFinancialCommand({ method: "PUT", routeTemplate, resourceKey,
        params: { id: "1", assetId: String(assetId) }, body: command }) };
  }
  function apply(assetId: number, before: number | null, after: number | null) {
    const command = { expectedProductVariantId: before, productVariantId: after };
    return service.apply(1, assetId, command, descriptor(assetId, command));
  }
  async function scopes() {
    return (await database.pool.query("SELECT id,product_id,product_variant_id,url,position,is_primary,storage_type,mime_type,file_data FROM catalog.product_assets ORDER BY id")).rows;
  }
  async function audit() { return (await database.pool.query("SELECT * FROM public.audit_events ORDER BY id")).rows; }
  const request = { productId: 1, channelId: 67, variants: [{ variantId: 10, sku: "PACK" }, { variantId: 11, sku: "CASE" }] };
  async function applyDefaults() {
    const client = await database.pool.connect();
    try {
      await executeMigrationWithRetry({ client, file: defaultsFile, sql: defaultsSql,
        contentHash: createHash("sha256").update(defaultsSql).digest("hex"),
        options: { maxAttempts: 1, retryBaseDelayMs: 0, retryMaxDelayMs: 0, lockTimeoutMs: 2000 } });
    } finally { client.release(); }
  }

  it("initializes every existing image to all variants with exact audit evidence and the same publication resolver", async () => {
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,product_variant_id,asset_type,url,position,is_primary)
      VALUES (5,1,10,'document','https://cdn.example.com/instructions.pdf',3,0)`);
    const before = await scopes();
    await expect(ebay.resolve(request)).rejects.toMatchObject({ code: "EBAY_CATALOG_PHOTO_REQUIRED" });
    await applyDefaults();
    const after = await scopes();
    expect(after.map(row => ({ ...row, product_variant_id: before.find(old => old.id === row.id)!.product_variant_id }))).toEqual(before);
    expect(after.map(row => [row.id, row.product_variant_id])).toEqual([[1,null],[2,null],[3,null],[4,null],[5,10]]);
    const photos = await ebay.resolve(request);
    expect(photos.byVariantId.get(10)).toEqual(photos.byVariantId.get(11));
    expect(photos.byVariantId.get(11)).toEqual([
      "https://cdn.example.com/front.jpg", "https://cdn.example.com/back.jpg", expect.stringContaining("/api/catalog/images/4/"),
    ]);
    expect(photos.groupImageUrls).not.toContain("https://cdn.example.com/foreign.jpg");
    expect(photos.groupImageUrls).not.toContain("https://cdn.example.com/instructions.pdf");
    expect(await audit()).toEqual([1,2,4].map(assetId => expect.objectContaining({
      actor: "migration:0730_catalog_existing_photo_defaults", action: "catalog.asset.shared_default_applied",
      target: `catalog.product_assets:${assetId}`,
      changes: { before: { productId: 1, productVariantId: 10 }, after: { productId: 1, productVariantId: null } },
      context: expect.objectContaining({ migration: defaultsFile }),
    })));
    expect((await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY variant_id")).rows)
      .toEqual([{ variant_id:10,quantity:31 },{ variant_id:11,quantity:9 }]);
    expect((await database.pool.query("SELECT filename FROM public._migrations")).rows).toEqual([{ filename: defaultsFile }]);
  });

  it("preserves deliberate variant choices and allows a new exception after the shared default", async () => {
    await apply(1,10,11);
    await applyDefaults();
    expect((await scopes()).map(row => [row.id, row.product_variant_id])).toEqual([[1,11],[2,null],[3,null],[4,null]]);
    expect((await apply(2,null,10)).httpStatus).toBe(200);
    const photos = await ebay.resolve(request);
    expect(photos.byVariantId.get(10)).not.toContain("https://cdn.example.com/front.jpg");
    expect(photos.byVariantId.get(11)).not.toContain("https://cdn.example.com/back.jpg");
    expect((await apply(4,null,20)).body).toMatchObject({ code: "ASSET_VARIANT_INVALID" });
  });

  it("does not duplicate the migration audit or erase later intentional exceptions when its SQL is replayed", async () => {
    await applyDefaults();
    await apply(1,null,11);
    const before = await scopes(), events = await audit();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(defaultsSql);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    expect(await scopes()).toEqual(before);
    expect(await audit()).toEqual(events);
  });

  it("clears pre-constraint cross-product variant links without moving photos or weakening ownership protection", async () => {
    // Reproduce the legacy state admitted before 0727, then install the real
    // NOT VALID constraint: legacy rows survive but new mistakes are rejected.
    await database.pool.query("ALTER TABLE catalog.product_assets DROP CONSTRAINT product_assets_variant_product_fk");
    await database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,product_variant_id,url,position,is_primary)
      VALUES (6,1,20,'https://cdn.example.com/legacy.jpg',3,0)`);
    await database.pool.query(readFileSync(resolve(process.cwd(), "migrations/0727_product_asset_variant_ownership.sql"), "utf8"));
    await applyDefaults();
    expect((await scopes()).find(row => row.id === 6)).toMatchObject({ product_id:1,product_variant_id:null,url:"https://cdn.example.com/legacy.jpg" });
    const photos = await ebay.resolve(request);
    expect(photos.byVariantId.get(11)).toContain("https://cdn.example.com/legacy.jpg");
    expect(photos.groupImageUrls).not.toContain("https://cdn.example.com/foreign.jpg");
    await expect(database.pool.query(`INSERT INTO catalog.product_assets(id,product_id,product_variant_id,position,is_primary)
      VALUES (7,1,20,4,0)`)).rejects.toMatchObject({ code:"23503" });
  });

  it("rolls back the entire default conversion and release receipt when audit storage fails, then safely retries", async () => {
    const before = await scopes();
    await database.pool.query(`CREATE FUNCTION public.reject_defaults_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'default audit unavailable'; END $$;
      CREATE TRIGGER reject_defaults_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_defaults_audit()`);
    try {
      await expect(applyDefaults()).rejects.toThrow("default audit unavailable");
      expect(await scopes()).toEqual(before);
      expect(await audit()).toEqual([]);
      expect((await database.pool.query("SELECT * FROM public._migrations")).rows).toEqual([]);
    } finally { await database.pool.query("DROP TRIGGER reject_defaults_audit ON public.audit_events; DROP FUNCTION public.reject_defaults_audit()"); }
    await applyDefaults();
    expect((await scopes())[0].product_variant_id).toBe(null);
    expect(await audit()).toHaveLength(3);
  });

  it("serializes a simultaneous stale editor behind the default conversion and returns a conflict", async () => {
    const client = await database.pool.connect();
    let editing: ReturnType<typeof apply> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(defaultsSql);
      editing = apply(1,10,11);
      await vi.waitFor(async () => {
        const waiting = await database.pool.query(`SELECT count(*)::int AS count FROM pg_locks
          WHERE relation = 'catalog.product_assets'::regclass AND mode = 'RowShareLock' AND NOT granted`);
        expect(waiting.rows[0].count).toBe(1);
      }, { timeout:5000,interval:20 });
      await client.query("COMMIT");
      expect(await editing).toMatchObject({ httpStatus:409,body:{ code:"ASSET_SCOPE_CHANGED" } });
      expect((await scopes())[0].product_variant_id).toBe(null);
      expect(await audit()).toHaveLength(3);
    } finally {
      await client.query("ROLLBACK"); client.release();
      // Release the migration lock before awaiting a failed/blocked editor.
      await editing;
    }
  });

  it("makes an existing pack photo shared, then keeps a case photo specific through the one eBay resolver", async () => {
    const before = await scopes();
    await expect(ebay.resolve(request)).rejects.toMatchObject({ code: "EBAY_CATALOG_PHOTO_REQUIRED" });
    expect((await apply(1,10,null)).httpStatus).toBe(200);
    expect((await apply(2,10,11)).httpStatus).toBe(200);
    const plan = await ebay.resolve(request);
    expect(plan.byVariantId.get(10)).toEqual(["https://cdn.example.com/front.jpg", expect.stringContaining("/api/catalog/images/4/")]);
    expect(plan.byVariantId.get(11)).toEqual(["https://cdn.example.com/front.jpg", "https://cdn.example.com/back.jpg"]);
    expect(plan.groupImageUrls).not.toContain("https://cdn.example.com/foreign.jpg");
    const after = await scopes();
    expect(after.map(row => ({ ...row, product_variant_id: before.find(old => old.id === row.id)!.product_variant_id }))).toEqual(before);
    expect(await audit()).toEqual([
      expect.objectContaining({ actor: "user:operator", action: "catalog.asset.scope_changed", timestamp: now,
        changes: { before: { productId: 1, productVariantId: 10 }, after: { productId: 1, productVariantId: null } } }),
      expect.objectContaining({ changes: { before: { productId: 1, productVariantId: 10 }, after: { productId: 1, productVariantId: 11 } } }),
    ]);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_levels ORDER BY variant_id")).rows)
      .toEqual([{ variant_id:10,quantity:31 },{ variant_id:11,quantity:9 }]);
  });
  it("shares stored file bytes without copying the asset or changing its fingerprint", async () => {
    const before = (await reader.listPublicationPhotos({ productVariantIds:[10],maxPhotosPerVariant:12 })).get(10)!.photos.find(photo => photo.assetId === 4)!;
    await apply(4,10,null);
    const photos = await reader.listPublicationPhotos({ productVariantIds:[10,11],maxPhotosPerVariant:12 });
    expect(photos.get(10)!.photos.find(photo => photo.assetId === 4)).toEqual(before);
    expect(photos.get(11)!.photos.find(photo => photo.assetId === 4)).toEqual(before);
    expect(await scopes()).toHaveLength(4);
  });
  it.each([20,999])("rejects foreign or missing variant %s atomically", async target => {
    const before = await scopes();
    expect(await apply(1,10,target)).toMatchObject({ httpStatus:400,body:{ code:"ASSET_VARIANT_INVALID" } });
    expect(await scopes()).toEqual(before); expect(await audit()).toEqual([]);
  });
  it("rejects another product's asset and missing products without changing either owner", async () => {
    expect(await apply(3,null,10)).toMatchObject({ httpStatus:404,body:{ code:"ASSET_NOT_FOUND" } });
    const command = { productVariantId:null, expectedProductVariantId:10 };
    expect(await service.apply(999,1,command,descriptor(1,command))).toMatchObject({ httpStatus:404,body:{ code:"PRODUCT_NOT_FOUND" } });
    expect(await audit()).toEqual([]);
  });
  it("rejects invalid contracts before reserving work", async () => {
    const command = { productVariantId:null, expectedProductVariantId:10 };
    await expect(service.apply(1,1,{ productVariantId:null },descriptor(1,command))).rejects.toMatchObject({ code:"ASSET_SCOPE_INVALID" });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.financial_command_results")).rows[0].count).toBe(0);
  });
  it("does not silently apply a stale snapshot, including a matching destination", async () => {
    await apply(1,10,null);
    expect(await apply(1,10,null)).toMatchObject({ httpStatus:409,body:{ code:"ASSET_SCOPE_CHANGED" } });
    expect(await audit()).toHaveLength(1);
  });
  it("records a no-op receipt without a false change audit", async () => {
    expect(await apply(1,10,10)).toMatchObject({ httpStatus:200,body:{ changed:false } });
    expect(await audit()).toEqual([]);
  });
  it("rejects reuse of one key for a different requested assignment", async () => {
    const first = { productVariantId:null,expectedProductVariantId:10 }, key = randomUUID();
    await service.apply(1,1,first,descriptor(1,first,key));
    const second = { productVariantId:11,expectedProductVariantId:null };
    await expect(service.apply(1,1,second,descriptor(1,second,key))).rejects.toMatchObject({ code:"FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
    expect((await scopes())[0].product_variant_id).toBe(null);
  });
  it("serializes simultaneous editors: one applies and one receives a stale conflict", async () => {
    const responses = await Promise.all([apply(1,10,null),apply(1,10,11)]);
    expect(responses.map(result => result.httpStatus).sort()).toEqual([200,409]);
    expect(await audit()).toHaveLength(1);
  });
  it("concurrent retries create one change and one durable receipt", async () => {
    const command = { productVariantId:null,expectedProductVariantId:10 }, identity = descriptor(1,command);
    const results = await Promise.allSettled([service.apply(1,1,command,identity),service.apply(1,1,command,identity)]);
    const completed = results.filter(result => result.status === "fulfilled");
    expect(completed.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === "rejected") expect(result.reason).toMatchObject({ code:"FINANCIAL_COMMAND_IN_PROGRESS" });
      else expect(result.value.httpStatus).toBe(200);
    }
    expect(await service.apply(1,1,command,identity)).toMatchObject({ replayed:true,httpStatus:200 });
    expect(await audit()).toHaveLength(1);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM public.financial_command_results")).rows[0].count).toBe(1);
  });
  it("a lost response can be recovered after process recreation without overwriting a later edit", async () => {
    const command = { productVariantId:null,expectedProductVariantId:10 }, identity = descriptor(1,command);
    const committed = await service.apply(1,1,command,identity); // Simulate delivery being lost after commit.
    await apply(1,null,11);
    const restarted = createProductAssetScopeService(drizzle(database.pool,{ schema }), () => now);
    expect(await restarted.apply(1,1,command,identity)).toMatchObject({ replayed:true,httpStatus:200,body:committed.body });
    expect((await scopes())[0].product_variant_id).toBe(11);
    expect(await audit()).toHaveLength(2);
  });
  it("rolls back assignment when audit persistence fails, then retries the same command", async () => {
    const command = { productVariantId:null,expectedProductVariantId:10 }, identity = descriptor(1,command), before = await scopes();
    await database.pool.query(`CREATE FUNCTION public.reject_scope_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'audit storage unavailable'; END $$;
      CREATE TRIGGER reject_scope_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_scope_audit();`);
    try {
      await expect(service.apply(1,1,command,identity)).rejects.toThrow("audit storage unavailable");
      expect(await scopes()).toEqual(before); expect(await audit()).toEqual([]);
      expect((await database.pool.query("SELECT status FROM public.financial_command_results")).rows[0].status).toBe("retryable");
    } finally { await database.pool.query("DROP TRIGGER reject_scope_audit ON public.audit_events; DROP FUNCTION public.reject_scope_audit()"); }
    // Respect the existing platform retry backoff instead of rewriting ledger rows.
    await database.pool.query("SELECT pg_sleep(2.1)");
    expect(await service.apply(1,1,command,identity)).toMatchObject({ httpStatus:200,replayed:false });
    expect(await audit()).toHaveLength(1);
  });
  it("rolls back a photo write failure and leaves no audit or success receipt", async () => {
    const before = await scopes();
    await database.pool.query(`CREATE FUNCTION catalog.reject_scope_write() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'photo write unavailable'; END $$;
      CREATE TRIGGER reject_scope_write BEFORE UPDATE ON catalog.product_assets FOR EACH ROW EXECUTE FUNCTION catalog.reject_scope_write();`);
    try {
      await expect(apply(1,10,null)).rejects.toThrow("photo write unavailable");
      expect(await scopes()).toEqual(before); expect(await audit()).toEqual([]);
      expect((await database.pool.query("SELECT status FROM public.financial_command_results")).rows[0].status).toBe("retryable");
    } finally { await database.pool.query("DROP TRIGGER reject_scope_write ON catalog.product_assets; DROP FUNCTION catalog.reject_scope_write()"); }
  });
});
