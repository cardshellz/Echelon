const credentialFixtureSql=readFileSync(new URL("../../../../../migrations/900000056000020040001_staff_credential_state.sql",import.meta.url),"utf8");
import { readFileSync } from "node:fs";
const fixtureCredentialVersion="b656f5e9-9dde-49c0-9c2b-823638ff6b5a";
import { readAccessConfiguration } from "../../infrastructure/access-configuration.repository";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import type { SafeUser } from "@shared/schema";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

// Only the connection and session identity are synthetic. The HTTP handlers,
// permission gate, use case, transaction and repository are application code.
const connection = vi.hoisted(() => ({ database: null as NodePgDatabase<typeof schema> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, {
  get(_target, property) {
    if (!connection.database) throw new Error("Role permission fixture is not initialized");
    const value = Reflect.get(connection.database, property);
    return typeof value === "function" ? value.bind(connection.database) : value;
  },
}) }));
import { registerAuthRoutes } from "../../identity.routes";
import { updateRolePermissionsUseCase } from "../../application/identity.use-cases";
import { updateRolePermissions } from "../../infrastructure/identity.repository";
import { readCommandAuthorityActor } from "../../infrastructure/command-authority.repository";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;

// Current Identity field types/PK/FK/unique contracts for these five tables.
// This intentionally reduced fixture proves query and transaction behavior;
// it is not proof of full migration history, production roles or real sessions.
const fixtureSql = `
  CREATE SCHEMA identity;
  CREATE TABLE identity.users (
    id varchar PRIMARY KEY, username text NOT NULL UNIQUE, password text NOT NULL,
    role varchar(20) NOT NULL DEFAULT 'picker', display_name text,
    active integer NOT NULL DEFAULT 1, created_at timestamp NOT NULL DEFAULT now(), last_login_at timestamp
  );
  ${credentialFixtureSql}
  CREATE TABLE identity.auth_roles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name varchar(100) NOT NULL UNIQUE,
    description text, is_system integer NOT NULL DEFAULT 0,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE identity.auth_permissions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, resource varchar(50) NOT NULL,
    action varchar(50) NOT NULL, description text, category varchar(50) NOT NULL,
    created_at timestamp NOT NULL DEFAULT now(), UNIQUE(resource,action)
  );
  CREATE TABLE identity.auth_role_permissions (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    role_id integer NOT NULL REFERENCES identity.auth_roles(id) ON DELETE CASCADE,
    permission_id integer NOT NULL REFERENCES identity.auth_permissions(id) ON DELETE CASCADE,
    constraints jsonb, created_at timestamp NOT NULL DEFAULT now(), UNIQUE(role_id,permission_id)
  );
  CREATE TABLE identity.auth_user_roles (
    id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id varchar NOT NULL REFERENCES identity.users(id) ON DELETE CASCADE,
    role_id integer NOT NULL REFERENCES identity.auth_roles(id) ON DELETE CASCADE,
    created_at timestamp NOT NULL DEFAULT now(), UNIQUE(user_id,role_id)
  );
  CREATE TABLE public.audit_events (
    id bigserial PRIMARY KEY, timestamp timestamptz NOT NULL DEFAULT now(),
    level text NOT NULL DEFAULT 'AUDIT', actor text NOT NULL, action text NOT NULL,
    target text, changes jsonb, context jsonb
  );
  INSERT INTO identity.auth_permissions(resource,action,category) VALUES
    ('roles','view','users'), ('roles','edit','users'),
    ('inventory','view','inventory'), ('inventory','edit','inventory'), ('orders','view','orders');
`;
const restrictedCases = [
  { label: "warehouse object", json: '{"warehouseId":1}' },
  { label: "empty object", json: "{}" },
  { label: "array", json: '["warehouse-1"]' },
  { label: "empty array", json: "[]" },
  { label: "JSON null", json: "null" },
  { label: "JSON false", json: "false" },
  { label: "JSON zero", json: "0" },
  { label: "JSON string", json: '"warehouse-1"' },
];
interface GrantRow {
  id: number;
  role_id: number;
  permission_id: number;
  constraint_json: string | null;
  is_unrestricted: boolean;
  created_at: Date;
}

