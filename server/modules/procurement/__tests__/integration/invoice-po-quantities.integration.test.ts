import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { fixtureForeignKeys, fixtureTable, qualifiedTable } from "./shipment-line-fixture";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { logger } from "../../../../platform/observability/logger";

const connection = vi.hoisted(() => ({ database: null as ReturnType<typeof drizzle<typeof schema>> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, { get(_target, property) {
  if (!connection.database) throw new Error("Invoice comparison test database not initialized");
  const value = Reflect.get(connection.database, property);
  return typeof value === "function" ? value.bind(connection.database) : value;
} }) }));
import { getInvoiceById } from "../../ap-ledger.service";

const TEST_URL = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = TEST_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const TABLES = [schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines, schema.vendorInvoices,
  schema.vendorInvoiceLines, schema.vendorInvoicePoLinks, schema.vendorInvoiceAttachments, schema.apPayments, schema.apPaymentAllocations];

databaseTests.sequential("invoice current PO comparison PostgreSQL guarantees", () => {
  let pool: pg.Pool | undefined;
  let ownsProcurement = false;

  beforeAll(async () => {
    if (!TEST_URL) throw new Error("Explicit disposable test database required");
    validatePostgresTestEnvironment(process.env);
    pool = new pg.Pool({ connectionString: TEST_URL, max: 4, ssl: false, statement_timeout: 10000 });
    await pool.query("CREATE SCHEMA procurement");
    ownsProcurement = true;
    for (const table of TABLES) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(TABLES)) await pool.query(statement);
    await pool.query("CREATE UNIQUE INDEX comparison_invoice_po_link_unique ON procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id)");
    connection.database = drizzle(pool, { schema });
  });

  beforeEach(async () => {
    if (!pool || !ownsProcurement) throw new Error("Invoice fixture schema ownership missing");
    await pool.query(`TRUNCATE ${TABLES.map(qualifiedTable).join(",")} RESTART IDENTITY CASCADE`);
    await pool.query(`
      INSERT INTO procurement.vendors(id,code,name) VALUES(5,'COMPARE-VENDOR','Synthetic vendor');
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status,total_cents)
        VALUES(10,'COMPARE-PO',5,'received',1338750);
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,order_qty,received_qty,unit_cost_mills,line_total_cents,status)
        VALUES(21,10,1,'COMPARE-SKU',25000,25000,5023,1338750,'received');
      INSERT INTO procurement.vendor_invoices(id,invoice_number,vendor_id,status,invoiced_amount_cents,paid_amount_cents,balance_cents)
        VALUES(71,'COMPARE-INVOICE',5,'paid',669375,669375,0);
      INSERT INTO procurement.vendor_invoice_po_links(id,vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(73,71,10,669375);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,qty_ordered,qty_received,
        unit_cost_cents,unit_cost_mills,line_total_cents,match_status)
        VALUES(72,71,21,1,12500,12500,12500,50,5023,669375,'qty_discrepancy');
      INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,total_amount_cents)
        VALUES(81,'COMPARE-PAYMENT',5,'2026-05-05','ach',669375);
      INSERT INTO procurement.ap_payment_allocations(id,ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(82,81,71,669375)
    `);
  });

  afterAll(async () => {
    connection.database = null;
    try { if (pool && ownsProcurement) await pool.query("DROP SCHEMA procurement CASCADE"); }
    finally { await pool?.end(); }
  });

  async function financialRecords() {
    if (!pool) throw new Error("Invoice fixture database missing");
    const records: Record<string, unknown[]> = {};
    for (const name of ["vendor_invoices", "vendor_invoice_lines", "vendor_invoice_po_links", "ap_payments", "ap_payment_allocations"]) {
      records[name] = (await pool.query(`SELECT * FROM procurement.${name} ORDER BY id`)).rows;
    }
    return records;
  }

  it("reads current PO counts without changing the billed quantity, historical snapshots, amounts, status or payments", async () => {
    const before = await financialRecords();
    const invoice = await getInvoiceById(71);
    expect(invoice).toMatchObject({ status: "paid", invoicedAmountCents: 669375, paidAmountCents: 669375, balanceCents: 0 });
    expect(invoice?.lines).toEqual([expect.objectContaining({
      id: 72, qtyInvoiced: 12500, qtyOrdered: 12500, qtyReceived: 12500, lineTotalCents: 669375,
      poQuantities: { status: "current", purchaseOrderId: 10, purchaseOrderLineId: 21, orderedQty: 25000, receivedQty: 25000 },
    })]);
    expect(invoice?.payments).toEqual([expect.objectContaining({ apPaymentId: 81, appliedAmountCents: 669375 })]);
    expect(await getInvoiceById(71)).toEqual(invoice);
    expect(await financialRecords()).toEqual(before);
  });

  it("reads corrected and zero PO quantities on the next request without rewriting saved invoice comparisons", async () => {
    const before = await financialRecords();
    await pool!.query("UPDATE procurement.purchase_order_lines SET order_qty=30000,received_qty=0 WHERE id=21");
    expect((await getInvoiceById(71))?.lines[0].poQuantities).toEqual({
      status: "current", purchaseOrderId: 10, purchaseOrderLineId: 21, orderedQty: 30000, receivedQty: 0,
    });
    expect(await financialRecords()).toEqual(before);
  });

  it("preserves the maximum quantity supported by PostgreSQL integer storage", async () => {
    const before = await financialRecords();
    await pool!.query("UPDATE procurement.purchase_order_lines SET order_qty=$1,received_qty=$1 WHERE id=21", [POSTGRES_INTEGER_MAX]);
    expect((await getInvoiceById(71))?.lines[0].poQuantities).toMatchObject({
      orderedQty: POSTGRES_INTEGER_MAX, receivedQty: POSTGRES_INTEGER_MAX,
    });
    expect(await financialRecords()).toEqual(before);
  });

  it("distinguishes a missing PO link from a line that was never linked to a PO", async () => {
    await pool!.query("DELETE FROM procurement.vendor_invoice_po_links WHERE id=73");
    expect((await getInvoiceById(71))?.lines[0].poQuantities).toEqual({ status: "unavailable" });
    await pool!.query("UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=NULL WHERE id=72");
    expect((await getInvoiceById(71))?.lines[0].poQuantities).toEqual({ status: "unlinked" });
  });

  it("compares each invoice line to its exact PO when several linked POs share a SKU and line number", async () => {
    await pool!.query(`
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,status) VALUES(20,'COMPARE-PO-OTHER',5,'sent');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,order_qty,received_qty)
        VALUES(22,20,1,'COMPARE-SKU',40,30);
      INSERT INTO procurement.vendor_invoice_po_links(id,vendor_invoice_id,purchase_order_id,allocated_amount_cents) VALUES(74,71,20,0);
      INSERT INTO procurement.vendor_invoice_lines(id,vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,unit_cost_cents,line_total_cents)
        VALUES(75,71,22,2,40,1,40)
    `);
    const lines = (await getInvoiceById(71))?.lines;
    expect(lines).toHaveLength(2);
    expect(lines?.map((line) => line.poQuantities)).toEqual([
      { status: "current", purchaseOrderId: 10, purchaseOrderLineId: 21, orderedQty: 25000, receivedQty: 25000 },
      { status: "current", purchaseOrderId: 20, purchaseOrderLineId: 22, orderedQty: 40, receivedQty: 30 },
    ]);
  });

  it("reads coherent PO counts before and after a concurrent committed correction", async () => {
    const before = await financialRecords();
    const writer = await pool!.connect();
    let transactionOpen = false;
    try {
      await writer.query("BEGIN"); transactionOpen = true;
      await writer.query("UPDATE procurement.purchase_order_lines SET order_qty=30000,received_qty=20000 WHERE id=21");
      expect((await getInvoiceById(71))?.lines[0].poQuantities).toMatchObject({ orderedQty: 25000, receivedQty: 25000 });
      await writer.query("COMMIT"); transactionOpen = false;
      expect((await getInvoiceById(71))?.lines[0].poQuantities).toMatchObject({ orderedQty: 30000, receivedQty: 20000 });
    } finally {
      if (transactionOpen) await writer.query("ROLLBACK");
      writer.release();
    }
    expect(await financialRecords()).toEqual(before);
  });

  it("rejects invalid PO comparison data without modifying a paid invoice", async () => {
    const before = await financialRecords();
    await pool!.query("UPDATE procurement.purchase_order_lines SET order_qty=-1 WHERE id=21");
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    try {
      await expect(getInvoiceById(71)).rejects.toThrow();
      expect(log).toHaveBeenCalledWith("procurement.invoice_po_quantities_read", expect.objectContaining({
        outcome: "failed", invoice_id: 71, error_code: "AP_INVOICE_PO_QUANTITY_INVALID",
      }));
    } finally { log.mockRestore(); }
    expect(await financialRecords()).toEqual(before);
  });

  it("classifies SQL read failures and propagates them without changing invoice economics", async () => {
    const before = await financialRecords();
    const log = vi.spyOn(logger, "error").mockImplementation(() => {});
    await pool!.query("ALTER TABLE procurement.purchase_order_lines RENAME TO comparison_unavailable");
    try {
      await expect(getInvoiceById(71)).rejects.toThrow();
      expect(log).toHaveBeenCalledWith("procurement.invoice_po_quantities_read", expect.objectContaining({
        outcome: "failed", invoice_id: 71, error_code: "AP_INVOICE_PO_QUANTITY_READ_FAILED",
      }));
    } finally {
      await pool!.query("ALTER TABLE procurement.comparison_unavailable RENAME TO purchase_order_lines");
      log.mockRestore();
    }
    expect(await financialRecords()).toEqual(before);
  });
});
