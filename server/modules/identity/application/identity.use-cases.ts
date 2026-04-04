import { db } from "../../../storage/base";
import * as repo from "../infrastructure/identity.repository";
import * as domain from "../domain/identity.domain";
import bcrypt from "bcrypt";
import type { InsertUser, SafeUser, User } from "../../../storage/base";
import type { AuthRole } from "@shared/schema";

export async function loginUseCase(username: string, passwordString: string): Promise<SafeUser> {
  const user = await repo.getUserByUsername(username);
  if (!user || !user.active) throw new Error("Invalid credentials");
  
  const validPassword = await bcrypt.compare(passwordString, user.password);
  if (!validPassword) throw new Error("Invalid credentials");

  await repo.updateUserLastLogin(user.id);
  
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    active: user.active,
    createdAt: user.createdAt,
    lastLoginAt: new Date(),
  };
}

export async function createUserUseCase(data: InsertUser): Promise<SafeUser> {
  return await db.transaction(async (tx) => {
    const existing = await repo.getUserByUsername(data.username, tx);
    if (existing) throw new Error("Username already exists");
    
    data.password = await bcrypt.hash(data.password, 10);
    const user = await repo.createUser(data, tx);
    
    return {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      active: user.active,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    };
  });
}

export async function createRoleUseCase(name: string, description: string | null, permissionIds: number[]): Promise<AuthRole> {
  return await db.transaction(async (tx) => {
    return await repo.createRole(name, description, permissionIds, tx);
  });
}

export async function updateRolePermissionsUseCase(roleId: number, permissionIds: number[]): Promise<void> {
  return await db.transaction(async (tx) => {
    await repo.updateRolePermissions(roleId, permissionIds, tx);
  });
}

export async function assignUserRolesUseCase(userId: string, roleIds: number[]): Promise<void> {
  return await db.transaction(async (tx) => {
    await repo.assignUserRoles(userId, roleIds, tx);
  });
}

export async function seedRBACUseCase(): Promise<void> {
  // Try to see if tables exist, safely abort if DB throws schema error
  try {
    await repo.getAllPermissions();
  } catch(e) {
    console.log("[IdentityUseCase] RBAC tables not found, skipping seed.");
    return;
  }
  
  // Actually execute atomic insert inside single-transaction lock
  // We don't rollback if a seed insert fails because they might already exist
  // We use the db instance directly for seeding since it uses `onConflictDoNothing` deeply
  
  const { authPermissions, authRoles, authRolePermissions, authUserRoles } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const { users } = await import("../../../storage/base");

  // Inserts intentionally isolated from explicit transactions to prevent block-locking on conflicts
  for (const perm of domain.DEFAULT_PERMISSIONS) {
    try { await db.insert(authPermissions).values(perm as any).onConflictDoNothing(); } catch (e) {}
  }

  const allPerms = await repo.getAllPermissions();
  const permMap = new Map(allPerms.map((p: any) => [`${p.resource}:${p.action}`, p.id]));

  for (const [key, roleData] of Object.entries(domain.SYSTEM_ROLES)) {
    let roleRows = await db.select().from(authRoles).where(eq(authRoles.name, roleData.name)).limit(1);
    if (roleRows.length === 0) {
      roleRows = await db.insert(authRoles).values({ name: roleData.name, description: roleData.description, isSystem: 1 }).returning();
    }
    const roleId = roleRows[0].id;

    for (const permKey of roleData.permissions) {
      const permId = permMap.get(permKey);
      if (permId) {
        try { await db.insert(authRolePermissions).values({ roleId, permissionId: permId }).onConflictDoNothing(); } catch (e) {}
      }
    }
  }

  // Migrate users to new roles
  const existingUsers = await db.select().from(users);
  const roles = await repo.getAllRoles();
  const roleNameMap = new Map(roles.map((r: any) => [r.name, r.id]));

  for (const user of existingUsers) {
    const legacyRole = user.role as string;
    let newRoleName = "Picker";
    if (legacyRole === "admin") newRoleName = "Administrator";
    else if (legacyRole === "lead") newRoleName = "Team Lead";

    const roleId = roleNameMap.get(newRoleName);
    if (roleId) {
      try { await db.insert(authUserRoles).values({ userId: user.id, roleId }).onConflictDoNothing(); } catch (e) {}
    }
  }
}

export async function seedAdjustmentReasonsUseCase(): Promise<void> {
  try {
    const { adjustmentReasons } = await import("@shared/schema");
    await db.select().from(adjustmentReasons).limit(1);
    
    const { eq } = await import("drizzle-orm");
    const oldLowercaseCodes = ["po_received", "rma_return", "cycle_count", "damaged"];
    
    for (const code of oldLowercaseCodes) {
      try { await db.delete(adjustmentReasons).where(eq(adjustmentReasons.code, code)); } catch(e) {}
    }

    for (const reason of domain.DEFAULT_ADJUSTMENT_REASONS) {
      try { await db.insert(adjustmentReasons).values(reason as any).onConflictDoNothing(); } catch(e) {}
    }
  } catch(e) { /* ignore schema error during early startup */ }
}
