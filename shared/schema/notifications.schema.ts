import { pgTable, text, varchar, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { users, authRoles } from "./identity.schema";

// ============================================
// NOTIFICATION SYSTEM
// ============================================

export const notificationCategoryEnum = ["replenishment", "receiving", "picking", "inventory"] as const;
export type NotificationCategory = typeof notificationCategoryEnum[number];

// Notification types — static registry of events the system can fire
export const notificationTypes = pgTable("notification_types", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  label: varchar("label", { length: 200 }).notNull(),
  description: text("description"),
  category: varchar("category", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertNotificationTypeSchema = createInsertSchema(notificationTypes).omit({
  id: true,
  createdAt: true,
});

export type InsertNotificationType = z.infer<typeof insertNotificationTypeSchema>;
export type NotificationType = typeof notificationTypes.$inferSelect;

// Notification preferences — role defaults + per-user overrides
export const notificationPreferences = pgTable("notification_preferences", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  notificationTypeId: integer("notification_type_id").notNull().references(() => notificationTypes.id, { onDelete: "cascade" }),
  roleId: integer("role_id").references(() => authRoles.id, { onDelete: "cascade" }),
  userId: varchar("user_id").references(() => users.id, { onDelete: "cascade" }),
  enabled: integer("enabled").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("notification_pref_type_role_user_idx").on(table.notificationTypeId, table.roleId, table.userId),
]);

export const insertNotificationPreferenceSchema = createInsertSchema(notificationPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertNotificationPreference = z.infer<typeof insertNotificationPreferenceSchema>;
export type NotificationPreference = typeof notificationPreferences.$inferSelect;

// Notifications — actual delivered notifications
export const notifications = pgTable("notifications", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  notificationTypeId: integer("notification_type_id").notNull().references(() => notificationTypes.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 300 }).notNull(),
  message: text("message"),
  data: jsonb("data"),
  read: integer("read").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  read: true,
  createdAt: true,
});

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;
