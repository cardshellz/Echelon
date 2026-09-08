import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { defaultPurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import { fixtureForeignKeys, fixtureTable } from "./shipment-line-fixture";
import { DEFAULT_PURCHASING_FORECAST_POLICY } from "../../purchasing-forecast-policy";

// Only replace the application database handle and the separate planning-policy
// service. The storage methods, canonical resolver, SQL and transactions are real.
const runtime = vi.hoisted(() => ({
  database: undefined as unknown,
  afterResolution: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../../../db", () => ({ get db() { return runtime.database; } }));
vi.mock("../../purchase-planning-policy.runtime", () => ({
  getPurchasePlanningPolicyService: () => ({
    read: async () => ({ policy: defaultPurchasePlanningPolicy(), revision: 12 }),
  }),
}));
vi.mock("../../../warehouse/settings.resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../warehouse/settings.resolver")>();
  return {
    ...actual,
    // Defer only after the actual resolver's SQL, preserving Drizzle's real
    // transaction and execute contracts while a second connection commits.
    getSettingsForWarehouse: async (...args: Parameters<typeof actual.getSettingsForWarehouse>) => {
      const result = await actual.getSettingsForWarehouse(...args);
      await runtime.afterResolution?.();
      return result;
    },
  };
});
import { procurementMethods } from "../../procurement.storage";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const ownerSchemas = ["inventory", "warehouse", "catalog", "procurement", "wms", "oms", "settings_shadow"];
const tables = [
  schema.warehouseSettings, schema.warehouses, schema.warehouseLocations,
  schema.products, schema.productVariants, schema.productLines, schema.productLineProducts,
  schema.inventoryLevels, schema.inventoryTransactions,
  schema.vendors, schema.vendorProducts, schema.demandEvents, schema.demandEventLines,
  schema.orders, schema.orderItems, schema.omsOrderLines,
  schema.purchaseOrders, schema.purchaseOrderLines,
];

suite.sequential("canonical procurement settings authority in PostgreSQL", () => {
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let ownsSchemas = false;

  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) {
      throw new Error("Settings authority tests require a separate disposable local database.");
    }
    pool = new pg.Pool({ connectionString: url, ssl: false, max: 5, statement_timeout: 10_000,
      options: "-c search_path=settings_shadow,public" });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease.");
    const existing = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])", [ownerSchemas]);
    if (existing.rowCount !== 0) throw new Error("Settings fixture refuses to replace existing schemas.");
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      for (const name of ownerSchemas) await setup.query(`CREATE SCHEMA ${name}`);
      for (const table of tables) await setup.query(fixtureTable(table));
      for (const fk of fixtureForeignKeys(tables)) await setup.query(fk);
      // These three persisted fields are defined by migration 052; the existing
      // projection deliberately preserves them although Drizzle omits them.
      await setup.query(`ALTER TABLE inventory.warehouse_settings
        ADD COLUMN auto_draft_include_order_soon boolean NOT NULL DEFAULT false,
        ADD COLUMN auto_draft_skip_on_open_po boolean NOT NULL DEFAULT true,
        ADD COLUMN auto_draft_skip_no_vendor boolean NOT NULL DEFAULT true,
        ADD UNIQUE (warehouse_code),
        ADD CHECK (rfq_draft_maximum_lines_per_run BETWEEN 1 AND 500);
        CREATE TABLE settings_shadow.warehouse_settings (LIKE inventory.warehouse_settings INCLUDING DEFAULTS)`);
      await setup.query(readFileSync(resolve(process.cwd(), "migrations/228_supplier_sourcing_policies.sql"), "utf8"));
      await setup.query("COMMIT");
      ownsSchemas = true;
    } catch (error) {
      await setup.query("ROLLBACK");
      throw error;
    } finally { setup.release(); }
    runtime.database = drizzle(pool);
  });

  beforeEach(async () => {
    runtime.afterResolution = undefined;
    await pool.query(`TRUNCATE inventory.warehouse_settings, settings_shadow.warehouse_settings,
      warehouse.warehouses RESTART IDENTITY CASCADE;
      INSERT INTO warehouse.warehouses(id,code,name) VALUES
        (4,'LEON','Synthetic LEON'),(5,'LEGACY','Synthetic legacy'),(6,'UNCONFIGURED','Synthetic fallback');
      INSERT INTO inventory.warehouse_settings(id,warehouse_id,warehouse_code,warehouse_name,
        velocity_lookback_days,purchasing_forecast_short_window_days,purchasing_forecast_long_window_days,
        purchasing_forecast_seasonal_window_days,purchasing_forward_demand_horizon_days,
        auto_draft_mode,auto_draft_include_order_soon,rfq_draft_automation_mode) VALUES
        (4,4,'LEON','Synthetic LEON',60,20,180,60,180,'draft_po',false,'preferred_vendor'),
        (1,NULL,'DEFAULT','Synthetic global',30,9,120,21,45,'review_only',true,'manual'),
        (5,NULL,'LEGACY','Synthetic legacy',90,30,365,90,365,'draft_po',false,'preferred_vendor');
      INSERT INTO settings_shadow.warehouse_settings SELECT * FROM inventory.warehouse_settings WHERE id=4;
      INSERT INTO catalog.products(id,sku,name) VALUES(10,'SETTINGS-TEST','Synthetic settings product') ON CONFLICT DO NOTHING;
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant)
        VALUES(100,10,'SETTINGS-EACH','Synthetic unit',1) ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    try {
      if (ownsSchemas) await pool.query(`DROP SCHEMA ${ownerSchemas.join(", ")} CASCADE`);
    } finally {
      if (lease) {
        await lease.query("SELECT pg_advisory_unlock(hashtext('echelon.procurement.cost-audit-fixture'))");
        lease.release();
      }
      await pool?.end();
      runtime.database = undefined;
    }
  });

  async function stored(id: number) {
    const result = await pool.query("SELECT * FROM inventory.warehouse_settings WHERE id=$1", [id]);
    return result.rows[0];
  }

  it("uses DEFAULT for both real global reads despite conflicting warehouse and search-path rows", async () => {
    const settings = await procurementMethods.getAutoDraftSettings();
    expect(settings).toMatchObject({ autoDraftMode: "review_only", includeOrderSoon: true,
      rfqDraftAutomationMode: "manual", planningPolicyRevision: 12,
      forecastPolicy: { standardWindowDays: 30, shortWindowDays: 9, longWindowDays: 120,
        seasonalWindowDays: 21, forwardDemandHorizonDays: 45 } });
    const [row] = await procurementMethods.getReorderAnalysisData(30);
    expect(row).toMatchObject({ product_id: 10, short_window_days: 9, long_window_days: 120,
      seasonal_window_days: 21, forward_demand_horizon_days: 45 });
  });

  it("retains explicit FK, legacy code and DEFAULT fallback precedence", async () => {
    expect((await procurementMethods.getAutoDraftSettings(4)).forecastPolicy.standardWindowDays).toBe(60);
    expect((await procurementMethods.getAutoDraftSettings(5)).forecastPolicy.standardWindowDays).toBe(90);
    expect((await procurementMethods.getAutoDraftSettings(6)).forecastPolicy.standardWindowDays).toBe(30);
    expect((await procurementMethods.getAutoDraftSettings(999)).forecastPolicy.standardWindowDays).toBe(30);
  });

  it("retains normalized defaults when no DEFAULT exists rather than adopting another warehouse", async () => {
    await pool.query("DELETE FROM inventory.warehouse_settings WHERE id=1");
    expect(await procurementMethods.getAutoDraftSettings()).toMatchObject({
      autoDraftMode: "draft_po", includeOrderSoon: false, skipOnOpenPo: true, skipNoVendor: true,
      rfqDraftAutomationMode: "manual", forecastPolicy: DEFAULT_PURCHASING_FORECAST_POLICY,
    });
    const [row] = await procurementMethods.getReorderAnalysisData(30);
    expect(row).toMatchObject({ short_window_days: 7, long_window_days: 90,
      seasonal_window_days: 30, forward_demand_horizon_days: 90 });
  });

  it("updates only DEFAULT for a global change and preserves explicit false and zero fields", async () => {
    const specific = await stored(4);
    const shadow = (await pool.query("SELECT * FROM settings_shadow.warehouse_settings")).rows;
    await procurementMethods.updateAutoDraftSettings(undefined, { autoDraftMode: "draft_po",
      includeOrderSoon: false, skipOnOpenPo: false, skipNoVendor: false, candidateScoreReviewThreshold: 0 });
    expect(await stored(1)).toMatchObject({ auto_draft_mode: "draft_po", auto_draft_include_order_soon: false,
      auto_draft_skip_on_open_po: false, auto_draft_skip_no_vendor: false, recommendation_candidate_score_review_threshold: 0 });
    expect(await stored(4)).toEqual(specific);
    expect((await pool.query("SELECT * FROM settings_shadow.warehouse_settings")).rows).toEqual(shadow);
  });

  it("updates explicit FK and legacy-code targets without changing DEFAULT", async () => {
    const global = await stored(1);
    await procurementMethods.updateAutoDraftSettings(4, { autoDraftMode: "review_only" });
    await procurementMethods.updateAutoDraftSettings(5, { rfqDraftAutomationMode: "manual" });
    expect(await stored(4)).toMatchObject({ auto_draft_mode: "review_only" });
    expect(await stored(5)).toMatchObject({ rfq_draft_automation_mode: "manual" });
    expect(await stored(1)).toEqual(global);
  });

  it("writes a missing warehouse's DEFAULT fallback and leaves absent canonical targets untouched", async () => {
    await procurementMethods.updateAutoDraftSettings(6, { rfqDraftMaximumLinesPerRun: 7 });
    expect(await stored(1)).toMatchObject({ rfq_draft_maximum_lines_per_run: 7 });
    await pool.query("DELETE FROM inventory.warehouse_settings WHERE id=1");
    const specific = await stored(4);
    await procurementMethods.updateAutoDraftSettings(undefined, { autoDraftMode: "review_only" });
    await procurementMethods.updateAutoDraftSettings(999, { autoDraftMode: "review_only" });
    expect(await stored(4)).toEqual(specific);
  });

  it("retains existing enum and RFQ bound validation without modifying rejected fields", async () => {
    const global = await stored(1);
    await procurementMethods.updateAutoDraftSettings(undefined, { autoDraftMode: "unsupported",
      approvalPolicy: "unsupported", rfqDraftAutomationMode: "unsupported", rfqDraftMinimumConfidence: "low",
      rfqDraftMaximumLinesPerRun: 501 });
    expect(await stored(1)).toEqual(global);
  });

  it("rolls back the entire targeted update and propagates a database failure", async () => {
    const global = await stored(1);
    // Native integer conversion rejects this stale-threshold input even though
    // the first assignment in the same UPDATE is otherwise valid.
    await expect(procurementMethods.updateAutoDraftSettings(undefined, { autoDraftMode: "draft_po",
      stalePoThresholds: { reviewPendingWarningDays: "invalid-integer" } })).rejects.toMatchObject({ code: "22P02" });
    expect(await stored(1)).toEqual(global);
  });

  it("keeps resolution and projection in one snapshot during a concurrent settings update", async () => {
    runtime.afterResolution = async () => {
      runtime.afterResolution = undefined;
      await pool.query("UPDATE inventory.warehouse_settings SET auto_draft_mode='draft_po' WHERE id=1");
    };
    expect((await procurementMethods.getAutoDraftSettings()).autoDraftMode).toBe("review_only");
    expect((await procurementMethods.getAutoDraftSettings()).autoDraftMode).toBe("draft_po");
  });

  it("rejects a concurrent target retargeting instead of silently writing the renamed row", async () => {
    runtime.afterResolution = async () => {
      runtime.afterResolution = undefined;
      await pool.query("UPDATE inventory.warehouse_settings SET warehouse_code='RENAMED' WHERE id=1");
    };
    await expect(procurementMethods.updateAutoDraftSettings(undefined, { autoDraftMode: "draft_po" })).rejects.toMatchObject({ code: "40001" });
    expect(await stored(1)).toMatchObject({ warehouse_code: "RENAMED", auto_draft_mode: "review_only" });
    expect(await stored(4)).toMatchObject({ warehouse_code: "LEON", auto_draft_mode: "draft_po" });
  });
});
