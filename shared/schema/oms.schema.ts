/**
 * OMS (Order Management System) Schema
 *
 * Unified, channel-agnostic order model for Echelon.
 * All channels (Shopify, eBay, Amazon, etc.) normalize into these tables.
 * The existing WMS pick/pack/ship flow (orders, order_items) is NOT modified.
 */

import { pgTable, varchar, integer, bigint, timestamp, jsonb, text, boolean, uniqueIndex, index, pgSchema, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { channels } from "./channels.schema";
import { productVariants, products } from "./catalog.schema";
import { warehouses } from "./warehouse.schema";
import { orders, orderItems } from "./orders.schema";
import { vendors } from "./procurement.schema";

// Create the explicit PostgreSQL Namespace
export const omsSchema = pgSchema("oms");

// ============================================
// OMS ORDERS — Unified order header
// ============================================

export const omsOrders = omsSchema.table("oms_orders", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  externalOrderId: varchar("external_order_id", { length: 100 }).notNull(),
  externalOrderNumber: varchar("external_order_number", { length: 50 }),

  // Status workflow: pending → confirmed → processing → shipped → delivered → cancelled
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  financialStatus: varchar("financial_status", { length: 30 }).default("paid"),
  fulfillmentStatus: varchar("fulfillment_status", { length: 30 }).default("unfulfilled"),

  // Customer
  customerName: varchar("customer_name", { length: 200 }),
  customerEmail: varchar("customer_email", { length: 200 }),
  customerPhone: varchar("customer_phone", { length: 50 }),

  // Shipping address
  shipToName: varchar("ship_to_name", { length: 200 }),
  shipToAddress1: varchar("ship_to_address1", { length: 300 }),
  shipToAddress2: varchar("ship_to_address2", { length: 300 }),
  shipToCity: varchar("ship_to_city", { length: 100 }),
  shipToState: varchar("ship_to_state", { length: 100 }),
  shipToZip: varchar("ship_to_zip", { length: 20 }),
  shipToCountry: varchar("ship_to_country", { length: 100 }),

  // Delivery SLA & Shipping logic
  shippingMethod: varchar("shipping_method", { length: 200 }), // free-form customer-facing label (do NOT use for routing)
  shippingMethodCode: varchar("shipping_method_code", { length: 100 }), // platform code
  shippingServiceLevel: varchar("shipping_service_level", { length: 20 }).notNull().default("standard"), // normalized: standard | expedited | overnight
  memberPlanName: varchar("member_plan_name", { length: 20 }),
  memberPlanColor: varchar("member_plan_color", { length: 20 }),
  channelShipByDate: timestamp("channel_ship_by_date"), // platform-provided ship-by deadline (eBay shipByDate, etc.)

  // Totals (cents)
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull().default(0),
  shippingCents: bigint("shipping_cents", { mode: "number" }).notNull().default(0),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
  taxExempt: boolean("tax_exempt").default(false),
  discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
  totalCents: bigint("total_cents", { mode: "number" }).notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),

  // Fulfillment
  warehouseId: integer("warehouse_id").references(() => warehouses.id),
  trackingNumber: varchar("tracking_number", { length: 100 }),
  trackingCarrier: varchar("tracking_carrier", { length: 50 }),
  shippedAt: timestamp("shipped_at"),

  // Cancellation / Refund
  cancelledAt: timestamp("cancelled_at"),
  refundedAt: timestamp("refunded_at"),

  // ShipStation integration
  shipstationOrderId: integer("shipstation_order_id"),
  shipstationOrderKey: varchar("shipstation_order_key", { length: 100 }),

  // Member enrichment (historical snapshot for analytics)
  memberTier: varchar("member_tier", { length: 50 }), // Tier at time of order

  // Metadata
  rawPayload: jsonb("raw_payload"),
  notes: text("notes"),
  tags: text("tags"), // stored as JSON array string

  // Timestamps
  orderedAt: timestamp("ordered_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("oms_orders_channel_external_idx").on(table.channelId, table.externalOrderId),
  index("idx_oms_orders_status").on(table.status),
  index("idx_oms_orders_channel").on(table.channelId),
  index("idx_oms_orders_ordered").on(table.orderedAt),
  index("idx_oms_orders_external").on(table.externalOrderId),
]);

export const insertOmsOrderSchema = createInsertSchema(omsOrders).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertOmsOrder = z.infer<typeof insertOmsOrderSchema>;
export type OmsOrder = typeof omsOrders.$inferSelect;

// ============================================
// OMS ORDER LINES — Line items
// ============================================

