import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

import { productVariants } from "./catalog.schema";
import { omsOrderLines, omsOrders, omsSchema } from "./oms.schema";
import {
  orderItems,
  orders,
  outboundShipmentItems,
  outboundShipments,
  wmsSchema,
} from "./orders.schema";
import { warehouses } from "./warehouse.schema";

export const fulfillmentPlanStatusValues = ["active", "superseded", "cancelled"] as const;
export const fulfillmentPlanLineStatusValues = [
  "planned",
  "partially_shipped",
  "shipped",
  "cancelled",
  "shorted",
] as const;
export const shipmentRequestStatusValues = [
  "planned",
  "queued",
  "accepted",
  "cancelled",
  "shipped",
  "review",
] as const;
export const physicalShipmentStatusValues = ["shipped", "voided", "returned", "review"] as const;
export const channelFulfillmentPushStatusValues = [
  "pending",
  "success",
  "failed",
  "ignored",
  "review",
] as const;

export type FulfillmentPlanStatus = typeof fulfillmentPlanStatusValues[number];
export type FulfillmentPlanLineStatus = typeof fulfillmentPlanLineStatusValues[number];
export type ShipmentRequestStatus = typeof shipmentRequestStatusValues[number];
export type PhysicalShipmentStatus = typeof physicalShipmentStatusValues[number];
export type ChannelFulfillmentPushStatus = typeof channelFulfillmentPushStatusValues[number];

export const fulfillmentPlans = wmsSchema.table("fulfillment_plans", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).notNull().references(() => omsOrders.id, { onDelete: "cascade" }),
  wmsOrderId: integer("wms_order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  planStatus: varchar("plan_status", { length: 30 }).notNull().default("active"),
  plannerVersion: varchar("planner_version", { length: 80 }).notNull().default("canonical-v1-shadow"),
  supersededByPlanId: bigint("superseded_by_plan_id", { mode: "number" }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_fulfillment_plans_active_wms_order")
    .on(table.wmsOrderId)
    .where(sql`${table.planStatus} = 'active'`),
  index("idx_fulfillment_plans_oms_order").on(table.omsOrderId),
]);

export const fulfillmentPlanLines = wmsSchema.table("fulfillment_plan_lines", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  fulfillmentPlanId: bigint("fulfillment_plan_id", { mode: "number" }).notNull().references(() => fulfillmentPlans.id, { onDelete: "cascade" }),
  omsOrderLineId: bigint("oms_order_line_id", { mode: "number" }).notNull().references(() => omsOrderLines.id, { onDelete: "restrict" }),
  wmsOrderItemId: integer("wms_order_item_id").notNull().references(() => orderItems.id, { onDelete: "restrict" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }).notNull(),
  quantityPlanned: integer("quantity_planned").notNull(),
  quantityCancelled: integer("quantity_cancelled").notNull().default(0),
  quantityShipped: integer("quantity_shipped").notNull().default(0),
  lineStatus: varchar("line_status", { length: 30 }).notNull().default("planned"),
  authoritySnapshot: jsonb("authority_snapshot").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("fulfillment_plan_lines_unique_oms_line").on(table.fulfillmentPlanId, table.omsOrderLineId),
  index("idx_fulfillment_plan_lines_wms_item").on(table.wmsOrderItemId),
]);

