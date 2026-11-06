export interface AccessConfiguration {
  revision: string;
  users: Array<{ id: string; label: string; active: number }>;
  roles: Array<{ id: number; name: string; system: number }>;
  permissions: Array<{ id: number; key: string }>;
  memberships: Array<{ userId: string; roleId: number }>;
  grants: Array<{ roleId: number; permissionId: number; restriction: string | null }>;
}
