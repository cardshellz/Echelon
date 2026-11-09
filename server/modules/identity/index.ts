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
export type { IdentityAdministrationActor } from "./domain/access-administration";

export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const permissions = await repository.getUserPermissions(userId);
  return hasStaffCapability(permissions, `${resource}:${action}`);
}

export { readPurchaseApprovalActor } from "./infrastructure/purchase-approval-access.repository";
export type { PurchaseApprovalActor } from "./domain/purchase-approval-authority";
export { readCommandAuthorityActor } from "./infrastructure/command-authority.repository";
export type { CommandAuthorityActor } from "./domain/command-authority";
export { readCurrentStaffAccess } from "./infrastructure/staff-access.repository";
export { hasAssignedSystemRole, assignedSystemRoleKeys } from "./domain/staff-access";
export type { CurrentStaffAccess, StaffSystemRole, StaffSystemRoleAuthority } from "./domain/staff-access";
export { readStaffCredentialState } from "./infrastructure/staff-credentials.repository";
export { isCurrentStaffCredential } from "./staff-session";
export { createStaffStreamObserver } from "./staff-stream";
export { readStaffSystemRoleAuthority, readStaffSystemRoleAuthorityPg } from "./staff-authority";
export { onStaffAuthorityChanged, notifyStaffAuthorityChanged } from "./authority-events";
export {
  recoverStaffPasswordBreakGlass,
  requestStaffPasswordRecoveryEmail,
  resetStaffPasswordWithToken,
  createStaffPasswordRecoveryToken,
  resolveStaffRecoveryEmail,
} from "./application/staff-credentials";
