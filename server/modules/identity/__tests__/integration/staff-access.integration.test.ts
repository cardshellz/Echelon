import { setTimeout as delay } from "node:timers/promises";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@shared/schema";
import { validatePostgresTestEnvironment } from "../../../../../scripts/ci/postgres-tests";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { identityAdministrationFixtureSql } from "../fixtures/identity-administration.fixture";

// Every reader is given this suite's isolated executor. Importing the snapshot
// reader must not initialize an ambient application database or provider client.
vi.mock("../../../../db", () => ({ db: new Proxy({}, {
  get() { throw new Error("Staff access tests require their explicit disposable executor"); },
}) }));
import { readCurrentStaffAccess } from "../../infrastructure/staff-access.repository";
import { readStaffSystemRoleAuthority, readStaffSystemRoleAuthorityPg } from "../../staff-authority";
import { hasAssignedSystemRole } from "../../domain/staff-access";

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
if (databaseUrl) validatePostgresTestEnvironment(process.env);
const integration = databaseUrl ? describe.sequential : describe.skip;

integration("current staff snapshots and transaction-held explicit roles", () => {
  let database: InventoryCutoverTestDatabase;
  let executor: NodePgDatabase<typeof schema>;
  let roles: Record<string, number>;
  let permissions: Record<string, number>;
  const actorId = "staff-reader-fixture";

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, true, identityAdministrationFixtureSql);
    executor = drizzle(database.pool, { schema });
    permissions = Object.fromEntries((await database.pool.query<{ id: number; key: string }>(
      "SELECT id,resource || ':' || action AS key FROM identity.auth_permissions",
    )).rows.map(row => [row.key, row.id]));
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query("TRUNCATE identity.auth_user_roles,identity.auth_role_permissions,identity.auth_roles,identity.users CASCADE");
    await database.pool.query("INSERT INTO identity.users(id,username,password,role,display_name,last_login_at) VALUES($1::varchar,$1::text,'synthetic-never-returned-password','admin','Synthetic operator','2026-11-04T12:00:00')", [actorId]);
    roles = Object.fromEntries((await database.pool.query<{ id: number; name: string }>(`
      INSERT INTO identity.auth_roles(name,is_system) VALUES
        ('Administrator',1),('Team Lead',1),('Picker',1),('Custom stock analyst',0)
      RETURNING id,name
    `)).rows.map(row => [row.name, row.id]));
  });
  async function assign(roleIds: number[]) {
    for (const roleId of roleIds) await database.pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [actorId, roleId]);
  }
  async function grant(roleId: number, permission: string, constraintJson?: string) {
    await database.pool.query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES($1,$2,$3::jsonb)", [roleId, permissions[permission], constraintJson ?? null]);
  }
  async function read() { return readCurrentStaffAccess(actorId, executor); }

  it("keeps an active zero-role identity available without inferring authority from its legacy admin label", async () => {
    const access = await read();
    expect(access).toMatchObject({ user: { id: actorId, active: 1, role: "admin" }, roles: [], permissions: [] });
    expect(hasAssignedSystemRole(access, ["admin", "lead", "picker"])).toBe(false);
  });
  it.each(["missing", "inactive"])("does not expose a current staff identity for an %s account", async kind => {
    if (kind === "missing") await database.pool.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
    else await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    expect(await read()).toBeUndefined();
  });
  it("returns multiple explicit roles and a deduplicated union of unrestricted capabilities", async () => {
    await assign([roles.Administrator, roles["Custom stock analyst"]]);
    await grant(roles.Administrator, "inventory:view");
    await grant(roles["Custom stock analyst"], "inventory:view");
    await grant(roles["Custom stock analyst"], "orders:view");
    expect(await read()).toMatchObject({
      roles: [
        { id: roles.Administrator, name: "Administrator", isSystem: true },
        { id: roles["Custom stock analyst"], name: "Custom stock analyst", isSystem: false },
      ], permissions: ["inventory:view", "orders:view"],
    });
  });
  it.each(["null", "{}", "false", "0", '"scope"', "[]", '{"warehouseId":1}'])(
    "does not broaden stored %s constraints into global authority", async constraint => {
      await assign([roles["Custom stock analyst"]]);
      await grant(roles["Custom stock analyst"], "inventory:view");
      await grant(roles["Custom stock analyst"], "orders:view", constraint);
      expect((await read())?.permissions).toEqual(["inventory:view"]);
    },
  );
  it("returns safe account fields and normalized dates without reading a password into the DTO", async () => {
    const access = await read();
    expect(access?.user.createdAt).toBeInstanceOf(Date);
    expect(access?.user.lastLoginAt).toEqual(new Date("2026-11-04T12:00:00Z"));
    expect(access?.user).not.toHaveProperty("password");
    expect(JSON.stringify(access)).not.toContain("synthetic-never-returned-password");
  });
  it("rechecks assignment and account activity on subsequent reads", async () => {
    await assign([roles.Administrator]);
    await grant(roles.Administrator, "users:edit");
    expect((await read())?.permissions).toEqual(["users:edit"]);
    await database.pool.query("DELETE FROM identity.auth_user_roles WHERE user_id=$1", [actorId]);
    expect(await read()).toMatchObject({ roles: [], permissions: [] });
    await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
    expect(await read()).toBeUndefined();
  });
  it("matches exact opaque IDs instead of trimming into a different account", async () => {
    expect(await readCurrentStaffAccess(` ${actorId} `, executor)).toBeUndefined();
    const paddedId = " padded-staff-fixture ";
    await database.pool.query("INSERT INTO identity.users(id,username,password) VALUES($1::varchar,$1::text,'synthetic-padded-password')", [paddedId]);
    expect(await readCurrentStaffAccess(paddedId, executor)).toMatchObject({ user: { id: paddedId }, roles: [], permissions: [] });
  });
  it("does not treat a custom same-name role as a protected system role", async () => {
    await database.pool.query("UPDATE identity.auth_roles SET is_system=0 WHERE id=$1", [roles.Administrator]);
    await assign([roles.Administrator]);
    await grant(roles.Administrator, "users:edit");
    const access = await read();
    expect(access?.permissions).toEqual(["users:edit"]);
    expect(hasAssignedSystemRole(access, ["admin"])).toBe(false);
  });

  const readers = [
    { name: "Drizzle", read: (client: PoolClient, id: string) => readStaffSystemRoleAuthority(drizzle(client, { schema }), id) },
    { name: "node-postgres", read: (client: PoolClient, id: string) => readStaffSystemRoleAuthorityPg(client, id) },
  ];
  const authorityMutations: ReadonlyArray<{ name: string; statement: string; values: () => Array<string | number> }> = [
    { name: "account deactivation", statement: "UPDATE identity.users SET active=0 WHERE id=$1", values: () => [actorId] },
    { name: "membership removal", statement: "DELETE FROM identity.auth_user_roles WHERE user_id=$1", values: () => [actorId] },
    { name: "system-role demotion", statement: "UPDATE identity.auth_roles SET is_system=0 WHERE id=$1", values: () => [roles.Administrator] },
  ];
  async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } finally {
      try { await client.query("ROLLBACK"); } finally { client.release(); }
    }
  }
  for (const reader of readers) {
    describe(reader.name, () => {
      it("returns no system authority for an active unassigned legacy admin", async () => {
        expect(await inTransaction(client => reader.read(client, actorId))).toEqual({ active: true, roles: [] });
      });
      it.each(["missing", "inactive"])("returns inactive authority for an %s account", async kind => {
        if (kind === "missing") await database.pool.query("DELETE FROM identity.users WHERE id=$1", [actorId]);
        else await database.pool.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
        expect(await inTransaction(client => reader.read(client, actorId))).toEqual({ active: false, roles: [] });
      });
      it("returns only exact assigned system roles without an implicit hierarchy", async () => {
        await database.pool.query("UPDATE identity.users SET role='picker' WHERE id=$1", [actorId]);
        await assign([roles.Administrator, roles["Team Lead"], roles["Custom stock analyst"]]);
        expect(await inTransaction(client => reader.read(client, actorId))).toEqual({ active: true, roles: ["admin", "lead"] });
      });
      it("does not promote a same-name custom role to system authority", async () => {
        await database.pool.query("UPDATE identity.auth_roles SET is_system=0 WHERE id=$1", [roles.Administrator]);
        await assign([roles.Administrator]);
        expect(await inTransaction(client => reader.read(client, actorId))).toEqual({ active: true, roles: [] });
      });
      it("preserves exact actor identity", async () => {
        await assign([roles.Administrator]);
        expect(await inTransaction(client => reader.read(client, ` ${actorId} `))).toEqual({ active: false, roles: [] });
      });
      it.each(authorityMutations)("holds authority through commit against $name", async mutation => {
        await assign([roles.Administrator]);
        await inTransaction(async client => {
          expect(await reader.read(client, actorId)).toEqual({ active: true, roles: ["admin"] });
          const rival = await database.pool.connect();
          try {
            await rival.query("BEGIN; SET LOCAL lock_timeout='100ms'");
            await expect(rival.query(mutation.statement, mutation.values())).rejects.toMatchObject({ code: "55P03" });
          } finally {
            try { await rival.query("ROLLBACK"); } finally { rival.release(); }
          }
        });
        await database.pool.query(mutation.statement, mutation.values());
        const result = await inTransaction(client => reader.read(client, actorId));
        expect(result.roles).toEqual([]);
      });
      it("sees deactivation committed before its account lock becomes available", async () => {
        await assign([roles.Administrator]);
        const revoker = await database.pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await revoker.query("BEGIN");
          const pid = (await revoker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
          await revoker.query("UPDATE identity.users SET active=0 WHERE id=$1", [actorId]);
          pending = inTransaction(client => reader.read(client, actorId));
          const deadline = Date.now() + 5_000;
          while (true) {
            const blocked = (await database.pool.query<{ blocked: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::int=ANY(pg_blocking_pids(pid))) AS blocked", [pid])).rows[0].blocked;
            if (blocked) break;
            if (Date.now() > deadline) throw new Error("Staff reader did not wait for the account lock");
            await delay(10);
          }
          await revoker.query("COMMIT");
          expect(await pending).toEqual({ active: false, roles: [] });
        } finally {
          try { await revoker.query("ROLLBACK"); } finally { revoker.release(); }
          if (pending) await Promise.allSettled([pending]);
        }
      });
    });
  }
});