integration("generic role editor preserves existing grant restrictions", () => {
  let database: InventoryCutoverTestDatabase;
  let server: Server;
  let baseUrl: string;
  let sessionUser: SafeUser | undefined;
  let targetRoleId: number;
  let operatorRoleId: number;
  let permissionIds: Record<string, number>;
  const actorId = "role-editor-fixture";
  const inventoryView = () => permissionIds["inventory:view"];
  const inventoryEdit = () => permissionIds["inventory:edit"];
  const ordersView = () => permissionIds["orders:view"];

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, fixtureSql);
    connection.database = drizzle(database.pool, { schema });
    permissionIds = Object.fromEntries((await database.pool.query<{ id: number; resource: string; action: string }>(
      "SELECT id,resource,action FROM identity.auth_permissions",
    )).rows.map(row => [`${row.resource}:${row.action}`, row.id]));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: sessionUser,staffCredentialVersion:fixtureCredentialVersion } as typeof req.session; next(); });
    registerAuthRoutes(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    try {
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally {
      connection.database = null;
      await database?.close();
    }
  });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE public.audit_events,identity.auth_role_permissions,identity.auth_user_roles,identity.auth_roles,identity.users CASCADE");
    await database.pool.query("INSERT INTO identity.users(id,username,password,role) VALUES($1::varchar,$1::text,'unused-synthetic-password','admin')", [actorId]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id,credential_version) VALUES($1,$2::uuid)",[actorId,fixtureCredentialVersion]);
    operatorRoleId = (await database.pool.query<{ id: number }>("INSERT INTO identity.auth_roles(name) VALUES('Fixture operator') RETURNING id")).rows[0].id;
    targetRoleId = (await database.pool.query<{ id: number }>("INSERT INTO identity.auth_roles(name) VALUES('Fixture target') RETURNING id")).rows[0].id;
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [actorId, operatorRoleId]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='roles'", [operatorRoleId]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2)", [targetRoleId, inventoryView()]);
    sessionUser = { id: actorId, username: actorId, role: "admin", displayName: "Fixture employee", active: 1,
      createdAt: new Date("2026-11-04T00:00:00Z"), lastLoginAt: null };
  });

  async function edit(body: unknown, roleId: string | number = targetRoleId) {
    return requestLocalHttp(`${baseUrl}/api/roles/${encodeURIComponent(roleId)}/permissions`, {
      method: "PUT", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body, expectedAccessRevision: (await readAccessConfiguration(connection.database!)).revision } : body) }),
    });
  }
  async function snapshot() {
    const role = (await database.pool.query("SELECT * FROM identity.auth_roles WHERE id=$1", [targetRoleId])).rows;
    const grants = (await database.pool.query<GrantRow>(`
      SELECT id,role_id,permission_id,constraints::text AS constraint_json,
        constraints IS NULL AS is_unrestricted,created_at
      FROM identity.auth_role_permissions WHERE role_id=$1 ORDER BY id
    `, [targetRoleId])).rows;
    return { role, grants };
  }
  async function restrict(json: string) {
    await database.pool.query("UPDATE identity.auth_role_permissions SET constraints=$1::jsonb WHERE role_id=$2 AND permission_id=$3", [json, targetRoleId, inventoryView()]);
  }
  async function waitForBlockedWriter(blockerPid: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await database.pool.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked", [blockerPid],
      );
      if (result.rows[0].blocked) return;
      await delay(10);
    }
    throw new Error("Role edit did not wait for the conflicting transaction");
  }

  it.each(restrictedCases)("rejects edits of $label without deleting, widening or rotating grants", async ({ json }) => {
    await restrict(json);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2)", [targetRoleId, inventoryEdit()]);
    const before = await snapshot();
    const selections = [[inventoryView(), inventoryEdit(), ordersView()], [],
      [inventoryView()], [inventoryView(), inventoryEdit()], [inventoryView(), inventoryEdit()]];
    for (const permissionIds of selections) {
      const response = await edit({ permissionIds });
      // Soft assertions expose the old writer's concrete widening/row rotation
      // even when its HTTP response is already incorrectly successful.
      expect.soft(response.status).toBe(409);
      expect.soft(await response.json()).toMatchObject({ code: "IDENTITY_ROLE_RESTRICTIONS_UNSUPPORTED" });
      expect.soft(await snapshot()).toEqual(before);
    }
  });

  it.each(restrictedCases)("GET reports $label as restricted without exposing scope payloads", async ({ json }) => {
    await restrict(json);
    const response = await requestLocalHttp(`${baseUrl}/api/roles/${targetRoleId}/permissions`);
    expect(response.status).toBe(200);
    const body = await response.json() as Array<Record<string, unknown>>;
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ id: inventoryView(), resource: "inventory", action: "view", isRestricted: true });
    expect(body[0]).not.toHaveProperty("constraints");
    expect(body[0]).not.toHaveProperty("constraint_json");
  });

  it("keeps the array contract and allows explicit replacement and removal of unrestricted grants", async () => {
    const read = await requestLocalHttp(`${baseUrl}/api/roles/${targetRoleId}/permissions`);
    expect(await read.json()).toEqual([expect.objectContaining({ id: inventoryView(), isRestricted: false })]);
    const operatorBefore = (await database.pool.query("SELECT * FROM identity.auth_role_permissions WHERE role_id=$1 ORDER BY id", [operatorRoleId])).rows;
    const response = await edit({ permissionIds: [inventoryEdit(), ordersView()] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const replaced = await snapshot();
    expect(replaced.grants.map(row => row.permission_id).sort()).toEqual([inventoryEdit(), ordersView()].sort());
    expect(replaced.grants.every(row => row.is_unrestricted)).toBe(true);
    expect((await edit({ permissionIds: [] })).status).toBe(200);
    expect((await snapshot()).grants).toEqual([]);
    expect((await database.pool.query("SELECT * FROM identity.auth_role_permissions WHERE role_id=$1 ORDER BY id", [operatorRoleId])).rows).toEqual(operatorBefore);
  });

  it.each([
    { label: "missing body", body: undefined }, { label: "missing field", body: {} },
    { label: "null field", body: { permissionIds: null } }, { label: "string field", body: { permissionIds: "" } },
    { label: "number field", body: { permissionIds: 0 } }, { label: "object field", body: { permissionIds: {} } },
    { label: "zero id", body: { permissionIds: [0] } }, { label: "negative id", body: { permissionIds: [-1] } },
    { label: "fractional id", body: { permissionIds: [1.5] } }, { label: "string id", body: { permissionIds: ["1"] } },
    { label: "null id", body: { permissionIds: [null] } }, { label: "boolean id", body: { permissionIds: [true] } },
    { label: "outside PostgreSQL integer range", body: { permissionIds: [2_147_483_648] } },
    { label: "unsafe id", body: { permissionIds: [Number.MAX_SAFE_INTEGER + 1] } },
  ])("rejects $label before changing grants", async ({ body }) => {
    const before = await snapshot();
    expect((await edit(body)).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it("rejects duplicate permission IDs without changing grants", async () => {
    const before = await snapshot();
    const response = await edit({ permissionIds: [inventoryView(), inventoryView()] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "IDENTITY_ROLE_PERMISSIONS_INVALID" });
    expect(await snapshot()).toEqual(before);
  });

  it("preserves existing rollback behavior for a valid but nonexistent permission ID", async () => {
    const before = await snapshot();
    // Missing catalog rows retain the established FK failure classification;
    // this bounded fix does not introduce a new permission catalog policy.
    expect((await edit({ permissionIds: [inventoryEdit(), 2_147_483_647] })).status).toBe(500);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["0", "-1", "1.5", "1e2", "NaN", "9007199254740992"])("rejects malformed role id %s", async roleId => {
    const before = await snapshot();
    expect((await edit({ permissionIds: [] }, roleId)).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
  it("does not parse a valid role prefix from an invalid identifier", async () => {
    const before = await snapshot();
    expect((await edit({ permissionIds: [] }, `${targetRoleId}suffix`)).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });
  it("returns not found for a valid missing role without changing another role", async () => {
    const before = await snapshot();
    expect((await edit({ permissionIds: [] }, targetRoleId + 1_000_000)).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });
  it("validates direct use-case callers and requires an explicit repository transaction", async () => {
    const before = await snapshot();
    await expect(updateRolePermissionsUseCase(0, [], { credentialVersion: fixtureCredentialVersion, actorId })).rejects.toThrow();
    await expect(updateRolePermissionsUseCase(targetRoleId, undefined as unknown as number[], { credentialVersion: fixtureCredentialVersion, actorId })).rejects.toThrow();
    await expect(updateRolePermissionsUseCase(targetRoleId, [inventoryView(), -1], { credentialVersion: fixtureCredentialVersion, actorId })).rejects.toThrow();
    // @ts-expect-error The raw writer must not fall back to the ambient database.
    await expect(updateRolePermissions(targetRoleId, [])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it.each(["absent", "wrong permission", "restricted permission", "inactive"])("rejects an %s operator despite the session role label", async kind => {
    const before = await snapshot();
    if (kind === "absent") sessionUser = undefined;
    if (kind === "wrong permission") await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1 AND permission_id=$2", [operatorRoleId, permissionIds["roles:edit"]]);
    if (kind === "restricted permission") await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='null'::jsonb WHERE role_id=$1 AND permission_id=$2", [operatorRoleId, permissionIds["roles:edit"]]);
    if (kind === "inactive") await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    expect((await edit({ permissionIds: [] })).status).toBe(kind === "absent" ? 401 : 403);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back the original deletion when a later insertion fails and permits a clean retry", async () => {
    const before = await snapshot();
    // Target IDs are database-generated integers in this uniquely owned fixture.
    await database.pool.query(`CREATE FUNCTION identity.fixture_role_insert_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.role_id=${targetRoleId} AND NEW.permission_id=${ordersView()} THEN
        RAISE EXCEPTION 'Synthetic role permission insert failure' USING ERRCODE='P0001';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_role_insert_failure BEFORE INSERT ON identity.auth_role_permissions
      FOR EACH ROW EXECUTE FUNCTION identity.fixture_role_insert_failure();`);
    try {
      expect((await edit({ permissionIds: [inventoryEdit(), ordersView()] })).status).toBe(500);
      expect(await snapshot()).toEqual(before);
    } finally {
      await database.pool.query("DROP TRIGGER fixture_role_insert_failure ON identity.auth_role_permissions; DROP FUNCTION identity.fixture_role_insert_failure()");
    }
    expect((await edit({ permissionIds: [inventoryEdit(), ordersView()] })).status).toBe(200);
    expect((await snapshot()).grants.map(row => row.permission_id).sort()).toEqual([inventoryEdit(), ordersView()].sort());
  });

  it("rechecks a grant restriction committed while the editor is waiting", async () => {
    const before = await snapshot();
    const writer = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await writer.query("UPDATE identity.auth_role_permissions SET constraints='{}'::jsonb WHERE role_id=$1", [targetRoleId]);
      response = edit({ permissionIds: [inventoryView()] });
      await waitForBlockedWriter(pid);
      await writer.query("COMMIT");
      const result = await response;
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({ code: "IDENTITY_ROLE_RESTRICTIONS_UNSUPPORTED" });
      const after = await snapshot();
      expect(after.role).toEqual(before.role);
      expect(after.grants).toEqual(before.grants.map(row => ({ ...row, constraint_json: "{}", is_unrestricted: false })));
    } finally {
      try { await writer.query("ROLLBACK"); } finally { writer.release(); }
      if (response) await Promise.allSettled([response]);
    }
  });

  it("rechecks a restricted grant inserted before the editor acquires its parent role lock", async () => {
    const before = await snapshot();
    const writer = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      await writer.query("BEGIN");
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const inserted = (await writer.query<{ id: number }>("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES($1,$2,'null'::jsonb) RETURNING id", [targetRoleId, ordersView()])).rows[0].id;
      response = edit({ permissionIds: [inventoryView()] });
      await waitForBlockedWriter(pid);
      await writer.query("COMMIT");
      const result = await response;
      expect(result.status).toBe(409);
      const after = await snapshot();
      expect(after.role).toEqual(before.role);
      expect(after.grants.filter(row => row.id !== inserted)).toEqual(before.grants);
      expect(after.grants.find(row => row.id === inserted)).toMatchObject({ permission_id: ordersView(), constraint_json: "null", is_unrestricted: false });
    } finally {
      try { await writer.query("ROLLBACK"); } finally { writer.release(); }
      if (response) await Promise.allSettled([response]);
    }
  });

  it("holds the parent role lock through completion so new restricted grants cannot race the replacement", async () => {
    const rival = await database.pool.connect();
    try {
      await connection.database!.transaction(async tx => {
        await updateRolePermissions(targetRoleId, [inventoryEdit()], tx);
        await rival.query("BEGIN");
        await rival.query("SET LOCAL lock_timeout='100ms'");
        await expect(rival.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES($1,$2,'{}'::jsonb)",
          [targetRoleId, ordersView()])).rejects.toMatchObject({ code: "55P03" });
        await rival.query("ROLLBACK");
      });
      const after = await snapshot();
      expect(after.grants.map(row => row.permission_id)).toEqual([inventoryEdit()]);
      expect(after.grants[0].is_unrestricted).toBe(true);
    } finally {
      try { await rival.query("ROLLBACK"); } finally { rival.release(); }
    }
  });

  it("waits for actual command-authority share locks before editing that actor's role", async () => {
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [actorId, targetRoleId]);
    const reader = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      await reader.query("BEGIN");
      const pid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const authority = await readCommandAuthorityActor(drizzle(reader, { schema }), actorId);
      expect(authority.permissions).toContain("inventory:view");
      response = edit({ permissionIds: [ordersView()] });
      await waitForBlockedWriter(pid);
      // The current command retains its evidence until its transaction ends.
      expect((await reader.query<{ permission_id: number }>("SELECT permission_id FROM identity.auth_role_permissions WHERE role_id=$1", [targetRoleId])).rows)
        .toEqual([{ permission_id: inventoryView() }]);
      await reader.query("COMMIT");
      expect((await response).status).toBe(200);
      const after = await snapshot();
      expect(after.grants.map(row => row.permission_id)).toEqual([ordersView()]);
      expect(after.grants[0].is_unrestricted).toBe(true);
    } finally {
      try { await reader.query("ROLLBACK"); } finally { reader.release(); }
      if (response) await Promise.allSettled([response]);
    }
  });

  it("serializes two unrestricted replacements without mixing their final selections", async () => {
    const first = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      const pid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await drizzle(first, { schema }).transaction(async tx => {
        await updateRolePermissions(targetRoleId, [inventoryEdit()], tx);
        response = edit({ permissionIds: [ordersView()] });
        await waitForBlockedWriter(pid);
        expect((await first.query<{ permission_id: number }>("SELECT permission_id FROM identity.auth_role_permissions WHERE role_id=$1", [targetRoleId])).rows)
          .toEqual([{ permission_id: inventoryEdit() }]);
      });
      expect(response).toBeDefined();
      expect((await response!).status).toBe(200);
      const after = await snapshot();
      expect(after.grants.map(row => row.permission_id)).toEqual([ordersView()]);
      expect(after.grants[0].is_unrestricted).toBe(true);
    } finally {
      first.release();
      if (response) await Promise.allSettled([response]);
    }
  });
});
