/**
 * Transaction-scoped system-role authority readers & live authority change event bus (CI-03).
 * Deliberately free of database singletons.
 */
export {
  readStaffSystemRoleAuthority,
  readStaffSystemRoleAuthorityPg,
  hasAssignedSystemRole,
  type CurrentStaffAccess,
  type StaffSystemRole,
  type StaffSystemRoleAuthority,
} from "./staff-authority";
export {
  onStaffAuthorityChanged,
  notifyStaffAuthorityChanged,
  type StaffAuthorityChangeListener,
} from "./authority-events";