export const shipmentRequests = wmsSchema.table("shipment_requests", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  fulfillmentPlanId: bigint("fulfillment_plan_id", { mode: "number" }).notNull().references(() => fulfillmentPlans.id, { onDelete: "cascade" }),
  wmsOrderId: integer("wms_order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
  legacyWmsShipmentId: integer("legacy_wms_shipment_id").references(() => outboundShipments.id, { onDelete: "set null" }),
  requestStatus: varchar("request_status", { length: 30 }).notNull().default("planned"),
  holdReason: varchar("hold_reason", { length: 200 }),
  priorityRank: varchar("priority_rank", { length: 64 }),
  shipToSnapshot: jsonb("ship_to_snapshot").notNull().default({}),
  plannerReason: varchar("planner_reason", { length: 120 }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipment_requests_legacy_unique").on(table.legacyWmsShipmentId),
  index("idx_shipment_requests_plan").on(table.fulfillmentPlanId),
  index("idx_shipment_requests_wms_order").on(table.wmsOrderId),
]);

export const shipmentRequestItems = wmsSchema.table("shipment_request_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).notNull().references(() => shipmentRequests.id, { onDelete: "cascade" }),
  fulfillmentPlanLineId: bigint("fulfillment_plan_line_id", { mode: "number" }).notNull().references(() => fulfillmentPlanLines.id, { onDelete: "restrict" }),
  wmsOrderItemId: integer("wms_order_item_id").notNull().references(() => orderItems.id, { onDelete: "restrict" }),
  legacyWmsShipmentItemId: integer("legacy_wms_shipment_item_id").references(() => outboundShipmentItems.id, { onDelete: "set null" }),
  quantityRequested: integer("quantity_requested").notNull(),
  quantityCancelled: integer("quantity_cancelled").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipment_request_items_unique_plan_line").on(table.shipmentRequestId, table.fulfillmentPlanLineId),
  uniqueIndex("shipment_request_items_legacy_unique").on(table.legacyWmsShipmentItemId),
  index("idx_shipment_request_items_plan_line").on(table.fulfillmentPlanLineId),
]);

export const shippingEngineOrders = wmsSchema.table("shipping_engine_orders", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).notNull().references(() => shipmentRequests.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerOrderId: varchar("provider_order_id", { length: 200 }),
  providerOrderKey: varchar("provider_order_key", { length: 200 }),
  providerStatus: varchar("provider_status", { length: 80 }),
  requestPayloadHash: varchar("request_payload_hash", { length: 128 }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_shipping_engine_orders_provider_order_id")
    .on(table.provider, table.providerOrderId)
    .where(sql`${table.providerOrderId} IS NOT NULL`),
  uniqueIndex("uq_shipping_engine_orders_provider_order_key")
    .on(table.provider, table.providerOrderKey)
    .where(sql`${table.providerOrderKey} IS NOT NULL`),
  index("idx_shipping_engine_orders_request").on(table.shipmentRequestId),
]);

export const physicalShipments = wmsSchema.table("physical_shipments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingEngineOrderId: bigint("shipping_engine_order_id", { mode: "number" }).references(() => shippingEngineOrders.id, { onDelete: "set null" }),
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).notNull().references(() => shipmentRequests.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerPhysicalShipmentId: varchar("provider_physical_shipment_id", { length: 200 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  carrier: varchar("carrier", { length: 100 }),
  serviceCode: varchar("service_code", { length: 100 }),
  shipDate: timestamp("ship_date", { withTimezone: true }),
  status: varchar("status", { length: 30 }).notNull().default("shipped"),
  rawEventHash: varchar("raw_event_hash", { length: 128 }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("physical_shipments_provider_unique").on(table.provider, table.providerPhysicalShipmentId),
  index("idx_physical_shipments_request").on(table.shipmentRequestId),
  index("idx_physical_shipments_tracking")
    .on(table.trackingNumber)
    .where(sql`${table.trackingNumber} IS NOT NULL`),
]);

export const physicalShipmentItems = wmsSchema.table("physical_shipment_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).notNull().references(() => physicalShipments.id, { onDelete: "cascade" }),
  shipmentRequestItemId: bigint("shipment_request_item_id", { mode: "number" }).notNull().references(() => shipmentRequestItems.id, { onDelete: "restrict" }),
  fulfillmentPlanLineId: bigint("fulfillment_plan_line_id", { mode: "number" }).notNull().references(() => fulfillmentPlanLines.id, { onDelete: "restrict" }),
  wmsOrderItemId: integer("wms_order_item_id").notNull().references(() => orderItems.id, { onDelete: "restrict" }),
  quantityShipped: integer("quantity_shipped").notNull(),
  providerPhysicalShipmentLineId: varchar("provider_physical_shipment_line_id", { length: 200 }),
  providerOrderLineId: varchar("provider_order_line_id", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("physical_shipment_items_request_item_unique").on(table.physicalShipmentId, table.shipmentRequestItemId),
  index("idx_physical_shipment_items_plan_line").on(table.fulfillmentPlanLineId),
]);

export const channelFulfillmentPushes = omsSchema.table("channel_fulfillment_pushes", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).notNull().references(() => omsOrders.id, { onDelete: "cascade" }),
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).notNull().references(() => physicalShipments.id, { onDelete: "cascade" }),
  channelProvider: varchar("channel_provider", { length: 40 }).notNull(),
  channelFulfillmentId: varchar("channel_fulfillment_id", { length: 200 }),
  pushStatus: varchar("push_status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastError: text("last_error"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_fulfillment_pushes_unique_physical").on(table.channelProvider, table.physicalShipmentId),
  index("idx_channel_fulfillment_pushes_oms_order").on(table.omsOrderId),
]);

