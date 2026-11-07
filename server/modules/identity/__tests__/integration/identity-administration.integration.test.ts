const fixtureCredentialVersion="b656f5e9-9dde-49c0-9c2b-823638ff6b5a";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { identityAdministrationFixtureSql } from "../fixtures/identity-administration.fixture";

const connection = vi.hoisted(() => ({ database: null as NodePgDatabase<typeof schema> | null }));
vi.mock("../../../../db", () => ({ db: new Proxy({}, {
  get(_target, property) {
    if (!connection.database) throw new Error("Identity administration fixture is not initialized");
    const value = Reflect.get(connection.database, property);
    return typeof value === "function" ? value.bind(connection.database) : value;
  },
}) }));
import * as actualCommands from "../../application/identity.use-cases";
import { readAccessConfiguration } from "../../infrastructure/access-configuration.repository";
import { queryAccessReview, queryStaffUserList } from "../../application/access-review.query";
import { readIdentityAccessPreflight } from "../../infrastructure/access-preflight.repository";
import { logger } from "../../../../platform/observability/logger";

// Existing command cases explicitly review current configuration first. Dedicated
// cases below call actualCommands directly to prove missing/stale review rejection.
async function reviewedActor(actor: Parameters<typeof actualCommands.assignUserRolesUseCase>[2]) {
  return actor ? { ...actor, expectedAccessRevision: actor.expectedAccessRevision ?? (await readAccessConfiguration(connection.database!)).revision } : actor;
}
const commands = {
  ...actualCommands,
  updateUserUseCase: async (...args: Parameters<typeof actualCommands.updateUserUseCase>) => actualCommands.updateUserUseCase(args[0],args[1],args[1].active === undefined ? args[2] : await reviewedActor(args[2])),
  assignUserRolesUseCase: async (...args: Parameters<typeof actualCommands.assignUserRolesUseCase>) => actualCommands.assignUserRolesUseCase(args[0],args[1],await reviewedActor(args[2])),
  updateRolePermissionsUseCase: async (...args: Parameters<typeof actualCommands.updateRolePermissionsUseCase>) => actualCommands.updateRolePermissionsUseCase(args[0],args[1],await reviewedActor(args[2])),
  deleteRoleUseCase: async (...args: Parameters<typeof actualCommands.deleteRoleUseCase>) => actualCommands.deleteRoleUseCase(args[0],await reviewedActor(args[1])),
};

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;
const auditGuardCandidateSql = readFileSync(new URL(
  "../../../../../migrations/900000053000019980001_identity_access_audit_guard.sql",
  import.meta.url,
), "utf8");

