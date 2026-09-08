import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresOperationalShipmentDispatchRepository } from "../../infrastructure/operational-shipment-dispatch.repository";
import { WmsOperationalShipmentSourceOwner } from "../../../wms/operational-shipment-source";
import { createChannelFulfillmentAuthorityRepository } from "../../../oms/channel-fulfillment-authority.repository";
import { shipmentQuantityEvidenceProjection } from "../../infrastructure/shipment-quantity-evidence.sql";
import { interpretInventoryShipmentQuantity } from "@shared/inventory/shipment-quantity";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";
import { shipmentCompatibilityFixtureSql, shipmentCompatibilitySeedSql } from "../../../oms/__tests__/fixtures/shipment-compatibility";
import type { OperationalShipmentBeforeCommit } from "../../application/operational-shipment-dispatch.port";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const databaseSuite = url && disposable ? describe : describe.skip;
const occurredAt = new Date("2026-09-07T18:00:00Z");
const request = { orderId: 70, outboundShipmentId: 92, sourceShipmentItemId: 103,
  productVariantId: 105, quantity: 5, actor: "system:shipstation:v2" };

databaseSuite.sequential("operational shipment exact available-stock owner PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, shipmentCompatibilityFixtureSql);
    pool = database.pool;
    for (const name of ["0662_inventory_availability_claim_dispatch.sql",
      "183_omission_correction_shipment_item_authority.sql", "234_inventory_canonical_shipment_compatibility.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", name), "utf8"));
    }
    await pool.query("CREATE TABLE public.operational_publication_test(transaction_id integer PRIMARY KEY)");
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE public.operational_publication_test");
    await pool.query(shipmentCompatibilitySeedSql);
    await pool.query(`INSERT INTO wms.outbound_shipments(id,order_id,status,shipment_purpose,replaces_shipment_id,
      replacement_authorized_at,replacement_authorized_by)
      VALUES(92,70,'shipped','replacement',90,'2026-09-07','operator');
      INSERT INTO wms.outbound_shipment_items(id,shipment_id,product_variant_id,qty,shipment_item_purpose,replacement_for_order_item_id,from_location_id)
      VALUES(103,92,105,5,'replacement',71,50)`);
  });
  afterAll(async () => { await database?.close(); });
  const publication: OperationalShipmentBeforeCommit = async ({ client, inventoryTransactionId }) => {
    await client.query("INSERT INTO public.operational_publication_test VALUES($1)", [inventoryTransactionId]);
  };
  const owner = (beforeCommit: OperationalShipmentBeforeCommit = publication) =>
    new PostgresOperationalShipmentDispatchRepository(pool, new WmsOperationalShipmentSourceOwner(), beforeCommit, () => occurredAt);
  async function snapshot() {
    const result: Record<string, unknown[]> = {};
    for (const table of ["inventory.inventory_levels", "inventory.inventory_lots", "inventory.inventory_transactions",
      "oms.order_item_costs", "inventory.availability_claim_lines", "inventory.availability_claim_resources",
      "inventory.availability_claim_lot_allocations", "inventory.operational_shipment_dispatch_receipts",
      "inventory.operational_shipment_dispatch_lots", "wms.outbound_shipment_items"]) {
      result[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    }
    result.publication = (await pool.query("SELECT * FROM public.operational_publication_test ORDER BY transaction_id")).rows;
    return result;
  }
  async function readQuantity() {
    const query = new PgDialect().sqlToQuery(sql`SELECT ${shipmentQuantityEvidenceProjection(sql.identifier("ledger"))} AS evidence
      FROM inventory.inventory_transactions ledger WHERE ledger.shipment_item_id=103`);
    const evidence = (await pool.query(query.sql, query.params)).rows[0].evidence;
    return { evidence, quantity: interpretInventoryShipmentQuantity(evidence) };
  }

  it.each(["replacement", "concession"])("consumes exact new FIFO stock for %s without touching anyone's picked/reserved custody or customer COGS", async (purpose) => {
    if (purpose === "concession") await pool.query("UPDATE wms.outbound_shipment_items SET shipment_item_purpose='concession',replacement_for_order_item_id=NULL WHERE id=103");
    const before = await snapshot();
    expect(await owner().dispatch(request)).toEqual({ warehouseLocationId: 50, alreadyRecorded: false, preserveSourceLocation: true });
    const after = await snapshot();
    expect(after["inventory.inventory_levels"][0]).toMatchObject({ variant_qty: 5, reserved_qty: 4, picked_qty: 8 });
    expect(after["inventory.inventory_lots"]).toMatchObject([
      { id: 401, qty_on_hand: 1, qty_reserved: 1, qty_picked: 4, qty_consumed: 7 },
      { id: 402, qty_on_hand: 4, qty_reserved: 3, qty_picked: 2, qty_consumed: 8 },
      { id: 403, qty_on_hand: 0, qty_reserved: 0, qty_picked: 2, qty_consumed: 9 },
    ]);
    for (const table of ["oms.order_item_costs", "inventory.availability_claim_lines",
      "inventory.availability_claim_resources", "inventory.availability_claim_lot_allocations", "wms.outbound_shipment_items"]) {
      expect(after[table]).toEqual(before[table]);
    }
    expect(after["inventory.inventory_transactions"]).toHaveLength(1);
    expect(after["inventory.inventory_transactions"][0]).toMatchObject({ variant_qty_delta: -5, reserved_qty_delta: 0,
      order_item_id: null, reference_type: "operational_shipment", total_cost_mills: "4773" });
    expect(after["inventory.operational_shipment_dispatch_lots"]).toMatchObject([
      { inventory_lot_id: 401, quantity: 3, unit_cost_mills: "999", total_cost_mills: "2997" },
      { inventory_lot_id: 402, quantity: 2, unit_cost_mills: "888", total_cost_mills: "1776" },
    ]);
    expect(after.publication).toHaveLength(1);
    expect((await readQuantity()).quantity).toEqual({ status: "verified", source: "operational_dispatch_receipt", quantity: 5, receiptId: "1" });
  });

  it("uses new available stock from another bin without overwriting the original source hint", async () => {
    await pool.query(`UPDATE inventory.inventory_levels SET reserved_qty=variant_qty;
      UPDATE inventory.inventory_lots SET qty_reserved=qty_on_hand;
      INSERT INTO warehouse.warehouse_locations(id,warehouse_id) VALUES(51,1);
      INSERT INTO inventory.inventory_levels VALUES(61,51,105,5,0,0,0,0,'2026-09-07');
      INSERT INTO inventory.inventory_lots VALUES(404,51,105,5,0,0,0,'active','2026-09-01',100,100)`);
    expect(await owner().dispatch(request)).toMatchObject({ warehouseLocationId: 51 });
    expect((await pool.query("SELECT from_location_id FROM wms.outbound_shipment_items WHERE id=103")).rows[0].from_location_id).toBe(50);
    expect((await readQuantity()).quantity).toMatchObject({ status: "verified", quantity: 5 });
  });

  it("supports physical-package materialization before operational inventory posting and exact replay afterwards", async () => {
    const materializer = createChannelFulfillmentAuthorityRepository(drizzle(pool));
    const physical = await materializer.materializePhysicalPackage({ legacyWmsShipmentIds: [92], shippingProvider: "shipstation",
      providerPhysicalShipmentId: "replacement-92", providerOrderKey: "replacement-92",
      source: "compatibility-test", suppressChannelWriteback: true });
    expect(physical).toMatchObject({ customerFulfillmentItemCount: 0, nonCustomerItemCount: 1, channelCommands: [] });
    await owner().dispatch(request);
    const before = await snapshot();
    expect(await owner().dispatch({ ...request, actor: "recovery-worker" })).toMatchObject({ alreadyRecorded: true });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects changed replay quantity without another write", async () => {
    await owner().dispatch(request);
    const before = await snapshot();
    await expect(owner().dispatch({ ...request, quantity: 4 })).rejects.toMatchObject({ code: "OPERATIONAL_SHIPMENT_REPLAY_CONFLICT" });
    expect(await snapshot()).toEqual(before);
  });

  it("serializes concurrent retries to one source-owned debit", async () => {
    const results = await Promise.all([owner().dispatch(request), owner().dispatch(request)]);
    expect(results.filter((result) => !result.alreadyRecorded)).toHaveLength(1);
    expect((await snapshot()).publication).toHaveLength(1);
  });

  it("rolls inventory, exact lot receipts, and publication back together", async () => {
    const before = await snapshot();
    await expect(owner(async (input) => { await publication(input); throw new Error("publication failed"); }).dispatch(request))
      .rejects.toThrow("publication failed");
    expect(await snapshot()).toEqual(before);
  });

  it("retries a classified publication-target conflict without duplicate debit", async () => {
    let attempts = 0;
    const beforeCommit = vi.fn(async (input: Parameters<OperationalShipmentBeforeCommit>[0]) => {
      await publication(input);
      if (++attempts === 1) throw Object.assign(new Error("target busy"), { code: "INVENTORY_PUBLICATION_TARGET_BUSY" });
    });
    await owner(beforeCommit).dispatch(request);
    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect((await snapshot()).publication).toHaveLength(1);
    expect((await readQuantity()).quantity).toMatchObject({ status: "verified", quantity: 5 });
  });

  it.each([
    ["aggregate reserved", "UPDATE inventory.inventory_levels SET reserved_qty=variant_qty"],
    ["FIFO reserved", "UPDATE inventory.inventory_lots SET qty_reserved=qty_on_hand"],
    ["frozen", "UPDATE warehouse.warehouse_locations SET cycle_count_freeze_id=1"],
    ["nonpickable", "UPDATE warehouse.warehouse_locations SET is_pickable=0"],
  ])("rejects %s stock instead of consuming another owner's picked stock", async (_name, mutation) => {
    await pool.query(mutation);
    const before = await snapshot();
    await expect(owner().dispatch(request)).rejects.toMatchObject({ code: "REPLACEMENT_INVENTORY_UNAVAILABLE" });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["no authorization", "UPDATE wms.outbound_shipments SET replacement_authorized_by=NULL WHERE id=92"],
    ["other review", "UPDATE wms.outbound_shipments SET requires_review=true,review_reason='other' WHERE id=92"],
    ["held", "UPDATE wms.outbound_shipments SET held=true WHERE id=92"],
    ["ordinary customer", "UPDATE wms.outbound_shipment_items SET shipment_item_purpose='customer_fulfillment',order_item_id=71,replacement_for_order_item_id=NULL WHERE id=103"],
    ["voided", "UPDATE wms.outbound_shipments SET voided_at=now() WHERE id=92"],
  ])("rejects %s source authority before stock mutation", async (_name, mutation) => {
    await pool.query(mutation);
    const before = await snapshot();
    await expect(owner().dispatch(request)).rejects.toMatchObject({ code: "OPERATIONAL_SHIPMENT_SOURCE_UNAUTHORIZED" });
    expect(await snapshot()).toEqual(before);
  });

  it("permits only the existing authorized adoption-pending review state", async () => {
    await pool.query("UPDATE wms.outbound_shipments SET requires_review=true,review_reason='shipstation_reship_adoption_pending' WHERE id=92");
    await owner().dispatch(request);
  });

  it("fails closed on a prior legacy debit instead of attaching operational authority", async () => {
    await pool.query("INSERT INTO inventory.inventory_transactions(transaction_type,shipment_id,shipment_item_id,variant_qty_delta) VALUES('ship',92,103,-5)");
    const before = await snapshot();
    await expect(owner().dispatch(request)).rejects.toMatchObject({ code: "OPERATIONAL_SHIPMENT_ALREADY_POSTED" });
    expect(await snapshot()).toEqual(before);
  });

  it("enforces immutable receipts and rejects incomplete deferred lot journals", async () => {
    await owner().dispatch(request);
    await expect(pool.query("UPDATE inventory.operational_shipment_dispatch_receipts SET quantity=4")).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("DELETE FROM inventory.operational_shipment_dispatch_lots")).rejects.toMatchObject({ code: "23514" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO inventory.operational_shipment_dispatch_lots(receipt_id,inventory_lot_id,quantity,unit_cost_mills,total_cost_mills) VALUES(1,403,1,777,777)");
      await expect(client.query("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toMatchObject({ code: "23514" });
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("classifies a tampered ledger as invalid quantity instead of downgrading to legacy proof", async () => {
    await owner().dispatch(request);
    await pool.query("UPDATE inventory.inventory_transactions SET reference_type='shipment' WHERE shipment_item_id=103");
    expect((await readQuantity()).quantity).toMatchObject({ status: "invalid" });
  });
});
