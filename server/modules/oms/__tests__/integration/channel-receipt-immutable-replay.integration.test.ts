import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeChannelFulfillmentIngress } from "../../channel-fulfillment-ingress";
import { createChannelFulfillmentIngressRepository, type ChannelFulfillmentIngressRepository } from "../../channel-fulfillment-ingress.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { channelShipmentRuntimeFixtureSql, channelShipmentRuntimeSeedSql } from "../fixtures/channel-shipment-runtime";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const now = new Date("2026-09-07T20:00:00.000Z");
const input = normalizeChannelFulfillmentIngress({
  sourceProvider:"shopify", sourceChannelId:36, sourceOrderId:"101", sourceFulfillmentId:"201",
  eventKind:"created", source:"test:immutable-replay", shippedAt:now, trackingNumber:"TRACK1",
  lineItems:[{ channelOrderLineId:"line-1", quantity:2 }],
});

// Install the actual production guard, not a permissive approximation. Other
// owner tables are reduced query fixtures; this does not certify all migrations.
function receiptGuardSql(): string {
  const migration = readFileSync(resolve(process.cwd(), "migrations/0593_fulfillment_authority_cutover_foundation.sql"), "utf8");
  const start = migration.indexOf("CREATE OR REPLACE FUNCTION oms.channel_fulfillment_receipt_item_update_guard()");
  const end = migration.indexOf("DROP TRIGGER IF EXISTS physical_shipment_tracking_amendments_immutable", start);
  if (start < 0 || end <= start) throw new Error("Receipt immutability migration section not found");
  return migration.slice(start, end);
}

