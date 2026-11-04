import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { hasAssignedSystemRole, assignedSystemRoleKeys, type CurrentStaffAccess } from "../../domain/staff-access";
const execute = vi.hoisted(() => vi.fn());
vi.mock("../../../../db", () => ({ db: { execute } }));
import { readCurrentStaffAccess } from "../../infrastructure/staff-access.repository";
import { readStaffSystemRoleAuthority, readStaffSystemRoleAuthorityPg } from "../../staff-authority";

const user = { id: "staff", username: "Staff", role: "admin", displayName: null,
  active: 1, createdAt: new Date("2026-11-04T00:00:00Z"), lastLoginAt: null };
const admin = { id: 1, name: "Administrator", isSystem: true };
const picker = { id: 2, name: "Picker", isSystem: true };
const custom = { id: 3, name: "Purchasing specialist", isSystem: false };
const access = (roles = [admin]): CurrentStaffAccess => ({ user, roles, permissions: [] });
beforeEach(() => execute.mockReset());

describe("explicit staff authority", () => {
  it("never grants authority from an old user role label, custom names, or an implicit hierarchy", () => {
    expect(hasAssignedSystemRole(access([]), ["admin"])).toBe(false);
    expect(hasAssignedSystemRole(access([{ ...admin, isSystem: false }]), ["admin"])).toBe(false);
    expect(hasAssignedSystemRole(access([admin]), ["lead", "picker"])).toBe(false);
    expect(hasAssignedSystemRole(access([picker, custom]), ["admin"])).toBe(false);
    expect(hasAssignedSystemRole(undefined, ["admin"])).toBe(false);
    expect(hasAssignedSystemRole({ ...access(), user: { ...user, active: 0 } }, ["admin"])).toBe(false);
  });
  it("accepts actual multiple assignments and classifies system roles deterministically", () => {
    expect(hasAssignedSystemRole(access([custom, picker, admin]), ["picker"])).toBe(true);
    expect(assignedSystemRoleKeys([picker, admin, admin, custom])).toEqual(["admin", "picker"]);
  });
});

describe("one-statement current account snapshot", () => {
  it("returns custom and multiple assignments, deduplicated permissions and only safe user fields", async () => {
    execute.mockResolvedValue({ rows: [{ ...user, password: "must-never-return", roles: [admin, custom],
      permissions: ["orders:view", "inventory:view", "orders:view"] }] });
    const result = await readCurrentStaffAccess("staff");
    expect(result).toEqual({ user, roles: [admin, custom], permissions: ["inventory:view", "orders:view"] });
    expect(execute).toHaveBeenCalledOnce();
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual(["staff"]);
    expect(query.sql).not.toContain("password");
    expect(query.sql).toContain("grant_row.constraints IS NULL");
  });
  it("retains intentional zero roles and distinguishes absent/inactive identity", async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...user, roles: [], permissions: [] }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await readCurrentStaffAccess("staff")).toEqual({ user, roles: [], permissions: [] });
    expect(await readCurrentStaffAccess("inactive")).toBeUndefined();
  });
  it("accepts actual driver timestamps but rejects malformed authority instead of inventing an empty grant", async () => {
    execute.mockResolvedValueOnce({ rows: [{ ...user, createdAt: "2026-11-04 00:00:00", roles: [], permissions: [] }] });
    expect((await readCurrentStaffAccess("staff"))?.user.createdAt).toBeInstanceOf(Date);
    execute.mockResolvedValueOnce({ rows: [{ ...user, createdAt: "not-a-date", roles: [], permissions: [] }] });
    await expect(readCurrentStaffAccess("staff")).rejects.toThrow();
    execute.mockResolvedValueOnce({ rows: [{ ...user, roles: [{ ...admin, isSystem: "true" }], permissions: [] }] });
    await expect(readCurrentStaffAccess("staff")).rejects.toThrow();
  });
  it.each(["", " "])("rejects invalid identity %j without a database request", async id => {
    await expect(readCurrentStaffAccess(id)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("transaction-held system assignment authority", () => {
  it("locks account then ordered roles/memberships, without legacy fallback", async () => {
    execute.mockResolvedValueOnce({ rows: [{ active: 1 }] }).mockResolvedValueOnce({ rows: [custom, picker] });
    expect(await readStaffSystemRoleAuthority({ execute }, "staff")).toEqual({ active: true, roles: ["picker"] });
    const queries = execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
    expect(queries[0].sql).toContain("FOR SHARE");
    expect(queries[1].sql).toContain("FOR SHARE OF role, assignment");
    expect(queries.every(query => query.params[0] === "staff")).toBe(true);
  });
  it.each([{ rows: [] }, { rows: [{ active: 0 }] }])("denies absent/inactive accounts before reading grants", async ({ rows }) => {
    execute.mockResolvedValueOnce({ rows });
    expect(await readStaffSystemRoleAuthority({ execute }, "staff")).toEqual({ active: false, roles: [] });
    expect(execute).toHaveBeenCalledOnce();
  });
  it("node-postgres uses the same parameterized statements and preserves opaque user IDs", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ active: 1 }] }).mockResolvedValueOnce({ rows: [admin] });
    expect(await readStaffSystemRoleAuthorityPg({ query }, " actor' ")).toEqual({ active: true, roles: ["admin"] });
    expect(query.mock.calls[0][0]).not.toContain("actor");
    expect(query.mock.calls[0][1]).toEqual([" actor' "]);
  });
});
