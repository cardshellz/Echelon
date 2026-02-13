import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, uniqueIndex, bigint, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// User roles
export const userRoleEnum = ["admin", "lead", "picker"] as const;
export type UserRole = typeof userRoleEnum[number];

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: varchar("role", { length: 20 }).notNull().default("picker"),
  displayName: text("display_name"),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
  role: true,
  displayName: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type SafeUser = Omit<User, "password">;

// User audit trail for tracking username/profile changes
export const userAudit = pgTable("user_audit", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  fieldChanged: varchar("field_changed", { length: 50 }).notNull(), // username, displayName, role, etc.
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changedBy: varchar("changed_by").references(() => users.id),
  changedAt: timestamp("changed_at").defaultNow().notNull(),
});

export const insertUserAuditSchema = createInsertSchema(userAudit).omit({
  id: true,
  changedAt: true,
});

export type InsertUserAudit = z.infer<typeof insertUserAuditSchema>;
export type UserAudit = typeof userAudit.$inferSelect;

// Location types for multi-location WMS support
export const locationTypeEnum = ["pick", "reserve", "receiving", "staging"] as const;
export type LocationType = typeof locationTypeEnum[number];

export const productLocations = pgTable("product_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  catalogProductId: integer("catalog_product_id"), // Primary link to catalog_products - NOT unique, allows multiple locations per product
  sku: varchar("sku", { length: 100 }), // Optional - cached from catalog for display/legacy
  shopifyVariantId: bigint("shopify_variant_id", { mode: "number" }), // Optional - cached from catalog for quick Shopify lookups
  name: text("name").notNull(),
  location: varchar("location", { length: 50 }).notNull(), // Location code (must match a warehouse_locations.code)
  zone: varchar("zone", { length: 10 }).notNull(), // Derived from location for grouping
  warehouseLocationId: integer("warehouse_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }), // FK to warehouse_locations
  locationType: varchar("location_type", { length: 30 }).notNull().default("pick"), // pick, reserve, receiving, staging
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

// Order status workflow: ready → in_progress → completed/exception → ready_to_ship → shipped
// Exception status is for orders with short items that need lead review
export const orderStatusEnum = ["ready", "in_progress", "completed", "exception", "ready_to_ship", "shipped", "cancelled"] as const;
export type OrderStatus = typeof orderStatusEnum[number];

// Exception resolution types
export const exceptionResolutionEnum = ["ship_partial", "hold", "resolved", "cancelled"] as const;
export type ExceptionResolution = typeof exceptionResolutionEnum[number];

// Order priority levels
export const orderPriorityEnum = ["rush", "high", "normal"] as const;
export type OrderPriority = typeof orderPriorityEnum[number];

// Item status during picking
export const itemStatusEnum = ["pending", "in_progress", "completed", "short"] as const;
export type ItemStatus = typeof itemStatusEnum[number];

// Order source types for multi-channel support
export const orderSourceEnum = ["shopify", "ebay", "amazon", "etsy", "manual", "api"] as const;
export type OrderSource = typeof orderSourceEnum[number];

export const orders = pgTable("orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  
  // ===== MULTI-CHANNEL LINKAGE =====
  // Links to source raw tables (shopify_orders, ebay_orders, etc.) for full order data
  channelId: integer("channel_id").references(() => channels.id, { onDelete: "set null" }),
  source: varchar("source", { length: 20 }).notNull().default("shopify"), // shopify, ebay, amazon, etsy, manual, api
  externalOrderId: varchar("external_order_id", { length: 100 }), // External system's order ID
  sourceTableId: varchar("source_table_id", { length: 100 }), // ID in source table for JOIN lookups
  shopifyOrderId: varchar("shopify_order_id", { length: 50 }).unique(), // Legacy compatibility
  
  // ===== ORDER IDENTIFICATION =====
  orderNumber: varchar("order_number", { length: 50 }).notNull(),
  
  // ===== CUSTOMER INFO (for packing slips) =====
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  
  // ===== SHIPPING ADDRESS (for labels) =====
  shippingName: text("shipping_name"), // Recipient name from shipping address
  shippingAddress: text("shipping_address"), // Legacy single-line format
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingPostalCode: text("shipping_postal_code"),
  shippingCountry: text("shipping_country"),
  
  // ===== SHOPIFY STATUS (mirrored from shopify_orders) =====
  financialStatus: varchar("financial_status", { length: 30 }), // pending, authorized, paid, partially_refunded, refunded, voided
  shopifyFulfillmentStatus: varchar("shopify_fulfillment_status", { length: 30 }), // null, partial, fulfilled
  cancelledAt: timestamp("cancelled_at"), // When order was cancelled in Shopify
  
  // ===== WAREHOUSE OPERATIONS =====
  priority: varchar("priority", { length: 20 }).notNull().default("normal"), // rush, high, normal
  warehouseStatus: varchar("warehouse_status", { length: 20 }).notNull().default("ready"), // ready, picking, picked, packing, packed, shipped, exception, cancelled
  onHold: integer("on_hold").notNull().default(0), // 1 = on hold, 0 = available
  heldAt: timestamp("held_at"),
  assignedPickerId: varchar("assigned_picker_id", { length: 100 }),
  batchId: varchar("batch_id", { length: 50 }),
  
  // ===== ORDER COMBINING =====
  combinedGroupId: integer("combined_group_id"), // Links orders in same combined group
  combinedRole: varchar("combined_role", { length: 20 }), // "parent" or "child" - parent is used for shipping label
  
  // ===== ITEM COUNTS =====
  itemCount: integer("item_count").notNull().default(0), // Total line items
  unitCount: integer("unit_count").notNull().default(0), // Total units (sum of quantities)
  pickedCount: integer("picked_count").notNull().default(0), // Units picked so far
  
  // ===== NOTES =====
  notes: text("notes"), // Internal notes
  shortReason: text("short_reason"),
  metadata: jsonb("metadata"), // Extra data from external sources
  
  // ===== DISPLAY (legacy, for order cards) =====
  totalAmount: text("total_amount"),
  currency: varchar("currency", { length: 3 }).default("USD"),
  legacyOrderId: varchar("legacy_order_id", { length: 100 }), // Legacy order ID from external systems
  
  // ===== TIMESTAMPS =====
  orderPlacedAt: timestamp("order_placed_at"), // When placed in channel
  shopifyCreatedAt: timestamp("shopify_created_at"), // Legacy
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"), // Picking started
  completedAt: timestamp("completed_at"), // Picking completed
  
  // ===== EXCEPTION TRACKING =====
  exceptionAt: timestamp("exception_at"),
  exceptionResolution: varchar("exception_resolution", { length: 20 }),
  exceptionResolvedAt: timestamp("exception_resolved_at"),
  exceptionResolvedBy: varchar("exception_resolved_by", { length: 100 }),
  exceptionNotes: text("exception_notes"),
});

export const insertOrderSchema = createInsertSchema(orders).omit({
  id: true,
  createdAt: true,
});

export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof orders.$inferSelect;

export const orderItems = pgTable("order_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  
  // ===== CHANNEL LINKAGE =====
  // Links to source raw tables for full line item data (pricing, properties, etc.)
  shopifyLineItemId: varchar("shopify_line_item_id", { length: 50 }), // Legacy
  sourceItemId: varchar("source_item_id", { length: 100 }), // ID in source table for JOIN lookups
  
  // ===== PRODUCT (for picking display) =====
  catalogProductId: integer("catalog_product_id"), // Optional link to catalog_products for analytics (nullable - doesn't affect order creation)
  sku: varchar("sku", { length: 100 }).notNull(),
  name: text("name").notNull(),
  imageUrl: text("image_url"),
  barcode: varchar("barcode", { length: 100 }), // For scanner matching
  
  // ===== QUANTITIES =====
  quantity: integer("quantity").notNull(),
  pickedQuantity: integer("picked_quantity").notNull().default(0),
  fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0), // Shipped to channel
  
  // ===== WAREHOUSE OPERATIONS =====
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, picked, shorted, cancelled
  location: varchar("location", { length: 50 }).notNull().default("UNASSIGNED"),
  zone: varchar("zone", { length: 10 }).notNull().default("U"),
  
  // ===== PICKING =====
  shortReason: text("short_reason"),
  pickedAt: timestamp("picked_at"),
  
  // ===== ORDER TYPE =====
  requiresShipping: integer("requires_shipping").notNull().default(1), // 1 = needs fulfillment, 0 = digital/membership
});

