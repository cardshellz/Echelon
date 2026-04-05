import { pgSchema, varchar, integer, timestamp, boolean, text, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { products } from "./catalog.schema";

export const dropshipSchema = pgSchema("dropship");

// Dropship Vendors - Third party suppliers sending directly to customers
export const dropshipVendors = dropshipSchema.table("dropship_vendors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 200 }).notNull(),
  email: varchar("email", { length: 200 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 200 }).notNull(),
  companyName: varchar("company_name", { length: 200 }),
  phone: varchar("phone", { length: 50 }),
  shellzClubMemberId: varchar("shellz_club_member_id", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  tier: varchar("tier", { length: 20 }).default("standard"),
  ebayOauthToken: text("ebay_oauth_token"),
  ebayRefreshToken: text("ebay_refresh_token"),
  ebayTokenExpiresAt: timestamp("ebay_token_expires_at"),
  ebayUserId: varchar("ebay_user_id", { length: 200 }),
  stripeCustomerId: varchar("stripe_customer_id", { length: 100 }),
  walletBalanceCents: integer("wallet_balance_cents").notNull().default(0),
  autoReloadEnabled: boolean("auto_reload_enabled").default(false),
  autoReloadThresholdCents: integer("auto_reload_threshold_cents").default(5000),
  autoReloadAmountCents: integer("auto_reload_amount_cents").default(20000),
  usdcWalletAddress: varchar("usdc_wallet_address", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_dv_status").on(table.status),
  // Note: Drizzle defines unique indexes globally or via drizzle-schema
]);

export const insertDropshipVendorSchema = createInsertSchema(dropshipVendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDropshipVendor = z.infer<typeof insertDropshipVendorSchema>;
export type DropshipVendor = typeof dropshipVendors.$inferSelect;

// Dropship Wallet Ledger - tracks the financial deposit/withdrawal system for vendor billing
export const dropshipWalletLedger = dropshipSchema.table("dropship_wallet_ledger", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  type: varchar("type", { length: 30 }).notNull(), // deposit, withdrawal, charge, refund, credit
  amountCents: integer("amount_cents").notNull(),
  balanceAfterCents: integer("balance_after_cents").notNull(),
  referenceType: varchar("reference_type", { length: 50 }), // order, plan, manual
  referenceId: varchar("reference_id", { length: 200 }),
  paymentMethod: varchar("payment_method", { length: 30 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_dwl_vendor_id").on(table.vendorId),
]);

export const insertDropshipWalletLedgerSchema = createInsertSchema(dropshipWalletLedger).omit({
  id: true,
  createdAt: true,
});
export type InsertDropshipWalletLedger = z.infer<typeof insertDropshipWalletLedgerSchema>;
export type DropshipWalletLedger = typeof dropshipWalletLedger.$inferSelect;

// Dropship Vendor Products - Maps which vendors are approved to ship which inventory
export const dropshipVendorProducts = dropshipSchema.table("dropship_vendor_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  productId: integer("product_id").notNull().references(() => products.id),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_dvp_unique_vendor_product").on(table.vendorId, table.productId),
]);

export const insertDropshipVendorProductSchema = createInsertSchema(dropshipVendorProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDropshipVendorProduct = z.infer<typeof insertDropshipVendorProductSchema>;
export type DropshipVendorProduct = typeof dropshipVendorProducts.$inferSelect;
