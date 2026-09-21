import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recomputeOrderStatusFromShipments } from "../../shipment-rollup";
import { projectPhysicalShipmentToWms } from "../../../wms/channel-fulfillment-projection.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe.sequential : describe.skip;
const now = new Date("2026-09-20T12:00:00Z");

// Foreign-owner/current WMS prerequisites. Canonical package/request constraints
// and the effective-quantity view below are loaded from the real migrations.
const prerequisites = `
  CREATE SCHEMA wms; CREATE SCHEMA oms; CREATE SCHEMA catalog; CREATE SCHEMA warehouse;
  CREATE TABLE catalog.product_variants (id integer PRIMARY KEY,
      inventory_tracking_override boolean
    );
  CREATE TABLE warehouse.warehouses (id integer PRIMARY KEY);
  CREATE TABLE oms.oms_orders (id bigint PRIMARY KEY);
  CREATE TABLE oms.oms_order_lines (id bigint PRIMARY KEY, order_id bigint REFERENCES oms.oms_orders(id),
    authority_fulfillable_quantity integer NOT NULL,
      catalog_product_id integer, inventory_tracking boolean
    );
  CREATE TABLE wms.orders (id integer PRIMARY KEY, warehouse_status text NOT NULL,
    picked_count integer NOT NULL DEFAULT 0, completed_at timestamp, updated_at timestamp);
  CREATE TABLE wms.order_items (id integer PRIMARY KEY, order_id integer REFERENCES wms.orders(id),
    oms_order_line_id bigint REFERENCES oms.oms_order_lines(id), quantity integer NOT NULL,
    picked_quantity integer NOT NULL DEFAULT 0, fulfilled_quantity integer NOT NULL DEFAULT 0,
    requires_shipping integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'pending', picked_at timestamp,
      catalog_product_id integer, inventory_tracking boolean
    );
  CREATE TABLE wms.outbound_shipments (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id integer REFERENCES wms.orders(id), shipment_purpose text NOT NULL DEFAULT 'customer_fulfillment',
    source text NOT NULL, status text NOT NULL);
  CREATE TABLE wms.outbound_shipment_items (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shipment_id integer REFERENCES wms.outbound_shipments(id), order_item_id integer REFERENCES wms.order_items(id),
    qty integer NOT NULL, shipment_item_purpose text NOT NULL DEFAULT 'customer_fulfillment');
  CREATE TABLE wms.allocation_exceptions (id integer PRIMARY KEY, order_id integer REFERENCES wms.orders(id),
    status text NOT NULL, resolution text, resolved_at timestamp, updated_at timestamp, metadata jsonb DEFAULT '{}');
`;
const currentItemColumns = `
  ALTER TABLE wms.physical_shipment_items
    ADD COLUMN legacy_wms_shipment_item_id integer REFERENCES wms.outbound_shipment_items(id),
    ADD COLUMN shipment_item_purpose text NOT NULL DEFAULT 'customer_fulfillment',
    ADD COLUMN replacement_for_order_item_id integer REFERENCES wms.order_items(id),
    ADD COLUMN product_variant_id integer REFERENCES catalog.product_variants(id),
    ADD COLUMN sku varchar(100);
`;

