import { resolve } from "node:path";
import { config } from "dotenv";
import { getTableColumns, sql, type Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { createPurchaseWorkspaceRepository, PURCHASE_WORKSPACE_RECORD_LIMIT } from "../../purchase-workspace.repository";
import { createPurchaseWorkspaceService } from "../../purchase-workspace.service";

config({ path: resolve(process.cwd(), ".env.test") });
const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseTests = TEST_DB_URL && disposable ? describe : describe.skip;

// Build the selected fixture columns from the real Drizzle schema, so a
// misspelled/stale query column cannot be hidden by a matching handwritten DDL.
function fixtureTable(table: Parameters<typeof getTableConfig>[0], keys: readonly string[]): string {
  const definition = getTableConfig(table);
  const columns = getTableColumns(table as Table);
  const selected = keys.map((key) => {
    const column = columns[key];
    if (!column) throw new Error(`Unknown fixture column ${definition.name}.${key}`);
    return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE "${definition.schema}"."${definition.name}" (${selected.join(", ")})`;
}

databaseTests.sequential("purchase workspace PostgreSQL read model", () => {
  let pool: pg.Pool;
  let ownsSchema = false;
  let database: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter(Boolean).includes(TEST_DB_URL!)) {
      throw new Error("Workspace integration requires a separate explicitly disposable database.");
    }
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      ssl: /localhost|127\.0\.0\.1/.test(TEST_DB_URL!) ? false : { rejectUnauthorized: false },
    });
    await pool.query("CREATE SCHEMA procurement");
    ownsSchema = true;
    const tables = [
      fixtureTable(schema.vendors, ["id", "name"]),
      fixtureTable(schema.purchaseOrders, ["id", "poNumber", "vendorId", "status", "physicalStatus", "financialStatus", "currency", "totalCents", "invoicedTotalCents", "paidTotalCents", "outstandingCents", "expectedDeliveryDate", "confirmedDeliveryDate", "actualDeliveryDate"]),
      fixtureTable(schema.purchaseOrderLines, ["id", "purchaseOrderId", "lineNumber", "sku", "productName", "lineType", "orderQty", "receivedQty", "cancelledQty"]),
      fixtureTable(schema.receivingOrders, ["id", "receiptNumber", "status", "purchaseOrderId", "inboundShipmentId", "expectedDate", "receivedDate", "closedDate", "createdAt"]),
      fixtureTable(schema.receivingLines, ["id", "receivingOrderId", "purchaseOrderLineId"]),
      fixtureTable(schema.poReceipts, ["id", "receivingOrderId", "purchaseOrderId"]),
      fixtureTable(schema.inboundShipments, ["id", "shipmentNumber", "status", "mode", "containerNumber", "eta", "deliveredDate", "estimatedTotalCostCents", "actualTotalCostCents", "createdAt"]),
      fixtureTable(schema.inboundShipmentLines, ["id", "inboundShipmentId", "purchaseOrderId", "purchaseOrderLineId", "sku", "qtyShipped", "allocatedCostCents"]),
      fixtureTable(schema.vendorInvoices, ["id", "invoiceNumber", "status", "currency", "invoiceDate", "dueDate", "inboundShipmentId", "invoicedAmountCents", "paidAmountCents", "balanceCents"]),
      fixtureTable(schema.vendorInvoicePoLinks, ["id", "vendorInvoiceId", "purchaseOrderId", "allocatedAmountCents"]),
      fixtureTable(schema.inboundFreightCosts, ["id", "inboundShipmentId", "vendorInvoiceId"]),
    ];
    for (const ddl of tables) await pool.query(ddl);
    await pool.query(`
      INSERT INTO procurement.vendors(id,name) VALUES (1,'Fixture supplier');
      INSERT INTO procurement.purchase_orders
        (id,po_number,vendor_id,status,physical_status,financial_status,currency,total_cents,invoiced_total_cents,paid_total_cents,outstanding_cents,expected_delivery_date)
        VALUES (1,'PO-001',1,'sent','sent','partially_paid','USD',100000,40000,20000,20000,'2026-10-01'),
               (2,'PO-002',1,'sent','sent','unbilled','USD',60000,0,0,0,NULL);
      INSERT INTO procurement.purchase_order_lines
        (id,purchase_order_id,line_number,sku,product_name,line_type,order_qty,received_qty,cancelled_qty)
        VALUES (11,1,1,'SKU-A','Product A','product',100,25,0),
               (12,1,2,NULL,'Fee','fee',1,0,0),
               (21,2,1,'SKU-B','Product B','product',50,0,0);
      INSERT INTO procurement.inbound_shipments
        (id,shipment_number,status,mode,container_number,eta,estimated_total_cost_cents,actual_total_cost_cents,created_at)
        VALUES (7,'SHIP-007','in_transit','ocean','CONT-7','2026-10-03',9000,NULL,'2026-09-01'),
               (8,'SHIP-008','cancelled','ocean',NULL,NULL,NULL,0,'2026-09-02'),
               (9,'UNRELATED','draft',NULL,NULL,NULL,NULL,NULL,'2026-09-03');
      INSERT INTO procurement.inbound_shipment_lines
        (id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,sku,qty_shipped,allocated_cost_cents)
        VALUES (71,7,1,11,'SKU-A',60,5400),(72,7,2,21,'SKU-B',50,3600),
               (73,7,NULL,NULL,'UNKNOWN',5,NULL),(81,8,1,11,'SKU-A',40,NULL);
      INSERT INTO procurement.receiving_orders
        (id,receipt_number,status,purchase_order_id,inbound_shipment_id,created_at)
        VALUES (31,'RCV-DRAFT','draft',1,7,'2026-09-01'),
               (32,'RCV-CANCELLED','cancelled',1,8,'2026-09-02'),
               (33,'RCV-LEGACY','closed',NULL,NULL,'2026-09-03'),
               (34,'RCV-LINE-LINK','open',NULL,NULL,'2026-09-04'),
               (35,'RCV-OTHER-PO','draft',2,7,'2026-09-05'),
               (99,'UNRELATED','draft',NULL,9,'2026-09-06');
      INSERT INTO procurement.po_receipts (id,receiving_order_id,purchase_order_id) VALUES (331,33,1);
      INSERT INTO procurement.receiving_lines (id,receiving_order_id,purchase_order_line_id) VALUES (341,34,11);
      INSERT INTO procurement.vendor_invoices
        (id,invoice_number,status,currency,invoice_date,inbound_shipment_id,invoiced_amount_cents,paid_amount_cents,balance_cents)
        VALUES (41,'INV-SHARED','partially_paid','USD','2026-09-01',7,100000,50000,50000),
               (42,'INV-FREIGHT','received','USD','2026-09-02',NULL,9000,0,9000),
               (43,'INV-VOID','voided','USD','2026-09-03',NULL,-1000,0,0),
               (99,'INV-UNRELATED','received','USD','2026-09-04',9,9999,0,9999);
      INSERT INTO procurement.vendor_invoice_po_links (id,vendor_invoice_id,purchase_order_id,allocated_amount_cents)
        VALUES (411,41,1,40000),(412,41,2,60000),(431,43,1,NULL);
      INSERT INTO procurement.inbound_freight_costs (id,inbound_shipment_id,vendor_invoice_id) VALUES (421,7,42),(422,7,41);
    `);
    database = drizzle(pool, { schema });
  });

  afterAll(async () => {
    if (pool) {
      if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE");
      await pool.end();
    }
  });

  const workspace = () => createPurchaseWorkspaceService(createPurchaseWorkspaceRepository(database)).getPurchaseWorkspace(1);

  it("executes the real bounded SQL and retains draft, cancelled and legacy receipt relationships", async () => {
    const result = await workspace();
    expect(result.shipments.map((record) => record.id)).toEqual([7, 8]);
    expect(result.receipts.map((record) => record.id).sort()).toEqual([31, 32, 33, 34, 35]);
    expect(result.receipts.find((record) => record.id === 31)?.status).toBe("draft");
    expect(result.receipts.find((record) => record.id === 32)?.status).toBe("cancelled");
    expect(result.edges.filter((edge) => edge.relationship === "purchase_receipt").map((edge) => edge.to.id).sort()).toEqual([31, 32, 33, 34]);
    expect(result.edges).toContainEqual({ from: { kind: "shipment", id: 7 }, to: { kind: "receipt", id: 35 }, relationship: "shipment_receipt" });
    expect(result.purchase.lines.map((line) => line.quantityBasis)).toEqual(["pieces", "not_applicable"]);
    expect(result.purchase.expectedDeliveryDate).toMatch(/^2026-10-01T/);
  });

  it("keeps split/shared shipment lines and invoice costs at their recorded document scope", async () => {
    const result = await workspace();
    const shared = result.shipments.find((record) => record.id === 7)!;
    expect(shared.purchaseOrderIds).toEqual([1, 2]);
    expect(shared.unlinkedLineCount).toBe(1);
    expect(shared.lines.map((line) => line.qtyShipped)).toEqual([60, 50, 5]);
    expect(shared.estimatedTotalCostCents).toBe(9000);
    expect(shared.actualTotalCostCents).toBeNull();
    expect(result.invoices.map((invoice) => invoice.id)).toEqual([41, 42, 43]);
    expect(result.invoices[0]).toMatchObject({ invoicedAmountCents: 100000, paidAmountCents: 50000, allocatedToPurchaseCents: 40000, amountScope: "whole_invoice", purchaseOrderIds: [1, 2] });
    expect(result.invoices[1].allocatedToPurchaseCents).toBeNull();
    expect(result.invoices[2]).toMatchObject({ status: "voided", invoicedAmountCents: -1000 });
    expect(result.edges.filter((edge) => edge.relationship === "shipment_invoice" && edge.to.id === 41)).toHaveLength(1);
    expect(result.edges.some((edge) => edge.relationship === "purchase_invoice" && edge.to.id === 42)).toBe(false);
    expect(result.purchase.paidTotalCents).toBe(20000);
  });

  it("uses a real read-only repeatable-read transaction", async () => {
    let observed: Record<string, unknown> | undefined;
    const repository = createPurchaseWorkspaceRepository({
      transaction: (callback, options) => database.transaction(async (tx) => {
        observed = (await tx.execute(sql`SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation`)).rows[0];
        return callback(tx);
      }, options),
    });
    await repository.read(1);
    expect(observed).toEqual({ readonly: "on", isolation: "repeatable read" });
  });

  it("fails rather than rounding an unsafe PostgreSQL bigint", async () => {
    await pool.query("UPDATE procurement.purchase_orders SET total_cents=9007199254740993 WHERE id=1");
    try {
      await expect(workspace()).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_MONEY_INVALID", statusCode: 500 });
    } finally {
      await pool.query("UPDATE procurement.purchase_orders SET total_cents=100000 WHERE id=1");
    }
  });

  it("preserves missing and zero amounts as different values", async () => {
    await pool.query("UPDATE procurement.purchase_orders SET total_cents=NULL WHERE id=1");
    try {
      const result = await workspace();
      expect(result.purchase.totalCents).toBeNull();
      expect(result.shipments.find((shipment) => shipment.id === 8)?.actualTotalCostCents).toBe(0);
    } finally {
      await pool.query("UPDATE procurement.purchase_orders SET total_cents=100000 WHERE id=1");
    }
  });

  it("rejects oversized history explicitly instead of returning partial records", async () => {
    await pool.query(`
      INSERT INTO procurement.receiving_orders(id,receipt_number,status,purchase_order_id)
      SELECT 10000+n, 'LIMIT-' || n, 'draft', 1 FROM generate_series(1,$1::int) n
    `, [PURCHASE_WORKSPACE_RECORD_LIMIT + 1]);
    try {
      await expect(workspace()).rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_TOO_LARGE", statusCode: 422 });
    } finally {
      await pool.query("DELETE FROM procurement.receiving_orders WHERE id>=10000");
    }
  });

  it("returns not found for an absent purchase without reading an unrelated graph", async () => {
    await expect(createPurchaseWorkspaceService(createPurchaseWorkspaceRepository(database)).getPurchaseWorkspace(987654))
      .rejects.toMatchObject({ code: "PURCHASE_WORKSPACE_NOT_FOUND", statusCode: 404 });
  });
});
