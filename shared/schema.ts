import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
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
  location: varchar("location", { length: 50 }).notNull(),
  zone: varchar("zone", { length: 10 }).notNull(),
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

export const orders = pgTable("orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shopifyOrderId: varchar("shopify_order_id", { length: 50 }).notNull().unique(),
  orderNumber: varchar("order_number", { length: 50 }).notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email"),
  priority: varchar("priority", { length: 20 }).notNull().default("normal"),
  status: varchar("status", { length: 20 }).notNull().default("ready"),
  onHold: integer("on_hold").notNull().default(0), // 1 = on hold (hidden from pickers), 0 = available
  heldAt: timestamp("held_at"), // When the order was put on hold
  assignedPickerId: varchar("assigned_picker_id", { length: 100 }),
  batchId: varchar("batch_id", { length: 50 }),
  itemCount: integer("item_count").notNull().default(0),
  pickedCount: integer("picked_count").notNull().default(0),
  shortReason: text("short_reason"),
  metadata: jsonb("metadata"),
  shopifyCreatedAt: timestamp("shopify_created_at"), // When the order was placed in Shopify
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  // Exception tracking fields
  exceptionAt: timestamp("exception_at"), // When the order entered exception status
  exceptionResolution: varchar("exception_resolution", { length: 20 }), // ship_partial, hold, resolved, cancelled
  exceptionResolvedAt: timestamp("exception_resolved_at"),
  exceptionResolvedBy: varchar("exception_resolved_by", { length: 100 }), // User ID who resolved
  exceptionNotes: text("exception_notes"), // Lead notes on resolution
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
  shopifyLineItemId: varchar("shopify_line_item_id", { length: 50 }),
  sku: varchar("sku", { length: 100 }).notNull(),
  name: text("name").notNull(),
  quantity: integer("quantity").notNull(),
  pickedQuantity: integer("picked_quantity").notNull().default(0),
  fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0), // Quantity fulfilled in Shopify (shipped by Shipstation)
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  location: varchar("location", { length: 50 }).notNull().default("UNASSIGNED"),
  zone: varchar("zone", { length: 10 }).notNull().default("U"),
  imageUrl: text("image_url"),
  barcode: varchar("barcode", { length: 100 }), // Product barcode for scanner matching
  shortReason: text("short_reason"),
  pickedAt: timestamp("picked_at"), // When this item was picked
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

// Location types for warehouse management
export const locationTypeEnum = ["forward_pick", "bulk_storage", "receiving", "pallet"] as const;
export type LocationType = typeof locationTypeEnum[number];

// Movement policy - how strict is inventory tracking for this movement type
export const movementPolicyEnum = ["implicit", "soft_log", "require_scan"] as const;
export type MovementPolicy = typeof movementPolicyEnum[number];

// Warehouse locations (bins, pallets, racks, etc.)
export const warehouseLocations = pgTable("warehouse_locations", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 50 }).notNull().unique(), // e.g., "A-01-02-B", "PALLET-R3-L2"
  name: text("name"), // Friendly name
  locationType: varchar("location_type", { length: 30 }).notNull().default("forward_pick"),
  zone: varchar("zone", { length: 10 }).notNull().default("A"),
  isPickable: integer("is_pickable").notNull().default(1), // 1 = contributes to ATP
  parentLocationId: integer("parent_location_id"), // Replenishment source (references self)
  movementPolicy: varchar("movement_policy", { length: 20 }).notNull().default("implicit"),
  minQty: integer("min_qty"), // Trigger replenishment alert when below this
  maxQty: integer("max_qty"), // Maximum capacity
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
  baseSku: varchar("base_sku", { length: 100 }).notNull().unique(), // e.g., "EG-STD-SLV"
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
  warehouseLocationId: integer("warehouse_location_id").notNull().references(() => warehouseLocations.id),
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
  warehouseLocationId: integer("warehouse_location_id").references(() => warehouseLocations.id),
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
