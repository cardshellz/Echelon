import { pgTable, text, varchar, integer, timestamp, jsonb, bigint, boolean, numeric, uniqueIndex, pgSchema } from "drizzle-orm/pg-core";
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

// Shipping service level — business fulfillment intent (not customer label)
export const shippingServiceLevelEnum = ["standard", "expedited", "overnight"] as const;
export type ShippingServiceLevel = typeof shippingServiceLevelEnum[number];

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

export const wmsSchema = pgSchema("wms");

export const orders = wmsSchema.table("orders", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

  // ===== MULTI-CHANNEL LINKAGE =====
  // Links to source raw tables (shopify_orders, ebay_orders, etc.) for full order data
  omsFulfillmentOrderId: varchar("oms_fulfillment_order_id", { length: 128 }),
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
  priority: integer("priority").notNull().default(100), // Numerical priority: higher is better
  shippingServiceLevel: varchar("shipping_service_level", { length: 20 }).notNull().default("standard"), // normalized: standard | expedited | overnight
  memberPlanName: varchar("member_plan_name", { length: 20 }),
  memberPlanColor: varchar("member_plan_color", { length: 20 }),
  channelShipByDate: timestamp("channel_ship_by_date"), // platform-provided ship-by deadline, preferred over generic channel SLA
  sortRank: varchar("sort_rank", { length: 32 }), // flattened pick queue sort key (26 chars), pushed to ShipStation customField1
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
  legacyOrderId: varchar("legacy_order_id", { length: 100 }), // Legacy order ID from external systems

  // ===== FINANCIAL SNAPSHOT (migration 058 — §4.1 of shipstation-flow-refactor-plan.md) =====
  // Populated by OMS→WMS sync (Group B). WMS owns these values once set.
  // Defaults are zero / 'USD' until sync lands; no backfill in this commit.
  amountPaidCents: bigint("amount_paid_cents", { mode: "number" }).notNull().default(0),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
  shippingCents: bigint("shipping_cents", { mode: "number" }).notNull().default(0),
  discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
  totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),

  // ===== TIMESTAMPS =====
  orderPlacedAt: timestamp("order_placed_at"), // When placed in channel
  shopifyCreatedAt: timestamp("shopify_created_at"), // Legacy
  createdAt: timestamp("created_at").defaultNow().notNull(),
  startedAt: timestamp("started_at"), // Picking started
  completedAt: timestamp("completed_at"), // Picking completed
  trackingNumber: varchar("tracking_number", { length: 200 }), // Tracking number from shipping carrier
  updatedAt: timestamp("updated_at").defaultNow().notNull(),

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

