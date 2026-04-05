/**
 * eBay-Specific Schema
 *
 * Tables specifically needed for eBay channel integration
 * that don't fit in the generic channels schema.
 */

import { pgSchema, text, varchar, integer, timestamp, boolean, uniqueIndex, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { channels } from "./channels.schema";
import { products } from "./catalog.schema";

export const ebaySchema = pgSchema("ebay");

// ---------------------------------------------------------------------------
// eBay OAuth Tokens — rotating token storage
// ---------------------------------------------------------------------------

/**
 * Stores eBay OAuth2 tokens with support for token rotation.
 *
 * CRITICAL: eBay refresh tokens change on every refresh call.
 * The new refresh token must be persisted immediately or access is lost.
 * One row per channel + environment combination.
 */
export const ebayOauthTokens = ebaySchema.table("ebay_oauth_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  environment: varchar("environment", { length: 20 }).notNull().default("production"), // sandbox | production
  accessToken: text("access_token").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"), // ~18 months from issuance
  scopes: text("scopes"), // Space-separated OAuth scopes
  lastRefreshedAt: timestamp("last_refreshed_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_oauth_tokens_channel_env_idx").on(table.channelId, table.environment),
]);

export const insertEbayOauthTokenSchema = createInsertSchema(ebayOauthTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEbayOauthToken = z.infer<typeof insertEbayOauthTokenSchema>;
export type EbayOauthToken = typeof ebayOauthTokens.$inferSelect;

// ---------------------------------------------------------------------------
// eBay Listing Rules — cascading config (default → product_type → SKU)
// ---------------------------------------------------------------------------

export const ebayListingRules = ebaySchema.table("ebay_listing_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  scopeType: varchar("scope_type", { length: 20 }).notNull(), // 'default' | 'product_type' | 'sku'
  scopeValue: varchar("scope_value", { length: 100 }), // null for default, product_type slug, or SKU
  ebayCategoryId: varchar("ebay_category_id", { length: 20 }),
  ebayStoreCategoryId: varchar("ebay_store_category_id", { length: 20 }),
  fulfillmentPolicyId: varchar("fulfillment_policy_id", { length: 20 }),
  returnPolicyId: varchar("return_policy_id", { length: 20 }),
  paymentPolicyId: varchar("payment_policy_id", { length: 20 }),
  sortOrder: integer("sort_order").default(0),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_listing_rules_channel_scope_idx").on(table.channelId, table.scopeType, table.scopeValue),
]);

export const insertEbayListingRuleSchema = createInsertSchema(ebayListingRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEbayListingRule = z.infer<typeof insertEbayListingRuleSchema>;
export type EbayListingRule = typeof ebayListingRules.$inferSelect;

// ---------------------------------------------------------------------------
// eBay Category Mappings — product type → eBay category associations
// ---------------------------------------------------------------------------

export const ebayCategoryMappings = ebaySchema.table("ebay_category_mappings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  productTypeSlug: varchar("product_type_slug", { length: 50 }).notNull(),
  ebayBrowseCategoryId: varchar("ebay_browse_category_id", { length: 20 }),
  ebayBrowseCategoryName: varchar("ebay_browse_category_name", { length: 200 }),
  ebayStoreCategoryId: varchar("ebay_store_category_id", { length: 20 }),
  ebayStoreCategoryName: varchar("ebay_store_category_name", { length: 200 }),
  fulfillmentPolicyOverride: varchar("fulfillment_policy_override", { length: 20 }),
  returnPolicyOverride: varchar("return_policy_override", { length: 20 }),
  paymentPolicyOverride: varchar("payment_policy_override", { length: 20 }),
  listingEnabled: boolean("listing_enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_cat_map_channel_type_idx").on(table.channelId, table.productTypeSlug),
]);

export const insertEbayCategoryMappingSchema = createInsertSchema(ebayCategoryMappings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEbayCategoryMapping = z.infer<typeof insertEbayCategoryMappingSchema>;
export type EbayCategoryMapping = typeof ebayCategoryMappings.$inferSelect;

// ---------------------------------------------------------------------------
// eBay Item Specifics (Aspects)
// ---------------------------------------------------------------------------

export const ebayCategoryAspects = ebaySchema.table("ebay_category_aspects", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  categoryId: varchar("category_id", { length: 20 }).notNull(),
  aspectName: varchar("aspect_name", { length: 200 }).notNull(),
  aspectRequired: boolean("aspect_required").notNull().default(false),
  aspectMode: varchar("aspect_mode", { length: 20 }).notNull().default('FREE_TEXT'),
  aspectUsage: varchar("aspect_usage", { length: 20 }).notNull().default('RECOMMENDED'),
  aspectValues: jsonb("aspect_values"),
  aspectOrder: integer("aspect_order").notNull().default(0),
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_cat_aspect_idx").on(table.categoryId, table.aspectName),
  index("idx_ebay_cat_aspects_cat").on(table.categoryId),
]);

export type EbayCategoryAspect = typeof ebayCategoryAspects.$inferSelect;

export const ebayTypeAspectDefaults = ebaySchema.table("ebay_type_aspect_defaults", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productTypeSlug: varchar("product_type_slug", { length: 100 }).notNull(),
  aspectName: varchar("aspect_name", { length: 200 }).notNull(),
  aspectValue: varchar("aspect_value", { length: 500 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_type_aspect_idx").on(table.productTypeSlug, table.aspectName),
  index("idx_ebay_type_aspects_slug").on(table.productTypeSlug),
]);

export type EbayTypeAspectDefault = typeof ebayTypeAspectDefaults.$inferSelect;

export const ebayProductAspectOverrides = ebaySchema.table("ebay_product_aspect_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => products.id),
  aspectName: varchar("aspect_name", { length: 200 }).notNull(),
  aspectValue: varchar("aspect_value", { length: 500 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_prod_aspect_idx").on(table.productId, table.aspectName),
  index("idx_ebay_prod_aspects_pid").on(table.productId),
]);

export type EbayProductAspectOverride = typeof ebayProductAspectOverrides.$inferSelect;
