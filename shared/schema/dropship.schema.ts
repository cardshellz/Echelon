import { pgSchema, varchar, integer, bigint, timestamp, boolean, text, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { products, productVariants } from "./catalog.schema";
import { channels } from "./channels.schema";
import { orders } from "./orders.schema";

export const dropshipSchema = pgSchema("dropship");

// Dropship Vendors - Third party suppliers sending directly to customers
export const dropshipVendors = dropshipSchema.table("dropship_vendors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 200 }).notNull(),
  email: varchar("email", { length: 200 }).notNull().unique(),
  companyName: varchar("company_name", { length: 200 }),
  phone: varchar("phone", { length: 50 }),
  shellzClubMemberId: varchar("shellz_club_member_id", { length: 255 }),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  tier: varchar("tier", { length: 20 }).default("standard"),
  stripeCustomerId: varchar("stripe_customer_id", { length: 100 }),
  availableBalanceCents: bigint("available_balance_cents", { mode: "number" }).notNull().default(0),
  pendingBalanceCents: bigint("pending_balance_cents", { mode: "number" }).notNull().default(0),
  autoReloadEnabled: boolean("auto_reload_enabled").default(false),
  autoReloadThresholdCents: bigint("auto_reload_threshold_cents", { mode: "number" }).default(5000),
  autoReloadAmountCents: bigint("auto_reload_amount_cents", { mode: "number" }).default(20000),
  usdcWalletAddress: varchar("usdc_wallet_address", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_dv_status").on(table.status),
]);

export const insertDropshipVendorSchema = createInsertSchema(dropshipVendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDropshipVendor = z.infer<typeof insertDropshipVendorSchema>;
export type DropshipVendor = typeof dropshipVendors.$inferSelect;

// Dropship Store Connections - Replaces Dropship Vendor Channels
export const dropshipStoreConnections = dropshipSchema.table("dropship_store_connections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  sourcePlatform: varchar("source_platform", { length: 50 }).notNull(), // 'ebay', 'shopify', 'tiktok', etc.
  sourceAccountId: varchar("source_account_id", { length: 255 }), // eBay username, Shopify domain
  accessToken: text("access_token"), // Encrypted or secrets-reference
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  status: varchar("status", { length: 50 }).notNull().default("connected"), // 'connected', 'needs_reauth', 'refresh_failed', 'disconnected'
  config: text("config"), // JSON payload
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDropshipStoreConnectionSchema = createInsertSchema(dropshipStoreConnections).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipStoreConnection = z.infer<typeof insertDropshipStoreConnectionSchema>;
export type DropshipStoreConnection = typeof dropshipStoreConnections.$inferSelect;

// Dropship Vendor Product Selections
export const dropshipVendorProductSelections = dropshipSchema.table("dropship_vendor_product_selections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  productId: integer("product_id").notNull().references(() => products.id),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_dvps_vendor_product").on(table.vendorId, table.productId),
]);

export const insertDropshipVendorProductSelectionSchema = createInsertSchema(dropshipVendorProductSelections).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipVendorProductSelection = z.infer<typeof insertDropshipVendorProductSelectionSchema>;
export type DropshipVendorProductSelection = typeof dropshipVendorProductSelections.$inferSelect;

// Dropship Vendor Variant Overrides
export const dropshipVendorVariantOverrides = dropshipSchema.table("dropship_vendor_variant_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  enabledOverride: boolean("enabled_override"),
  priceOverrideType: varchar("price_override_type", { length: 50 }), // 'percent', 'fixed'
  priceOverrideValue: integer("price_override_value"), // cents if fixed, percentage (0-100) if percent
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_dvvo_vendor_variant").on(table.vendorId, table.productVariantId),
]);

export const insertDropshipVendorVariantOverrideSchema = createInsertSchema(dropshipVendorVariantOverrides).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipVendorVariantOverride = z.infer<typeof insertDropshipVendorVariantOverrideSchema>;
export type DropshipVendorVariantOverride = typeof dropshipVendorVariantOverrides.$inferSelect;

// Dropship Vendor Pricing Rules
export const dropshipVendorPricingRules = dropshipSchema.table("dropship_vendor_pricing_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  scope: varchar("scope", { length: 50 }).notNull(), // 'global', 'category', 'product', 'variant'
  scopeId: integer("scope_id"), // Null for global
  ruleType: varchar("rule_type", { length: 50 }).notNull(), // 'percent', 'fixed'
  value: integer("value").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // Constraint to enforce 'fixed' rule type only on 'variant' scope is handled at DB level via check constraints during migration
]);

export const insertDropshipVendorPricingRuleSchema = createInsertSchema(dropshipVendorPricingRules).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipVendorPricingRule = z.infer<typeof insertDropshipVendorPricingRuleSchema>;
export type DropshipVendorPricingRule = typeof dropshipVendorPricingRules.$inferSelect;

