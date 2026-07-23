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
import { channels } from "./channels.schema";
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
export const shippingProviderLabelStatusValues = ["active", "voided", "superseded", "unknown"] as const;
export const carrierTrackingSubscriptionStatusValues = [
  "pending",
  "processing",
  "active",
  "retry",
  "review",
] as const;
export const carrierTrackingSubscriptionAttemptOutcomeValues = [
  "activated",
  "retry_scheduled",
  "review_required",
] as const;
export const carrierTrackingWebhookHydrationStatusValues = [
  "pending",
  "processing",
  "retry",
  "complete",
  "review",
] as const;
export const carrierTrackingWebhookHydrationAttemptOutcomeValues = [
  "hydrated",
  "retry_scheduled",
  "review_required",
] as const;
export const carrierTrackingStatusValues = [
  "unknown",
  "pre_transit",
  "accepted",
  "in_transit",
  "delivered",
  "exception",
  "delivery_attempt",
  "delivered_to_service_point",
] as const;
export const carrierDispatchEvidenceValues = ["confirmed", "not_confirmed", "review"] as const;
export const carrierTrackingMatchStatusValues = [
  "matched",
  "unmatched",
  "ambiguous",
  "voided_label",
  "review",
] as const;
export const channelFulfillmentPushStatusValues = [
  "pending",
  "processing",
  "retry",
  "success",
  "failed",
  "ignored",
  "review",
  "dead",
] as const;
export const shippingEngineOrderRequestRelationshipValues = [
  "primary",
  "combined",
  "split",
  "reconciled",
] as const;
export const channelFulfillmentPushAttemptOutcomeValues = [
  "success",
  "retry_scheduled",
  "ignored",
  "review_required",
  "dead_lettered",
] as const;
export const channelFulfillmentReceiptStatusValues = [
  "pending",
  "processed",
  "ignored",
  "review",
] as const;

export type FulfillmentPlanStatus = typeof fulfillmentPlanStatusValues[number];
export type FulfillmentPlanLineStatus = typeof fulfillmentPlanLineStatusValues[number];
export type ShipmentRequestStatus = typeof shipmentRequestStatusValues[number];
export type PhysicalShipmentStatus = typeof physicalShipmentStatusValues[number];
export type ShippingProviderLabelStatus = typeof shippingProviderLabelStatusValues[number];
export type CarrierTrackingSubscriptionStatus = typeof carrierTrackingSubscriptionStatusValues[number];
export type CarrierTrackingSubscriptionAttemptOutcome = typeof carrierTrackingSubscriptionAttemptOutcomeValues[number];
export type CarrierTrackingWebhookHydrationStatus = typeof carrierTrackingWebhookHydrationStatusValues[number];
export type CarrierTrackingWebhookHydrationAttemptOutcome = typeof carrierTrackingWebhookHydrationAttemptOutcomeValues[number];
export type CarrierTrackingStatus = typeof carrierTrackingStatusValues[number];
export type CarrierDispatchEvidence = typeof carrierDispatchEvidenceValues[number];
export type CarrierTrackingMatchStatus = typeof carrierTrackingMatchStatusValues[number];
export type ChannelFulfillmentPushStatus = typeof channelFulfillmentPushStatusValues[number];
export type ShippingEngineOrderRequestRelationship = typeof shippingEngineOrderRequestRelationshipValues[number];
export type ChannelFulfillmentPushAttemptOutcome = typeof channelFulfillmentPushAttemptOutcomeValues[number];
export type ChannelFulfillmentReceiptStatus = typeof channelFulfillmentReceiptStatusValues[number];

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
  // Compatibility pointer for legacy one-request provider orders. The join
  // table below is authoritative because a provider order may combine requests.
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).references(() => shipmentRequests.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  commandKey: varchar("command_key", { length: 300 }).notNull(),
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
  uniqueIndex("uq_shipping_engine_orders_command_key").on(table.provider, table.commandKey),
  index("idx_shipping_engine_orders_request").on(table.shipmentRequestId),
]);

export const shippingEngineOrderRequests = wmsSchema.table("shipping_engine_order_requests", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingEngineOrderId: bigint("shipping_engine_order_id", { mode: "number" }).notNull().references(() => shippingEngineOrders.id, { onDelete: "restrict" }),
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).notNull().references(() => shipmentRequests.id, { onDelete: "restrict" }),
  relationshipType: varchar("relationship_type", { length: 30 }).notNull().default("primary"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_engine_order_requests_unique").on(table.shippingEngineOrderId, table.shipmentRequestId),
  index("idx_shipping_engine_order_requests_request").on(table.shipmentRequestId, table.shippingEngineOrderId),
]);

