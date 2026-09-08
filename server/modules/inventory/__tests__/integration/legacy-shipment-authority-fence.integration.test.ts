import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import type { RecordInventoryShipmentInput } from "../../application/inventory.use-cases";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../fixtures/inventory-cutover-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

// Actual inventory owner and Drizzle inventory repository against reduced named
// schemas. This proves transaction/authority behavior, not historical migrations.
const fixtureSql = `
  CREATE SCHEMA inventory;
  CREATE SCHEMA warehouse;
  CREATE TABLE inventory.availability_runtime_authority (
    singleton_key boolean PRIMARY KEY, authority text, revision bigint, activation_run_id bigint
  );
  CREATE TABLE warehouse.warehouse_locations (
    id integer PRIMARY KEY, warehouse_id integer, is_active integer, is_pickable integer,
    cycle_count_freeze_id integer, location_type text, pick_sequence integer
  );
  CREATE TABLE inventory.inventory_levels (
    id integer PRIMARY KEY, warehouse_location_id integer NOT NULL, product_variant_id integer NOT NULL,
    variant_qty integer NOT NULL, reserved_qty integer NOT NULL, picked_qty integer NOT NULL,
    packed_qty integer NOT NULL DEFAULT 0, backorder_qty integer NOT NULL DEFAULT 0,
    updated_at timestamp NOT NULL DEFAULT now(), CHECK (reserved_qty <= variant_qty)
  );
  CREATE TABLE inventory.inventory_transactions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_variant_id integer, from_location_id integer, to_location_id integer,
    transaction_type varchar(30) NOT NULL, reason_id integer,
    variant_qty_delta integer NOT NULL DEFAULT 0, variant_qty_before integer, variant_qty_after integer,
    reserved_qty_delta integer, batch_id varchar(50), source_state varchar(20), target_state varchar(20),
    unit_cost_cents bigint, unit_cost_mills bigint, total_cost_mills bigint, inventory_lot_id integer,
    order_id integer, order_item_id integer, receiving_order_id integer, receiving_line_id integer,
    cycle_count_id integer, cycle_count_item_id integer, shipment_id integer, shipment_item_id integer,
    build_order_id integer, build_order_component_id integer, reference_type varchar(30), reference_id varchar(100),
    notes text, is_implicit integer NOT NULL DEFAULT 0, user_id varchar(100),
    created_at timestamp NOT NULL DEFAULT now(), build_run_id integer, build_reversal_id integer, voided_at timestamp
  );
  CREATE UNIQUE INDEX ship_item_dedup ON inventory.inventory_transactions (reference_id, shipment_item_id)
    WHERE transaction_type = 'ship';
`;

const command: RecordInventoryShipmentInput = {
  productVariantId: 30, warehouseLocationId: 20, qty: 2, orderId: 40,
  orderItemId: 50, shipmentId: "60", shipmentItemId: 70, userId: "test:shipment",
};

