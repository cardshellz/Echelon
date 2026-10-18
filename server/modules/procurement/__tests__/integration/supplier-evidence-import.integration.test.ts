import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable } from "./shipment-line-fixture";
import { createPurchasingService, type PurchasingService } from "../../purchasing.service";
import { buildSupplierEvidenceImportPreview, type SupplierEvidenceImportPreview,
  type SupplierEvidenceImportRow } from "../../supplier-evidence-import.service";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW = new Date("2026-10-18T12:00:00.000Z");
const ACTOR = "supplier-import-reviewer";
const tables = [schema.vendors, schema.products, schema.productVariants, schema.vendorProducts];

/** Real catalog owner, database locks, schema constraints and audit writes. No application singleton DB is used. */
databaseTests.sequential("reviewed supplier import PostgreSQL atomicity", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let service: PurchasingService;
  let ownsProcurement = false;
  let ownsCatalog = false;
  let ownsAudit = false;

  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
      [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) {
      throw new Error("Supplier import tests require a separate explicitly disposable LOCAL database");
    }
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 6, statement_timeout: 10_000 });
    db = drizzle(pool, { schema });
    await pool.query("CREATE SCHEMA procurement"); ownsProcurement = true;
    await pool.query("CREATE SCHEMA catalog"); ownsCatalog = true;
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    await pool.query(fixtureTable(schema.auditEvents)); ownsAudit = true;
    await pool.query(`CREATE UNIQUE INDEX vendor_products_vendor_product_variant_key_uidx
      ON procurement.vendor_products(vendor_id,product_id,COALESCE(product_variant_id,0));
      CREATE UNIQUE INDEX vendor_products_one_active_preferred_key_uidx
      ON procurement.vendor_products(product_id,COALESCE(product_variant_id,0)) WHERE is_active=1 AND is_preferred=1;`);
    for (const constraint of getTableConfig(schema.vendorProducts).checks) {
      const sql = new PgDialect().sqlToQuery(constraint.value);
      if (sql.params.length) throw new Error("Fixture constraint must have no parameters");
      await pool.query(`ALTER TABLE procurement.vendor_products ADD CONSTRAINT "${constraint.name}" CHECK (${sql.sql})`);
    }
    service = createPurchasingService(db, {} as Parameters<typeof createPurchasingService>[1], { now: () => NOW });
  });

  beforeEach(async () => {
    await pool.query("DROP TRIGGER IF EXISTS fail_supplier_import_audit ON public.audit_events");
    await pool.query(`TRUNCATE procurement.vendor_products, procurement.vendors, catalog.products,
      catalog.product_variants, public.audit_events RESTART IDENTITY CASCADE;
      INSERT INTO procurement.vendors(id,code,name,active) VALUES(7,'TEST-A','Test Supplier A',1),(8,'TEST-B','Test Supplier B',1);
      INSERT INTO catalog.products(id,sku,name,is_active) VALUES(10,'TEST-10','Test product 10',true),(20,'TEST-20','Test product 20',true);
      INSERT INTO procurement.vendor_products(vendor_id,product_id,unit_cost_cents,unit_cost_mills,pricing_basis,
        quoted_unit_cost_mills,quoted_at,quote_reference,is_preferred,updated_at)
      VALUES(7,10,100,10000,'per_piece',10000,'2026-10-17','ORIGINAL-10',1,'2026-10-17'),
        (7,20,200,20000,'per_piece',20000,'2026-10-17','ORIGINAL-20',1,'2026-10-17');`);
  });

  afterAll(async () => {
    if (!pool) return;
    if (ownsAudit) await pool.query("DROP TABLE public.audit_events");
    if (ownsProcurement) await pool.query("DROP SCHEMA procurement CASCADE");
    if (ownsCatalog) await pool.query("DROP SCHEMA catalog CASCADE");
    await pool.query("DROP FUNCTION IF EXISTS public.reject_supplier_import_audit()");
    await pool.end();
  });

  function row(productId = 10): SupplierEvidenceImportRow {
    return { sku: `TEST-${productId}`, vendorSku: `SUP-${productId}`, pricingBasis: "per_piece",
      quotedUnitCost: "3.2500", quotedAt: new Date("2026-10-18T10:00:00Z"), quoteReference: "REVIEWED-QUOTE",
      quoteValidUntil: "2026-11-18", moqPieces: 1, leadTimeDays: 5, isPreferred: true };
  }
  async function preview(rows: SupplierEvidenceImportRow[] = [row()]): Promise<SupplierEvidenceImportPreview> {
    return buildSupplierEvidenceImportPreview({ vendorId: 7, rows, dependencies: {
      getVendorById: async (id) => (await db.select().from(schema.vendors).where(eq(schema.vendors.id, id)))[0],
      getAllProducts: () => db.select().from(schema.products),
      getAllProductVariants: () => db.select().from(schema.productVariants),
      getVendorProductsByProductIds: (ids) => db.select().from(schema.vendorProducts).where(inArray(schema.vendorProducts.productId, ids)),
      now: () => NOW,
    } });
  }
  function apply(review: SupplierEvidenceImportPreview, owner = service) {
    return owner.applyReviewedSupplierEvidenceImport(7, review.catalogEntries, review.catalogStateFingerprint, ACTOR);
  }
  async function snapshot(): Promise<unknown[]> {
    return [ (await pool.query("SELECT * FROM procurement.vendor_products ORDER BY id")).rows,
      (await pool.query("SELECT * FROM public.audit_events ORDER BY id")).rows ];
  }
  async function waitBlocked(pid: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if ((await pool.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0].blocked) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Import did not block on the held catalog owner transaction");
  }

  async function race(review: SupplierEvidenceImportPreview,
    change: (tx: NodePgDatabase<typeof schema>) => Promise<unknown>) {
    const holder = await pool.connect();
    const importer = await pool.connect();
    let holderOpen = false;
    let outcome: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined;
    try {
      await holder.query("BEGIN"); holderOpen = true;
      await change(drizzle(holder, { schema }));
      const importerPid = Number((await importer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const importing = createPurchasingService(drizzle(importer, { schema }), {} as Parameters<typeof createPurchasingService>[1], { now: () => NOW });
      outcome = apply(review, importing).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      await waitBlocked(importerPid);
      await holder.query("COMMIT"); holderOpen = false;
      const result = await outcome;
      expect(result).toMatchObject({ ok: false, error: { statusCode: 409, details: { code: "SUPPLIER_EVIDENCE_PREVIEW_STALE" } } });
      expect((await pool.query("SELECT count(*)::integer AS count FROM public.audit_events WHERE actor=$1", [`user:${ACTOR}`])).rows[0].count).toBe(0);
      return snapshot();
    } finally {
      if (holderOpen) await holder.query("ROLLBACK");
      await outcome;
      importer.release(); holder.release();
    }
  }

  it("applies unchanged reviewed quotes and preference changes atomically, retaining audit before/after", async () => {
    const review = await preview([row(10), row(20)]);
    const result = await apply(review);
    expect(result.updated).toHaveLength(2);
    const rows = (await pool.query("SELECT unit_cost_mills::text AS cost,quote_reference FROM procurement.vendor_products ORDER BY id")).rows;
    expect(rows).toEqual([{ cost: "32500", quote_reference: "REVIEWED-QUOTE" }, { cost: "32500", quote_reference: "REVIEWED-QUOTE" }]);
    const audits = (await pool.query("SELECT actor,changes FROM public.audit_events ORDER BY id")).rows;
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({ actor: `user:${ACTOR}`, changes: { before: { unitCostMills: "10000" }, after: { unitCostMills: 32500 } } });
    const after = await snapshot();
    await expect(apply(review)).rejects.toMatchObject({ details: { code: "SUPPLIER_EVIDENCE_PREVIEW_STALE" } });
    expect(await snapshot()).toEqual(after);
  });

  it("rejects a quote committed while Apply waits, without partial writes to the earlier batch row", async () => {
    const review = await preview([row(10), row(20)]);
    await race(review, tx => service.bulkUpsertVendorCatalog(7, [{ productId: 20, unitCostMills: 99000 }], "other-reviewer", tx));
    expect((await pool.query("SELECT product_id,unit_cost_mills::text AS cost FROM procurement.vendor_products ORDER BY product_id")).rows)
      .toEqual([{ product_id: 10, cost: "10000" }, { product_id: 20, cost: "99000" }]);
    expect((await pool.query("SELECT actor,action FROM public.audit_events")).rows)
      .toEqual([{ actor: "user:other-reviewer", action: "vendor_catalog.updated" }]);
    const fresh = await preview([row(10), row(20)]);
    expect(fresh.previewHash).not.toBe(review.previewHash);
    expect((await apply(fresh)).updated).toHaveLength(2);
  });

  it("rejects a newly preferred competing supplier committed after review", async () => {
    const review = await preview();
    await race(review, tx => service.bulkUpsertVendorCatalog(8, [{ productId: 10, unitCostMills: 88000, isPreferred: true }], "other-reviewer", tx));
    expect((await pool.query("SELECT vendor_id,is_preferred,unit_cost_mills::text AS cost FROM procurement.vendor_products WHERE product_id=10 ORDER BY vendor_id")).rows)
      .toEqual([{ vendor_id: 7, is_preferred: 0, cost: "10000" }, { vendor_id: 8, is_preferred: 1, cost: "88000" }]);
    expect((await pool.query("SELECT action FROM public.audit_events ORDER BY id")).rows)
      .toEqual([{ action: "vendor_catalog.preferred_demoted" }, { action: "vendor_catalog.created" }]);
    const fresh = await preview();
    expect(fresh.items[0].willDemoteVendorProductIds).toHaveLength(1);
    await apply(fresh);
    expect((await pool.query("SELECT vendor_id FROM procurement.vendor_products WHERE product_id=10 AND is_preferred=1")).rows)
      .toEqual([{ vendor_id: 7 }]);
  });

  it("rejects creation of an absent reviewed target while Apply waits", async () => {
    await pool.query("DELETE FROM procurement.vendor_products WHERE product_id=10");
    const review = await preview();
    expect(review.items[0].action).toBe("create");
    await race(review, tx => service.bulkUpsertVendorCatalog(7, [{ productId: 10, unitCostMills: 44000 }], "other-reviewer", tx));
    expect((await pool.query("SELECT unit_cost_mills::text AS cost FROM procurement.vendor_products WHERE product_id=10")).rows)
      .toEqual([{ cost: "44000" }]);
  });

  it("rolls back catalog updates and preferred demotions when audit persistence fails", async () => {
    await service.bulkUpsertVendorCatalog(8, [{ productId: 10, unitCostMills: 88000, isPreferred: true }], "other-reviewer");
    const review = await preview([row(10), row(20)]);
    const before = await snapshot();
    await pool.query(`CREATE OR REPLACE FUNCTION public.reject_supplier_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.actor='user:supplier-import-reviewer' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_supplier_import_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_supplier_import_audit();`);
    await expect(apply(review)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
