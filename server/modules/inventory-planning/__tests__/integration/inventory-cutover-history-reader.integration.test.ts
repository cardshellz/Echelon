import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { readCutoverHistoryFacts } from "../../infrastructure/inventory-cutover-history.reader";
import { proposeHistoricalWork } from "../../domain/inventory-cutover-history-proposal";
import { historyFixture } from "../fixtures/inventory-cutover-history.fixture";

// Query contract fixture, not a substitute for production migration/trigger
// tests. This feature is SELECT-only and installs no production migration.
const schema = `CREATE SCHEMA oms; CREATE SCHEMA wms;
CREATE TABLE oms.channel_fulfillment_receipts(id bigint PRIMARY KEY,processing_status text,source_channel_id integer,
 source_order_id text,oms_order_id bigint,lease_expires_at timestamptz,lease_token text,created_at timestamptz,raw_payload jsonb);
CREATE TABLE oms.channel_fulfillment_receipt_attempts(id bigint PRIMARY KEY,receipt_id bigint,metadata jsonb);
CREATE TABLE oms.channel_fulfillment_receipt_items(id bigint PRIMARY KEY,receipt_id bigint,quantity integer);
CREATE TABLE oms.oms_orders(id bigint PRIMARY KEY,channel_id integer,external_order_id text,status text);
CREATE TABLE oms.oms_order_lines(id bigint PRIMARY KEY,order_id bigint,requires_shipping boolean,authority_fulfillable_quantity integer,fulfillment_status text);
CREATE TABLE wms.orders(id integer PRIMARY KEY,warehouse_status text);
CREATE TABLE wms.order_items(id integer PRIMARY KEY,order_id integer,quantity integer,picked_quantity integer,fulfilled_quantity integer);
CREATE TABLE wms.outbound_shipments(id integer PRIMARY KEY,order_id integer,status text,shipment_purpose text,external_fulfillment_id text,requires_review boolean,held boolean);
CREATE TABLE wms.outbound_shipment_items(id integer PRIMARY KEY,shipment_id integer,shipment_item_purpose text,qty integer,
 order_item_id integer,product_variant_id integer,replacement_for_order_item_id integer,correction_for_shipment_item_id integer);
CREATE TABLE wms.physical_shipments(id bigint PRIMARY KEY,shipment_request_id bigint,status text,provider text,provider_physical_shipment_id text);
CREATE TABLE wms.physical_shipment_items(id bigint PRIMARY KEY,physical_shipment_id bigint,legacy_wms_shipment_item_id integer,
 wms_order_item_id integer,product_variant_id integer,quantity_shipped integer);
CREATE TABLE wms.physical_shipment_item_quantity_adjustments(physical_shipment_item_id bigint PRIMARY KEY,quantity_delta integer);
CREATE TABLE wms.shipment_requests(id bigint PRIMARY KEY,legacy_wms_shipment_id integer);
CREATE TABLE wms.shipping_provider_labels(id bigint PRIMARY KEY,label_status text);
CREATE TABLE wms.shipping_provider_label_links(id bigint PRIMARY KEY,shipping_provider_label_id bigint,legacy_wms_shipment_id integer);
CREATE TABLE wms.pick_corrections(id integer PRIMARY KEY,order_item_id integer,state text);
INSERT INTO oms.channel_fulfillment_receipts VALUES(20,'review',36,'external-20',50,NULL,NULL,'2026-07-23T13:00:00Z','{"original":true}');
INSERT INTO oms.channel_fulfillment_receipt_attempts VALUES(1,20,'{"outcome":"review"}');
INSERT INTO oms.channel_fulfillment_receipt_items VALUES(1,20,1);
INSERT INTO oms.oms_orders VALUES(50,36,'external-20','shipped'),(51,37,'external-20','confirmed');
INSERT INTO oms.oms_order_lines VALUES(51,50,true,1,'fulfilled'),(52,51,true,10,'unfulfilled');
INSERT INTO wms.orders VALUES(2,'shipped');INSERT INTO wms.order_items VALUES(21,2,1,1,1);
INSERT INTO wms.outbound_shipments VALUES(90,2,'cancelled','customer_fulfillment',NULL,true,false);
INSERT INTO wms.outbound_shipment_items VALUES(91,90,'customer_fulfillment',1,21,101,NULL,NULL);
INSERT INTO wms.shipping_provider_labels VALUES(1,'active');INSERT INTO wms.shipping_provider_label_links VALUES(1,1,90);
INSERT INTO wms.shipment_requests VALUES(1,90);INSERT INTO wms.physical_shipments VALUES(200,1,'voided','shipstation','original');
INSERT INTO wms.physical_shipment_items VALUES(201,200,91,21,101,1);`;
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const blockers = [{ code: "SHIPMENT_RECEIPT_REQUIRES_REVIEW", subject: "channel_fulfillment_receipt:20", message: "review" },
{ code: "SHIPMENT_RECEIPT_REQUIRES_REVIEW", subject: "outbound_shipment_review:90", message: "review" },
{ code: "SHIPMENT_SOURCE_REQUIRES_REVIEW", subject: "source:91", message: "review" }];