integration("current explicit authority for Identity administration commands", () => {
  let database: InventoryCutoverTestDatabase;
  let roles: Record<string, number>;
  let permissions: Record<string, number>;
  const actorId = "administration-operator-fixture";
  const targetId = "administration-target-fixture";
  const otherId = "administration-other-fixture";
  const actor = () => ({ credentialVersion: fixtureCredentialVersion, actorId });
  const managerRole = () => roles["Custom administration"];
  const alphaRole = () => roles["Target alpha"];
  const betaRole = () => roles["Target beta"];

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, identityAdministrationFixtureSql);
    connection.database = drizzle(database.pool, { schema });
    permissions = Object.fromEntries((await database.pool.query<{ id: number; key: string }>(
      "SELECT id,resource || ':' || action AS key FROM identity.auth_permissions",
    )).rows.map(row => [row.key, row.id]));
  });
  afterAll(async () => {
    connection.database = null;
    await database?.close();
  });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE public.audit_events,identity.auth_user_roles,identity.auth_role_permissions,identity.auth_roles,identity.users CASCADE");
    await database.pool.query(`INSERT INTO identity.users(id,username,password,role) VALUES
      ($1::varchar,$1::text,'synthetic-existing-password','picker'),
      ($2::varchar,$2::text,'synthetic-target-password','admin'),
      ($3::varchar,$3::text,'synthetic-other-password','admin')`, [actorId, targetId, otherId]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id,credential_version) SELECT id,$1::uuid FROM identity.users",[fixtureCredentialVersion]);
    roles = Object.fromEntries((await database.pool.query<{ id: number; name: string }>(`
      INSERT INTO identity.auth_roles(name) VALUES
        ('Custom administration'),('Target alpha'),('Target beta'),('Limited administration')
      RETURNING id,name
    `)).rows.map(row => [row.name, row.id]));
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource IN ('users','roles')", [managerRole()]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2),($3,$4)",
      [alphaRole(), permissions["inventory:view"], betaRole(), permissions["orders:view"]]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2),($3,$4)",
      [actorId, managerRole(), targetId, alphaRole()]);
  });
  async function snapshot() {
    return {
      users: (await database.pool.query("SELECT * FROM identity.users ORDER BY id")).rows,
      roles: (await database.pool.query("SELECT * FROM identity.auth_roles ORDER BY id")).rows,
      grants: (await database.pool.query("SELECT *,constraints::text AS constraint_text FROM identity.auth_role_permissions ORDER BY id")).rows,
      memberships: (await database.pool.query("SELECT * FROM identity.auth_user_roles ORDER BY id")).rows,
      audit: (await database.pool.query("SELECT * FROM public.audit_events ORDER BY id")).rows,
    };
  }
  async function currentMemberships(userId: string) {
    return (await database.pool.query<{ role_id: number }>("SELECT role_id FROM identity.auth_user_roles WHERE user_id=$1 ORDER BY role_id", [userId])).rows.map(row => row.role_id);
  }
  async function auditRows() {
    return (await database.pool.query<{ actor: string; action: string; target: string; changes: unknown; context: Record<string, unknown> }>(
      "SELECT actor,action,target,changes,context FROM public.audit_events ORDER BY id",
    )).rows;
  }
  async function setActorPermissions(keys: string[]) {
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1", [managerRole()]);
    for (const key of keys) await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2)", [managerRole(), permissions[key]]);
  }
  const cases = [
    { name: "assignment replacement", permission: "users:manage_roles", run: () => commands.assignUserRolesUseCase(targetId, [betaRole()], actor()) },
    { name: "role grant replacement", permission: "roles:edit", run: () => commands.updateRolePermissionsUseCase(alphaRole(), [permissions["orders:view"]], actor()) },
    { name: "role creation", permission: "roles:create", run: () => commands.createRoleUseCase("Created custom role", "Synthetic description", [permissions["orders:view"]], actor()) },
    { name: "role deletion", permission: "roles:delete", run: () => commands.deleteRoleUseCase(betaRole(), actor()) },
    { name: "account update", permission: "users:edit", run: () => commands.updateUserUseCase(targetId, { displayName: "Updated synthetic name" }, actor()) },
    { name: "account creation", permission: "users:create", run: () => commands.createUserUseCase({ username: "created-synthetic-user", password: "synthetic-new-password", role: "admin", displayName: "Created account" }, actor()) },
  ];

  it.each(cases)("$name accepts the exact current capability from a custom role and records durable audit", async ({ run }) => {
    await run();
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: actorId, action: expect.stringMatching(/^identity\./), target: expect.any(String) });
    expect(audit[0].changes).toHaveProperty("before");
    expect(audit[0].changes).toHaveProperty("after");
    expect(audit[0].context).toMatchObject({ operationId: expect.any(String), attemptId: expect.any(String) });
    expect(JSON.stringify(audit)).not.toContain("synthetic-new-password");
    expect(JSON.stringify(audit)).not.toContain("synthetic-existing-password");
    expect(JSON.stringify(audit)).not.toContain("synthetic-target-password");
    expect(JSON.stringify(audit)).not.toMatch(/\$2[aby]\$/);
  });
  it.each(cases)("$name denies an old admin label without current assigned roles", async ({ run }) => {
    await database.pool.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [actorId]);
    await database.pool.query("UPDATE identity.users SET role='admin' WHERE id=$1", [actorId]);
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({ statusCode: 403 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(cases)("$name denies an inactive actor despite current grants", async ({ run }) => {
    await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({ statusCode: 403 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(cases)("$name rechecks the exact capability at command entry", async ({ run, permission }) => {
    await database.pool.query("DELETE FROM identity.auth_role_permissions WHERE role_id=$1 AND permission_id=$2", [managerRole(), permissions[permission]]);
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({ statusCode: 403 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(cases)("$name does not promote JSON null constraints into unrestricted authority", async ({ run, permission }) => {
    await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='null'::jsonb WHERE role_id=$1 AND permission_id=$2", [managerRole(), permissions[permission]]);
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({ statusCode: 403 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(cases)("$name rolls back the mutation when durable audit persistence fails", async ({ run }) => {
    const before = await snapshot();
    await database.pool.query(`CREATE FUNCTION public.reject_identity_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER reject_identity_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_identity_audit()`);
    try {
      await expect(run()).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await database.pool.query("DROP TRIGGER reject_identity_audit ON public.audit_events; DROP FUNCTION public.reject_identity_audit()");
    }
  });

  it("permits explicitly empty and multiple custom assignments without changing the legacy label", async () => {
    await commands.assignUserRolesUseCase(targetId, [alphaRole(), betaRole()], actor());
    expect(await currentMemberships(targetId)).toEqual([alphaRole(), betaRole()].sort((a, b) => a - b));
    await commands.assignUserRolesUseCase(targetId, [], actor());
    expect(await currentMemberships(targetId)).toEqual([]);
    expect((await database.pool.query("SELECT role FROM identity.users WHERE id=$1", [targetId])).rows).toEqual([{ role: "admin" }]);
  });
  it("creates a legacy-labelled account without any implicit assignment or grant", async () => {
    const created = await commands.createUserUseCase({ username: "new-unassigned", password: "synthetic-password", role: "admin" }, actor());
    expect(await currentMemberships(created.id)).toEqual([]);
    expect(created).not.toHaveProperty("password");
  });
  it("rejects missing actor context before any access mutation", async () => {
    const before = await snapshot();
    // Exercise the runtime boundary even though TypeScript requires this argument.
    await expect(commands.assignUserRolesUseCase(targetId, [], undefined as never)).rejects.toMatchObject({
      code: "IDENTITY_ADMINISTRATION_INVALID", statusCode: 400,
    });
    expect(await snapshot()).toEqual(before);
  });
  it("does not trim an unrecognized actor ID into a different authorized account", async () => {
    const before = await snapshot();
    await expect(commands.assignUserRolesUseCase(targetId, [], { actorId: ` ${actorId} ` })).rejects.toMatchObject({
      code: "IDENTITY_ADMINISTRATION_FORBIDDEN", statusCode: 403,
    });
    expect(await snapshot()).toEqual(before);
  });
  it("preserves a genuinely padded opaque actor ID in authorization and audit", async () => {
    const paddedId = " padded-actor-fixture ";
    await database.pool.query("INSERT INTO identity.users(id,username,password) VALUES($1::varchar,$1::text,'synthetic-padded-password')", [paddedId]);
    await database.pool.query("INSERT INTO identity.staff_credentials(user_id,credential_version) VALUES($1,$2::uuid)",[paddedId,fixtureCredentialVersion]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [paddedId, managerRole()]);
    await commands.assignUserRolesUseCase(targetId, [], { actorId: paddedId,credentialVersion:fixtureCredentialVersion });
    expect(await currentMemberships(targetId)).toEqual([]);
    expect(await auditRows()).toEqual([expect.objectContaining({ actor: paddedId })]);
  });
  it("records correlated retry attempts without pretending correlation provides deduplication", async () => {
    const operationId = "d9bc3268-e122-43fa-a635-5b5c2f939a7e";
    const firstAttempt = "cbe0b118-8720-47f3-a5af-f03b371ae610";
    const secondAttempt = "f254c752-3795-4b15-8ee9-c823fc802021";
    await commands.assignUserRolesUseCase(targetId, [betaRole()], { credentialVersion: fixtureCredentialVersion, actorId, operationId, attemptId: firstAttempt });
    await commands.assignUserRolesUseCase(targetId, [betaRole()], { credentialVersion: fixtureCredentialVersion, actorId, operationId, attemptId: secondAttempt });
    expect(await currentMemberships(targetId)).toEqual([betaRole()]);
    expect((await auditRows()).map(row => row.context)).toEqual([
      expect.objectContaining({ operationId, attemptId: firstAttempt }),
      expect.objectContaining({ operationId, attemptId: secondAttempt }),
    ]);
  });
  it("rejects credential replacement through ordinary profile administration", async () => {
    const before=await snapshot();
    await expect(commands.updateUserUseCase(targetId, { password: "synthetic-replacement-password" } as never, actor())).rejects.toMatchObject({ code:"IDENTITY_ADMINISTRATION_INVALID" });
    expect(await snapshot()).toEqual(before);
  });
  it("records users affected by role deletion and preserves SQL-null versus JSON-null grant evidence", async () => {
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$3),($2,$3)", [targetId, otherId, betaRole()]);
    await database.pool.query("UPDATE identity.auth_role_permissions SET constraints='null'::jsonb WHERE role_id=$1", [betaRole()]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2)", [betaRole(), permissions["inventory:view"]]);
    await expect(commands.deleteRoleUseCase(betaRole(), actor())).resolves.toBe(true);
    expect(await currentMemberships(otherId)).toEqual([]);
    expect(await currentMemberships(targetId)).toEqual([alphaRole()]);
    expect((await auditRows())[0].changes).toMatchObject({
      before: {
        affectedUserIds: [targetId, otherId].sort(),
        grants: expect.arrayContaining([
          { permissionId: permissions["inventory:view"], constraints: null, isRestricted: false },
          { permissionId: permissions["orders:view"], constraints: null, isRestricted: true },
        ]),
      }, after: null,
    });
  });
  it("commits an authorized assignment with the staged audit guard installed and refuses later history mutation", async () => {
    // Install the exact staged SQL into this suite's owned disposable database.
    // Installation commits before the real command opens its own transaction.
    try {
      await database.pool.query(auditGuardCandidateSql);
      await commands.assignUserRolesUseCase(targetId, [betaRole()], actor());
      expect(await currentMemberships(targetId)).toEqual([betaRole()]);
      expect(await auditRows()).toEqual([expect.objectContaining({
        actor: actorId, action: "identity.access.user_roles_replaced", target: `user:${targetId}`,
        changes: { before: { roleIds: [alphaRole()] }, after: { roleIds: [betaRole()] } },
      })]);
      const committed = await snapshot();
      for (const statement of [
        "UPDATE public.audit_events SET actor='synthetic-tampering' WHERE action='identity.access.user_roles_replaced'",
        "DELETE FROM public.audit_events WHERE action='identity.access.user_roles_replaced'",
        "TRUNCATE public.audit_events",
      ]) {
        await expect(database.pool.query(statement)).rejects.toMatchObject({ code: "23514" });
        expect(await snapshot()).toEqual(committed);
      }
    } finally {
      // Test teardown only, after the protected command and refusal assertions.
      // Remove solely this test's three new objects so ordinary fixture cleanup
      // can run; no existing schema, trigger, grant, or constraint is weakened.
      await database.pool.query(`
        DROP TRIGGER IF EXISTS identity_access_audit_history_immutable ON public.audit_events;
        DROP TRIGGER IF EXISTS identity_access_audit_history_truncate_immutable ON public.audit_events;
        DROP FUNCTION IF EXISTS public.guard_identity_access_audit_history();
      `);
    }
  });
  it("does not report a committed access change as failed when diagnostic delivery throws", async () => {
    const diagnostic = vi.spyOn(logger, "info").mockImplementation(() => { throw new Error("Synthetic diagnostic sink unavailable"); });
    try {
      await expect(commands.assignUserRolesUseCase(targetId, [betaRole()], actor())).resolves.toBeUndefined();
      expect(await currentMemberships(targetId)).toEqual([betaRole()]);
      expect(await auditRows()).toHaveLength(1);
      expect(diagnostic).toHaveBeenCalledWith("identity.access.user_roles_replaced", expect.objectContaining({ outcome: "succeeded" }));
    } finally { diagnostic.mockRestore(); }
  });
  it("preserves the original audit failure and rolled-back state when failure diagnostics also throw", async () => {
    const before = await snapshot();
    const diagnostic = vi.spyOn(logger, "error").mockImplementation(() => { throw new Error("Synthetic diagnostic sink unavailable"); });
    await database.pool.query(`CREATE FUNCTION public.reject_identity_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Synthetic audit failure'; END $$;
      CREATE TRIGGER reject_identity_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_identity_audit()`);
    try {
      await expect(commands.assignUserRolesUseCase(targetId, [betaRole()], actor())).rejects.toMatchObject({ code: "P0001", message: "Synthetic audit failure" });
      expect(await snapshot()).toEqual(before);
      expect(diagnostic).toHaveBeenCalledWith("identity.access.user_roles_replaced", expect.objectContaining({ outcome: "failed", error_code: "IDENTITY_ADMINISTRATION_FAILED" }));
    } finally {
      diagnostic.mockRestore();
      await database.pool.query("DROP TRIGGER reject_identity_audit ON public.audit_events; DROP FUNCTION public.reject_identity_audit()");
    }
  });
  const lockoutCases = [
    { name: "self assignment removal", run: () => commands.assignUserRolesUseCase(actorId, [], actor()) },
    { name: "last permission removal", run: () => commands.updateRolePermissionsUseCase(managerRole(), [permissions["users:manage_roles"]], actor()) },
    { name: "last assigned custom role deletion", run: () => commands.deleteRoleUseCase(managerRole(), actor()) },
    { name: "last manager deactivation", run: () => commands.updateUserUseCase(actorId, { active: 0 }, actor()) },
  ];
  it.each(lockoutCases)("rejects $name without changing authority or audit", async ({ run }) => {
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it.each(["users:view", "roles:view"])("does not remove the last manager's required %s UI access", async permission => {
    const remaining = Object.entries(permissions).filter(([key]) => (key.startsWith("users:") || key.startsWith("roles:")) && key !== permission).map(([, id]) => id);
    const before = await snapshot();
    await expect(commands.updateRolePermissionsUseCase(managerRole(), remaining, actor())).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it("does not count an inactive, scoped, or legacy-only backup as an access manager", async () => {
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [otherId, managerRole()]);
    await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [otherId]);
    await expect(commands.assignUserRolesUseCase(actorId, [], actor())).rejects.toMatchObject({ statusCode: 409 });
    await database.pool.query("UPDATE identity.users SET active=1 WHERE id=$1", [otherId]);
    await database.pool.query("UPDATE identity.auth_user_roles SET role_id=$1 WHERE user_id=$2", [roles["Limited administration"], otherId]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES($1,$2,'null'::jsonb),($1,$3,'{}'::jsonb)",
      [roles["Limited administration"], permissions["users:manage_roles"], permissions["roles:edit"]]);
    await expect(commands.assignUserRolesUseCase(actorId, [], actor())).rejects.toMatchObject({ statusCode: 409 });
    await database.pool.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [otherId]);
    await expect(commands.assignUserRolesUseCase(actorId, [], actor())).rejects.toMatchObject({ statusCode: 409 });
  });
  it("allows different people to retain membership and role-grant management", async () => {
    await setActorPermissions(["users:manage_roles"]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2)", [roles["Limited administration"], permissions["roles:edit"]]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [otherId, roles["Limited administration"]]);
    await commands.assignUserRolesUseCase(targetId, [], actor());
    expect(await currentMemberships(targetId)).toEqual([]);
  });
  it("does not manufacture missing managers while allowing an unrelated authorized edit", async () => {
    await setActorPermissions(["users:edit"]);
    await commands.updateUserUseCase(targetId, { displayName: "Unrelated profile edit" }, actor());
    expect(await currentMemberships(actorId)).toEqual([managerRole()]);
    expect((await database.pool.query(`SELECT p.resource || ':' || p.action AS key FROM identity.auth_role_permissions g
      JOIN identity.auth_permissions p ON p.id=g.permission_id WHERE g.role_id=$1`, [managerRole()])).rows).toEqual([{ key: "users:edit" }]);
  });
  it("serializes two concurrent deactivations so one current manager remains", async () => {
    await setActorPermissions(["users:edit"]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2),($1,$3)", [roles["Limited administration"], permissions["users:manage_roles"], permissions["roles:edit"]]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$3),($2,$3)", [targetId, otherId, roles["Limited administration"]]);
    const results = await Promise.allSettled([
      commands.updateUserUseCase(targetId, { active: 0 }, actor()),
      commands.updateUserUseCase(otherId, { active: 0 }, actor()),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected && rejected.status === "rejected" && rejected.reason).toMatchObject({ statusCode: 409 });
    expect((await database.pool.query("SELECT count(*)::int AS count FROM identity.users WHERE id IN ($1,$2) AND active=1", [targetId, otherId])).rows).toEqual([{ count: 1 }]);
    expect(await auditRows()).toHaveLength(1);
  });
  it("rechecks a waiting actor after a concurrent manager revokes their assignment", async () => {
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [otherId, managerRole()]);
    const results = await Promise.allSettled([
      commands.assignUserRolesUseCase(otherId, [], actor()),
      commands.assignUserRolesUseCase(actorId, [], { actorId: otherId }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected");
    expect(failure && failure.status === "rejected" && failure.reason).toMatchObject({ statusCode: 403 });
    expect((await currentMemberships(actorId)).length + (await currentMemberships(otherId)).length).toBe(1);
    expect(await auditRows()).toHaveLength(1);
  });
  it("holds current actor authority through commit against direct revocation", async () => {
    const blocker = await database.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      const pid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await blocker.query("SELECT id FROM identity.users WHERE id=$1 FOR UPDATE", [targetId]);
      pending = commands.assignUserRolesUseCase(targetId, [betaRole()], actor());
      const deadline = Date.now() + 5_000;
      while (true) {
        const blocked = (await database.pool.query<{ blocked: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked", [pid])).rows[0].blocked;
        if (blocked) break;
        if (Date.now() > deadline) throw new Error("Command did not reach its locked target");
        await delay(10);
      }
      const revoker = await database.pool.connect();
      try {
        await revoker.query("BEGIN; SET LOCAL lock_timeout='100ms'");
        await expect(revoker.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [actorId])).rejects.toMatchObject({ code: "55P03" });
      } finally {
        try { await revoker.query("ROLLBACK"); } finally { revoker.release(); }
      }
      await blocker.query("COMMIT");
      await pending;
    } finally {
      try { await blocker.query("ROLLBACK"); } finally { blocker.release(); }
      if (pending) await Promise.allSettled([pending]);
    }
  });
  it("preflights current access without mutating existing assignments, labels, grants or audit", async () => {
    const before = await snapshot();
    const result = await readIdentityAccessPreflight(connection.database!);
    expect(result).toEqual({ ready: true, activeAccounts: 3, unassignedActiveAccounts: 1,
      legacyLabelOnlyActiveAccounts: 1, capabilities: [
        { capability: "users:manage_roles", holders: 1, uiReadyHolders: 1 },
        { capability: "roles:edit", holders: 1, uiReadyHolders: 1 },
      ] });
    expect(await snapshot()).toEqual(before);
  });
  it("preflight reports UI-inaccessible managers separately without changing their command grants", async () => {
    await setActorPermissions(["users:manage_roles", "roles:edit"]);
    const before = await snapshot();
    expect(await readIdentityAccessPreflight(connection.database!)).toMatchObject({ ready: false, capabilities: [
      { capability: "users:manage_roles", holders: 1, uiReadyHolders: 0 },
      { capability: "roles:edit", holders: 1, uiReadyHolders: 0 },
    ] });
    expect(await snapshot()).toEqual(before);
  });
  it("preflight accepts different current people managing assignments and grants", async () => {
    await setActorPermissions(["users:manage_roles", "users:view", "roles:view"]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES($1,$2),($1,$3)",
      [roles["Limited administration"], permissions["roles:edit"], permissions["roles:view"]]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [otherId, roles["Limited administration"]]);
    expect(await readIdentityAccessPreflight(connection.database!)).toMatchObject({ ready: true, capabilities: [
      { capability: "users:manage_roles", holders: 1, uiReadyHolders: 1 },
      { capability: "roles:edit", holders: 1, uiReadyHolders: 1 },
    ] });
  });
  it("preflight excludes inactive and restricted grants and never treats legacy admin as access", async () => {
    await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [targetId, roles["Limited administration"]]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) SELECT $1,id,'null'::jsonb FROM identity.auth_permissions WHERE resource IN ('users','roles')", [roles["Limited administration"]]);
    const before = await snapshot();
    expect(await readIdentityAccessPreflight(connection.database!)).toEqual({ ready: false, activeAccounts: 2,
      unassignedActiveAccounts: 1, legacyLabelOnlyActiveAccounts: 1, capabilities: [
        { capability: "users:manage_roles", holders: 0, uiReadyHolders: 0 },
        { capability: "roles:edit", holders: 0, uiReadyHolders: 0 },
      ] });
    expect(await snapshot()).toEqual(before);
  });
  it.each([
    () => actualCommands.assignUserRolesUseCase(targetId,[],actor()),
    () => actualCommands.updateRolePermissionsUseCase(alphaRole(),[],actor()),
    () => actualCommands.deleteRoleUseCase(betaRole(),actor()),
  ])("rejects a replacement/deletion without a reviewed revision (%#)", async run => {
    const before = await snapshot();
    await expect(run()).rejects.toMatchObject({ statusCode: 428,code: "IDENTITY_ACCESS_REVIEW_REQUIRED" });
    expect(await snapshot()).toEqual(before);
  });
  it("rejects a stale role save without changing assignments or audit", async () => {
    const reviewed = await queryAccessReview(actorId,{ kind: "role",id: alphaRole(),permissionIds: [] });
    await commands.assignUserRolesUseCase(otherId,[betaRole()],actor());
    const before = await snapshot();
    await expect(actualCommands.updateRolePermissionsUseCase(alphaRole(),[],{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision: reviewed.revision }))
      .rejects.toMatchObject({ statusCode: 409,code: "IDENTITY_ACCESS_STALE" });
    expect(await snapshot()).toEqual(before);
  });
  it("serializes two saves of one reviewed state so exactly one succeeds", async () => {
    const expectedAccessRevision = (await queryAccessReview(actorId,{ kind: "user",id: targetId })).revision;
    const results = await Promise.allSettled([
      actualCommands.assignUserRolesUseCase(targetId,[betaRole()],{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision }),
      actualCommands.assignUserRolesUseCase(targetId,[],{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "IDENTITY_ACCESS_STALE" }) })]);
    expect(await auditRows()).toHaveLength(1);
  });
  it("review is read-only, reports custom-role effects and uses the same revision as saving", async () => {
    const before = await snapshot();
    const review = await queryAccessReview(actorId,{ kind: "user",id: targetId,roleIds: [betaRole()] });
    expect(review.users[0].after.permissions).toEqual(["orders:view"]);
    expect(review.users[0].before.permissions).toEqual(["inventory:view"]);
    expect(await snapshot()).toEqual(before);
    await actualCommands.assignUserRolesUseCase(targetId,[betaRole()],{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision: review.revision });
    expect(await currentMemberships(targetId)).toEqual([betaRole()]);
  });
  it("review without users:view does not expose staff identities or names", async () => {
    await setActorPermissions(["roles:view"]);
    const review = await queryAccessReview(actorId,{ kind: "role",id: alphaRole() });
    expect(review.affectedCount).toBe(1); expect(review.users).toEqual([]);
    expect(JSON.stringify(review)).not.toContain(targetId);
  });
  it("review refuses a proposed change based on an outdated snapshot", async () => {
    const review = await queryAccessReview(actorId,{ kind: "role",id: alphaRole() });
    await commands.updateUserUseCase(targetId,{ displayName: "Changed synthetic label" },actor());
    await expect(queryAccessReview(actorId,{ kind: "role",id: alphaRole(),permissionIds: [] },review.revision))
      .rejects.toMatchObject({ statusCode: 409,code: "IDENTITY_ACCESS_STALE" });
  });

  it("blocks a newly incomplete effective assignment and rolls back membership/audit changes",async () => {
    await database.pool.query("INSERT INTO identity.auth_permissions(resource,action,category) VALUES('shipments','view','shipping'),('shipments','view_costs','shipping') ON CONFLICT DO NOTHING");
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='shipments' AND action='view'",[alphaRole()]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='shipments' AND action='view_costs'",[betaRole()]);
    await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)",[targetId,betaRole()]);
    const review = await queryAccessReview(actorId,{ kind: "user",id: targetId,roleIds: [betaRole()] });
    expect(review.blockingDependencies).toEqual([{ userId: targetId,capability: "shipments:view_costs",required: "shipments:view" }]);
    const before = await snapshot();
    await expect(actualCommands.assignUserRolesUseCase(targetId,[betaRole()],{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision: review.revision }))
      .rejects.toMatchObject({ code: "IDENTITY_ACCESS_DEPENDENCIES",statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });
  it("keeps a dependency-satisfying custom-role union and permits explicit zero-access revocation",async () => {
    await database.pool.query("INSERT INTO identity.auth_permissions(resource,action,category) VALUES('shipments','view','shipping'),('shipments','view_costs','shipping') ON CONFLICT DO NOTHING");
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='shipments' AND action='view'",[alphaRole()]);
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) SELECT $1,id FROM identity.auth_permissions WHERE resource='shipments' AND action='view_costs'",[betaRole()]);
    const review = await queryAccessReview(actorId,{ kind: "user",id: targetId,roleIds: [alphaRole(),betaRole()] });
    expect(review.blockingDependencies).toEqual([]);
    await actualCommands.assignUserRolesUseCase(targetId,[alphaRole(),betaRole()],{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision: review.revision });
    await commands.assignUserRolesUseCase(targetId,[],actor());
    expect(await currentMemberships(targetId)).toEqual([]);
  });

  it("rejects a stale profile form that would reactivate a revoked account",async () => {
    const expectedAccessRevision = (await readAccessConfiguration(connection.database!)).revision;
    await actualCommands.updateUserUseCase(targetId,{ active: 0 },{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision });
    const before = await snapshot();
    await expect(actualCommands.updateUserUseCase(targetId,{ displayName: "Stale form label",active: 1 },{ credentialVersion: fixtureCredentialVersion, actorId,expectedAccessRevision }))
      .rejects.toMatchObject({ code: "IDENTITY_ACCESS_STALE",statusCode: 409 });
    expect(await snapshot()).toEqual(before);
  });

  it("requires a current review for activation changes but not a text-only profile edit",async () => {
    const before = await snapshot();
    await expect(actualCommands.updateUserUseCase(targetId,{ active: 0 },actor())).rejects.toMatchObject({ code: "IDENTITY_ACCESS_REVIEW_REQUIRED",statusCode: 428 });
    expect(await snapshot()).toEqual(before);
    await actualCommands.updateUserUseCase(targetId,{ displayName: "Explicit text-only edit" },actor());
    expect((await database.pool.query("SELECT active FROM identity.users WHERE id=$1",[targetId])).rows[0].active).toBe(1);
  });

  it("pairs user-list values with the access revision without disclosing role details or requiring roles:view",async () => {
    await setActorPermissions(["users:view"]);
    const before = await snapshot();
    const list = await queryStaffUserList(actorId);
    expect(list.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(list.revision).toBe((await readAccessConfiguration(connection.database!)).revision);
    expect(list.users.find(user => user.id === targetId)?.active).toBe(1);
    for(const user of list.users) { expect(user).not.toHaveProperty("password"); expect(user).not.toHaveProperty("permissions"); }
    expect(await snapshot()).toEqual(before);
  });

});