suite("physical-line shipping status PostgreSQL guarantees", () => {
  let database: InventoryCutoverTestDatabase;
  let db: ReturnType<typeof drizzle>;
  let labelSequence = 0;
  beforeAll(async () => {
    const migration = (name: string) => readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
    database = await createInventoryCutoverTestDatabase(url, disposable,
      prerequisites + migration("115_fulfillment_canonical_shadow_tables.sql") + currentItemColumns
      + migration("182_physical_shipment_item_quantity_adjustments.sql"));
    db = drizzle(database.pool);
  });
  beforeEach(async () => {
    await database.pool.query(`TRUNCATE wms.orders, oms.oms_orders RESTART IDENTITY CASCADE;
      INSERT INTO oms.oms_orders VALUES (1);
      INSERT INTO wms.orders (id,warehouse_status) VALUES (1,'ready');
      INSERT INTO wms.fulfillment_plans (oms_order_id,wms_order_id) VALUES (1,1);
      INSERT INTO wms.allocation_exceptions (id,order_id,status) VALUES (1,1,'blocked');`);
    labelSequence = 0;
  });
  afterAll(async () => { await database?.close(); });

  async function line(id: number, qty = 2, physical = true) {
    await database.pool.query("INSERT INTO oms.oms_order_lines VALUES ($1,1,$2)", [id, qty]);
    await database.pool.query(`INSERT INTO wms.order_items
      (id,order_id,oms_order_line_id,quantity,requires_shipping) VALUES ($1::integer,1,$1::bigint,$2,$3)`, [id, qty, physical ? 1 : 0]);
    const result = await database.pool.query(`INSERT INTO wms.fulfillment_plan_lines
      (fulfillment_plan_id,oms_order_line_id,wms_order_item_id,sku,quantity_planned)
      SELECT id,$1::bigint,$1::integer,'SKU-' || $1::text,$2 FROM wms.fulfillment_plans WHERE wms_order_id=1 RETURNING id`, [id, qty]);
    return Number(result.rows[0].id);
  }
  async function legacy(itemId: number, qty: number, status = "shipped", source = "shipstation") {
    const shipment = await database.pool.query(`INSERT INTO wms.outbound_shipments (order_id,status,source)
      VALUES (1,$1,$2) RETURNING id`, [status, source]);
    const item = await database.pool.query(`INSERT INTO wms.outbound_shipment_items (shipment_id,order_item_id,qty)
      VALUES ($1,$2,$3) RETURNING id`, [shipment.rows[0].id, itemId, qty]);
    return { shipmentId: Number(shipment.rows[0].id), itemId: Number(item.rows[0].id) };
  }
  async function canonical(itemId: number, qty: number, sourceItemId: number | null = null) {
    let requestItem = sourceItemId ? (await database.pool.query(
      "SELECT id,shipment_request_id FROM wms.shipment_request_items WHERE legacy_wms_shipment_item_id=$1", [sourceItemId])).rows[0] : null;
    const planLine = (await database.pool.query("SELECT * FROM wms.fulfillment_plan_lines WHERE wms_order_item_id=$1", [itemId])).rows[0];
    if (!requestItem) {
      const request = await database.pool.query(`INSERT INTO wms.shipment_requests (fulfillment_plan_id,wms_order_id)
        VALUES ($1,1) RETURNING id`, [planLine.fulfillment_plan_id]);
      requestItem = (await database.pool.query(`INSERT INTO wms.shipment_request_items
        (shipment_request_id,fulfillment_plan_line_id,wms_order_item_id,quantity_requested,legacy_wms_shipment_item_id)
        VALUES ($1,$2,$3,$4,$5) RETURNING id,shipment_request_id`,
      [request.rows[0].id, planLine.id, itemId, planLine.quantity_planned, sourceItemId])).rows[0];
    }
    const packageRow = (await database.pool.query(`INSERT INTO wms.physical_shipments
      (shipment_request_id,provider,provider_physical_shipment_id) VALUES ($1,'shipstation',$2) RETURNING id`,
    [requestItem.shipment_request_id, `test-label-${++labelSequence}`])).rows[0];
    const physical = (await database.pool.query(`INSERT INTO wms.physical_shipment_items
      (physical_shipment_id,shipment_request_item_id,fulfillment_plan_line_id,wms_order_item_id,quantity_shipped,sku)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [packageRow.id, requestItem.id, planLine.id, itemId, qty, planLine.sku])).rows[0];
    return { packageId: Number(packageRow.id), physicalItemId: Number(physical.id) };
  }
  const rollup = () => recomputeOrderStatusFromShipments(db, 1, { now });
  async function status() { return (await database.pool.query("SELECT warehouse_status FROM wms.orders WHERE id=1")).rows[0].warehouse_status; }

  it("never hides #63085-shaped physical demand behind a donation fulfillment", async () => {
    await line(1, 1, false);
    for (const id of [2, 3, 4, 5]) await line(id, 1);
    await legacy(1, 1, "shipped", "shopify_fulfillment_receipt");
    expect(await rollup()).toEqual({ warehouseStatus: "ready", changed: false });
    await database.pool.query("UPDATE wms.orders SET warehouse_status='shipped' WHERE id=1");
    expect(await rollup()).toEqual({ warehouseStatus: "ready", changed: true });
    expect((await database.pool.query("SELECT status FROM wms.allocation_exceptions WHERE id=1")).rows[0].status).toBe("blocked");
    expect((await database.pool.query("SELECT picked_quantity,fulfilled_quantity FROM wms.order_items ORDER BY id")).rows)
      .toEqual(Array.from({ length: 5 }, () => ({ picked_quantity: 0, fulfilled_quantity: 0 })));
  });
  it("covers a split line but does not let extra units cover another line with no package", async () => {
    await line(1); await line(2);
    await legacy(1, 1); await legacy(1, 3);
    expect((await rollup()).warehouseStatus).toBe("partially_shipped");
    await legacy(2, 2);
    expect((await rollup()).warehouseStatus).toBe("shipped");
    expect((await rollup()).changed).toBe(false);
  });
  it.each(["cancelled", "planned", "queued", "labeled", "voided"])("%s packages do not discharge physical demand", async packageStatus => {
    await line(1); await legacy(1, 2, packageStatus);
    expect((await rollup()).warehouseStatus).toBe("ready");
  });
  it("excludes digital, cancelled and refunded quantities but keeps short/backordered quantities", async () => {
    await line(1); await line(2); await line(3, 1, false);
    await legacy(1, 1);
    await database.pool.query("UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=1 WHERE id=1");
    await database.pool.query("UPDATE wms.order_items SET status='short' WHERE id=2");
    expect((await rollup()).warehouseStatus).toBe("partially_shipped");
    await database.pool.query("UPDATE oms.oms_order_lines SET authority_fulfillable_quantity=0 WHERE id=2");
    expect((await rollup()).warehouseStatus).toBe("shipped");
  });
  it("does not count noncustomer replacement packages or another order's package", async () => {
    await line(1); const shipment = await legacy(1, 2);
    await database.pool.query("UPDATE wms.outbound_shipment_items SET shipment_item_purpose='replacement' WHERE id=$1", [shipment.itemId]);
    expect((await rollup()).warehouseStatus).toBe("ready");
    await database.pool.query("INSERT INTO wms.orders (id,warehouse_status) VALUES (2,'ready')");
    await database.pool.query("UPDATE wms.outbound_shipment_items SET shipment_item_purpose='customer_fulfillment' WHERE id=$1", [shipment.itemId]);
    await database.pool.query("UPDATE wms.outbound_shipments SET order_id=2 WHERE id=$1", [shipment.shipmentId]);
    expect((await rollup()).warehouseStatus).toBe("ready");
  });
  it("does not double count canonical package portions and their larger compatibility request", async () => {
    await line(1); const shipment = await legacy(1, 2);
    const first = await canonical(1, 1, shipment.itemId);
    await db.transaction(tx => projectPhysicalShipmentToWms(tx, first.packageId));
    expect(await status()).toBe("partially_shipped");
    expect((await rollup()).warehouseStatus).toBe("partially_shipped");
    const second = await canonical(1, 1, shipment.itemId);
    await db.transaction(tx => projectPhysicalShipmentToWms(tx, second.packageId));
    expect(await status()).toBe("shipped");
    expect((await rollup()).warehouseStatus).toBe("shipped");
  });
  it("a voided canonical package cannot fall back to a stale shipped request", async () => {
    await line(1); const shipment = await legacy(1, 2);
    const physical = await canonical(1, 2, shipment.itemId);
    await database.pool.query("UPDATE wms.physical_shipments SET status='voided' WHERE id=$1", [physical.packageId]);
    expect((await rollup()).warehouseStatus).toBe("ready");
  });
  it("a canonical quantity corrected to zero cannot resurrect its compatibility quantity", async () => {
    await line(1); const shipment = await legacy(1, 2);
    const physical = await canonical(1, 2, shipment.itemId);
    await db.transaction(tx => projectPhysicalShipmentToWms(tx, physical.packageId));
    expect(await status()).toBe("shipped");
    await database.pool.query(`INSERT INTO wms.physical_shipment_item_quantity_adjustments
      (physical_shipment_item_id,quantity_delta,adjustment_kind,repair_run_id,idempotency_key,operator,reason,created_at)
      VALUES ($1,-2,'historical_provider_package_repartition','00000000-0000-0000-0000-000000000001',
        'test-zero','integration-test','Correct over-attributed package',$2)`, [physical.physicalItemId, now]);
    await db.transaction(tx => projectPhysicalShipmentToWms(tx, physical.packageId));
    // An audited shipping correction does not undo actual historical picking.
    expect(await status()).toBe("in_progress");
    expect((await rollup()).warehouseStatus).toBe("in_progress");
    expect((await database.pool.query("SELECT fulfilled_quantity FROM wms.order_items WHERE id=1")).rows[0].fulfilled_quantity).toBe(0);
  });
  it("rejects a historical channel-created physical package through request-item lineage too", async () => {
    await line(1);
    const shipment = await legacy(1, 2, "shipped", "shopify_fulfillment_receipt");
    const physical = await canonical(1, 2, shipment.itemId);
    await db.transaction(tx => projectPhysicalShipmentToWms(tx, physical.packageId));
    expect(await status()).toBe("ready");
    expect((await database.pool.query("SELECT fulfilled_quantity,picked_quantity FROM wms.order_items WHERE id=1")).rows[0])
      .toEqual({ fulfilled_quantity: 0, picked_quantity: 0 });
  });
  it("projecting an old nonshipping package neither picks the donation nor ships physical lines", async () => {
    await line(1, 1, false); await line(2);
    const physical = await canonical(1, 1);
    await db.transaction(tx => projectPhysicalShipmentToWms(tx, physical.packageId));
    expect(await status()).toBe("ready");
    expect((await database.pool.query("SELECT picked_quantity,fulfilled_quantity FROM wms.order_items WHERE id=1")).rows[0])
      .toEqual({ picked_quantity: 0, fulfilled_quantity: 0 });
  });
  it("serializes concurrent completion and rolls back the entire status update on failure", async () => {
    await line(1); await legacy(1, 2);
    const outcomes = await Promise.all([rollup(), rollup()]);
    expect(outcomes.filter(row => row.changed)).toHaveLength(1);
    expect(await status()).toBe("shipped");
    await database.pool.query("UPDATE wms.orders SET warehouse_status='ready',completed_at=NULL WHERE id=1");
    await expect(db.transaction(async tx => { await recomputeOrderStatusFromShipments(tx, 1, { now }); throw new Error("rollback test"); }))
      .rejects.toThrow("rollback test");
    expect(await status()).toBe("ready");
  });
  it("re-reads committed line coverage after waiting on another package projector", async () => {
    await line(1, 1); await line(2, 1);
    const first = await canonical(1, 1); const second = await canonical(2, 1);
    await database.pool.query("UPDATE wms.physical_shipments SET status='voided'");
    const a = await database.pool.connect(); const b = await database.pool.connect();
    let firstOpen = false; let secondOpen = false;
    let pending: Promise<void> | undefined;
    try {
      const aPid = (await a.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const bPid = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await a.query("BEGIN"); firstOpen = true;
      await b.query("BEGIN"); secondOpen = true;
      await a.query("UPDATE wms.physical_shipments SET status='shipped' WHERE id=$1", [first.packageId]);
      await projectPhysicalShipmentToWms(drizzle(a), first.packageId);
      await b.query("UPDATE wms.physical_shipments SET status='shipped' WHERE id=$1", [second.packageId]);
      pending = projectPhysicalShipmentToWms(drizzle(b), second.packageId);
      await expect.poll(async () => (await database.pool.query(
        "SELECT pg_blocking_pids($1) AS blockers", [bPid])).rows[0].blockers).toContain(aPid);
      await a.query("COMMIT"); firstOpen = false;
      await pending;
      await b.query("COMMIT"); secondOpen = false;
      expect(await status()).toBe("shipped");
      expect((await database.pool.query("SELECT fulfilled_quantity FROM wms.order_items ORDER BY id")).rows)
        .toEqual([{ fulfilled_quantity: 1 }, { fulfilled_quantity: 1 }]);
    } finally {
      if (firstOpen) await a.query("ROLLBACK");
      await pending?.catch(() => undefined);
      if (secondOpen) await b.query("ROLLBACK");
      a.release(); b.release();
    }
  });
});
