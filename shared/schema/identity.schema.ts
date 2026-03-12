import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// User roles
export const userRoleEnum = ["admin", "lead", "picker"] as const;
export type UserRole = typeof userRoleEnum[number];

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: varchar("role", { length: 20 }).notNull().default("picker"),
  displayName: text("display_name"),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  role: true,
  displayName: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type SafeUser = Omit<User, "password">;

// User audit trail for tracking username/profile changes
export const userAudit = pgTable("user_audit", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fieldChanged: varchar("field_changed", { length: 50 }).notNull(), // username, displayName, role, etc.
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: varchar("changed_by").references(() => users.id),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
});

export const insertUserAuditSchema = createInsertSchema(userAudit).omit({
  id: true,
  changedAt: true,
});

export type InsertUserAudit = z.infer<typeof insertUserAuditSchema>;
export type UserAudit = typeof userAudit.$inferSelect;

// ============================================
// ROLE-BASED ACCESS CONTROL (RBAC)
// ============================================

// Permission categories for UI grouping
export const permissionCategoryEnum = ["dashboard", "inventory", "orders", "picking", "purchasing", "channels", "reports", "users", "settings"] as const;
export type PermissionCategory = typeof permissionCategoryEnum[number];

// Auth roles - custom roles created by admin
export const authRoles = pgTable("auth_roles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  isSystem: integer("is_system").notNull().default(0), // 1 = built-in role (admin/lead/picker), cannot delete
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAuthRoleSchema = createInsertSchema(authRoles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAuthRole = z.infer<typeof insertAuthRoleSchema>;
export type AuthRole = typeof authRoles.$inferSelect;

// Auth permissions - individual permissions (resource:action pairs)
export const authPermissions = pgTable("auth_permissions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  resource: varchar("resource", { length: 50 }).notNull(), // e.g., "inventory", "orders"
  action: varchar("action", { length: 50 }).notNull(), // e.g., "view", "create", "edit", "delete"
  description: text("description"),
  category: varchar("category", { length: 50 }).notNull(), // For UI grouping
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_permissions_resource_action_idx").on(table.resource, table.action),
]);

export const insertAuthPermissionSchema = createInsertSchema(authPermissions).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthPermission = z.infer<typeof insertAuthPermissionSchema>;
export type AuthPermission = typeof authPermissions.$inferSelect;

// Auth role permissions - links roles to their allowed permissions
export const authRolePermissions = pgTable("auth_role_permissions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  roleId: integer("role_id").notNull().references(() => authRoles.id, { onDelete: "cascade" }),
  permissionId: integer("permission_id").notNull().references(() => authPermissions.id, { onDelete: "cascade" }),
  constraints: jsonb("constraints"), // Optional scoping rules (e.g., specific warehouse, zone)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_role_permissions_role_perm_idx").on(table.roleId, table.permissionId),
]);

export const insertAuthRolePermissionSchema = createInsertSchema(authRolePermissions).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthRolePermission = z.infer<typeof insertAuthRolePermissionSchema>;
export type AuthRolePermission = typeof authRolePermissions.$inferSelect;

// Auth user roles - assigns roles to users (supports multiple roles per user)
export const authUserRoles = pgTable("auth_user_roles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id").notNull().references(() => authRoles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_user_roles_user_role_idx").on(table.userId, table.roleId),
]);

export const insertAuthUserRoleSchema = createInsertSchema(authUserRoles).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthUserRole = z.infer<typeof insertAuthUserRoleSchema>;
export type AuthUserRole = typeof authUserRoles.$inferSelect;

// Helper type for user with permissions
export type UserWithPermissions = SafeUser & {
  roles: AuthRole[];
  permissions: string[]; // Array of "resource:action" strings
};
