import { z } from "zod";

export const staffSystemRoleSchema = z.enum(["admin", "lead", "picker"]);
export type StaffSystemRole = z.infer<typeof staffSystemRoleSchema>;
export const assignedStaffRoleSchema = z.object({
  id: z.number().int().positive().safe(), name: z.string().min(1), isSystem: z.boolean(),
});
export type AssignedStaffRole = z.infer<typeof assignedStaffRoleSchema>;
// Names are part of the existing built-in-role contract, not legacy user labels.
const systemRoleNames: Record<StaffSystemRole, string> = {
  admin: "Administrator", lead: "Team Lead", picker: "Picker",
};

// Older/malformed responses cannot turn the compatibility user.role into authority.
export const staffAuthoritySchema = z.object({
  user: z.object({
    id: z.string().min(1), username: z.string(), role: z.string(),
    displayName: z.string().nullable(), active: z.literal(1),
    createdAt: z.coerce.date(), lastLoginAt: z.coerce.date().nullable(),
  }),
  credentialActionRequired: z.boolean().default(false),
  permissions: z.array(z.string().regex(/^[^:\s]+:[^:\s]+$/)),
  roles: z.array(z.string().min(1)),
  assignedRoles: z.array(assignedStaffRoleSchema),
  systemRoles: z.array(staffSystemRoleSchema),
}).superRefine((value, context) => {
  const assignedNames = new Set(value.assignedRoles.map(role => role.name));
  const assignedSystemNames = new Set(value.assignedRoles.filter(role => role.isSystem).map(role => role.name));
  const claimedSystemNames = new Set(value.systemRoles.map(role => systemRoleNames[role]));
  if (new Set(value.assignedRoles.map(role => role.id)).size !== value.assignedRoles.length
    || value.roles.length !== assignedNames.size || value.roles.some(name => !assignedNames.has(name))
    || claimedSystemNames.size !== value.systemRoles.length
    || claimedSystemNames.size !== assignedSystemNames.size
    || [...claimedSystemNames].some(name => !assignedSystemNames.has(name))
    || (value.assignedRoles.length === 0 && value.permissions.length > 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent assigned-role metadata" });
  }
});
export type StaffAuthority = z.infer<typeof staffAuthoritySchema>;

export function staffAuthorityKey(value: StaffAuthority): string {
  return JSON.stringify([value.user.id, value.credentialActionRequired, [...value.permissions].sort(),
    [...value.assignedRoles].sort((left, right) => left.id - right.id), [...value.systemRoles].sort()]);
}
