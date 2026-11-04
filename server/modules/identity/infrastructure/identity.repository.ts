import { db, users, eq, and, isNull, inArray, sql } from "../../../storage/base";
import { authRoles, authPermissions, authRolePermissions, authUserRoles, channels, adjustmentReasons } from "@shared/schema";
import type { User, InsertUser, SafeUser } from "../../../storage/base";
import type { AuthRole, AuthPermission, InsertAuthPermission } from "@shared/schema";
import { assertRolePermissionEditSupported, parseRolePermissionEdit } from "../domain/role-permission-edit";
import { assertRoleAssignmentTargets, parseRoleAssignment } from "../domain/role-assignment";

type Tx = typeof db | any; // Drizzle transaction or db instance
type IdentityTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Register definitions only. Startup must never recreate a revoked grant or membership. */
export async function registerIdentityDefinitions(
  permissions: readonly InsertAuthPermission[],
  roles: ReadonlyArray<{ name: string; description: string }>,
  tx: IdentityTransaction,
): Promise<{ permissionsRegistered: number; rolesRegistered: number }> {
  const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const orderedPermissions = [...permissions].sort((left, right) =>
    compare(left.resource, right.resource) || compare(left.action, right.action));
  const orderedRoles = [...roles].sort((left, right) => compare(left.name, right.name));
  const insertedPermissions = permissions.length === 0 ? [] : await tx.insert(authPermissions)
    .values(orderedPermissions)
    .onConflictDoNothing({ target: [authPermissions.resource, authPermissions.action] })
    .returning({ id: authPermissions.id });
  // A same-name custom role keeps its identity, metadata and grants unchanged.
  const insertedRoles = roles.length === 0 ? [] : await tx.insert(authRoles)
    .values(orderedRoles.map(role => ({ name: role.name, description: role.description, isSystem: 1 })))
    .onConflictDoNothing({ target: authRoles.name })
    .returning({ id: authRoles.id });
  return { permissionsRegistered: insertedPermissions.length, rolesRegistered: insertedRoles.length };
}

/** User Storage Methods */

export async function getUser(id: string, tx: Tx = db): Promise<User | undefined> {
  const result = await tx.select().from(users).where(eq(users.id, id));
  return result[0];
}

export async function getUserByUsername(username: string, tx: Tx = db): Promise<User | undefined> {
  const result = await tx.select().from(users).where(eq(users.username, username));
  return result[0];
}

export async function createUser(insertUser: InsertUser, tx: IdentityTransaction): Promise<User> {
  const result = await tx.insert(users).values(insertUser).returning();
  return result[0];
}

export async function updateUserLastLogin(id: string, tx: Tx = db): Promise<void> {
  await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
}

export async function updateUser(id: string, data: { displayName?: string; role?: string; password?: string; active?: number }, tx: IdentityTransaction): Promise<User | undefined> {
  const updateData: Partial<{ displayName: string; role: string; password: string; active: number }> = {};
  if (data.displayName !== undefined) updateData.displayName = data.displayName;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.password !== undefined) updateData.password = data.password;
  if (data.active !== undefined) updateData.active = data.active;
  if (Object.keys(updateData).length === 0) return undefined;
  
  const result = await tx.update(users).set(updateData).where(eq(users.id, id)).returning();
  return result[0];
}

export async function getAllUsers(tx: Tx = db): Promise<SafeUser[]> {
  const result = await tx.select({
    id: users.id,
    username: users.username,
    role: users.role,
    displayName: users.displayName,
    active: users.active,
    createdAt: users.createdAt,
    lastLoginAt: users.lastLoginAt,
  }).from(users);
  return result as SafeUser[];
}

/** RBAC Storage Methods */

export async function getUserPermissions(userId: string, tx: Tx = db): Promise<string[]> {
  const permissions = await tx
    .select({ resource: authPermissions.resource, action: authPermissions.action })
    .from(authUserRoles)
    .innerJoin(users, eq(users.id, authUserRoles.userId))
    .innerJoin(authRolePermissions, eq(authRolePermissions.roleId, authUserRoles.roleId))
    .innerJoin(authPermissions, eq(authPermissions.id, authRolePermissions.permissionId))
    // A saved session can outlive account deactivation. Resolve activity from
    // the same statement snapshot as memberships and grants. Generic checks
    // cannot evaluate record scopes: only SQL NULL means an unscoped grant.
    // JSONB null (like any other stored constraint) must not become global.
    .where(and(eq(authUserRoles.userId, userId), eq(users.active, 1),
      isNull(authRolePermissions.constraints)));
  
  const permSet = new Set(permissions.map((p: any) => `${p.resource}:${p.action}`));
  return Array.from(permSet) as string[];
}

export async function getUserRoles(userId: string, tx: Tx = db): Promise<AuthRole[]> {
  return await tx
    .select({
      id: authRoles.id,
      name: authRoles.name,
      description: authRoles.description,
      isSystem: authRoles.isSystem,
      createdAt: authRoles.createdAt,
      updatedAt: authRoles.updatedAt,
    })
    .from(authUserRoles)
    .innerJoin(authRoles, eq(authUserRoles.roleId, authRoles.id))
    .where(eq(authUserRoles.userId, userId));
}

