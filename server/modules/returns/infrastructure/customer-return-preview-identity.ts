import type { CustomerReturnPreviewIdentityReader } from "../application/customer-return-preview-access";

/** Reuse Identity's current account/membership readers without exposing password fields. */
export const readCurrentPreviewIdentity: CustomerReturnPreviewIdentityReader = async userId => {
  const { identityStorage } = await import("../../identity");
  const user = await identityStorage.getUser(userId);
  if (!user) return null;
  const roles = await identityStorage.getUserRoles(userId);
  return { id: user.id, active: user.active, role: user.role,
    roles: roles.map(role => ({ name: role.name, isSystem: role.isSystem })) };
};
