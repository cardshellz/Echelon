/**
 * @echelon/identity — Users, Auth, RBAC
 *
 * Tables owned: users, userAudit, authRoles, authPermissions, authRolePermissions, authUserRoles
 * Depends on: nothing (leaf module)
 */

// Storage
export { type IUserStorage, userMethods } from "./identity.storage";
import { type IUserStorage, userMethods } from "./identity.storage";
export const identityStorage: IUserStorage = userMethods;

// RBAC
export {
  seedRBAC,
  seedDefaultChannels,
  seedAdjustmentReasons,
  getUserPermissions,
  getUserRoles,
  hasPermission,
  getAllRoles,
  getAllPermissions,
  getRolePermissions,
  createRole,
  updateRolePermissions,
  deleteRole,
  assignUserRoles,
} from "./rbac";
