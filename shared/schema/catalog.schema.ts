import { pgTable, text, varchar, integer, timestamp, jsonb, boolean, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ============================================================================
// PRODUCTS - Master product catalog (source of truth for product identity)
// ============================================================================
export const products = pgTable("products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar("sku", { length: 100 }), // Base SKU for the product family
  name: text("name").notNull(),
  title: varchar("title", { length: 500 }), // Display title (from Shopify product card)
  description: text("description"),
  bulletPoints: jsonb("bullet_points"), // Array of feature bullet points
  category: varchar("category", { length: 100 }), // Product category
  subcategory: varchar("subcategory", { length: 200 }),
  brand: varchar("brand", { length: 100 }), // Brand name
  manufacturer: varchar("manufacturer", { length: 200 }),
  baseUnit: varchar("base_unit", { length: 20 }).notNull().default("piece"), // piece, pack, box, case, pallet
  tags: jsonb("tags"), // Array of tags
  seoTitle: varchar("seo_title", { length: 200 }),
  seoDescription: text("seo_description"),
  shopifyProductId: varchar("shopify_product_id", { length: 100 }), // Shopify product ID for sync
  leadTimeDays: integer("lead_time_days").notNull().default(120), // Supplier lead time in days
  safetyStockDays: integer("safety_stock_days").notNull().default(7), // Safety stock buffer in days of cover
  status: varchar("status", { length: 20 }).default("active"), // active, draft, archived
  inventoryType: varchar("inventory_type", { length: 20 }).notNull().default("inventory"), // inventory, non_inventory, expense
  isActive: boolean("is_active").notNull().default(true),
  lastPushedAt: timestamp("last_pushed_at"), // Last time product data was pushed to channels
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof products.$inferSelect;

// ============================================================================
// PRODUCT VARIANTS - Sellable/purchasable SKUs with pack sizes
// ============================================================================
export const productVariants = pgTable("product_variants", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => products.id),
  sku: varchar("sku", { length: 100 }),
  name: text("name").notNull(),
  unitsPerVariant: integer("units_per_variant").notNull().default(1),
  hierarchyLevel: integer("hierarchy_level").notNull().default(1),
  parentVariantId: integer("parent_variant_id"),
  isBaseUnit: boolean("is_base_unit").notNull().default(false),
  barcode: varchar("barcode", { length: 100 }),
  weightGrams: integer("weight_grams"),
  lengthMm: integer("length_mm"),
  widthMm: integer("width_mm"),
  heightMm: integer("height_mm"),
  priceCents: integer("price_cents"),
  compareAtPriceCents: integer("compare_at_price_cents"),
  standardCostCents: doublePrecision("standard_cost_cents"), // Standard cost for valuation
  lastCostCents: doublePrecision("last_cost_cents"), // Most recent purchase cost
  avgCostCents: doublePrecision("avg_cost_cents"), // Weighted average cost (updated on each receipt)
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertProductVariantSchema = createInsertSchema(productVariants).omit({
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

export const productLines = pgTable("product_lines", {
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
export const productLineProducts = pgTable("product_line_products", {
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
export const productAssets = pgTable("product_assets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }), // NULL = product-level, set = variant-specific
  assetType: varchar("asset_type", { length: 20 }).notNull().default("image"), // image, video, document
  url: text("url").notNull(),
  altText: varchar("alt_text", { length: 500 }),
  position: integer("position").notNull().default(0), // Sort order
  isPrimary: integer("is_primary").notNull().default(0), // 1 = main image
  width: integer("width"),
  height: integer("height"),
  fileSize: integer("file_size"), // Bytes
  mimeType: varchar("mime_type", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProductAssetSchema = createInsertSchema(productAssets).omit({
  id: true,
  createdAt: true,
});

export type InsertProductAsset = z.infer<typeof insertProductAssetSchema>;
export type ProductAsset = typeof productAssets.$inferSelect;
