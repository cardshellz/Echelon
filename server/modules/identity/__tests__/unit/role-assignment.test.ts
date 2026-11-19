import { describe, expect, it } from "vitest";
import { RoleAssignmentError, assertRoleAssignmentTargets, parseRoleAssignment } from "../../domain/role-assignment";

describe("explicit employee role assignment boundary", () => {
  it("requires an explicit list, permits clearing and copies the caller's role IDs", () => {
    const roleIds = Object.freeze([7, 3]);
    const parsed = parseRoleAssignment("employee-key", roleIds);
    expect(parsed).toEqual({ userId: "employee-key", roleIds: [7, 3] });
    expect(parsed.roleIds).not.toBe(roleIds);
    parsed.roleIds.push(9);
    expect(roleIds).toEqual([7, 3]);
    expect(parseRoleAssignment("employee-key", [])).toEqual({ userId: "employee-key", roleIds: [] });
    expect(parseRoleAssignment("employee-key", [2_147_483_647]).roleIds).toEqual([2_147_483_647]);
  });
  it.each(["legacy-user", " employee-key ", "employee/legacy:1", "員工-1"])("preserves exact nonblank user ID %s without UUID assumptions", userId => {
    expect(parseRoleAssignment(userId, [1]).userId).toBe(userId);
  });
  it.each([undefined, null, false, true, 0, 1, [], {}, "", " \t\n"])("rejects invalid user ID %j without coercion", userId => {
    expect(() => parseRoleAssignment(userId, [1])).toThrow(RoleAssignmentError);
    expect(() => parseRoleAssignment(userId, [1])).toThrow(expect.objectContaining({
      code: "IDENTITY_ROLE_ASSIGNMENT_INVALID", statusCode: 400,
    }));
  });
  it.each([undefined, null, false, "", 0, 1, {}, [0], [-1], [1.5], ["1"], [null], [true],
    [1, 1], [2_147_483_648], [Infinity], [NaN], [[1]], new Set([1])])(
    "rejects invalid role list %j rather than clearing or coercing memberships", roleIds => {
      expect(() => parseRoleAssignment("employee-key", roleIds)).toThrow(expect.objectContaining({
        code: "IDENTITY_ROLE_ASSIGNMENT_INVALID", statusCode: 400,
      }));
    });
  it("distinguishes a missing target user from a missing selected role", () => {
    expect(() => assertRoleAssignmentTargets(false, false)).toThrow(expect.objectContaining({ code: "IDENTITY_USER_NOT_FOUND", statusCode: 404 }));
    expect(() => assertRoleAssignmentTargets(true, false)).toThrow(expect.objectContaining({ code: "IDENTITY_ASSIGNED_ROLE_NOT_FOUND", statusCode: 404 }));
    expect(() => assertRoleAssignmentTargets(true, true)).not.toThrow();
  });
});
