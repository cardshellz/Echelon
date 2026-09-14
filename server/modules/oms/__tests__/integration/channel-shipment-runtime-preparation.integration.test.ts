import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeChannelFulfillmentIngress } from "../../channel-fulfillment-ingress";
import type { ChannelFulfillmentIngressRepository } from "../../channel-fulfillment-ingress.repository";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { InventoryCutoverPreflightService } from "../../../inventory-planning/application/inventory-cutover-preflight.service";
import { PostgresInventoryCutoverPreflightRepository } from "../../../inventory-planning/infrastructure/inventory-cutover-preflight.repository";

// Both repositories below receive the suite's dedicated PostgreSQL pool. Never
// import or connect an ambient application database from this acceptance test.
vi.mock("../../../../db", () => ({ pool: { connect: vi.fn() } }));

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

const providerNonInventoryCutoverFixtureSql = `${fixtureSql}
  ${channelShipmentRuntimeSeedSql}

  ALTER TABLE catalog.product_variants
    ADD COLUMN product_id integer,
    ADD COLUMN sku varchar(100),
    ADD COLUMN is_active boolean,
    ADD COLUMN sales_eligibility varchar(30);
  ALTER TABLE wms.orders
    ADD COLUMN warehouse_id integer,
    ADD COLUMN on_hold integer,
    ADD COLUMN channel_id integer,
    ADD COLUMN source varchar(50),
    ADD COLUMN external_order_id varchar(100),
    ADD COLUMN oms_fulfillment_order_id varchar(100),
    ADD COLUMN fulfillment_partition_key varchar(100);
  ALTER TABLE wms.order_items
    ADD COLUMN source_item_id varchar(100),
    ADD COLUMN sku varchar(100),
    ADD COLUMN product_id integer,
    ADD COLUMN fulfilled_quantity integer,
    ADD COLUMN on_hold boolean,
    ADD COLUMN location varchar(100),
    ADD COLUMN short_reason varchar(100);
  ALTER TABLE wms.outbound_shipments
    ADD COLUMN held boolean NOT NULL DEFAULT false;
  ALTER TABLE wms.outbound_shipment_items
    ADD COLUMN replacement_for_order_item_id integer,
    ADD COLUMN correction_for_shipment_item_id integer;
  ALTER TABLE wms.physical_shipment_items
    ADD COLUMN wms_order_item_id integer,
    ADD COLUMN replacement_for_order_item_id integer,
    ADD COLUMN package_allocation_entry_id bigint,
    ADD COLUMN product_variant_id integer,
    ADD COLUMN sku varchar(100);
  ALTER TABLE inventory.inventory_levels
    ADD COLUMN id integer,
    ADD COLUMN reserved_qty integer NOT NULL DEFAULT 0,
    ADD COLUMN picked_qty integer NOT NULL DEFAULT 0,
    ADD COLUMN packed_qty integer NOT NULL DEFAULT 0;

  CREATE TABLE inventory.build_orders (
    id integer PRIMARY KEY, status varchar(20) NOT NULL, warehouse_id integer NOT NULL
  );
  CREATE TABLE inventory.build_order_components (
    id integer PRIMARY KEY, build_order_id integer NOT NULL,
    component_variant_id integer NOT NULL, source_location_id integer
  );
  CREATE TABLE inventory.inventory_lots (
    id integer PRIMARY KEY, product_variant_id integer NOT NULL,
    warehouse_location_id integer NOT NULL, qty_reserved integer NOT NULL
  );
  CREATE TABLE inventory.build_component_reservations (
    id integer PRIMARY KEY, build_order_component_id integer NOT NULL,
    inventory_lot_id integer NOT NULL, reserved_qty integer NOT NULL,
    consumed_qty integer NOT NULL, released_qty integer NOT NULL,
    reservation_owner varchar(30) NOT NULL,
    availability_claim_id bigint, availability_claim_lot_allocation_id bigint
  );
  CREATE TABLE inventory.availability_claims (
    id bigint PRIMARY KEY, status varchar(30) NOT NULL, order_id integer NOT NULL
  );
  CREATE TABLE inventory.availability_claim_lines (
    id bigint PRIMARY KEY, claim_id bigint NOT NULL,
    order_item_id integer NOT NULL, target_variant_id integer NOT NULL
  );
  CREATE TABLE inventory.availability_claim_resources (
    id bigint PRIMARY KEY, claim_id bigint NOT NULL, claim_line_id bigint NOT NULL,
    warehouse_id integer NOT NULL, warehouse_location_id integer NOT NULL,
    inventory_level_id integer NOT NULL, source_variant_id integer NOT NULL,
    claimed_qty bigint NOT NULL, released_qty bigint NOT NULL,
    consumed_qty bigint NOT NULL, picked_qty bigint NOT NULL
  );
  CREATE TABLE inventory.availability_claim_lot_allocations (
    id bigint PRIMARY KEY, claim_id bigint NOT NULL, claim_resource_id bigint NOT NULL,
    inventory_lot_id integer NOT NULL, claimed_qty bigint NOT NULL,
    released_qty bigint NOT NULL, consumed_qty bigint NOT NULL, picked_qty bigint NOT NULL
  );
  CREATE TABLE wms.physical_shipment_item_quantity_adjustments (
    physical_shipment_item_id bigint PRIMARY KEY, quantity_delta integer NOT NULL
  );

  UPDATE catalog.product_variants
  SET product_id=300,sku='SKU-30',is_active=true,sales_eligibility='sellable',
      requires_shipping=false,track_inventory=false
  WHERE id=30;
  UPDATE oms.oms_order_lines SET requires_shipping=false WHERE id=12;
  UPDATE wms.orders
  SET warehouse_id=4,warehouse_status='ready',on_hold=0,channel_id=36,
      source='shopify',external_order_id='101'
  WHERE id=40;
  UPDATE wms.order_items
  SET source_item_id='line-1',sku='SKU-30',product_id=30,
      fulfilled_quantity=2,on_hold=false,status='completed',requires_shipping=0
  WHERE id=50;
`;

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
  async function configureNonInventoryLine() {
    await pool.query(`
      UPDATE oms.oms_order_lines SET requires_shipping=false WHERE id=12;
      UPDATE wms.order_items SET requires_shipping=0,status='completed' WHERE id=50;
      UPDATE catalog.product_variants SET requires_shipping=false,track_inventory=false WHERE id=30;
    `);
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

  it.each(["legacy", "canonical"])("records %s provider fulfillment for a non-inventory line without posting inventory", async (authority) => {
    if (authority === "canonical") await canonical();
    await configureNonInventoryLine();

    const result = await prepare();

    expect(result.inventoryItems).toEqual([]);
    expect((await pool.query(`SELECT item.order_item_id,item.product_variant_id,item.qty,item.from_location_id,
      shipment.requires_review,shipment.review_reason
      FROM wms.outbound_shipment_items item
      JOIN wms.outbound_shipments shipment ON shipment.id=item.shipment_id`)).rows).toEqual([{
      order_item_id: 50,
      product_variant_id: 30,
      qty: 2,
      from_location_id: null,
      requires_review: false,
      review_reason: null,
    }]);
    expect((await pool.query("SELECT channel_order_line_id,wms_order_item_id FROM oms.channel_fulfillment_receipt_items")).rows)
      .toEqual([{ channel_order_line_id: "line-1", wms_order_item_id: 50 }]);
  });

  it("accepts a canonical non-inventory package without inventing inventory source lineage", async () => {
    await canonical();
    await configureNonInventoryLine();
    await pool.query(`
      INSERT INTO wms.physical_shipments (id,provider,provider_physical_shipment_id,status)
        VALUES (701,'shopify','201','shipped');
      INSERT INTO wms.fulfillment_plan_lines VALUES (801,12);
      INSERT INTO wms.physical_shipment_items
        (id,physical_shipment_id,legacy_wms_shipment_item_id,fulfillment_plan_line_id,quantity_shipped,shipment_item_purpose)
        VALUES (901,701,NULL,801,2,'customer_fulfillment');
    `);

    const result = await prepare();

    expect(result).toMatchObject({ physicalShipmentId: 701, inventoryItems: [] });
    expect((await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows).toEqual([]);
    expect((await pool.query("SELECT physical_shipment_item_id FROM oms.channel_fulfillment_receipt_items")).rows)
      .toEqual([{ physical_shipment_item_id: 901 }]);
  });

  it("fails closed before package writes when OMS, WMS, and catalog shipping facts conflict", async () => {
    await pool.query("UPDATE oms.oms_order_lines SET requires_shipping=false WHERE id=12");

    await expect(prepare()).rejects.toMatchObject({
      code: "INVENTORY_CONFIGURATION_CONFLICT",
      context: { reasons: ["wms_requires_shipping_true", "oms_requires_shipping_false", "catalog_requires_shipping_true"] },
    });
    expect((await pool.query("SELECT * FROM wms.outbound_shipments")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM wms.outbound_shipment_items")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM oms.channel_fulfillment_receipt_items")).rows).toEqual([]);
  });

  it("closes only receipt-owned review exceptions when a replay completes successfully", async () => {
    await pool.query(`
      INSERT INTO wms.reconciliation_exceptions
        (classification,status,severity,idempotency_key,updated_at)
      VALUES
        ('manual_review','open','review','channel_fulfillment_ingress:91:inventory_record_failed:1',NOW()),
        ('manual_review','open','review','channel_fulfillment_ingress:92:inventory_record_failed:1',NOW());
    `);

    await repository.completeReceipt({
      receiptId: 91,
      leaseToken: "lease-1",
      processingStatus: "processed",
      completedAt: now,
    });

    expect((await pool.query(`SELECT idempotency_key,classification,status,severity,resolved_by,resolution
      FROM wms.reconciliation_exceptions ORDER BY id`)).rows).toEqual([
      {
        idempotency_key: "channel_fulfillment_ingress:91:inventory_record_failed:1",
        classification: "safe_auto_repair",
        status: "resolved",
        severity: "info",
        resolved_by: "channel_fulfillment_ingress",
        resolution: "Receipt replay completed after its prior review condition was corrected",
      },
      {
        idempotency_key: "channel_fulfillment_ingress:92:inventory_record_failed:1",
        classification: "manual_review",
        status: "open",
        severity: "review",
        resolved_by: null,
        resolution: null,
      },
    ]);
    expect((await pool.query("SELECT processing_status,error_code,error_message FROM oms.channel_fulfillment_receipts")).rows)
      .toEqual([{ processing_status: "processed", error_code: null, error_message: null }]);
    expect((await pool.query("SELECT attempt_number,outcome FROM oms.channel_fulfillment_receipt_attempts")).rows)
      .toEqual([{ attempt_number: 1, outcome: "processed" }]);
  });

  it("leaves receipt-owned exceptions open when the current attempt still requires review", async () => {
    await pool.query(`INSERT INTO wms.reconciliation_exceptions
      (classification,status,severity,idempotency_key,updated_at)
      VALUES ('manual_review','open','review','channel_fulfillment_ingress:91:inventory_record_failed:1',NOW())`);

    await repository.completeReceipt({
      receiptId: 91,
      leaseToken: "lease-1",
      processingStatus: "review",
      errorCode: "INVENTORY_RECORD_FAILED",
      errorMessage: "Inventory is still unresolved",
      completedAt: now,
    });

    expect((await pool.query(`SELECT classification,status,severity,resolved_at,resolved_by,resolution
      FROM wms.reconciliation_exceptions`)).rows).toEqual([{
      classification: "manual_review",
      status: "open",
      severity: "review",
      resolved_at: null,
      resolved_by: null,
      resolution: null,
    }]);
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

describeDatabase.sequential("provider non-inventory fulfillment cutover acceptance PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let repository: ChannelFulfillmentIngressRepository;

  const inventoryWriterTables = [
    "inventory.inventory_transactions",
    "inventory.inventory_levels",
    "inventory.build_orders",
    "inventory.build_order_components",
    "inventory.inventory_lots",
    "inventory.build_component_reservations",
    "inventory.availability_claims",
    "inventory.availability_claim_lines",
    "inventory.availability_claim_resources",
    "inventory.availability_claim_lot_allocations",
  ] as const;
  const preflightObservedTables = [
    ...inventoryWriterTables,
    "inventory.availability_runtime_authority",
    "catalog.product_variants",
    "wms.orders",
    "wms.order_items",
    "wms.outbound_shipments",
    "wms.outbound_shipment_items",
    "wms.physical_shipments",
    "wms.physical_shipment_items",
    "wms.physical_shipment_item_quantity_adjustments",
  ] as const;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    database = await createInventoryCutoverTestDatabase(
      databaseUrl,
      disposable,
      providerNonInventoryCutoverFixtureSql,
    );
    pool = database.pool;
    const { createChannelFulfillmentIngressRepository } = await import("../../channel-fulfillment-ingress.repository");
    repository = createChannelFulfillmentIngressRepository(drizzle(pool));
  });

  afterAll(async () => { await database?.close(); });

  async function snapshot(tables: readonly string[]) {
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      result[table] = (await pool.query(
        `SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`,
      )).rows;
    }
    return result;
  }

  function connectedPreflight() {
    const trace: string[] = [];
    let releaseCount = 0;
    const tracedPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            trace.push(sql);
            return client.query(sql, values);
          },
          release: (error?: Error) => {
            releaseCount += 1;
            client.release(error);
          },
        };
      },
    } as unknown as Pick<Pool, "connect">;
    return {
      service: new InventoryCutoverPreflightService(
        new PostgresInventoryCutoverPreflightRepository(tracedPool),
      ),
      trace,
      releaseCount: () => releaseCount,
    };
  }

  async function materializeProviderPackage(sourceShipmentItemId: number) {
    const client = await pool.connect();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      await client.query(`INSERT INTO wms.physical_shipments
        (id,provider,provider_physical_shipment_id,status,tracking_number)
        VALUES (701,'shopify','201','shipped',NULL)`);
      await client.query(`INSERT INTO wms.fulfillment_plan_lines (id,oms_order_line_id)
        VALUES (801,12)`);
      await client.query(`INSERT INTO wms.physical_shipment_items
        (id,physical_shipment_id,legacy_wms_shipment_item_id,fulfillment_plan_line_id,
         quantity_shipped,shipment_item_purpose,wms_order_item_id,
         replacement_for_order_item_id,package_allocation_entry_id,product_variant_id,sku)
        VALUES (901,701,$1,801,2,'customer_fulfillment',50,NULL,NULL,30,'SKU-30')`,
      [sourceShipmentItemId]);
      await client.query("COMMIT");
      began = false;
    } catch (error) {
      if (began) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("carries actual non-inventory ingress evidence into read-only no-inventory-demand preflight", async () => {
    const inventoryBeforeIngress = await snapshot(inventoryWriterTables);

    const prepared = await repository.prepareReceipt(91, input, "lease-1", now);

    expect(prepared.inventoryItems).toEqual([]);
    expect(await snapshot(inventoryWriterTables)).toEqual(inventoryBeforeIngress);
    const sourceRows = (await pool.query<{
      id: number;
      order_item_id: number;
      product_variant_id: number;
      qty: number;
      from_location_id: number | null;
    }>(`SELECT id,order_item_id,product_variant_id,qty,from_location_id
        FROM wms.outbound_shipment_items ORDER BY id`)).rows;
    expect(sourceRows).toEqual([expect.objectContaining({
      order_item_id: 50,
      product_variant_id: 30,
      qty: 2,
      from_location_id: null,
    })]);
    await materializeProviderPackage(sourceRows[0]!.id);

    const beforePreflight = await snapshot(preflightObservedTables);
    const { service, trace, releaseCount } = connectedPreflight();
    const report = await service.preview("acceptance-test");

    expect(report.lines).toEqual([expect.objectContaining({
      orderId: 40,
      orderItemId: 50,
      sku: "SKU-30",
      disposition: "no_inventory_demand",
      candidateDemandQty: "0",
      findingCodes: [],
    })]);
    expect(report.summary.noInventoryDemandLines).toBe(1);
    expect(report.findings).toEqual([]);
    expect(await snapshot(preflightObservedTables)).toEqual(beforePreflight);
    expect(trace[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(trace.at(-1)).toBe("COMMIT");
    expect(trace.some((sql) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|pg_advisory)\b/i.test(sql))).toBe(false);
    expect(releaseCount()).toBe(1);
  });
});
