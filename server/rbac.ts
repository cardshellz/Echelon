import { db } from "./db";
import { 
  authRoles, authPermissions, authRolePermissions, authUserRoles, users, channels,
  type AuthRole, type AuthPermission, type InsertAuthPermission
} from "@shared/schema";
import { eq, and, inArray, sql } from "drizzle-orm";

// Default permissions for Echelon
export const DEFAULT_PERMISSIONS: InsertAuthPermission[] = [
  // Dashboard
  { resource: "dashboard", action: "view", description: "View dashboard and analytics", category: "dashboard" },
  
  // Inventory
  { resource: "inventory", action: "view", description: "View inventory levels and items", category: "inventory" },
  { resource: "inventory", action: "create", description: "Create new inventory items", category: "inventory" },
  { resource: "inventory", action: "edit", description: "Edit inventory items", category: "inventory" },
  { resource: "inventory", action: "adjust", description: "Make inventory adjustments", category: "inventory" },
  { resource: "inventory", action: "upload", description: "Bulk upload inventory via CSV", category: "inventory" },
  { resource: "inventory", action: "receive", description: "Receive inventory shipments", category: "inventory" },
  
  // Orders
  { resource: "orders", action: "view", description: "View orders list", category: "orders" },
  { resource: "orders", action: "claim", description: "Claim orders for picking", category: "orders" },
  { resource: "orders", action: "edit", description: "Edit order details", category: "orders" },
  { resource: "orders", action: "cancel", description: "Cancel orders", category: "orders" },
  { resource: "orders", action: "hold", description: "Put orders on hold", category: "orders" },
  { resource: "orders", action: "priority", description: "Change order priority", category: "orders" },
  { resource: "orders", action: "resolve_exception", description: "Resolve order exceptions", category: "orders" },
  
  // Picking
  { resource: "picking", action: "view", description: "View picking queue", category: "picking" },
  { resource: "picking", action: "perform", description: "Perform picking operations", category: "picking" },
  { resource: "picking", action: "complete", description: "Mark picks as complete", category: "picking" },
  
  // Channels
  { resource: "channels", action: "view", description: "View sales channels", category: "channels" },
  { resource: "channels", action: "create", description: "Create new channels", category: "channels" },
  { resource: "channels", action: "edit", description: "Edit channel settings", category: "channels" },
  { resource: "channels", action: "sync", description: "Sync channel data", category: "channels" },
  { resource: "channels", action: "delete", description: "Delete channels", category: "channels" },
  
  // Reports
  { resource: "reports", action: "view", description: "View reports", category: "reports" },
  { resource: "reports", action: "export", description: "Export report data", category: "reports" },
  
  // User Management
  { resource: "users", action: "view", description: "View user list", category: "users" },
  { resource: "users", action: "create", description: "Create new users", category: "users" },
  { resource: "users", action: "edit", description: "Edit user details", category: "users" },
  { resource: "users", action: "delete", description: "Delete users", category: "users" },
  { resource: "users", action: "manage_roles", description: "Assign roles to users", category: "users" },
  
  // Roles & Permissions
  { resource: "roles", action: "view", description: "View roles", category: "users" },
  { resource: "roles", action: "create", description: "Create custom roles", category: "users" },
  { resource: "roles", action: "edit", description: "Edit role permissions", category: "users" },
  { resource: "roles", action: "delete", description: "Delete custom roles", category: "users" },
  
  // Settings
  { resource: "settings", action: "view", description: "View system settings", category: "settings" },
  { resource: "settings", action: "edit", description: "Edit system settings", category: "settings" },
  
  // Shopify Sync
  { resource: "shopify", action: "view", description: "View Shopify sync status", category: "shopify" },
  { resource: "shopify", action: "sync", description: "Trigger Shopify sync", category: "shopify" },
  
  // Locations
  { resource: "locations", action: "view", description: "View warehouse locations", category: "inventory" },
  { resource: "locations", action: "create", description: "Create locations", category: "inventory" },
  { resource: "locations", action: "edit", description: "Edit locations", category: "inventory" },
];

