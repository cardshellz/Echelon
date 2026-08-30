import { pgTable, text, varchar, integer, bigint, numeric, timestamp, jsonb, boolean, uniqueIndex, index, check, pgSchema } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { VARIANT_UOM_TYPES, type VariantUomType } from "../catalog/variant-uom";
import {
  DEFAULT_PRODUCT_INVENTORY_STRATEGY,
  PRODUCT_INVENTORY_STRATEGIES,
  type ProductInventoryStrategy,
} from "../catalog/inventory-strategy";

export const catalogSchema = pgSchema("catalog");

// ============================================================================
// PRODUCT TYPES - Canonical product classification
// ============================================================================
export const productTypes = catalogSchema.table("product_types", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  slug: varchar("slug", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProductTypeSchema = createInsertSchema(productTypes).omit({
  id: true,
  createdAt: true,
});

export type InsertProductType = z.infer<typeof insertProductTypeSchema>;
export type ProductType = typeof productTypes.$inferSelect;

// ============================================================================
// PRODUCT CATEGORIES - Controlled product taxonomy
// ============================================================================
export const productCategories = catalogSchema.table("product_categories", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_product_categories_active_sort").on(table.isActive, table.sortOrder, table.name),
]);

export const insertProductCategorySchema = createInsertSchema(productCategories).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProductCategory = z.infer<typeof insertProductCategorySchema>;
export type ProductCategory = typeof productCategories.$inferSelect;

// ============================================================================
// SHIPPING GROUPS - Fulfillment equivalence classes ("can this item ship with
// that item"). Distinct from category/product_type: governs which storefront
// free-shipping threshold a product counts toward and how it's packed/mailed
// (e.g. flat-mailer storage boxes can't combine with boxed plastic protection).
// ============================================================================
export const shippingGroups = catalogSchema.table("shipping_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 50 }).notNull().unique(), // stable key used by storefront/sync (e.g. "protection", "storage_boxes")
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("idx_shipping_groups_active_sort").on(table.isActive, table.sortOrder, table.name),
]);

export const insertShippingGroupSchema = createInsertSchema(shippingGroups).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShippingGroup = z.infer<typeof insertShippingGroupSchema>;
export type ShippingGroup = typeof shippingGroups.$inferSelect;

// ============================================================================
// PRODUCTS - Master product catalog (source of truth for product identity)
// ============================================================================
export const products = catalogSchema.table("products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar("sku", { length: 100 }), // Base SKU for the product family
  name: text("name").notNull(),
  title: varchar("title", { length: 500 }), // Display title (from Shopify product card)
  description: text("description"),
  bulletPoints: jsonb("bullet_points"), // Array of feature bullet points
  categoryId: integer("category_id").references(() => productCategories.id, { onDelete: "set null" }),
  category: varchar("category", { length: 100 }), // Denormalized category name for channel/dropship compatibility
  shippingGroupId: integer("shipping_group_id").references(() => shippingGroups.id, { onDelete: "set null" }), // Fulfillment equivalence class — see shippingGroups
  subcategory: varchar("subcategory", { length: 200 }),
  brand: varchar("brand", { length: 100 }), // Brand name
  manufacturer: varchar("manufacturer", { length: 200 }),
  baseUnit: varchar("base_unit", { length: 20 }).notNull().default("piece"), // piece, each, pack, box, case, pallet
  inventoryStrategy: varchar("inventory_strategy", { length: 30 })
    .$type<ProductInventoryStrategy>()
    .notNull()
    .default(DEFAULT_PRODUCT_INVENTORY_STRATEGY),
  tags: jsonb("tags"), // Array of tags
  seoTitle: varchar("seo_title", { length: 200 }),
  seoDescription: text("seo_description"),
  shopifyProductId: varchar("shopify_product_id", { length: 100 }), // Shopify product ID for sync
  leadTimeDays: integer("lead_time_days").notNull().default(120), // Supplier lead time in days
  safetyStockDays: integer("safety_stock_days").notNull().default(7), // Safety stock buffer in days of cover
  status: varchar("status", { length: 20 }).default("active"), // active, draft, archived
  inventoryType: varchar("inventory_type", { length: 20 }).notNull().default("inventory"), // inventory, non_inventory, expense
  isActive: boolean("is_active").notNull().default(true),
  condition: varchar("condition", { length: 30 }).default("new"), // new, used, refurbished
  countryOfOrigin: varchar("country_of_origin", { length: 2 }), // ISO 3166-1 alpha-2
  harmonizedCode: varchar("harmonized_code", { length: 20 }), // HS tariff code
  itemSpecifics: jsonb("item_specifics"), // Structured marketplace attributes (eBay item specifics, etc.)
  productType: varchar("product_type", { length: 50 }), // References product_types.slug
  ebayBrowseCategoryId: varchar("ebay_browse_category_id", { length: 20 }), // Per-product eBay browse category override
  ebayBrowseCategoryName: varchar("ebay_browse_category_name", { length: 200 }), // Per-product eBay browse category name override
  ebayFulfillmentPolicyOverride: varchar("ebay_fulfillment_policy_override", { length: 100 }),
  ebayReturnPolicyOverride: varchar("ebay_return_policy_override", { length: 100 }),
  ebayPaymentPolicyOverride: varchar("ebay_payment_policy_override", { length: 100 }),
  ebayListingExcluded: boolean("ebay_listing_excluded").notNull().default(false), // Per-product eBay exclusion
  reorderExcluded: boolean("reorder_excluded").notNull().default(false), // Per-product exclusion from reorder analysis
  lastPushedAt: timestamp("last_pushed_at"), // Last time product data was pushed to channels
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  check(
    "products_inventory_strategy_chk",
    sql`${table.inventoryStrategy} IN (${sql.join(PRODUCT_INVENTORY_STRATEGIES.map((strategy) => sql`${strategy}`), sql`, `)})`,
  ),
]);

