import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { invoiceWorkListQuerySchema, paymentWorkListQuerySchema } from "@shared/procurement/ap-work-list";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const tables = [schema.vendors, schema.vendorInvoices, schema.purchaseOrders, schema.vendorInvoicePoLinks, schema.apPayments, schema.apPaymentAllocations];
databaseTests.sequential("AP work lists with real PostgreSQL", () => {
  let pool: pg.Pool; let modulePool: pg.Pool; let ownsSchema = false;
  let repository: typeof import("../../ap-work-list.repository");
  let poService: typeof import("../../purchase-order-work-list.service");
  const now = new Date("2026-10-18T12:00:00Z");
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(url)) throw new Error("Requires a separate disposable local database");
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 6, statement_timeout: 10000 });
    await pool.query("CREATE SCHEMA procurement"); ownsSchema = true;
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(tables)) await pool.query(statement);
    if (process.env.DATABASE_URL || process.env.EXTERNAL_DATABASE_URL) throw new Error("Unexpected application database URL");
    const dbModule = await import("../../../../db"); modulePool = dbModule.pool;
    modulePool.query = pool.query.bind(pool) as any; modulePool.connect = pool.connect.bind(pool) as any;
    repository = await import("../../ap-work-list.repository");
    poService = await import("../../purchase-order-work-list.service");
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE ${tables.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query(`INSERT INTO procurement.vendors(id,code,name) VALUES (5,'MOST','Large supplier'),(6,'TAIL','Older supplier');
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,balance_cents,created_at,due_date)
      SELECT n,'INV-'||n,CASE WHEN n<=5 THEN 6 ELSE 5 END,'approved',10000,10000,'2026-10-01','2026-10-05' FROM generate_series(1,265) n;
      INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status)
      SELECT n,'PAY-'||n,CASE WHEN n<=5 THEN 6 ELSE 5 END,'2026-10-01','ach',10000,'completed' FROM generate_series(1,265) n;`);
  });
  afterAll(async () => { if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE"); await pool?.end(); await modulePool?.end(); });
  const invoices = (query: Record<string, unknown> = {}) => repository.readInvoiceWorkList(invoiceWorkListQuerySchema.parse(query), now);
  const payments = (query: Record<string, unknown> = {}) => repository.readPaymentWorkList(paymentWorkListQuerySchema.parse(query));

  it("enumerates all 265 invoices with timestamp ties, consistent counts and no duplicates", async () => {
    const ids: number[] = [];
    for (let offset = 0; offset < 300; offset += 50) {
      const page = await invoices({ offset, limit: 50 });
      expect(page.total).toBe(265); expect(page.nextOffset).toBe(offset === 250 ? null : offset + 50);
      ids.push(...page.items.map(item => item.id));
    }
    expect(ids).toEqual(Array.from({ length: 265 }, (_, index) => 265 - index));
  });
  it("enumerates all payments with payment-date ties and a reachable final page", async () => {
    const ids: number[] = [];
    for (let offset = 0; offset < 300; offset += 50) { const page = await payments({ offset }); expect(page.total).toBe(265); ids.push(...page.items.map(item => item.id)); }
    expect(ids).toEqual(Array.from({ length: 265 }, (_, index) => 265 - index));
    expect(await payments({ offset: 500 })).toMatchObject({ items: [], total: 265, nextOffset: null });
  });
  it("filters a supplier before pagination even when all their invoices fall beyond the former 200 cap", async () => {
    const page = await invoices({ vendorId: "6", status: "approved,partially_paid" });
    expect(page.total).toBe(5); expect(page.items.map(item => item.id)).toEqual([5,4,3,2,1]);
    expect((await payments({ vendorId: "6" })).total).toBe(5);
  });
  it("searches invoice, reference, supplier and linked PO evidence before count and paging", async () => {
    await pool.query(`UPDATE procurement.vendor_invoices SET our_reference='Exact reference' WHERE id=1;
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES (1,'PO-needle',6,'received'),(2,'PO-needle-again',6,'received');
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id) VALUES (1,1),(1,2)`);
    expect((await invoices({ search: "inv-1", vendorId: "6" })).items.map(item => item.id)).toEqual([1]);
    expect((await invoices({ search: "REFERENCE" })).total).toBe(1);
    expect((await invoices({ search: "older supplier" })).total).toBe(5);
    const linked = await invoices({ search: "PO-needle" });
    expect(linked.total).toBe(1); expect(linked.items[0].poNumbers).toEqual(["PO-needle", "PO-needle-again"]);
    expect((await invoices({ search: "TAIL" })).total).toBe(5);
  });
  it("treats wildcard characters literally and filters payment references and methods on the server", async () => {
    await pool.query(`UPDATE procurement.vendor_invoices SET our_reference='discount_10%' WHERE id=1;
      UPDATE procurement.ap_payments SET reference_number='bank_10%',check_number='CHK-special',payment_method='check' WHERE id=1`);
    expect((await invoices({ search: "_10%" })).total).toBe(1);
    expect((await payments({ search: "_10%" })).items.map(item => item.id)).toEqual([1]);
    expect((await payments({ search: "CHK-special", paymentMethod: "check" })).total).toBe(1);
    expect((await payments({ search: "CHK-special", paymentMethod: "ach" })).total).toBe(0);
  });
  it("preserves existing overdue and status filtering with an injected clock", async () => {
    await pool.query(`UPDATE procurement.vendor_invoices SET status='disputed' WHERE id=1; UPDATE procurement.vendor_invoices SET due_date='2026-10-20' WHERE id=2`);
    expect((await invoices({ vendorId: "6", overdue: "true" })).items.map(item => item.id)).toEqual([5,4,3]);
    expect((await invoices({ vendorId: "6", status: "disputed" })).items.map(item => item.id)).toEqual([1]);
  });
  it("fails closed when stored money exceeds exact JavaScript integer representation", async () => {
    await pool.query("UPDATE procurement.vendor_invoices SET balance_cents=9007199254740993 WHERE id=265");
    await expect(invoices()).rejects.toThrow();
  });
  it("PO selectors enumerate tied dates beyond 100 with supplier, purpose, exclusions and search counted together", async () => {
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents,created_at)
      SELECT n,'PO-'||n,CASE WHEN n=130 THEN 5 ELSE 6 END,CASE WHEN n IN (2,3,4) THEN 'closed' ELSE 'received' END,10000,'2026-10-01' FROM generate_series(1,130) n`);
    const read = (query: Record<string, unknown>) => poService.getPurchaseOrderWorkList({ vendorId: "6", purpose: "invoice-create", ...query });
    const first = await read({ limit: "100" }); const last = await read({ limit: "100", offset: "100" });
    expect(first.total).toBe(126); expect(last.total).toBe(126);
    expect([...first.items, ...last.items].map(item => item.id)).toEqual(Array.from({length:129}, (_, i) => 129-i).filter(id => ![2,3,4].includes(id)));
    const existing = await read({ purpose: "invoice-link", excludeIds: "129,128", search: "PO-12" });
    expect(existing.total).toBe(9); expect(existing.items.some(item => item.id === 129 || item.id === 128)).toBe(false);
    expect((await read({ purpose: "invoice-link", search: "PO-2" })).items.some(item => item.id === 2)).toBe(true);
    expect((await read({ search: "PO-_" })).total).toBe(0);
  });
  it("shipment PO selection reaches older orders beyond 200 without imposing invoice status or supplier filters", async () => {
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents,created_at)
      SELECT n,'SHIP-PO-'||n,CASE WHEN n=1 THEN 6 ELSE 5 END,CASE WHEN n=1 THEN 'closed' ELSE 'received' END,10000,'2026-10-01' FROM generate_series(1,225) n`);
    const read = (query: Record<string, unknown>) => poService.getPurchaseOrderWorkList({ purpose: "shipment-lines", ...query });
    const final = await read({ offset: "220" });
    expect(final.total).toBe(225); expect(final.items.map(item => item.id)).toEqual([5,4,3,2,1]);
    const searched = await read({ search: "SHIP-PO-1", vendorId: "6" });
    expect(searched.total).toBe(1); expect(searched.items[0]).toMatchObject({ id: 1, status: "closed", vendorId: 6 });
    expect((await read({ search: "no matching order" })).total).toBe(0);
  });
  it("invoice count and page retain one snapshot when a concurrent commit deletes a matching invoice", async () => {
    const connect = modulePool.connect;
    let deleted = false;
    modulePool.connect = (async () => {
      const client = await pool.connect();
      const query = client.query.bind(client); const release = client.release.bind(client);
      client.query = (async (...args: any[]) => {
        const result = await (query as any)(...args);
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (!deleted && text?.includes("count(*)") && text.includes("vendor_invoices")) {
          deleted = true; await pool.query("DELETE FROM procurement.vendor_invoices WHERE id=265");
        }
        return result;
      }) as any;
      client.release = (...args: any[]) => { client.query = query as any; release(...args); };
      return client;
    }) as any;
    try {
      const page = await invoices();
      expect(deleted).toBe(true); expect(page.total).toBe(265); expect(page.items[0].id).toBe(265);
      expect((await pool.query("SELECT count(*)::int AS count FROM procurement.vendor_invoices")).rows[0].count).toBe(264);
    } finally { modulePool.connect = connect; }
  });

  it("shows exact remaining funds from repeated applications and preserves unverified legacy dates", async () => {
    await pool.query(`INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents)
      VALUES(265,265,2000),(265,265,3000);
      UPDATE procurement.ap_payments SET payment_calendar_date='2026-10-01' WHERE id=265`);
    const page = await payments();
    expect(page.items[0]).toMatchObject({ id: 265, paymentCalendarDate: "2026-10-01", paymentDateSource: "recorded_calendar_date",
      paymentBalance: { state: "available", appliedAmountCents: 5000, unappliedAmountCents: 5000 } });
    expect(page.items[1]).toMatchObject({ paymentCalendarDate: null, paymentDateSource: "legacy_timestamp",
      paymentBalance: { state: "available", appliedAmountCents: 0, unappliedAmountCents: 10000 } });
    await pool.query("INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(265,1,1)");
    expect((await payments()).items[0].paymentBalance).toMatchObject({ state: "review_required", appliedAmountCents: null, unappliedAmountCents: null });
  });

  it("reads payment headers and allocation balances from one snapshot during a concurrent application", async () => {
    const connect = modulePool.connect;
    let applied = false;
    modulePool.connect = (async () => {
      const client = await pool.connect();
      const query = client.query.bind(client), release = client.release.bind(client);
      client.query = (async (...args: any[]) => {
        const result = await (query as any)(...args);
        const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
        if (!applied && text?.includes("count(*)") && text.includes("ap_payments")) {
          applied = true;
          await pool.query("INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(265,265,4000)");
        }
        return result;
      }) as any;
      client.release = (...args: any[]) => { client.query = query as any; release(...args); };
      return client;
    }) as any;
    try {
      const page = await payments();
      expect(applied).toBe(true);
      expect(page.items[0].paymentBalance).toMatchObject({ appliedAmountCents: 0, unappliedAmountCents: 10000 });
    } finally { modulePool.connect = connect; }
    expect((await payments()).items[0].paymentBalance).toMatchObject({ appliedAmountCents: 4000, unappliedAmountCents: 6000 });
  });

});
