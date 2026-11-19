import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { identityAdministrationFixtureSql } from "../../../identity/__tests__/fixtures/identity-administration.fixture";
const connection = vi.hoisted(() => ({ database: null as NodePgDatabase<typeof schema> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, { get(_target,key) {
  if (!connection.database) throw new Error("Synthetic shipment fixture not ready");
  const value = Reflect.get(connection.database,key); return typeof value === "function" ? value.bind(connection.database) : value;
} }) }));
import { registerOutboundShipmentRoutes } from "../../../shipping-engine/outbound-shipments.routes";
import { queryShipmentOrderContext, withShipmentAccess } from "../../outbound-shipment-access.query";
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;
const fixture = identityAdministrationFixtureSql + `
  CREATE SCHEMA channels; CREATE TABLE channels.channels(id integer PRIMARY KEY,name text);
  CREATE SCHEMA wms;
  CREATE TABLE wms.orders(id integer PRIMARY KEY,order_number text NOT NULL,customer_name text NOT NULL,warehouse_status text NOT NULL,on_hold integer NOT NULL);
  CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders(id),sku text NOT NULL,name text NOT NULL,quantity integer NOT NULL,picked_quantity integer NOT NULL,status text NOT NULL);
  CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY,order_id integer REFERENCES wms.orders(id),channel_id integer REFERENCES channels.channels(id),
    status text NOT NULL,carrier text,tracking_number text,tracking_url text,shipped_at timestamp,created_at timestamp NOT NULL DEFAULT now(),carrier_cost_cents bigint);
  INSERT INTO channels.channels VALUES(1,'Synthetic channel');
  INSERT INTO wms.orders VALUES(10,'SYNTHETIC-10','Synthetic recipient','shipped',0),(20,'UNRELATED-20','Unrelated recipient','ready',0);
  INSERT INTO wms.order_items VALUES(101,10,'SKU-A','Synthetic item',3,3,'completed'),(201,20,'UNRELATED','Must not be returned',1,0,'pending');
  INSERT INTO wms.outbound_shipments(id,order_id,channel_id,status,carrier,tracking_number,shipped_at,carrier_cost_cents)
    VALUES(1,10,1,'shipped','usps','TRACK-TEST',now(),1234),(2,NULL,1,'planned',NULL,NULL,NULL,0);
  INSERT INTO identity.auth_permissions(resource,action,category) VALUES
    ('shipments','view','shipping'),('shipments','view_costs','shipping'),('shipments','view_order_context','shipping');
  INSERT INTO identity.users(id,username,password,role) VALUES('shipment-reader','shipment-reader','unused-synthetic-password','admin');
  INSERT INTO identity.auth_roles(id,name) OVERRIDING SYSTEM VALUE VALUES(1,'Custom shipment access');
  INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('shipment-reader',1);
`;
integration("configured shipment access and bounded order context", () => {
  let database: InventoryCutoverTestDatabase, server: Server, baseUrl: string;
  let loggedIn = true; const queries: string[] = [];
  async function request(url: string) {
    const response = await requestLocalHttp(url);
    // Keep the raw JSON shape: schema stripping here could conceal a data leak.
    const body = await response.json() as { rows?: Array<Record<string,unknown>>; order?: Record<string,unknown> | null };
    return { status: response.status, body };
  }
  async function grants(keys: string[]) {
    await database.pool.query("DELETE FROM identity.auth_role_permissions");
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT 1,id FROM identity.auth_permissions WHERE resource || ':' || action = ANY($1::text[])",[keys]);
  }
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl,true,fixture);
    connection.database = drizzle(database.pool,{ schema,logger: { logQuery(query) { queries.push(query); } } });
    const app = express(); app.use(express.json());
    app.use((req,_res,next) => { req.session = { user: loggedIn ? { id: "shipment-reader" } : undefined } as typeof req.session; next(); });
    registerOutboundShipmentRoutes(app); server = createServer(app);
    await new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(0,"127.0.0.1",resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    try { if (server?.listening) await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
    finally { connection.database = null; await database?.close(); }
  });
  beforeEach(async () => { loggedIn = true; queries.length = 0; await database.pool.query("UPDATE identity.users SET active=1"); await grants(["shipments:view"]); });
  it("allows a custom shipment reader while omitting and not selecting carrier cost", async () => {
    const response = await request(baseUrl+"/api/outbound-shipments");
    expect(response.status).toBe(200); expect(response.body.rows!).toHaveLength(2);
    expect(response.body.rows!.every((row: Record<string,unknown>) => !("carrierCostCents" in row))).toBe(true);
    expect(queries.some(query => query.includes("carrier_cost_cents"))).toBe(false);
  });
  it("requires a separate cost grant and preserves exact integer cents", async () => {
    await grants(["shipments:view","shipments:view_costs"]);
    const response = await request(baseUrl+"/api/outbound-shipments");
    expect(response.status).toBe(200); expect(response.body.rows!.find(row => row.id === 1)!.carrierCostCents).toBe(1234);
  });
  it.each([{ keys: [] },{ keys: ["orders:view"] },{ keys: ["shipments:view_costs"] },{ keys: ["shipments:view_order_context"] }])("denies incomplete/adjacent grants %#", async ({ keys }) => {
    await grants(keys); expect((await request(baseUrl+"/api/outbound-shipments")).status).toBe(403);
  });
  it("denies context without its explicit grant, including direct query entry", async () => {
    expect((await request(baseUrl+"/api/outbound-shipments/1/order-context")).status).toBe(403);
    await expect(queryShipmentOrderContext("shipment-reader",1)).rejects.toMatchObject({ status: 403 });
  });
  it("returns only the exact shipment's read-only order context, without money or unrelated order", async () => {
    await grants(["shipments:view","shipments:view_order_context"]);
    const response = await request(baseUrl+"/api/outbound-shipments/1/order-context");
    expect(response.status).toBe(200); expect(response.body.order!.orderNumber).toBe("SYNTHETIC-10");
    expect(response.body.order!.items).toEqual([{ id: 101,sku: "SKU-A",name: "Synthetic item",quantity: 3,pickedQuantity: 3,status: "completed" }]);
    expect(Object.keys(response.body.order!).sort()).toEqual(["customerName","hasMoreItems","items","onHold","orderNumber","warehouseStatus"]);
    expect(JSON.stringify(response.body)).not.toContain("UNRELATED");
    expect(queries.some(query => query.includes("carrier_cost_cents"))).toBe(false);
  });
  it("handles absent and unlinked shipments without fabricating order evidence", async () => {
    await grants(["shipments:view","shipments:view_order_context"]);
    expect((await request(baseUrl+"/api/outbound-shipments/999/order-context")).status).toBe(404);
    expect((await request(baseUrl+"/api/outbound-shipments/2/order-context")).body.order).toBeNull();
    expect((await request(baseUrl+"/api/outbound-shipments/1x/order-context")).status).toBe(400);
  });
  it("bounds a large order and explicitly reports omitted items", async () => {
    await grants(["shipments:view","shipments:view_order_context"]);
    await database.pool.query("INSERT INTO wms.order_items SELECT i,10,'SKU-'||i,'Synthetic bounded item',1,0,'pending' FROM generate_series(1000,1200) AS i");
    try {
      const response = await request(baseUrl+"/api/outbound-shipments/1/order-context");
      expect(response.status).toBe(200); expect(response.body.order!.items).toHaveLength(200); expect(response.body.order!.hasMoreItems).toBe(true);
    } finally { await database.pool.query("DELETE FROM wms.order_items WHERE id>=1000"); }
  });
  it("does not promote a scoped or JSON-null cost grant", async () => {
    await grants(["shipments:view","shipments:view_costs"]);
    await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='null'::jsonb WHERE permission_id=(SELECT id FROM identity.auth_permissions WHERE resource='shipments' AND action='view_costs')");
    const response = await request(baseUrl+"/api/outbound-shipments");
    expect(response.status).toBe(200); expect(JSON.stringify(response.body)).not.toContain("carrierCostCents");
  });
  it("denies inactive and revoked saved sessions", async () => {
    await database.pool.query("UPDATE identity.users SET active=0");
    expect((await request(baseUrl+"/api/outbound-shipments")).status).toBe(403);
    await database.pool.query("UPDATE identity.users SET active=1"); await grants([]);
    expect((await request(baseUrl+"/api/outbound-shipments")).status).toBe(403);
  });
  it("does not mutate shipment state or create audit events on reads", async () => {
    const before = (await database.pool.query("SELECT * FROM wms.outbound_shipments ORDER BY id")).rows;
    await request(baseUrl+"/api/outbound-shipments");
    expect((await database.pool.query("SELECT * FROM wms.outbound_shipments ORDER BY id")).rows).toEqual(before);
    expect((await database.pool.query("SELECT * FROM public.audit_events")).rows).toEqual([]);
  });
  it("keeps query count constant as the requested page grows",async () => {
    queries.length = 0;
    const first = await request(baseUrl+"/api/outbound-shipments?pageSize=1");
    expect(first.status).toBe(200); expect(first.body.rows!).toHaveLength(1);
    const count = queries.length; queries.length = 0;
    const second = await request(baseUrl+"/api/outbound-shipments?pageSize=200");
    expect(second.status).toBe(200); expect(second.body.rows!).toHaveLength(2);
    expect(queries.length).toBe(count);
  });
  it("orders concurrent revocation after the authorized query and denies the following query",async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered=resolve; });
    const held = new Promise<void>(resolve => { release=resolve; });
    const read = withShipmentAccess("shipment-reader","shipments:view",async () => { entered(); await held; return "authorized"; });
    const client = await database.pool.connect(); let mutation: Promise<unknown> | undefined;
    try {
      await ready;
      const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      mutation = client.query("DELETE FROM identity.auth_role_permissions WHERE role_id=1");
      const deadline = Date.now()+5000; let blocked=false;
      while(Date.now()<deadline) {
        const state = await database.pool.query<{ wait_event_type: string }>("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",[pid]);
        if(state.rows[0]?.wait_event_type === "Lock") { blocked=true; break; }
        await new Promise(resolve => setTimeout(resolve,10));
      }
      expect(blocked).toBe(true); release(); expect(await read).toBe("authorized"); await mutation;
      await expect(withShipmentAccess("shipment-reader","shipments:view",async () => "denied")).rejects.toMatchObject({ status: 403 });
    } finally { release(); await Promise.allSettled([read,...(mutation?[mutation]:[])]); client.release(); }
  });

});