export const insertProductSchema = createInsertSchema(products, {
  inventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

// ============================================================================
// PRODUCT VARIANTS - Inventory identities and sellable/purchasable package configurations
// ============================================================================
export const productVariants = catalogSchema.table("product_variants", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => products.id),
  sku: varchar("sku", { length: 100 }),
  name: text("name").notNull(),
  uomType: varchar("uom_type", { length: 20 }).$type<VariantUomType>().notNull().default("pack"),
  unitsPerVariant: integer("units_per_variant").notNull().default(1),
  hierarchyLevel: integer("hierarchy_level").notNull().default(1),
  parentVariantId: integer("parent_variant_id"),
  isBaseUnit: boolean("is_base_unit").notNull().default(false),
  barcode: varchar("barcode", { length: 100 }),
  // Physical package facts are numeric(10,2) in the DB so inch/pound inputs
  // round-trip exactly (6.00in = 152.40mm). The pg driver returns numeric as
  // string; readers coerce via shared/utils/measurements.numericToNumber.
  weightGrams: numeric("weight_grams", { precision: 10, scale: 2 }),
  lengthMm: numeric("length_mm", { precision: 10, scale: 2 }),
  widthMm: numeric("width_mm", { precision: 10, scale: 2 }),
  heightMm: numeric("height_mm", { precision: 10, scale: 2 }),
  // SIOC: parcel = the item's own packaging (no outer box). Canonical home
  // for this fact (moved from shipping.variant_shipping_attrs /
  // dropship.dropship_package_profiles in migration 185).
  shipsInOwnContainer: boolean("ships_in_own_container").notNull().default(false),
  // Optional packing cap for single-SKU parcels; null = derive from geometry.
  maxUnitsPerPackage: integer("max_units_per_package"),
  priceCents: bigint("price_cents", { mode: "number" }),
  compareAtPriceCents: bigint("compare_at_price_cents", { mode: "number" }),
  standardCostCents: bigint("standard_cost_cents", { mode: "number" }), // Standard cost for valuation
  lastCostCents: bigint("last_cost_cents", { mode: "number" }), // Most recent purchase cost
  avgCostCents: bigint("avg_cost_cents", { mode: "number" }), // Weighted average cost (updated on each receipt)
  // Fulfillment identity is independent from inventory management. Digital
  // variants do not ship and must never enter ATP, reservation, picking, or
  // channel inventory quantity workflows.
  requiresShipping: boolean("requires_shipping").notNull().default(true),
  trackInventory: boolean("track_inventory").default(true),
  inventoryPolicy: varchar("inventory_policy", { length: 20 }).default("deny"),
  shopifyVariantId: varchar("shopify_variant_id", { length: 100 }),
  shopifyInventoryItemId: varchar("shopify_inventory_item_id", { length: 100 }),
  isActive: boolean("is_active").notNull().default(true),
  position: integer("position").default(0),
  option1Name: varchar("option1_name", { length: 100 }),
  option1Value: varchar("option1_value", { length: 100 }),
  option2Name: varchar("option2_name", { length: 100 }),
  option2Value: varchar("option2_value", { length: 100 }),
  option3Name: varchar("option3_name", { length: 100 }),
  option3Value: varchar("option3_value", { length: 100 }),
  gtin: varchar("gtin", { length: 14 }), // UPC/EAN/ISBN — required by eBay/Amazon
  mpn: varchar("mpn", { length: 100 }), // Manufacturer Part Number
  conditionNote: text("condition_note"), // Per-variant condition details
  ebayListingExcluded: boolean("ebay_listing_excluded").notNull().default(false), // Per-variant eBay exclusion
  ebayFulfillmentPolicyOverride: varchar("ebay_fulfillment_policy_override", { length: 100 }),
  ebayReturnPolicyOverride: varchar("ebay_return_policy_override", { length: 100 }),
  ebayPaymentPolicyOverride: varchar("ebay_payment_policy_override", { length: 100 }),
  dropshipEligible: boolean("dropship_eligible").default(false), // Whether variant is eligible for dropship vendors
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("product_variants_id_product_uidx").on(table.id, table.productId),
  check("product_variants_max_units_per_package_chk", sql`${table.maxUnitsPerPackage} IS NULL OR ${table.maxUnitsPerPackage} > 0`),
  check("product_variants_digital_untracked_chk", sql`${table.requiresShipping} = true OR ${table.trackInventory} IS FALSE`),
  check("product_variants_single_unit_uom_invariants_chk", sql`${table.uomType} NOT IN ('piece', 'each') OR (
    ${table.unitsPerVariant} = 1
    AND ${table.hierarchyLevel} = 1
    AND ${table.parentVariantId} IS NULL
    AND ${table.isBaseUnit} = true
  )`),
]);