// Default system roles with their permission sets
export const SYSTEM_ROLES = {
  admin: {
    name: "Administrator",
    description: "Full system access",
    permissions: DEFAULT_PERMISSIONS.map(p => `${p.resource}:${p.action}`), // All permissions
  },
  lead: {
    name: "Team Lead",
    description: "Manage picking operations and resolve exceptions",
    permissions: [
      "dashboard:view",
      "inventory:view",
      "orders:view", "orders:claim", "orders:hold", "orders:priority", "orders:resolve_exception",
      "picking:view", "picking:perform", "picking:complete",
      "reports:view",
      "users:view",
      "shopify:view",
      "locations:view",
    ],
  },
  picker: {
    name: "Picker",
    description: "Perform picking operations",
    permissions: [
      "dashboard:view",
      "orders:view", "orders:claim",
      "picking:view", "picking:perform", "picking:complete",
    ],
  },
};

// Seed permissions and roles
export async function seedRBAC() {
  console.log("Seeding RBAC permissions and roles...");
  
  // Check if RBAC tables exist - wrap entire function to never crash app
  try {
    await db.select().from(authPermissions).limit(1);
  } catch (e: any) {
    // Any database error means tables don't exist or aren't accessible
    console.log("RBAC tables not yet created - skipping seed. Run schema migration first.");
    console.log("RBAC error details:", e.message || e.code || "unknown");
    return;
  }
  
  // Insert all permissions (ignore duplicates)
  for (const perm of DEFAULT_PERMISSIONS) {
    try {
      await db.insert(authPermissions).values(perm).onConflictDoNothing();
    } catch (e) {
      // Already exists
    }
  }
  
  // Get all permissions for mapping
  const allPerms = await db.select().from(authPermissions);
  const permMap = new Map(allPerms.map(p => [`${p.resource}:${p.action}`, p.id]));
  
  // Create system roles
  for (const [key, roleData] of Object.entries(SYSTEM_ROLES)) {
    // Insert or get role
    let role = await db.select().from(authRoles).where(eq(authRoles.name, roleData.name)).limit(1);
    
    if (role.length === 0) {
      const [newRole] = await db.insert(authRoles).values({
        name: roleData.name,
        description: roleData.description,
        isSystem: 1,
      }).returning();
      role = [newRole];
    }
    
    const roleId = role[0].id;
    
    // Assign permissions to role
    for (const permKey of roleData.permissions) {
      const permId = permMap.get(permKey);
      if (permId) {
        try {
          await db.insert(authRolePermissions).values({
            roleId,
            permissionId: permId,
          }).onConflictDoNothing();
        } catch (e) {
          // Already exists
        }
      }
    }
  }
  
  // Migrate existing users to new roles based on their current role field
  const existingUsers = await db.select().from(users);
  const roles = await db.select().from(authRoles);
  const roleNameMap = new Map(roles.map(r => [r.name, r.id]));
  
  for (const user of existingUsers) {
    const legacyRole = user.role as string;
    let newRoleName = "Picker"; // Default
    
    if (legacyRole === "admin") newRoleName = "Administrator";
    else if (legacyRole === "lead") newRoleName = "Team Lead";
    else if (legacyRole === "picker") newRoleName = "Picker";
    
    const roleId = roleNameMap.get(newRoleName);
    if (roleId) {
      try {
        await db.insert(authUserRoles).values({
          userId: user.id,
          roleId,
        }).onConflictDoNothing();
      } catch (e) {
        // Already assigned
      }
    }
  }
  
  console.log("RBAC seeding complete!");
}