export const insertOrderItemSchema = createInsertSchema(orderItems).omit({
  id: true,
});

export type InsertOrderItem = z.infer<typeof insertOrderItemSchema>;
export type OrderItem = typeof orderItems.$inferSelect;

// ============================================
// PICKING LOGS (Audit Trail)
// ============================================

// Action types for picking operations
export const pickingActionTypeEnum = [
  "order_claimed",      // Picker claimed an order
  "order_released",     // Picker released an order back to queue
  "order_completed",    // All items picked, order completed
  "item_picked",        // Individual item scanned/picked
  "item_shorted",       // Item marked as short
  "item_quantity_adjusted", // Picker changed picked quantity
  "order_held",         // Admin put order on hold
  "order_unhold",       // Admin released hold
  "order_exception",    // Order moved to exception status
  "exception_resolved", // Exception resolved by lead
] as const;
export type PickingActionType = typeof pickingActionTypeEnum[number];

// Picking logs table for full audit trail
export const pickingLogs = pgTable("picking_logs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  
  // When
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  
  // What action
  actionType: varchar("action_type", { length: 30 }).notNull(),
  
  // Who
  pickerId: varchar("picker_id", { length: 100 }),
  pickerName: varchar("picker_name", { length: 100 }),
  pickerRole: varchar("picker_role", { length: 20 }),
  
  // Which order
  orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
  orderNumber: varchar("order_number", { length: 50 }),
  
  // Which item (for item-level actions)
  orderItemId: integer("order_item_id").references(() => orderItems.id, { onDelete: "set null" }),
  catalogProductId: integer("catalog_product_id"), // Optional link to catalog_products for analytics
  sku: varchar("sku", { length: 100 }),
  itemName: text("item_name"),
  locationCode: varchar("location_code", { length: 50 }),
  
  // Quantities
  qtyRequested: integer("qty_requested"),        // How many were needed
  qtyBefore: integer("qty_before"),              // Picked qty before action
  qtyAfter: integer("qty_after"),                // Picked qty after action
  qtyDelta: integer("qty_delta"),                // Change amount
  
  // Context
  reason: text("reason"),                        // Short reason, release reason, etc.
  notes: text("notes"),                          // Additional notes
  
  // Device/session info
  deviceType: varchar("device_type", { length: 20 }), // "mobile", "desktop", "scanner"
  sessionId: varchar("session_id", { length: 100 }), // Group actions in a picking session
  
  // Pick method - how was this item picked?
  pickMethod: varchar("pick_method", { length: 20 }), // "scan", "manual", "pick_all", "button"
  
  // Status snapshots
  orderStatusBefore: varchar("order_status_before", { length: 20 }),
  orderStatusAfter: varchar("order_status_after", { length: 20 }),
  itemStatusBefore: varchar("item_status_before", { length: 20 }),
  itemStatusAfter: varchar("item_status_after", { length: 20 }),
  
  // Metadata for extensibility
  metadata: jsonb("metadata"),
});

export const insertPickingLogSchema = createInsertSchema(pickingLogs).omit({
  id: true,
  timestamp: true,
});

export type InsertPickingLog = z.infer<typeof insertPickingLogSchema>;
export type PickingLog = typeof pickingLogs.$inferSelect;

// ============================================
// INVENTORY MANAGEMENT SYSTEM (WMS)
// ============================================

// Movement policy - how strict is inventory tracking for this movement type
export const movementPolicyEnum = ["implicit", "soft_log", "require_scan"] as const;
export type MovementPolicy = typeof movementPolicyEnum[number];

