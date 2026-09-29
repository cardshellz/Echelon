import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { COUNTRY_CODE_ALIASES, ISO_COUNTRY_CODES, parseCountryCode } from "@shared/country-code";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { applyOrderCountryRepair, orderCountryRepairDigest, planOrderCountryRepair, type OrderCountryRepairPlan } from "../../infrastructure/order-country-repair";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
if (databaseUrl && disposable) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl && disposable ? describe.sequential : describe.skip;
const migration = readFileSync("migrations/258_order_country_integrity.sql", "utf8");
const targets = [
  { table: "oms.oms_orders", column: "ship_to_country" },
  { table: "wms.orders", column: "shipping_country" },
  { table: "wms.combined_order_groups", column: "shipping_country" },
] as const;
// Reduced named-schema fixtures retain the production country column types.
// Every country/reference/audit trigger and constraint comes from migration258.
const fixture = `CREATE SCHEMA oms; CREATE SCHEMA wms;
  CREATE TABLE oms.oms_orders(id integer PRIMARY KEY,ship_to_country text,notes text);
  CREATE TABLE oms.oms_order_lines(id integer PRIMARY KEY,order_id integer NOT NULL REFERENCES oms.oms_orders(id));
  CREATE TABLE wms.orders(id integer PRIMARY KEY,shipping_country text,notes text);
  CREATE TABLE wms.combined_order_groups(id integer PRIMARY KEY,shipping_country text,notes text);
  CREATE TABLE public.shopify_orders(id integer PRIMARY KEY,shipping_country text);
  ${targets.map(({ table, column }) => `INSERT INTO ${table}(id,${column},notes) VALUES(1,'United States','legacy'),(2,'Legacy unknown','legacy'),(3,NULL,'legacy');`).join("\n")}
  INSERT INTO public.shopify_orders VALUES(1,'External raw country');`;

