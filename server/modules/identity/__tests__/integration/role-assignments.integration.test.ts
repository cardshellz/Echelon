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

// Only DB connection and session identity are substituted. Authorization,
// route, use case and repository execute their real code on synthetic records.
const connection = vi.hoisted(() => ({ database: null as NodePgDatabase<typeof schema> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, {
  get(_target, property) {
    if (!connection.database) throw new Error("Role assignment fixture is not initialized");
    const value = Reflect.get(connection.database, property);
    return typeof value === "function" ? value.bind(connection.database) : value;
  },
}) }));
import { registerAuthRoutes } from "../../identity.routes";
import { assignUserRolesUseCase } from "../../application/identity.use-cases";
import { assignUserRoles, getUserPermissions } from "../../infrastructure/identity.repository";
import { readCommandAuthorityActor } from "../../infrastructure/command-authority.repository";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;
// Reduced current Identity column/PK/FK/unique contracts. This proves query,
// transaction and lock behavior, not full migrations or production permissions.
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
    ('users','manage_roles','users'),('inventory','view','inventory'),('orders','view','orders');
`;

integration("explicit employee role assignment transaction", () => {
  let database: InventoryCutoverTestDatabase;
  let server: Server;
  let baseUrl: string;
  let sessionUser: SafeUser | undefined;
  let roles: Record<string, number>;
  const actorId = "assignment-operator-fixture";
  const targetId = "assignment-target-fixture";
  const initialRole = () => roles["Custom initial"];
  const secondRole = () => roles["Custom second"];
  const thirdRole = () => roles["Custom third"];

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, fixtureSql);
    connection.database = drizzle(database.pool, { schema });
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
  async function addUser(userId: string) {
    await database.pool.query("INSERT INTO identity.users(id,username,password,role) VALUES($1::varchar,$1::text,'unused-synthetic-password','admin')", [userId]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id,credential_version) VALUES($1,$2::uuid)",[userId,fixtureCredentialVersion]);
  }
  beforeEach(async () => {
    await database.pool.query("TRUNCATE public.audit_events,identity.auth_role_permissions,identity.auth_user_roles,identity.auth_roles,identity.users CASCADE");
    await addUser(actorId); await addUser(targetId);
    roles = Object.fromEntries((await database.pool.query<{ id: number; name: string }>(`
      INSERT INTO identity.auth_roles(name,description) VALUES
      ('Fixture operator','Synthetic manager'),('Custom initial','Existing custom role'),
      ('Custom second','Second custom role'),('Custom third','Third custom role') RETURNING id,name
    `)).rows.map(role => [role.name, role.id]));
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2),($3,$4)", [actorId, roles["Fixture operator"], targetId, initialRole()]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='users'", [roles["Fixture operator"]]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='inventory'", [initialRole()]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='orders'", [secondRole()]);
    sessionUser = { id: actorId, username: actorId, role: "admin", displayName: "Fixture manager", active: 1,
      createdAt: new Date("2026-11-04T00:00:00Z"), lastLoginAt: null };
  });
  async function edit(body: unknown, userId = targetId) {
    return requestLocalHttp(`${baseUrl}/api/users/${encodeURIComponent(userId)}/roles`, {
      method: "PUT", headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body, expectedAccessRevision: (await readAccessConfiguration(connection.database!)).revision } : body) }),
    });
  }
  async function memberships(userId = targetId) {
    return (await database.pool.query<{ id: number; user_id: string; role_id: number; created_at: Date }>(
      "SELECT * FROM identity.auth_user_roles WHERE user_id=$1 ORDER BY id", [userId],
    )).rows;
  }
  async function snapshot() {
    return {
      users: (await database.pool.query("SELECT id,username,role,display_name,active,created_at,last_login_at FROM identity.users ORDER BY id")).rows,
      roles: (await database.pool.query("SELECT * FROM identity.auth_roles ORDER BY id")).rows,
      grants: (await database.pool.query("SELECT id,role_id,permission_id,constraints::text AS constraint_json,created_at FROM identity.auth_role_permissions ORDER BY id")).rows,
      memberships: (await database.pool.query("SELECT * FROM identity.auth_user_roles ORDER BY id")).rows,
    };
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
    throw new Error("Assignment did not wait for the conflicting transaction");
  }

  it.each([
    { label: "omitted body", body: undefined }, { label: "omitted field", body: {} },
    { label: "null", body: { roleIds: null } }, { label: "false", body: { roleIds: false } },
    { label: "empty string", body: { roleIds: "" } }, { label: "zero", body: { roleIds: 0 } },
    { label: "nonzero number", body: { roleIds: 1 } }, { label: "object", body: { roleIds: {} } },
    { label: "zero ID", body: { roleIds: [0] } }, { label: "negative ID", body: { roleIds: [-1] } },
    { label: "fractional ID", body: { roleIds: [1.5] } }, { label: "string ID", body: { roleIds: ["1"] } },
    { label: "null ID", body: { roleIds: [null] } }, { label: "boolean ID", body: { roleIds: [true] } },
    { label: "nested array", body: { roleIds: [[1]] } },
    { label: "integer overflow", body: { roleIds: [2_147_483_648] } },
    { label: "unsafe number", body: { roleIds: [Number.MAX_SAFE_INTEGER + 1] } },
  ])("rejects $label without deleting or rotating memberships", async ({ body }) => {
    const before = await snapshot();
    const result = await edit(body);
    // Preserve evidence of the pre-fix falsy-default destructive clear even
    // when its successful HTTP status already violates this contract.
    expect.soft(result.status).toBe(400);
    expect.soft(await result.json()).toMatchObject({ code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" });
    expect.soft(await snapshot()).toEqual(before);
  });
  it("rejects duplicate role IDs without modifying existing authority", async () => {
    const before = await snapshot();
    const result = await edit({ roleIds: [secondRole(), secondRole()] });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" });
    expect(await snapshot()).toEqual(before);
  });
  it.each([" ", "\t\n"])("rejects whitespace-only target ID %j", async userId => {
    const before = await snapshot();
    const result = await edit({ roleIds: [] }, userId);
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" });
    expect(await snapshot()).toEqual(before);
  });
  it("preserves exact non-UUID target IDs rather than trimming into another employee", async () => {
    const exactId = ` ${targetId} `;
    await addUser(exactId);
    const original = await memberships();
    expect((await edit({ roleIds: [secondRole()] }, exactId)).status).toBe(200);
    expect((await memberships(exactId)).map(row => row.role_id)).toEqual([secondRole()]);
    expect(await memberships()).toEqual(original);
  });
  it("allows explicit clearing, multiple custom roles and repeated replacement without changing legacy metadata", async () => {
    const before = await snapshot();
    const operatorBefore = await memberships(actorId);
    expect((await edit({ roleIds: [] })).status).toBe(200);
    expect(await memberships()).toEqual([]);
    const selected = [thirdRole(), secondRole()];
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await edit({ roleIds: selected });
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ success: true });
      expect((await memberships()).map(row => row.role_id).sort()).toEqual([...selected].sort());
    }
    expect(await memberships(actorId)).toEqual(operatorBefore);
    const after = await snapshot();
    expect(after.users).toEqual(before.users);
    expect(after.roles).toEqual(before.roles);
    expect(after.grants).toEqual(before.grants);
  });
  it("preserves inactive-target and restricted-role semantics without enabling the account or widening a grant", async () => {
    await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [targetId]);
    await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='null'::jsonb WHERE role_id=$1", [secondRole()]);
    const before = await snapshot();
    expect((await edit({ roleIds: [secondRole()] })).status).toBe(200);
    const after = await snapshot();
    expect(after.users).toEqual(before.users);
    expect(after.grants).toEqual(before.grants);
    expect((await memberships()).map(row => row.role_id)).toEqual([secondRole()]);
    expect(await getUserPermissions(targetId)).toEqual([]);
  });
  it.each(["empty", "nonempty"])("rejects a missing target for an explicit %s selection", async kind => {
    const before = await snapshot();
    const result = await edit({ roleIds: kind === "empty" ? [] : [secondRole()] }, "missing-assignment-fixture");
    expect(result.status).toBe(404);
    expect(await result.json()).toMatchObject({ code: "IDENTITY_USER_NOT_FOUND" });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a missing requested role before deleting existing memberships", async () => {
    const before = await snapshot();
    const result = await edit({ roleIds: [secondRole(), 2_147_483_647] });
    expect(result.status).toBe(404);
    expect(await result.json()).toMatchObject({ code: "IDENTITY_ASSIGNED_ROLE_NOT_FOUND" });
    expect(await snapshot()).toEqual(before);
  });
  it("validates direct use-case and transaction-writer inputs", async () => {
    const before = await snapshot();
    await expect(assignUserRolesUseCase(targetId, undefined, { credentialVersion: fixtureCredentialVersion, actorId })).rejects.toMatchObject({ code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" });
    await expect(assignUserRolesUseCase(" ", [], { credentialVersion: fixtureCredentialVersion, actorId })).rejects.toMatchObject({ code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" });
    await expect(connection.database!.transaction(tx => assignUserRoles(targetId, [0], tx))).rejects.toMatchObject({ code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" });
    expect(await snapshot()).toEqual(before);
  });
  it("requires an explicit transaction instead of falling back to the ambient database", async () => {
    const before = await snapshot();
    // @ts-expect-error Assignment persistence requires an explicit transaction.
    await expect(assignUserRoles(targetId, [])).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
  it.each(["absent", "wrong permission", "restricted permission", "inactive"])("rejects an %s operator despite a saved admin label", async kind => {
    const before = await snapshot();
    if (kind === "absent") sessionUser = undefined;
    if (kind === "wrong permission") await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [roles["Fixture operator"]]);
    if (kind === "restricted permission") await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='{}'::jsonb WHERE role_id=$1", [roles["Fixture operator"]]);
    if (kind === "inactive") await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    const originalMemberships = before.memberships;
    expect((await edit({ roleIds: [] })).status).toBe(kind === "absent" ? 401 : 403);
    expect((await snapshot()).memberships).toEqual(originalMemberships);
  });
  it("rolls back the old membership deletion when a later insert fails and permits a clean retry", async () => {
    const before = await snapshot();
    // Fixed fixture user ID and database-generated role ID; no external input.
    await database.pool.query(`CREATE FUNCTION identity.fixture_assignment_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.user_id='assignment-target-fixture' AND NEW.role_id=${thirdRole()} THEN
        RAISE EXCEPTION 'Synthetic membership insert failure' USING ERRCODE='P0001';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_assignment_failure BEFORE INSERT ON identity.auth_user_roles
      FOR EACH ROW EXECUTE FUNCTION identity.fixture_assignment_failure();`);
    try {
      expect((await edit({ roleIds: [secondRole(), thirdRole()] })).status).toBe(500);
      expect(await snapshot()).toEqual(before);
    } finally {
      await database.pool.query("DROP TRIGGER fixture_assignment_failure ON identity.auth_user_roles; DROP FUNCTION identity.fixture_assignment_failure()");
    }
    expect((await edit({ roleIds: [secondRole(), thirdRole()] })).status).toBe(200);
    expect((await memberships()).map(row => row.role_id).sort()).toEqual([secondRole(), thirdRole()].sort());
  });
  it("serializes two replacements for the same user without mixing their selections", async () => {
    const first = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      const pid = (await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await drizzle(first, { schema }).transaction(async tx => {
        await assignUserRoles(targetId, [secondRole()], tx);
        response = edit({ roleIds: [thirdRole()] });
        await waitForBlockedWriter(pid);
        expect((await first.query<{ role_id: number }>("SELECT role_id FROM identity.auth_user_roles WHERE user_id=$1", [targetId])).rows).toEqual([{ role_id: secondRole() }]);
      });
      expect(response).toBeDefined();
      expect((await response!).status).toBe(200);
      expect((await memberships()).map(row => row.role_id)).toEqual([thirdRole()]);
    } finally {
      first.release();
      if (response) await Promise.allSettled([response]);
    }
  });
  it("waits for current command authority to finish before replacing that user's memberships", async () => {
    const reader = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      await reader.query("BEGIN");
      const pid = (await reader.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      expect((await readCommandAuthorityActor(drizzle(reader, { schema }), targetId)).permissions).toEqual(["inventory:view"]);
      response = edit({ roleIds: [secondRole()] });
      await waitForBlockedWriter(pid);
      expect((await reader.query<{ role_id: number }>("SELECT role_id FROM identity.auth_user_roles WHERE user_id=$1", [targetId])).rows).toEqual([{ role_id: initialRole() }]);
      await reader.query("COMMIT");
      expect((await response).status).toBe(200);
      expect(await getUserPermissions(targetId)).toEqual(["orders:view"]);
    } finally {
      try { await reader.query("ROLLBACK"); } finally { reader.release(); }
      if (response) await Promise.allSettled([response]);
    }
  });
  it("rejects a requested role deleted before its selection lock is acquired", async () => {
    const before = await memberships();
    const deleter = await database.pool.connect();
    let response: Promise<Response> | undefined;
    try {
      await deleter.query("BEGIN");
      const pid = (await deleter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await deleter.query("DELETE FROM identity.auth_roles WHERE id=$1", [secondRole()]);
      response = edit({ roleIds: [secondRole()] });
      await waitForBlockedWriter(pid);
      await deleter.query("COMMIT");
      const result = await response;
      expect(result.status).toBe(404);
      expect(await result.json()).toMatchObject({ code: "IDENTITY_ASSIGNED_ROLE_NOT_FOUND" });
      expect(await memberships()).toEqual(before);
    } finally {
      try { await deleter.query("ROLLBACK"); } finally { deleter.release(); }
      if (response) await Promise.allSettled([response]);
    }
  });
  it("holds selected roles through commit without prohibiting an ordinary later role deletion", async () => {
    const deleter = await database.pool.connect();
    try {
      await connection.database!.transaction(async tx => {
        await assignUserRoles(targetId, [secondRole()], tx);
        await deleter.query("BEGIN");
        await deleter.query("SET LOCAL lock_timeout='100ms'");
        await expect(deleter.query("DELETE FROM identity.auth_roles WHERE id=$1", [secondRole()])).rejects.toMatchObject({ code: "55P03" });
        await deleter.query("ROLLBACK");
      });
      expect((await memberships()).map(row => row.role_id)).toEqual([secondRole()]);
      await deleter.query("DELETE FROM identity.auth_roles WHERE id=$1", [secondRole()]);
      expect(await memberships()).toEqual([]);
    } finally {
      try { await deleter.query("ROLLBACK"); } finally { deleter.release(); }
    }
  });
  it("holds the target user lock while clearing memberships against a competing insert", async () => {
    const rival = await database.pool.connect();
    try {
      await connection.database!.transaction(async tx => {
        await assignUserRoles(targetId, [], tx);
        await rival.query("BEGIN");
        await rival.query("SET LOCAL lock_timeout='100ms'");
        await expect(rival.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [targetId, thirdRole()])).rejects.toMatchObject({ code: "55P03" });
        await rival.query("ROLLBACK");
      });
      expect(await memberships()).toEqual([]);
    } finally {
      try { await rival.query("ROLLBACK"); } finally { rival.release(); }
    }
  });
});
