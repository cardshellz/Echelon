import { readFileSync } from "node:fs";
import type { PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;
const source = (path: string) => readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");
const candidateSql = source("migrations/900000053000019980001_identity_access_audit_guard.sql");

/**
 * Execute the exact existing audit-guard SQL, not a second implementation. These
 * two migrations also create unrelated business schema; only their final audit
 * sections belong in this reduced fixture. This is NOT full-schema acceptance.
 */
function auditSection(path: string, functionName: string): string {
  const sql = source(path);
  const marker = `CREATE FUNCTION public.${functionName}()`;
  const start = sql.indexOf(marker);
  if (start < 0 || sql.indexOf(marker, start + marker.length) !== -1) {
    throw new Error(`Expected one existing audit section in ${path}`);
  }
  return sql.slice(start);
}
const existingGuardsSql = [
  source("migrations/900000001000017770001_receiving_integrity_audit_guard.sql"),
  auditSection("migrations/900000003000017710001_procurement_policy_revision.sql", "guard_procurement_settings_audit_history"),
  source("migrations/900000029000019070001_rfq_creation_audit_guard.sql"),
  auditSection("migrations/900000052000019950001_shopify_oauth_authorization_challenges.sql", "guard_shopify_oauth_audit_history"),
].join("\n");

// The current public.audit_events column contract. No other production tables,
// provider calls, credentials, application singleton DB or account grants used.
const auditFixtureSql = `
  CREATE TABLE public.audit_events (
    id bigserial PRIMARY KEY, timestamp timestamptz NOT NULL DEFAULT now(),
    level text NOT NULL DEFAULT 'AUDIT', actor text NOT NULL, action text NOT NULL,
    target text, changes jsonb, context jsonb
  );
  ${existingGuardsSql}
`;
const identityAction = "identity.access.role_permissions_replaced";
const existingProtectedActions = [
  "channels.shopify_oauth.succeeded",
  "procurement.receiving.source_resolved",
  "procurement.settings.updated",
  "purchase_rfq.batch_created",
];

integration("staged identity access audit migration (reduced disposable fixture)", () => {
  let database: InventoryCutoverTestDatabase;
  let client: PoolClient | undefined;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, auditFixtureSql);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    client = await database.pool.connect();
    await client.query("BEGIN");
  });
  afterEach(async () => {
    try { await client?.query("ROLLBACK"); }
    finally { client?.release(); client = undefined; }
  });
  function connection() {
    if (!client) throw new Error("Isolated audit migration transaction is not initialized");
    return client;
  }
  const install = () => connection().query(candidateSql);
  async function insert(action: string) {
    const result = await connection().query<{ id: string }>(
      `INSERT INTO public.audit_events(actor,action,target,changes,context)
       VALUES('synthetic-operator',$1,'role:synthetic','{"before":null,"after":{"roleIds":[1]}}','{"operationId":"synthetic"}') RETURNING id`,
      [action],
    );
    return result.rows[0].id;
  }
  const rows = async () => (await connection().query("SELECT * FROM public.audit_events ORDER BY id")).rows;
  async function rejected(sql: string, values: unknown[] = []) {
    const before = await rows();
    await connection().query("SAVEPOINT rejected_audit_change");
    let error: unknown;
    try { await connection().query(sql, values); }
    catch (caught) { error = caught; }
    finally {
      await connection().query("ROLLBACK TO SAVEPOINT rejected_audit_change");
      await connection().query("RELEASE SAVEPOINT rejected_audit_change");
    }
    expect(error).toMatchObject({ code: "23514" });
    expect(await rows()).toEqual(before);
  }
  async function schemaSnapshot() {
    const query = connection().query.bind(connection());
    return {
      columns: (await query(`SELECT attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,
        pg_get_expr(adbin,adrelid) AS default_expression FROM pg_attribute
        LEFT JOIN pg_attrdef ON adrelid=attrelid AND adnum=attnum
        WHERE attrelid='public.audit_events'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`)).rows,
      constraints: (await query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='public.audit_events'::regclass ORDER BY conname`)).rows,
      indexes: (await query(`SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='audit_events' ORDER BY indexname`)).rows,
      relation: (await query(`SELECT relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class
        WHERE oid='public.audit_events'::regclass`)).rows,
      triggers: (await query(`SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger
        WHERE tgrelid='public.audit_events'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows,
      functions: (await query(`SELECT DISTINCT procedure.proname,procedure.proowner,procedure.proacl,procedure.proconfig,
        pg_get_functiondef(procedure.oid) AS definition FROM pg_trigger
        JOIN pg_proc procedure ON procedure.oid=tgfoid
        WHERE tgrelid='public.audit_events'::regclass AND NOT tgisinternal ORDER BY procedure.proname`)).rows,
    };
  }

  it("preserves existing rows, audit functions/triggers, columns, constraints, indexes and ACLs during upgrade", async () => {
    await insert(identityAction);
    await insert("legacy.unrelated");
    for (const action of existingProtectedActions) await insert(action);
    const beforeRows = await rows();
    const before = await schemaSnapshot();
    await install();
    const after = await schemaSnapshot();
    expect(await rows()).toEqual(beforeRows);
    expect({ ...after, triggers: before.triggers, functions: before.functions }).toEqual(before);
    expect(after.triggers.filter(row => !String(row.tgname).startsWith("identity_access_"))).toEqual(before.triggers);
    expect(after.functions.filter(row => row.proname !== "guard_identity_access_audit_history")).toEqual(before.functions);
    expect(after.triggers).toHaveLength(before.triggers.length + 2);
    expect(after.functions).toHaveLength(before.functions.length + 1);
    expect(after.functions.find(row => row.proname === "guard_identity_access_audit_history"))
      .toMatchObject({ proconfig: ["search_path=pg_catalog"] });
    await rejected("UPDATE public.audit_events SET actor='changed' WHERE action=$1", [identityAction]);
  });

  it.each([identityAction, "identity.access.future_command"])("allows append then protects every field for %s", async action => {
    await install();
    const id = await insert(action);
    const mutations = [
      "id=id+1000", "action='legacy.unrelated'", "actor='changed'", "target='changed'", "level='INFO'",
      "changes='{}'::jsonb", "context='{}'::jsonb", "timestamp=timestamp + interval '1 second'", "action=action",
    ];
    for (const mutation of mutations) await rejected(`UPDATE public.audit_events SET ${mutation} WHERE id=$1`, [id]);
    await rejected("DELETE FROM public.audit_events WHERE id=$1", [id]);
  });

  it("rejects promotion of an existing unrelated row to protected history", async () => {
    await install();
    const id = await insert("legacy.unrelated");
    await rejected("UPDATE public.audit_events SET action=$1 WHERE id=$2", [identityAction, id]);
  });

  it("rejects multirow update/delete and truncate while identity evidence exists", async () => {
    await install();
    await insert("legacy.unrelated");
    await insert(identityAction);
    await rejected("UPDATE public.audit_events SET actor='changed'");
    await rejected("DELETE FROM public.audit_events");
    await rejected("TRUNCATE public.audit_events");
    await rejected("TRUNCATE public.audit_events RESTART IDENTITY CASCADE");
  });

  it.each(existingProtectedActions)("preserves existing guard behavior for %s", async action => {
    await install();
    const id = await insert(action);
    const unrelated = await insert("legacy.unrelated");
    await rejected("UPDATE public.audit_events SET action='legacy.unrelated' WHERE id=$1", [id]);
    await rejected("DELETE FROM public.audit_events WHERE id=$1", [id]);
    await rejected("UPDATE public.audit_events SET action=$1 WHERE id=$2", [action, unrelated]);
    await rejected("TRUNCATE public.audit_events");
  });

  it("retains ordinary update/delete/truncate behavior when no protected evidence exists", async () => {
    await install();
    // Similar spelling is not the owned action prefix.
    const id = await insert("identity.accessory.changed");
    expect((await connection().query("UPDATE public.audit_events SET actor='changed' WHERE id=$1 RETURNING actor", [id])).rows)
      .toEqual([{ actor: "changed" }]);
    expect((await connection().query("DELETE FROM public.audit_events WHERE id=$1", [id])).rowCount).toBe(1);
    await insert("legacy.unrelated");
    await connection().query("TRUNCATE public.audit_events");
    expect(await rows()).toEqual([]);
  });

  it.each(["REPEATABLE READ", "SERIALIZABLE"])("explicitly refuses %s truncate even for empty or unrelated history", async isolation => {
    await connection().query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    await install();
    await rejected("TRUNCATE public.audit_events");
    await insert("legacy.unrelated");
    await rejected("TRUNCATE public.audit_events");
    // The isolation restriction is confined to TRUNCATE, not ordinary rows.
    expect((await connection().query("DELETE FROM public.audit_events WHERE action='legacy.unrelated'")).rowCount).toBe(1);
  });

  it.each(["REPEATABLE READ", "SERIALIZABLE"])("rejects %s truncation after an audit append outside its snapshot", async isolation => {
    // Commit installation in a separate disposable DB: installing a trigger in
    // the per-test transaction would hold a table lock and hide this race.
    const race = await createInventoryCutoverTestDatabase(databaseUrl, true, auditFixtureSql + candidateSql);
    try {
      const stale = await race.pool.connect();
      let error: unknown;
      try {
        await stale.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await stale.query("SET LOCAL statement_timeout='10000ms'");
        // Establish a snapshot without acquiring any lock on the audit table.
        await stale.query("SELECT count(*) FROM pg_catalog.pg_class");
        await race.pool.query("INSERT INTO public.audit_events(actor,action) VALUES('synthetic-concurrent-operator',$1)", [identityAction]);
        try { await stale.query("TRUNCATE public.audit_events"); }
        catch (caught) { error = caught; }
      } finally {
        try { await stale.query("ROLLBACK"); }
        finally { stale.release(); }
      }
      // A rejected unsafe truncate must be explicit, not a deferred assumption
      // that transaction commit or a different guard will happen to save it.
      expect(error).toMatchObject({ code: "23514" });
      expect((await race.pool.query("SELECT action FROM public.audit_events")).rows).toEqual([{ action: identityAction }]);
    } finally { await race.close(); }
  });
});
