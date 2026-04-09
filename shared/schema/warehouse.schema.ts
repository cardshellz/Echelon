import { sql } from "drizzle-orm";
import { pgTable, pgSchema, text, varchar, integer, timestamp, jsonb, bigint, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { productVariants } from "./catalog.schema";

// Location types for multi-location WMS support
export const locationTypeEnum = ["pick", "reserve", "receiving", "staging", "3pl_virtual"] as const;
export type LocationType = typeof locationTypeEnum[number];

// Warehouse types
export const warehouseTypeEnum = ["operations", "bulk_storage", "3pl"] as const;
export type WarehouseType = typeof warehouseTypeEnum[number];

// Inventory source types — determines sync direction
export const inventorySourceTypeEnum = ["internal", "channel", "integration", "manual"] as const;
export type InventorySourceType = typeof inventorySourceTypeEnum[number];

// Movement policy - how strict is inventory tracking for this movement type
export const movementPolicyEnum = ["implicit", "soft_log", "require_scan"] as const;
export type MovementPolicy = typeof movementPolicyEnum[number];

// Warehouse zone types
export const zoneTypeEnum = ["RCV", "BULK", "FWD", "PACK", "SHIP"] as const;
export type ZoneType = typeof zoneTypeEnum[number];

// Warehouse zones (optional - for organizing locations)
const warehouseSchema = pgSchema("warehouse");

export const warehouseZones = warehouseSchema.table("warehouse_zones", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 10 }).notNull().unique(), // RCV, BULK, FWD, PACK, SHIP
  name: varchar("name", { length: 50 }).notNull(), // "Receiving Dock", "Bulk Storage", etc.
  description: text("description"),
  locationType: varchar("location_type", { length: 30 }).notNull().default("pick"),
  isPickable: integer("is_pickable").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertWarehouseZoneSchema = createInsertSchema(warehouseZones).omit({
  id: true,
  createdAt: true,
});

export type InsertWarehouseZone = z.infer<typeof insertWarehouseZoneSchema>;
export type WarehouseZone = typeof warehouseZones.$inferSelect;

// Helper function to generate location code from hierarchy (used on backend)
export function generateLocationCode(parts: {
  zone?: string | null;
  aisle?: string | null;
  bay?: string | null;
  level?: string | null;
  bin?: string | null;
}): string {
  // Clean and normalize each segment
  const cleanSegment = (s: string | null | undefined): string | null => {
    if (s == null) return null;
    const trimmed = s.trim().toUpperCase();
    return trimmed === '' ? null : trimmed;
  };

  // Pad numeric values to 2 digits (industry standard for proper sorting)
  const padNumeric = (val: string | null): string | null => {
    if (val == null) return null;
    const num = parseInt(val, 10);
    if (!isNaN(num)) return num.toString().padStart(2, '0');
    return val; // Keep as-is if not numeric
  };

  const segments = [
    cleanSegment(parts.zone),
    cleanSegment(parts.aisle),
    padNumeric(cleanSegment(parts.bay)),
    cleanSegment(parts.level),
    padNumeric(cleanSegment(parts.bin)),
  ].filter((s): s is string => s != null);

  if (segments.length === 0) {
    throw new Error('Location must have at least one hierarchy field (zone, aisle, bay, level, or bin)');
  }

  return segments.join('-');
}

