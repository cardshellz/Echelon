import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { fixtureTable, fixtureForeignKeys } from "./shipment-line-fixture";
import type { FinancialCommandDescriptor } from "../../../../platform/commands/transactional-command.service";

vi.mock("../../../../db", () => ({ db: {} }));
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { createProcurementSettingsCommands, PROCUREMENT_SETTINGS_COMMAND_SCOPE } from "../../procurement-settings.commands";
import { readProcurementSettings } from "../../procurement-settings.repository";

const TEST_URL = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests = TEST_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const NOW = new Date("2026-10-13T12:00:00.000Z");

databaseTests.sequential("procurement policy real PostgreSQL command guarantees", () => {
  let pool: pg.Pool;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let commands: ReturnType<typeof createProcurementSettingsCommands>;
  const tables = [schema.users, schema.authRoles, schema.authPermissions, schema.authUserRoles, schema.authRolePermissions, schema.warehouseSettings];
  const toggle = (expectedRevision = 0) => ({ key: "requireApproval", value: true, expectedRevision });
  const descriptor = (body: unknown, actorId = "editor", key = randomUUID()): FinancialCommandDescriptor => ({
    ...PROCUREMENT_SETTINGS_COMMAND_SCOPE, actorType: "user", actorId, idempotencyKey: key,
    requestHash: createHash("sha256").update(canonicalJson(body)).digest("hex"), contractVersion: 1,
  });
  const update = (body: unknown, actor = "editor", key = randomUUID()) => commands.update(body, actor, descriptor(body, actor, key));
  const snapshot = async () => (await readProcurementSettings(database)).settings;
  const audit = async () => (await pool.query("SELECT actor,action,target,changes,context,timestamp FROM public.audit_events ORDER BY id")).rows;

  beforeAll(async () => {
    validatePostgresTestEnvironment(process.env);
    pool = new pg.Pool({ connectionString: TEST_URL, ssl: false, max: 8 });
    await pool.query("CREATE SCHEMA identity; CREATE SCHEMA inventory");
    for (const table of tables) await pool.query(fixtureTable(table));
    for (const ddl of fixtureForeignKeys(tables)) await pool.query(ddl);
    await pool.query("CREATE UNIQUE INDEX warehouse_settings_code_test_uidx ON inventory.warehouse_settings(warehouse_code)");
    // Install production policy revision migration against the preceding shape.
    await pool.query("INSERT INTO inventory.warehouse_settings(warehouse_code) VALUES('DEFAULT'); ALTER TABLE inventory.warehouse_settings DROP COLUMN IF EXISTS procurement_policy_revision");
    for (const file of ["0107_audit_events.sql", "136_financial_command_results.sql", "140_financial_command_operations.sql", "900000003000017710001_procurement_policy_revision.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    database = drizzle(pool, { schema });
    commands = createProcurementSettingsCommands(createDrizzleFinancialCommandRepository(database), () => NOW);
  });
  beforeEach(async () => {
    await pool.query(`DROP TRIGGER IF EXISTS settings_test_audit_failure ON public.audit_events;
      -- This suite already requires a disposable local database. Disable only
      -- its protected audit guards during fixture reset, then restore them.
      ALTER TABLE public.audit_events DISABLE TRIGGER procurement_settings_audit_immutable_rows;
      ALTER TABLE public.audit_events DISABLE TRIGGER procurement_settings_audit_immutable_truncate;
      TRUNCATE identity.users,identity.auth_roles,identity.auth_permissions,identity.auth_user_roles,identity.auth_role_permissions,
        inventory.warehouse_settings,public.audit_events,public.financial_command_results RESTART IDENTITY CASCADE;
      ALTER TABLE public.audit_events ENABLE TRIGGER procurement_settings_audit_immutable_rows;
      ALTER TABLE public.audit_events ENABLE TRIGGER procurement_settings_audit_immutable_truncate;
      INSERT INTO identity.users(id,username,password,role,active) VALUES
        ('editor','editor','unused','picker',1),('inventory','inventory','unused','admin',1),('inactive','inactive','unused','admin',0),('scoped','scoped','unused','admin',1);
      INSERT INTO identity.auth_roles(id,name,is_system) VALUES(1,'Policy editor',0),(2,'Stock operator',0),(3,'Inactive policy editor',0),(4,'Restricted policy editor',0);
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES(1,'settings','edit','settings'),(2,'inventory','adjust','inventory'),(3,'purchasing','edit','purchasing');
      INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('editor',1),('inventory',2),('inactive',3),('scoped',4);
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,1,NULL),(2,2,NULL),(2,3,NULL),(3,1,NULL),(4,1,'{"warehouseId":1}');
      INSERT INTO inventory.warehouse_settings(warehouse_code,require_approval) VALUES('DEFAULT',false),('SECONDARY',false)`);
  });
  afterAll(async () => { await pool?.end(); });

  it("writes the complete batch, before/after audit and successful receipt atomically", async () => {
    const before = await snapshot();
    const body = { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "useNewPoEditor", value: true }] };
    const result = await update(body);
    expect(result).toMatchObject({ httpStatus: 200, replayed: false, terminalState: "succeeded", body: { requireApproval: true, useNewPoEditor: true, revision: 1 } });
    expect(await audit()).toEqual([expect.objectContaining({ actor: "editor", action: "procurement.settings.updated", timestamp: NOW,
      changes: { before, after: result.body }, context: expect.objectContaining({ previousRevision: 0, revision: 1, policy: "DEFAULT" }) })]);
    expect((await pool.query("SELECT status,response_body FROM public.financial_command_results")).rows).toEqual([{ status: "succeeded", response_body: result.body }]);
    expect((await pool.query("SELECT require_approval,procurement_policy_revision FROM inventory.warehouse_settings WHERE warehouse_code='SECONDARY'")).rows)
      .toEqual([{ require_approval: false, procurement_policy_revision: 0 }]);
  });

  it.each([
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "notASetting", value: false }] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "useNewPoEditor", value: "yes" }] },
    { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "requireApproval", value: false }] },
  ])("rejects every entry when a later batch element is invalid", async body => {
    const before = await snapshot();
    expect(await update(body)).toMatchObject({ httpStatus: 400, terminalState: "rejected", body: { code: "PROCUREMENT_SETTINGS_INPUT_INVALID" } });
    expect(await snapshot()).toEqual(before);
    expect(await audit()).toEqual([]);
  });

  it.each(["inventory", "inactive", "scoped"])("does not let %s actor mutate policy through the direct owner", async actor => {
    expect(await update(toggle(), actor)).toMatchObject({ httpStatus: 403, body: { code: "PROCUREMENT_SETTINGS_FORBIDDEN" } });
    expect(await snapshot()).toMatchObject({ requireApproval: false, revision: 0 });
    expect(await audit()).toEqual([]);
  });

  it("rechecks a revoked grant rather than trusting a cached identity", async () => {
    await pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=1");
    expect(await update(toggle())).toMatchObject({ httpStatus: 403 });
    expect(await snapshot()).toMatchObject({ requireApproval: false, revision: 0 });
  });

  it("replays the original response without changing policy or duplicating audit", async () => {
    const key = randomUUID();
    const first = await update(toggle(), "editor", key);
    await update({ expectedRevision: 1, key: "requireApproval", value: false });
    expect(await update(toggle(), "editor", key)).toEqual({ ...first, replayed: true });
    expect(await snapshot()).toMatchObject({ requireApproval: false, revision: 2 });
    expect(await audit()).toHaveLength(2);
    await expect(update({ ...toggle(), value: false }, "editor", key)).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
    expect(await audit()).toHaveLength(2);
  });

  it("rolls back every key and leaves no success receipt if audit persistence fails", async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION settings_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER settings_test_audit_failure BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION settings_fail_audit()`);
    const body = { expectedRevision: 0, updates: [{ key: "requireApproval", value: true }, { key: "useNewPoEditor", value: true }] };
    await expect(update(body)).rejects.toThrow();
    expect(await snapshot()).toMatchObject({ requireApproval: false, useNewPoEditor: false, revision: 0 });
    expect(await audit()).toEqual([]);
    expect((await pool.query("SELECT status,last_error_code FROM public.financial_command_results")).rows)
      .toEqual([{ status: "retryable", last_error_code: "PROCUREMENT_SETTINGS_TRANSIENT_FAILURE" }]);
  });

  it("allows exactly one of two administrator commands based on the same revision", async () => {
    const results = await Promise.all([update(toggle()), update({ expectedRevision: 0, key: "useNewPoEditor", value: true })]);
    expect(results.map(result => result.httpStatus).sort()).toEqual([200, 409]);
    expect(results.find(result => result.httpStatus === 409)?.body).toMatchObject({ code: "PROCUREMENT_SETTINGS_STALE" });
    const current = await snapshot();
    expect(current.revision).toBe(1);
    expect(Number(current.requireApproval) + Number(current.useNewPoEditor)).toBe(1);
    expect(await audit()).toHaveLength(1);
  });

  it("does not update other warehouse rows when DEFAULT is absent", async () => {
    await pool.query("DELETE FROM inventory.warehouse_settings WHERE warehouse_code='DEFAULT'");
    expect(await update(toggle())).toMatchObject({ httpStatus: 409, body: { code: "PROCUREMENT_SETTINGS_CONFIGURATION_INVALID" } });
    expect((await pool.query("SELECT require_approval,procurement_policy_revision FROM inventory.warehouse_settings")).rows)
      .toEqual([{ require_approval: false, procurement_policy_revision: 0 }]);
    expect(await audit()).toEqual([]);
  });

  it("holds an existing policy reader stable until its transaction releases the share lock", async () => {
    let releaseReader!: () => void;
    let readerReady!: () => void;
    const released = new Promise<void>(resolve => { releaseReader = resolve; });
    const ready = new Promise<void>(resolve => { readerReady = resolve; });
    const reader = database.transaction(async tx => {
      const before = await readProcurementSettings(tx, "share");
      readerReady();
      await released;
      expect((await readProcurementSettings(tx, "share")).settings).toEqual(before.settings);
    });
    await ready;
    const writer = update(toggle());
    try {
      // Observe PostgreSQL's lock wait rather than relying on a scheduling sleep.
      const deadline = Date.now() + 5000;
      for (;;) {
        const locks = await pool.query("SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%warehouse_code=%'");
        if (locks.rows[0].waiting > 0) break;
        if (Date.now() > deadline) throw new Error("Policy writer did not wait for the canonical share lock");
        await pool.query("SELECT pg_sleep(0.01)");
      }
      expect(await audit()).toEqual([]);
    } finally { releaseReader(); }
    await reader;
    expect(await writer).toMatchObject({ httpStatus: 200, body: { revision: 1 } });
  });

  it("binds direct commands to the authenticated actor and settings command scope", async () => {
    await expect(commands.update(toggle(), "inventory", descriptor(toggle(), "editor"))).rejects.toMatchObject({ code: "PROCUREMENT_SETTINGS_SCOPE_INVALID" });
    expect((await pool.query("SELECT id FROM public.financial_command_results")).rows).toEqual([]);
  });

  it("preserves policy audit history against update, action rewrite, deletion and truncation", async () => {
    await update(toggle());
    const before = await audit();
    for (const statement of [
      "UPDATE public.audit_events SET changes='{}'::jsonb WHERE action='procurement.settings.updated'",
      "UPDATE public.audit_events SET action='unrelated' WHERE action='procurement.settings.updated'",
      "DELETE FROM public.audit_events WHERE action='procurement.settings.updated'",
      "TRUNCATE public.audit_events",
    ]) {
      await expect(pool.query(statement)).rejects.toMatchObject({ code: "23514" });
      expect(await audit()).toEqual(before);
    }
  });

  it("does not freeze unrelated audit actions or allow them to become fabricated policy history", async () => {
    await pool.query("INSERT INTO public.audit_events(actor,action,target) VALUES('legacy','unrelated','original')");
    await pool.query("UPDATE public.audit_events SET target='changed' WHERE action='unrelated'");
    await expect(pool.query("UPDATE public.audit_events SET action='procurement.settings.updated' WHERE action='unrelated'"))
      .rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM public.audit_events WHERE action='unrelated'");
    expect(await audit()).toEqual([]);
    // Empty or unprotected history retains the old truncate behavior.
    await pool.query("INSERT INTO public.audit_events(actor,action) VALUES('legacy','unrelated')");
    await pool.query("TRUNCATE public.audit_events");
    expect(await audit()).toEqual([]);
  });
});
