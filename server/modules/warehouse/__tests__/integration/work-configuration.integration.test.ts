import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { config } from "dotenv";
import { emptyWorkConfiguration, type SaveWorkConfiguration } from "@shared/warehouse-work";
import { WorkConfigurationRepository } from "../../work/infrastructure/work-configuration.repository";
import { WorkConfigurationService } from "../../work/application/work-configuration.service";

config({ path: resolve(process.cwd(), ".env.test") });
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe.sequential : describe.skip;
const TIME = "2026-09-05T12:00:00.000Z";

// Self-contained suite, run serially against an explicitly disposable DB. It
// executes the REAL migration and repository, not a simulated SQL engine.
describeDatabase("warehouse work PostgreSQL guarantees", () => {
  let pool: Pool;
  let service: WorkConfigurationService;
  let nextWarehouse = 100;

  beforeAll(async () => {
    if (!databaseUrl || !disposable) throw new Error("A disposable test database is required");
    const target = new URL(databaseUrl);
    for (const protectedUrl of [process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].filter((value): value is string => !!value)) {
      const protectedTarget = new URL(protectedUrl);
      if (target.hostname === protectedTarget.hostname && (target.port || "5432") === (protectedTarget.port || "5432") && target.pathname === protectedTarget.pathname) {
        throw new Error("Test database must not be an application database, even with different credentials");
      }
    }
    pool = new Pool({ connectionString: databaseUrl, max: 8, ssl: /^(localhost|127\.0\.0\.1|\[::1\])$/.test(target.hostname) ? false : { rejectUnauthorized: false } });
    await pool.query(`
      DROP SCHEMA IF EXISTS warehouse CASCADE;
      DROP SCHEMA IF EXISTS identity CASCADE;
      CREATE SCHEMA warehouse;
      CREATE SCHEMA identity;
      CREATE TABLE warehouse.warehouses (id integer PRIMARY KEY, code text UNIQUE NOT NULL, name text NOT NULL, is_active integer NOT NULL DEFAULT 1, warehouse_type text NOT NULL DEFAULT 'operations');
      CREATE TABLE warehouse.warehouse_locations (id integer PRIMARY KEY, warehouse_id integer REFERENCES warehouse.warehouses(id), code text NOT NULL, zone text, is_active integer NOT NULL DEFAULT 1);
      CREATE TABLE identity.users (id varchar PRIMARY KEY, username text NOT NULL, display_name text, active integer NOT NULL DEFAULT 1);
      CREATE TABLE identity.auth_permissions (id serial PRIMARY KEY, resource text NOT NULL, action text NOT NULL);
      CREATE TABLE identity.auth_roles (id integer PRIMARY KEY);
      CREATE TABLE identity.auth_user_roles (id serial PRIMARY KEY, user_id varchar REFERENCES identity.users(id), role_id integer REFERENCES identity.auth_roles(id));
      CREATE TABLE identity.auth_role_permissions (id serial PRIMARY KEY, role_id integer REFERENCES identity.auth_roles(id), permission_id integer REFERENCES identity.auth_permissions(id), constraints jsonb);
      INSERT INTO identity.users(id, username) VALUES ('admin','admin'),('operator','operator');
      INSERT INTO identity.auth_roles VALUES (1);
      INSERT INTO identity.auth_user_roles(user_id, role_id) VALUES ('admin',1);
      INSERT INTO identity.auth_permissions(resource,action) VALUES ('warehouse_work','view'),('warehouse_work','configure'),('warehouse_work','manage_access'),('warehouse_work','assembly');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT 1,id FROM identity.auth_permissions;
    `);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/0654_warehouse_work_configuration.sql"), "utf8"));
    service = new WorkConfigurationService(new WorkConfigurationRepository(pool), () => new Date(TIME));
  });
  afterAll(async () => { if (pool) await pool.end(); });

  async function warehouse() {
    const id = ++nextWarehouse;
    await pool.query("INSERT INTO warehouse.warehouses(id,code,name) VALUES ($1,$2,$2)", [id, `W${id}`]);
    await pool.query("INSERT INTO warehouse.warehouse_locations(id,warehouse_id,code,zone) VALUES ($1,$1,'ASSEMBLY','PACK')", [id]);
    return id;
  }
  function command(warehouseId: number): SaveWorkConfiguration {
    return { expectedRevision: 0, commandId: randomUUID(), reason: "Prepare small team workflow",
      configuration: { ...emptyWorkConfiguration(), stations: [{ id: randomUUID(), code: "ASSEMBLY", name: "Assembly & Pack", locationId: warehouseId, capabilities: ["assembly", "packing"], enabled: true }],
        access: [{ userId: "admin", capabilities: ["assembly"], scope: { kind: "warehouse" } }] } };
  }
  async function count(warehouseId: number) {
    const result = await pool.query<{ count: string }>("SELECT count(*) FROM warehouse.work_configuration_revisions WHERE warehouse_id=$1", [warehouseId]);
    return Number(result.rows[0].count);
  }

  it("persists all projections and immutable who/what/before/after evidence", async () => {
    const id = await warehouse(); const request = command(id);
    const saved = await service.save("admin", id, request);
    expect(saved).toMatchObject({ revision: 1, executionStatus: "not_connected", savedAt: TIME, savedBy: "admin" });
    const evidence = await pool.query("SELECT before_configuration, configuration, actor_id FROM warehouse.work_configuration_revisions WHERE warehouse_id=$1", [id]);
    expect(evidence.rows[0].before_configuration).toEqual(emptyWorkConfiguration());
    expect(evidence.rows[0].configuration).toEqual(saved.configuration);
    expect((await pool.query("SELECT * FROM warehouse.work_stations WHERE warehouse_id=$1", [id])).rowCount).toBe(1);
    expect((await pool.query("SELECT * FROM warehouse.work_access_scopes WHERE warehouse_id=$1", [id])).rowCount).toBe(1);
    expect(await service.preview("admin", id, { capability: "assembly", stationId: request.configuration.stations[0].id, locationId: id })).toMatchObject({ eligible: true, executionAllowed: false });
  });
  it("serializes simultaneous editors so exactly one expected-revision write wins", async () => {
    const id = await warehouse(); const a = command(id); const b = { ...a, commandId: randomUUID(), reason: "Another edit" };
    const results = await Promise.allSettled([service.save("admin", id, a), service.save("admin", id, b)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "WORK_REVISION_CONFLICT" } });
    expect(await count(id)).toBe(1);
  });
  it("serializes simultaneous identical retries into one revision", async () => {
    const id = await warehouse(); const request = command(id);
    const [a, b] = await Promise.all([service.save("admin", id, request), service.save("admin", id, request)]);
    expect(a).toEqual(b); expect(await count(id)).toBe(1);
    await expect(service.save("admin", id, { ...request, reason: "Changed payload" })).rejects.toMatchObject({ code: "WORK_COMMAND_REUSED" });
  });
  it("rejects foreign locations before writing and foreign station IDs roll back the whole revision", async () => {
    const local = await warehouse(); const foreign = await warehouse();
    const request = command(local); request.configuration.stations[0].locationId = foreign;
    await expect(service.save("admin", local, request)).rejects.toMatchObject({ code: "WORK_LOCATION_INVALID" });
    expect(await count(local)).toBe(0);
    const existing = command(foreign); await service.save("admin", foreign, existing);
    request.configuration.stations[0].locationId = local; request.configuration.stations[0].id = existing.configuration.stations[0].id;
    await expect(service.save("admin", local, request)).rejects.toMatchObject({ code: "WORK_STATION_ID_CONFLICT" });
    expect(await count(local)).toBe(0);
  });
  it("database guards reject ledger mutation and cross-warehouse relocation", async () => {
    const id = await warehouse(); const foreign = await warehouse(); await service.save("admin", id, command(id));
    await expect(pool.query("UPDATE warehouse.work_configuration_revisions SET reason='tamper' WHERE warehouse_id=$1", [id])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("DELETE FROM warehouse.work_configuration_revisions WHERE warehouse_id=$1", [id])).rejects.toMatchObject({ code: "55000" });
    await expect(pool.query("UPDATE warehouse.work_stations SET location_id=$1 WHERE warehouse_id=$2", [foreign, id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE warehouse.warehouse_locations SET warehouse_id=$1 WHERE id=$2", [foreign, id])).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps historical profiles and station identities after retirement", async () => {
    const id = await warehouse(); const request = command(id); await service.save("admin", id, request);
    const next = structuredClone(request); next.commandId = randomUUID(); next.expectedRevision = 1;
    next.configuration.profile.inbound = "staged"; next.configuration.stations[0].enabled = false; next.configuration.access = [];
    await service.save("admin", id, next);
    const history = await service.history("admin", id, 100);
    expect(history.map((row) => row.revision)).toEqual([2, 1]);
    expect(history[1].configuration.profile.inbound).toBe("receive_and_stow");
    expect((await pool.query("SELECT enabled FROM warehouse.work_stations WHERE warehouse_id=$1", [id])).rows[0].enabled).toBe(false);
    expect((await pool.query("SELECT * FROM warehouse.work_access_scopes WHERE warehouse_id=$1", [id])).rowCount).toBe(0);
  });
  it("rolls back revision and station projections when access persistence fails", async () => {
    const id = await warehouse();
    await pool.query(`CREATE FUNCTION warehouse.test_reject_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected scope persistence failure'; END $$;
      CREATE TRIGGER test_reject_scope BEFORE INSERT ON warehouse.work_access_scopes FOR EACH ROW EXECUTE FUNCTION warehouse.test_reject_scope();`);
    try {
      await expect(service.save("admin", id, command(id))).rejects.toThrow("injected scope persistence failure");
      expect(await count(id)).toBe(0);
      expect((await pool.query("SELECT * FROM warehouse.work_stations WHERE warehouse_id=$1", [id])).rowCount).toBe(0);
    } finally { await pool.query("DROP TRIGGER test_reject_scope ON warehouse.work_access_scopes; DROP FUNCTION warehouse.test_reject_scope()"); }
  });
});
