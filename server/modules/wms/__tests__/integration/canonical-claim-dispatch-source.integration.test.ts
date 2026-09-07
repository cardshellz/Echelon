import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalClaimDispatchCommand } from "@shared/types/inventory-availability-dispatch";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../canonical-claim-dispatch-source";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const owner = new WmsCanonicalClaimDispatchSourceOwner();
function command(physical = false): CanonicalClaimDispatchCommand {
  return { claimId: "10", orderId: 70, orderItemId: 71, warehouseId: 1, warehouseLocationId: 50,
    productVariantId: 105, outboundShipmentId: 90, sourceShipmentItemId: 101,
    physicalShipmentId: physical ? "700" : null, physicalShipmentItemId: physical ? "701" : null,
    quantity: "3", idempotencyKey: "source-test", actor: "source-test", reason: "Exact source dispatch test" };
}

/** Real owner queries/locks plus migration182 correction trigger; reduced WMS schema, not full migration proof. */
describeDatabase.sequential("WMS canonical dispatch source PostgreSQL owner", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable); pool = database.pool;
    await pool.query(`CREATE SCHEMA wms;
      CREATE TABLE wms.orders (id integer PRIMARY KEY, warehouse_id integer, warehouse_status text, on_hold integer, cancelled_at timestamptz);
      CREATE TABLE wms.order_items (id integer PRIMARY KEY, order_id integer REFERENCES wms.orders(id), product_id integer, status text, on_hold boolean, requires_shipping integer);
      CREATE TABLE wms.outbound_shipments (id integer PRIMARY KEY, order_id integer REFERENCES wms.orders(id), status text, held boolean, requires_review boolean,
        shipment_purpose text, replaces_shipment_id integer, cancelled_at timestamptz, voided_at timestamptz);
      CREATE TABLE wms.outbound_shipment_items (id integer PRIMARY KEY, shipment_id integer REFERENCES wms.outbound_shipments(id), order_item_id integer REFERENCES wms.order_items(id),
        product_variant_id integer, qty integer, from_location_id integer, shipment_item_purpose text, replacement_for_order_item_id integer,
        correction_for_shipment_item_id integer, provider_membership_state text);
      CREATE TABLE wms.physical_shipments (id bigint PRIMARY KEY, status text);
      CREATE TABLE wms.physical_shipment_items (id bigint PRIMARY KEY, physical_shipment_id bigint REFERENCES wms.physical_shipments(id),
        shipment_request_item_id bigint, fulfillment_plan_line_id bigint, legacy_wms_shipment_item_id integer UNIQUE REFERENCES wms.outbound_shipment_items(id),
        wms_order_item_id integer, product_variant_id integer, quantity_shipped integer, shipment_item_purpose text, replacement_for_order_item_id integer,
        correction_for_physical_shipment_item_id bigint, package_allocation_entry_id bigint, sku text, provider_physical_shipment_line_id text,
        provider_order_line_id text, created_at timestamptz);
    `);
    await pool.query(readFileSync("migrations/182_physical_shipment_item_quantity_adjustments.sql", "utf8"));
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE wms.physical_shipment_item_quantity_adjustments,wms.physical_shipment_items,wms.physical_shipments,
      wms.outbound_shipment_items,wms.outbound_shipments,wms.order_items,wms.orders;
      INSERT INTO wms.orders VALUES (70,1,'ready_to_ship',0,NULL);
      INSERT INTO wms.order_items VALUES (71,70,105,'completed',false,1);
      INSERT INTO wms.outbound_shipments VALUES (90,70,'shipped',false,false,'customer_fulfillment',NULL,NULL,NULL);
      INSERT INTO wms.outbound_shipment_items VALUES (101,90,71,105,3,50,'customer_fulfillment',NULL,NULL,'authoritative');
    `);
  });
  afterAll(async () => { await database?.close(); });

  async function read(input = command()) {
    const client = await pool.connect();
    try { await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
      const result = await owner.lockDispatchSource({ client, command: input }); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async function insertPhysical() {
    await pool.query(`INSERT INTO wms.physical_shipments VALUES (700,'shipped');
      INSERT INTO wms.physical_shipment_items (id,physical_shipment_id,legacy_wms_shipment_item_id,wms_order_item_id,product_variant_id,
        quantity_shipped,shipment_item_purpose,sku,created_at) VALUES (701,700,101,71,105,3,'customer_fulfillment','P5',NOW())`);
  }
  async function snapshot() {
    const snapshots: unknown[] = [];
    for (const table of ["orders", "order_items", "outbound_shipments", "outbound_shipment_items", "physical_shipments", "physical_shipment_items"]) {
      snapshots.push((await pool.query(`SELECT to_jsonb(row) AS value FROM wms.${table} row ORDER BY id`)).rows);
    }
    return snapshots;
  }

  it("reads and locks exact shipped source without changing any owner rows", async () => {
    const before = await snapshot(); expect(await read()).toMatchObject({ readiness: "authorized", quantity: "3", physicalShipmentItemId: null });
    expect(await snapshot()).toEqual(before);
  });
  it("requires persisted bin identity and never reads inventory/primary-location fallbacks", async () => {
    await pool.query("UPDATE wms.outbound_shipment_items SET from_location_id=NULL WHERE id=101");
    await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_IDENTITY_MISMATCH" });
  });
  it.each([99, null])("accepts legacy base-product/null hint %s without weakening exact source identity", async (productId) => {
    await pool.query("UPDATE wms.order_items SET product_id=$1 WHERE id=71", [productId]);
    expect(await read()).toMatchObject({ productVariantId: 105 });
    await pool.query("UPDATE wms.outbound_shipment_items SET product_variant_id=99 WHERE id=101");
    await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_IDENTITY_MISMATCH" });
  });
  it("rejects labels, source holds and cancellation flags", async () => {
    await pool.query("UPDATE wms.outbound_shipments SET status='labeled' WHERE id=90");
    await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_NOT_AUTHORIZED" });
    await pool.query("UPDATE wms.outbound_shipments SET status='shipped',held=true WHERE id=90");
    await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_HELD" });
    await pool.query("UPDATE wms.outbound_shipments SET held=false WHERE id=90");
    await pool.query("UPDATE wms.orders SET cancelled_at=NOW() WHERE id=70");
    await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_CANCELLED" });
  });
  it("binds known physical identity instead of silently accepting omitted command IDs", async () => {
    await insertPhysical(); await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CONFLICT" });
    expect(await read(command(true))).toMatchObject({ physicalShipmentId: "700", physicalShipmentItemId: "701", physicalShipmentItemQuantity: "3" });
  });
  it("blocks an actual immutable quantity correction, including zero effective physical quantity", async () => {
    await insertPhysical();
    await pool.query(`INSERT INTO wms.physical_shipment_item_quantity_adjustments
      (physical_shipment_item_id,quantity_delta,adjustment_kind,repair_run_id,idempotency_key,operator,reason,created_at)
      VALUES (701,-3,'historical_provider_package_repartition','00000000-0000-4000-8000-000000000001','source-test','test','test',NOW())`);
    expect((await pool.query("SELECT * FROM wms.effective_physical_shipment_items WHERE id=701")).rows).toHaveLength(0);
    await expect(read(command(true))).rejects.toMatchObject({ code: "WMS_DISPATCH_PHYSICAL_CORRECTION" });
  });
  it.each([
    ["source quantity", "UPDATE wms.outbound_shipment_items SET qty=2 WHERE id=101", "WMS_DISPATCH_QUANTITY_MISMATCH"],
    ["order hold", "UPDATE wms.orders SET on_hold=1 WHERE id=70", "WMS_DISPATCH_HELD"],
  ])("aborts a stale serializable snapshot after concurrent %s change and rejects it on fresh retry", async (_name, sql, expectedCode) => {
    const client = await pool.connect();
    let resume: () => void = () => {};
    let captured: () => void = () => {};
    const snapshotCaptured = new Promise<void>((resolve) => { captured = resolve; });
    const continueAfterSnapshot = new Promise<void>((resolve) => { resume = resolve; });
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
      const wrapped = { query: async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (text.includes("current_setting")) { captured(); await continueAfterSnapshot; }
        return result;
      } };
      const pending = owner.lockDispatchSource({ client: wrapped, command: command() });
      const checked = expect(pending).rejects.toMatchObject({ code: "40001" });
      await snapshotCaptured; await pool.query(sql); resume(); await checked;
      await client.query("ROLLBACK"); await expect(read()).rejects.toMatchObject({ code: expectedCode });
    } finally { resume(); await client.query("ROLLBACK"); client.release(); }
  });
  it("holds the source row until the caller ends its transaction", async () => {
    const reader = await pool.connect(); const writer = await pool.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ WRITE");
      await owner.lockDispatchSource({ client: reader, command: command() });
      await writer.query("BEGIN"); await writer.query("SET LOCAL lock_timeout='50ms'");
      await expect(writer.query("UPDATE wms.outbound_shipment_items SET qty=2 WHERE id=101")).rejects.toMatchObject({ code: "55P03" });
      await writer.query("ROLLBACK"); await reader.query("COMMIT");
      await writer.query("UPDATE wms.outbound_shipment_items SET qty=2 WHERE id=101");
      await expect(read()).rejects.toMatchObject({ code: "WMS_DISPATCH_QUANTITY_MISMATCH" });
    } finally { await reader.query("ROLLBACK"); await writer.query("ROLLBACK"); reader.release(); writer.release(); }
  });
});
