import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";
import { assertReceivingCustodyCountable } from "../../application/receiving-custody-count-guard";
import { costEvidenceTransactionFromPg } from "../../infrastructure/cost-evidence-pg";
import { lockReceivingCustodyFence } from "../../../procurement/receiving-custody-public";
import { PostgresCanonicalClaimInventoryRepository } from "../../infrastructure/canonical-claim-inventory.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const enabled = !!databaseUrl && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const run = enabled ? describe : describe.skip;
const identity = { productVariantId: 101, warehouseLocationId: 2 };
const schema = `
  CREATE SCHEMA procurement; CREATE SCHEMA catalog; CREATE SCHEMA warehouse; CREATE SCHEMA inventory;
  CREATE TABLE warehouse.warehouses(id integer PRIMARY KEY);
  CREATE TABLE warehouse.warehouse_locations(id integer PRIMARY KEY, warehouse_id integer NOT NULL,location_type text DEFAULT 'bin');
  CREATE TABLE catalog.products(id integer PRIMARY KEY);
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL,UNIQUE(id,product_id));
  CREATE TABLE procurement.purchase_order_lines(id integer PRIMARY KEY);
  CREATE TABLE procurement.inbound_shipment_lines(id integer PRIMARY KEY);
  CREATE TABLE procurement.receiving_orders(id integer PRIMARY KEY,warehouse_id integer,purchase_order_id integer,inbound_shipment_id integer,status text);
  CREATE TABLE procurement.receiving_lines(id integer PRIMARY KEY,receiving_order_id integer,product_id integer,product_variant_id integer,
    units_per_variant_snapshot integer,purchase_order_line_id integer,inbound_shipment_line_id integer,received_qty integer,damaged_qty integer,
    expected_qty integer,putaway_complete integer,putaway_location_id integer);
  CREATE TABLE inventory.inventory_levels(id integer PRIMARY KEY,product_variant_id integer,warehouse_location_id integer,variant_qty integer,reserved_qty integer);
  INSERT INTO warehouse.warehouses VALUES(1);
  INSERT INTO warehouse.warehouse_locations(id,warehouse_id) VALUES(2,1),(3,1);
  INSERT INTO catalog.products VALUES(10),(20);
  INSERT INTO catalog.product_variants VALUES(101,10),(102,10),(201,20);
  INSERT INTO procurement.receiving_orders VALUES(77,1,NULL,NULL,'open');
  INSERT INTO procurement.receiving_lines VALUES(78,77,10,101,1,NULL,NULL,8,0,10,0,2);
  INSERT INTO inventory.inventory_levels VALUES(11,101,2,8,0);
`;

