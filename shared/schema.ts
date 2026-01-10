import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export const productLocations = pgTable("product_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar("sku", { length: 100 }).notNull().unique(),
  name: text("name").notNull(),
  location: varchar("location", { length: 50 }).notNull(),
  zone: varchar("zone", { length: 10 }).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProductLocationSchema = createInsertSchema(productLocations).omit({
  id: true,
  updatedAt: true,
});

export const updateProductLocationSchema = createInsertSchema(productLocations).omit({
  id: true,
  updatedAt: true,
}).partial();

export type InsertProductLocation = z.infer<typeof insertProductLocationSchema>;
export type UpdateProductLocation = z.infer<typeof updateProductLocationSchema>;
export type ProductLocation = typeof productLocations.$inferSelect;