export const physicalShipments = wmsSchema.table("physical_shipments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingEngineOrderId: bigint("shipping_engine_order_id", { mode: "number" }).references(() => shippingEngineOrders.id, { onDelete: "restrict" }),
  // Compatibility pointer only. Package ownership is derived from the exact
  // request-item allocations in physical_shipment_items.
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).references(() => shipmentRequests.id, { onDelete: "set null" }),
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
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).notNull().references(() => physicalShipments.id, { onDelete: "restrict" }),
  shipmentRequestItemId: bigint("shipment_request_item_id", { mode: "number" }).references(() => shipmentRequestItems.id, { onDelete: "restrict" }),
  fulfillmentPlanLineId: bigint("fulfillment_plan_line_id", { mode: "number" }).references(() => fulfillmentPlanLines.id, { onDelete: "restrict" }),
  wmsOrderItemId: integer("wms_order_item_id").references(() => orderItems.id, { onDelete: "restrict" }),
  legacyWmsShipmentItemId: integer("legacy_wms_shipment_item_id").references(() => outboundShipmentItems.id, { onDelete: "restrict" }),
  shipmentItemPurpose: varchar("shipment_item_purpose", { length: 30 }).notNull().default("customer_fulfillment"),
  replacementForOrderItemId: integer("replacement_for_order_item_id").references(() => orderItems.id, { onDelete: "restrict" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  sku: varchar("sku", { length: 100 }).notNull(),
  quantityShipped: integer("quantity_shipped").notNull(),
  providerPhysicalShipmentLineId: varchar("provider_physical_shipment_line_id", { length: 200 }),
  providerOrderLineId: varchar("provider_order_line_id", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("physical_shipment_items_request_item_unique").on(table.physicalShipmentId, table.shipmentRequestItemId),
  uniqueIndex("uq_physical_shipment_items_legacy_item")
    .on(table.legacyWmsShipmentItemId)
    .where(sql`${table.legacyWmsShipmentItemId} IS NOT NULL`),
  index("idx_physical_shipment_items_plan_line").on(table.fulfillmentPlanLineId),
  index("idx_physical_shipment_items_replacement_line")
    .on(table.replacementForOrderItemId)
    .where(sql`${table.replacementForOrderItemId} IS NOT NULL`),
]);

export const shippingProviderLabels = wmsSchema.table("shipping_provider_labels", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerLabelId: varchar("provider_label_id", { length: 200 }).notNull(),
  providerOrderId: varchar("provider_order_id", { length: 200 }),
  providerOrderKey: varchar("provider_order_key", { length: 200 }),
  trackingNumber: varchar("tracking_number", { length: 200 }).notNull(),
  normalizedTrackingNumber: varchar("normalized_tracking_number", { length: 200 }).notNull(),
  labelStatus: varchar("label_status", { length: 30 }).notNull().default("unknown"),
  carrier: varchar("carrier", { length: 100 }),
  serviceCode: varchar("service_code", { length: 100 }),
  labelCreatedAt: timestamp("label_created_at", { withTimezone: true }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
  lastLinkReconciledAt: timestamp("last_link_reconciled_at", { withTimezone: true }),
  nextLinkReconcileAt: timestamp("next_link_reconcile_at", { withTimezone: true }),
  linkReconcileAttempts: integer("link_reconcile_attempts").notNull().default(0),
  source: varchar("source", { length: 50 }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_shipping_provider_labels_provider_label")
    .on(table.provider, table.providerLabelId),
  index("idx_shipping_provider_labels_tracking").on(table.provider, table.normalizedTrackingNumber),
  index("idx_shipping_provider_labels_status_observed").on(table.labelStatus, table.firstObservedAt),
  index("idx_shipping_provider_labels_link_reconcile")
    .on(table.nextLinkReconcileAt, table.lastLinkReconciledAt),
]);

export const shippingProviderLabelLinks = wmsSchema.table("shipping_provider_label_links", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" }).notNull().references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).references(() => shipmentRequests.id, { onDelete: "restrict" }),
  shippingEngineOrderId: bigint("shipping_engine_order_id", { mode: "number" }).references(() => shippingEngineOrders.id, { onDelete: "restrict" }),
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).references(() => physicalShipments.id, { onDelete: "restrict" }),
  legacyWmsShipmentId: integer("legacy_wms_shipment_id").references(() => outboundShipments.id, { onDelete: "restrict" }),
  source: varchar("source", { length: 50 }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_shipping_provider_label_links_request")
    .on(table.shippingProviderLabelId, table.shipmentRequestId)
    .where(sql`${table.shipmentRequestId} IS NOT NULL`),
  uniqueIndex("uq_shipping_provider_label_links_engine_order")
    .on(table.shippingProviderLabelId, table.shippingEngineOrderId)
    .where(sql`${table.shippingEngineOrderId} IS NOT NULL`),
  uniqueIndex("uq_shipping_provider_label_links_physical")
    .on(table.shippingProviderLabelId, table.physicalShipmentId)
    .where(sql`${table.physicalShipmentId} IS NOT NULL`),
  uniqueIndex("uq_shipping_provider_label_links_legacy")
    .on(table.shippingProviderLabelId, table.legacyWmsShipmentId)
    .where(sql`${table.legacyWmsShipmentId} IS NOT NULL`),
  index("idx_shipping_provider_label_links_label").on(table.shippingProviderLabelId),
]);

export const shippingProviderLabelEvents = wmsSchema.table("shipping_provider_label_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" }).notNull().references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  eventHash: varchar("event_hash", { length: 64 }).notNull(),
  eventType: varchar("event_type", { length: 40 }).notNull(),
  labelStatus: varchar("label_status", { length: 30 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }).notNull(),
  providerOccurredAt: timestamp("provider_occurred_at", { withTimezone: true }),
  sanitizedPayload: jsonb("sanitized_payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("uq_shipping_provider_label_events_hash")
    .on(table.shippingProviderLabelId, table.eventHash),
  index("idx_shipping_provider_label_events_label")
    .on(table.shippingProviderLabelId, table.receivedAt),
]);

