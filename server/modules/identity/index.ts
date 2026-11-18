/**
 * @echelon/identity — Users, Auth, RBAC
 */

import * as repository from "./infrastructure/identity.repository";
import * as usecases from "./application/identity.use-cases";
import { hasStaffCapability } from "@shared/staff-capabilities";

// Explicit public surface. Mutation primitives must not leak into composed storage.
export const identityStorage = {
  getUser: repository.getUser, getUserByUsername: repository.getUserByUsername,
  getAllUsers: repository.getAllUsers, getUserPermissions: repository.getUserPermissions,
  getUserRoles: repository.getUserRoles, getAllRoles: repository.getAllRoles,
  getAllPermissions: repository.getAllPermissions, getRolePermissions: repository.getRolePermissions,
  createUser: usecases.createUserUseCase, updateUser: usecases.updateUserUseCase,
  createRole: usecases.createRoleUseCase, deleteRole: usecases.deleteRoleUseCase,
  assignUserRoles: usecases.assignUserRolesUseCase, updateRolePermissions: usecases.updateRolePermissionsUseCase,
};

// RBAC
export const seedRBAC = usecases.seedRBACUseCase;
export const seedDefaultChannels = repository.seedDefaultChannels;
export const seedAdjustmentReasons = usecases.seedAdjustmentReasonsUseCase;

export const getUserPermissions = repository.getUserPermissions;
export const getUserRoles = repository.getUserRoles;
export const getAllRoles = repository.getAllRoles;
export const getAllPermissions = repository.getAllPermissions;
export const getRolePermissions = repository.getRolePermissions;

export { readWarehouseWorkActor, readWarehouseWorkEmployees } from "./infrastructure/work-access.repository";
export { readPickingReleaseActor } from "./infrastructure/picking-release-access.repository";

export const assignUserRoles = usecases.assignUserRolesUseCase;
export const createRole = usecases.createRoleUseCase;
export const updateRolePermissions = usecases.updateRolePermissionsUseCase;
export const deleteRole = usecases.deleteRoleUseCase;

export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const permissions = await repository.getUserPermissions(userId);
  return hasStaffCapability(permissions, `${resource}:${action}`);
}

export {
  SYSTEM_ROLES,
  purchaseApprovalActorSchema,
  commandAuthorityActorSchema,
  hasAssignedSystemRole,
  assignedSystemRoleKeys,
  type PurchaseApprovalActor,
  type CommandAuthorityActor,
  type CurrentStaffAccess,
  type StaffSystemRole,
  type StaffSystemRoleAuthority,
  type IdentityAdministrationActor,
} from "./authority-contracts.api";
export {
  readPurchaseApprovalActor,
  readPurchaseApproverName,
  readPurchaseInvoiceActionActor,
  type PurchaseApprovalIdentityTransaction,
} from "./purchase-approval-authority.api";
export { readCommandAuthorityActor } from "./command-authority.api";
export { readCurrentStaffAccess } from "./infrastructure/staff-access.repository";
export { readStaffCredentialState } from "./infrastructure/staff-credentials.repository";
export {
  createStaffSessionGate,
  isCurrentStaffCredential,
  createStaffStreamObserver,
} from "./staff-session.api";
export {
  readStaffSystemRoleAuthority,
  readStaffSystemRoleAuthorityPg,
  onStaffAuthorityChanged,
  notifyStaffAuthorityChanged,
  type StaffAuthorityChangeListener,
} from "./staff-authority.api";
export {
  recoverStaffPasswordBreakGlass,
  requestStaffPasswordRecoveryEmail,
  resetStaffPasswordWithToken,
  createStaffPasswordRecoveryToken,
  resolveStaffRecoveryEmail,
} from "./application/staff-credentials";