run.sequential("Receiving custody count protection with real PostgreSQL snapshots", () => {
  let database: InventoryCutoverTestDatabase;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, schema);
    await database.pool.query(readFileSync(resolve(process.cwd(), "migrations/pending/receiving_quarantine.sql"), "utf8"));
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  // The migration's immutable observation contract is installed above. This
  // fixture records custody directly; workflow acceptance is tested separately.
  async function observe(client: PoolClient, productId: number | null = 10): Promise<void> {
    await lockReceivingCustodyFence(costEvidenceTransactionFromPg(client), "write");
    await client.query(`INSERT INTO procurement.receiving_quarantine_observations
      (receiving_order_id,receiving_line_id,warehouse_id,holding_location_id,product_id,product_variant_id,
       units_per_variant_snapshot,description,observed_sku,unit_label,condition,observed_qty,reason,evidence_reference,actor_id,recorded_at,
       command_key,source_evidence)
      VALUES(77,$1,1,2,$2,$3,$4,'Observed goods','SKU-1','each','damaged',2,'Counted damaged goods','photo:1','operator',$5,
       'observation:1','{}'::jsonb)`,
    [productId === null ? null : 78, productId, productId === null ? null : 101, productId === null ? null : 1, new Date("2026-10-14T12:00:00Z")]);
  }

  it("blocks both packs of a held product while allowing unrelated stock and locations", async () => {
    await transaction(client => observe(client));
    for (const productVariantId of [101, 102]) {
      await expect(transaction(client => assertReceivingCustodyCountable(client, { ...identity, productVariantId })))
        .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_COUNT_CONFLICT", context: { receivingOrderIds: [77] } });
    }
    await transaction(client => assertReceivingCustodyCountable(client, { ...identity, productVariantId: 201 }));
    await transaction(client => assertReceivingCustodyCountable(client, { ...identity, warehouseLocationId: 3 }));
  });

  it("blocks the entire location for unidentified goods", async () => {
    await transaction(client => observe(client, null));
    await expect(transaction(client => assertReceivingCustodyCountable(client, { ...identity, productVariantId: 201 })))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_COUNT_CONFLICT" });
  });

  it("preserves the observed base product when catalog editing attempts to reparent its variant", async () => {
    await transaction(client => observe(client));
    await expect(database.pool.query("UPDATE catalog.product_variants SET product_id=20 WHERE id=101"))
      .rejects.toMatchObject({ code: "23503" });
    await expect(transaction(client => assertReceivingCustodyCountable(client, identity)))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_COUNT_CONFLICT" });
  });

  it.each([10, null])("keeps prepared acceptance from observed product %s in custody with pinned catalog identity until normal close", async productId => {
    await transaction(client => observe(client, productId));
    await transaction(async client => {
      await lockReceivingCustodyFence(costEvidenceTransactionFromPg(client), "write");
      await client.query(`
        INSERT INTO procurement.receiving_orders VALUES(88,1,NULL,NULL,'open');
        INSERT INTO procurement.receiving_lines VALUES(89,88,10,101,1,NULL,NULL,2,0,2,0,2);
        INSERT INTO procurement.receiving_quarantine_acceptances
          (observation_id,receiving_order_id,receiving_line_id,observation_qty,product_id,product_variant_id,
           units_per_variant_snapshot,accepted_variant_qty,actor_id,created_at,reason,source_evidence)
          VALUES(1,88,89,2,10,101,1,2,'operator','2026-10-14T12:00:00Z','Reviewed goods','{}'::jsonb);
        INSERT INTO procurement.receiving_quarantine_dispositions
          (observation_id,acceptance_id,kind,observation_qty,actor_id,recorded_at,reason,
           version_before,version_after,command_key,request_evidence)
          VALUES(1,1,'prepare_acceptance',2,'operator','2026-10-14T12:00:00Z','Reviewed goods',
            0,1,'prepare:1','{}'::jsonb);
        UPDATE procurement.receiving_quarantine_observations SET awaiting_receipt_qty=2,version=1 WHERE id=1;
      `);
    });
    await expect(database.pool.query("UPDATE catalog.product_variants SET product_id=20 WHERE id=101"))
      .rejects.toMatchObject({ code: "23503" });
    await expect(transaction(client => assertReceivingCustodyCountable(client, identity)))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_COUNT_CONFLICT" });
  });

  it("rejects a stale serializable snapshot then sees held custody on a fresh transaction", async () => {
    const stale = await database.pool.connect();
    try {
      await stale.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      await stale.query("SELECT revision FROM procurement.receiving_custody_fence WHERE singleton=true");
      await transaction(client => observe(client));
      // No sleeps: the observation and fence update are committed after the
      // first snapshot but before its guard attempts the shared row lock.
      await expect(assertReceivingCustodyCountable(stale, identity)).rejects.toMatchObject({ code: "40001" });
      await stale.query("ROLLBACK");
      await expect(transaction(client => assertReceivingCustodyCountable(client, identity)))
        .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_COUNT_CONFLICT" });
    } finally { await stale.query("ROLLBACK"); stale.release(); }
  });

  it.each([8, 10])("prevents the canonical count writer from approving held physical quantity as %s ordinary units", async countedQty => {
    await transaction(client => observe(client));
    const writer = new PostgresCanonicalClaimInventoryRepository();
    await expect(transaction(client => {
      const input = { client, ...identity, inventoryLevelId: 11, quantityBefore: 8, countedQty,
        cycleCountId: 1, cycleCountItemId: 1, actor: "operator", reason: "Physical count", occurredAt: new Date("2026-10-14T12:00:00Z") };
      return countedQty === 8 ? writer.recordCycleCountNoop(input) : writer.applyCycleCountAdjustment(input);
    })).rejects.toMatchObject({ code: "RECEIVING_CUSTODY_COUNT_CONFLICT" });
    expect((await database.pool.query("SELECT variant_qty FROM inventory.inventory_levels WHERE id=11")).rows).toEqual([{ variant_qty: 8 }]);
  });

  it("fails closed if the caller supplies an autocommit pool", async () => {
    await expect(assertReceivingCustodyCountable(database.pool, identity)).rejects.toMatchObject({ code: "25P01" });
  });

  it("fails closed when the persisted custody fence is missing", async () => {
    await expect(database.pool.query("DELETE FROM procurement.receiving_custody_fence"))
      .rejects.toMatchObject({ code: "23514" });
    // Simulate administrator/migration damage only in this uniquely owned DB;
    // ordinary application deletion is separately proven forbidden above.
    await database.pool.query(`ALTER TABLE procurement.receiving_custody_fence DISABLE TRIGGER USER;
      DELETE FROM procurement.receiving_custody_fence;
      ALTER TABLE procurement.receiving_custody_fence ENABLE TRIGGER USER;`);
    await expect(transaction(client => assertReceivingCustodyCountable(client, identity)))
      .rejects.toMatchObject({ code: "RECEIVING_CUSTODY_FENCE_MISSING" });
  });
});