export async function getAllRoles(tx: Tx = db): Promise<AuthRole[]> {
  return tx.select().from(authRoles).orderBy(authRoles.name);
}

export async function getAllPermissions(tx: Tx = db): Promise<AuthPermission[]> {
  return tx.select().from(authPermissions).orderBy(authPermissions.category, authPermissions.resource);
}

export async function getRolePermissions(roleId: number, tx: Tx = db): Promise<Array<AuthPermission & { isRestricted: boolean }>> {
  return await tx
    .select({
      id: authPermissions.id,
      resource: authPermissions.resource,
      action: authPermissions.action,
      description: authPermissions.description,
      category: authPermissions.category,
      createdAt: authPermissions.createdAt,
      isRestricted: sql<boolean>`${authRolePermissions.constraints} IS NOT NULL`,
    })
    .from(authRolePermissions)
    .innerJoin(authPermissions, eq(authRolePermissions.permissionId, authPermissions.id))
    .where(eq(authRolePermissions.roleId, roleId));
}

export async function createRole(name: string, description: string | null, permissionIds: number[], tx: IdentityTransaction): Promise<AuthRole> {
  const [role] = await tx.insert(authRoles).values({ name, description, isSystem: 0 }).returning();
  if (permissionIds.length > 0) {
    await tx.insert(authRolePermissions).values(
      permissionIds.map(permissionId => ({ roleId: role.id, permissionId }))
    );
  }
  return role;
}

// No pooled-db default: locks must cover the complete check and replacement.
export async function updateRolePermissions(roleId: number, permissionIds: number[], tx: IdentityTransaction): Promise<void> {
  const edit = parseRolePermissionEdit(roleId, permissionIds);
  const roles = await tx.select({ id: authRoles.id }).from(authRoles)
    .where(eq(authRoles.id, edit.roleId)).for("update");
  // Lock the parent before grants. FK-backed inserts wait on this parent lock;
  // existing row updates wait on the ordered grant locks below.
  const grants = roles.length === 0 ? [] : await tx.select({
    id: authRolePermissions.id,
    isRestricted: sql<boolean>`${authRolePermissions.constraints} IS NOT NULL`,
  }).from(authRolePermissions).where(eq(authRolePermissions.roleId, edit.roleId))
    .orderBy(authRolePermissions.id).for("update");
  assertRolePermissionEditSupported(roles.length > 0, grants.some(grant => grant.isRestricted));
  await tx.delete(authRolePermissions).where(eq(authRolePermissions.roleId, edit.roleId));
  if (edit.permissionIds.length > 0) {
    await tx.insert(authRolePermissions).values(
      edit.permissionIds.map(permissionId => ({ roleId: edit.roleId, permissionId }))
    );
  }
}

export async function deleteRole(roleId: number, tx: IdentityTransaction): Promise<boolean> {
  const role = await tx.select().from(authRoles).where(eq(authRoles.id, roleId)).limit(1);
  if (role.length === 0 || role[0].isSystem === 1) return false;
  await tx.delete(authRoles).where(eq(authRoles.id, roleId));
  return true;
}

export async function assignUserRoles(userId: string, roleIds: number[], tx: IdentityTransaction): Promise<void> {
  const assignment = parseRoleAssignment(userId, roleIds);
  // Match command readers' user-before-role order. The user lock serializes
  // replacements and protects the gap when the current assignment is empty.
  const target = await tx.select({ id: users.id }).from(users)
    .where(eq(users.id, assignment.userId)).for("update");
  assertRoleAssignmentTargets(target.length > 0, true);
  const roles = assignment.roleIds.length === 0 ? [] : await tx.select({ id: authRoles.id }).from(authRoles)
    .where(inArray(authRoles.id, assignment.roleIds)).orderBy(authRoles.id).for("share");
  assertRoleAssignmentTargets(true, roles.length === assignment.roleIds.length);
  await tx.delete(authUserRoles).where(eq(authUserRoles.userId, assignment.userId));
  if (assignment.roleIds.length > 0) {
    await tx.insert(authUserRoles).values(
      assignment.roleIds.map(roleId => ({ userId: assignment.userId, roleId }))
    );
  }
}

/** Seed functionalities mapping to DB directly */

export async function seedDefaultChannels() {
  console.log("Checking default channels...");
  try {
    const existingShopify = await db.execute(sql`SELECT id FROM channels.channels WHERE provider = 'shopify' LIMIT 1`);
    if (existingShopify.rows.length === 0) {
      await db.execute(sql`INSERT INTO channels (name, type, provider, status) VALUES ('Shopify Store', 'internal', 'shopify', 'active') ON CONFLICT DO NOTHING`);
    }
  } catch (error) {
    console.warn("Could not seed default channels:", error);
  }
}
