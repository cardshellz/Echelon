import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeChannelFulfillmentIngress } from "../../channel-fulfillment-ingress";
import type { ChannelFulfillmentIngressRepository } from "../../channel-fulfillment-ingress.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const now = new Date("2026-09-07T20:00:00.000Z");
const input = normalizeChannelFulfillmentIngress({
  sourceProvider: "shopify", sourceChannelId: 36, sourceOrderId: "101",
  sourceFulfillmentId: "201", sourceEventId: "event-201", eventKind: "created",
  source: "test:channel-runtime", rawPayload: {}, shippedAt: now,
  lineItems: [{ channelOrderLineId: "line-1", quantity: 2 }],
});

import { channelShipmentRuntimeFixtureSql as fixtureSql, channelShipmentRuntimeSeedSql } from "../fixtures/channel-shipment-runtime";

describeDatabase.sequential("channel shipment runtime exact preparation PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let repository: ChannelFulfillmentIngressRepository;
  const statements: string[] = [];
  let statementListener: ((query: string) => void) | undefined;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
    const { createChannelFulfillmentIngressRepository } = await import("../../channel-fulfillment-ingress.repository");
    repository = createChannelFulfillmentIngressRepository(drizzle(pool, {
      logger: { logQuery(query) { statements.push(query); statementListener?.(query); } },
    }));
  });
  beforeEach(async () => {
    statementListener = undefined;
    await pool.query(channelShipmentRuntimeSeedSql);
    statements.length = 0;
  });
  afterAll(async () => { await database?.close(); });

  function prepare() { return repository.prepareReceipt(91, input, "lease-1", now); }
  async function canonical() {
    await pool.query("UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=4");
  }

  it.each(["last pick", "primary location"])("canonical preparation leaves the new source bin NULL despite a %s hint", async (hint) => {
    await canonical();
    if (hint === "primary location") await pool.query("DELETE FROM inventory.inventory_transactions");
    const result = await prepare();
    expect((await pool.query("SELECT from_location_id FROM wms.outbound_shipment_items")).rows)
      .toEqual([{ from_location_id: null }]);
    expect(result.inventoryItems).toHaveLength(1);
    expect(result.inventoryItems[0].warehouseLocationId).toBe(hint === "last pick" ? 20 : 25);
    expect(statements[1]).toContain("availability_runtime_authority");
    expect(statements[1]).toContain("FOR SHARE");
    expect(statements[2]).toContain("pg_advisory_xact_lock");
  });

  it.each(["last pick", "primary location"])("legacy preparation retains its existing %s source selection", async (hint) => {
    if (hint === "primary location") await pool.query("DELETE FROM inventory.inventory_transactions");
    await prepare();
    expect((await pool.query("SELECT from_location_id FROM wms.outbound_shipment_items")).rows)
      .toEqual([{ from_location_id: hint === "last pick" ? 20 : 25 }]);
  });

  it("canonical preparation permits no hint and does not mark a valid variant as missing lineage solely for a NULL bin", async () => {
    await canonical();
    await pool.query("DELETE FROM inventory.inventory_transactions; DELETE FROM warehouse.product_locations");
    const result = await prepare();
    expect(result.inventoryItems[0].warehouseLocationId).toBeNull();
    expect((await pool.query("SELECT requires_review,review_reason FROM wms.outbound_shipments")).rows)
      .toEqual([{ requires_review: false, review_reason: null }]);
  });

  it("reuses source identifiers on preparation replay and never overwrites a persisted source bin", async () => {
    await canonical();
    const first = await prepare();
    await pool.query("UPDATE wms.outbound_shipment_items SET from_location_id=20");
    const second = await prepare();
    expect(second.inventoryItems.map((row) => row.legacyWmsShipmentItemId))
      .toEqual(first.inventoryItems.map((row) => row.legacyWmsShipmentItemId));
    expect((await pool.query("SELECT from_location_id FROM wms.outbound_shipment_items")).rows)
      .toEqual([{ from_location_id: 20 }]);
  });

  it.each(["missing", "invalid revision"])("fails closed for %s authority before any receipt/source write", async (kind) => {
    if (kind === "missing") await pool.query("DELETE FROM inventory.availability_runtime_authority");
    else await pool.query("UPDATE inventory.availability_runtime_authority SET revision=0");
    const before = (await pool.query("SELECT * FROM oms.channel_fulfillment_receipts")).rows;
    await expect(prepare()).rejects.toMatchObject({ code: "SHIPMENT_RUNTIME_AUTHORITY_INVALID" });
    expect((await pool.query("SELECT * FROM oms.channel_fulfillment_receipts")).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM wms.outbound_shipments")).rows).toEqual([]);
    expect(statements).toHaveLength(3); // BEGIN, authority pin, ROLLBACK.
  });

  it("does not silently omit inventory posting for an existing provider package whose physical item lacks an exact source link", async () => {
    await canonical();
    await pool.query(`
      INSERT INTO wms.physical_shipments (id,provider,provider_physical_shipment_id,status)
        VALUES (701,'shopify','201','shipped');
      INSERT INTO wms.fulfillment_plan_lines VALUES (801,12);
      INSERT INTO wms.physical_shipment_items
        (id,physical_shipment_id,legacy_wms_shipment_item_id,fulfillment_plan_line_id,quantity_shipped,shipment_item_purpose)
        VALUES (901,701,NULL,801,2,'customer_fulfillment');
    `);
    await expect(prepare()).rejects.toMatchObject({ code: "ECHO_COMMAND_CONFLICT" });
    expect((await pool.query("SELECT * FROM oms.channel_fulfillment_receipt_items")).rows).toEqual([]);
  });

  it("holds the authority pin while waiting for an existing WMS lock so activation cannot overtake preparation", async () => {
    const blocker = await pool.connect();
    const activation = await pool.connect();
    let preparation: ReturnType<typeof prepare> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM wms.orders WHERE id=40 FOR UPDATE");
      let reachedWms!: () => void;
      const waitingForWms = new Promise<void>((resolve) => { reachedWms = resolve; });
      statementListener = (query) => { if (query.includes("FOR UPDATE OF ol, w, oi")) reachedWms(); };
      preparation = prepare();
      await waitingForWms;
      await activation.query("BEGIN");
      await activation.query("SET LOCAL lock_timeout='100ms'");
      await expect(activation.query("UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=4"))
        .rejects.toMatchObject({ code: "55P03" });
      await activation.query("ROLLBACK");
      await blocker.query("ROLLBACK");
      await preparation;
      await activation.query("UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=4");
    } finally {
      statementListener = undefined;
      await blocker.query("ROLLBACK"); await activation.query("ROLLBACK");
      blocker.release(); activation.release();
      await preparation?.catch(() => undefined);
    }
  });
});
