/**
 * @echelon/identity — Users, Auth, RBAC
 */

import * as repository from "./infrastructure/identity.repository";
import * as usecases from "./application/identity.use-cases";

// Storage
export const identityStorage = repository;

// RBAC
export const seedRBAC = usecases.seedRBACUseCase;
export const seedDefaultChannels = repository.seedDefaultChannels;
export const seedAdjustmentReasons = usecases.seedAdjustmentReasonsUseCase;

export const getUserPermissions = repository.getUserPermissions;
export const getUserRoles = repository.getUserRoles;
export const getAllRoles = repository.getAllRoles;
export const getAllPermissions = repository.getAllPermissions;
export const getRolePermissions = repository.getRolePermissions;

export const assignUserRoles = usecases.assignUserRolesUseCase;
export const createRole = usecases.createRoleUseCase;
export const updateRolePermissions = usecases.updateRolePermissionsUseCase;
export const deleteRole = repository.deleteRole; // Repo operation (no domain logic wrap needed yet)

export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const permissions = await repository.getUserPermissions(userId);
  return permissions.includes(`${resource}:${action}`);
}
