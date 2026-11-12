/**
 * Pure domain authority schemas, role catalogs, and type contracts for `identity` (CI-03).
 * Deliberately free of infrastructure and database singleton imports so policy
 * modules and unit tests can import authority contracts without `DATABASE_URL`.
 */
export { SYSTEM_ROLES } from "./domain/identity.domain";
export {
  purchaseApprovalActorSchema,
  type PurchaseApprovalActor,
} from "./domain/purchase-approval-authority";
export {
  commandAuthorityActorSchema,
  type CommandAuthorityActor,
} from "./domain/command-authority";
export {
  hasAssignedSystemRole,
  assignedSystemRoleKeys,
  type CurrentStaffAccess,
  type StaffSystemRole,
  type StaffSystemRoleAuthority,
} from "./domain/staff-access";
export type { IdentityAdministrationActor } from "./domain/access-administration";
