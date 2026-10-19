import { readFileSync } from "node:fs";
import pg from "pg";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

const TABLES = [schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines,
  schema.vendorInvoices, schema.vendorInvoiceLines, schema.vendorInvoicePoLinks,
  schema.inboundFreightCosts,
  schema.apPayments, schema.apPaymentAllocations, schema.poStatusHistory, schema.poExceptions];
const LEASE = "echelon.procurement.po-financial-refresh";
export const REFRESH_ACTOR = "po-financial-refresh-reviewer";

/** Actual AP transaction owner, schema columns, FKs and precision guards. The
 * legacy module singleton's transport alone is redirected to a private DB. */
export class PoFinancialRefreshFixture {
  pool!: pg.Pool;
  db!: typeof import("../../../../db").db;
  service!: typeof import("../../ap-ledger.service");
  private modulePool?: pg.Pool;
  private lease?: pg.PoolClient;
  private ownsProcurement = false;
  private ownsAudit = false;

  async start(url: string): Promise<void> {
    if (process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true"
      || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) {
      throw new Error("PO financial refresh tests require a separate explicitly disposable LOCAL database");
    }
    this.pool = new pg.Pool({ connectionString: url, ssl: false, max: 8, statement_timeout: 15_000 });
    this.lease = await this.pool.connect();
    const locked = await this.lease.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [LEASE]);
    if (!locked.rows[0].acquired) throw new Error("Another PO financial fixture owns the schema lease");
    await this.pool.query("CREATE SCHEMA procurement");
    this.ownsProcurement = true;
    for (const table of TABLES) await this.pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await this.pool.query(statement);
    await this.pool.query(fixtureTable(schema.auditEvents));
    this.ownsAudit = true;
    await this.pool.query(`
      CREATE UNIQUE INDEX refresh_invoice_number ON procurement.vendor_invoices(vendor_id,invoice_number);
      CREATE UNIQUE INDEX refresh_invoice_po ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id);
      CREATE UNIQUE INDEX refresh_payment_invoice ON procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id);
    `);
    await this.pool.query(readFileSync("migrations/0620_vendor_invoice_unit_cost_mills_repair.sql", "utf8"));
    if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) {
      throw new Error("Application database URLs must be removed before fixture execution");
    }
    const dbModule = await import("../../../../db");
    this.db = dbModule.db;
    this.modulePool = dbModule.pool;
    this.modulePool.query = this.pool.query.bind(this.pool) as typeof this.modulePool.query;
    this.modulePool.connect = this.pool.connect.bind(this.pool) as typeof this.modulePool.connect;
    this.service = await import("../../ap-ledger.service");
  }

  async seed(): Promise<void> {
    if (!this.ownsProcurement || !this.ownsAudit) throw new Error("Fixture ownership missing");
    await this.pool.query("DROP TRIGGER IF EXISTS reject_refresh_audit ON public.audit_events");
    await this.pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await this.pool.query("TRUNCATE public.audit_events RESTART IDENTITY");
    await this.pool.query(`
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'REFRESH-VENDOR','Synthetic vendor');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents)
        VALUES(10,'REFRESH-A',5,'sent',1000),(20,'REFRESH-B',5,'sent',2000),(30,'REFRESH-C',5,'sent',3000);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,order_qty,
        total_product_cost_cents,packaging_cost_cents,unit_cost_cents,unit_cost_mills,line_total_cents,status)
        VALUES(21,10,1,'REFRESH-A',1,1000,0,1000,100000,1000,'open'),
          (22,20,1,'REFRESH-B',1,2000,0,2000,200000,2000,'open'),
          (23,30,1,'REFRESH-C',1,3000,0,3000,300000,3000,'open');
    `);
  }

  async createInvoice(poIds: number[]): Promise<number> {
    const invoice = await this.service.createInvoice({
      invoiceNumber: "REFRESH-COMBINED", vendorId: 5, poIds, createdBy: REFRESH_ACTOR,
    });
    return invoice.id;
  }

  async removeBLine(invoiceId: number): Promise<void> {
    const line = await this.pool.query<{ id: number }>(
      "SELECT id FROM procurement.vendor_invoice_lines WHERE vendor_invoice_id=$1 AND purchase_order_line_id=22", [invoiceId]);
    if (line.rows.length !== 1) throw new Error("Expected exactly one B invoice line");
    await this.service.removeInvoiceLine(line.rows[0].id, REFRESH_ACTOR);
  }

  async amounts(): Promise<Array<{ id: number; invoiced: string; paid: string; outstanding: string }>> {
    return (await this.pool.query<{ id: number; invoiced: string; paid: string; outstanding: string }>(`
      SELECT id,invoiced_total_cents::text AS invoiced,paid_total_cents::text AS paid,
        outstanding_cents::text AS outstanding FROM procurement.purchase_orders ORDER BY id
    `)).rows;
  }

  async snapshot(): Promise<Record<string, unknown[]>> {
    const result: Record<string, unknown[]> = {};
    for (const table of [...TABLES, schema.auditEvents]) {
      result[qualifiedTable(table)] = (await this.pool.query(`SELECT * FROM ${qualifiedTable(table)} ORDER BY id`)).rows;
    }
    return result;
  }

  async waitForBlockedGraphWriters(count: number): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    do {
      const waiting = await this.pool.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock' AND query LIKE '%pg_advisory_xact_lock%'
      `);
      if (waiting.rows[0].count >= count) return true;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    return false;
  }

  async stop(): Promise<void> {
    try {
      if (this.ownsAudit) await this.pool.query("DROP TABLE public.audit_events");
      if (this.ownsProcurement) await this.pool.query("DROP SCHEMA procurement CASCADE");
    } finally {
      if (this.lease) {
        await this.lease.query("SELECT pg_advisory_unlock(hashtext($1))", [LEASE]);
        this.lease.release();
      }
      await this.pool?.end();
      await this.modulePool?.end();
    }
  }
}
