/** Public transaction authority contract; deliberately does not import a database singleton. */
export { readStaffSystemRoleAuthority, readStaffSystemRoleAuthorityPg } from "./infrastructure/staff-system-role-authority.repository";
export { hasAssignedSystemRole } from "./domain/staff-access";
export type { CurrentStaffAccess, StaffSystemRole, StaffSystemRoleAuthority } from "./domain/staff-access";