export const carrierTrackingSubscriptions = wmsSchema.table("carrier_tracking_subscriptions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  trackingProvider: varchar("tracking_provider", { length: 40 }).notNull(),
  carrierCode: varchar("carrier_code", { length: 100 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }).notNull(),
  normalizedTrackingNumber: varchar("normalized_tracking_number", { length: 200 }).notNull(),
  subscriptionStatus: varchar("subscription_status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  leaseOwner: varchar("lease_owner", { length: 200 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: text("last_error_message"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_subscriptions_identity")
    .on(table.trackingProvider, table.carrierCode, table.normalizedTrackingNumber),
  index("idx_carrier_tracking_subscriptions_due")
    .on(table.nextAttemptAt, table.leaseExpiresAt, table.id),
  index("idx_carrier_tracking_subscriptions_status")
    .on(table.subscriptionStatus, table.updatedAt),
]);

export const carrierTrackingSubscriptionLabels = wmsSchema.table("carrier_tracking_subscription_labels", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierTrackingSubscriptionId: bigint("carrier_tracking_subscription_id", { mode: "number" }).notNull().references(() => carrierTrackingSubscriptions.id, { onDelete: "restrict" }),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" }).notNull().references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  source: varchar("source", { length: 50 }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_subscription_labels")
    .on(table.carrierTrackingSubscriptionId, table.shippingProviderLabelId),
  index("idx_carrier_tracking_subscription_labels_label")
    .on(table.shippingProviderLabelId),
]);

export const carrierTrackingSubscriptionAttempts = wmsSchema.table("carrier_tracking_subscription_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierTrackingSubscriptionId: bigint("carrier_tracking_subscription_id", { mode: "number" }).notNull().references(() => carrierTrackingSubscriptions.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  attemptOutcome: varchar("attempt_outcome", { length: 30 }).notNull(),
  httpStatus: integer("http_status"),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  requestEvidence: jsonb("request_evidence").notNull(),
  responseEvidence: jsonb("response_evidence").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_subscription_attempts_number")
    .on(table.carrierTrackingSubscriptionId, table.attemptNumber),
  index("idx_carrier_tracking_subscription_attempts_subscription")
    .on(table.carrierTrackingSubscriptionId, table.attemptNumber),
]);

export const carrierTrackingEvents = wmsSchema.table("carrier_tracking_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  provider: varchar("provider", { length: 40 }).notNull(),
  eventHash: varchar("event_hash", { length: 64 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }).notNull(),
  normalizedTrackingNumber: varchar("normalized_tracking_number", { length: 200 }).notNull(),
  providerLabelId: varchar("provider_label_id", { length: 200 }),
  carrier: varchar("carrier", { length: 100 }),
  providerStatusCode: varchar("provider_status_code", { length: 30 }).notNull(),
  providerStatusDetailCode: varchar("provider_status_detail_code", { length: 100 }),
  providerCarrierStatusCode: varchar("provider_carrier_status_code", { length: 100 }),
  providerCarrierDetailCode: varchar("provider_carrier_detail_code", { length: 100 }),
  canonicalStatus: varchar("canonical_status", { length: 40 }).notNull(),
  dispatchEvidence: varchar("dispatch_evidence", { length: 30 }).notNull(),
  statusDescription: text("status_description"),
  carrierStatusDescription: text("carrier_status_description"),
  eventOccurredAt: timestamp("event_occurred_at", { withTimezone: true }),
  eventTimeSource: varchar("event_time_source", { length: 30 }).notNull(),
  estimatedDeliveryAt: timestamp("estimated_delivery_at", { withTimezone: true }),
  actualDeliveryAt: timestamp("actual_delivery_at", { withTimezone: true }),
  sanitizedPayload: jsonb("sanitized_payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_events_provider_hash").on(table.provider, table.eventHash),
  index("idx_carrier_tracking_events_tracking").on(table.provider, table.normalizedTrackingNumber, table.receivedAt),
  index("idx_carrier_tracking_events_dispatch").on(table.dispatchEvidence, table.receivedAt),
]);

