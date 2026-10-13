import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { PROCUREMENT_SETTING_KEYS } from "@shared/procurement/procurement-settings";
import { fixtureTable, fixtureForeignKeys } from "../../../procurement/__tests__/integration/shipment-line-fixture";

const runtime = vi.hoisted(() => ({ database: undefined as unknown }));
vi.mock("../../../../db", () => ({ get db() { return runtime.database; } }));
import { replenishmentMethods } from "../../../inventory/infrastructure/replenishment.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const suite = url && disposable ? describe : describe.skip;

suite.sequential("warehouse settings ownership in PostgreSQL", () => {
  let pool: pg.Pool;
  let ownsSchemas = false;
  beforeAll(async () => {
    if (!url || !disposable || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) {
      throw new Error("Warehouse settings tests require an explicitly disposable, separate local database.");
    }
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 5, statement_timeout: 10_000,
      application_name: "warehouse-settings-ownership-test" });
    const existing = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('inventory','warehouse')");
    if (existing.rows.length) throw new Error("Refusing to replace existing inventory/warehouse schemas.");
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      await setup.query("CREATE SCHEMA inventory; CREATE SCHEMA warehouse");
      const tables = [schema.warehouses, schema.warehouseSettings];
      for (const table of tables) await setup.query(fixtureTable(table));
      for (const foreignKey of fixtureForeignKeys(tables)) await setup.query(foreignKey);
      await setup.query("ALTER TABLE inventory.warehouse_settings ADD UNIQUE(warehouse_code)");
      await setup.query("COMMIT");
      ownsSchemas = true;
    } catch (error) { await setup.query("ROLLBACK"); throw error; }
    finally { setup.release(); }
    runtime.database = drizzle(pool, { schema });
  });
  beforeEach(async () => { await pool.query("TRUNCATE inventory.warehouse_settings RESTART IDENTITY"); });
  afterAll(async () => {
    if (!pool) return;
    if (ownsSchemas) await pool.query("DROP SCHEMA inventory CASCADE; DROP SCHEMA warehouse CASCADE");
    await pool.end();
  });

  async function seed(code = "DEFAULT"): Promise<number> {
    const result = await pool.query(`INSERT INTO inventory.warehouse_settings
      (warehouse_code, require_approval, procurement_policy_revision, inline_replen_max_units)
      VALUES ($1, true, 7, 50) RETURNING id`, [code]);
    return result.rows[0].id;
  }
  async function state(id: number) {
    const result = await pool.query("SELECT warehouse_code, warehouse_id, require_approval, procurement_policy_revision, inline_replen_max_units FROM inventory.warehouse_settings WHERE id=$1", [id]);
    return result.rows[0];
  }

  it("rejects every procurement field at direct create/update entrypoints with no partial generic write", async () => {
    const id = await seed();
    const before = await state(id);
    for (const key of [...PROCUREMENT_SETTING_KEYS, "procurementPolicyRevision"]) {
      const patch = { inlineReplenMaxUnits: 0, [key]: key === "procurementPolicyRevision" ? 0 : false };
      await expect(replenishmentMethods.updateWarehouseSettings(id, patch)).rejects.toMatchObject({ code: "PROCUREMENT_SETTINGS_OWNER_REQUIRED" });
      await expect(replenishmentMethods.createWarehouseSettings({ warehouseCode: `NEW-${key}`, ...patch })).rejects.toMatchObject({ code: "PROCUREMENT_SETTINGS_OWNER_REQUIRED" });
    }
    expect(await state(id)).toEqual(before);
    expect((await pool.query("SELECT count(*)::integer AS count FROM inventory.warehouse_settings")).rows[0].count).toBe(1);
  });

  it("allows generic DEFAULT settings updates without changing procurement policy or revision", async () => {
    const id = await seed();
    await replenishmentMethods.updateWarehouseSettings(id, { inlineReplenMaxUnits: 0, warehouseCode: "DEFAULT", warehouseId: null });
    expect(await state(id)).toMatchObject({ warehouse_code: "DEFAULT", warehouse_id: null,
      inline_replen_max_units: 0, require_approval: true, procurement_policy_revision: 7 });
  });

  it("does not commit an existing raw-client transaction supplied by the legacy authority adapter", async () => {
    const id = await seed();
    const client = await pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const transactionDb = drizzle(client, { schema });
      await replenishmentMethods.updateWarehouseSettings(id, { inlineReplenMaxUnits: 0 }, transactionDb);
      await client.query("ROLLBACK");
      expect((await state(id)).inline_replen_max_units).toBe(50);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("protects DEFAULT against rename, warehouse reassignment, deletion and ordinary-row takeover", async () => {
    const id = await seed();
    const ordinary = await seed("NORTH");
    for (const mutation of [
      () => replenishmentMethods.updateWarehouseSettings(id, { warehouseCode: "OLD-DEFAULT" }),
      () => replenishmentMethods.updateWarehouseSettings(id, { warehouseId: 123 }),
      () => replenishmentMethods.deleteWarehouseSettings(id),
      () => replenishmentMethods.updateWarehouseSettings(ordinary, { warehouseCode: "DEFAULT" }),
    ]) await expect(mutation()).rejects.toMatchObject({ code: "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED" });
    expect((await state(id)).warehouse_code).toBe("DEFAULT");
    expect((await state(ordinary)).warehouse_code).toBe("NORTH");
  });

  it("retains safe bootstrap and ordinary warehouse creation/update/deletion", async () => {
    const defaults = await replenishmentMethods.createWarehouseSettings({ warehouseCode: "DEFAULT", warehouseName: "Main Warehouse" });
    expect(defaults.requireApproval).toBe(false);
    const row = await replenishmentMethods.createWarehouseSettings({ warehouseCode: "NORTH", inlineReplenMaxUnits: null, urgentReplenThreshold: 0 });
    expect(row.inlineReplenMaxUnits).toBeNull();
    await replenishmentMethods.updateWarehouseSettings(row.id, { warehouseCode: "WEST", inlineReplenMaxUnits: 0 });
    expect((await state(row.id)).warehouse_code).toBe("WEST");
    expect(await replenishmentMethods.deleteWarehouseSettings(row.id)).toBe(true);
    expect(await replenishmentMethods.deleteWarehouseSettings(row.id)).toBe(false);
  });

  it.each(["update", "delete"] as const)("%s bases its identity guard on the row after a competing transaction commits", async operation => {
    const id = await seed("NORTH");
    const editor = await pool.connect();
    const pending = { current: undefined as Promise<{ error?: unknown }> | undefined };
    try {
      const editorPid = (await editor.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await editor.query("BEGIN");
      await editor.query("UPDATE inventory.warehouse_settings SET warehouse_code='DEFAULT' WHERE id=$1", [id]);
      pending.current = (operation === "update"
        ? replenishmentMethods.updateWarehouseSettings(id, { warehouseCode: "OLD" })
        : replenishmentMethods.deleteWarehouseSettings(id)).then(() => ({}), error => ({ error }));
      // Observe the actual PostgreSQL lock wait before releasing the writer.
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        // The full Drizzle projection can exceed track_activity_query_size
        // before its FROM clause. Inspect the actual blocker PID, not truncated SQL.
        const activity = await pool.query(`SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND $1::integer = ANY(pg_blocking_pids(pid))`, [editorPid]);
        if (activity.rows.length > 0) { blocked = true; break; }
        await delay(20);
      }
      expect(blocked).toBe(true);
      await editor.query("COMMIT");
      expect((await pending.current).error).toMatchObject({ code: "DEFAULT_WAREHOUSE_SETTINGS_PROTECTED" });
      expect((await state(id)).warehouse_code).toBe("DEFAULT");
    } finally {
      await editor.query("ROLLBACK"); editor.release();
      await pending.current;
    }
  });
});