describeDatabase.sequential("legacy shipment authority transaction fence PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  let inventory: InstanceType<typeof import("../../application/inventory.use-cases").InventoryUseCases>;

  beforeAll(async () => {
    process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
    const { InventoryUseCases } = await import("../../application/inventory.use-cases");
    const { createInventoryMethods } = await import("../../infrastructure/inventory.repository");
    const db = drizzle(pool, { schema });
    inventory = new InventoryUseCases(db, createInventoryMethods(db));
  });

  beforeEach(async () => {
    await pool.query(`
      DROP INDEX IF EXISTS inventory.ship_item_dedup_late_test;
      TRUNCATE inventory.inventory_transactions RESTART IDENTITY;
      TRUNCATE inventory.inventory_levels, inventory.availability_runtime_authority, warehouse.warehouse_locations;
      INSERT INTO inventory.availability_runtime_authority VALUES (true, 'legacy', 1, NULL);
      INSERT INTO warehouse.warehouse_locations VALUES (20,1,1,1,NULL,'pick',1);
      INSERT INTO inventory.inventory_levels
        (id,warehouse_location_id,product_variant_id,variant_qty,reserved_qty,picked_qty)
        VALUES (10,20,30,5,3,2);
    `);
  });
  afterAll(async () => { await database?.close(); });

  async function state() {
    return {
      levels: (await pool.query("SELECT variant_qty,reserved_qty,picked_qty FROM inventory.inventory_levels ORDER BY id")).rows,
      ledger: (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows,
    };
  }

  it("retains the legacy picked quantity and ship journal semantics", async () => {
    await inventory.recordShipment(command);
    expect(await state()).toMatchObject({
      levels: [{ variant_qty: 5, reserved_qty: 3, picked_qty: 0 }],
      ledger: [{ transaction_type: "ship", variant_qty_delta: -2, variant_qty_before: 5, variant_qty_after: 5 }],
    });
  });

  it("uses the caller's existing client and leaves commit or rollback to that caller", async () => {
    const before = await state();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.recordShipmentInsideTransaction(command, drizzle(client, { schema }));
      expect((await client.query("SELECT picked_qty FROM inventory.inventory_levels")).rows[0].picked_qty).toBe(0);
      expect(await state()).toEqual(before);
      await client.query("ROLLBACK");
      expect(await state()).toEqual(before);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("rolls back inventory and ledger when later caller work fails", async () => {
    const before = await state();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await inventory.recordShipmentInsideTransaction(command, drizzle(client, { schema }));
      await expect(client.query("SELECT 1/0")).rejects.toMatchObject({ code: "22012" });
      await client.query("ROLLBACK");
      expect(await state()).toEqual(before);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("propagates a late ship uniqueness failure and rolls back the prior balance update", async () => {
    // This deliberately stronger fixture index forces a race-shaped late failure
    // after the ordinary source probe, without bypassing any owner call.
    await pool.query(`INSERT INTO inventory.inventory_transactions
      (transaction_type, reference_id, shipment_item_id) VALUES ('ship','different',999);
      CREATE UNIQUE INDEX ship_item_dedup_late_test ON inventory.inventory_transactions ((1))
        WHERE transaction_type = 'ship';`);
    const before = await state();
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({ code: "23505", constraint: "ship_item_dedup_late_test" });
    expect(await state()).toEqual(before);
  });

  it("keeps activation blocked until the caller transaction releases the authority pin", async () => {
    const shipment = await pool.connect();
    const activation = await pool.connect();
    try {
      await shipment.query("BEGIN");
      await inventory.recordShipmentInsideTransaction(command, drizzle(shipment, { schema }));
      await activation.query("BEGIN");
      await activation.query("SET LOCAL lock_timeout='100ms'");
      await expect(activation.query(`UPDATE inventory.availability_runtime_authority
        SET authority='canonical', activation_run_id=4, revision=revision+1 WHERE singleton_key=true`))
        .rejects.toMatchObject({ code: "55P03" });
      await activation.query("ROLLBACK");
      await shipment.query("COMMIT");
      await activation.query(`UPDATE inventory.availability_runtime_authority
        SET authority='canonical', activation_run_id=4, revision=revision+1 WHERE singleton_key=true`);
      const after = await state();
      await expect(inventory.recordShipment({ ...command, shipmentItemId: 71 }))
        .rejects.toMatchObject({ code: "LEGACY_SHIPMENT_AUTHORITY_DISABLED" });
      expect(await state()).toEqual(after);
    } finally {
      await shipment.query("ROLLBACK"); await activation.query("ROLLBACK");
      shipment.release(); activation.release();
    }
  });

  it("posts only once when two legacy requests race on the same exact source", async () => {
    await Promise.all([inventory.recordShipment(command), inventory.recordShipment(command)]);
    const result = await state();
    expect(result.levels).toEqual([{ variant_qty: 5, reserved_qty: 3, picked_qty: 0 }]);
    expect(result.ledger).toHaveLength(1);
  });

  it.each(["missing", "malformed", "canonical"])("rejects the direct legacy owner for %s authority without effects", async (kind) => {
    if (kind === "missing") await pool.query("DELETE FROM inventory.availability_runtime_authority");
    else await pool.query(`UPDATE inventory.availability_runtime_authority SET authority=$1, activation_run_id=$2`,
      [kind === "canonical" ? "canonical" : "unexpected", kind === "canonical" ? 4 : null]);
    const before = await state();
    await expect(inventory.recordShipment(command)).rejects.toMatchObject({
      code: kind === "canonical" ? "LEGACY_SHIPMENT_AUTHORITY_DISABLED" : "SHIPMENT_RUNTIME_AUTHORITY_INVALID",
    });
    expect(await state()).toEqual(before);
  });

  it("prevents replacement from bypassing canonical authority", async () => {
    await pool.query("UPDATE inventory.availability_runtime_authority SET authority='canonical',activation_run_id=4");
    const before = await state();
    await expect(inventory.recordReplacementShipmentFromAvailableInventory({
      productVariantId: 30, qty: 2, warehouseId: 1, orderId: 40, shipmentId: 60, shipmentItemId: 70,
    })).rejects.toMatchObject({ code: "LEGACY_SHIPMENT_AUTHORITY_DISABLED" });
    expect(await state()).toEqual(before);
  });

  it("retains replacement current unreserved allocation under legacy authority", async () => {
    await expect(inventory.recordReplacementShipmentFromAvailableInventory({
      productVariantId: 30, qty: 2, warehouseId: 1, orderId: 40, shipmentId: 60, shipmentItemId: 70,
    })).resolves.toEqual({ warehouseLocationId: 20, alreadyRecorded: false });
    const result = await state();
    expect(result.levels).toEqual([{ variant_qty: 3, reserved_qty: 3, picked_qty: 2 }]);
    expect(result.ledger.map((row) => row.transaction_type)).toEqual(["pick", "ship"]);
  });
});
