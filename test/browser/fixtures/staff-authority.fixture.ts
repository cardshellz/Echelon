import { staffAuthoritySchema, type AssignedStaffRole, type StaffSystemRole } from "../../../client/src/lib/staff-authority";

type FixtureUser = {
  id: string;
  username: string;
  /** Compatibility label only. It never supplies an assignment or permission. */
  role: string;
  displayName?: string | null;
  active?: number;
  createdAt?: string | Date;
  lastLoginAt?: string | Date | null;
};

const systemAssignments: Record<StaffSystemRole, AssignedStaffRole> = {
  admin: { id: 1, name: "Administrator", isSystem: true },
  lead: { id: 2, name: "Team Lead", isSystem: true },
  picker: { id: 3, name: "Picker", isSystem: true },
};

/** Synthetic public /auth/me DTO. Callers explicitly choose roles and every grant. */
export function staffAuthorityFixture(options: {
  user: FixtureUser;
  permissions: readonly string[];
  systemRoles: readonly StaffSystemRole[];
  assignedRoles?: readonly AssignedStaffRole[];
}) {
  const assignedRoles = [
    ...options.systemRoles.map(role => ({ ...systemAssignments[role] })),
    ...(options.assignedRoles ?? []).map(role => ({ ...role })),
  ];
  return staffAuthoritySchema.parse({
    user: {
      displayName: null,
      active: 1,
      createdAt: "2026-11-04T00:00:00.000Z",
      lastLoginAt: null,
      ...options.user,
    },
    permissions: [...options.permissions],
    roles: assignedRoles.map(role => role.name),
    assignedRoles,
    systemRoles: [...options.systemRoles],
  });
}
