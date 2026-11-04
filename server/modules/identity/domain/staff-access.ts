import type { SafeUser } from "@shared/schema";
import { SYSTEM_ROLES } from "./identity.domain";

export type StaffSystemRole = "admin" | "lead" | "picker";

export interface AssignedStaffRole {
  id: number;
  name: string;
  isSystem: boolean;
}

/** A current, active identity snapshot. The legacy user.role is display data only. */
export interface CurrentStaffAccess {
  user: SafeUser;
  roles: AssignedStaffRole[];
  permissions: string[];
}

export interface StaffSystemRoleAuthority {
  active: boolean;
  roles: StaffSystemRole[];
}

export function assignedSystemRoleKeys(roles: readonly AssignedStaffRole[]): StaffSystemRole[] {
  const keys: StaffSystemRole[] = ["admin", "lead", "picker"];
  return keys.filter(key => roles.some(role => role.isSystem && role.name === SYSTEM_ROLES[key].name));
}

/** Exact assignments only: neither a profile label nor an implied role hierarchy grants access. */
export function hasAssignedSystemRole(
  access: CurrentStaffAccess | undefined,
  allowed: readonly StaffSystemRole[],
): boolean {
  return access?.user.active === 1 && assignedSystemRoleKeys(access.roles).some(role => allowed.includes(role));
}