export const channelFulfillmentPushItems = omsSchema.table("channel_fulfillment_push_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channelFulfillmentPushId: bigint("channel_fulfillment_push_id", { mode: "number" }).notNull().references(() => channelFulfillmentPushes.id, { onDelete: "cascade" }),
  omsOrderLineId: bigint("oms_order_line_id", { mode: "number" }).notNull().references(() => omsOrderLines.id, { onDelete: "restrict" }),
  channelOrderLineId: varchar("channel_order_line_id", { length: 200 }),
  quantityPushed: integer("quantity_pushed").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_fulfillment_push_items_unique_line").on(table.channelFulfillmentPushId, table.omsOrderLineId),
  index("idx_channel_fulfillment_push_items_oms_line").on(table.omsOrderLineId),
]);

export const insertFulfillmentPlanSchema = createInsertSchema(fulfillmentPlans).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFulfillmentPlanLineSchema = createInsertSchema(fulfillmentPlanLines).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShipmentRequestSchema = createInsertSchema(shipmentRequests).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShipmentRequestItemSchema = createInsertSchema(shipmentRequestItems).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingEngineOrderSchema = createInsertSchema(shippingEngineOrders).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPhysicalShipmentSchema = createInsertSchema(physicalShipments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPhysicalShipmentItemSchema = createInsertSchema(physicalShipmentItems).omit({ id: true, createdAt: true });
export const insertChannelFulfillmentPushSchema = createInsertSchema(channelFulfillmentPushes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertChannelFulfillmentPushItemSchema = createInsertSchema(channelFulfillmentPushItems).omit({ id: true, createdAt: true });

export type InsertFulfillmentPlan = z.infer<typeof insertFulfillmentPlanSchema>;
export type FulfillmentPlan = typeof fulfillmentPlans.$inferSelect;
export type InsertFulfillmentPlanLine = z.infer<typeof insertFulfillmentPlanLineSchema>;
export type FulfillmentPlanLine = typeof fulfillmentPlanLines.$inferSelect;
export type InsertShipmentRequest = z.infer<typeof insertShipmentRequestSchema>;
export type ShipmentRequest = typeof shipmentRequests.$inferSelect;
export type InsertShipmentRequestItem = z.infer<typeof insertShipmentRequestItemSchema>;
export type ShipmentRequestItem = typeof shipmentRequestItems.$inferSelect;
export type InsertShippingEngineOrder = z.infer<typeof insertShippingEngineOrderSchema>;
export type ShippingEngineOrder = typeof shippingEngineOrders.$inferSelect;
export type InsertPhysicalShipment = z.infer<typeof insertPhysicalShipmentSchema>;
export type PhysicalShipment = typeof physicalShipments.$inferSelect;
export type InsertPhysicalShipmentItem = z.infer<typeof insertPhysicalShipmentItemSchema>;
export type PhysicalShipmentItem = typeof physicalShipmentItems.$inferSelect;
export type InsertChannelFulfillmentPush = z.infer<typeof insertChannelFulfillmentPushSchema>;
export type ChannelFulfillmentPush = typeof channelFulfillmentPushes.$inferSelect;
export type InsertChannelFulfillmentPushItem = z.infer<typeof insertChannelFulfillmentPushItemSchema>;
export type ChannelFulfillmentPushItem = typeof channelFulfillmentPushItems.$inferSelect;
