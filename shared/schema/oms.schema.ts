/**
 * OMS (Order Management System) Schema
 *
 * Unified, channel-agnostic order model for Echelon.
 * All channels (Shopify, eBay, Amazon, etc.) normalize into these tables.
 * The existing WMS pick/pack/ship flow (orders, order_items) is NOT modified.
 */

import { pgTable, varchar, integer, bigint, timestamp, jsonb, text, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { channels } from "./channels.schema";
import { productVariants } from "./catalog.schema";
import { warehouses } from "./warehouse.schema";

// ============================================
// OMS ORDERS — Unified order header
// ============================================

export const omsOrders = pgTable("oms_orders", {
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

  // Totals (cents)
  subtotalCents: integer("subtotal_cents").notNull().default(0),
  shippingCents: integer("shipping_cents").notNull().default(0),
  taxCents: integer("tax_cents").notNull().default(0),
  discountCents: integer("discount_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
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

export const omsOrderLines = pgTable("oms_order_lines", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  orderId: bigint("order_id", { mode: "number" }).notNull().references(() => omsOrders.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  externalLineItemId: varchar("external_line_item_id", { length: 100 }),
  sku: varchar("sku", { length: 100 }),
  title: varchar("title", { length: 300 }),
  variantTitle: varchar("variant_title", { length: 200 }),
  quantity: integer("quantity").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull().default(0),
  totalCents: integer("total_cents").notNull().default(0),
  taxCents: integer("tax_cents").notNull().default(0),
  discountCents: integer("discount_cents").notNull().default(0),
  fulfillmentStatus: varchar("fulfillment_status", { length: 30 }).default("unfulfilled"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
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

export const omsOrderEvents = pgTable("oms_order_events", {
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
