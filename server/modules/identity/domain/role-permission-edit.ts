import { z } from "zod";

const identifier = z.number().int().positive().max(2_147_483_647);
const editSchema = z.object({
  roleId: identifier,
  permissionIds: z.array(identifier).refine(ids => new Set(ids).size === ids.length),
});

export class RolePermissionEditError extends Error {
  constructor(
    public readonly code: "IDENTITY_ROLE_PERMISSIONS_INVALID" | "IDENTITY_ROLE_NOT_FOUND" | "IDENTITY_ROLE_RESTRICTIONS_UNSUPPORTED",
    public readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "RolePermissionEditError";
  }
}

export function parseRolePermissionEdit(roleId: unknown, permissionIds: unknown) {
  const result = editSchema.safeParse({ roleId, permissionIds });
  if (!result.success) {
    throw new RolePermissionEditError("IDENTITY_ROLE_PERMISSIONS_INVALID", 400,
      "A valid role and an explicit list of distinct permission IDs are required.");
  }
  return result.data;
}

/** This editor has no scope contract; it must not remove or reinterpret one. */
export function assertRolePermissionEditSupported(exists: boolean, restricted: boolean): void {
  if (!exists) throw new RolePermissionEditError("IDENTITY_ROLE_NOT_FOUND", 404, "Role not found.");
  if (restricted) throw new RolePermissionEditError("IDENTITY_ROLE_RESTRICTIONS_UNSUPPORTED", 409,
    "This role's permissions are read-only in this editor because some grants contain restrictions.");
}
