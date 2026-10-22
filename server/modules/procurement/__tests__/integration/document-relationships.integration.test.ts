import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, type Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { inboundShipments, inboundShipmentLines, purchaseOrders, purchaseOrderLines, receivingOrders, receivingLines,
  inboundFreightCosts, inboundFreightAllocations, supplierCreditLines, supplierCredits, vendorInvoiceLines, vendorInvoices } from "@shared/schema";
import { createDocumentRelationshipRepository } from "../../document-relationships.repository";
import { projectDocumentRelationships } from "@shared/procurement/document-relationships";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
suite.sequential("document relationship read model against PostgreSQL", () => {
  let pool: pg.Pool;
  let ownsSchema = false;
  beforeAll(async () => {
    if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) throw new Error("Requires an isolated local disposable database");
    pool = new pg.Pool({ connectionString: url, max: 3, statement_timeout: 10000 });
    await pool.query("CREATE SCHEMA procurement");
    ownsSchema = true;
    for (const table of [inboundShipments, inboundShipmentLines, purchaseOrders, purchaseOrderLines, receivingOrders, receivingLines,
      inboundFreightCosts, inboundFreightAllocations, supplierCreditLines, supplierCredits, vendorInvoiceLines, vendorInvoices]) {
      const config = getTableConfig(table);
      const columns = Object.values(getTableColumns(table as Table)).map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`);
      await pool.query(`CREATE TABLE "${config.schema}"."${config.name}" (${columns.join(",")})`);
    }
    await pool.query(`INSERT INTO procurement.purchase_orders(id,po_number) VALUES (17,'TEST-PO-17'),(99,'TEST-PO-99');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,sku,product_name,order_qty) VALUES
        (101,17,1,'SAME','Sleeves',200000),(102,99,1,'SAME','Sleeves',50000);
      INSERT INTO procurement.inbound_shipments(id,shipment_number,status) VALUES (42,'TEST-SHIP-42','closed'),(43,'TEST-SHIP-43','booked');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,sku,qty_shipped) VALUES
        (201,42,17,101,'SAME',100000),(202,42,99,102,'SAME',50000),(203,43,NULL,101,'SAME',100000);
      INSERT INTO procurement.receiving_orders(id,receipt_number,status,purchase_order_id,inbound_shipment_id) VALUES
        (31,'TEST-RCV-31','closed',17,42),(32,'TEST-RCV-32','closed',17,42);
      INSERT INTO procurement.receiving_lines(id,receiving_order_id,purchase_order_line_id,inbound_shipment_line_id,sku,received_qty,reversed_qty,units_per_variant_snapshot) VALUES
        (301,31,101,201,'SAME',60,0,1000),(302,32,101,201,'SAME',40,0,1000);
      INSERT INTO procurement.inbound_freight_costs(id,inbound_shipment_id,cost_type,currency,actual_cents) VALUES (401,42,'freight','USD',10001);
      INSERT INTO procurement.inbound_freight_allocations(id,shipment_cost_id,inbound_shipment_line_id,allocated_cents) VALUES
        (501,401,201,6001),(502,401,202,4000);`);
  });
  afterAll(async () => {
    if (!pool) return;
    try { if (ownsSchema) await pool.query("DROP SCHEMA procurement CASCADE"); }
    finally { await pool.end(); }
  });
  it("returns identical scoped shares from PO, shipment and receipt roots without multiplying partial receipts", async () => {
    const repository = createDocumentRelationshipRepository(drizzle(pool));
    for (const root of [{ kind: "purchase", id: 17 }, { kind: "shipment", id: 42 }, { kind: "receipt", id: 31 }] as const) {
      const data = await repository.read(root); expect(data).not.toBeNull();
      const shipment = projectDocumentRelationships(data!).find(row => row.shipment.id === 42)!;
      expect(shipment.groups.map(group => group.costs.amounts[0].cents)).toEqual([6001, 4000]);
      expect(shipment.groups[0].lines[0].receipts).toHaveLength(2);
      expect(shipment.allocationIncomplete).toBe(false);
    }
    const purchase = await repository.read({ kind: "purchase", id: 17 });
    expect(purchase!.shipments.map(row => row.id)).toEqual([42, 43]);
    expect(await repository.read({ kind: "shipment", id: 999 })).toBeNull();
  });
  it("does not mix a concurrent cost edit into an already-open document snapshot", async () => {
    const db = drizzle(pool); let changed = false;
    const repository = createDocumentRelationshipRepository({ execute: query => db.execute(query),
      transaction: (read, options) => db.transaction(tx => read({ execute: async query => {
        const result = await tx.execute(query);
        if (!changed) { changed = true; await pool.query("UPDATE procurement.inbound_freight_costs SET actual_cents=10002 WHERE id=401"); }
        return result;
      } }), options) });
    const before = await repository.read({ kind: "shipment", id: 42 });
    expect(before!.charges[0].cents).toBe(10001);
    const after = await createDocumentRelationshipRepository(db).read({ kind: "shipment", id: 42 });
    expect(after!.charges[0].cents).toBe(10002);
    expect(projectDocumentRelationships(after!)[0].allocationIncomplete).toBe(true);
  });
  it("refreshes the ordered quantity everywhere after a saved PO edit without rewriting shipped or received counts", async () => {
    await pool.query("UPDATE procurement.purchase_order_lines SET order_qty=250000 WHERE id=101");
    const repository = createDocumentRelationshipRepository(drizzle(pool));
    for (const root of [{ kind: "purchase", id: 17 }, { kind: "shipment", id: 42 }, { kind: "receipt", id: 31 }] as const) {
      const data = await repository.read(root);
      const row = projectDocumentRelationships(data!)[0].groups[0].lines[0];
      expect(row.owner.purchaseLine!.orderedPieces).toBe(250000);
      expect(row.line.shippedPieces).toBe(100000);
      expect(row.receipts.map(line => line.receivedUnits)).toEqual([60, 40]);
      expect(row.costs.amounts[0].cents).toBe(6001);
    }
  });
});
