import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { inboundShipments, inboundShipmentLines, purchaseOrderLines, purchaseOrders } from "@shared/schema";
import { getTableConfig } from "drizzle-orm/pg-core";
import { readShipmentList, countShipmentList } from "../../shipment-work-list.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
suite.sequential("shipment work-list real PostgreSQL predicates and page boundaries", () => {
  let pool: pg.Pool | undefined, client: pg.PoolClient | undefined;
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL,process.env.EXTERNAL_DATABASE_URL].includes(url)) throw new Error("Requires a separate local disposable PostgreSQL database");
    pool = new pg.Pool({connectionString:url,max:1,statement_timeout:10_000});
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("CREATE SCHEMA procurement");
    const columns = Object.values(getTableColumns(inboundShipments)).map(column =>
      `"${column.name}" ${column.getSQLType()}${column.primary ? " PRIMARY KEY" : ""}`);
    await client.query(`CREATE TABLE procurement.inbound_shipments (${columns.join(", ")})`);
    for (const table of [inboundShipmentLines, purchaseOrderLines, purchaseOrders]) {
      const fields = Object.values(getTableColumns(table)).map(column => `"${column.name}" ${column.getSQLType()}`);
      await client.query(`CREATE TABLE procurement.${getTableConfig(table).name} (${fields.join(",")})`);
    }
    await client.query(`INSERT INTO procurement.purchase_orders(id,po_number) VALUES (17,'SEARCH-PO-17');
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,sku) VALUES (101,17,'PO-SKU');
      INSERT INTO procurement.inbound_shipment_lines(id,inbound_shipment_id,purchase_order_id,purchase_order_line_id,sku) VALUES
        (1,1,17,101,'SEARCH-SKU'),(2,1,17,101,'SEARCH-SKU'),(3,3,NULL,101,'SEARCH-SKU')`);
    await client.query(`INSERT INTO procurement.inbound_shipments
      (id,shipment_number,status,mode,warehouse_id,carrier_name,container_number,created_at,updated_at)
      SELECT n,'SHP-'||n,CASE WHEN n%2=0 THEN 'cancelled' WHEN n=1 THEN 'closed' ELSE 'booked' END,
        CASE WHEN n%3=0 THEN 'air' ELSE 'sea_fcl' END, CASE WHEN n%3=0 THEN 2 ELSE 1 END,
        CASE WHEN n<=3 THEN 'Old carrier needle' ELSE 'Standard carrier' END,
        CASE WHEN n=1 THEN '100%_literal' ELSE 'CONTAINER-'||n END,'2026-10-18 00:00:00','2026-10-18 00:00:00'
      FROM generate_series(1,205) n`);
  });
  afterAll(async () => { try { if(client) await client.query("ROLLBACK"); } finally {client?.release();await pool?.end();} });
  it("retains all 205 timestamp-tied rows across boundaries with stable descending ID order", async () => {
    const db=drizzle(client!);
    const first=await readShipmentList(db,{limit:100,offset:0});
    const second=await readShipmentList(db,{limit:100,offset:100});
    const last=await readShipmentList(db,{limit:100,offset:200});
    expect(first.map(row=>row.id)).toEqual(Array.from({length:100},(_,i)=>205-i));
    expect(second.map(row=>row.id)).toEqual(Array.from({length:100},(_,i)=>105-i));
    expect(last.map(row=>row.id)).toEqual([5,4,3,2,1]);
    expect(new Set([...first,...second,...last].map(row=>row.id)).size).toBe(205);
    expect(await countShipmentList(db)).toBe(205);
  });
  it("filters cancelled records before paging while preserving closed active records", async () => {
    const db=drizzle(client!);
    const rows=await readShipmentList(db,{status:"active",limit:100,offset:100});
    expect(rows.map(row=>row.id)).toEqual([5,3,1]);
    expect(rows[2].status).toBe("closed");
    expect(await countShipmentList(db,{status:"active"})).toBe(103);
  });
  it("searches beyond the first100 and shares matching totals with the requested page", async () => {
    const db=drizzle(client!);
    const query={search:"NEEDLE",status:"active" as const,limit:1,offset:1};
    expect((await readShipmentList(db,query)).map(row=>row.id)).toEqual([1]);
    expect(await countShipmentList(db,query)).toBe(2);
  });
  it("combines mode, status, warehouse and search before counting and paging", async () => {
    const db=drizzle(client!),query={mode:"air" as const,status:["booked" as const],warehouseId:2,search:"needle",limit:50,offset:0};
    expect((await readShipmentList(db,query)).map(row=>row.id)).toEqual([3]);
    expect(await countShipmentList(db,query)).toBe(1);
  });
  it("treats SQL wildcard characters as literal search text", async () => {
    const db=drizzle(client!);
    expect((await readShipmentList(db,{search:"100%_"})).map(row=>row.id)).toEqual([1]);
    expect(await countShipmentList(db,{search:"100%_"})).toBe(1);
    expect(await countShipmentList(db,{search:"' OR 1=1 --"})).toBe(0);
  });
  it("searches PO numbers and SKUs without duplicate shipments and includes PO-line-only links", async () => {
    const db = drizzle(client!);
    for (const search of ["SEARCH-PO-17", "SEARCH-SKU", "PO-SKU"]) {
      expect((await readShipmentList(db, { search })).map(row => row.id)).toEqual([3, 1]);
      expect(await countShipmentList(db, { search })).toBe(2);
    }
  });
  it("returns a successful empty requested page without losing its matching total", async () => {
    const db=drizzle(client!);
    expect(await readShipmentList(db,{status:"active",offset:500,limit:50})).toEqual([]);
    expect(await countShipmentList(db,{status:"active",offset:500,limit:50})).toBe(103);
  });
});