integration("staged owned-order country enforcement with real PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let nextId = 100;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixture);
    await database.pool.query(migration);
  }, 30_000);
  afterAll(async () => { await database?.close(); });

  it("does not mutate historical records or the externally written Shopify table, including replay", async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await database.pool.query(migration);
      for (const { table, column } of targets) {
        const result = await database.pool.query(`SELECT ${column} AS country FROM ${table} WHERE id<=3 ORDER BY id`);
        expect(result.rows).toEqual([{ country: "United States" }, { country: "Legacy unknown" }, { country: null }]);
      }
    }
    await database.pool.query("INSERT INTO public.shopify_orders VALUES(2,'Another raw country')");
    expect((await database.pool.query("SELECT shipping_country FROM public.shopify_orders ORDER BY id")).rows)
      .toEqual([{ shipping_country: "External raw country" }, { shipping_country: "Another raw country" }]);
  });

  it("keeps the SQL code/alias reference and normalization behavior aligned with the application", async () => {
    const codes = await database.pool.query("SELECT code FROM oms.order_country_codes ORDER BY code");
    expect(codes.rows.map(row => row.code)).toEqual([...ISO_COUNTRY_CODES].sort());
    const aliases = await database.pool.query("SELECT alias,code FROM oms.order_country_aliases ORDER BY alias");
    expect(Object.fromEntries(aliases.rows.map(row => [row.alias, row.code]))).toEqual(COUNTRY_CODE_ALIASES);
    const values = [...ISO_COUNTRY_CODES, ...Object.keys(COUNTRY_CODE_ALIASES), "México", "Türkiye", " us ", "\tCanada\r\n", "\u00a0United States\uFEFF", "", " \t\n", null];
    const result = await database.pool.query("SELECT value,oms.normalize_order_country(value) AS country FROM unnest($1::text[]) AS input(value)", [values]);
    expect(result.rows.map(row => row.country)).toEqual(values.map(parseCountryCode));
    for (const invalid of ["ZZ", "Atlantis", "america", "virgin islands", "constructor", "uſ", "ıe", "x".repeat(101)]) {
      await expect(database.pool.query("SELECT oms.normalize_order_country($1)", [invalid]))
        .rejects.toMatchObject({ code: "23514", message: "ORDER_COUNTRY_INVALID" });
    }
  });

  it("does not accept Unicode confusables even when callers use ICU case folding", async () => {
    const raw = await database.pool.query(`SELECT upper('uſ' COLLATE "und-x-icu") AS country`);
    expect(raw.rows[0].country).toBe("US");
    for (const invalid of ["uſ", "ıe"]) {
      expect(() => parseCountryCode(invalid)).toThrow();
      await expect(database.pool.query(`SELECT oms.normalize_order_country($1 COLLATE "und-x-icu")`, [invalid]))
        .rejects.toMatchObject({ code: "23514", message: "ORDER_COUNTRY_INVALID" });
    }
    expect((await database.pool.query(`SELECT oms.normalize_order_country('INDIA' COLLATE "tr-x-icu") AS country`)).rows[0].country).toBe("IN");
  });

  it.each(targets)("canonicalizes new/changed country and retains missing data on $table", async ({ table, column }) => {
    for (const [input, expected] of [["United States", "US"], [" ca ", "CA"], ["UK", "GB"], [null, null], ["\t ", null]]) {
      const id = nextId++;
      const inserted = await database.pool.query(`INSERT INTO ${table}(id,${column}) VALUES($1,$2) RETURNING ${column} AS country`, [id, input]);
      expect(inserted.rows[0].country).toBe(expected);
      const updated = await database.pool.query(`UPDATE ${table} SET ${column}='Japan' WHERE id=$1 RETURNING ${column} AS country`, [id]);
      expect(updated.rows[0].country).toBe("JP");
    }
  });

  it.each(targets)("allows unchanged legacy country but rejects new invalid data on $table", async ({ table, column }) => {
    await database.pool.query(`UPDATE ${table} SET notes='ordinary update',${column}=${column} WHERE id IN (1,2,3)`);
    expect((await database.pool.query(`SELECT ${column} AS country FROM ${table} WHERE id<=3 ORDER BY id`)).rows)
      .toEqual([{ country: "United States" }, { country: "Legacy unknown" }, { country: null }]);
    await expect(database.pool.query(`INSERT INTO ${table}(id,${column}) VALUES($1,$2)`, [nextId++, "private arbitrary input"]))
      .rejects.toMatchObject({ code: "23514", message: "ORDER_COUNTRY_INVALID" });
    await expect(database.pool.query(`UPDATE ${table} SET ${column}=$1,notes='must rollback' WHERE id=1`, ["ZZ"]))
      .rejects.toMatchObject({ code: "23514", message: "ORDER_COUNTRY_INVALID" });
    expect((await database.pool.query(`SELECT notes FROM ${table} WHERE id=1`)).rows[0].notes).toBe("ordinary update");
  });

  it("rolls order changes, operation identity, and audit evidence back together after an invalid write", async () => {
    const client = await database.pool.connect();
    const ids = targets.map(() => nextId++);
    for (const [index, { table, column }] of targets.entries()) {
      await database.pool.query(`INSERT INTO ${table}(id,${column}) VALUES($1,'US')`, [ids[index]]);
    }
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO oms.order_country_repair_operations(operation_key,plan_digest,actor) VALUES('rollback',$1,'test')", ["a".repeat(64)]);
      for (const [index, { table, column }] of targets.entries()) {
        await client.query(`UPDATE ${table} SET ${column}='Canada' WHERE id=$1`, [ids[index]]);
        await client.query("INSERT INTO oms.order_country_repairs(operation_key,table_name,row_id,before_country,after_country,actor) VALUES('rollback',$1,$2,'US','CA','test')", [table, ids[index]]);
      }
      await expect(client.query("UPDATE oms.oms_orders SET ship_to_country='bad' WHERE id=$1", [ids[0]])).rejects.toMatchObject({ code: "23514" });
      await client.query("ROLLBACK");
    } finally { await client.query("ROLLBACK"); client.release(); }
    for (const [index, { table, column }] of targets.entries()) {
      expect((await database.pool.query(`SELECT ${column} AS country FROM ${table} WHERE id=$1`, [ids[index]])).rows[0].country).toBe("US");
    }
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs WHERE operation_key='rollback'")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repair_operations WHERE operation_key='rollback'")).rows[0].count).toBe(0);
  });

  it.each(targets)("serializes concurrent guarded updates on $table", async ({ table, column }) => {
    const id = nextId++;
    await database.pool.query(`INSERT INTO ${table}(id,${column}) VALUES($1,'US')`, [id]);
    const first = await database.pool.connect();
    const second = await database.pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`UPDATE ${table} SET ${column}='United Kingdom' WHERE id=$1`, [id]);
      const pid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = second.query(`UPDATE ${table} SET ${column}='Canada' WHERE id=$1 RETURNING ${column} AS country`, [id]);
      // Observe the actual row-lock wait instead of assuming timing proves contention.
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!blocked && Date.now() < deadline) {
        blocked = (await database.pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [pid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await first.query("COMMIT");
      expect((await pending).rows[0].country).toBe("CA");
    } finally { await first.query("ROLLBACK"); first.release(); second.release(); }
  });

  it("enforces immutable, canonical, actor-bound repair evidence and retry uniqueness", async () => {
    await database.pool.query("INSERT INTO oms.order_country_repair_operations(operation_key,plan_digest,actor) VALUES('audit',$1,'test')", ["b".repeat(64)]);
    const insert = "INSERT INTO oms.order_country_repairs(operation_key,table_name,row_id,before_country,after_country,actor) VALUES('audit',$1,1,'United States',$2,$3)";
    await database.pool.query(insert, ["oms.oms_orders", "US", "test"]);
    await expect(database.pool.query(insert, ["oms.oms_orders", "US", "test"])).rejects.toMatchObject({ code: "23505" });
    await expect(database.pool.query(insert, ["wms.orders", "US", "other"])).rejects.toMatchObject({ code: "23503" });
    await expect(database.pool.query(insert, ["wms.orders", "Canada", "test"])).rejects.toMatchObject({ code: "23503" });
    await expect(database.pool.query(insert, ["public.shopify_orders", "US", "test"])).rejects.toMatchObject({ code: "23514" });
    for (const table of ["oms.order_country_repair_operations", "oms.order_country_repairs"]) {
      for (const statement of [`UPDATE ${table} SET actor='other' WHERE operation_key='audit'`, `DELETE FROM ${table} WHERE operation_key='audit'`, `TRUNCATE ${table} CASCADE`]) {
        await expect(database.pool.query(statement)).rejects.toMatchObject({ code: "55000", message: "ORDER_COUNTRY_EVIDENCE_IMMUTABLE" });
      }
    }
    await expect(database.pool.query("INSERT INTO oms.order_country_codes VALUES('ZZ')")).rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("INSERT INTO oms.order_country_aliases VALUES('private arbitrary value','US')")).rejects.toMatchObject({ code: "23514" });
    await database.pool.query(migration);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs WHERE operation_key='audit'")).rows[0].count).toBe(1);
  });
  it("previews unknown historical values as hashes and refuses to apply the plan", async () => {
    const client = await database.pool.connect();
    let plan: OrderCountryRepairPlan;
    try { plan = await planOrderCountryRepair(client); } finally { client.release(); }
    expect(plan.unrecognized).toHaveLength(3);
    expect(JSON.stringify(plan.unrecognized)).not.toContain("Legacy unknown");
    await expect(applyOrderCountryRepair(database.pool, { plan, approvedDigest: orderCountryRepairDigest(plan),
      operationKey: "unknown", actor: "test" })).rejects.toMatchObject({ code: "COUNTRY_REPAIR_UNRECOGNIZED_VALUES" });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repair_operations WHERE operation_key='unknown'")).rows[0].count).toBe(0);
  });
});

