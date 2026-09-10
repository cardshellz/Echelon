import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns, type Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { inboundShipmentLines, purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { readShipmentPurchaseOrders } from "../../shipment-purchase-orders.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;

function fixtureTable(table: Parameters<typeof getTableConfig>[0], keys: readonly string[]): string {
  const definition = getTableConfig(table);
  const columns = getTableColumns(table as Table);
  const definitions = keys.map((key) => {
    const column = columns[key];
    if (!column) throw new Error(`Unknown fixture column ${definition.name}.${key}`);
    return `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`;
  });
  return `CREATE TABLE "${definition.schema}"."${definition.name}" (${definitions.join(", ")})`;
}

suite.sequential("shipment purchase references against canonical PostgreSQL columns", () => {
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;

  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) {
      throw new Error("Shipment purchase reference integration requires a separate local disposable database");
    }
    pool = new pg.Pool({ connectionString: url, max: 1, statement_timeout: 10_000 });
    client = await pool.connect();
    await client.query("BEGIN");
    // All fixture DDL/data are rolled back, and an existing schema is never replaced.
    await client.query("CREATE SCHEMA procurement");
    await client.query(fixtureTable(purchaseOrders, ["id", "poNumber"]));
    await client.query(fixtureTable(purchaseOrderLines, ["id", "purchaseOrderId"]));
    await client.query(fixtureTable(inboundShipmentLines, ["id", "inboundShipmentId", "purchaseOrderId", "purchaseOrderLineId"]));
    await client.query("INSERT INTO procurement.purchase_orders (id, po_number) VALUES (17, 'TEST-PO-17'), (99, 'TEST-PO-99')");
    await client.query("INSERT INTO procurement.purchase_order_lines (id, purchase_order_id) VALUES (101, 17), (102, 99)");
    await client.query(`INSERT INTO procurement.inbound_shipment_lines (id, inbound_shipment_id, purchase_order_id, purchase_order_line_id) VALUES
      (1, 41, 17, 101),
      (2, 42, 17, 101), (3, 42, 17, 101), (4, 42, 99, 102),
      (5, 43, 17, 101),
      (6, 44, NULL, NULL),
      (7, 45, NULL, 102),
      (8, 46, 17, 102)`);
  });

  afterAll(async () => {
    try { if (client) await client.query("ROLLBACK"); }
    finally { client?.release(); await pool?.end(); }
  });

  it("preserves single, consolidated, split and unlinked relationships without duplicate POs", async () => {
    const references = await readShipmentPurchaseOrders(drizzle(client!), [41, 42, 43, 44]);
    expect(references).toEqual(new Map([
      [41, [{ id: 17, poNumber: "TEST-PO-17" }]],
      [42, [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }]],
      [43, [{ id: 17, poNumber: "TEST-PO-17" }]],
      [44, []],
    ]));
  });

  it("retains a PO-line-only association and does not hide conflicting source references", async () => {
    expect(await readShipmentPurchaseOrders(drizzle(client!), [45, 46])).toEqual(new Map([
      [45, [{ id: 99, poNumber: "TEST-PO-99" }]],
      [46, [{ id: 17, poNumber: "TEST-PO-17" }, { id: 99, poNumber: "TEST-PO-99" }]],
    ]));
  });

  it("does not return relationships from another page", async () => {
    expect(await readShipmentPurchaseOrders(drizzle(client!), [43])).toEqual(new Map([
      [43, [{ id: 17, poNumber: "TEST-PO-17" }]],
    ]));
  });
});