// Warehouse zone types
export const zoneTypeEnum = ["RCV", "BULK", "FWD", "PACK", "SHIP"] as const;
export type ZoneType = typeof zoneTypeEnum[number];

// Warehouse zones (optional - for organizing locations)
export const warehouseZones = pgTable("warehouse_zones", {
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
export const warehouses = pgTable("warehouses", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 20 }).notNull().unique(), // Short code: "EAST", "WEST", "HQ"
  name: varchar("name", { length: 200 }).notNull(), // Full name: "East Coast Distribution Center"
  warehouseType: varchar("warehouse_type", { length: 30 }).notNull().default("fulfillment_center"), // fulfillment_center, bulk_storage, distribution_center
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 50 }),
  postalCode: varchar("postal_code", { length: 20 }),
  country: varchar("country", { length: 50 }).default("US"),
  timezone: varchar("timezone", { length: 50 }).default("America/New_York"),
  isActive: integer("is_active").notNull().default(1),
  isDefault: integer("is_default").notNull().default(0), // Default warehouse for new orders
  shopifyLocationId: varchar("shopify_location_id", { length: 50 }), // Maps to Shopify location_id for inventory sync
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
export const warehouseLocations = pgTable("warehouse_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "cascade" }), // Which warehouse this location belongs to
  code: varchar("code", { length: 50 }).notNull().unique(), // Auto-generated from hierarchy: "BULK-A-02-C-1"
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
  pickSequence: integer("pick_sequence"), // Walk order for optimized picking (null = not sequenced)
  
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
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWarehouseLocationSchema = createInsertSchema(warehouseLocations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWarehouseLocation = z.infer<typeof insertWarehouseLocationSchema>;
export type WarehouseLocation = typeof warehouseLocations.$inferSelect;

// ============================================================================
// PRODUCTS - Master product catalog (source of truth for product identity)
// ============================================================================
export const products = pgTable("products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar("sku", { length: 100 }), // Base SKU for the product family
  name: text("name").notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }), // Product category
  brand: varchar("brand", { length: 100 }), // Brand name
  baseUnit: varchar("base_unit", { length: 20 }).notNull().default("piece"), // piece, pack, box, case, pallet
  imageUrl: text("image_url"),
  shopifyProductId: varchar("shopify_product_id", { length: 100 }), // Shopify product ID for sync
  leadTimeDays: integer("lead_time_days").notNull().default(120), // Supplier lead time in days
  safetyStockDays: integer("safety_stock_days").notNull().default(7), // Safety stock buffer in days of cover
  isActive: boolean("is_active").notNull().default(true),
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
  barcode: varchar("barcode", { length: 100 }),
  weightGrams: integer("weight_grams"),
  lengthMm: integer("length_mm"),
  widthMm: integer("width_mm"),
  heightMm: integer("height_mm"),
  priceCents: integer("price_cents"),
  compareAtPriceCents: integer("compare_at_price_cents"),
  trackInventory: boolean("track_inventory").default(true),
  inventoryPolicy: varchar("inventory_policy", { length: 20 }).default("deny"),
  imageUrl: text("image_url"),
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

// Inventory levels per location - all quantities in variant units (e.g., 5 cases, 10 packs)
// Base unit equivalents are computed at query time via: qty * product_variants.units_per_variant
export const inventoryLevels = pgTable("inventory_levels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  variantQty: integer("variant_qty").notNull().default(0), // Physical on-hand count in variant units (e.g., 5 cases)
  reservedQty: integer("reserved_qty").notNull().default(0), // Allocated to orders (variant units)
  pickedQty: integer("picked_qty").notNull().default(0), // In picker carts (variant units)
  packedQty: integer("packed_qty").notNull().default(0), // Boxed, awaiting ship (variant units)
  backorderQty: integer("backorder_qty").notNull().default(0), // Backorder demand (variant units)
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInventoryLevelSchema = createInsertSchema(inventoryLevels).omit({
  id: true,
  updatedAt: true,
});

export type InsertInventoryLevel = z.infer<typeof insertInventoryLevelSchema>;
export type InventoryLevel = typeof inventoryLevels.$inferSelect;

// Legacy type aliases for backward compatibility during code migration
export type InventoryItem = Product;
export type UomVariant = ProductVariant;

// Transaction types for audit trail
export const transactionTypeEnum = [
  "receipt",      // PO received
  "pick",         // Picked for order
  "adjustment",   // Manual count adjustment
  "break",        // Case/pack broken into smaller units
  "assemble",     // Smaller units assembled into larger pack (future)
  "replenish",    // Moved from bulk to pick location
  "transfer",     // Moved between locations
  "reserve",      // Reserved for order
  "unreserve",    // Reservation released (cancel, short)
  "ship",         // Shipped out
  "return",       // Customer return (future)
  "csv_upload",   // Bulk update from CSV file
] as const;
export type TransactionType = typeof transactionTypeEnum[number];

// Standardized adjustment reasons lookup table
export const adjustmentReasons = pgTable("adjustment_reasons", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 30 }).notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  transactionType: varchar("transaction_type", { length: 30 }).notNull(),
  requiresNote: integer("requires_note").notNull().default(0),
  isActive: integer("is_active").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAdjustmentReasonSchema = createInsertSchema(adjustmentReasons).omit({
  id: true,
  createdAt: true,
});

export type InsertAdjustmentReason = z.infer<typeof insertAdjustmentReasonSchema>;
export type AdjustmentReason = typeof adjustmentReasons.$inferSelect;

// Inventory transactions ledger (audit trail) - Full WMS
// Every inventory movement is logged here for complete audit trail
export const inventoryTransactions = pgTable("inventory_transactions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),

  // Location tracking - for transfers, both are used; for receive/pick, one is null
  fromLocationId: integer("from_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),
  toLocationId: integer("to_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),

  transactionType: varchar("transaction_type", { length: 30 }).notNull(), // receipt, pick, adjustment, transfer, ship, return
  reasonId: integer("reason_id").references(() => adjustmentReasons.id),

  // Quantity changes in variant units
  variantQtyDelta: integer("variant_qty_delta").notNull().default(0), // Positive = add, negative = remove
  variantQtyBefore: integer("variant_qty_before"), // Snapshot: variant qty before at location
  variantQtyAfter: integer("variant_qty_after"), // Snapshot: variant qty after at location

  batchId: varchar("batch_id", { length: 50 }), // Groups transactions from same operation
  sourceState: varchar("source_state", { length: 20 }), // "on_hand", "committed", "picked", etc.
  targetState: varchar("target_state", { length: 20 }), // "committed", "picked", "shipped", etc.

  // Reference links - which operation triggered this transaction
  orderId: integer("order_id").references(() => orders.id),
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  receivingOrderId: integer("receiving_order_id").references(() => receivingOrders.id), // Link to receiving
  cycleCountId: integer("cycle_count_id").references(() => cycleCounts.id), // Link to cycle count
  shipmentId: integer("shipment_id").references(() => shipments.id), // Link to shipment

  referenceType: varchar("reference_type", { length: 30 }), // "order", "receiving", "cycle_count", "manual"
  referenceId: varchar("reference_id", { length: 100 }), // External reference ID
  notes: text("notes"),
  isImplicit: integer("is_implicit").notNull().default(0), // 1 = auto-generated, 0 = explicit scan
  userId: varchar("user_id", { length: 100 }), // Who performed the action
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInventoryTransactionSchema = createInsertSchema(inventoryTransactions).omit({
  id: true,
  createdAt: true,
});

export type InsertInventoryTransaction = z.infer<typeof insertInventoryTransactionSchema>;
export type InventoryTransaction = typeof inventoryTransactions.$inferSelect;

// Replenishment method types
export const replenMethodEnum = ["case_break", "full_case", "pallet_drop", "manual"] as const;
export type ReplenMethod = typeof replenMethodEnum[number];

// Replenishment trigger types
export const replenTriggerEnum = ["min_max", "wave", "manual", "stockout", "inline_pick"] as const;
export type ReplenTrigger = typeof replenTriggerEnum[number];

// Warehouse replenishment mode - who does replen work
export const replenModeEnum = ["inline", "queue", "hybrid"] as const;
export type ReplenMode = typeof replenModeEnum[number];

// Short pick action - what happens when picker encounters shortage
export const shortPickActionEnum = ["pause_and_replen", "partial_pick", "skip_to_next", "block_order"] as const;
export type ShortPickAction = typeof shortPickActionEnum[number];

// Auto-generate trigger - when replen tasks are automatically created
export const autoGenerateTriggerEnum = ["after_pick", "after_wave", "scheduled", "manual_only"] as const;
export type AutoGenerateTrigger = typeof autoGenerateTriggerEnum[number];

// Warehouse settings - configurable per warehouse
export const warehouseSettings = pgTable("warehouse_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").references(() => warehouses.id), // Link to actual warehouse (null = DEFAULT global settings)
  warehouseCode: varchar("warehouse_code", { length: 50 }).notNull().unique().default("DEFAULT"),
  warehouseName: varchar("warehouse_name", { length: 100 }).notNull().default("Main Warehouse"),
  
  // Replenishment workflow settings
  replenMode: varchar("replen_mode", { length: 20 }).notNull().default("queue"), // inline, queue, hybrid
  shortPickAction: varchar("short_pick_action", { length: 30 }).notNull().default("partial_pick"), // pause_and_replen, partial_pick, skip_to_next, block_order
  autoGenerateTrigger: varchar("auto_generate_trigger", { length: 30 }).notNull().default("manual_only"), // after_pick, after_wave, scheduled, manual_only
  
  // Hybrid mode thresholds
  inlineReplenMaxUnits: integer("inline_replen_max_units").default(50), // Max units for inline replen (larger goes to queue)
  inlineReplenMaxCases: integer("inline_replen_max_cases").default(2), // Max cases picker can grab inline
  
  // Priority settings
  urgentReplenThreshold: integer("urgent_replen_threshold").default(0), // Qty at which replen becomes urgent priority
  stockoutPriority: integer("stockout_priority").default(1), // Priority for stockout-triggered tasks
  minMaxPriority: integer("min_max_priority").default(5), // Priority for min/max triggered tasks
  
  // Scheduling settings (for scheduled mode)
  scheduledReplenIntervalMinutes: integer("scheduled_replen_interval_minutes").default(30),
  scheduledReplenEnabled: integer("scheduled_replen_enabled").default(0),
  
  // Pick path optimization
  pickPathOptimization: varchar("pick_path_optimization", { length: 30 }).default("zone_sequence"), // zone_sequence, shortest_path, fifo
  
  // Wave planning settings
  maxOrdersPerWave: integer("max_orders_per_wave").default(50),
  maxItemsPerWave: integer("max_items_per_wave").default(500),
  waveAutoRelease: integer("wave_auto_release").default(0), // Auto-release waves when full
  
  // Order combining settings
  enableOrderCombining: integer("enable_order_combining").notNull().default(1), // Show combine badges to pickers

  // Velocity calculation
  velocityLookbackDays: integer("velocity_lookback_days").notNull().default(14), // Days of pick history for SKU velocity

  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertWarehouseSettingsSchema = createInsertSchema(warehouseSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWarehouseSettings = z.infer<typeof insertWarehouseSettingsSchema>;
export type WarehouseSettings = typeof warehouseSettings.$inferSelect;

// Replenishment task status workflow
export const replenTaskStatusEnum = ["pending", "assigned", "in_progress", "completed", "cancelled", "blocked"] as const;
export type ReplenTaskStatus = typeof replenTaskStatusEnum[number];

// Replenishment tier defaults - tier-based rules by UOM hierarchy level
// These are the DEFAULT rules that apply to all products at a given tier
export const replenTierDefaults = pgTable("replen_tier_defaults", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").references(() => warehouses.id), // Which warehouse this rule applies to (null = global default for all warehouses)
  hierarchyLevel: integer("hierarchy_level").notNull(), // Which tier this applies to (1=each, 2=pack, 3=case, etc.)
  sourceHierarchyLevel: integer("source_hierarchy_level").notNull(), // What tier to pull from
  pickLocationType: varchar("pick_location_type", { length: 30 }).notNull().default("pick"),
  sourceLocationType: varchar("source_location_type", { length: 30 }).notNull().default("reserve"),
  sourcePriority: varchar("source_priority", { length: 20 }).notNull().default("fifo"), // fifo, smallest_first
  triggerValue: integer("trigger_value").notNull().default(0), // case_break/full_case: min units. pallet_drop: coverage days
  maxQty: integer("max_qty"), // Fill up to this qty (null = use bin capacity or one source unit)
  replenMethod: varchar("replen_method", { length: 30 }).notNull().default("case_break"), // case_break, full_case, pallet_drop
  priority: integer("priority").notNull().default(5), // 1 = highest priority
  autoReplen: integer("auto_replen").notNull().default(0), // 1 = system auto-completes replen (no worker needed, e.g. pick-to-pick)
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReplenTierDefaultSchema = createInsertSchema(replenTierDefaults).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReplenTierDefault = z.infer<typeof insertReplenTierDefaultSchema>;
export type ReplenTierDefault = typeof replenTierDefaults.$inferSelect;

// Replenishment SKU overrides - product-specific exceptions to tier defaults
// Only create these when a product needs DIFFERENT behavior than its tier default
export const replenRules = pgTable("replen_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  catalogProductId: integer("catalog_product_id").references(() => catalogProducts.id), // Which product this override applies to
  pickProductVariantId: integer("pick_product_variant_id").references(() => productVariants.id),
  sourceProductVariantId: integer("source_product_variant_id").references(() => productVariants.id),
  pickLocationType: varchar("pick_location_type", { length: 30 }), // Override: different pick location type
  sourceLocationType: varchar("source_location_type", { length: 30 }), // Override: different source location type
  sourcePriority: varchar("source_priority", { length: 20 }), // Override: different priority (fifo, smallest_first)
  triggerValue: integer("trigger_value"), // Override: case_break/full_case: min units. pallet_drop: coverage days
  maxQty: integer("max_qty"), // Override: different fill target
  replenMethod: varchar("replen_method", { length: 30 }), // Override: different method (case_break, full_case, pallet_drop)
  priority: integer("priority"), // Override: different task priority
  autoReplen: integer("auto_replen"), // Override: 1 = system auto-completes (null = use tier default)
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReplenRuleSchema = createInsertSchema(replenRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReplenRule = z.infer<typeof insertReplenRuleSchema>;
export type ReplenRule = typeof replenRules.$inferSelect;

// Per-location replen configuration overrides
// product_variant_id NULL = location-wide default, non-NULL = SKU-specific override at that location
export const locationReplenConfig = pgTable("location_replen_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  triggerValue: varchar("trigger_value", { length: 20 }), // numeric(8,2) in DB — case_break: min units, pallet_drop: coverage days
  maxQty: integer("max_qty"),
  replenMethod: varchar("replen_method", { length: 30 }),
  isActive: integer("is_active").notNull().default(1),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertLocationReplenConfigSchema = createInsertSchema(locationReplenConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertLocationReplenConfig = z.infer<typeof insertLocationReplenConfigSchema>;
export type LocationReplenConfig = typeof locationReplenConfig.$inferSelect;

// Replenishment tasks - work queue for warehouse workers
export const replenTasks = pgTable("replen_tasks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  replenRuleId: integer("replen_rule_id").references(() => replenRules.id),
  fromLocationId: integer("from_location_id").notNull().references(() => warehouseLocations.id),
  toLocationId: integer("to_location_id").notNull().references(() => warehouseLocations.id),
  catalogProductId: integer("catalog_product_id").references(() => catalogProducts.id),
  sourceProductVariantId: integer("source_product_variant_id").references(() => productVariants.id),
  pickProductVariantId: integer("pick_product_variant_id").references(() => productVariants.id),
  qtySourceUnits: integer("qty_source_units").notNull().default(1), // How many cases to pick
  qtyTargetUnits: integer("qty_target_units").notNull(), // How many eaches to put (after conversion)
  qtyCompleted: integer("qty_completed").notNull().default(0), // Eaches actually put
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  priority: integer("priority").notNull().default(5),
  triggeredBy: varchar("triggered_by", { length: 20 }).notNull().default("min_max"), // min_max, wave, manual, stockout
  executionMode: varchar("execution_mode", { length: 20 }).notNull().default("queue"), // queue, inline - based on warehouse settings
  warehouseId: integer("warehouse_id").references(() => warehouses.id), // Which warehouse this task belongs to
  createdBy: varchar("created_by", { length: 100 }),
  assignedTo: varchar("assigned_to", { length: 100 }),
  assignedAt: timestamp("assigned_at"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  notes: text("notes"),
  exceptionReason: varchar("exception_reason", { length: 30 }),
  linkedCycleCountId: integer("linked_cycle_count_id").references(() => cycleCounts.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertReplenTaskSchema = createInsertSchema(replenTasks).omit({
  id: true,
  createdAt: true,
});

export type InsertReplenTask = z.infer<typeof insertReplenTaskSchema>;
export type ReplenTask = typeof replenTasks.$inferSelect;

// Channel feeds - maps variants to external channel IDs (Shopify, future marketplaces)
export const channelTypeEnum = ["shopify", "amazon", "ebay", "wholesale"] as const;
export type ChannelType = typeof channelTypeEnum[number];

export const channelFeeds = pgTable("channel_feeds", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").references(() => channels.id),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  channelType: varchar("channel_type", { length: 30 }).notNull().default("shopify"),
  channelVariantId: varchar("channel_variant_id", { length: 100 }).notNull(), // Shopify variant ID
  channelProductId: varchar("channel_product_id", { length: 100 }), // Shopify product ID
  channelSku: varchar("channel_sku", { length: 100 }), // SKU as it appears in channel
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

// ============================================
// MULTI-CHANNEL INFRASTRUCTURE
// ============================================

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

// Channel reservations - priority stock allocation per channel
export const channelReservations = pgTable("channel_reservations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "cascade" }),
  reserveBaseQty: integer("reserve_base_qty").notNull().default(0), // Base units reserved for this channel
  minStockBase: integer("min_stock_base").default(0), // Minimum stock to maintain (alert threshold)
  maxStockBase: integer("max_stock_base"), // Maximum to list (cap availability)
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

// ============================================
// CATALOG / LISTING MANAGEMENT
// ============================================

// Catalog products - master listing content (source of truth)
// 1:1 with products table — represents the unsellable parent product (Shopify product card)
// Individual sellable SKUs (pack, box, case) live in product_variants
export const catalogProducts = pgTable("catalog_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").references(() => products.id), // FK to products (1:1)
  shopifyProductId: bigint("shopify_product_id", { mode: "number" }).unique(), // Shopify product ID for sync
  sku: varchar("sku", { length: 100 }), // Base SKU for the product family
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"), // HTML/markdown
  bulletPoints: jsonb("bullet_points"), // Array of feature bullet points
  category: varchar("category", { length: 200 }),
  subcategory: varchar("subcategory", { length: 200 }),
  brand: varchar("brand", { length: 100 }),
  manufacturer: varchar("manufacturer", { length: 200 }),
  tags: jsonb("tags"), // Array of tags
  seoTitle: varchar("seo_title", { length: 200 }),
  seoDescription: text("seo_description"),
  status: varchar("status", { length: 20 }).notNull().default("draft"), // draft, active, archived
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCatalogProductSchema = createInsertSchema(catalogProducts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCatalogProduct = z.infer<typeof insertCatalogProductSchema>;
export type CatalogProduct = typeof catalogProducts.$inferSelect;

// Catalog assets - master media library
// productVariantId NULL = product-level asset, non-NULL = variant-specific asset
export const catalogAssets = pgTable("catalog_assets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  catalogProductId: integer("catalog_product_id").notNull().references(() => catalogProducts.id, { onDelete: "cascade" }),
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

export const insertCatalogAssetSchema = createInsertSchema(catalogAssets).omit({
  id: true,
  createdAt: true,
});

export type InsertCatalogAsset = z.infer<typeof insertCatalogAssetSchema>;
export type CatalogAsset = typeof catalogAssets.$inferSelect;

// Channel product overrides - per-channel content customization
export const channelProductOverrides = pgTable("channel_product_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  catalogProductId: integer("catalog_product_id").notNull().references(() => catalogProducts.id, { onDelete: "cascade" }),
  titleOverride: varchar("title_override", { length: 500 }), // NULL = use master
  descriptionOverride: text("description_override"),
  bulletPointsOverride: jsonb("bullet_points_override"),
  categoryOverride: varchar("category_override", { length: 200 }), // Channel-specific category mapping
  tagsOverride: jsonb("tags_override"),
  isListed: integer("is_listed").notNull().default(1), // 0 = hide from this channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_product_overrides_channel_product_idx").on(table.channelId, table.catalogProductId),
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
  catalogAssetId: integer("catalog_asset_id").notNull().references(() => catalogAssets.id, { onDelete: "cascade" }),
  urlOverride: text("url_override"), // Channel-specific image URL
  altTextOverride: varchar("alt_text_override", { length: 500 }),
  positionOverride: integer("position_override"), // Different sort order per channel
  isIncluded: integer("is_included").notNull().default(1), // 0 = exclude this asset from channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_asset_overrides_channel_asset_idx").on(table.channelId, table.catalogAssetId),
]);

export const insertChannelAssetOverrideSchema = createInsertSchema(channelAssetOverrides).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertChannelAssetOverride = z.infer<typeof insertChannelAssetOverrideSchema>;
export type ChannelAssetOverride = typeof channelAssetOverrides.$inferSelect;

// ============================================
// ROLE-BASED ACCESS CONTROL (RBAC)
// ============================================

// Permission categories for UI grouping
export const permissionCategoryEnum = ["dashboard", "inventory", "orders", "picking", "channels", "reports", "users", "settings"] as const;
export type PermissionCategory = typeof permissionCategoryEnum[number];

// Auth roles - custom roles created by admin
export const authRoles = pgTable("auth_roles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  description: text("description"),
  isSystem: integer("is_system").notNull().default(0), // 1 = built-in role (admin/lead/picker), cannot delete
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAuthRoleSchema = createInsertSchema(authRoles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAuthRole = z.infer<typeof insertAuthRoleSchema>;
export type AuthRole = typeof authRoles.$inferSelect;

// Auth permissions - individual permissions (resource:action pairs)
export const authPermissions = pgTable("auth_permissions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  resource: varchar("resource", { length: 50 }).notNull(), // e.g., "inventory", "orders"
  action: varchar("action", { length: 50 }).notNull(), // e.g., "view", "create", "edit", "delete"
  description: text("description"),
  category: varchar("category", { length: 50 }).notNull(), // For UI grouping
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_permissions_resource_action_idx").on(table.resource, table.action),
]);

export const insertAuthPermissionSchema = createInsertSchema(authPermissions).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthPermission = z.infer<typeof insertAuthPermissionSchema>;
export type AuthPermission = typeof authPermissions.$inferSelect;

// Auth role permissions - links roles to their allowed permissions
export const authRolePermissions = pgTable("auth_role_permissions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  roleId: integer("role_id").notNull().references(() => authRoles.id, { onDelete: "cascade" }),
  permissionId: integer("permission_id").notNull().references(() => authPermissions.id, { onDelete: "cascade" }),
  constraints: jsonb("constraints"), // Optional scoping rules (e.g., specific warehouse, zone)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_role_permissions_role_perm_idx").on(table.roleId, table.permissionId),
]);

export const insertAuthRolePermissionSchema = createInsertSchema(authRolePermissions).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthRolePermission = z.infer<typeof insertAuthRolePermissionSchema>;
export type AuthRolePermission = typeof authRolePermissions.$inferSelect;

// Auth user roles - assigns roles to users (supports multiple roles per user)
export const authUserRoles = pgTable("auth_user_roles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: integer("role_id").notNull().references(() => authRoles.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("auth_user_roles_user_role_idx").on(table.userId, table.roleId),
]);

export const insertAuthUserRoleSchema = createInsertSchema(authUserRoles).omit({
  id: true,
  createdAt: true,
});

export type InsertAuthUserRole = z.infer<typeof insertAuthUserRoleSchema>;
export type AuthUserRole = typeof authUserRoles.$inferSelect;

// Helper type for user with permissions
export type UserWithPermissions = SafeUser & {
  roles: AuthRole[];
  permissions: string[]; // Array of "resource:action" strings
};

// ============================================
// ECHELON APPLICATION SETTINGS
// ============================================

export const echelonSettings = pgTable("echelon_settings", {
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

// ============================================
// CYCLE COUNTS (Inventory Reconciliation)
// ============================================

// Cycle count status workflow
export const cycleCountStatusEnum = ["draft", "in_progress", "pending_review", "completed", "cancelled"] as const;
export type CycleCountStatus = typeof cycleCountStatusEnum[number];

// Variance types for reconciliation
export const varianceTypeEnum = [
  "quantity_over",     // Found more than expected
  "quantity_under",    // Found less than expected (shrinkage/damage)
  "sku_mismatch",      // Different SKU in bin than expected
  "unexpected_item",   // Item found but not expected in this bin
  "missing_item",      // Item expected but not found
] as const;
export type VarianceType = typeof varianceTypeEnum[number];

// Cycle count sessions (monthly reconciliation)
export const cycleCounts = pgTable("cycle_counts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull(), // e.g., "January 2026 Cycle Count"
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  warehouseId: integer("warehouse_id").references(() => warehouses.id),
  zoneFilter: varchar("zone_filter", { length: 20 }), // Optional: limit to specific zone
  locationTypeFilter: text("location_type_filter"), // Optional: comma-separated list of location types to include
  binTypeFilter: text("bin_type_filter"), // Optional: comma-separated list of bin types to include (bin, pallet, carton_flow, etc.)
  assignedTo: varchar("assigned_to", { length: 100 }), // User assigned to count
  totalBins: integer("total_bins").notNull().default(0),
  countedBins: integer("counted_bins").notNull().default(0),
  varianceCount: integer("variance_count").notNull().default(0),
  approvedVariances: integer("approved_variances").notNull().default(0),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCycleCountSchema = createInsertSchema(cycleCounts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCycleCount = z.infer<typeof insertCycleCountSchema>;
export type CycleCount = typeof cycleCounts.$inferSelect;

// Individual bin counts within a cycle count session
export const cycleCountItems = pgTable("cycle_count_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  cycleCountId: integer("cycle_count_id").notNull().references(() => cycleCounts.id, { onDelete: "cascade" }),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id), // Expected variant (null if bin should be empty)
  catalogProductId: integer("catalog_product_id").references(() => catalogProducts.id), // Link to catalog
  
  // Expected (system) values at time of count
  expectedSku: varchar("expected_sku", { length: 100 }),
  expectedQty: integer("expected_qty").notNull().default(0),
  
  // Actual (counted) values
  countedSku: varchar("counted_sku", { length: 100 }),
  countedQty: integer("counted_qty"),
  
  // Variance tracking
  varianceQty: integer("variance_qty"), // countedQty - expectedQty
  varianceType: varchar("variance_type", { length: 30 }), // from varianceTypeEnum
  varianceReason: varchar("variance_reason", { length: 50 }), // damaged, shrinkage, misplaced, found, etc.
  varianceNotes: text("variance_notes"),
  
  // Status
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, counted, variance, approved, adjusted
  
  // Related item for SKU mismatch workflow (links expected→found items)
  relatedItemId: integer("related_item_id"), // Points to the other half of a mismatch pair
  mismatchType: varchar("mismatch_type", { length: 20 }), // "expected_missing" or "unexpected_found"
  
  // Approval workflow
  requiresApproval: integer("requires_approval").notNull().default(0), // 1 if variance exceeds threshold
  approvedBy: varchar("approved_by", { length: 100 }),
  approvedAt: timestamp("approved_at"),
  adjustmentTransactionId: integer("adjustment_transaction_id").references(() => inventoryTransactions.id),
  
  // Audit
  countedBy: varchar("counted_by", { length: 100 }),
  countedAt: timestamp("counted_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCycleCountItemSchema = createInsertSchema(cycleCountItems).omit({
  id: true,
  createdAt: true,
});

export type InsertCycleCountItem = z.infer<typeof insertCycleCountItemSchema>;
export type CycleCountItem = typeof cycleCountItems.$inferSelect;

// ===== RECEIVING & VENDORS =====

// Vendors - suppliers for receiving POs
export const vendors = pgTable("vendors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 20 }).notNull().unique(), // Short code like "ACME"
  name: text("name").notNull(),
  contactName: text("contact_name"),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  address: text("address"),
  notes: text("notes"),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertVendorSchema = createInsertSchema(vendors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertVendor = z.infer<typeof insertVendorSchema>;
export type Vendor = typeof vendors.$inferSelect;

// Receiving status workflow: draft → open → receiving → verified → closed
export const receivingStatusEnum = ["draft", "open", "receiving", "verified", "closed", "cancelled"] as const;
export type ReceivingStatus = typeof receivingStatusEnum[number];

// Receiving source types
export const receivingSourceEnum = ["po", "asn", "blind", "initial_load"] as const;
export type ReceivingSource = typeof receivingSourceEnum[number];

// Receiving Orders - header for each receipt
export const receivingOrders = pgTable("receiving_orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  
  // Identification
  receiptNumber: varchar("receipt_number", { length: 50 }).notNull().unique(), // Auto-generated RCV-YYYYMMDD-XXX
  poNumber: varchar("po_number", { length: 100 }), // External PO number from vendor
  asnNumber: varchar("asn_number", { length: 100 }), // Advance shipment notice number
  
  // Source & vendor
  sourceType: varchar("source_type", { length: 20 }).notNull().default("blind"), // po, asn, blind, initial_load
  vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
  
  // Warehouse
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
  receivingLocationId: integer("receiving_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }), // Staging area
  
  // Status & dates
  status: varchar("status", { length: 20 }).notNull().default("draft"), // draft, open, receiving, verified, closed, cancelled
  expectedDate: timestamp("expected_date"),
  receivedDate: timestamp("received_date"), // When receiving started
  closedDate: timestamp("closed_date"), // When receipt was finalized
  
  // Counts
  expectedLineCount: integer("expected_line_count").default(0),
  receivedLineCount: integer("received_line_count").default(0),
  expectedTotalUnits: integer("expected_total_units").default(0),
  receivedTotalUnits: integer("received_total_units").default(0),
  
  // Audit
  notes: text("notes"),
  createdBy: varchar("created_by", { length: 100 }),
  receivedBy: varchar("received_by", { length: 100 }),
  closedBy: varchar("closed_by", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReceivingOrderSchema = createInsertSchema(receivingOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReceivingOrder = z.infer<typeof insertReceivingOrderSchema>;
export type ReceivingOrder = typeof receivingOrders.$inferSelect;

// Receiving line status
export const receivingLineStatusEnum = ["pending", "partial", "complete", "overage", "short"] as const;
export type ReceivingLineStatus = typeof receivingLineStatusEnum[number];

// Receiving Lines - individual items on a receipt
export const receivingLines = pgTable("receiving_lines", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  receivingOrderId: integer("receiving_order_id").notNull().references(() => receivingOrders.id, { onDelete: "cascade" }),
  
  // Product reference
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  catalogProductId: integer("catalog_product_id").references(() => catalogProducts.id),
  
  // Product info (cached for display)
  sku: varchar("sku", { length: 100 }),
  productName: text("product_name"),
  barcode: varchar("barcode", { length: 100 }),
  
  // Quantities
  expectedQty: integer("expected_qty").notNull().default(0), // From PO (0 for blind receives)
  receivedQty: integer("received_qty").notNull().default(0), // Actually received
  damagedQty: integer("damaged_qty").notNull().default(0), // Damaged during receipt
  
  // Cost tracking
  unitCost: integer("unit_cost"), // Cost per unit in cents
  
  // Put-away location (where it goes after receiving)
  putawayLocationId: integer("putaway_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),
  putawayComplete: integer("putaway_complete").notNull().default(0), // 1 = put away
  
  // Status
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, partial, complete, overage, short
  
  // Audit
  receivedBy: varchar("received_by").references(() => users.id, { onDelete: "set null" }),
  receivedAt: timestamp("received_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertReceivingLineSchema = createInsertSchema(receivingLines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertReceivingLine = z.infer<typeof insertReceivingLineSchema>;
export type ReceivingLine = typeof receivingLines.$inferSelect;

// Combined Order Groups - for picking/shipping multiple orders together
export const combinedOrderGroups = pgTable("combined_order_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  
  // Identification
  groupCode: varchar("group_code", { length: 20 }).notNull().unique(), // e.g., "G-1024" based on parent order
  
  // Shared customer/shipping info (denormalized for quick display)
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  shippingAddress: text("shipping_address"),
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingPostalCode: text("shipping_postal_code"),
  shippingCountry: text("shipping_country"),
  addressHash: varchar("address_hash", { length: 64 }), // Normalized address hash for matching
  
  // Aggregates
  orderCount: integer("order_count").notNull().default(0),
  totalItems: integer("total_items").notNull().default(0),
  totalUnits: integer("total_units").notNull().default(0),
  
  // Status
  status: varchar("status", { length: 20 }).notNull().default("active"), // active, picked, shipped, cancelled
  
  // Audit
  createdBy: varchar("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCombinedOrderGroupSchema = createInsertSchema(combinedOrderGroups).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCombinedOrderGroup = z.infer<typeof insertCombinedOrderGroupSchema>;
export type CombinedOrderGroup = typeof combinedOrderGroups.$inferSelect;

// ============================================
// SHIPMENTS & FULFILLMENT
// ============================================

// Shipment source types
export const shipmentSourceEnum = ["shopify_webhook", "manual", "api"] as const;
export type ShipmentSource = typeof shipmentSourceEnum[number];

// Shipment status workflow
export const shipmentStatusEnum = ["pending", "packed", "shipped", "delivered"] as const;
export type ShipmentStatus = typeof shipmentStatusEnum[number];

// Shipments - tracks fulfillment from warehouse through carrier delivery
export const shipments = pgTable("shipments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").references(() => orders.id),
  channelId: integer("channel_id").references(() => channels.id),
  externalFulfillmentId: varchar("external_fulfillment_id", { length: 200 }), // Shopify fulfillment ID or external reference
  source: varchar("source", { length: 30 }).notNull().default("shopify_webhook"), // shopify_webhook, manual, api
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending, packed, shipped, delivered
  carrier: varchar("carrier", { length: 100 }),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  trackingUrl: text("tracking_url"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertShipmentSchema = createInsertSchema(shipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertShipment = z.infer<typeof insertShipmentSchema>;
export type Shipment = typeof shipments.$inferSelect;

// Shipment items - individual items within a shipment
export const shipmentItems = pgTable("shipment_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shipmentId: integer("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  qty: integer("qty").notNull().default(1),
  fromLocationId: integer("from_location_id").references(() => warehouseLocations.id), // which bin it was picked from
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertShipmentItemSchema = createInsertSchema(shipmentItems).omit({
  id: true,
  createdAt: true,
});

export type InsertShipmentItem = z.infer<typeof insertShipmentItemSchema>;
export type ShipmentItem = typeof shipmentItems.$inferSelect;

// App Settings - key-value store for application configuration
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value"),
  type: varchar("type", { length: 20 }), // boolean, string, number, json
  category: varchar("category", { length: 50 }), // picking, shipping, sync, etc.
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type AppSetting = typeof appSettings.$inferSelect;