integration("approved country repair against the real migration", () => {
  let database: InventoryCutoverTestDatabase;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, fixture.replaceAll("'Legacy unknown'", "'Canada'"));
    await database.pool.query(migration);
    // Country cleanup follows the normal order writer path. Its real Archon
    // projection trigger must participate in the same country/audit transaction.
    await database.pool.query(readFileSync("migrations/0672_archon_order_projection.sql", "utf8"));
  }, 30_000);
  afterEach(async () => { await database?.close(); });

  async function plan() {
    const client = await database.pool.connect();
    try { return await planOrderCountryRepair(client); } finally { client.release(); }
  }
  async function snapshot() {
    return Promise.all(targets.map(async ({ table }) => ({ table, rows: (await database.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows })));
  }
  const options = (input: OrderCountryRepairPlan) => ({ plan: input, approvedDigest: orderCountryRepairDigest(input), operationKey: "repair-test", actor: "admin:test" });

  it("generates a read-only plan, requires its digest, then applies only audited country changes and resumes idempotently", async () => {
    const before = await snapshot();
    const preview = await plan();
    expect(preview.rows).toHaveLength(6);
    expect(preview.unrecognized).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repair_operations")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.archon_order_outbox")).rows[0].count).toBe(0);
    await expect(applyOrderCountryRepair(database.pool, { ...options(preview), approvedDigest: "0".repeat(64) }))
      .rejects.toMatchObject({ code: "COUNTRY_REPAIR_APPROVAL_MISMATCH" });
    expect(await snapshot()).toEqual(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repair_operations")).rows[0].count).toBe(0);
    expect(await applyOrderCountryRepair(database.pool, options(preview))).toEqual({ updated: 6, alreadyCanonical: 0 });
    for (const { table, column } of targets) {
      expect((await database.pool.query(`SELECT id,${column} AS country,notes FROM ${table} ORDER BY id`)).rows)
        .toEqual([{ id: 1, country: "US", notes: "legacy" }, { id: 2, country: "CA", notes: "legacy" }, { id: 3, country: null, notes: "legacy" }]);
    }
    const audit = await database.pool.query("SELECT table_name,row_id::text,before_country,after_country,actor FROM oms.order_country_repairs ORDER BY table_name,row_id");
    expect(audit.rows).toEqual([...preview.rows].sort((a, b) => a.tableName.localeCompare(b.tableName) || Number(a.rowId) - Number(b.rowId))
      .map(row => ({ table_name: row.tableName, row_id: row.rowId, before_country: row.beforeCountry, after_country: row.afterCountry, actor: "admin:test" })));
    const projection = (await database.pool.query("SELECT order_id,revision::text,delivered_revision::text FROM oms.archon_order_outbox ORDER BY order_id")).rows;
    expect(projection.map(row => row.order_id)).toEqual([1, 2]);
    expect(projection.every(row => BigInt(row.revision) > BigInt(0) && row.delivered_revision === "0")).toBe(true);
    expect(await applyOrderCountryRepair(database.pool, options(preview))).toEqual({ updated: 0, alreadyCanonical: 6 });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs")).rows[0].count).toBe(6);
    expect((await database.pool.query("SELECT order_id,revision::text,delivered_revision::text FROM oms.archon_order_outbox ORDER BY order_id")).rows).toEqual(projection);
  });

  it("binds an operation key to the approved plan and actor", async () => {
    const preview = await plan();
    await applyOrderCountryRepair(database.pool, options(preview));
    await expect(applyOrderCountryRepair(database.pool, { ...options(preview), actor: "admin:other" }))
      .rejects.toMatchObject({ code: "COUNTRY_REPAIR_OPERATION_REUSED" });
    const otherPlan = { ...preview, rows: preview.rows.slice(1) };
    await expect(applyOrderCountryRepair(database.pool, options(otherPlan))).rejects.toMatchObject({ code: "COUNTRY_REPAIR_OPERATION_REUSED" });
    expect((await database.pool.query("SELECT actor,plan_digest FROM oms.order_country_repair_operations")).rows)
      .toEqual([{ actor: "admin:test", plan_digest: orderCountryRepairDigest(preview) }]);
  });

  it("rejects a tampered destination even when the supplied plan claims it is approved", async () => {
    const preview = await plan();
    const tampered = { ...preview, rows: preview.rows.map((row, index) => index === 0 ? { ...row, afterCountry: "MX" } : row) };
    const before = await snapshot();
    await expect(applyOrderCountryRepair(database.pool, { ...options(preview), plan: tampered }))
      .rejects.toMatchObject({ code: "COUNTRY_REPAIR_PLAN_INVALID" });
    expect(await snapshot()).toEqual(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repair_operations")).rows[0].count).toBe(0);
  });

  it("waits for a concurrent edit and rejects the changed source before any row in its batch is repaired", async () => {
    const preview = await plan();
    const editor = await database.pool.connect();
    let repairPid: number | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      await editor.query("BEGIN");
      await editor.query("UPDATE oms.oms_orders SET ship_to_country='Japan' WHERE id=1");
      pending = applyOrderCountryRepair({ connect: async () => {
        const client = await database.pool.connect();
        repairPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        return client;
      } }, options(preview)).catch(error => error);
      let blocked = false;
      const deadline = Date.now() + 5_000;
      while (!blocked && Date.now() < deadline) {
        if (repairPid !== undefined) blocked = (await database.pool.query("SELECT cardinality(pg_blocking_pids($1))>0 AS blocked", [repairPid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await editor.query("COMMIT");
      expect(await pending).toMatchObject({ code: "COUNTRY_REPAIR_ROW_CHANGED" });
      expect((await database.pool.query("SELECT ship_to_country FROM oms.oms_orders ORDER BY id")).rows)
        .toEqual([{ ship_to_country: "JP" }, { ship_to_country: "Canada" }, { ship_to_country: null }]);
      expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs")).rows[0].count).toBe(0);
    } finally { await editor.query("ROLLBACK"); editor.release(); await pending; }
  });

  it("rolls back the country changes when durable audit insertion fails", async () => {
    const preview = await plan();
    const before = await snapshot();
    await database.pool.query("INSERT INTO oms.archon_order_outbox(order_id) VALUES(1)");
    const projectionBefore = (await database.pool.query("SELECT * FROM oms.archon_order_outbox ORDER BY order_id")).rows;
    await database.pool.query(`CREATE FUNCTION public.reject_test_country_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='TEST_AUDIT_FAILURE'; END; $$;
      CREATE TRIGGER test_audit_failure BEFORE INSERT ON oms.order_country_repairs
      FOR EACH ROW EXECUTE FUNCTION public.reject_test_country_audit();`);
    await expect(applyOrderCountryRepair(database.pool, options(preview))).rejects.toMatchObject({ code: "23514", message: "TEST_AUDIT_FAILURE" });
    expect(await snapshot()).toEqual(before);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs")).rows[0].count).toBe(0);
    expect((await database.pool.query("SELECT * FROM oms.archon_order_outbox ORDER BY order_id")).rows).toEqual(projectionBefore);
    await database.pool.query("DROP TRIGGER test_audit_failure ON oms.order_country_repairs");
    expect(await applyOrderCountryRepair(database.pool, options(preview))).toEqual({ updated: 6, alreadyCanonical: 0 });
  });

  it("preserves the first committed 500 rows after a later batch failure and resumes with the same approval", async () => {
    // Fixture setup only, on the harness-owned disposable database: seed the
    // historical aliases that would have existed before migrations258/0672.
    await database.pool.query(`BEGIN;
      TRUNCATE oms.oms_orders,wms.orders,wms.combined_order_groups CASCADE;
      ALTER TABLE oms.oms_orders DISABLE TRIGGER order_country_integrity;
      ALTER TABLE oms.oms_orders DISABLE TRIGGER queue_archon_order;
      INSERT INTO oms.oms_orders(id,ship_to_country,notes)
        SELECT id,'United States','legacy' FROM generate_series(1,501) AS rows(id);
      ALTER TABLE oms.oms_orders ENABLE TRIGGER order_country_integrity;
      ALTER TABLE oms.oms_orders ENABLE TRIGGER queue_archon_order;
      COMMIT;`);
    const preview = await plan();
    expect(preview.rows).toHaveLength(501);
    await database.pool.query(`CREATE FUNCTION public.reject_second_country_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='TEST_SECOND_BATCH_FAILURE'; END; $$;
      CREATE TRIGGER test_second_batch_failure BEFORE INSERT ON oms.order_country_repairs
      FOR EACH ROW WHEN (NEW.row_id=501) EXECUTE FUNCTION public.reject_second_country_batch();`);
    await expect(applyOrderCountryRepair(database.pool, options(preview)))
      .rejects.toMatchObject({ code: "23514", message: "TEST_SECOND_BATCH_FAILURE" });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.oms_orders WHERE ship_to_country='US'")).rows[0].count).toBe(500);
    expect((await database.pool.query("SELECT ship_to_country,notes FROM oms.oms_orders WHERE id=501")).rows)
      .toEqual([{ ship_to_country: "United States", notes: "legacy" }]);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs")).rows[0].count).toBe(500);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.archon_order_outbox")).rows[0].count).toBe(500);
    await database.pool.query("DROP TRIGGER test_second_batch_failure ON oms.order_country_repairs");
    expect(await applyOrderCountryRepair(database.pool, options(preview))).toEqual({ updated: 1, alreadyCanonical: 500 });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs")).rows[0].count).toBe(501);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.archon_order_outbox")).rows[0].count).toBe(501);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.oms_orders WHERE ship_to_country='US' AND notes='legacy'")).rows[0].count).toBe(501);
  });

  it("allows two concurrent same-plan retries to commit one audit and projection per corrected row", async () => {
    const preview = await plan();
    const results = await Promise.all([
      applyOrderCountryRepair(database.pool, options(preview)),
      applyOrderCountryRepair(database.pool, options(preview)),
    ]);
    expect(results.reduce((sum, result) => sum + result.updated, 0)).toBe(6);
    expect(results.reduce((sum, result) => sum + result.alreadyCanonical, 0)).toBe(6);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.order_country_repairs")).rows[0].count).toBe(6);
    expect((await database.pool.query("SELECT count(*)::int AS count FROM oms.archon_order_outbox")).rows[0].count).toBe(2);
  });
});