export const carrierTrackingWebhookReceipts = wmsSchema.table("carrier_tracking_webhook_receipts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  provider: varchar("provider", { length: 40 }).notNull(),
  receiptHash: varchar("receipt_hash", { length: 64 }).notNull(),
  signatureAlgorithm: varchar("signature_algorithm", { length: 30 }).notNull(),
  signatureKeyId: varchar("signature_key_id", { length: 500 }).notNull(),
  signatureTimestampRaw: varchar("signature_timestamp_raw", { length: 100 }).notNull(),
  signatureTimestampAt: timestamp("signature_timestamp_at", { withTimezone: true }).notNull(),
  rawBodyBase64: text("raw_body_base64").notNull(),
  rawBodyHash: varchar("raw_body_hash", { length: 64 }).notNull(),
  signatureBase64: text("signature_base64").notNull(),
  signatureHash: varchar("signature_hash", { length: 64 }).notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_webhook_receipts_provider_hash")
    .on(table.provider, table.receiptHash),
  index("idx_carrier_tracking_webhook_receipts_verified")
    .on(table.provider, table.verifiedAt),
]);

export const carrierTrackingWebhookReceiptParses = wmsSchema.table("carrier_tracking_webhook_receipt_parses", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierTrackingWebhookReceiptId: bigint("carrier_tracking_webhook_receipt_id", { mode: "number" }).notNull().references(() => carrierTrackingWebhookReceipts.id, { onDelete: "restrict" }),
  carrierTrackingEventId: bigint("carrier_tracking_event_id", { mode: "number" }).references(() => carrierTrackingEvents.id, { onDelete: "restrict" }),
  attemptHash: varchar("attempt_hash", { length: 64 }).notNull(),
  parserVersion: varchar("parser_version", { length: 100 }).notNull(),
  outcome: varchar("outcome", { length: 30 }).notNull(),
  reasonCode: varchar("reason_code", { length: 100 }).notNull(),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_webhook_receipt_parses_attempt")
    .on(table.carrierTrackingWebhookReceiptId, table.attemptHash),
  index("idx_carrier_tracking_webhook_receipt_parses_receipt")
    .on(table.carrierTrackingWebhookReceiptId, table.createdAt),
  index("idx_carrier_tracking_webhook_receipt_parses_event")
    .on(table.carrierTrackingEventId, table.createdAt),
]);