// Dropship Vendor Listings
export const dropshipVendorListings = dropshipSchema.table("dropship_vendor_listings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorStoreConnectionId: integer("vendor_store_connection_id").notNull().references(() => dropshipStoreConnections.id),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  externalListingId: text("external_listing_id"),
  externalOfferId: text("external_offer_id"),
  pushedPriceCents: integer("pushed_price_cents"),
  pushedQty: integer("pushed_qty"),
  status: varchar("status", { length: 50 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_dvl_connection_variant").on(table.vendorStoreConnectionId, table.productVariantId),
]);

export const insertDropshipVendorListingSchema = createInsertSchema(dropshipVendorListings).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipVendorListing = z.infer<typeof insertDropshipVendorListingSchema>;
export type DropshipVendorListing = typeof dropshipVendorListings.$inferSelect;

// Dropship Listing Push Jobs
export const dropshipListingPushJobs = dropshipSchema.table("dropship_listing_push_jobs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  vendorStoreConnectionId: integer("vendor_store_connection_id").notNull().references(() => dropshipStoreConnections.id),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  requestedScope: text("requested_scope"), // JSON scope/payload
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDropshipListingPushJobSchema = createInsertSchema(dropshipListingPushJobs).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipListingPushJob = z.infer<typeof insertDropshipListingPushJobSchema>;
export type DropshipListingPushJob = typeof dropshipListingPushJobs.$inferSelect;

// Dropship Listing Push Job Items
export const dropshipListingPushJobItems = dropshipSchema.table("dropship_listing_push_job_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  jobId: integer("job_id").notNull().references(() => dropshipListingPushJobs.id),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  result: text("result"), // JSON/text of result or error
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDropshipListingPushJobItemSchema = createInsertSchema(dropshipListingPushJobItems).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipListingPushJobItem = z.infer<typeof insertDropshipListingPushJobItemSchema>;
export type DropshipListingPushJobItem = typeof dropshipListingPushJobItems.$inferSelect;

// Dropship Wallet Ledger
export const dropshipWalletLedger = dropshipSchema.table("dropship_wallet_ledger", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  type: varchar("type", { length: 30 }).notNull(), // deposit, withdrawal, charge, refund, credit
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  balanceAfterCents: bigint("balance_after_cents", { mode: "number" }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("pending"), // 'pending', 'settled', 'failed'
  referenceType: varchar("reference_type", { length: 50 }), // order, plan, manual
  referenceId: varchar("reference_id", { length: 200 }),
  paymentMethod: varchar("payment_method", { length: 30 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_dwl_vendor_id").on(table.vendorId),
  uniqueIndex("idx_dwl_ref_type_id")
    .on(table.referenceType, table.referenceId)
    .where(sql`${table.referenceId} IS NOT NULL`), // Ensure idempotency
]);

export const insertDropshipWalletLedgerSchema = createInsertSchema(dropshipWalletLedger).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipWalletLedger = z.infer<typeof insertDropshipWalletLedgerSchema>;
export type DropshipWalletLedger = typeof dropshipWalletLedger.$inferSelect;

// Dropship Order Intake
export const dropshipOrderIntake = dropshipSchema.table("dropship_order_intake", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id), // Point to Dropship OMS channel
  externalOrderId: varchar("external_order_id", { length: 255 }).notNull(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  sourcePlatform: varchar("source_platform", { length: 50 }).notNull(),
  sourceAccountId: varchar("source_account_id", { length: 255 }),
  sourceOrderId: varchar("source_order_id", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default("received"), // 'received', 'accepted', 'rejected', 'retrying', 'failed'
  reasonCode: text("reason_code"),
  omsOrderId: integer("oms_order_id").references(() => orders.id), // Nullable link to OMS
  payloadHash: text("payload_hash"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_doi_channel_external").on(table.channelId, table.externalOrderId),
]);

export const insertDropshipOrderIntakeSchema = createInsertSchema(dropshipOrderIntake).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipOrderIntake = z.infer<typeof insertDropshipOrderIntakeSchema>;
export type DropshipOrderIntake = typeof dropshipOrderIntake.$inferSelect;

// Dropship Store Setup Checks
export const dropshipStoreSetupChecks = dropshipSchema.table("dropship_store_setup_checks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorStoreConnectionId: integer("vendor_store_connection_id").notNull().references(() => dropshipStoreConnections.id),
  checkKey: varchar("check_key", { length: 100 }).notNull(),
  status: varchar("status", { length: 50 }).notNull(), // 'pass', 'fail', 'warning'
  message: text("message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("idx_dssc_connection_key").on(table.vendorStoreConnectionId, table.checkKey),
]);

export const insertDropshipStoreSetupCheckSchema = createInsertSchema(dropshipStoreSetupChecks).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertDropshipStoreSetupCheck = z.infer<typeof insertDropshipStoreSetupCheckSchema>;
export type DropshipStoreSetupCheck = typeof dropshipStoreSetupChecks.$inferSelect;

// Dropship Audit Events
export const dropshipAuditEvents = dropshipSchema.table("dropship_audit_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").references(() => dropshipVendors.id),
  vendorStoreConnectionId: integer("vendor_store_connection_id").references(() => dropshipStoreConnections.id),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  details: text("details"), // JSON payload
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDropshipAuditEventSchema = createInsertSchema(dropshipAuditEvents).omit({ id: true, createdAt: true });
export type InsertDropshipAuditEvent = z.infer<typeof insertDropshipAuditEventSchema>;
export type DropshipAuditEvent = typeof dropshipAuditEvents.$inferSelect;
