import { z } from "zod";

const roleAssignmentSchema = z.object({
  // IDs are opaque varchar values; do not coerce or trim a different identity.
  userId: z.string().min(1).refine(id => id.trim().length > 0),
  roleIds: z.array(z.number().int().positive().max(2_147_483_647))
    .refine(ids => new Set(ids).size === ids.length),
});

export class RoleAssignmentError extends Error {
  constructor(
    public readonly code: "IDENTITY_ROLE_ASSIGNMENT_INVALID" | "IDENTITY_USER_NOT_FOUND" | "IDENTITY_ASSIGNED_ROLE_NOT_FOUND",
    public readonly statusCode: 400 | 404,
    message: string,
  ) {
    super(message);
    this.name = "RoleAssignmentError";
  }
}

export function parseRoleAssignment(userId: unknown, roleIds: unknown) {
  const parsed = roleAssignmentSchema.safeParse({ userId, roleIds });
  if (!parsed.success) {
    throw new RoleAssignmentError("IDENTITY_ROLE_ASSIGNMENT_INVALID", 400,
      "A user ID and an explicit list of distinct role IDs are required.");
  }
  return parsed.data;
}

export function assertRoleAssignmentTargets(userExists: boolean, allRolesExist: boolean): void {
  if (!userExists) throw new RoleAssignmentError("IDENTITY_USER_NOT_FOUND", 404, "User not found.");
  if (!allRolesExist) throw new RoleAssignmentError("IDENTITY_ASSIGNED_ROLE_NOT_FOUND", 404,
    "One or more selected roles no longer exist.");
}