export const carrierTrackingWebhookHydrations = wmsSchema.table("carrier_tracking_webhook_hydrations", {
  carrierTrackingWebhookReceiptId: bigint("carrier_tracking_webhook_receipt_id", { mode: "number" }).primaryKey().references(() => carrierTrackingWebhookReceipts.id, { onDelete: "restrict" }),
  resourceUrl: text("resource_url").notNull(),
  carrierCode: varchar("carrier_code", { length: 100 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }).notNull(),
  normalizedTrackingNumber: varchar("normalized_tracking_number", { length: 200 }).notNull(),
  hydrationStatus: varchar("hydration_status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  hydratedAt: timestamp("hydrated_at", { withTimezone: true }),
  leaseOwner: varchar("lease_owner", { length: 200 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: text("last_error_message"),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_carrier_tracking_webhook_hydrations_due")
    .on(table.nextAttemptAt, table.leaseExpiresAt),
  index("idx_carrier_tracking_webhook_hydrations_status")
    .on(table.hydrationStatus, table.updatedAt),
]);

export const carrierTrackingWebhookHydrationAttempts = wmsSchema.table("carrier_tracking_webhook_hydration_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierTrackingWebhookReceiptId: bigint("carrier_tracking_webhook_receipt_id", { mode: "number" }).notNull().references(() => carrierTrackingWebhookReceipts.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  attemptOutcome: varchar("attempt_outcome", { length: 30 }).notNull(),
  httpStatus: integer("http_status"),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  requestEvidence: jsonb("request_evidence").notNull(),
  responseEvidence: jsonb("response_evidence").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_webhook_hydration_attempts_number")
    .on(table.carrierTrackingWebhookReceiptId, table.attemptNumber),
  index("idx_carrier_tracking_webhook_hydration_attempts_receipt")
    .on(table.carrierTrackingWebhookReceiptId, table.attemptNumber),
]);

export const carrierTrackingEventMatches = wmsSchema.table("carrier_tracking_event_matches", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierTrackingEventId: bigint("carrier_tracking_event_id", { mode: "number" }).notNull().references(() => carrierTrackingEvents.id, { onDelete: "restrict" }),
  attemptHash: varchar("attempt_hash", { length: 64 }).notNull(),
  matchStatus: varchar("match_status", { length: 30 }).notNull(),
  candidateCount: integer("candidate_count").notNull(),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" }).references(() => shippingProviderLabels.id, { onDelete: "set null" }),
  reasonCode: varchar("reason_code", { length: 100 }).notNull(),
  evidence: jsonb("evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_event_matches_attempt").on(table.carrierTrackingEventId, table.attemptHash),
  index("idx_carrier_tracking_event_matches_event").on(table.carrierTrackingEventId, table.createdAt),
  index("idx_carrier_tracking_event_matches_status").on(table.matchStatus, table.createdAt),
]);

export const carrierTrackingReconciliationState = wmsSchema.table("carrier_tracking_reconciliation_state", {
  carrierTrackingEventId: bigint("carrier_tracking_event_id", { mode: "number" }).primaryKey().references(() => carrierTrackingEvents.id, { onDelete: "restrict" }),
  lastMatchAttemptId: bigint("last_match_attempt_id", { mode: "number" }).notNull().references(() => carrierTrackingEventMatches.id, { onDelete: "restrict" }),
  lastMatchAttemptHash: varchar("last_match_attempt_hash", { length: 64 }).notNull(),
  lastMatchStatus: varchar("last_match_status", { length: 30 }).notNull(),
  lastCandidateCount: integer("last_candidate_count").notNull(),
  lastReconciledAt: timestamp("last_reconciled_at", { withTimezone: true }).notNull(),
  nextReconcileAt: timestamp("next_reconcile_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("idx_carrier_tracking_reconciliation_state_due")
    .on(table.nextReconcileAt, table.lastReconciledAt),
]);

export const channelFulfillmentPushes = omsSchema.table("channel_fulfillment_pushes", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).notNull().references(() => omsOrders.id, { onDelete: "restrict" }),
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).notNull().references(() => physicalShipments.id, { onDelete: "restrict" }),
  channelProvider: varchar("channel_provider", { length: 40 }).notNull(),
  channelFulfillmentScopeKey: varchar("channel_fulfillment_scope_key", { length: 200 }).notNull().default("order"),
  commandKey: varchar("command_key", { length: 400 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  carrier: varchar("carrier", { length: 100 }),
  trackingUrl: text("tracking_url"),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  channelFulfillmentId: varchar("channel_fulfillment_id", { length: 200 }),
  pushStatus: varchar("push_status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(12),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(),
  leaseToken: varchar("lease_token", { length: 100 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastError: text("last_error"),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  correlationId: varchar("correlation_id", { length: 100 }),
  causationId: varchar("causation_id", { length: 100 }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_channel_fulfillment_pushes_command").on(
    table.channelProvider,
    table.omsOrderId,
    table.physicalShipmentId,
    table.channelFulfillmentScopeKey,
  ),
  uniqueIndex("uq_channel_fulfillment_pushes_command_key").on(table.commandKey),
  index("idx_channel_fulfillment_pushes_oms_order").on(table.omsOrderId),
  index("idx_channel_fulfillment_pushes_due")
    .on(table.nextAttemptAt, table.id)
    .where(sql`${table.pushStatus} IN ('pending', 'retry')`),
  index("idx_channel_fulfillment_pushes_expired_lease")
    .on(table.leaseExpiresAt, table.id)
    .where(sql`${table.pushStatus} = 'processing'`),
]);

export const channelFulfillmentPushItems = omsSchema.table("channel_fulfillment_push_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channelFulfillmentPushId: bigint("channel_fulfillment_push_id", { mode: "number" }).notNull().references(() => channelFulfillmentPushes.id, { onDelete: "restrict" }),
  physicalShipmentItemId: bigint("physical_shipment_item_id", { mode: "number" }).references(() => physicalShipmentItems.id, { onDelete: "restrict" }),
  omsOrderLineId: bigint("oms_order_line_id", { mode: "number" }).notNull().references(() => omsOrderLines.id, { onDelete: "restrict" }),
  channelOrderLineId: varchar("channel_order_line_id", { length: 200 }),
  quantityPushed: integer("quantity_pushed").notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_channel_fulfillment_push_items_physical_item")
    .on(table.channelFulfillmentPushId, table.physicalShipmentItemId)
    .where(sql`${table.physicalShipmentItemId} IS NOT NULL`),
  index("idx_channel_fulfillment_push_items_push_oms_line").on(table.channelFulfillmentPushId, table.omsOrderLineId),
  index("idx_channel_fulfillment_push_items_oms_line").on(table.omsOrderLineId),
]);

export const channelFulfillmentPushAttempts = omsSchema.table("channel_fulfillment_push_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channelFulfillmentPushId: bigint("channel_fulfillment_push_id", { mode: "number" }).notNull().references(() => channelFulfillmentPushes.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  outcome: varchar("outcome", { length: 30 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  providerResponseId: varchar("provider_response_id", { length: 300 }),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: varchar("error_message", { length: 1000 }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  correlationId: varchar("correlation_id", { length: 100 }),
  causationId: varchar("causation_id", { length: 100 }),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_fulfillment_push_attempts_unique").on(table.channelFulfillmentPushId, table.attemptNumber),
  index("idx_channel_fulfillment_push_attempts_push").on(table.channelFulfillmentPushId, table.attemptNumber),
]);

/**
 * Immutable inbound evidence from a sales channel's fulfillment API/webhook.
 * A receipt is not itself permission to mutate an entire order. Its exact line
 * allocations must resolve through channel -> OMS -> WMS lineage before it can
 * materialize a canonical physical package.
 */
export const channelFulfillmentReceipts = omsSchema.table("channel_fulfillment_receipts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  receiptKey: varchar("receipt_key", { length: 500 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  sourceProvider: varchar("source_provider", { length: 40 }).notNull(),
  sourceChannelId: integer("source_channel_id").references(() => channels.id, { onDelete: "restrict" }),
  sourceOrderId: varchar("source_order_id", { length: 200 }).notNull(),
  sourceFulfillmentId: varchar("source_fulfillment_id", { length: 200 }).notNull(),
  sourceEventId: varchar("source_event_id", { length: 200 }),
  sourceInboxId: integer("source_inbox_id"),
  eventKind: varchar("event_kind", { length: 30 }).notNull(),
  source: varchar("source", { length: 80 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  carrier: varchar("carrier", { length: 100 }),
  trackingUrl: text("tracking_url"),
  shippedAt: timestamp("shipped_at", { withTimezone: true }),
  processingStatus: varchar("processing_status", { length: 30 }).notNull().default("pending"),
  retryFailureCount: integer("retry_failure_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).references(() => omsOrders.id, { onDelete: "restrict" }),
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).references(() => physicalShipments.id, { onDelete: "restrict" }),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  rawPayload: jsonb("raw_payload").notNull().default({}),
  correlationId: varchar("correlation_id", { length: 100 }),
  causationId: varchar("causation_id", { length: 100 }),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_channel_fulfillment_receipts_key").on(table.receiptKey),
  index("idx_channel_fulfillment_receipts_package").on(
    table.sourceProvider,
    table.sourceOrderId,
    table.sourceFulfillmentId,
  ),
  index("idx_channel_fulfillment_receipts_status").on(table.processingStatus, table.createdAt),
]);

export const channelFulfillmentReceiptItems = omsSchema.table("channel_fulfillment_receipt_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  receiptId: bigint("receipt_id", { mode: "number" }).notNull().references(() => channelFulfillmentReceipts.id, { onDelete: "restrict" }),
  sourceFulfillmentLineId: varchar("source_fulfillment_line_id", { length: 200 }),
  channelOrderLineId: varchar("channel_order_line_id", { length: 200 }).notNull(),
  quantity: integer("quantity").notNull(),
  omsOrderLineId: bigint("oms_order_line_id", { mode: "number" }).references(() => omsOrderLines.id, { onDelete: "restrict" }),
  wmsOrderItemId: integer("wms_order_item_id").references(() => orderItems.id, { onDelete: "restrict" }),
  legacyWmsShipmentItemId: integer("legacy_wms_shipment_item_id").references(() => outboundShipmentItems.id, { onDelete: "restrict" }),
  physicalShipmentItemId: bigint("physical_shipment_item_id", { mode: "number" }).references(() => physicalShipmentItems.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_channel_fulfillment_receipt_items_line").on(table.receiptId, table.channelOrderLineId),
  index("idx_channel_fulfillment_receipt_items_oms_line").on(table.omsOrderLineId),
  index("idx_channel_fulfillment_receipt_items_wms_line").on(table.wmsOrderItemId),
]);

/** Append-only changes to an already-observed package's tracking metadata. */
export const physicalShipmentTrackingAmendments = wmsSchema.table("physical_shipment_tracking_amendments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  physicalShipmentId: bigint("physical_shipment_id", { mode: "number" }).notNull().references(() => physicalShipments.id, { onDelete: "restrict" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerEventId: varchar("provider_event_id", { length: 200 }),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  trackingNumber: varchar("tracking_number", { length: 200 }),
  carrier: varchar("carrier", { length: 100 }),
  trackingUrl: text("tracking_url"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  source: varchar("source", { length: 80 }).notNull(),
  rawPayload: jsonb("raw_payload").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_physical_shipment_tracking_amendment_hash").on(
    table.physicalShipmentId,
    table.requestHash,
  ),
  index("idx_physical_shipment_tracking_amendment_current").on(
    table.physicalShipmentId,
    table.occurredAt,
    table.id,
  ),
]);

export const insertFulfillmentPlanSchema = createInsertSchema(fulfillmentPlans).omit({ id: true, createdAt: true, updatedAt: true });
export const insertFulfillmentPlanLineSchema = createInsertSchema(fulfillmentPlanLines).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShipmentRequestSchema = createInsertSchema(shipmentRequests).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShipmentRequestItemSchema = createInsertSchema(shipmentRequestItems).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingEngineOrderSchema = createInsertSchema(shippingEngineOrders).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingEngineOrderRequestSchema = createInsertSchema(shippingEngineOrderRequests).omit({ id: true, createdAt: true });
export const insertPhysicalShipmentSchema = createInsertSchema(physicalShipments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPhysicalShipmentItemSchema = createInsertSchema(physicalShipmentItems).omit({ id: true, createdAt: true });
export const insertShippingProviderLabelSchema = createInsertSchema(shippingProviderLabels).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingProviderLabelLinkSchema = createInsertSchema(shippingProviderLabelLinks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingProviderLabelEventSchema = createInsertSchema(shippingProviderLabelEvents).omit({ id: true });
export const insertCarrierTrackingSubscriptionSchema = createInsertSchema(carrierTrackingSubscriptions).omit({ id: true, createdAt: true, updatedAt: true });
export const insertCarrierTrackingSubscriptionLabelSchema = createInsertSchema(carrierTrackingSubscriptionLabels).omit({ id: true, createdAt: true });
export const insertCarrierTrackingSubscriptionAttemptSchema = createInsertSchema(carrierTrackingSubscriptionAttempts).omit({ id: true, createdAt: true });
export const insertCarrierTrackingEventSchema = createInsertSchema(carrierTrackingEvents).omit({ id: true });
export const insertCarrierTrackingWebhookReceiptSchema = createInsertSchema(carrierTrackingWebhookReceipts).omit({ id: true });
export const insertCarrierTrackingWebhookReceiptParseSchema = createInsertSchema(carrierTrackingWebhookReceiptParses).omit({ id: true });
export const insertCarrierTrackingWebhookHydrationSchema = createInsertSchema(carrierTrackingWebhookHydrations);
export const insertCarrierTrackingWebhookHydrationAttemptSchema = createInsertSchema(carrierTrackingWebhookHydrationAttempts).omit({ id: true, createdAt: true });
export const insertCarrierTrackingEventMatchSchema = createInsertSchema(carrierTrackingEventMatches).omit({ id: true });
export const insertCarrierTrackingReconciliationStateSchema = createInsertSchema(carrierTrackingReconciliationState);
export const insertChannelFulfillmentPushSchema = createInsertSchema(channelFulfillmentPushes).omit({ id: true, createdAt: true, updatedAt: true });
export const insertChannelFulfillmentPushItemSchema = createInsertSchema(channelFulfillmentPushItems).omit({ id: true, createdAt: true });
export const insertChannelFulfillmentPushAttemptSchema = createInsertSchema(channelFulfillmentPushAttempts).omit({ id: true, createdAt: true });
export const insertChannelFulfillmentReceiptSchema = createInsertSchema(channelFulfillmentReceipts).omit({ id: true, createdAt: true, updatedAt: true });
export const insertChannelFulfillmentReceiptItemSchema = createInsertSchema(channelFulfillmentReceiptItems).omit({ id: true, createdAt: true });
export const insertPhysicalShipmentTrackingAmendmentSchema = createInsertSchema(physicalShipmentTrackingAmendments).omit({ id: true, createdAt: true });

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
export type InsertShippingEngineOrderRequest = z.infer<typeof insertShippingEngineOrderRequestSchema>;
export type ShippingEngineOrderRequest = typeof shippingEngineOrderRequests.$inferSelect;
export type InsertPhysicalShipment = z.infer<typeof insertPhysicalShipmentSchema>;
export type PhysicalShipment = typeof physicalShipments.$inferSelect;
export type InsertPhysicalShipmentItem = z.infer<typeof insertPhysicalShipmentItemSchema>;
export type PhysicalShipmentItem = typeof physicalShipmentItems.$inferSelect;
export type InsertShippingProviderLabel = z.infer<typeof insertShippingProviderLabelSchema>;
export type ShippingProviderLabel = typeof shippingProviderLabels.$inferSelect;
export type InsertShippingProviderLabelLink = z.infer<typeof insertShippingProviderLabelLinkSchema>;
export type ShippingProviderLabelLink = typeof shippingProviderLabelLinks.$inferSelect;
export type InsertShippingProviderLabelEvent = z.infer<typeof insertShippingProviderLabelEventSchema>;
export type ShippingProviderLabelEvent = typeof shippingProviderLabelEvents.$inferSelect;
export type InsertCarrierTrackingSubscription = z.infer<typeof insertCarrierTrackingSubscriptionSchema>;
export type CarrierTrackingSubscription = typeof carrierTrackingSubscriptions.$inferSelect;
export type InsertCarrierTrackingSubscriptionLabel = z.infer<typeof insertCarrierTrackingSubscriptionLabelSchema>;
export type CarrierTrackingSubscriptionLabel = typeof carrierTrackingSubscriptionLabels.$inferSelect;
export type InsertCarrierTrackingSubscriptionAttempt = z.infer<typeof insertCarrierTrackingSubscriptionAttemptSchema>;
export type CarrierTrackingSubscriptionAttempt = typeof carrierTrackingSubscriptionAttempts.$inferSelect;
export type InsertCarrierTrackingEvent = z.infer<typeof insertCarrierTrackingEventSchema>;
export type CarrierTrackingEvent = typeof carrierTrackingEvents.$inferSelect;
export type InsertCarrierTrackingWebhookReceipt = z.infer<typeof insertCarrierTrackingWebhookReceiptSchema>;
export type CarrierTrackingWebhookReceipt = typeof carrierTrackingWebhookReceipts.$inferSelect;
export type InsertCarrierTrackingWebhookReceiptParse = z.infer<typeof insertCarrierTrackingWebhookReceiptParseSchema>;
export type CarrierTrackingWebhookReceiptParse = typeof carrierTrackingWebhookReceiptParses.$inferSelect;
export type InsertCarrierTrackingWebhookHydration = z.infer<typeof insertCarrierTrackingWebhookHydrationSchema>;
export type CarrierTrackingWebhookHydration = typeof carrierTrackingWebhookHydrations.$inferSelect;
export type InsertCarrierTrackingWebhookHydrationAttempt = z.infer<typeof insertCarrierTrackingWebhookHydrationAttemptSchema>;
export type CarrierTrackingWebhookHydrationAttempt = typeof carrierTrackingWebhookHydrationAttempts.$inferSelect;
export type InsertCarrierTrackingEventMatch = z.infer<typeof insertCarrierTrackingEventMatchSchema>;
export type CarrierTrackingEventMatch = typeof carrierTrackingEventMatches.$inferSelect;
export type InsertCarrierTrackingReconciliationState = z.infer<typeof insertCarrierTrackingReconciliationStateSchema>;
export type CarrierTrackingReconciliationState = typeof carrierTrackingReconciliationState.$inferSelect;
export type InsertChannelFulfillmentPush = z.infer<typeof insertChannelFulfillmentPushSchema>;
export type ChannelFulfillmentPush = typeof channelFulfillmentPushes.$inferSelect;
export type InsertChannelFulfillmentPushItem = z.infer<typeof insertChannelFulfillmentPushItemSchema>;
export type ChannelFulfillmentPushItem = typeof channelFulfillmentPushItems.$inferSelect;
export type InsertChannelFulfillmentPushAttempt = z.infer<typeof insertChannelFulfillmentPushAttemptSchema>;
export type ChannelFulfillmentPushAttempt = typeof channelFulfillmentPushAttempts.$inferSelect;
export type InsertChannelFulfillmentReceipt = z.infer<typeof insertChannelFulfillmentReceiptSchema>;
export type ChannelFulfillmentReceipt = typeof channelFulfillmentReceipts.$inferSelect;
export type InsertChannelFulfillmentReceiptItem = z.infer<typeof insertChannelFulfillmentReceiptItemSchema>;
export type ChannelFulfillmentReceiptItem = typeof channelFulfillmentReceiptItems.$inferSelect;
export type InsertPhysicalShipmentTrackingAmendment = z.infer<typeof insertPhysicalShipmentTrackingAmendmentSchema>;
export type PhysicalShipmentTrackingAmendment = typeof physicalShipmentTrackingAmendments.$inferSelect;