describeDatabase.sequential("receipt replay with the production immutability trigger", () => {
  let database: InventoryCutoverTestDatabase;
  let repository: ChannelFulfillmentIngressRepository;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable,
      channelShipmentRuntimeFixtureSql + receiptGuardSql());
    repository = createChannelFulfillmentIngressRepository(drizzle(database.pool));
  });
  beforeEach(async () => { await database.pool.query(channelShipmentRuntimeSeedSql); });
  afterAll(async () => { await database?.close(); });
  const prepare = () => repository.prepareReceipt(91, input, "lease-1", now);
  const receiptRows = async () => (await database.pool.query("SELECT *,xmin::text AS row_version FROM oms.channel_fulfillment_receipt_items ORDER BY channel_order_line_id")).rows;
  async function nonShipping(): Promise<void> {
    await database.pool.query(`UPDATE catalog.product_variants SET requires_shipping=false,track_inventory=false;
      UPDATE oms.oms_order_lines SET requires_shipping=false;
      UPDATE wms.order_items SET requires_shipping=0,status='completed';`);
  }
  async function engineEcho(): Promise<void> {
    await database.pool.query(`INSERT INTO wms.physical_shipments VALUES(70,'shipstation','SS201','shipped','TRACK1');
      INSERT INTO wms.fulfillment_plan_lines VALUES(80,12);
      INSERT INTO wms.physical_shipment_items VALUES(71,70,1,80,2,'customer_fulfillment');
      INSERT INTO oms.channel_fulfillment_pushes VALUES(90,70,'shopify',11,'201','success');
      INSERT INTO oms.channel_fulfillment_push_items VALUES(92,90,'line-1',2,71);`);
  }
  async function retained(legacyId: number | null, physicalId: number | null): Promise<void> {
    await database.pool.query(`INSERT INTO oms.channel_fulfillment_receipt_items
      VALUES(91,NULL,'line-1',2,12,50,$1,$2,'2026-09-06T12:00:00Z')`, [legacyId,physicalId]);
  }

  it.each([[null,null],[1,null],[1,71]] as const)("non-shipping replay preserves prior links %s/%s without an item UPDATE", async (legacyId,physicalId) => {
    await nonShipping();
    await retained(legacyId,physicalId);
    const before = await receiptRows();
    const stockBefore = (await database.pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows;
    expect(await prepare()).toMatchObject({ nonShippingOnly:true, inventoryItems:[], cancellationCandidates:[], physicalShipmentId:null });
    expect(await prepare()).toMatchObject({ nonShippingOnly:true, inventoryItems:[] });
    expect(await receiptRows()).toEqual(before);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows).toEqual(stockBefore);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM wms.outbound_shipments")).rows[0].count).toBe(0);
  });
  it("replays an identical engine echo without touching fully attached receipt evidence", async () => {
    await engineEcho();
    expect(await prepare()).toMatchObject({ sourceEcho:true, physicalShipmentId:70 });
    const before = await receiptRows();
    expect(await prepare()).toMatchObject({ sourceEcho:true, physicalShipmentId:70 });
    expect(await receiptRows()).toEqual(before);
  });
  it("allows the one-time physical attachment without replacing the retained legacy link", async () => {
    await engineEcho();
    await retained(1,null);
    expect(await prepare()).toMatchObject({ sourceEcho:true, physicalShipmentId:70 });
    expect(await receiptRows()).toMatchObject([{ legacy_wms_shipment_item_id:1,physical_shipment_item_id:71 }]);
    const attached = await receiptRows();
    await prepare();
    expect(await receiptRows()).toEqual(attached);
  });
  it.each([
    ["quantity", "line-1",1,12,50], ["OMS identity", "line-1",2,999,50],
    ["WMS identity", "line-1",2,12,999], ["extra line", "other",2,12,50],
  ] as const)("rejects conflicting %s and rolls back receipt-header and item writes", async (_name, channelLineId, quantity, omsLineId, wmsItemId) => {
    await nonShipping();
    // Insert conflicting historical evidence without ever disabling its guard.
    await database.pool.query(`INSERT INTO oms.channel_fulfillment_receipt_items
      VALUES(91,NULL,$1,$2,$3,$4,NULL,NULL,'2026-09-06T12:00:00Z')`, [channelLineId,quantity,omsLineId,wmsItemId]);
    const before = await receiptRows();
    const headerBefore = (await database.pool.query("SELECT * FROM oms.channel_fulfillment_receipts")).rows;
    await expect(prepare()).rejects.toMatchObject({ code:"PACKAGE_ITEM_CONFLICT" });
    expect(await receiptRows()).toEqual(before);
    expect((await database.pool.query("SELECT * FROM oms.channel_fulfillment_receipts")).rows).toEqual(headerBefore);
  });
  it.each([[999,71],[1,999]])("rejects conflicting physical lineage %s/%s", async (legacyId,physicalId) => {
    await engineEcho();
    await retained(legacyId,physicalId);
    const before = await receiptRows();
    await expect(prepare()).rejects.toMatchObject({ code:"PACKAGE_ITEM_CONFLICT" });
    expect(await receiptRows()).toEqual(before);
  });
  it("serializes competing identical preparations with no duplicate or changed evidence", async () => {
    await nonShipping();
    await retained(1,71);
    const before = await receiptRows();
    const results = await Promise.all([prepare(),prepare()]);
    expect(results.every(result => result.nonShippingOnly)).toBe(true);
    expect(await receiptRows()).toEqual(before);
  });
  it("keeps the guard active for deletion, no-op UPDATE and replacement of lineage", async () => {
    await retained(1,71);
    const before = await receiptRows();
    await expect(database.pool.query("DELETE FROM oms.channel_fulfillment_receipt_items")).rejects.toMatchObject({ code:"55000" });
    await expect(database.pool.query("UPDATE oms.channel_fulfillment_receipt_items SET quantity=quantity")).rejects.toMatchObject({ code:"23514" });
    await expect(database.pool.query("UPDATE oms.channel_fulfillment_receipt_items SET physical_shipment_item_id=72")).rejects.toMatchObject({ code:"23514" });
    expect(await receiptRows()).toEqual(before);
  });
  it("does not widen the guard to permit rewriting a missing legacy link", async () => {
    await engineEcho();
    await retained(null,null);
    const before = await receiptRows();
    await expect(prepare()).rejects.toMatchObject({ code:"23514" });
    expect(await receiptRows()).toEqual(before);
  });
});
