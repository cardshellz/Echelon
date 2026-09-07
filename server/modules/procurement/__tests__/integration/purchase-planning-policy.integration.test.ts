import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { purchaseInventorySnapshotQuery } from "../../purchase-inventory-snapshot.query";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPurchaseForecastBacktestingRepository } from "../../purchase-forecast-backtesting.repository";
import { buildPurchaseForecastEvaluation } from "../../purchase-forecast-backtesting.domain";
import { buildPurchasingForecastPolicyCohort } from "../../purchasing-forecast-policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPurchasePlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import { PurchasePlanningPolicyRepository } from "../../purchase-planning-policy.repository";
import { PurchasePlanningPolicyService } from "../../purchase-planning-policy.service";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const suite = url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;

suite.sequential("purchase planning policy PostgreSQL owner", () => {
  let pool: pg.Pool;
  let lease: pg.PoolClient | undefined;
  let ownsProcurement = false;
  let ownsCatalog = false;
  let ownsWms = false;
  let ownsInventory = false;
  let ownsWarehouse = false;
  let service: PurchasePlanningPolicyService;
  const fixedTime = new Date("2026-09-07T12:00:00.000Z");
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
      || [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(url)) throw new Error("Planning tests require a separate local disposable database");
    pool = new pg.Pool({ connectionString: url, max: 6, statement_timeout: 10_000 });
    lease = await pool.connect();
    const lock = await lease.query("SELECT pg_try_advisory_lock(hashtext('echelon.procurement.cost-audit-fixture')) AS acquired");
    if (!lock.rows[0].acquired) throw new Error("Another procurement fixture owns the schema lease");
    await pool.query("CREATE SCHEMA procurement"); ownsProcurement = true;
    await pool.query("CREATE SCHEMA catalog"); ownsCatalog = true;
    await pool.query("CREATE TABLE catalog.products (id integer PRIMARY KEY, sku text, name text NOT NULL, is_active boolean NOT NULL DEFAULT true)");
    await pool.query("INSERT INTO catalog.products(id,sku,name) VALUES (10,'POLICY-10','Policy test item')");
    await pool.query("CREATE TABLE procurement.purchase_forecast_observations (forecast_policy_capture_version integer NOT NULL, forecast_policy_fingerprint varchar(64), forecast_policy_snapshot jsonb)");
    await pool.query("INSERT INTO procurement.purchase_forecast_observations VALUES (1, repeat('a',64), '{\"method\":\"legacy\"}')");
    const migration = readFileSync(resolve(process.cwd(), "migrations/223_purchase_planning_policy.sql"), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    service = new PurchasePlanningPolicyService(new PurchasePlanningPolicyRepository(pool), () => fixedTime);
  });
  afterAll(async () => {
    try {
      if (ownsProcurement) await pool.query("DROP SCHEMA procurement CASCADE");
      if (ownsCatalog) await pool.query("DROP SCHEMA catalog CASCADE");
      if (ownsWms) await pool.query("DROP SCHEMA wms CASCADE");
      if (ownsInventory) await pool.query("DROP SCHEMA inventory CASCADE");
      if (ownsWarehouse) await pool.query("DROP SCHEMA warehouse CASCADE");
    } finally { lease?.release(); await pool?.end(); }
  });
  const save = async (key: string, growthPercent = 25) => service.update({ expectedRevision: (await service.read()).revision, idempotencyKey: key, policy: { ...defaultPurchasePlanningPolicy(), growthPercent } }, "policy-operator");

  it("initializes neutral policy and preserves existing forecast evidence across repeated migrations", async () => {
    expect(await service.read()).toEqual({ revision: 0, policy: defaultPurchasePlanningPolicy() });
    expect((await pool.query("SELECT * FROM procurement.purchase_forecast_observations")).rows).toEqual([{ forecast_policy_capture_version: 1, forecast_policy_fingerprint: "a".repeat(64), forecast_policy_snapshot: { method: "legacy" } }]);
    await pool.query("INSERT INTO procurement.purchase_forecast_observations VALUES (2, repeat('b',64), '{\"growthPercent\":25}')");
    await expect(pool.query("INSERT INTO procurement.purchase_forecast_observations VALUES (3, repeat('c',64), '{}')")).rejects.toMatchObject({ code: "23514" });
  });
  it("writes exact before/after policy and injected actor/time evidence", async () => {
    const result = await save("planning-first-change");
    expect(result).toMatchObject({ revision: 1, reused: false });
    expect((await service.history())[0]).toEqual({ revision: 1, actorId: "policy-operator", changedAt: fixedTime.toISOString(), before: defaultPurchasePlanningPolicy(), after: { ...defaultPurchasePlanningPolicy(), growthPercent: 25 } });
  });
  it("replays a lost response even after another policy change and rejects changed payloads", async () => {
    await save("planning-second-change", 50);
    expect(await service.update({ expectedRevision: 0, idempotencyKey: "planning-first-change", policy: { ...defaultPurchasePlanningPolicy(), growthPercent: 25 } }, "policy-operator")).toMatchObject({ revision: 1, reused: true });
    expect((await service.read()).policy.growthPercent).toBe(50);
    await expect(service.update({ expectedRevision: 0, idempotencyKey: "planning-first-change", policy: defaultPurchasePlanningPolicy() }, "policy-operator")).rejects.toMatchObject({ code: "PLANNING_POLICY_IDEMPOTENCY_CONFLICT" });
  });
  it("serializes concurrent editors so exactly one expected revision succeeds", async () => {
    const expectedRevision = (await service.read()).revision;
    const outcomes = await Promise.allSettled([10, 20].map((growthPercent) => service.update({ expectedRevision, idempotencyKey: `planning-concurrent-${growthPercent}`, policy: { ...defaultPurchasePlanningPolicy(), growthPercent } }, "policy-operator")));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { code: "PLANNING_POLICY_CHANGED" } });
    expect((await service.read()).revision).toBe(expectedRevision + 1);
  });
  it("rolls back the revision and policy together when a later write fails", async () => {
    const before = await service.read();
    const history = await service.history();
    await pool.query("CREATE FUNCTION procurement.policy_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (NEW.policy->>'growthPercent')::int = 666 THEN RAISE EXCEPTION 'synthetic policy write failure'; END IF; RETURN NEW; END; $$");
    await pool.query("CREATE TRIGGER policy_test_failure BEFORE UPDATE ON procurement.purchase_planning_policy FOR EACH ROW EXECUTE FUNCTION procurement.policy_test_failure()");
    await expect(save("planning-failing-write", 666)).rejects.toThrow("synthetic policy write failure");
    expect(await service.read()).toEqual(before);
    expect(await service.history()).toEqual(history);
    await pool.query("DROP TRIGGER policy_test_failure ON procurement.purchase_planning_policy");
  });
  it("rejects history edits and deletion", async () => {
    await expect(pool.query("UPDATE procurement.purchase_planning_policy_revisions SET actor_id = 'rewritten' WHERE revision = 1")).rejects.toThrow("immutable");
    await expect(pool.query("DELETE FROM procurement.purchase_planning_policy_revisions WHERE revision = 1")).rejects.toThrow("immutable");
  });
  it("rejects nonexistent product targets, invalid numbers, and unauthenticated changes without writes", async () => {
    const before = await service.read();
    const policy = { ...defaultPurchasePlanningPolicy(), products: [{ productId: 999, essential: true, minimumStockPieces: 50, targetCoverDays: null, leadTimeStages: null }] };
    await expect(service.update({ expectedRevision: before.revision, idempotencyKey: "planning-missing-product", policy }, "policy-operator")).rejects.toMatchObject({ code: "PLANNING_POLICY_PRODUCT_MISSING" });
    await expect(service.update({ expectedRevision: before.revision, idempotencyKey: "planning-invalid-number", policy: { ...defaultPurchasePlanningPolicy(), growthPercent: "10" } }, "policy-operator")).rejects.toMatchObject({ code: "PLANNING_POLICY_INVALID" });
    await expect(service.update({ expectedRevision: before.revision, idempotencyKey: "planning-no-actor", policy: defaultPurchasePlanningPolicy() }, null)).rejects.toMatchObject({ code: "PLANNING_POLICY_ACTOR_REQUIRED" });
    expect(await service.read()).toEqual(before);
  });
  it("searches products with bound parameters and persists a real essential target", async () => {
    expect(await service.searchProducts("POLICY")).toEqual([{ id: 10, sku: "POLICY-10", name: "Policy test item" }]);
    expect(await service.searchProducts("' OR 1=1 --")).toEqual([]);
    const result = await service.update({ expectedRevision: (await service.read()).revision, idempotencyKey: "planning-essential-product", policy: { ...defaultPurchasePlanningPolicy(), products: [{ productId: 10, essential: true, minimumStockPieces: 100, targetCoverDays: 180, leadTimeStages: null }] } }, "policy-operator");
    expect(result.policy.products[0].essential).toBe(true);
  });
  it("captures replacement policy revisions and evaluates the original v3 evidence after a later policy edit", async () => {
    const migration = readFileSync(resolve(process.cwd(), "migrations/225_purchase_replacement_forecast_capture.sql"), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    const replacementForecasts = [{ productId: 10, startDate: "2026-09-01", endDate: "2026-09-07", totalPieces: 70, reference: "Club launch forecast" }];
    const policy = { ...defaultPurchasePlanningPolicy(), growthPercent: 50,
      products: [{ productId: 10, essential: true, minimumStockPieces: 100, targetCoverDays: 180, leadTimeStages: null }], replacementForecasts };
    const saved = await service.update({ expectedRevision: (await service.read()).revision, idempotencyKey: "planning-replacement-capture", policy }, "policy-operator");
    expect(saved.policy.replacementForecasts).toEqual(replacementForecasts);
    expect((await service.history())[0]).toMatchObject({ actorId: "policy-operator", after: policy });
    const cohort = buildPurchasingForecastPolicyCohort({ growthPercent: 50, replacementForecasts });
    expect(cohort.captureVersion).toBe(3);
    await pool.query(`ALTER TABLE procurement.purchase_forecast_observations
      ADD COLUMN id serial PRIMARY KEY, ADD COLUMN run_id int, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN product_id int, ADD COLUMN product_sku text, ADD COLUMN product_name text,
      ADD COLUMN scope text, ADD COLUMN forecast_method text, ADD COLUMN forecast_version int,
      ADD COLUMN forecast_daily_pieces_micros bigint, ADD COLUMN baseline_daily_pieces_micros bigint,
      ADD COLUMN forward_demand_pieces int, ADD COLUMN forward_demand_raw_pieces int,
      ADD COLUMN overlay_capture_version int, ADD COLUMN overlay_capture_complete boolean,
      ADD COLUMN overlay_planning_as_of_date date, ADD COLUMN overlay_horizon_days int`);
    await pool.query("CREATE TABLE procurement.purchase_recommendation_runs (id int PRIMARY KEY, as_of timestamptz, status text)");
    await pool.query("CREATE TABLE procurement.purchase_forecast_evaluations (id int, observation_id int, evaluation_version int, horizon_days int, evaluated_at timestamptz)");
    await pool.query(`CREATE TABLE procurement.purchase_forecast_overlay_contributions (observation_id int, demand_event_id int,
      demand_event_line_id int, event_start_date date, planning_as_of_date date, expected_pieces int, weighted_pieces int)`);
    await pool.query("CREATE SCHEMA wms"); ownsWms = true;
    await pool.query("CREATE TABLE wms.orders (id int, order_placed_at timestamptz, cancelled_at timestamptz, warehouse_status text)");
    await pool.query("CREATE TABLE wms.order_items (order_id int, sku text, quantity int, status text, requires_shipping int)");
    await pool.query("CREATE TABLE catalog.product_variants (id int, product_id int, sku text, units_per_variant int, is_active boolean)");
    await pool.query("INSERT INTO procurement.purchase_recommendation_runs VALUES (1, '2026-09-01T00:00:00Z', 'completed')");
    const inserted = await pool.query(`INSERT INTO procurement.purchase_forecast_observations
      (run_id, product_id, product_sku, product_name, scope, forecast_method, forecast_version,
       forecast_policy_capture_version, forecast_policy_fingerprint, forecast_policy_snapshot,
       forecast_daily_pieces_micros, baseline_daily_pieces_micros, forward_demand_pieces, forward_demand_raw_pieces,
       overlay_capture_version, overlay_capture_complete, overlay_planning_as_of_date, overlay_horizon_days)
      VALUES (1,10,'POLICY-10','Policy test item','product_all_warehouses',$1,1,3,$2,$3,1500000,1000000,2,2,2,true,'2026-09-01',90) RETURNING id`,
      [cohort.snapshot.method, cohort.fingerprint, JSON.stringify(cohort.snapshot)]);
    await pool.query("INSERT INTO procurement.purchase_forecast_overlay_contributions VALUES ($1,1,1,'2026-09-03','2026-09-01',2,2)", [inserted.rows[0].id]);
    await pool.query("INSERT INTO wms.orders VALUES (1,'2026-09-02',NULL,'shipped')");
    await pool.query("INSERT INTO wms.order_items VALUES (1,'POLICY-10-CASE',7,'shipped',1)");
    await pool.query("INSERT INTO catalog.product_variants VALUES (1,10,'POLICY-10-CASE',10,true)");
    await save("planning-later-policy-change", 200);
    const repository = createPurchaseForecastBacktestingRepository(drizzle(pool));
    expect(await repository.loadPolicyCohorts({ evaluationVersion: 2 })).toMatchObject([{ captureVersion: 3, fingerprint: cohort.fingerprint, snapshot: cohort.snapshot }]);
    const candidates = await repository.loadMaturedCandidates({ asOf: new Date("2026-09-08T00:00:00Z"), horizons: [7], evaluationVersion: 2, limit: 10 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ replacementForecasts, actualDemandPieces: 70, forecastDailyPiecesMicros: 1_500_000 });
    const evaluation = buildPurchaseForecastEvaluation({ candidate: candidates[0], evaluatedAt: new Date("2026-09-08T00:00:00Z"), evaluatedBy: "policy-operator" });
    expect(evaluation).toMatchObject({ forecastDemandMicros: 70_000_000, baselineDemandMicros: 7_000_000,
      overlayAdjustedForecastDemandMicros: 72_000_000, actualDemandPieces: 70 });
    expect((await pool.query("SELECT forecast_policy_snapshot FROM procurement.purchase_forecast_observations WHERE id=$1", [inserted.rows[0].id])).rows[0].forecast_policy_snapshot).toEqual(cohort.snapshot);
  });
  it("excludes quarantine while counting nonpickable reserve stock and its reservations", async () => {
    await pool.query("CREATE SCHEMA inventory"); ownsInventory = true;
    await pool.query("CREATE SCHEMA warehouse"); ownsWarehouse = true;
    await pool.query("CREATE TABLE warehouse.warehouse_locations (id int, location_type text, is_pickable boolean)");
    await pool.query("CREATE TABLE inventory.inventory_levels (product_variant_id int, warehouse_location_id int, variant_qty int, reserved_qty int)");
    await pool.query("INSERT INTO warehouse.warehouse_locations VALUES (1,'pick',true),(2,'reserve',false),(3,'quarantine',false)");
    await pool.query("INSERT INTO inventory.inventory_levels VALUES (1,1,2,1),(1,2,10,2),(1,3,100,30)");
    const result = await drizzle(pool).execute(purchaseInventorySnapshotQuery());
    expect(result.rows).toEqual([{ product_id: 10, total_pieces: "120", total_reserved_pieces: "30", excluded_quarantine_pieces: "1000", variant_count: "1" }]);
  });
});
