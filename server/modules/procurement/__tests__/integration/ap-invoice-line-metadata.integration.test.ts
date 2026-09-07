import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

config({ path: resolve(process.cwd(), ".env.test") });
const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = TEST_DB_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const TABLES = [schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.vendorInvoicePoLinks];

databaseTests.sequential("AP invoice line metadata PostgreSQL integrity", () => {
  const actorId = `ap-line-metadata-${randomUUID()}`;
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let modulePool: pg.Pool | undefined;
  let ownsProcurement = false;
  let ownsAudit = false;
  let updateInvoiceLine: typeof import("../../ap-ledger.service").updateInvoiceLine;

  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(TEST_DB_URL!)) {
      throw new Error("AP metadata tests require a separate explicitly disposable database");
    }
    const local = ["127.0.0.1", "localhost"].includes(new URL(TEST_DB_URL!).hostname);
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 6, ssl: local ? false : { rejectUnauthorized: false }, statement_timeout: 10_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement cost fixture owns the schema lease");
    await pool.query("CREATE SCHEMA procurement"); ownsProcurement = true;
    for (const table of TABLES) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await pool.query("CREATE UNIQUE INDEX metadata_invoice_po_link_unique ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id)");
    if (!(await pool.query("SELECT to_regclass('public.audit_events') AS relation")).rows[0].relation) {
      await pool.query(fixtureTable(schema.auditEvents)); ownsAudit = true;
    }
    const priorDatabase = process.env.DATABASE_URL;
    const priorExternal = process.env.EXTERNAL_DATABASE_URL;
    delete process.env.DATABASE_URL; delete process.env.EXTERNAL_DATABASE_URL;
    try {
      const [apModule, dbModule] = await Promise.all([import("../../ap-ledger.service"), import("../../../../db")]);
      modulePool = dbModule.pool;
      // updateInvoiceLine owns its transaction through the legacy module-global
      // Drizzle DB. Forward its transport to this same isolated real SQL pool.
      modulePool.query = pool.query.bind(pool) as any;
      modulePool.connect = pool.connect.bind(pool) as any;
      updateInvoiceLine = apModule.updateInvoiceLine;
    } finally {
      if (priorDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabase;
      if (priorExternal === undefined) delete process.env.EXTERNAL_DATABASE_URL; else process.env.EXTERNAL_DATABASE_URL = priorExternal;
    }
  });

  beforeEach(async () => {
    if (!ownsProcurement) throw new Error("Fixture schema ownership missing");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
    await pool.query(`
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'META-VENDOR','Synthetic vendor');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents,invoiced_total_cents)
        VALUES(10,'META-PO',5,'sent',11800,11800);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,order_qty,
        total_product_cost_cents,packaging_cost_cents,unit_cost_mills,unit_cost_cents,line_total_cents,status)
        VALUES(21,10,1,'META-SKU',150,10000,1800,6667,67,11800,'open');
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,paid_amount_cents,balance_cents)
        VALUES(71,'META-INVOICE',5,'received',11800,0,11800);
      INSERT INTO procurement.vendor_invoice_po_links(id,vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(73,71,10,11800);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,
        unit_cost_cents,unit_cost_mills,line_total_cents,match_status,notes,description)
        VALUES(72,71,21,1,150,67,6667,11800,'matched','Before note','Before description')`);
  });

  afterAll(async () => {
    try {
      if (pool && ownsProcurement) {
        if (ownsAudit) await pool.query("DROP TABLE public.audit_events");
        else await pool.query("DELETE FROM public.audit_events WHERE actor=$1", [actorId]);
        await pool.query("DROP SCHEMA procurement CASCADE");
      }
    } finally {
      if (lease) { await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))"); lease.release(); }
      await pool?.end(); await modulePool?.end();
    }
  });

  async function economics() {
    return (await pool.query(`SELECT qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents,match_status,
      purchase_order_line_id,freight_cost_id FROM procurement.vendor_invoice_lines WHERE id=72`)).rows[0];
  }
  async function relatedState() {
    const result = [];
    for (const table of ["purchase_orders", "purchase_order_lines", "vendor_invoices", "vendor_invoice_po_links"]) {
      result.push((await pool.query(`SELECT * FROM procurement.${table} ORDER BY id`)).rows);
    }
    return result;
  }
  async function fullState() {
    return [await relatedState(), (await pool.query("SELECT * FROM procurement.vendor_invoice_lines ORDER BY id")).rows,
      (await pool.query("SELECT * FROM public.audit_events WHERE actor=$1 ORDER BY id", [actorId])).rows];
  }

  it.each([
    { notes: "  Packing detail checked  " },
    { description: "  Vendor description corrected  " },
    { notes: "Same economics echoed", qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6667 },
    { notes: "Cents-only form echo", unitCostCents: 67 },
  ])("preserves exact imported economics and all related rows for metadata/form echo %j", async (patch) => {
    const beforeEconomics = await economics(); const beforeRelated = await relatedState();
    const result = await updateInvoiceLine(72, patch, actorId);
    expect(await economics()).toEqual(beforeEconomics);
    expect(await relatedState()).toEqual(beforeRelated);
    if (patch.notes !== undefined) expect(result.notes).toBe(patch.notes.trim());
    if (patch.description !== undefined) expect(result.description).toBe(patch.description.trim());
    const audit = (await pool.query("SELECT action,target,context FROM public.audit_events WHERE actor=$1 ORDER BY id", [actorId])).rows;
    expect(audit).toEqual([expect.objectContaining({ action: "ap_ledger.invoice_line_updated", target: "invoice:71",
      context: expect.objectContaining({ economicsChanged: false, affectedPoIds: [], invoiceLineId: 72, economicsBefore: { qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6667, lineTotalCents: 11800, matchStatus: "matched", costComponentEvidence: null }, economicsAfter: { qtyInvoiced: 150, unitCostCents: 67, unitCostMills: 6667, lineTotalCents: 11800, matchStatus: "matched", costComponentEvidence: null } }) })]);
  });

  it.each([{ notes: "Legacy notes correction" }, { notes: "Legacy equivalent mills echo", unitCostMills: 6700 }])("keeps legacy null mills, exact total and match evidence for %j", async (patch) => {
    await pool.query("UPDATE procurement.vendor_invoice_lines SET unit_cost_mills=NULL WHERE id=72");
    const before = await economics(); const beforeRelated = await relatedState();
    await updateInvoiceLine(72, patch, actorId);
    expect(await economics()).toEqual(before);
    expect((await economics()).unit_cost_mills).toBeNull();
    expect(await relatedState()).toEqual(beforeRelated);
  });

  it.each([{ unitCostMills: null }, { unitCostCents: false }, { qtyInvoiced: "" }])(
    "rejects coercible malformed numeric payload %j without any write", async (payload) => {
      const before = await fullState();
      await expect(updateInvoiceLine(72, payload as any, actorId)).rejects.toMatchObject({ statusCode: 400 });
      expect(await fullState()).toEqual(before);
    },
  );
  it("rolls back metadata and its timestamp if immutable AP audit insertion fails", async () => {
    const before = await fullState();
    await pool.query(`CREATE FUNCTION procurement.metadata_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'metadata fixture injected audit failure'; END $$;
      CREATE TRIGGER metadata_audit_fail BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.metadata_audit_fail()`);
    try { await expect(updateInvoiceLine(72, { notes: "Must roll back" }, actorId)).rejects.toThrow(/metadata fixture injected audit failure/); }
    finally { await pool.query("DROP TRIGGER metadata_audit_fail ON public.audit_events; DROP FUNCTION procurement.metadata_audit_fail()"); }
    expect(await fullState()).toEqual(before);
  });

  it("waits for a concurrent invoice status change and rejects metadata once the invoice becomes approved", async () => {
    const holder = await pool.connect(); let open = false;
    let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
    try {
      await holder.query("BEGIN"); open = true;
      const holderPid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await holder.query("SELECT id FROM procurement.vendor_invoices WHERE id=71 FOR UPDATE");
      pending = updateInvoiceLine(72, { notes: "Stale edit" }, actorId).then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
      const deadline = Date.now() + 5_000; let blocked = false;
      while (Date.now() < deadline) {
        blocked = (await pool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked", [holderPid])).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      expect(blocked).toBe(true);
      await holder.query("UPDATE procurement.vendor_invoices SET status='approved' WHERE id=71");
      await holder.query("COMMIT"); open = false;
      expect(await pending).toMatchObject({ ok: false, error: { statusCode: 409, details: { code: "AP_INVOICE_IMMUTABLE" } } });
      expect((await pool.query("SELECT notes FROM procurement.vendor_invoice_lines WHERE id=72")).rows).toEqual([{ notes: "Before note" }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM public.audit_events WHERE actor=$1", [actorId])).rows[0].count).toBe(0);
    } finally { if (open) await holder.query("ROLLBACK"); holder.release(); await pending; }
  });
});