// Warehouses (physical warehouse buildings/sites)
export const warehouses = warehouseSchema.table("warehouses", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 20 }).notNull().unique(), // Short code: "EAST", "WEST", "HQ"
  name: varchar("name", { length: 200 }).notNull(), // Full name: "East Coast Distribution Center"
  warehouseType: varchar("warehouse_type", { length: 30 }).notNull().default("operations"), // operations, bulk_storage, 3pl
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 50 }),
  postalCode: varchar("postal_code", { length: 20 }),
  country: varchar("country", { length: 50 }).default("US"),
  timezone: varchar("timezone", { length: 50 }).default("America/New_York"),
  isActive: integer("is_active").notNull().default(1),
  isDefault: integer("is_default").notNull().default(0), // Default warehouse for new orders
  shopifyLocationId: varchar("shopify_location_id", { length: 50 }), // Maps to Shopify location_id for inventory sync
  inventorySourceType: varchar("inventory_source_type", { length: 20 }).notNull().default("internal"), // internal, channel, integration, manual
  inventorySourceConfig: jsonb("inventory_source_config"), // Source-specific settings: { channelId }, { integrationId, apiType }, etc.
  lastInventorySyncAt: timestamp("last_inventory_sync_at"), // Last time external inventory was pulled
  inventorySyncStatus: varchar("inventory_sync_status", { length: 20 }).default("never"), // never, syncing, ok, error
  feedEnabled: boolean("feed_enabled").default(true), // Whether this warehouse feeds inventory to channel sync
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWarehouseSchema = createInsertSchema(warehouses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertWarehouse = z.infer<typeof insertWarehouseSchema>;
export type Warehouse = typeof warehouses.$inferSelect;

// Warehouse locations (bins, pallets, racks, etc.)
export const warehouseLocations = warehouseSchema.table("warehouse_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "cascade" }), // Which warehouse this location belongs to
  code: varchar("code", { length: 50 }).notNull(), // Auto-generated from hierarchy: "BULK-A-02-C-1" — unique per warehouse via composite constraint
  name: text("name"), // Friendly name (optional)

  // Hierarchical location structure (all optional for flexibility)
  zone: varchar("zone", { length: 10 }), // RCV, BULK, FWD, PACK, SHIP
  aisle: varchar("aisle", { length: 5 }), // A, B, C or 01, 02...
  bay: varchar("bay", { length: 5 }), // 01, 02, 03... (2-digit padded)
  level: varchar("level", { length: 5 }), // A=floor, B=1st shelf, C=2nd shelf...
  bin: varchar("bin", { length: 5 }), // 1, 2, 3... (subdivision within level)

  // Location metadata
  locationType: varchar("location_type", { length: 30 }).notNull().default("pick"), // pick, reserve, receiving, staging
  binType: varchar("bin_type", { length: 30 }).notNull().default("bin"), // bin, shelf, pallet, carton_flow, floor
  isPickable: integer("is_pickable").notNull().default(1), // 1 = contributes to ATP
  cycleCountFreezeId: integer("cycle_count_freeze_id"), // When set, location is frozen for cycle counting — picks/replen/reservations skip it

  // Replenishment chain
  parentLocationId: integer("parent_location_id"), // Specific location that feeds this one (optional)
  replenSourceType: varchar("replen_source_type", { length: 30 }), // Location type that feeds this: reserve, case_pick, pallet_pick
  movementPolicy: varchar("movement_policy", { length: 20 }).notNull().default("implicit"),

  // Capacity constraints (dimensions in mm for cube calculations)
  capacityCubicMm: bigint("capacity_cubic_mm", { mode: "number" }), // Calculated from dimensions or set directly
  maxWeightG: integer("max_weight_g"), // Max weight in grams
  widthMm: integer("width_mm"), // Physical dimensions for slotting
  heightMm: integer("height_mm"),
  depthMm: integer("depth_mm"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  isActive: integer("is_active").notNull().default(1),
  pickSequence: integer("pick_sequence"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWarehouseLocationSchema = createInsertSchema(warehouseLocations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWarehouseLocation = z.infer<typeof insertWarehouseLocationSchema>;
export type WarehouseLocation = typeof warehouseLocations.$inferSelect;

export const productLocations = warehouseSchema.table("product_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id"), // Primary link to products - NOT unique, allows multiple locations per product
  sku: varchar("sku", { length: 100 }), // Optional - cached from catalog for display/legacy
  shopifyVariantId: bigint("shopify_variant_id", { mode: "number" }), // Optional - cached from catalog for quick Shopify lookups
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  location: varchar("location", { length: 50 }).notNull(), // Location code (must match a warehouse_locations.code)
  zone: varchar("zone", { length: 10 }).notNull(), // Derived from location for grouping
  warehouseLocationId: integer("warehouse_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }), // FK to warehouse_locations
  isPrimary: integer("is_primary").notNull().default(1), // 1 = primary pick location, 0 = secondary/bulk
  status: varchar("status", { length: 20 }).notNull().default("active"), // "active" or "draft"
  imageUrl: text("image_url"),
  barcode: varchar("barcode", { length: 100 }), // Product barcode from Shopify for scanner matching
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

// ============================================
// ECHELON APPLICATION SETTINGS
// ============================================

export const echelonSettings = warehouseSchema.table("echelon_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value"),
  type: varchar("type", { length: 20 }).notNull().default("string"), // string, number, boolean, json
  category: varchar("category", { length: 50 }).notNull().default("general"),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertEchelonSettingSchema = createInsertSchema(echelonSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertEchelonSetting = z.infer<typeof insertEchelonSettingSchema>;
export type EchelonSetting = typeof echelonSettings.$inferSelect;

// App Settings - key-value store for application configuration
export const appSettings = warehouseSchema.table("app_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value"),
  type: varchar("type", { length: 20 }), // boolean, string, number, json
  category: varchar("category", { length: 50 }), // picking, shipping, sync, etc.
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type AppSetting = typeof appSettings.$inferSelect;
