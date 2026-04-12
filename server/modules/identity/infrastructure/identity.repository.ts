import { db, users, eq, and, inArray, sql } from "../../../storage/base";
import { authRoles, authPermissions, authRolePermissions, authUserRoles, channels, adjustmentReasons } from "@shared/schema";
import type { User, InsertUser, SafeUser } from "../../../storage/base";
import type { AuthRole, AuthPermission } from "@shared/schema";

type Tx = typeof db | any; // Drizzle transaction or db instance

/** User Storage Methods */

export async function getUser(id: string, tx: Tx = db): Promise<User | undefined> {
  const result = await tx.select().from(users).where(eq(users.id, id));
  return result[0];
}

export async function getUserByUsername(username: string, tx: Tx = db): Promise<User | undefined> {
  const result = await tx.select().from(users).where(eq(users.username, username));
  return result[0];
}

export async function createUser(insertUser: InsertUser, tx: Tx = db): Promise<User> {
  const result = await tx.insert(users).values(insertUser).returning();
  return result[0];
}

export async function updateUserLastLogin(id: string, tx: Tx = db): Promise<void> {
  await tx.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
}

export async function updateUser(id: string, data: { displayName?: string; role?: string; password?: string; active?: number }, tx: Tx = db): Promise<User | undefined> {
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
  const userRoles = await tx
    .select({ roleId: authUserRoles.roleId })
    .from(authUserRoles)
    .where(eq(authUserRoles.userId, userId));
  
  if (userRoles.length === 0) return [];
  
  const roleIds = userRoles.map((r: any) => r.roleId);
  const permissions = await tx
    .select({ resource: authPermissions.resource, action: authPermissions.action })
    .from(authRolePermissions)
    .innerJoin(authPermissions, eq(authRolePermissions.permissionId, authPermissions.id))
    .where(inArray(authRolePermissions.roleId, roleIds));
  
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

export async function getRolePermissions(roleId: number, tx: Tx = db): Promise<AuthPermission[]> {
  return await tx
    .select({
      id: authPermissions.id,
      resource: authPermissions.resource,
      action: authPermissions.action,
      description: authPermissions.description,
      category: authPermissions.category,
      createdAt: authPermissions.createdAt,
    })
    .from(authRolePermissions)
    .innerJoin(authPermissions, eq(authRolePermissions.permissionId, authPermissions.id))
    .where(eq(authRolePermissions.roleId, roleId));
}

export async function createRole(name: string, description: string | null, permissionIds: number[], tx: Tx = db): Promise<AuthRole> {
  const [role] = await tx.insert(authRoles).values({ name, description, isSystem: 0 }).returning();
  if (permissionIds.length > 0) {
    await tx.insert(authRolePermissions).values(
      permissionIds.map(permissionId => ({ roleId: role.id, permissionId }))
    );
  }
  return role;
}

export async function updateRolePermissions(roleId: number, permissionIds: number[], tx: Tx = db): Promise<void> {
  await tx.delete(authRolePermissions).where(eq(authRolePermissions.roleId, roleId));
  if (permissionIds.length > 0) {
    await tx.insert(authRolePermissions).values(
      permissionIds.map(permissionId => ({ roleId, permissionId }))
    );
  }
}

export async function deleteRole(roleId: number, tx: Tx = db): Promise<boolean> {
  const role = await tx.select().from(authRoles).where(eq(authRoles.id, roleId)).limit(1);
  if (role.length === 0 || role[0].isSystem === 1) return false;
  await tx.delete(authRoles).where(eq(authRoles.id, roleId));
  return true;
}

export async function assignUserRoles(userId: string, roleIds: number[], tx: Tx = db): Promise<void> {
  await tx.delete(authUserRoles).where(eq(authUserRoles.userId, userId));
  if (roleIds.length > 0) {
    await tx.insert(authUserRoles).values(
      roleIds.map(roleId => ({ userId, roleId }))
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
