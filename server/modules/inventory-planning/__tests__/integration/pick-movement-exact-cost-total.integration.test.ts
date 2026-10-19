import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

// 2026-10-19, C-07 GLV-TOP-130PT-P50: a pick from a lot with exact cost totals
// recorded the lot's exact extended share (not unit x qty) and the old 0647
// CHECK rejected it: availability_claim_pick_movements_cost_chk.

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;
const migrationsDir = resolve(process.cwd(), "migrations");
const migrationFile = readdirSync(migrationsDir).filter(file => file.endsWith("_pick_movement_exact_cost_total.sql"));
const migration = () => readFileSync(resolve(migrationsDir, migrationFile[0]!), "utf8");

// Reduced real shapes: the 0647 cost columns and CHECK, and the 0751 cost link.
const fixtureSql = `
  CREATE SCHEMA IF NOT EXISTS oms;
  CREATE SCHEMA IF NOT EXISTS inventory;
  CREATE TABLE oms.order_item_costs (id integer PRIMARY KEY, qty integer NOT NULL,
    total_cost_mills bigint NOT NULL, cost_quantity_allocation_id bigint);
  CREATE TABLE inventory.availability_claim_pick_movements (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_item_cost_id integer NOT NULL REFERENCES oms.order_item_costs(id),
    movement_type varchar(20) NOT NULL, quantity bigint NOT NULL,
    unit_cost_mills bigint NOT NULL, total_cost_mills bigint NOT NULL,
    CONSTRAINT availability_claim_pick_movements_cost_chk CHECK (
      unit_cost_mills >= 0 AND total_cost_mills = unit_cost_mills * quantity));
`;

describeDatabase.sequential("pick movement cost totals with exact lot costs", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;
  const insert = (costId: number, type: string, quantity: number, unit: number, total: number) => pool.query(
    `INSERT INTO inventory.availability_claim_pick_movements(order_item_cost_id,movement_type,quantity,unit_cost_mills,total_cost_mills)
     VALUES($1,$2,$3,$4,$5)`, [costId, type, quantity, unit, total]);

  beforeAll(async () => {
    expect(migrationFile).toHaveLength(1);
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixtureSql);
    pool = database.pool;
    // Rows that satisfied the old rule must survive the migration unchanged.
    await pool.query("INSERT INTO oms.order_item_costs VALUES(1,3,300,NULL)");
    await insert(1, "pick", 3, 100, 300);
    await pool.query(`BEGIN; ${migration()} COMMIT;`);
    await pool.query(`BEGIN; ${migration()} COMMIT;`); // replay-safe
  }, 60_000);
  beforeEach(async () => {
    await pool.query("TRUNCATE inventory.availability_claim_pick_movements, oms.order_item_costs RESTART IDENTITY CASCADE");
    // Lot of 3 units costing 1000 mills: the rounded unit mirror is 333; one
    // unit's exact share is 334, which is what the pick records.
    await pool.query(`INSERT INTO oms.order_item_costs VALUES
      (10,1,334,77),(11,-1,-334,78),(12,2,666,NULL),(13,1,334,NULL)`);
  });
  afterAll(async () => { await database?.close(); });

  it("accepts an exact-allocation pick and its unpick reversal", async () => {
    await expect(insert(10, "pick", 1, 333, 334)).resolves.toBeDefined();
    await expect(insert(11, "unpick", 1, 333, 334)).resolves.toBeDefined();
  });

  it("still requires total = unit x quantity for a uniform-cost row", async () => {
    await expect(insert(12, "pick", 2, 333, 666)).resolves.toBeDefined();
    await expect(insert(13, "pick", 1, 333, 334)).rejects.toMatchObject({
      code: "23514", constraint: "availability_claim_pick_movements_cost_chk" });
  });

  it("rejects an exact row that does not mirror its linked cost", async () => {
    await expect(insert(10, "pick", 1, 333, 335)).rejects.toMatchObject({ code: "23514" });
    await expect(insert(10, "pick", 2, 333, 334)).rejects.toMatchObject({ code: "23514" });
  });

  it("never accepts a negative cost", async () => {
    await expect(insert(12, "pick", 2, -1, -2)).rejects.toMatchObject({ code: "23514" });
  });
});
