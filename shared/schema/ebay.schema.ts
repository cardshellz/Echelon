/**
 * eBay-Specific Schema
 *
 * Tables specifically needed for eBay channel integration
 * that don't fit in the generic channels schema.
 */

import { pgTable, text, varchar, integer, timestamp, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { channels } from "./channels.schema";

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
export const ebayOauthTokens = pgTable("ebay_oauth_tokens", {
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

export const ebayListingRules = pgTable("ebay_listing_rules", {
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

export const ebayCategoryMappings = pgTable("ebay_category_mappings", {
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