dbDescribe.sequential("read-only complete history evidence in real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  beforeAll(async () => { database = await createInventoryCutoverTestDatabase(url, disposable, schema); }, 30_000);
  afterAll(async () => { await database?.close(); });
  async function snapshot<T>(run: (client: PoolClient, source: ReturnType<typeof historyFixture>["source"]) => Promise<T>) {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const { source } = historyFixture(); source.capturedAt = (await client.query("SELECT transaction_timestamp() AS time")).rows[0].time.toISOString();
      return await run(client, source);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  it("reads exact scoped owners, full membership and closed package evidence without writing", async () => {
    await snapshot(async (client, source) => {
      const facts = await readCutoverHistoryFacts(client, source, blockers);
      expect(facts.receipts[0].matchedOrders.map(row => row.id)).toEqual(["50"]);
      expect(facts.shipments[0].sources.map(row => row.id)).toEqual([91]);
      expect(facts.shipments[0].physicalStatuses).toEqual(["voided"]);
      expect(proposeHistoricalWork(source, facts)).toMatchObject({ blockers: [], productionReady: false });
      await expect(client.query("UPDATE wms.outbound_shipments SET requires_review=false WHERE id=90")).rejects.toMatchObject({ code: "25006" });
    });
    expect((await database.pool.query("SELECT requires_review FROM wms.outbound_shipments WHERE id=90")).rows[0].requires_review).toBe(true);
  });
  it("requires a same-snapshot read-only transaction", async () => {
    const { source } = historyFixture();
    await expect(readCutoverHistoryFacts(database.pool, source, blockers)).rejects.toThrow("HISTORY_READER_SNAPSHOT_REQUIRED");
    await snapshot(async (client, source) => {
      source.capturedAt = "2026-01-01T00:00:00.000Z";
      await expect(readCutoverHistoryFacts(client, source, blockers)).rejects.toThrow("HISTORY_READER_SNAPSHOT_REQUIRED");
    });
  });
  it("does not read a null channel as permission to search all channels", async () => {
    await database.pool.query("UPDATE oms.channel_fulfillment_receipts SET source_channel_id=NULL,oms_order_id=NULL WHERE id=20");
    try {
      await snapshot(async (client, source) => {
        const facts = await readCutoverHistoryFacts(client, source, blockers);
        expect(facts.receipts[0].matchedOrders).toEqual([]);
        expect(proposeHistoricalWork(source, facts).groups.unresolved_channel_quarantine).toBe(1);
      });
    } finally { await database.pool.query("UPDATE oms.channel_fulfillment_receipts SET source_channel_id=36,oms_order_id=50 WHERE id=20"); }
  });
  it("keeps original attempt evidence stable during a concurrent update, then fingerprints the change", async () => {
    const oldHash = await snapshot(async (client, source) => {
      const first = await readCutoverHistoryFacts(client, source, blockers);
      await database.pool.query("UPDATE oms.channel_fulfillment_receipt_attempts SET metadata=$1::jsonb WHERE id=1", [JSON.stringify({ changed: true })]);
      const again = await readCutoverHistoryFacts(client, source, blockers);
      expect(again).toEqual(first); return first.receipts[0].attemptsHash;
    });
    await snapshot(async (client, source) => { expect((await readCutoverHistoryFacts(client, source, blockers)).receipts[0].attemptsHash).not.toBe(oldHash); });
  });
  it("hashes columns unknown to the typed projection", async () => {
    const old = await snapshot(async (client, source) => (await readCutoverHistoryFacts(client, source, blockers)).receipts[0].rowHash);
    await database.pool.query("ALTER TABLE oms.channel_fulfillment_receipts ADD COLUMN future_evidence text DEFAULT 'keep me'");
    await snapshot(async (client, source) => { expect((await readCutoverHistoryFacts(client, source, blockers)).receipts[0].rowHash).not.toBe(old); });
  });
  it("fingerprints full package membership and quantity adjustments, not just the header status", async () => {
    const old = await snapshot(async (client, source) => (await readCutoverHistoryFacts(client, source, blockers)).shipments[0].physicalLinksHash);
    await database.pool.query("INSERT INTO wms.physical_shipment_item_quantity_adjustments VALUES(201,-1)");
    try {
      await snapshot(async (client, source) => {
        const changed = (await readCutoverHistoryFacts(client, source, blockers)).shipments[0];
        expect(changed.physicalStatuses).toEqual(["voided"]);
        expect(changed.physicalLinksHash).not.toBe(old);
      });
    } finally { await database.pool.query("DELETE FROM wms.physical_shipment_item_quantity_adjustments WHERE physical_shipment_item_id=201"); }
  });
  it("rejects missing exact membership rather than returning a partial census", async () => {
    await snapshot(async (client, source) => {
      await expect(readCutoverHistoryFacts(client, source, [...blockers, { code: "SHIPMENT_RECEIPT_REQUIRES_REVIEW", subject: "channel_fulfillment_receipt:999", message: "missing" }]))
        .rejects.toThrow("HISTORY_READER_MEMBERSHIP_CHANGED");
    });
  });
  it("captures pick corrections as current work, not closed-order history", async () => {
    await database.pool.query("INSERT INTO wms.pick_corrections VALUES(1,21,'picking_required')");
    try {
      await snapshot(async (client, source) => {
        const facts = await readCutoverHistoryFacts(client, source, blockers);
        expect(facts.shipments[0].openPickCorrections).toBe(1);
        expect(proposeHistoricalWork(source, facts).blockers).toContainEqual({ code: "HISTORY_SHIPMENT_CURRENT_OR_UNKNOWN_OWNER", subject: "shipment:90" });
      });
    } finally { await database.pool.query("DELETE FROM wms.pick_corrections WHERE id=1"); }
  });
});