export const orderItems = wmsSchema.table("order_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),

  // ===== CHANNEL LINKAGE =====
  // Links to source raw tables for full line item data (pricing, properties, etc.)
  omsOrderLineId: integer("oms_order_line_id"),
  shopifyLineItemId: varchar("shopify_line_item_id", { length: 50 }), // Legacy
  sourceItemId: varchar("source_item_id", { length: 100 }), // ID in source table for JOIN lookups

  // ===== PRODUCT (for picking display) =====
  productId: integer("product_id"), // Optional link to products for analytics (nullable - doesn't affect order creation)
  sku: varchar("sku", { length: 100 }).notNull(),
  name: text("name").notNull(),
  imageUrl: text("image_url"),
  barcode: varchar("barcode", { length: 100 }), // For scanner matching

  // ===== QUANTITIES =====
  quantity: integer("quantity").notNull(),
  pickedQuantity: integer("picked_quantity").notNull().default(0),
  fulfilledQuantity: integer("fulfilled_quantity").notNull().default(0), // Shipped to channel

  // ===== PRICING SNAPSHOT (migration 059 — §4.2 of shipstation-flow-refactor-plan.md) =====
  // Populated by OMS→WMS sync (Group B) from oms.oms_order_lines (oms.schema.ts:109-110).
  // WMS owns these values once set; ShipStation push reads unitPriceCents as SS unitPrice.
  // Defaults are zero until sync lands; no backfill in this commit.
  unitPriceCents: bigint("unit_price_cents", { mode: "number" }).notNull().default(0),
  paidPriceCents: bigint("paid_price_cents", { mode: "number" }).notNull().default(0),
  totalPriceCents: bigint("total_price_cents", { mode: "number" }).notNull().default(0),

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
// WMS SHADOW TABLES (Namespace wms.*) [ALIASED]
// ============================================

export const wmsOrders = orders;
export const insertWmsOrderSchema = insertOrderSchema;
export type InsertWmsOrder = InsertOrder;
export type WmsOrder = Order;

export const wmsOrderItems = orderItems;
export const insertWmsOrderItemSchema = insertOrderItemSchema;
export type InsertWmsOrderItem = InsertOrderItem;
export type WmsOrderItem = OrderItem;

// ============================================
// PICKING LOGS (Audit Trail)
// ============================================

// Picking logs table for full audit trail
export const pickingLogs = wmsSchema.table("picking_logs", {
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
// COMBINED ORDER GROUPS
// ============================================

// Combined Order Groups - for picking/shipping multiple orders together.
// Groups are always scoped to a single warehouse — orders from different
// warehouses cannot combine (no transship at pick time).
export const combinedOrderGroups = wmsSchema.table("combined_order_groups", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

  // Identification
  groupCode: varchar("group_code", { length: 20 }).notNull().unique(), // e.g., "G-1024" based on parent order

  // Warehouse scope — every combined group belongs to exactly one warehouse.
  // Nullable for migration tolerance (old rows pre-backfill), but new rows must set it.
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),

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

// Shipments - tracks fulfillment from warehouse through carrier delivery.
//
// Plan reference: shipstation-flow-refactor-plan.md §2 (invariant #3 —
// shipment is a first-class entity), §4.3, §6 Group A Commit 4.
//
// The `status` column is backed by the PG enum `wms.shipment_status`
// (created in migration 060). Drizzle does not natively map PG enum
// types, so we keep the TS column type as varchar(20) here and narrow to
// the `ShipmentStatus` union (from shared/enums/order-status.ts) at the
// application layer. The full enum set is:
//   planned, queued, labeled, shipped,
//   on_hold, voided, cancelled, returned, lost
export const outboundShipments = wmsSchema.table("outbound_shipments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").references(() => orders.id),
  channelId: integer("channel_id").references(() => channels.id),
  externalFulfillmentId: varchar("external_fulfillment_id", { length: 200 }), // Shopify fulfillment ID or external reference
  source: varchar("source", { length: 30 }).notNull().default("shopify_webhook"), // shopify_webhook, manual, api
  // DB-level enum: wms.shipment_status. See header comment above for values.
  status: varchar("status", { length: 20 }).notNull().default("planned"),
  carrier: varchar("carrier", { length: 100 }),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  trackingUrl: text("tracking_url"),
  shippedAt: timestamp("shipped_at"),
  deliveredAt: timestamp("delivered_at"),

  // Shipping costs (for dropship invoicing & profitability)
  carrierCostCents: bigint("carrier_cost_cents", { mode: "number" }).default(0), // Actual carrier charge
  dunnageCostCents: bigint("dunnage_cost_cents", { mode: "number" }).default(0), // Packaging materials
  // totalShippingCostCents computed column added via migration

  // ===== SHIPSTATION ↔ SHOPIFY LINKAGE =====
  // Canonical pointers to the shipment's external-system counterparts.
  // Added by migration 060 (§4.3). Populated by Group C (SS push) and
  // Group E (Shopify fulfillment push) respectively.
  shipstationOrderId: integer("shipstation_order_id"),
  shipstationOrderKey: varchar("shipstation_order_key", { length: 100 }),
  shopifyFulfillmentId: varchar("shopify_fulfillment_id", { length: 100 }),

  // ===== OPS REVIEW FLAGS =====
  // Set when the shipment needs warehouse-ops attention (e.g. customer
  // cancel arrived after the label was printed, or the ship-to address
  // changed post-label). Added by migration 060 (§4.3).
  requiresReview: boolean("requires_review").notNull().default(false),
  reviewReason: varchar("review_reason", { length: 100 }),
  addressChangedAfterLabel: boolean("address_changed_after_label").notNull().default(false),

  // ===== LIFECYCLE TIMESTAMPS =====
  // Stamped on the state-machine transitions defined in §2.4. Added by
  // migration 060 (§4.3). `lastReconciledAt` is set by the hourly
  // reconcile sweep (Group F).
  voidedAt: timestamp("voided_at"),
  voidedReason: varchar("voided_reason", { length: 200 }),
  onHoldReason: varchar("on_hold_reason", { length: 200 }),
  cancelledAt: timestamp("cancelled_at"),
  returnedAt: timestamp("returned_at"),
  lastReconciledAt: timestamp("last_reconciled_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertOutboundShipmentSchema = createInsertSchema(outboundShipments).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOutboundShipment = z.infer<typeof insertOutboundShipmentSchema>;
export type OutboundShipment = typeof outboundShipments.$inferSelect;

// Shipment items - individual items within a shipment
export const outboundShipmentItems = wmsSchema.table("outbound_shipment_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  shipmentId: integer("shipment_id").notNull().references(() => outboundShipments.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").references(() => orderItems.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  qty: integer("qty").notNull().default(1),
  fromLocationId: integer("from_location_id").references(() => warehouseLocations.id), // which bin it was picked from
  boxId: varchar("box_id", { length: 100 }), // WMS Cartonization assigned box
  weightOz: integer("weight_oz"), // Actual picked weight
  trackingId: varchar("tracking_id", { length: 200 }), // Package tracking num if split into multiple tracking nums
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOutboundShipmentItemSchema = createInsertSchema(outboundShipmentItems).omit({
  id: true,
  createdAt: true,
});

export type InsertOutboundShipmentItem = z.infer<typeof insertOutboundShipmentItemSchema>;
export type OutboundShipmentItem = typeof outboundShipmentItems.$inferSelect;



