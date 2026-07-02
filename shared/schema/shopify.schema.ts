import { pgSchema, pgTable, integer, varchar, text, timestamp, boolean, jsonb, decimal } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { products } from "./catalog.schema";

export const shopifySchema = pgSchema("shopify");

// ============================================================================
// SHOPIFY COLLECTIONS — synced from Shopify, channel-specific
// Echelon references these but does not own the concept.
// ============================================================================
export const shopifyCollections = shopifySchema.table("shopify_collections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shopifyCollectionId: varchar("shopify_collection_id", { length: 100 }).notNull().unique(),
  title: varchar("title", { length: 500 }).notNull(),
  handle: varchar("handle", { length: 255 }),
  description: text("description"),
  collectionType: varchar("collection_type", { length: 20 }).notNull().default("smart"), // 'smart' | 'custom'
  rules: jsonb("rules"), // Smart collection rules from Shopify (array of {column, relation, condition})
  sortOrder: varchar("sort_order", { length: 30 }).default("best-selling"),
  publishedAt: timestamp("published_at"),
  lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertShopifyCollectionSchema = createInsertSchema(shopifyCollections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShopifyCollection = z.infer<typeof insertShopifyCollectionSchema>;
export type ShopifyCollection = typeof shopifyCollections.$inferSelect;

// Many-to-many: products ↔ collections
export const shopifyCollectionProducts = shopifySchema.table("shopify_collection_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  collectionId: integer("collection_id").notNull().references(() => shopifyCollections.id, { onDelete: "cascade" }),
  productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  position: integer("position").default(0), // Sort position within collection
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  collectionProductIdx: { columns: [table.collectionId, table.productId] },
}));

export type ShopifyCollectionProduct = typeof shopifyCollectionProducts.$inferSelect;

// Legacy public Shopify variant cache used as the retail-price source of truth.
// The membership pricing app reads this same table for Wholesale Pricing retail
// values; channel listing prices should resolve from it before catalog fallback.
export const shopifyVariants = pgTable("shopify_variants", {
  id: varchar("id", { length: 100 }).primaryKey(),
  productId: text("product_id").notNull(),
  title: text("title"),
  sku: text("sku"),
  price: decimal("price", { precision: 10, scale: 2 }),
  compareAtPrice: decimal("compare_at_price", { precision: 10, scale: 2 }),
  inventoryItemId: text("inventory_item_id"),
  inventoryQuantity: integer("inventory_quantity"),
  imageUrl: text("image_url"),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
});

export type ShopifyVariant = typeof shopifyVariants.$inferSelect;
