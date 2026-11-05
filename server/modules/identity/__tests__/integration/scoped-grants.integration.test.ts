import { readFileSync } from "node:fs";
const fixtureCredentialVersion="b656f5e9-9dde-49c0-9c2b-823638ff6b5a";
const credentialFixtureSql=readFileSync(new URL("../../../../../docs/reviews/configurable-access-2026-11-05/staff-credential-state.DRAFT.sql",import.meta.url),"utf8");
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import type { SafeUser } from "@shared/schema";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

// Substitute the connection boundary only. Identity queries, public permission
// checks, HTTP middleware and /api/auth/me remain the actual application code.
const connection = vi.hoisted(() => ({ database: null as NodePgDatabase<typeof schema> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, {
  get(_target, property) {
    if (!connection.database) throw new Error("Identity test database not initialized");
    const value = Reflect.get(connection.database, property);
    return typeof value === "function" ? value.bind(connection.database) : value;
  },
}) }));
import { getUserPermissions, hasPermission } from "../../index";
import { registerAuthRoutes } from "../../identity.routes";
import { readCommandAuthorityActor } from "../../infrastructure/command-authority.repository";
import { readPurchaseApprovalActor, readPurchaseInvoiceActionActor } from "../../infrastructure/purchase-approval-access.repository";
import { readWarehouseWorkActor } from "../../infrastructure/work-access.repository";
import { readPickingReleaseActor } from "../../infrastructure/picking-release-access.repository";
import { requireAnyPermission, requirePermission } from "../../../../routes/middleware";

// No application .env loader or real provider is used. The existing helper
// creates and drops a uniquely owned database; the supplied database is not rebuilt.
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;

// Reduced Identity fixture: current column types, required fields, PK/FK and
// uniqueness for these five tables. This proves actual query/JSON/lock behavior,
// not full historical migrations, production grants or authentication/session setup.
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
  INSERT INTO identity.auth_permissions(resource,action,category) VALUES
    ('settings','edit','settings'), ('channels','view','channels'),
    ('purchasing','approve','purchasing'), ('purchasing','edit','purchasing'),
    ('warehouse_work','configure','settings'), ('picking','perform','picking');
