import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, uniqueIndex, bigint } from "drizzle-orm/pg-core";
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

export const productLocations = pgTable("product_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar("sku", { length: 100 }).notNull().unique(),
  name: text("name").notNull(),
  location: varchar("location", { length: 50 }).notNull(), // Location code (must match a warehouse_locations.code)
  zone: varchar("zone", { length: 10 }).notNull(), // Derived from location for grouping
  warehouseLocationId: integer("warehouse_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }), // FK to warehouse_locations
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
  shippingAddress: text("shipping_address"), // Legacy single-line format
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingPostalCode: text("shipping_postal_code"),
  shippingCountry: text("shipping_country"),
  
  // ===== WAREHOUSE OPERATIONS =====
  priority: varchar("priority", { length: 20 }).notNull().default("normal"), // rush, high, normal
  status: varchar("status", { length: 20 }).notNull().default("ready"), // ready, in_progress, completed, exception, shipped, cancelled
  onHold: integer("on_hold").notNull().default(0), // 1 = on hold, 0 = available
  heldAt: timestamp("held_at"),
  assignedPickerId: varchar("assigned_picker_id", { length: 100 }),
  batchId: varchar("batch_id", { length: 50 }),
  
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

// Location types for warehouse management
export const locationTypeEnum = ["forward_pick", "bulk_storage", "receiving", "packing", "shipping", "staging", "pallet"] as const;
export type LocationType = typeof locationTypeEnum[number];

// Warehouse zones (optional - for organizing locations)
export const warehouseZones = pgTable("warehouse_zones", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 10 }).notNull().unique(), // RCV, BULK, FWD, PACK, SHIP
  name: varchar("name", { length: 50 }).notNull(), // "Receiving Dock", "Bulk Storage", etc.
  description: text("description"),
  locationType: varchar("location_type", { length: 30 }).notNull().default("forward_pick"),
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
  address: text("address"),
  city: varchar("city", { length: 100 }),
  state: varchar("state", { length: 50 }),
  postalCode: varchar("postal_code", { length: 20 }),
  country: varchar("country", { length: 50 }).default("US"),
  timezone: varchar("timezone", { length: 50 }).default("America/New_York"),
  isActive: integer("is_active").notNull().default(1),
  isDefault: integer("is_default").notNull().default(0), // Default warehouse for new orders
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
  locationType: varchar("location_type", { length: 30 }).notNull().default("forward_pick"), // forward_pick, bulk_storage, receiving, packing, shipping
  isPickable: integer("is_pickable").notNull().default(1), // 1 = contributes to ATP
  pickSequence: integer("pick_sequence"), // Walk order for optimized picking (null = not sequenced)
  
  // Replenishment chain
  parentLocationId: integer("parent_location_id"), // Bulk location that feeds this forward pick
  movementPolicy: varchar("movement_policy", { length: 20 }).notNull().default("implicit"),
  
  // Capacity constraints
  minQty: integer("min_qty"), // Trigger replenishment alert when below
  maxQty: integer("max_qty"), // Maximum units this location can hold
  maxWeight: integer("max_weight"), // Max weight in lbs (optional)
  widthInches: integer("width_inches"), // Physical dimensions for slotting
  heightInches: integer("height_inches"),
  depthInches: integer("depth_inches"),
  
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

// Master inventory items (base SKU level)
export const inventoryItems = pgTable("inventory_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  baseSku: varchar("base_sku", { length: 100 }), // e.g., "EG-STD-SLV" - optional, not unique since variant_id is primary identifier
  shopifyVariantId: bigint("shopify_variant_id", { mode: "number" }).unique(), // Shopify variant ID - primary key for syncing
  shopifyProductId: bigint("shopify_product_id", { mode: "number" }), // Shopify product ID
  name: text("name").notNull(),
  description: text("description"),
  baseUnit: varchar("base_unit", { length: 20 }).notNull().default("each"), // "each", "unit", etc.
  costPerUnit: integer("cost_per_unit"), // Cost in cents
  imageUrl: text("image_url"),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInventoryItemSchema = createInsertSchema(inventoryItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;
export type InventoryItem = typeof inventoryItems.$inferSelect;

// UOM Variants - sellable SKUs at different pack levels
export const uomVariants = pgTable("uom_variants", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  sku: varchar("sku", { length: 100 }).notNull().unique(), // e.g., "EG-STD-SLV-P100"
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItems.id),
  name: text("name").notNull(), // "Easy Glide Sleeves - Pack of 100"
  unitsPerVariant: integer("units_per_variant").notNull(), // 100 for P100, 500 for B500, etc.
  hierarchyLevel: integer("hierarchy_level").notNull().default(1), // 1=smallest, 2, 3, 4=largest
  parentVariantId: integer("parent_variant_id"), // For replenishment chain (P1 <- B25 <- C250)
  barcode: varchar("barcode", { length: 100 }),
  imageUrl: text("image_url"),
  active: integer("active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertUomVariantSchema = createInsertSchema(uomVariants).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUomVariant = z.infer<typeof insertUomVariantSchema>;
export type UomVariant = typeof uomVariants.$inferSelect;

// Inventory levels per location - tracks both physical variant count and base units
export const inventoryLevels = pgTable("inventory_levels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItems.id),
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id, { onDelete: "cascade" }),
  variantId: integer("variant_id").references(() => uomVariants.id), // Which variant is stored here
  variantQty: integer("variant_qty").notNull().default(0), // Physical count of variant units (e.g., 5 boxes)
  onHandBase: integer("on_hand_base").notNull().default(0), // Derived: variantQty * unitsPerVariant
  reservedBase: integer("reserved_base").notNull().default(0), // Allocated to orders (in base units)
  pickedBase: integer("picked_base").notNull().default(0), // In picker carts (in base units)
  packedBase: integer("packed_base").notNull().default(0), // Boxed, awaiting ship (in base units)
  backorderBase: integer("backorder_base").notNull().default(0), // Backorder demand (in base units)
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertInventoryLevelSchema = createInsertSchema(inventoryLevels).omit({
  id: true,
  updatedAt: true,
});

export type InsertInventoryLevel = z.infer<typeof insertInventoryLevelSchema>;
export type InventoryLevel = typeof inventoryLevels.$inferSelect;

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

// Inventory transactions ledger (audit trail)
export const inventoryTransactions = pgTable("inventory_transactions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItems.id),
  variantId: integer("variant_id").references(() => uomVariants.id),
  warehouseLocationId: integer("warehouse_location_id").references(() => warehouseLocations.id, { onDelete: "set null" }),
  transactionType: varchar("transaction_type", { length: 30 }).notNull(),
  reasonId: integer("reason_id").references(() => adjustmentReasons.id),
  baseQtyDelta: integer("base_qty_delta").notNull(), // Positive = add, negative = remove
  variantQtyDelta: integer("variant_qty_delta"), // Delta in variant units
  baseQtyBefore: integer("base_qty_before"), // Snapshot: on_hand before this change
  baseQtyAfter: integer("base_qty_after"), // Snapshot: on_hand after this change
  variantQtyBefore: integer("variant_qty_before"), // Snapshot: variant qty before
  variantQtyAfter: integer("variant_qty_after"), // Snapshot: variant qty after
  batchId: varchar("batch_id", { length: 50 }), // Groups transactions from same operation (e.g., CSV upload)
  sourceState: varchar("source_state", { length: 20 }), // "on_hand", "reserved", "picked", etc.
  targetState: varchar("target_state", { length: 20 }), // "reserved", "picked", "shipped", etc.
  orderId: integer("order_id").references(() => orders.id), // Link to order if applicable
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  referenceType: varchar("reference_type", { length: 30 }), // "order", "po", "adjustment", etc.
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

// Channel feeds - maps variants to external channel IDs (Shopify, future marketplaces)
export const channelTypeEnum = ["shopify", "amazon", "ebay", "wholesale"] as const;
export type ChannelType = typeof channelTypeEnum[number];

export const channelFeeds = pgTable("channel_feeds", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  variantId: integer("variant_id").notNull().references(() => uomVariants.id),
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
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }),
  reserveBaseQty: integer("reserve_base_qty").notNull().default(0), // Base units reserved for this channel
  minStockBase: integer("min_stock_base").default(0), // Minimum stock to maintain (alert threshold)
  maxStockBase: integer("max_stock_base"), // Maximum to list (cap availability)
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_reservations_channel_item_idx").on(table.channelId, table.inventoryItemId),
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
export const catalogProducts = pgTable("catalog_products", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  inventoryItemId: integer("inventory_item_id").notNull().references(() => inventoryItems.id, { onDelete: "cascade" }).unique(),
  shopifyVariantId: bigint("shopify_variant_id", { mode: "number" }).unique(), // Primary key for Shopify sync
  sku: varchar("sku", { length: 100 }), // Optional - products may not have SKU yet
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
export const catalogAssets = pgTable("catalog_assets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  catalogProductId: integer("catalog_product_id").notNull().references(() => catalogProducts.id, { onDelete: "cascade" }),
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
  variantId: integer("variant_id").notNull().references(() => uomVariants.id, { onDelete: "cascade" }),
  price: integer("price").notNull(), // In cents
  compareAtPrice: integer("compare_at_price"), // MSRP / strikethrough price
  cost: integer("cost"), // For margin tracking
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_pricing_channel_variant_idx").on(table.channelId, table.variantId),
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
  variantId: integer("variant_id").notNull().references(() => uomVariants.id, { onDelete: "cascade" }),
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
  uniqueIndex("channel_listings_channel_variant_idx").on(table.channelId, table.variantId),
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
  variantId: integer("variant_id").notNull().references(() => uomVariants.id, { onDelete: "cascade" }),
  nameOverride: varchar("name_override", { length: 500 }), // NULL = use master
  skuOverride: varchar("sku_override", { length: 100 }), // Channel-specific SKU
  barcodeOverride: varchar("barcode_override", { length: 100 }),
  weightOverride: integer("weight_override"), // In grams
  isListed: integer("is_listed").notNull().default(1), // 0 = hide this variant from channel
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_variant_overrides_channel_variant_idx").on(table.channelId, table.variantId),
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
// APPLICATION SETTINGS
// ============================================

export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value"),
  type: varchar("type", { length: 20 }).notNull().default("string"), // string, number, boolean, json
  category: varchar("category", { length: 50 }).notNull().default("general"),
  description: text("description"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAppSettingSchema = createInsertSchema(appSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertAppSetting = z.infer<typeof insertAppSettingSchema>;
export type AppSetting = typeof appSettings.$inferSelect;