export const insertProductVariantSchema = createInsertSchema(productVariants, {
  uomType: z.enum(VARIANT_UOM_TYPES),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProductVariant = z.infer<typeof insertProductVariantSchema>;
export type ProductVariant = typeof productVariants.$inferSelect;

// Legacy type aliases for backward compatibility during code migration
export type InventoryItem = Product;
export type UomVariant = ProductVariant;

// ============================================
// PRODUCT LINES — backend catalog groupings for channel gating
// Distinct from Shopify collections (customer-facing merchandising).
// ============================================

export const productLines = catalogSchema.table("product_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProductLineSchema = createInsertSchema(productLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProductLine = z.infer<typeof insertProductLineSchema>;
export type ProductLine = typeof productLines.$inferSelect;

// Many-to-many: products → product lines
export const productLineProducts = catalogSchema.table("product_line_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productLineId: integer("product_line_id").notNull().references(() => productLines.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("plp_line_product_idx").on(table.productLineId, table.productId),
]);

export type ProductLineProduct = typeof productLineProducts.$inferSelect;

// ============================================
// CATALOG / LISTING MANAGEMENT
// ============================================

// Product assets - master media library (images, videos, documents)
// productVariantId NULL = product-level asset, non-NULL = variant-specific asset
export const productAssets = catalogSchema.table("product_assets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }), // NULL = product-level, set = variant-specific
  assetType: varchar("asset_type", { length: 20 }).notNull().default("image"), // image, video, document
  url: text("url"), // External URL (nullable for file-only assets)
  altText: varchar("alt_text", { length: 500 }),
  position: integer("position").notNull().default(0), // Sort order
  isPrimary: integer("is_primary").notNull().default(0), // 1 = main image
  width: integer("width"),
  height: integer("height"),
  fileSize: integer("file_size"), // Bytes
  mimeType: varchar("mime_type", { length: 100 }),
  storageType: varchar("storage_type", { length: 20 }).notNull().default("url"), // 'url' | 'file' | 'both'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProductAssetSchema = createInsertSchema(productAssets).omit({
  id: true,
  createdAt: true,
});

export type InsertProductAsset = z.infer<typeof insertProductAssetSchema>;
export type ProductAsset = typeof productAssets.$inferSelect;
