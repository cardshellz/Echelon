import { describe, expect, it } from "vitest";
import { assertRolePermissionEditSupported, parseRolePermissionEdit } from "../../domain/role-permission-edit";

describe("generic role permission editor boundary", () => {
  it("accepts an explicit empty list or distinct positive IDs without mutating the caller", () => {
    const ids = [3, 1];
    const parsed = parseRolePermissionEdit(7, ids);
    expect(parsed).toEqual({ roleId: 7, permissionIds: [3, 1] });
    expect(parsed.permissionIds).not.toBe(ids);
    expect(parseRolePermissionEdit(7, [])).toEqual({ roleId: 7, permissionIds: [] });
  });
  it.each([undefined, null, "1", {}, [0], [-1], [1.5], ["1"], [1, 1], [2_147_483_648]])(
    "rejects invalid permission input %j instead of clearing or coercing grants", permissionIds => {
      expect(() => parseRolePermissionEdit(1, permissionIds)).toThrow(expect.objectContaining({
        code: "IDENTITY_ROLE_PERMISSIONS_INVALID", statusCode: 400,
      }));
    });
  it.each([undefined, null, "1", 0, -1, 1.5, NaN, 2_147_483_648])("rejects invalid role %j", roleId => {
    expect(() => parseRolePermissionEdit(roleId, [1])).toThrow(expect.objectContaining({
      code: "IDENTITY_ROLE_PERMISSIONS_INVALID", statusCode: 400,
    }));
  });
  it("does not reinterpret a restricted role in the generic editor", () => {
    expect(() => assertRolePermissionEditSupported(true, true)).toThrow(expect.objectContaining({
      code: "IDENTITY_ROLE_RESTRICTIONS_UNSUPPORTED", statusCode: 409,
    }));
    expect(() => assertRolePermissionEditSupported(true, false)).not.toThrow();
  });
  it("rejects a missing role", () => {
    expect(() => assertRolePermissionEditSupported(false, false)).toThrow(expect.objectContaining({
      code: "IDENTITY_ROLE_NOT_FOUND", statusCode: 404,
    }));
  });
});
