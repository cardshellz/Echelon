import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeChannelFulfillmentIngress } from "../../channel-fulfillment-ingress";
import type { ChannelFulfillmentIngressRepository } from "../../channel-fulfillment-ingress.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { channelShipmentRuntimeFixtureSql, channelShipmentRuntimeSeedSql } from "../fixtures/channel-shipment-runtime";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const now = new Date("2026-09-07T20:00:00.000Z");
const input = normalizeChannelFulfillmentIngress({
  sourceProvider: "shopify", sourceChannelId: 36, sourceOrderId: "101", sourceFulfillmentId: "201",
  eventKind: "created", source: "test:canonical-echo", shippedAt: now, trackingNumber: "TRACK1",
  lineItems: [{ channelOrderLineId: "line-1", quantity: 2 }],
});

describeDatabase.sequential("canonical shipment echo exact-source PostgreSQL preparation", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let repository: ChannelFulfillmentIngressRepository;
  beforeAll(async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, channelShipmentRuntimeFixtureSql + `
      ALTER TABLE wms.outbound_shipments ADD COLUMN shipstation_order_key text, ADD COLUMN service_code text;`);
    pool = database.pool;
    const { createChannelFulfillmentIngressRepository } = await import("../../channel-fulfillment-ingress.repository");
    repository = createChannelFulfillmentIngressRepository(drizzle(pool));
  });
  beforeEach(async () => {
    await pool.query(`TRUNCATE oms.channel_fulfillment_push_items,oms.channel_fulfillment_pushes,
      wms.physical_shipment_items,wms.physical_shipments,wms.fulfillment_plan_lines;
      ${channelShipmentRuntimeSeedSql}
      UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=4;
      INSERT INTO wms.outbound_shipments(order_id,status,tracking_number,shipping_engine,engine_order_ref,
        external_fulfillment_id,carrier,shipped_at) VALUES(40,'shipped','TRACK1','shipstation','SSORDER',
        'provider_physical:v1:shipstation:SS201','UPS','2026-09-07T20:00:00Z');
      INSERT INTO wms.outbound_shipment_items(shipment_id,order_item_id,shipment_item_purpose,product_variant_id,qty,from_location_id)
        VALUES(1,50,'customer_fulfillment',30,2,NULL);`);
  });
  afterAll(async () => { await database?.close(); });
  const prepare = () => repository.prepareReceipt(91, input, "lease-1", now);
  async function physical() {
    await pool.query(`INSERT INTO wms.physical_shipments VALUES(70,'shipstation','SS201','shipped','TRACK1');
      INSERT INTO wms.fulfillment_plan_lines VALUES(80,12);
      INSERT INTO wms.physical_shipment_items VALUES(71,70,1,80,2,'customer_fulfillment');`);
  }
  async function push() {
    await physical();
    await pool.query(`INSERT INTO oms.channel_fulfillment_pushes VALUES(90,70,'shopify',11,'201','success');
      INSERT INTO oms.channel_fulfillment_push_items VALUES(92,90,'line-1',2,71);`);
  }
  function expected() {
    return { legacyWmsShipmentId: 1, legacyWmsShipmentItemId: 1, wmsOrderId: 40, wmsOrderItemId: 50,
      productVariantId: 30, warehouseLocationId: null, quantity: 2, deductFromOnHandOnly: false };
  }

  it.each(["provider push", "physical tracking", "legacy tracking"])("%s echo reuses persisted source quantity and NULL bin without creating or changing sources", async branch => {
    if (branch === "provider push") await push();
    if (branch === "physical tracking") await physical();
    const before = (await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows;
    const result = await prepare();
    expect(result.sourceEcho).toBe(true);
    expect(result.inventoryItems).toEqual([expected()]);
    expect(result.cancellationCandidates).toEqual([]);
    expect((await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS count FROM wms.outbound_shipments")).rows[0]?.count).toBe(1);
  });

  it("keeps legacy provider echoes free of inventory replay work", async () => {
    await push();
    await pool.query("UPDATE inventory.availability_runtime_authority SET authority='legacy',activation_run_id=NULL");
    expect((await prepare()).inventoryItems).toEqual([]);
  });

  it.each(["provider push", "physical tracking", "legacy tracking"])("%s cannot turn an old channel-created package into engine authority", async branch => {
    if (branch === "provider push") await push();
    if (branch === "physical tracking") await physical();
    await pool.query(`UPDATE wms.outbound_shipments SET source='shopify_fulfillment_receipt',
      shipping_engine='shopify', external_fulfillment_id='provider_physical:v1:shopify:201';
      UPDATE wms.physical_shipments SET provider='shopify',provider_physical_shipment_id='201';`);
    const before = (await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows;
    expect(await prepare()).toMatchObject({
      shippingEvidenceMissing: true, physicalShipmentId: null, inventoryItems: [], cancellationCandidates: [],
    });
    expect((await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows).toEqual(before);
    expect((await pool.query("SELECT physical_shipment_item_id FROM oms.channel_fulfillment_receipt_items")).rows)
      .toEqual([{ physical_shipment_item_id: null }]);
  });

  it("fills only missing receipt bindings when an approved replay finds engine evidence", async () => {
    await pool.query("UPDATE wms.outbound_shipments SET source='shopify_fulfillment_receipt'");
    expect((await prepare()).shippingEvidenceMissing).toBe(true);
    await pool.query("UPDATE wms.outbound_shipments SET source='shipstation'");
    await physical();
    expect((await prepare()).sourceEcho).toBe(true);
    expect((await prepare()).sourceEcho).toBe(true);
    expect((await pool.query(`SELECT legacy_wms_shipment_item_id, physical_shipment_item_id
      FROM oms.channel_fulfillment_receipt_items`)).rows)
      .toEqual([{ legacy_wms_shipment_item_id: 1, physical_shipment_item_id: 71 }]);
    await pool.query("UPDATE oms.channel_fulfillment_receipt_items SET legacy_wms_shipment_item_id=999");
    await expect(prepare()).rejects.toMatchObject({ code: "PACKAGE_ITEM_CONFLICT" });
    expect((await pool.query("SELECT legacy_wms_shipment_item_id FROM oms.channel_fulfillment_receipt_items")).rows[0].legacy_wms_shipment_item_id).toBe(999);
  });

  it.each(["provider push", "physical tracking", "legacy tracking"])("%s matches physical lines in a mixed donation receipt without inventing a donation package", async branch => {
    if (branch === "provider push") await push();
    if (branch === "physical tracking") await physical();
    await pool.query(`INSERT INTO catalog.product_variants VALUES (31,false,false);
      INSERT INTO oms.oms_order_lines VALUES (13,11,'donation',1,1,31,'DONATION',false);
      INSERT INTO wms.order_items VALUES (51,40,13,1,0,'pending',0);`);
    const mixed = normalizeChannelFulfillmentIngress({
      sourceProvider: "shopify", sourceChannelId: 36, sourceOrderId: "101", sourceFulfillmentId: "201",
      eventKind: "created", source: "test:mixed-echo", shippedAt: now, trackingNumber: "TRACK1",
      lineItems: [{ channelOrderLineId: "line-1", quantity: 2 }, { channelOrderLineId: "donation", quantity: 1 }],
    });
    const before = (await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows;
    const result = await repository.prepareReceipt(91, mixed, "lease-1", now);
    expect(result.sourceEcho).toBe(true);
    expect(result.inventoryItems).toEqual([expected()]);
    expect((await pool.query(`SELECT channel_order_line_id, quantity, legacy_wms_shipment_item_id,
      physical_shipment_item_id FROM oms.channel_fulfillment_receipt_items ORDER BY channel_order_line_id`)).rows)
      .toEqual([
        { channel_order_line_id: "donation", quantity: 1, legacy_wms_shipment_item_id: null, physical_shipment_item_id: null },
        { channel_order_line_id: "line-1", quantity: 2, legacy_wms_shipment_item_id: 1,
          physical_shipment_item_id: branch === "legacy tracking" ? null : 71 },
      ]);
    expect((await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows).toEqual(before);
    expect((await pool.query("SELECT picked_quantity FROM wms.order_items WHERE id=51")).rows[0].picked_quantity).toBe(0);
    if (branch === "legacy tracking") await physical();
    await repository.attachPhysicalShipment(91, 70, "lease-1", now);
    expect((await pool.query(`SELECT channel_order_line_id, physical_shipment_item_id
      FROM oms.channel_fulfillment_receipt_items ORDER BY channel_order_line_id`)).rows).toEqual([
        { channel_order_line_id: "donation", physical_shipment_item_id: null },
        { channel_order_line_id: "line-1", physical_shipment_item_id: 71 },
      ]);
  });

  it("still rejects and rolls back an unresolved physical receipt item at attachment", async () => {
    await push(); await prepare();
    await pool.query(`UPDATE oms.channel_fulfillment_receipt_items
      SET physical_shipment_item_id=NULL, legacy_wms_shipment_item_id=NULL`);
    await expect(repository.attachPhysicalShipment(91, 70, "lease-1", now))
      .rejects.toMatchObject({ code: "CANONICAL_PACKAGE_CONFLICT" });
    expect((await pool.query("SELECT physical_shipment_id FROM oms.channel_fulfillment_receipts WHERE id=91")).rows[0].physical_shipment_id).toBeNull();
  });

  it.each(["missing source", "changed quantity", "other order", "other variant"])("rejects %s even when the outbound provider command matched", async mismatch => {
    await push();
    if (mismatch === "missing source") await pool.query("DELETE FROM wms.outbound_shipment_items");
    if (mismatch === "changed quantity") await pool.query("UPDATE wms.outbound_shipment_items SET qty=1");
    if (mismatch === "other order") await pool.query("UPDATE wms.outbound_shipments SET order_id=999");
    if (mismatch === "other variant") await pool.query("UPDATE wms.outbound_shipment_items SET product_variant_id=999");
    await expect(prepare()).rejects.toMatchObject({ code: "ECHO_COMMAND_CONFLICT" });
    expect((await pool.query("SELECT * FROM oms.channel_fulfillment_receipt_items")).rows).toEqual([]);
  });
});
