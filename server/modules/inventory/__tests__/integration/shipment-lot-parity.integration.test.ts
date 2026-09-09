import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { InventoryLotService } from "../../lots.service";
import type { RecordInventoryShipmentInput } from "../../application/inventory.use-cases";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";
import { legacyShipmentFixtureSql, shipmentLotFixtureSql } from "../fixtures/legacy-shipment-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const command: RecordInventoryShipmentInput = { productVariantId: 30, warehouseLocationId: 20,
  qty: 2, orderId: 40, orderItemId: 50, shipmentId: "60", shipmentItemId: 70, userId: "test:shipment" };

describeDatabase.sequential("shipment aggregate and lot bucket parity PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let inventory: InstanceType<typeof import("../../application/inventory.use-cases").InventoryUseCases>;

  beforeAll(async () => {
    // The explicit disposable pool owns all IO. The unused ambient import cannot
    // reach application data even when this suite is launched from a developer shell.
    process.env.DATABASE_URL = "postgres://disabled:disabled@127.0.0.1:1/disabled";
    delete process.env.EXTERNAL_DATABASE_URL;
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable,
      legacyShipmentFixtureSql + shipmentLotFixtureSql);
    pool = database.pool;
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const { createInventoryMethods } = await import("../../infrastructure/inventory.repository");
    const db = drizzle(pool, { schema });
    inventory = new InventoryUseCases(db, createInventoryMethods(db), new InventoryLotService(db));
  });
  beforeEach(async () => {
    await pool.query(`
      DROP TRIGGER IF EXISTS omit_shipment_lot ON inventory.inventory_lots;
      DROP INDEX IF EXISTS inventory.reject_shipment_late;
      TRUNCATE inventory.inventory_transactions RESTART IDENTITY;
      TRUNCATE inventory.inventory_lots, inventory.inventory_levels,
        inventory.availability_runtime_authority, warehouse.warehouse_locations;
      INSERT INTO inventory.availability_runtime_authority VALUES (true,'legacy',1,NULL);
      INSERT INTO warehouse.warehouse_locations VALUES (20,1,1,1,NULL,'pick',1);
      INSERT INTO inventory.inventory_levels (id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty)
        VALUES (10,20,30,5,3,2);
      INSERT INTO inventory.inventory_lots VALUES (1,30,20,5,3,2,'2026-01-01','active');
    `);
  });
  afterAll(async () => { await database?.close(); });

  async function state() {
    return {
      levels: (await pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels ORDER BY id")).rows,
      lots: (await pool.query("SELECT id,qty_on_hand,qty_reserved,qty_picked,status FROM inventory.inventory_lots ORDER BY id")).rows,
      journal: (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows,
    };
  }

  it.each([
    { label: "on-hand-only", options: { deductFromOnHandOnly: true }, onHand: 3, reserved: 1, picked: 2, delta: -2 },
    { label: "unreserved concession", options: { deductFromOnHandOnly: true, releaseReservation: false }, onHand: 3, reserved: 3, picked: 2, delta: 0 },
    { label: "picked", options: {}, onHand: 5, reserved: 3, picked: 0, delta: 0 },
    { label: "mixed", options: { qty: 4 }, onHand: 3, reserved: 1, picked: 0, delta: -2 },
  ])("keeps level, lot and reservation journal consistent for $label shipment", async ({ options, onHand, reserved, picked, delta }) => {
    await inventory.recordShipment({ ...command, ...options });
    const result = await state();
    expect(result.levels).toEqual([{ variant_qty: onHand, reserved_qty: reserved, picked_qty: picked }]);
    expect(result.lots).toMatchObject([{ qty_on_hand: onHand, qty_reserved: reserved, qty_picked: picked }]);
    expect(result.journal).toHaveLength(1);
    expect(result.journal[0]).toMatchObject({ reserved_qty_delta: delta, user_id: "test:shipment", shipment_item_id: 70 });
  });
  it.each([
    { bucket: "picked", sql: "UPDATE inventory.inventory_lots SET qty_picked=1", options: {} },
    { bucket: "reserved", sql: "UPDATE inventory.inventory_lots SET qty_reserved=1", options: { deductFromOnHandOnly: true } },
    { bucket: "unreserved", sql: "UPDATE inventory.inventory_lots SET qty_reserved=4", options: { deductFromOnHandOnly: true, releaseReservation: false } },
    { bucket: "missing lots", sql: "DELETE FROM inventory.inventory_lots", options: {} },
  ])("rolls back the aggregate before returning a $bucket lot shortfall", async ({ sql, options }) => {
    await pool.query(sql);
    const before = await state();
    await expect(inventory.recordShipment({ ...command, ...options })).rejects.toMatchObject({ code: "LOT_SHIPMENT_SHORTFALL" });
    expect(await state()).toEqual(before);
  });
  it("does not spend another lot's reservation for an unreserved concession", async () => {
    await pool.query(`UPDATE inventory.inventory_lots SET qty_on_hand=3,qty_reserved=3;
      INSERT INTO inventory.inventory_lots VALUES (2,30,20,2,0,0,'2026-02-01','active');`);
    await inventory.recordShipment({ ...command, deductFromOnHandOnly: true, releaseReservation: false });
    expect((await state()).lots).toEqual([
      { id: 1, qty_on_hand: 3, qty_reserved: 3, qty_picked: 2, status: "active" },
      { id: 2, qty_on_hand: 0, qty_reserved: 0, qty_picked: 0, status: "depleted" },
    ]);
  });
  it("does not let exhausted historical lots exhaust the live-position census bound", async () => {
    await pool.query(`INSERT INTO inventory.inventory_lots
      SELECT n,30,20,0,0,0,'2025-01-01'::timestamp,'depleted' FROM generate_series(2,10002) AS n`);
    await inventory.recordShipment(command);
    expect((await state()).journal).toHaveLength(1);
  });
  it("fails closed when nonempty lot evidence exceeds the complete census bound", async () => {
    await pool.query(`INSERT INTO inventory.inventory_lots
      SELECT n,30,20,0,0,1,'2025-01-01'::timestamp,'active' FROM generate_series(2,10002) AS n`);
    const before = await state();
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "LOT_SHIPMENT_CENSUS_LIMIT" });
    expect(await state()).toEqual(before);
  });
  it("rolls back all level and lot effects when the journal write fails", async () => {
    await pool.query(`INSERT INTO inventory.inventory_transactions (transaction_type,reference_id,shipment_item_id)
      VALUES ('ship','other',99);
      CREATE UNIQUE INDEX reject_shipment_late ON inventory.inventory_transactions ((1)) WHERE transaction_type='ship';`);
    const before = await state();
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "23505" });
    expect(await state()).toEqual(before);
  });
  it("rejects a partial CAS result and rolls back the complete caller transaction", async () => {
    await pool.query(`UPDATE inventory.inventory_lots SET qty_picked=1;
      INSERT INTO inventory.inventory_lots VALUES (2,30,20,0,0,1,'2026-02-01','active');
      CREATE OR REPLACE FUNCTION inventory.omit_lot_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=2 THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER omit_shipment_lot BEFORE UPDATE ON inventory.inventory_lots
        FOR EACH ROW EXECUTE FUNCTION inventory.omit_lot_update();`);
    const before = await state();
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "LOT_SHIPMENT_CONFLICT" });
    expect(await state()).toEqual(before);
  });
  it("serializes identical retries and posts the lot depletion only once", async () => {
    await Promise.all([inventory.recordShipment(command), inventory.recordShipment(command)]);
    const result = await state();
    expect(result.lots[0].qty_picked).toBe(0);
    expect(result.journal).toHaveLength(1);
  });
  it("serializes picked and on-hand-only shipments against the same position", async () => {
    const results = await Promise.allSettled([
      inventory.recordShipment(command),
      inventory.recordShipment({ ...command, qty: 2, shipmentItemId: 71, deductFromOnHandOnly: true }),
    ]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const result = await state();
    expect(result.levels).toEqual([{ variant_qty: 3, reserved_qty: 1, picked_qty: 0 }]);
    expect(result.lots).toMatchObject([{ qty_on_hand: 3, qty_reserved: 1, qty_picked: 0 }]);
    expect(result.journal).toHaveLength(2);
  });
  it("retains caller transaction ownership and lot locks until commit or rollback", async () => {
    const client = await pool.connect();
    const competing = await pool.connect();
    const before = await state();
    try {
      await client.query("BEGIN");
      await inventory.recordShipmentInsideTransaction(command, drizzle(client, { schema }));
      await competing.query("BEGIN");
      await competing.query("SET LOCAL lock_timeout='100ms'");
      await expect(competing.query("UPDATE inventory.inventory_lots SET qty_picked=1 WHERE id=1"))
        .rejects.toMatchObject({ code: "55P03" });
      await competing.query("ROLLBACK");
      expect(await state()).toEqual(before);
      await client.query("ROLLBACK");
      expect(await state()).toEqual(before);
    } finally {
      await client.query("ROLLBACK"); await competing.query("ROLLBACK"); client.release(); competing.release();
    }
  });
  it("keeps the legacy authority gate ahead of any inventory effect", async () => {
    await pool.query("UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=4");
    const before = await state();
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "LEGACY_SHIPMENT_AUTHORITY_DISABLED" });
    expect(await state()).toEqual(before);
  });
});
