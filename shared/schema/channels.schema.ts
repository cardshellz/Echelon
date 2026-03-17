import { pgTable, text, varchar, integer, bigint, timestamp, jsonb, uniqueIndex, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { products, productVariants, productAssets, productLines } from "./catalog.schema";

// Channel types
export const channelTypeEnum = ["shopify", "amazon", "ebay", "wholesale"] as const;
export type ChannelType = typeof channelTypeEnum[number];

// Channel types and ownership
export const channelOwnershipEnum = ["internal", "partner"] as const;
export type ChannelOwnership = typeof channelOwnershipEnum[number];

export const channelProviderEnum = ["shopify", "ebay", "amazon", "etsy", "manual"] as const;
export type ChannelProvider = typeof channelProviderEnum[number];

export const channelStatusEnum = ["active", "paused", "pending_setup", "error"] as const;
export type ChannelStatus = typeof channelStatusEnum[number];

// Channels - the core entity for all sales channels
export const channels = pgTable("channels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull(),
  type: varchar("type", { length: 20 }).notNull().default("internal"), // internal or partner
  provider: varchar("provider", { length: 30 }).notNull(), // shopify, ebay, amazon, etc.
  status: varchar("status", { length: 20 }).notNull().default("pending_setup"),
  isDefault: integer("is_default").notNull().default(0), // 1 = primary channel for this provider
  priority: integer("priority").notNull().default(0), // Higher = sync first
  allocationPct: integer("allocation_pct"), // % of total ATP pool allocated to this channel (null = no limit)
  allocationFixedQty: integer("allocation_fixed_qty"), // Fixed base-unit qty override (takes precedence over %)
  syncEnabled: boolean("sync_enabled").default(false),
  syncMode: varchar("sync_mode", { length: 10 }).default("dry_run"), // 'live' or 'dry_run'
  sweepIntervalMinutes: integer("sweep_interval_minutes").default(15),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertChannelSchema = createInsertSchema(channels).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Channel = typeof channels.$inferSelect;

// Channel connections - credentials and API settings per channel
export const channelConnections = pgTable("channel_connections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  shopDomain: varchar("shop_domain", { length: 255 }), // e.g., "mystore.myshopify.com"
  accessToken: text("access_token"), // Encrypted in production
  refreshToken: text("refresh_token"),
  webhookSecret: varchar("webhook_secret", { length: 255 }),
  apiVersion: varchar("api_version", { length: 20 }),
  scopes: text("scopes"), // Comma-separated OAuth scopes
  shopifyLocationId: varchar("shopify_location_id", { length: 50 }), // Primary Shopify location for inventory pushes
  expiresAt: timestamp("expires_at"),
  lastSyncAt: timestamp("last_sync_at"),
  syncStatus: varchar("sync_status", { length: 20 }).default("never"), // ok, error, never, syncing
  syncError: text("sync_error"),
  metadata: jsonb("metadata"), // Provider-specific settings
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertChannelConnectionSchema = createInsertSchema(channelConnections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelConnection = z.infer<typeof insertChannelConnectionSchema>;
export type ChannelConnection = typeof channelConnections.$inferSelect;

// Partner profiles - extra info for dropship/wholesale partners
export const partnerProfiles = pgTable("partner_profiles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }).unique(),
  companyName: varchar("company_name", { length: 200 }).notNull(),
  contactName: varchar("contact_name", { length: 100 }),
  contactEmail: varchar("contact_email", { length: 255 }),
  contactPhone: varchar("contact_phone", { length: 50 }),
  billingEmail: varchar("billing_email", { length: 255 }),
  discountPercent: integer("discount_percent").default(0), // Wholesale discount off retail
  markupPercent: integer("markup_percent").default(0), // Their markup on cost
  slaDays: integer("sla_days").default(3), // Fulfillment SLA in business days
  allowBackorder: integer("allow_backorder").notNull().default(0),
  autoFulfill: integer("auto_fulfill").notNull().default(0), // Auto-process orders
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertPartnerProfileSchema = createInsertSchema(partnerProfiles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPartnerProfile = z.infer<typeof insertPartnerProfileSchema>;
export type PartnerProfile = typeof partnerProfiles.$inferSelect;

// Channel feeds - maps variants to external channel IDs (Shopify, future marketplaces)
export const channelFeeds = pgTable("channel_feeds", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").references(() => channels.id),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  channelType: varchar("channel_type", { length: 30 }).notNull().default("shopify"),
  channelVariantId: varchar("channel_variant_id", { length: 100 }).notNull(), // Shopify variant ID
  channelProductId: varchar("channel_product_id", { length: 100 }), // Shopify product ID
  channelSku: varchar("channel_sku", { length: 100 }), // SKU as it appears in channel
  channelInventoryItemId: varchar("channel_inventory_item_id", { length: 100 }), // Per-channel inventory item ID (multi-store)
  isActive: integer("is_active").notNull().default(1), // 1 = sync enabled
  lastSyncedAt: timestamp("last_synced_at"),
  lastSyncedQty: integer("last_synced_qty"), // Last quantity pushed to channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertChannelFeedSchema = createInsertSchema(channelFeeds).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelFeed = z.infer<typeof insertChannelFeedSchema>;
export type ChannelFeed = typeof channelFeeds.$inferSelect;

// Channel reservations - priority stock allocation per channel
export const channelReservations = pgTable("channel_reservations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  reserveBaseQty: integer("reserve_base_qty").notNull().default(0), // Base units reserved for this channel
  minStockBase: integer("min_stock_base").default(0), // Minimum stock to maintain (alert threshold)
  maxStockBase: integer("max_stock_base"), // Maximum to list (cap availability)
  overrideQty: integer("override_qty"), // Hard override: push exactly this qty (null = use calculated, 0 = force zero)
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_reservations_channel_pv_idx").on(table.channelId, table.productVariantId),
]);

export const insertChannelReservationSchema = createInsertSchema(channelReservations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelReservation = z.infer<typeof insertChannelReservationSchema>;
export type ChannelReservation = typeof channelReservations.$inferSelect;

// Channel product allocation - product-level rules per channel
export const channelProductAllocation = pgTable("channel_product_allocation", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  minAtpBase: integer("min_atp_base"), // Product floor: push 0 for all variants when product ATP < this (base units)
  maxAtpBase: integer("max_atp_base"), // Product cap: limit all variants when product ATP > this (base units)
  isListed: integer("is_listed").notNull().default(1), // 0 = hard block, never list on this channel
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_product_alloc_channel_product_idx").on(table.channelId, table.productId),
]);

export const insertChannelProductAllocationSchema = createInsertSchema(channelProductAllocation).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelProductAllocation = z.infer<typeof insertChannelProductAllocationSchema>;
export type ChannelProductAllocation = typeof channelProductAllocation.$inferSelect;

// Channel sync log - audit trail for every inventory push to a channel
export const channelSyncLog = pgTable("channel_sync_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").references(() => products.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  channelId: integer("channel_id").references(() => channels.id),
  channelFeedId: integer("channel_feed_id").references(() => channelFeeds.id),
  atpBase: integer("atp_base").notNull(), // ATP in base units at time of sync
  pushedQty: integer("pushed_qty").notNull(), // What was actually pushed (after floors/caps)
  previousQty: integer("previous_qty"), // What was synced last time
  status: varchar("status", { length: 20 }).notNull(), // success, error, skipped, floor_triggered
  errorMessage: text("error_message"),
  responseCode: integer("response_code"),
  durationMs: integer("duration_ms"),
  triggeredBy: varchar("triggered_by", { length: 30 }), // reserve, pick, receive, adjust, manual, scheduled
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ChannelSyncLogEntry = typeof channelSyncLog.$inferSelect;

// Many-to-many: channels → product lines (which lines a channel carries)
export const channelProductLines = pgTable("channel_product_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productLineId: integer("product_line_id").notNull().references(() => productLines.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("cpl_channel_line_idx").on(table.channelId, table.productLineId),
]);

export type ChannelProductLine = typeof channelProductLines.$inferSelect;

// Channel product overrides - per-channel content customization
export const channelProductOverrides = pgTable("channel_product_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  titleOverride: varchar("title_override", { length: 500 }), // NULL = use master
  descriptionOverride: text("description_override"),
  bulletPointsOverride: jsonb("bullet_points_override"),
  categoryOverride: varchar("category_override", { length: 200 }), // Channel-specific category mapping
  tagsOverride: jsonb("tags_override"),
  itemSpecifics: jsonb("item_specifics"), // Channel-specific item specifics overrides (eBay, etc.)
  marketplaceCategoryId: varchar("marketplace_category_id", { length: 100 }), // e.g., eBay category ID
  listingFormat: varchar("listing_format", { length: 30 }), // eBay: auction/fixed_price/both
  conditionId: integer("condition_id"), // eBay condition ID (1000=New, etc.)
  isListed: integer("is_listed").notNull().default(1), // 0 = hide from this channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_product_overrides_channel_product_idx").on(table.channelId, table.productId),
]);

export const insertChannelProductOverrideSchema = createInsertSchema(channelProductOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelProductOverride = z.infer<typeof insertChannelProductOverrideSchema>;
export type ChannelProductOverride = typeof channelProductOverrides.$inferSelect;

// Channel pricing - per-channel, per-variant pricing
export const channelPricing = pgTable("channel_pricing", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  price: integer("price").notNull(), // In cents
  compareAtPrice: integer("compare_at_price"), // MSRP / strikethrough price
  cost: integer("cost"), // For margin tracking
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_pricing_channel_pv_idx").on(table.channelId, table.productVariantId),
]);

export const insertChannelPricingSchema = createInsertSchema(channelPricing).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelPricing = z.infer<typeof insertChannelPricingSchema>;
export type ChannelPricing = typeof channelPricing.$inferSelect;

// Channel listings - external IDs after pushing to channel
export const channelListings = pgTable("channel_listings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  externalProductId: varchar("external_product_id", { length: 100 }),
  externalVariantId: varchar("external_variant_id", { length: 100 }),
  externalSku: varchar("external_sku", { length: 100 }),
  externalUrl: text("external_url"), // Link to listing on marketplace
  lastSyncedQty: integer("last_synced_qty"),
  lastSyncedPrice: integer("last_synced_price"), // In cents
  lastSyncedAt: timestamp("last_synced_at"),
  syncStatus: varchar("sync_status", { length: 20 }).default("pending"), // pending, synced, error
  syncError: text("sync_error"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_listings_channel_pv_idx").on(table.channelId, table.productVariantId),
]);

export const insertChannelListingSchema = createInsertSchema(channelListings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelListing = z.infer<typeof insertChannelListingSchema>;
export type ChannelListing = typeof channelListings.$inferSelect;

// Channel variant overrides - per-channel variant-level customization
export const channelVariantOverrides = pgTable("channel_variant_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  nameOverride: varchar("name_override", { length: 500 }), // NULL = use master
  skuOverride: varchar("sku_override", { length: 100 }), // Channel-specific SKU
  barcodeOverride: varchar("barcode_override", { length: 100 }),
  weightOverride: integer("weight_override"), // In grams
  isListed: integer("is_listed").notNull().default(1), // 0 = hide this variant from channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_variant_overrides_channel_pv_idx").on(table.channelId, table.productVariantId),
]);

export const insertChannelVariantOverrideSchema = createInsertSchema(channelVariantOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelVariantOverride = z.infer<typeof insertChannelVariantOverrideSchema>;
export type ChannelVariantOverride = typeof channelVariantOverrides.$inferSelect;

// Channel asset overrides - per-channel media customization
export const channelAssetOverrides = pgTable("channel_asset_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productAssetId: integer("product_asset_id").notNull().references(() => productAssets.id, { onDelete: "cascade" }),
  urlOverride: text("url_override"), // Channel-specific image URL
  altTextOverride: varchar("alt_text_override", { length: 500 }),
  positionOverride: integer("position_override"), // Different sort order per channel
  isIncluded: integer("is_included").notNull().default(1), // 0 = exclude this asset from channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_asset_overrides_channel_asset_idx").on(table.channelId, table.productAssetId),
]);

export const insertChannelAssetOverrideSchema = createInsertSchema(channelAssetOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelAssetOverride = z.infer<typeof insertChannelAssetOverrideSchema>;
export type ChannelAssetOverride = typeof channelAssetOverrides.$inferSelect;

// ---------------------------------------------------------------------------
// Source Lock System — per-field-type, per-channel sync direction control
// ---------------------------------------------------------------------------

export const sourceLockFieldTypeEnum = [
  "inventory",    // Always locked (Echelon → channel only)
  "pricing",      // Always locked (Echelon → channel only)
  "variants",     // Always locked (Echelon → channel only)
  "sku",          // Always locked (Echelon → channel only) — SKU drift caused dupes, locked 2026-03-15
  "title",        // Always locked (Echelon → channel, with per-channel overrides)
  "description",  // Always locked (Echelon → channel, with per-channel overrides)
  "images",       // Always locked (Echelon → channel only)
  "weight",       // Always locked (Echelon → channel only)
  "tags",         // Always locked (Echelon → channel, with per-channel overrides)
  "barcodes",     // Toggle (default: unlocked — GS1 generator not yet built)
] as const;
export type SourceLockFieldType = typeof sourceLockFieldTypeEnum[number];

export const sourceLockConfig = pgTable("source_lock_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  fieldType: varchar("field_type", { length: 30 }).notNull(), // from sourceLockFieldTypeEnum
  isLocked: integer("is_locked").notNull().default(1), // 1 = Echelon-only (1-way push), 0 = 2-way sync
  lockedBy: varchar("locked_by", { length: 100 }),
  lockedAt: timestamp("locked_at").defaultNow(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("source_lock_config_channel_field_idx").on(table.channelId, table.fieldType),
]);

export const insertSourceLockConfigSchema = createInsertSchema(sourceLockConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertSourceLockConfig = z.infer<typeof insertSourceLockConfigSchema>;
export type SourceLockConfig = typeof sourceLockConfig.$inferSelect;

// ---------------------------------------------------------------------------
// Channel Warehouse Assignments — which warehouses fulfill for which channels
// ---------------------------------------------------------------------------

export const channelWarehouseAssignments = pgTable("channel_warehouse_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(0), // Higher = preferred fulfillment source
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("cwa_channel_warehouse_idx").on(table.channelId, table.warehouseId),
]);

export const insertChannelWarehouseAssignmentSchema = createInsertSchema(channelWarehouseAssignments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelWarehouseAssignment = z.infer<typeof insertChannelWarehouseAssignmentSchema>;
export type ChannelWarehouseAssignment = typeof channelWarehouseAssignments.$inferSelect;

// ---------------------------------------------------------------------------
// Channel Allocation Rules — parallel percentage/fixed/mirror allocation
// ---------------------------------------------------------------------------

export const allocationModeEnum = ["mirror", "share", "fixed"] as const;
export type AllocationMode = typeof allocationModeEnum[number];

export const channelAllocationRules = pgTable("channel_allocation_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  /** NULL = channel default. Set for product-level override. */
  productId: integer("product_id").references(() => products.id, { onDelete: "cascade" }),
  /** NULL = product-level or channel default. Set for variant-level override. */
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  /** Allocation mode: mirror (100%), share (% of ATP), fixed (N units) */
  mode: varchar("mode", { length: 10 }).notNull().default("mirror"),
  /** Share percentage (1-100). Only used when mode = 'share'. */
  sharePct: integer("share_pct"),
  /** Fixed quantity in base units. Only used when mode = 'fixed'. */
  fixedQty: integer("fixed_qty"),
  /** Floor: if base ATP < this threshold, push 0. Prevents selling dregs. */
  floorAtp: integer("floor_atp").default(0),
  /** Ceiling: never show more than this many base units, regardless of ATP. */
  ceilingQty: integer("ceiling_qty"),
  /** Eligible flag: false = block this product/variant from this channel entirely. */
  eligible: boolean("eligible").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  // Each scope level (channel-only, channel+product, channel+product+variant) is unique
  uniqueIndex("car_channel_product_variant_idx").on(table.channelId, table.productId, table.productVariantId),
]);

export const insertChannelAllocationRuleSchema = createInsertSchema(channelAllocationRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelAllocationRule = z.infer<typeof insertChannelAllocationRuleSchema>;
export type ChannelAllocationRule = typeof channelAllocationRules.$inferSelect;

// ---------------------------------------------------------------------------
// Allocation Audit Log — tracks allocation engine decisions
// ---------------------------------------------------------------------------

export const allocationAuditLog = pgTable("allocation_audit_log", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").references(() => products.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  channelId: integer("channel_id").references(() => channels.id),
  totalAtpBase: integer("total_atp_base").notNull(),
  allocatedQty: integer("allocated_qty").notNull(),
  previousQty: integer("previous_qty"),
  allocationMethod: varchar("allocation_method", { length: 30 }).notNull(), // priority, percentage, fixed, override
  details: jsonb("details"), // Full breakdown of allocation decision
  triggeredBy: varchar("triggered_by", { length: 30 }), // inventory_change, config_change, manual, scheduled
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type AllocationAuditLogEntry = typeof allocationAuditLog.$inferSelect;

// ---------------------------------------------------------------------------
// Sync Settings — global sync engine configuration
// ---------------------------------------------------------------------------

export const syncSettings = pgTable("sync_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  globalEnabled: boolean("global_enabled").notNull().default(false),
  sweepIntervalMinutes: integer("sweep_interval_minutes").notNull().default(15),
  lastSweepAt: timestamp("last_sweep_at"),
  lastSweepDurationMs: integer("last_sweep_duration_ms"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type SyncSettings = typeof syncSettings.$inferSelect;

// ---------------------------------------------------------------------------
// Sync Log — unified activity log for all sync operations
// ---------------------------------------------------------------------------

export const syncLog = pgTable("sync_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").references(() => channels.id),
  channelName: varchar("channel_name", { length: 100 }),
  action: varchar("action", { length: 30 }).notNull(), // inventory_push, pricing_push, listing_create, listing_update
  sku: varchar("sku", { length: 100 }),
  productVariantId: integer("product_variant_id"),
  previousValue: text("previous_value"),
  newValue: text("new_value"),
  status: varchar("status", { length: 20 }).notNull(), // dry_run, pushed, error, skipped
  errorMessage: text("error_message"),
  source: varchar("source", { length: 20 }).notNull(), // event, sweep, manual
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_sync_log_channel").on(table.channelId),
  index("idx_sync_log_created").on(table.createdAt),
  index("idx_sync_log_status").on(table.status),
]);

export type SyncLogEntry = typeof syncLog.$inferSelect;