`;
const permissionNames = ["channels:view", "picking:perform", "purchasing:approve", "purchasing:edit", "settings:edit", "warehouse_work:configure"];
const constrainedCases = [
  { label: "warehouse object", json: '{"warehouseId":1}' },
  { label: "empty object", json: "{}" },
  { label: "array", json: '["warehouse-1"]' },
  { label: "empty array", json: "[]" },
  { label: "JSON null", json: "null" },
  { label: "JSON false", json: "false" },
  { label: "JSON zero", json: "0" },
  { label: "JSON empty string", json: '""' },
];

integration("Identity constrained grants never become global authority", () => {
  let database: InventoryCutoverTestDatabase;
  let server: Server;
  let baseUrl: string;
  let sessionUser: SafeUser | undefined;
  let roleSequence = 0;
  const actorId = "identity-scope-fixture";

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, fixtureSql);
    connection.database = drizzle(database.pool, { schema });
    const app = express();
    // The synthetic session deliberately retains an admin role label even when
    // current grants are scoped/revoked. Session role strings must not authorize.
    app.use((req, _res, next) => {
      req.session = { user: sessionUser,staffCredentialVersion:fixtureCredentialVersion } as typeof req.session;
      next();
    });
    app.get("/identity-test/single", requirePermission("settings", "edit"), (_req, res) => res.json({ allowed: true }));
    app.get("/identity-test/any", requireAnyPermission(["settings", "edit"], ["channels", "view"]), (_req, res) => res.json({ allowed: true }));
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
    await database.pool.query("TRUNCATE identity.auth_role_permissions,identity.auth_user_roles,identity.auth_roles,identity.users CASCADE");
    await database.pool.query("INSERT INTO identity.users(id,username,password,role,display_name) VALUES($1::varchar,$1::text,'unused-synthetic-password','admin','Fixture employee')", [actorId]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id,credential_version) VALUES($1,$2::uuid)",[actorId,fixtureCredentialVersion]);
    sessionUser = { id: actorId, username: actorId, role: "admin", displayName: "Fixture employee", active: 1,
      createdAt: new Date("2026-11-04T00:00:00Z"), lastLoginAt: null };
  });

  async function grantRole(json: string | null, resource?: string, action?: string, userId = actorId) {
    const roleId = (await database.pool.query<{ id: number }>("INSERT INTO identity.auth_roles(name) VALUES($1) RETURNING id", [`Fixture role ${++roleSequence}`])).rows[0].id;
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [userId, roleId]);
    const result = await database.pool.query<{ id: number }>(`
      INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints)
      SELECT $1,id,$2::jsonb FROM identity.auth_permissions
      WHERE ($3::text IS NULL OR resource=$3) AND ($4::text IS NULL OR action=$4) RETURNING id
    `, [roleId, json, resource ?? null, action ?? null]);
    return { roleId, grantIds: result.rows.map(row => row.id) };
  }
  async function commandActors() {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = drizzle(client, { schema });
      return {
        command: await readCommandAuthorityActor(tx, actorId),
        approval: await readPurchaseApprovalActor(tx, actorId),
        invoiceApprove: await readPurchaseInvoiceActionActor(tx, actorId, "approve"),
        invoiceEdit: await readPurchaseInvoiceActionActor(tx, actorId, "edit"),
        work: await readWarehouseWorkActor(client, actorId),
        picking: await readPickingReleaseActor(tx, actorId),
      };
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  }
  async function assertHttpDenied(inactive = false) {
    expect((await requestLocalHttp(`${baseUrl}/identity-test/single`)).status).toBe(403);
    expect((await requestLocalHttp(`${baseUrl}/identity-test/any`)).status).toBe(403);
    const current = await requestLocalHttp(`${baseUrl}/api/auth/me`);
    expect(current.status).toBe(inactive ? 401 : 200);
    if (!inactive) expect(await current.json()).toMatchObject({ permissions: [] });
  }

  it.each(constrainedCases)("denies $label across generic, HTTP, command and specialized readers", async ({ json }) => {
    await grantRole(json);
    expect(await getUserPermissions(actorId)).toEqual([]);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(false);
    await assertHttpDenied();
    const actors = await commandActors();
    expect(actors.command).toMatchObject({ active: true, permissions: [], scopedPermissions: permissionNames });
    expect(actors.approval).toMatchObject({ active: true, approvalGrantIds: [], hasScopedApprovalGrant: true });
    expect(actors.invoiceApprove).toMatchObject({ grantIds: [], hasScopedGrant: true });
    expect(actors.invoiceEdit).toMatchObject({ grantIds: [], hasScopedGrant: true });
    expect(actors.work).toMatchObject({ active: true, permissions: [] });
    expect(actors.picking).toMatchObject({ active: true, permissions: [] });
  });

  // Separate regressions ensure the generic reader's failure cannot hide the
  // JSON decoder hazard in any specialized reader during a pre-fix probe.
  it("command authority distinguishes JSON null from a SQL NULL grant", async () => {
    await grantRole("null");
    const { command } = await commandActors();
    expect(command.permissions).toEqual([]);
    expect(command.scopedPermissions).toEqual(permissionNames);
  });

  it("purchase approval and invoice authority distinguish JSON null from SQL NULL", async () => {
    await grantRole("null");
    const { approval, invoiceApprove, invoiceEdit } = await commandActors();
    expect.soft(approval).toMatchObject({ approvalGrantIds: [], hasScopedApprovalGrant: true });
    expect.soft(invoiceApprove).toMatchObject({ grantIds: [], hasScopedGrant: true });
    expect.soft(invoiceEdit).toMatchObject({ grantIds: [], hasScopedGrant: true });
  });

  it("warehouse work authority distinguishes JSON null from a SQL NULL grant", async () => {
    await grantRole("null");
    const { work } = await commandActors();
    expect(work).toMatchObject({ active: true, permissions: [] });
  });

  it("allows SQL NULL grants, deduplicates roles and preserves current response contracts", async () => {
    await grantRole(null);
    await grantRole(null);
    expect((await getUserPermissions(actorId)).sort()).toEqual(permissionNames);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(true);
    expect((await requestLocalHttp(`${baseUrl}/identity-test/single`)).status).toBe(200);
    expect((await requestLocalHttp(`${baseUrl}/identity-test/any`)).status).toBe(200);
    const current = await requestLocalHttp(`${baseUrl}/api/auth/me`);
    const body = await current.json() as { permissions: string[]; roles: string[] };
    expect(body.permissions.sort()).toEqual(permissionNames);
    expect(body.roles).toHaveLength(2);
    const actors = await commandActors();
    expect(actors.command).toMatchObject({ permissions: permissionNames, scopedPermissions: [] });
    expect(actors.approval.approvalGrantIds).toHaveLength(2);
    expect(actors.approval.hasScopedApprovalGrant).toBe(false);
    expect(actors.invoiceApprove.grantIds).toHaveLength(2);
    expect(actors.invoiceEdit.grantIds).toHaveLength(2);
    expect(actors.work.permissions).toEqual(["warehouse_work:configure"]);
    expect(actors.picking.permissions).toEqual(["picking:perform"]);
  });

  it("a separate SQL NULL grant still authorizes when the same permission also has scoped grants", async () => {
    await grantRole("null");
    await grantRole(null);
    expect((await getUserPermissions(actorId)).sort()).toEqual(permissionNames);
    const actors = await commandActors();
    expect(actors.command).toMatchObject({ permissions: permissionNames, scopedPermissions: permissionNames });
    expect(actors.approval.approvalGrantIds).toHaveLength(1);
    expect(actors.approval.hasScopedApprovalGrant).toBe(true);
    expect(actors.invoiceApprove.grantIds).toHaveLength(1);
    expect(actors.invoiceEdit.grantIds).toHaveLength(1);
    expect(actors.work.permissions).toEqual(["warehouse_work:configure"]);
    expect(actors.picking.permissions).toEqual(["picking:perform"]);
  });

  it("ANY permission allows a later global grant but not an earlier scoped grant", async () => {
    await grantRole('{"warehouseId":1}', "settings", "edit");
    await grantRole(null, "channels", "view");
    expect((await requestLocalHttp(`${baseUrl}/identity-test/single`)).status).toBe(403);
    expect((await requestLocalHttp(`${baseUrl}/identity-test/any`)).status).toBe(200);
    expect(await getUserPermissions(actorId)).toEqual(["channels:view"]);
  });

  it("does not borrow another user's grant or substitute a different permission", async () => {
    const otherUserId = "another-identity-fixture";
    await database.pool.query("INSERT INTO identity.users(id,username,password) VALUES($1::varchar,$1::text,'unused-synthetic-password')", [otherUserId]);
    await grantRole(null, undefined, undefined, otherUserId);
    await grantRole("{}");
    expect(await getUserPermissions(actorId)).toEqual([]);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(false);
    await assertHttpDenied();
    const { command, approval, work } = await commandActors();
    expect(command.permissions).toEqual([]);
    expect(approval.approvalGrantIds).toEqual([]);
    expect(work.permissions).toEqual([]);
    await grantRole(null, "channels", "view");
    expect(await hasPermission(actorId, "channels", "view")).toBe(true);
    expect(await hasPermission(actorId, "channels", "edit")).toBe(false);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(false);
    expect((await getUserPermissions(otherUserId)).sort()).toEqual(permissionNames);
  });

  it.each(["grant", "membership", "account"] as const)("observes current %s revocation despite a saved admin session", async (kind) => {
    await grantRole(null);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(true);
    if (kind === "grant") await database.pool.query("DELETE FROM identity.auth_role_permissions");
    if (kind === "membership") await database.pool.query("DELETE FROM identity.auth_user_roles");
    if (kind === "account") await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    expect(await getUserPermissions(actorId)).toEqual([]);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(false);
    await assertHttpDenied(kind === "account");
    const actors = await commandActors();
    expect(actors.command.permissions).toEqual([]);
    expect(actors.approval.approvalGrantIds).toEqual([]);
    expect(actors.invoiceApprove.grantIds).toEqual([]);
    expect(actors.invoiceEdit.grantIds).toEqual([]);
    expect(actors.picking.permissions).toEqual([]);
    // Warehouse actor's existing contract reports activity separately; its
    // callers must reject active=false. This change does not redesign that DTO.
    if (kind === "account") expect(actors.work.active).toBe(false);
    else expect(actors.work.permissions).toEqual([]);
  });

  it("does not infer authority from a missing account or a role label without memberships", async () => {
    expect(await getUserPermissions(actorId)).toEqual([]);
    expect(await hasPermission(actorId, "settings", "edit")).toBe(false);
    expect(await getUserPermissions("missing-fixture-user")).toEqual([]);
    await assertHttpDenied();
    await database.pool.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
    const actors = await commandActors();
    expect(actors.command).toMatchObject({ active: false, permissions: [], scopedPermissions: [] });
    expect(actors.approval).toMatchObject({ active: false, approvalGrantIds: [] });
    expect(actors.work).toMatchObject({ active: false, permissions: [] });
    expect(actors.picking).toMatchObject({ active: false, permissions: [] });
  });

  it("retains command transaction locks until completion and sees revocation afterward", async () => {
    await grantRole(null, "settings", "edit");
    const authority = await database.pool.connect();
    const revoker = await database.pool.connect();
    try {
      await authority.query("BEGIN");
      expect((await readCommandAuthorityActor(drizzle(authority, { schema }), actorId)).permissions).toEqual(["settings:edit"]);
      await revoker.query("BEGIN");
      await revoker.query("SET LOCAL lock_timeout='100ms'");
      await expect(revoker.query("DELETE FROM identity.auth_role_permissions")).rejects.toMatchObject({ code: "55P03" });
      await revoker.query("ROLLBACK");
      await authority.query("COMMIT");
      await revoker.query("DELETE FROM identity.auth_role_permissions");
      expect(await hasPermission(actorId, "settings", "edit")).toBe(false);
      expect((await readCommandAuthorityActor(drizzle(authority, { schema }), actorId)).permissions).toEqual([]);
    } finally {
      try { await authority.query("ROLLBACK"); } finally { authority.release(); }
      try { await revoker.query("ROLLBACK"); } finally { revoker.release(); }
    }
  });

  it("rejects HTTP requests without an authenticated session", async () => {
    await grantRole(null);
    sessionUser = undefined;
    for (const path of ["/identity-test/single", "/identity-test/any", "/api/auth/me"]) {
      expect((await requestLocalHttp(`${baseUrl}${path}`)).status).toBe(401);
    }
  });
});