// Seed default channels (Shopify, etc.)
export async function seedDefaultChannels() {
  console.log("Checking default channels...");
  
  try {
    // Check if a Shopify channel exists using raw SQL to avoid schema mismatch
    const existingShopify = await db.execute(
      sql`SELECT id FROM channels WHERE provider = 'shopify' LIMIT 1`
    );
    
    if (existingShopify.rows.length === 0) {
      // Create default Shopify channel - only use basic columns that should exist
      await db.execute(
        sql`INSERT INTO channels (name, type, provider, status) 
            VALUES ('Shopify Store', 'internal', 'shopify', 'active')
            ON CONFLICT DO NOTHING`
      );
      console.log("Created default Shopify channel");
    } else {
      console.log("Shopify channel already exists");
    }
  } catch (error) {
    console.warn("Could not seed default channels:", error);
    // Non-fatal - continue with app startup
  }
}

// Get user's permissions (cached in session)
export async function getUserPermissions(userId: string): Promise<string[]> {
  const userRoles = await db
    .select({ roleId: authUserRoles.roleId })
    .from(authUserRoles)
    .where(eq(authUserRoles.userId, userId));
  
  if (userRoles.length === 0) {
    return [];
  }
  
  const roleIds = userRoles.map(r => r.roleId);
  
  const permissions = await db
    .select({
      resource: authPermissions.resource,
      action: authPermissions.action,
    })
    .from(authRolePermissions)
    .innerJoin(authPermissions, eq(authRolePermissions.permissionId, authPermissions.id))
    .where(inArray(authRolePermissions.roleId, roleIds));
  
  // Deduplicate and return as "resource:action" strings
  const permSet = new Set(permissions.map(p => `${p.resource}:${p.action}`));
  return Array.from(permSet);
}

// Get user's roles
export async function getUserRoles(userId: string): Promise<AuthRole[]> {
  const result = await db
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
  
  return result;
}

// Check if user has specific permission
export async function hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
  const permissions = await getUserPermissions(userId);
  return permissions.includes(`${resource}:${action}`);
}

// Get all roles
export async function getAllRoles(): Promise<AuthRole[]> {
  return db.select().from(authRoles).orderBy(authRoles.name);
}

// Get all permissions grouped by category
export async function getAllPermissions(): Promise<AuthPermission[]> {
  return db.select().from(authPermissions).orderBy(authPermissions.category, authPermissions.resource);
}

// Get permissions for a role
export async function getRolePermissions(roleId: number): Promise<AuthPermission[]> {
  const result = await db
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
  
  return result;
}

// Create a new role
export async function createRole(name: string, description: string | null, permissionIds: number[]): Promise<AuthRole> {
  const [role] = await db.insert(authRoles).values({
    name,
    description,
    isSystem: 0,
  }).returning();
  
  // Assign permissions
  if (permissionIds.length > 0) {
    await db.insert(authRolePermissions).values(
      permissionIds.map(permissionId => ({
        roleId: role.id,
        permissionId,
      }))
    );
  }
  
  return role;
}

// Update role permissions
export async function updateRolePermissions(roleId: number, permissionIds: number[]): Promise<void> {
  // Remove existing permissions
  await db.delete(authRolePermissions).where(eq(authRolePermissions.roleId, roleId));
  
  // Add new permissions
  if (permissionIds.length > 0) {
    await db.insert(authRolePermissions).values(
      permissionIds.map(permissionId => ({
        roleId,
        permissionId,
      }))
    );
  }
}

// Delete a role (only custom roles)
export async function deleteRole(roleId: number): Promise<boolean> {
  const role = await db.select().from(authRoles).where(eq(authRoles.id, roleId)).limit(1);
  
  if (role.length === 0 || role[0].isSystem === 1) {
    return false; // Can't delete system roles
  }
  
  await db.delete(authRoles).where(eq(authRoles.id, roleId));
  return true;
}

// Assign roles to user
export async function assignUserRoles(userId: string, roleIds: number[]): Promise<void> {
  // Remove existing roles
  await db.delete(authUserRoles).where(eq(authUserRoles.userId, userId));
  
  // Assign new roles
  if (roleIds.length > 0) {
    await db.insert(authUserRoles).values(
      roleIds.map(roleId => ({
        userId,
        roleId,
      }))
    );
  }
}
