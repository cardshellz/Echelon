const credentialFixtureSql=readFileSync(new URL("../../../../../docs/reviews/configurable-access-2026-11-05/staff-credential-state.DRAFT.sql",import.meta.url),"utf8");
import { readFileSync } from "node:fs";
const fixtureCredentialVersion="b656f5e9-9dde-49c0-9c2b-823638ff6b5a";
import { readAccessConfiguration } from "../../infrastructure/access-configuration.repository";
import { setTimeout as delay } from "node:timers/promises";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";

// Only the connection boundary is replaced; startup registration and its
// repository run against real PostgreSQL. No application .env or provider loads.
const connection = vi.hoisted(() => ({ database: null as NodePgDatabase<typeof schema> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, {
  get(_target, property) {
    if (!connection.database) throw new Error("Startup authority fixture is not initialized");
    const value = Reflect.get(connection.database, property);
    return typeof value === "function" ? value.bind(connection.database) : value;
  },
}) }));
import { assignUserRolesUseCase, createRoleUseCase, seedRBACUseCase } from "../../application/identity.use-cases";
import { getUserPermissions } from "../../infrastructure/identity.repository";
import { SYSTEM_ROLES } from "../../domain/identity.domain";
import { logger } from "../../../../platform/observability/logger";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;
// Reduced current Identity types/PK/FK/unique contracts. This proves startup
// query/transaction behavior, not migration history or production provisioning.
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
`;
const restrictedCases = [
  { label: "warehouse object", json: '{"warehouseId":1}' }, { label: "empty object", json: "{}" },
  { label: "array", json: '["warehouse-1"]' }, { label: "empty array", json: "[]" },
  { label: "JSON null", json: "null" }, { label: "JSON false", json: "false" },
  { label: "JSON zero", json: "0" }, { label: "JSON string", json: '"warehouse-1"' },
];

integration("startup registers definitions without changing employee authority", () => {
  let database: InventoryCutoverTestDatabase;
  let adminRoleId: number;
  let editPermissionId: number;
  const executedSql: string[] = [];
  const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, fixtureSql);
    connection.database = drizzle(database.pool, { schema,
      logger: { logQuery(query) { executedSql.push(query); } },
    });
  });
  afterAll(async () => {
    connection.database = null;
    info.mockRestore(); error.mockRestore();
    await database?.close();
  });
  async function emptyDatabase() {
    await database.pool.query("TRUNCATE public.audit_events,identity.auth_role_permissions,identity.auth_user_roles,identity.auth_roles,identity.auth_permissions,identity.users RESTART IDENTITY CASCADE");
  }
  beforeEach(async () => {
    await emptyDatabase();
    await database.pool.query(`INSERT INTO identity.auth_permissions(resource,action,category) VALUES
      ('roles','edit','users'),('inventory','view','inventory'),('picking','perform','picking')`);
    editPermissionId = (await database.pool.query<{ id: number }>("SELECT id FROM identity.auth_permissions WHERE resource='roles' AND action='edit'")).rows[0].id;
    for (const role of Object.values(SYSTEM_ROLES)) {
      await database.pool.query("INSERT INTO identity.auth_roles(name,description,is_system) VALUES($1,$2,1)", [role.name, role.description]);
    }
    adminRoleId = (await database.pool.query<{ id: number }>("SELECT id FROM identity.auth_roles WHERE name='Administrator'")).rows[0].id;
    executedSql.length = 0; info.mockClear(); error.mockClear();
  });
  async function addUser(id = "startup-fixture-user", role = "admin", active = 1) {
    await database.pool.query("INSERT INTO identity.users(id,username,password,role,active) VALUES($1::varchar,$1::text,'unused-synthetic-password',$2,$3)", [id, role, active]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id,credential_version) VALUES($1,$2::uuid)",[id,fixtureCredentialVersion]);
    return id;
  }
  async function grant(roleId = adminRoleId, constraintJson: string | null = null) {
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES($1,$2,$3::jsonb)", [roleId, editPermissionId, constraintJson]);
  }
  async function assign(userId: string, roleId = adminRoleId) {
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [userId, roleId]);
  }
  async function authoritySnapshot() {
    return {
      users: (await database.pool.query("SELECT id,username,role,display_name,active,created_at,last_login_at FROM identity.users ORDER BY id")).rows,
      roles: (await database.pool.query("SELECT * FROM identity.auth_roles ORDER BY id")).rows,
      grants: (await database.pool.query("SELECT id,role_id,permission_id,constraints::text AS constraint_json,constraints IS NULL AS is_unrestricted,created_at FROM identity.auth_role_permissions ORDER BY id")).rows,
      memberships: (await database.pool.query("SELECT * FROM identity.auth_user_roles ORDER BY id")).rows,
    };
  }
  async function completeSnapshot() {
    return { ...await authoritySnapshot(),
      permissions: (await database.pool.query("SELECT * FROM identity.auth_permissions ORDER BY id")).rows };
  }
  async function seedTwiceWithoutAuthorityChange() {
    const before = await authoritySnapshot();
    await seedRBACUseCase();
    expect.soft(await authoritySnapshot()).toEqual(before);
    await seedRBACUseCase();
    expect.soft(await authoritySnapshot()).toEqual(before);
  }
  async function waitForBlockedSeed(blockerPid: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await database.pool.query<{ blocked: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS blocked", [blockerPid],
      );
      if (result.rows[0].blocked) return;
      await delay(10);
    }
    throw new Error("Startup registration did not reach the fixture catalog lock");
  }

  it("does not restore a revoked built-in role grant on repeated startup", async () => {
    const userId = await addUser(); await assign(userId); await grant();
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1 AND permission_id=$2", [adminRoleId, editPermissionId]);
    await seedTwiceWithoutAuthorityChange();
  });
  it("does not restore a revoked membership from the user's legacy role label", async () => {
    const userId = await addUser(); await assign(userId); await grant();
    await database.pool.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [userId]);
    await seedTwiceWithoutAuthorityChange();
  });
  it("preserves zero memberships across every legacy user role", async () => {
    for (const role of ["admin", "lead", "picker", "custom_legacy"]) await addUser(`zero-membership-${role}`, role);
    await seedTwiceWithoutAuthorityChange();
  });
  it("preserves custom and multiple memberships without adding a legacy-derived role", async () => {
    const userId = await addUser();
    const roles = (await database.pool.query<{ id: number }>("INSERT INTO identity.auth_roles(name,description) VALUES('Custom alpha','Owner approved'),('Custom beta','Owner approved') RETURNING id")).rows;
    for (const role of roles) { await assign(userId, role.id); await grant(role.id); }
    await seedTwiceWithoutAuthorityChange();
  });
  it("does not change or provision authority for an inactive account", async () => {
    await addUser("inactive-fixture", "admin", 0);
    await grant();
    await seedTwiceWithoutAuthorityChange();
  });
  it.each(restrictedCases)("preserves $label and does not add unrestricted grants around it", async ({ json }) => {
    const userId = await addUser(); await assign(userId); await grant(adminRoleId, json);
    await seedTwiceWithoutAuthorityChange();
  });
  it("registers a newly introduced permission definition without granting it to existing roles", async () => {
    const userId = await addUser(); await assign(userId); await grant();
    expect((await database.pool.query("SELECT id FROM identity.auth_permissions WHERE resource='channels' AND action='sync'")).rows).toEqual([]);
    const before = await authoritySnapshot();
    await seedRBACUseCase();
    const permission = (await database.pool.query<{ id: number }>("SELECT id FROM identity.auth_permissions WHERE resource='channels' AND action='sync'")).rows;
    expect(permission).toHaveLength(1);
    expect((await database.pool.query("SELECT id FROM identity.auth_role_permissions WHERE permission_id=$1", [permission[0].id])).rows).toEqual([]);
    expect(await authoritySnapshot()).toEqual(before);
  });
  it("preserves a custom same-name role's identity, metadata and authority", async () => {
    await database.pool.query("UPDATE identity.auth_roles SET is_system=0,description='Deliberately custom role',updated_at='2025-01-01T00:00:00' WHERE id=$1", [adminRoleId]);
    const userId = await addUser(); await assign(userId); await grant();
    await seedTwiceWithoutAuthorityChange();
  });
  it("does not overwrite existing permission descriptions or categories", async () => {
    await database.pool.query("UPDATE identity.auth_permissions SET description='Existing operator wording',category='existing-category' WHERE id=$1", [editPermissionId]);
    const before = (await database.pool.query("SELECT * FROM identity.auth_permissions WHERE id=$1", [editPermissionId])).rows;
    await seedRBACUseCase();
    expect((await database.pool.query("SELECT * FROM identity.auth_permissions WHERE id=$1", [editPermissionId])).rows).toEqual(before);
  });
  it("on a fresh database creates definitions but no accounts, grants or memberships", async () => {
    await emptyDatabase();
    await seedRBACUseCase();
    await seedRBACUseCase();
    const after = await authoritySnapshot();
    expect(after.users).toEqual([]); expect(after.grants).toEqual([]); expect(after.memberships).toEqual([]);
    expect(after.roles.map(row => row.name).sort()).toEqual(Object.values(SYSTEM_ROLES).map(role => role.name).sort());
    expect((await database.pool.query("SELECT id FROM identity.auth_permissions WHERE resource='roles' AND action='edit'")).rows).toHaveLength(1);
  });
  it("retains explicit role creation and assignment independently of startup", async () => {
    await emptyDatabase();
    await seedRBACUseCase();
    const userId = await addUser("explicit-provisioning-fixture", "picker");
    const permissionId = (await database.pool.query<{ id: number }>("SELECT id FROM identity.auth_permissions WHERE resource='roles' AND action='edit'")).rows[0].id;
    // This separately provisioned synthetic manager is fixture setup, never a
    // startup default. The public commands must use its current explicit grants.
    const actorId = await addUser("explicit-manager-fixture", "picker");
    const actorRoleId = (await database.pool.query<{ id: number }>("INSERT INTO identity.auth_roles(name) VALUES('Explicit provisioning manager') RETURNING id")).rows[0].id;
    await assign(actorId, actorRoleId);
    await database.pool.query(`INSERT INTO identity.auth_role_permissions(role_id,permission_id)
      SELECT $1,id FROM identity.auth_permissions
      WHERE (resource='roles' AND action='create') OR (resource='users' AND action='manage_roles')`, [actorRoleId]);
    const role = await createRoleUseCase("Explicit fixture role", "Synthetic explicit provisioning", [permissionId], { credentialVersion: fixtureCredentialVersion, actorId });
    await assignUserRolesUseCase(userId, [role.id], { credentialVersion: fixtureCredentialVersion, actorId, expectedAccessRevision: (await readAccessConfiguration(connection.database!)).revision });
    expect(await getUserPermissions(userId)).toEqual(["roles:edit"]);
    await seedTwiceWithoutAuthorityChange();
  });
  it("does not restore a revocation committed while startup registration is in progress", async () => {
    const userId = await addUser(); await assign(userId); await grant();
    await database.pool.query(`CREATE FUNCTION identity.fixture_pause_registration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.resource='channels' AND NEW.action='sync' THEN
        PERFORM pg_advisory_xact_lock(904071,1);
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_pause_registration BEFORE INSERT ON identity.auth_permissions
      FOR EACH ROW EXECUTE FUNCTION identity.fixture_pause_registration();`);
    const blocker = await database.pool.connect();
    let seed: Promise<void> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(904071,1)");
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      seed = seedRBACUseCase();
      await waitForBlockedSeed(pid);
      await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [adminRoleId]);
      await database.pool.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [userId]);
      const revoked = await authoritySnapshot();
      await blocker.query("COMMIT");
      await seed;
      expect(await authoritySnapshot()).toEqual(revoked);
    } finally {
      try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
      if (seed) await Promise.allSettled([seed]);
      await database.pool.query("DROP TRIGGER fixture_pause_registration ON identity.auth_permissions; DROP FUNCTION identity.fixture_pause_registration()");
    }
  });
  it("concurrent startup instances converge on one set of definitions without provisioning authority", async () => {
    await emptyDatabase();
    const results = await Promise.allSettled([seedRBACUseCase(), seedRBACUseCase()]);
    // Even the pre-fix query-before-insert race must settle both callers before
    // the next fixture rebuild or teardown starts.
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const after = await authoritySnapshot();
    expect(after.roles.map(row => row.name).sort()).toEqual(Object.values(SYSTEM_ROLES).map(role => role.name).sort());
    expect(after.users).toEqual([]); expect(after.grants).toEqual([]); expect(after.memberships).toEqual([]);
    expect((await database.pool.query("SELECT resource,action,count(*) FROM identity.auth_permissions GROUP BY resource,action HAVING count(*)>1")).rows).toEqual([]);
  });
  it.each(["permissions", "roles"] as const)("rolls back all definition changes and reports a %s insertion failure", async target => {
    // Force real new role rows; failure in roles occurs after permission insertion.
    await database.pool.query("DELETE FROM identity.auth_roles");
    const before = await completeSnapshot();
    const relation = target === "roles" ? "auth_roles" : "auth_permissions";
    const condition = target === "roles" ? "NEW.name='Team Lead'" : "NEW.resource='channels' AND NEW.action='sync'";
    await database.pool.query(`CREATE FUNCTION identity.fixture_fail_registration() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${condition} THEN RAISE EXCEPTION 'Synthetic registration failure with private diagnostic' USING ERRCODE='P0001';
      END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_fail_registration BEFORE INSERT ON identity.${relation}
      FOR EACH ROW EXECUTE FUNCTION identity.fixture_fail_registration();`);
    try {
      await expect(seedRBACUseCase()).rejects.toThrow();
      expect(await completeSnapshot()).toEqual(before);
      expect(info).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledExactlyOnceWith("identity.definitions.register", expect.objectContaining({
        module: "identity", outcome: "failed", error_code: "IDENTITY_DEFINITION_REGISTRATION_FAILED", dependency: "database",
      }));
      expect(JSON.stringify(error.mock.calls)).not.toContain("private diagnostic");
    } finally {
      await database.pool.query(`DROP TRIGGER fixture_fail_registration ON identity.${relation}; DROP FUNCTION identity.fixture_fail_registration()`);
    }
    await seedRBACUseCase();
    expect(info).toHaveBeenCalledExactlyOnceWith("identity.definitions.register", expect.objectContaining({ outcome: "succeeded" }));
    const after = await authoritySnapshot();
    expect(after.grants).toEqual([]); expect(after.memberships).toEqual([]); expect(after.users).toEqual([]);
  });
  it("propagates missing-schema failure instead of reporting successful startup registration", async () => {
    await database.pool.query("ALTER TABLE identity.auth_permissions RENAME TO fixture_hidden_permissions");
    try {
      await expect(seedRBACUseCase()).rejects.toThrow();
      expect(info).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    } finally {
      await database.pool.query("ALTER TABLE identity.fixture_hidden_permissions RENAME TO auth_permissions");
    }
  });
  it("does not query employee accounts, memberships or grants during startup", async () => {
    await addUser();
    executedSql.length = 0;
    await seedRBACUseCase();
    // These are queries actually executed against PostgreSQL, not assertions
    // that a particular implementation source string happens to exist.
    expect(executedSql.filter(query => /\b(users|auth_user_roles|auth_role_permissions)\b/i.test(query))).toEqual([]);
  });
  it("emits successful registration counts only after its transaction commits", async () => {
    const beforeCount = Number((await database.pool.query("SELECT count(*) FROM identity.auth_permissions")).rows[0].count);
    let lastQueryAtSuccess: string | undefined;
    info.mockImplementationOnce(() => { lastQueryAtSuccess = executedSql.at(-1); });
    await seedRBACUseCase();
    const afterCount = Number((await database.pool.query("SELECT count(*) FROM identity.auth_permissions")).rows[0].count);
    expect(lastQueryAtSuccess?.trim().toLowerCase()).toBe("commit");
    expect(info).toHaveBeenCalledExactlyOnceWith("identity.definitions.register", expect.objectContaining({
      module: "identity", outcome: "succeeded", permissionsRegistered: afterCount - beforeCount, rolesRegistered: 0,
      duration_ms: expect.any(Number),
    }));
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).not.toContain("unused-synthetic-password");
  });
  it("does not turn a post-commit logging failure into registration failure", async () => {
    const before = await authoritySnapshot();
    info.mockImplementationOnce(() => { throw new Error("Synthetic diagnostic sink unavailable"); });
    await expect(seedRBACUseCase()).resolves.toBeUndefined();
    expect((await database.pool.query("SELECT id FROM identity.auth_permissions WHERE resource='channels' AND action='sync'")).rows).toHaveLength(1);
    expect(await authoritySnapshot()).toEqual(before);
    expect(info).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
  it("retains the original database failure and rollback when error logging also throws", async () => {
    await database.pool.query("DELETE FROM identity.auth_roles");
    const before = await completeSnapshot();
    await database.pool.query(`CREATE FUNCTION identity.fixture_logger_error_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Original startup database failure' USING ERRCODE='P0001'; END $$;
      CREATE TRIGGER fixture_logger_error_failure BEFORE INSERT ON identity.auth_roles
      FOR EACH ROW EXECUTE FUNCTION identity.fixture_logger_error_failure();`);
    const diagnosticFailure = new Error("Synthetic error logging failure");
    error.mockImplementationOnce(() => { throw diagnosticFailure; });
    try {
      let failure: unknown;
      try { await seedRBACUseCase(); } catch (caught) { failure = caught; }
      expect(failure).toBeDefined();
      expect(failure).not.toBe(diagnosticFailure);
      const cause = (failure as { cause?: unknown }).cause ?? failure;
      expect(cause).toMatchObject({ code: "P0001", message: "Original startup database failure" });
      expect(await completeSnapshot()).toEqual(before);
      expect(info).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledOnce();
    } finally {
      await database.pool.query("DROP TRIGGER fixture_logger_error_failure ON identity.auth_roles; DROP FUNCTION identity.fixture_logger_error_failure()");
    }
  });
});