export const omsOrderLines = omsSchema.table("oms_order_lines", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orderId: bigint("order_id", { mode: "number" }).notNull().references(() => omsOrders.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  externalLineItemId: varchar("external_line_item_id", { length: 100 }),
  externalProductId: varchar("external_product_id", { length: 100 }),
  sku: varchar("sku", { length: 100 }),
  title: varchar("title", { length: 300 }),
  variantTitle: varchar("variant_title", { length: 200 }),
  name: text("name"),
  vendor: varchar("vendor", { length: 200 }),
  quantity: integer("quantity").notNull(),
  paidPriceCents: bigint("paid_price_cents", { mode: "number" }).notNull().default(0),
  totalPriceCents: bigint("total_price_cents", { mode: "number" }).notNull().default(0),
  totalDiscountCents: bigint("total_discount_cents", { mode: "number" }).notNull().default(0),
  planDiscountCents: bigint("plan_discount_cents", { mode: "number" }).notNull().default(0),
  couponDiscountCents: bigint("coupon_discount_cents", { mode: "number" }).notNull().default(0),
  discountAllocations: jsonb("discount_allocations"),
  taxable: boolean("taxable").default(true),
  taxLines: jsonb("tax_lines"),
  requiresShipping: boolean("requires_shipping").default(true),
  giftCard: boolean("gift_card").default(false),
  productExists: boolean("product_exists").default(true),
  fulfillableQuantity: integer("fulfillable_quantity"),
  fulfillmentService: varchar("fulfillment_service", { length: 100 }),
  fulfillmentStatus: varchar("fulfillment_status", { length: 30 }).default("unfulfilled"),
  properties: jsonb("properties"),
  compareAtPriceCents: bigint("compare_at_price_cents", { mode: "number" }),
  orderNumber: varchar("order_number", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("idx_oms_lines_order").on(table.orderId),
  index("idx_oms_lines_variant").on(table.productVariantId),
]);

export const insertOmsOrderLineSchema = createInsertSchema(omsOrderLines).omit({
  id: true,
  createdAt: true,
});

export type InsertOmsOrderLine = z.infer<typeof insertOmsOrderLineSchema>;
export type OmsOrderLine = typeof omsOrderLines.$inferSelect;

// ============================================
// OMS ORDER EVENTS — Audit trail
// ============================================

export const omsOrderEvents = omsSchema.table("oms_order_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orderId: bigint("order_id", { mode: "number" }).notNull().references(() => omsOrders.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 50 }).notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("idx_oms_events_order").on(table.orderId),
]);

export const insertOmsOrderEventSchema = createInsertSchema(omsOrderEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertOmsOrderEvent = z.infer<typeof insertOmsOrderEventSchema>;
export type OmsOrderEvent = typeof omsOrderEvents.$inferSelect;

// ============================================
// FULFILLMENT ROUTING RULES
// ============================================

export const fulfillmentRoutingRules = omsSchema.table("fulfillment_routing_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").references(() => channels.id, { onDelete: "cascade" }),
  matchType: varchar("match_type", { length: 20 }).notNull(),
  matchValue: varchar("match_value", { length: 255 }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0),
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

// ============================================================================
// ORDER ITEM COSTS — COGS per shipment calculation
// ============================================================================

export const orderItemCosts = omsSchema.table("order_item_costs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
  inventoryLotId: integer("inventory_lot_id").notNull(), 
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  qty: integer("qty").notNull(), 
  unitCostCents: bigint("unit_cost_cents", { mode: "number" }).notNull(), 
  totalCostCents: bigint("total_cost_cents", { mode: "number" }).notNull(), 
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrderItemCostSchema = createInsertSchema(orderItemCosts).omit({
  id: true,
  createdAt: true,
});

export type InsertOrderItemCost = z.infer<typeof insertOrderItemCostSchema>;
export type OrderItemCost = typeof orderItemCosts.$inferSelect;

// ============================================================================
// ORDER ITEM FINANCIALS — Contribution profit per shipped line item
// ============================================================================

export const orderItemFinancials = omsSchema.table("order_item_financials", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }),
  productName: text("product_name"),
  qtyShipped: integer("qty_shipped").notNull(),
  revenueCents: bigint("revenue_cents", { mode: "number" }).notNull(),
  cogsCents: bigint("cogs_cents", { mode: "number" }).notNull(),
  grossProfitCents: bigint("gross_profit_cents", { mode: "number" }).notNull(),
  marginPercent: numeric("margin_percent", { precision: 5, scale: 2 }),
  avgSellingPriceCents: bigint("avg_selling_price_cents", { mode: "number" }),
  avgUnitCostCents: bigint("avg_unit_cost_cents", { mode: "number" }),
  vendorId: integer("vendor_id").references(() => vendors.id, { onDelete: "set null" }),
  channelId: integer("channel_id").references(() => channels.id, { onDelete: "set null" }),
  shippedAt: timestamp("shipped_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertOrderItemFinancialSchema = createInsertSchema(orderItemFinancials).omit({
  id: true,
  createdAt: true,
});

export type InsertOrderItemFinancial = z.infer<typeof insertOrderItemFinancialSchema>;
export type OrderItemFinancial = typeof orderItemFinancials.$inferSelect;

// ============================================================================
// WEBHOOK RETRY QUEUE
// ============================================================================

export const webhookRetryQueue = omsSchema.table("webhook_retry_queue", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  provider: varchar("provider", { length: 50 }).notNull(), // 'shopify', 'ebay', 'shipstation'
  topic: varchar("topic", { length: 100 }).notNull(),
  payload: jsonb("payload").notNull(),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
  status: varchar("status", { length: 20 }).notNull().default('pending'), // 'pending', 'dead', 'success'
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => {
  return {
    statusNextRetryIdx: index("idx_webhook_retry_queue_status_next_retry").on(table.status, table.nextRetryAt).where(sql`status = 'pending'`),
  };
});

export const insertWebhookRetryQueueSchema = createInsertSchema(webhookRetryQueue).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWebhookRetryQueue = z.infer<typeof insertWebhookRetryQueueSchema>;
export type WebhookRetryQueue = typeof webhookRetryQueue.$inferSelect;
