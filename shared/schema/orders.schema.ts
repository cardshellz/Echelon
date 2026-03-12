import { pgTable, text, varchar, integer, timestamp, jsonb, bigint, boolean, numeric, doublePrecision, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { products, productVariants } from "./catalog.schema";
import { warehouses, warehouseLocations } from "./warehouse.schema";
import { channels } from "./channels.schema";
import { users } from "./identity.schema";
import { vendors } from "./procurement.schema";

// ============================================
// ENUMS
// ============================================

// Order status workflow: ready -> in_progress -> completed/exception -> ready_to_ship -> shipped
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

// Fulfillment routing rule match types
export const routingMatchTypeEnum = ["location_id", "sku_prefix", "tag", "country", "default"] as const;
export type RoutingMatchType = typeof routingMatchTypeEnum[number];

// Shipment source types
export const shipmentSourceEnum = ["shopify_webhook", "manual", "api"] as const;
export type ShipmentSource = typeof shipmentSourceEnum[number];

// Shipment status workflow
export const shipmentStatusEnum = ["pending", "packed", "shipped", "delivered"] as const;
export type ShipmentStatus = typeof shipmentStatusEnum[number];

// ============================================
// ORDERS
// ============================================

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
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }), // Which warehouse fulfills this order
  priority: varchar("priority", { length: 20 }).notNull().default("normal"), // rush, high, normal
  warehouseStatus: varchar("warehouse_status", { length: 20 }).notNull().default("ready"), // ready, picking, picked, packing, packed, shipped, exception, cancelled, awaiting_3pl
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

  // ===== SLA TRACKING (3PL orders) =====
  slaDueAt: timestamp("sla_due_at"), // When 3PL must fulfill by (orderPlacedAt + partner slaDays)
  slaStatus: varchar("sla_status", { length: 20 }), // on_time, at_risk, overdue, met

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

// ============================================
// ORDER ITEMS
// ============================================

export const orderItems = pgTable("order_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),

  // ===== CHANNEL LINKAGE =====
  // Links to source raw tables for full line item data (pricing, properties, etc.)
  shopifyLineItemId: varchar("shopify_line_item_id", { length: 50 }), // Legacy
  sourceItemId: varchar("source_item_id", { length: 100 }), // ID in source table for JOIN lookups

  // ===== PRODUCT (for picking display) =====
  productId: integer("product_id"), // Optional link to products for analytics (nullable - doesn't affect order creation)
  sku: varchar("sku", { length: 100 }).notNull(),
  name: text("name").notNull(),
  imageUrl: text("image_url"),
  barcode: varchar("barcode", { length: 100 }), // For scanner matching

  // ===== FINANCIALS (from channel) =====
  priceCents: integer("price_cents"), // Sale price per unit
  discountCents: integer("discount_cents").default(0), // Per-unit discount
  totalPriceCents: integer("total_price_cents"), // Line total after discount

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
  productId: integer("product_id"), // Optional link to products for analytics
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
// FULFILLMENT ROUTING RULES
// ============================================

// Fulfillment routing rules — determines which warehouse fulfills an order
// Evaluated by priority (highest first), first match wins
export const fulfillmentRoutingRules = pgTable("fulfillment_routing_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").references(() => channels.id, { onDelete: "cascade" }), // NULL = applies to all channels
  matchType: varchar("match_type", { length: 20 }).notNull(), // location_id, sku_prefix, tag, country, default
  matchValue: varchar("match_value", { length: 255 }), // The value to match against (NULL for 'default' type)
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0), // Higher = evaluated first
  isActive: integer("is_active").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertFulfillmentRoutingRuleSchema = createInsertSchema(fulfillmentRoutingRules).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFulfillmentRoutingRule = z.infer<typeof insertFulfillmentRoutingRuleSchema>;
export type FulfillmentRoutingRule = typeof fulfillmentRoutingRules.$inferSelect;

// ============================================
// COMBINED ORDER GROUPS
// ============================================

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

// ============================================================================
// ORDER ITEM COSTS — COGS per shipment (Phase 6, schema defined now)
// ============================================================================

export const orderItemCosts = pgTable("order_item_costs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
  inventoryLotId: integer("inventory_lot_id").notNull(), // FK to inventory_lots (cross-domain, enforced at DB level)
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  qty: integer("qty").notNull(), // Units from this lot
  unitCostCents: doublePrecision("unit_cost_cents").notNull(), // From lot
  totalCostCents: doublePrecision("total_cost_cents").notNull(), // qty * unit_cost
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrderItemCostSchema = createInsertSchema(orderItemCosts).omit({
  id: true,
  createdAt: true,
});

export type InsertOrderItemCost = z.infer<typeof insertOrderItemCostSchema>;
export type OrderItemCost = typeof orderItemCosts.$inferSelect;

// ============================================================================
// ORDER ITEM FINANCIALS — Contribution profit per shipped line item (Phase 7)
// ============================================================================

export const orderItemFinancials = pgTable("order_item_financials", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }), // Cached for fast queries
  productName: text("product_name"), // Cached
  qtyShipped: integer("qty_shipped").notNull(),
  revenueCents: bigint("revenue_cents", { mode: "number" }).notNull(), // From order_items.total_price_cents
  cogsCents: bigint("cogs_cents", { mode: "number" }).notNull(), // From SUM(order_item_costs.total_cost_cents)
  grossProfitCents: bigint("gross_profit_cents", { mode: "number" }).notNull(), // revenue - cogs
  marginPercent: numeric("margin_percent", { precision: 5, scale: 2 }), // (profit / revenue) * 100
  avgSellingPriceCents: doublePrecision("avg_selling_price_cents"), // revenue / qty
  avgUnitCostCents: doublePrecision("avg_unit_cost_cents"), // cogs / qty
  vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }), // Which vendor supplied (from lot's PO)
  channelId: integer("channel_id").references(() => channels.id, { onDelete: "set null" }),
  shippedAt: timestamp("shipped_at").notNull(), // When fulfilled
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrderItemFinancialSchema = createInsertSchema(orderItemFinancials).omit({
  id: true,
  createdAt: true,
});

export type InsertOrderItemFinancial = z.infer<typeof insertOrderItemFinancialSchema>;
export type OrderItemFinancial = typeof orderItemFinancials.$inferSelect;
