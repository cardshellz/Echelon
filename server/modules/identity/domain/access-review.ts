import { accessReviewSchema, type EffectiveStaffAccess, missingCapabilityDependencies, newCapabilityDependencyGaps, effectiveStaffCapabilities } from "@shared/staff-capabilities";
import type { AccessConfiguration } from "./access-configuration";
import { IdentityAdministrationError } from "./access-administration";

export type AccessProposal = { kind: "role"; id: number; permissionIds?: number[]; removeRole?: boolean } | { kind: "user"; id: string; roleIds?: number[] };
export function effectiveAccess(configuration: AccessConfiguration, userId: string, proposal?: AccessProposal): EffectiveStaffAccess {
  const user = configuration.users.find(item => item.id === userId);
  if (!user) throw new IdentityAdministrationError("IDENTITY_USER_NOT_FOUND", 404, "User not found.");
  const assignedIds = proposal?.kind === "user" && proposal.id === userId && proposal.roleIds !== undefined
    ? proposal.roleIds : configuration.memberships.filter(item => item.userId === userId).map(item => item.roleId);
  const roleIds = proposal?.kind === "role" && proposal.removeRole ? assignedIds.filter(id => id !== proposal.id) : assignedIds;
  const sources = roleIds.flatMap(roleId => {
    const grants = proposal?.kind === "role" && proposal.id === roleId && proposal.permissionIds !== undefined
      ? proposal.permissionIds.map(permissionId => ({ permissionId, restriction: null }))
      : configuration.grants.filter(item => item.roleId === roleId);
    return grants.map(grant => ({ permission: configuration.permissions.find(item => item.id === grant.permissionId)?.key ?? "unknown",
      roleId, roleName: configuration.roles.find(role => role.id === roleId)?.name, restricted: grant.restriction !== null }));
  });
  const grantedPermissions = user.active === 1 ? [...new Set(sources.filter(item => !item.restricted).map(item => item.permission))].sort() : [];
  return { userId, label: user.label, active: user.active === 1, roleIds: [...roleIds].sort((a,b) => a-b), sources,
    permissions: effectiveStaffCapabilities(grantedPermissions), grantedPermissions,
    restrictedPermissions: [...new Set(sources.filter(item => item.restricted).map(item => item.permission))].sort() };
}
export function buildAccessReview(configuration: AccessConfiguration, proposal: AccessProposal, showLabels: boolean) {
  if (proposal.kind === "role" && proposal.permissionIds?.some(id => !configuration.permissions.some(permission => permission.id === id))
    || proposal.kind === "user" && proposal.roleIds?.some(id => !configuration.roles.some(role => role.id === id)))
    throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 400, "Review contains an unknown permission or role.");
  if (proposal.kind === "role" && !configuration.roles.some(role => role.id === proposal.id))
    throw new IdentityAdministrationError("IDENTITY_ADMINISTRATION_INVALID", 404, "Role not found.");
  const ids = proposal.kind === "user" ? [proposal.id] : configuration.memberships.filter(item => item.roleId === proposal.id).map(item => item.userId);
  const users = [...new Set(ids)].map(id => {
    const before = effectiveAccess(configuration,id), after = effectiveAccess(configuration,id,proposal);
    if (!showLabels) { delete before.label; delete after.label; }
    return { before, after };
  });
  return accessReviewSchema.parse({
    revision: configuration.revision,
    restricted: proposal.kind === "role" && configuration.grants.some(grant => grant.roleId === proposal.id && grant.restriction !== null),
    permissionIds: proposal.kind === "role" ? configuration.grants.filter(grant => grant.roleId === proposal.id).map(grant => grant.permissionId) : [],
    roleIds: proposal.kind === "user" ? configuration.memberships.filter(item => item.userId === proposal.id).map(item => item.roleId) : [],
    affectedCount: users.length, users,
    dependencies: users.flatMap(user => missingCapabilityDependencies(user.after.grantedPermissions).map(missing => ({ userId: user.after.userId, ...missing }))),
    blockingDependencies: users.flatMap(user => newCapabilityDependencyGaps(user.before.grantedPermissions,user.after.grantedPermissions)
      .map(missing => ({ userId: user.after.userId, ...missing }))),
    coverage: "migrated-workflows-only",
  });
}
/** Do not make legacy incomplete configurations uneditable. Block newly introduced
 * dependency violations, while runtime continues to deny every incomplete capability.
 */
export function assertNoNewDependencyGaps(before: AccessConfiguration, after: AccessConfiguration) {
  for (const user of after.users.filter(item => item.active === 1)) {
    const prior = before.users.some(item => item.id === user.id) ? effectiveAccess(before,user.id).grantedPermissions : [];
    if (newCapabilityDependencyGaps(prior,effectiveAccess(after,user.id).grantedPermissions).length > 0)
      throw new IdentityAdministrationError("IDENTITY_ACCESS_DEPENDENCIES", 409, "A user's proposed access is missing required capabilities. Review dependencies before saving.");
  }
}
