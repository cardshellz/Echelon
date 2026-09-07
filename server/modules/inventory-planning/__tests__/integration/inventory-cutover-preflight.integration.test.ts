import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { PostgresInventoryCutoverPreflightRepository } from "../../infrastructure/inventory-cutover-preflight.repository";
import { InventoryCutoverPreflightService } from "../../application/inventory-cutover-preflight.service";

// The actual repository receives the dedicated PostgreSQL pool below. Prevent
// importing an ambient application pool or production environment during tests.
vi.mock("../../../../db", () => ({ pool: { connect: vi.fn() } }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const fixtureTables = [
  "inventory.inventory_levels", "inventory.build_orders", "inventory.build_order_components",
  "inventory.inventory_lots", "inventory.build_component_reservations", "inventory.availability_claims",
  "inventory.availability_claim_lines", "inventory.availability_claim_resources",
  "inventory.availability_claim_lot_allocations", "inventory.availability_runtime_authority",
  "wms.orders", "wms.order_items", "wms.outbound_shipments", "wms.outbound_shipment_items",
  "wms.physical_shipments", "wms.physical_shipment_items", "wms.physical_shipment_item_quantity_adjustments",
  "catalog.product_variants",
] as const;

/** Real connected read path; reduced named-schema fixture, not full migration/trigger proof. */
describeDatabase.sequential("inventory cutover connected preflight PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase | undefined;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable);
    pool = database.pool;
    // Exact queried columns/types from the WMS reader and canonical catalog schema.
    // Unused operational columns and unrelated foreign keys are intentionally absent.
    await pool.query(`
      CREATE SCHEMA wms;
      CREATE SCHEMA catalog;
      CREATE TABLE inventory.availability_runtime_authority (
        singleton_key boolean PRIMARY KEY, authority varchar(20) NOT NULL, revision bigint NOT NULL
      );
      CREATE TABLE catalog.product_variants (
        id integer PRIMARY KEY, product_id integer NOT NULL, sku varchar(100) NOT NULL,
        is_active boolean NOT NULL, requires_shipping boolean NOT NULL,
        track_inventory boolean, sales_eligibility varchar(30) NOT NULL
      );
      CREATE TABLE wms.orders (
        id integer PRIMARY KEY, warehouse_id integer, warehouse_status varchar(30),
        on_hold integer NOT NULL, channel_id integer, source varchar(50), external_order_id varchar(100),
        oms_fulfillment_order_id varchar(100), fulfillment_partition_key varchar(100)
      );
      CREATE TABLE wms.order_items (
        id integer PRIMARY KEY, order_id integer NOT NULL, oms_order_line_id bigint,
        source_item_id varchar(100), sku varchar(100) NOT NULL, product_id integer,
        quantity integer NOT NULL, picked_quantity integer NOT NULL, fulfilled_quantity integer NOT NULL,
        status varchar(30), on_hold boolean NOT NULL, requires_shipping integer NOT NULL,
        location varchar(100), short_reason varchar(100)
      );
      CREATE TABLE wms.outbound_shipments (id integer PRIMARY KEY, order_id integer NOT NULL, status varchar(30), held boolean);
      CREATE TABLE wms.outbound_shipment_items (
        id integer PRIMARY KEY, shipment_id integer NOT NULL, order_item_id integer,
        replacement_for_order_item_id integer, correction_for_shipment_item_id integer,
        product_variant_id integer, qty integer NOT NULL, shipment_item_purpose varchar(30), from_location_id integer
      );
      CREATE TABLE wms.physical_shipments (id bigint PRIMARY KEY, status varchar(30));
      CREATE TABLE wms.physical_shipment_items (
        id bigint PRIMARY KEY, physical_shipment_id bigint NOT NULL, wms_order_item_id integer,
        replacement_for_order_item_id integer, legacy_wms_shipment_item_id integer,
        package_allocation_entry_id bigint, product_variant_id integer, sku varchar(100) NOT NULL,
        quantity_shipped integer NOT NULL, shipment_item_purpose varchar(30)
      );
      CREATE TABLE wms.physical_shipment_item_quantity_adjustments (
        physical_shipment_item_id bigint PRIMARY KEY, quantity_delta integer NOT NULL
      );
    `);
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${fixtureTables.join(", ")}`);
    await pool.query(`
      INSERT INTO inventory.availability_runtime_authority VALUES (true,'legacy',1);
      INSERT INTO inventory.inventory_levels VALUES (10,20,30,12,3,0,0);
      INSERT INTO inventory.build_orders VALUES (3,'released',4);
      INSERT INTO inventory.build_order_components VALUES (2,3,30,20);
      INSERT INTO inventory.inventory_lots VALUES (5,30,20,3);
      INSERT INTO inventory.build_component_reservations VALUES (1,2,5,4,1,0,'build_order',NULL,NULL);
      INSERT INTO catalog.product_variants VALUES (30,300,'TEST-P5',true,true,true,'sellable');
      INSERT INTO wms.orders VALUES
        (6,4,'ready',0,36,'shopify','external-6',NULL,NULL),
        (12,4,'shipped',0,36,'shopify','external-12',NULL,NULL);
      INSERT INTO wms.order_items VALUES (7,6,700,'source-7','TEST-P5',30,5,0,0,'pending',false,1,'A1',NULL);
    `);
  });

  afterAll(async () => { await database?.close(); });

  function connectedService(hook?: (sql: string, client: PoolClient) => Promise<void>) {
    const trace: string[] = [];
    let releaseCount = 0;
    const tracedPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, values?: unknown[]) => {
            trace.push(sql);
            const result = await client.query(sql, values);
            await hook?.(sql, client);
            return result;
          },
          release: (error?: Error) => { releaseCount += 1; client.release(error); },
        };
      },
    } as unknown as Pick<Pool, "connect">;
    const repository = new PostgresInventoryCutoverPreflightRepository(tracedPool);
    return { service: new InventoryCutoverPreflightService(repository), trace, releaseCount: () => releaseCount };
  }

  async function snapshotAllFixtureRows() {
    const result: Record<string, unknown> = {};
    for (const table of fixtureTables) {
      result[table] = (await pool.query(`SELECT to_jsonb(row) AS row FROM ${table} row ORDER BY to_jsonb(row)::text`)).rows;
    }
    return result;
  }

  it("uses actual service/repository/domain/owner readers and does not alter any fixture row", async () => {
    const before = await snapshotAllFixtureRows();
    const { service, trace, releaseCount } = connectedService();
    const result = await service.preview("reviewer");
    expect(result).toMatchObject({
      runtimeAuthority: "legacy", authorityRevision: "1", outcome: "evidence_captured",
      operationalWriteAttempted: false, activationReadinessEvaluated: false, excludedTerminalOrderCount: "1",
    });
    expect(result.lines[0]).toMatchObject({ disposition: "unstarted_demand", candidateDemandQty: "5" });
    expect(result.inventoryLevels[0]).toMatchObject({ physicalQty: "12", recordedReservedQty: "3", standaloneBuildOpenQty: "3", unattributedReservedQty: "0" });
    expect(await snapshotAllFixtureRows()).toEqual(before);
    expect(trace[0]).toBe("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(trace.at(-1)).toBe("COMMIT");
    expect(trace.some((sql) => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|pg_advisory)\b/i.test(sql))).toBe(false);
    expect(trace.some((sql) => sql.includes("FROM wms.order_items"))).toBe(true);
    expect(trace.some((sql) => sql.includes("FROM inventory.build_component_reservations"))).toBe(true);
    expect(releaseCount()).toBe(1);
  });

  it("does not equate WMS picker progress with attributed inventory custody", async () => {
    await pool.query("UPDATE wms.order_items SET picked_quantity=2,status='in_progress' WHERE id=7");
    const result = await connectedService().service.preview("reviewer");
    expect(result.lines[0]).toMatchObject({ recordedPickedQty: "2", candidateDemandQty: null, disposition: "review_required" });
    expect(result.lines[0]?.findingCodes).toContain("DEMAND_CUSTODY_RECONCILIATION_REQUIRED");
    expect(result.inventoryLevels[0]).toMatchObject({ physicalQty: "12", pickedQty: "0" });
  });

  it("preserves independent build holds and exposes remaining anonymous reservations", async () => {
    await pool.query("UPDATE inventory.inventory_levels SET reserved_qty=7 WHERE id=10");
    const result = await connectedService().service.preview("reviewer");
    expect(result.inventoryLevels[0]).toMatchObject({
      recordedReservedQty: "7", canonicalOpenQty: "0", standaloneBuildOpenQty: "3", unattributedReservedQty: "4",
    });
    expect(result.findings.map((finding) => finding.code)).toContain("RESERVATION_OWNER_RECONCILIATION_REQUIRED");
    expect((await pool.query("SELECT reserved_qty FROM inventory.inventory_levels WHERE id=10")).rows[0].reserved_qty).toBe(7);
  });

  it("requires external custody review for externally fulfilled progress without claiming it locally", async () => {
    await pool.query("UPDATE wms.orders SET warehouse_status='awaiting_3pl' WHERE id=6");
    await pool.query("UPDATE wms.order_items SET fulfilled_quantity=1 WHERE id=7");
    const result = await connectedService().service.preview("reviewer");
    expect(result.lines[0]).toMatchObject({ candidateDemandQty: null, disposition: "review_required", recordedFulfilledQty: "1" });
    expect(result.lines[0]?.findingCodes).toEqual(expect.arrayContaining([
      "EXTERNAL_FULFILLMENT_REVIEW", "DEMAND_CUSTODY_RECONCILIATION_REQUIRED",
    ]));
  });

  it("retains zero-effective physical history as review evidence, not new unstarted demand", async () => {
    await pool.query(`
      INSERT INTO wms.outbound_shipments VALUES (40,6,'shipped',false);
      INSERT INTO wms.outbound_shipment_items VALUES (41,40,7,NULL,NULL,30,2,'sale',20);
      INSERT INTO wms.physical_shipments VALUES (50,'delivered');
      INSERT INTO wms.physical_shipment_items VALUES (51,50,7,NULL,41,NULL,30,'TEST-P5',2,'sale');
      INSERT INTO wms.physical_shipment_item_quantity_adjustments VALUES (51,-2);
    `);
    const result = await connectedService().service.preview("reviewer");
    expect(result.lines[0]?.candidateDemandQty).toBeNull();
    expect(result.lines[0]?.findingCodes).toContain("DEMAND_CUSTODY_RECONCILIATION_REQUIRED");
  });

  it("shares one repeatable-read snapshot across WMS and inventory when a writer commits between owners", async () => {
    let interleaved = false;
    const { service } = connectedService(async (sql) => {
      if (sql.includes("FROM wms.order_items WHERE") && !interleaved) {
        interleaved = true;
        await pool.query(`
          BEGIN;
          UPDATE wms.order_items SET quantity=9 WHERE id=7;
          UPDATE inventory.inventory_levels SET reserved_qty=8 WHERE id=10;
          UPDATE inventory.build_component_reservations SET reserved_qty=9 WHERE id=1;
          COMMIT;
        `);
      }
    });
    const result = await service.preview("reviewer");
    expect(interleaved).toBe(true);
    expect(result.lines[0]).toMatchObject({ orderedQty: "5", candidateDemandQty: "5" });
    expect(result.inventoryLevels[0]).toMatchObject({ recordedReservedQty: "3", standaloneBuildOpenQty: "3", unattributedReservedQty: "0" });
    expect((await pool.query("SELECT quantity FROM wms.order_items WHERE id=7")).rows[0].quantity).toBe(9);
    expect((await pool.query("SELECT reserved_qty FROM inventory.inventory_levels WHERE id=10")).rows[0].reserved_qty).toBe(8);
  });

  it("rolls back and releases its connection after a real database read error", async () => {
    await pool.query("ALTER TABLE inventory.inventory_levels RENAME TO temporarily_missing_inventory_levels");
    const { service, trace, releaseCount } = connectedService();
    try {
      await expect(service.preview("reviewer")).rejects.toMatchObject({ code: "42P01" });
      expect(trace.at(-1)).toBe("ROLLBACK");
      expect(trace).not.toContain("COMMIT");
      expect(releaseCount()).toBe(1);
    } finally {
      await pool.query("ALTER TABLE inventory.temporarily_missing_inventory_levels RENAME TO inventory_levels");
    }
    await expect(connectedService().service.preview("reviewer")).resolves.toHaveProperty("operationalWriteAttempted", false);
  });

  it("rejects a real oversized demand census and rolls back instead of presenting partial readiness", async () => {
    await pool.query(`INSERT INTO wms.orders (id,warehouse_id,warehouse_status,on_hold)
      SELECT value,4,'ready',0 FROM generate_series(100,10100) value`);
    const { service, trace, releaseCount } = connectedService();
    await expect(service.preview("reviewer")).rejects.toMatchObject({ code: "WMS_CUTOVER_CAPTURE_LIMIT_EXCEEDED" });
    expect(trace.at(-1)).toBe("ROLLBACK");
    expect(trace.some((sql) => sql.includes("FROM inventory.inventory_levels"))).toBe(false);
    expect(releaseCount()).toBe(1);
  });

  it("requires an actor before opening any database transaction", async () => {
    const { service, trace } = connectedService();
    await expect(service.preview(" ")).rejects.toMatchObject({ code: "INVENTORY_CUTOVER_ACTOR_REQUIRED" });
    expect(trace).toEqual([]);
  });
});
