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
