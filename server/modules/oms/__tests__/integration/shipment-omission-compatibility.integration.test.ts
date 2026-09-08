import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChannelFulfillmentAuthorityRepository } from "../../channel-fulfillment-authority.repository";
import { PostgresCanonicalClaimInventoryRepository } from "../../../inventory/infrastructure/canonical-claim-inventory.repository";
import { PostgresCanonicalClaimDispatchRepository } from "../../../inventory-planning/infrastructure/inventory-availability-dispatch.repository";
import { WmsCanonicalClaimDispatchSourceOwner } from "../../../wms/canonical-claim-dispatch-source";
import { DISPATCH_TIME, dispatchPlan } from "../../../inventory/__tests__/fixtures/canonical-claim-dispatch";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { shipmentCompatibilityFixtureSql, shipmentCompatibilitySeedSql } from "../fixtures/shipment-compatibility";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseSuite = url && disposable ? describe : describe.skip;
const migration = (name: string) => readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
const omission183 = migration("183_omission_correction_shipment_item_authority.sql");
const compatibility234 = migration("234_inventory_canonical_shipment_compatibility.sql");

databaseSuite.sequential("canonical omission actual migration and materializer compatibility", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, shipmentCompatibilityFixtureSql);
    pool = database.pool;
    await pool.query(migration("0662_inventory_availability_claim_dispatch.sql"));
    await pool.query(omission183);
    await pool.query(compatibility234);
  });
  beforeEach(async () => { await pool.query(shipmentCompatibilitySeedSql); });
  afterAll(async () => { await database?.close(); });

  async function dispatch() {
    const repository = new PostgresCanonicalClaimDispatchRepository(pool,
      new WmsCanonicalClaimDispatchSourceOwner(), new PostgresCanonicalClaimInventoryRepository(),
      async () => undefined, () => DISPATCH_TIME);
    await repository.dispatch(dispatchPlan().command);
  }
  async function inventorySnapshot() {
    const result: Record<string, unknown[]> = {};
    for (const table of ["inventory.inventory_levels", "inventory.inventory_lots", "inventory.inventory_transactions",
      "oms.order_item_costs", "inventory.availability_claim_dispatch_receipts", "inventory.availability_claim_dispatch_movements",
      "inventory.availability_claim_lines", "inventory.availability_claim_resources", "inventory.availability_claim_lot_allocations"]) {
      result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    return result;
  }
  async function createOmission(quantity = 2) {
    await pool.query("INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(92,70,'shipped') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO wms.outbound_shipment_items
      (id,shipment_id,product_variant_id,qty,shipment_item_purpose,correction_for_shipment_item_id)
      VALUES(103,92,105,$1,'omission_correction',101)`, [quantity]);
  }
  async function originalPhysical() {
    await pool.query(`INSERT INTO wms.physical_shipments(id,status) VALUES(201,'shipped');
      INSERT INTO wms.physical_shipment_items(id,physical_shipment_id,legacy_wms_shipment_item_id,
      wms_order_item_id,product_variant_id,quantity_shipped,shipment_request_item_id,fulfillment_plan_line_id,sku)
      VALUES(301,201,101,71,105,5,1,1,'SKU-A');`);
  }

  it("proves actual183 rejects zero-delta canonical proof, then actual234 accepts it without an on-hand mutation", async () => {
    await dispatch();
    const before = await inventorySnapshot();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(omission183);
      await client.query("INSERT INTO wms.outbound_shipments(id,order_id,status) VALUES(92,70,'shipped')");
      await expect(client.query(`INSERT INTO wms.outbound_shipment_items
        (id,shipment_id,product_variant_id,qty,shipment_item_purpose,correction_for_shipment_item_id)
        VALUES(103,92,105,2,'omission_correction',101)`)).rejects.toMatchObject({
        code: "23514", constraint: "outbound_shipment_items_omission_inventory_proof_chk",
      });
    } finally { await client.query("ROLLBACK"); client.release(); }
    await createOmission();
    expect(await inventorySnapshot()).toEqual(before);
  });

  it("materializes and replays the actual omission package with exact original physical lineage and no stock/COGS/claim/writeback change", async () => {
    await dispatch();
    await originalPhysical();
    await createOmission();
    const before = await inventorySnapshot();
    const repository = createChannelFulfillmentAuthorityRepository(drizzle(pool));
    const input = { legacyWmsShipmentIds: [92], shippingProvider: "shipstation",
      providerPhysicalShipmentId: "omission-92", providerOrderKey: "order-70-omission",
      source: "compatibility-test", suppressChannelWriteback: true };
    const first = await repository.materializePhysicalPackage(input);
    expect(first).toMatchObject({ customerFulfillmentItemCount: 0, nonCustomerItemCount: 1, channelCommands: [] });
    expect(await repository.materializePhysicalPackage(input)).toEqual(first);
    const rows = (await pool.query("SELECT * FROM wms.physical_shipment_items WHERE legacy_wms_shipment_item_id=103")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ correction_for_physical_shipment_item_id: "301", quantity_shipped: 2,
      shipment_item_purpose: "omission_correction", wms_order_item_id: null, shipment_request_item_id: null,
      fulfillment_plan_line_id: null });
    expect(await inventorySnapshot()).toEqual(before);
  });

  it("retains exact negative-delta legacy source proof", async () => {
    await pool.query(`INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,
      order_id,order_item_id,shipment_id,shipment_item_id,product_variant_id)
      VALUES('ship',-5,70,71,90,101,105)`);
    await createOmission();
  });

  it.each([
    ["unexplained zero", "INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,shipment_id,shipment_item_id,product_variant_id) VALUES('ship',0,70,71,90,101,105)"],
    ["canonical marker without receipt", "INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,shipment_id,shipment_item_id,product_variant_id,reference_type) VALUES('ship',-5,70,71,90,101,105,'availability_claim_dispatch')"],
    ["positive legacy delta", "INSERT INTO inventory.inventory_transactions(transaction_type,variant_qty_delta,order_id,order_item_id,shipment_id,shipment_item_id,product_variant_id) VALUES('ship',5,70,71,90,101,105)"],
  ])("rejects %s instead of manufacturing original shipped units", async (_name, insert) => {
    await pool.query(insert);
    await expect(createOmission()).rejects.toMatchObject({ code: "23514",
      constraint: "outbound_shipment_items_omission_inventory_proof_chk" });
  });

  it.each([
    ["ledger marker", "reference_type='order'"],
    ["second on-hand debit", "variant_qty_delta=-5"],
    ["reservation debit", "reserved_qty_delta=-5"],
    ["source location", "from_location_id=NULL"],
    ["source identity", "shipment_item_id=NULL"],
    ["voided source", "voided_at=now()"],
  ])("rejects a canonical %s mismatch", async (_name, assignment) => {
    await dispatch();
    await pool.query(`UPDATE inventory.inventory_transactions SET ${assignment}`);
    await expect(createOmission()).rejects.toMatchObject({ code: "23514",
      constraint: "outbound_shipment_items_omission_inventory_proof_chk" });
  });

  it("preserves cumulative omission limits", async () => {
    await dispatch();
    await createOmission(3);
    await expect(pool.query(`INSERT INTO wms.outbound_shipment_items
      (id,shipment_id,product_variant_id,qty,shipment_item_purpose,correction_for_shipment_item_id)
      VALUES(104,92,105,3,'omission_correction',101)`)).rejects.toMatchObject({ code: "23514" });
  });

  it("retains actual183 exact physical-source guard and rolls back materialization on incompatible original SKU", async () => {
    await dispatch();
    await originalPhysical();
    await createOmission();
    await pool.query("UPDATE wms.physical_shipment_items SET sku='WRONG' WHERE id=301");
    const repository = createChannelFulfillmentAuthorityRepository(drizzle(pool));
    await expect(repository.materializePhysicalPackage({ legacyWmsShipmentIds: [92], shippingProvider: "shipstation",
      providerPhysicalShipmentId: "bad-omission", providerOrderKey: "bad-omission",
      source: "compatibility-test", suppressChannelWriteback: true })).rejects.toThrow();
    expect((await pool.query("SELECT id FROM wms.physical_shipment_items WHERE legacy_wms_shipment_item_id=103")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM wms.shipping_engine_orders")).rows).toEqual([]);
  });
});
