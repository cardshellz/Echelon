import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
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
import { users } from "./identity.schema";

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
export const packageAllocationSourcePurposeValues = [
  "customer_fulfillment",
  "replacement",
  "concession",
  "omission_correction",
  "unclassified",
] as const;
export const packageAllocationKindValues = [
  "primary_transfer",
  "additional_physical_consumption",
] as const;
export const packageAllocationTargetKindValues = [
  "package",
  "awaiting_relabel",
  "held_for_unpack",
] as const;
export const packageAllocationPlanOutcomeValues = ["proposed", "review"] as const;
export const packageAllocationEffectTypeValues = [
  "commercial_fulfillment",
  "inventory_consumption",
  "active_label_tracking",
  "pre_possession_void_removal",
  "carrier_tracking",
  "notification_candidate",
  "notification_reconciliation",
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
export type PackageAllocationSourcePurpose = typeof packageAllocationSourcePurposeValues[number];
export type PackageAllocationKind = typeof packageAllocationKindValues[number];
export type PackageAllocationTargetKind = typeof packageAllocationTargetKindValues[number];
export type PackageAllocationPlanOutcome = typeof packageAllocationPlanOutcomeValues[number];
export type PackageAllocationEffectType = typeof packageAllocationEffectTypeValues[number];

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

export const shippingEngineOrderProviderRefs = wmsSchema.table("shipping_engine_order_provider_refs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingEngineOrderId: bigint("shipping_engine_order_id", { mode: "number" }).notNull().references(() => shippingEngineOrders.id, { onDelete: "restrict" }),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerOrderId: varchar("provider_order_id", { length: 200 }).notNull(),
  source: varchar("source", { length: 50 }).notNull(),
  firstObservedAt: timestamp("first_observed_at", { withTimezone: true }).notNull(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_shipping_engine_order_provider_refs_identity")
    .on(table.provider, table.providerOrderId),
  index("idx_shipping_engine_order_provider_refs_order")
    .on(table.shippingEngineOrderId, table.id),
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
  index("idx_physical_shipments_engine_order_lookup")
    .on(table.shippingEngineOrderId, table.id)
    .where(sql`${table.shippingEngineOrderId} IS NOT NULL`),
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
  correctionForPhysicalShipmentItemId: bigint("correction_for_physical_shipment_item_id", { mode: "number" })
    .references((): AnyPgColumn => physicalShipmentItems.id, { onDelete: "restrict" }),
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
  index("idx_physical_shipment_items_request_item_lookup")
    .on(table.shipmentRequestItemId, table.physicalShipmentId)
    .where(sql`${table.shipmentRequestItemId} IS NOT NULL`),
  index("idx_physical_shipment_items_plan_line").on(table.fulfillmentPlanLineId),
  index("idx_physical_shipment_items_replacement_line")
    .on(table.replacementForOrderItemId)
    .where(sql`${table.replacementForOrderItemId} IS NOT NULL`),
  index("idx_physical_shipment_items_correction_source")
    .on(table.correctionForPhysicalShipmentItemId)
    .where(sql`${table.correctionForPhysicalShipmentItemId} IS NOT NULL`),
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
  labelDirection: varchar("label_direction", { length: 20 }).notNull().default("outbound"),
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
  index("idx_shipping_provider_labels_provider_order_id_lookup")
    .on(table.provider, table.providerOrderId, table.id)
    .where(sql`${table.providerOrderId} IS NOT NULL`),
  index("idx_shipping_provider_labels_provider_order_key_lookup")
    .on(table.provider, table.providerOrderKey, table.id)
    .where(sql`${table.providerOrderKey} IS NOT NULL`),
  index("idx_shipping_provider_labels_shadow_scan")
    .on(table.provider, table.id.desc()),
  index("idx_shipping_provider_labels_tracking").on(table.provider, table.normalizedTrackingNumber),
  index("idx_shipping_provider_labels_status_observed").on(table.labelStatus, table.firstObservedAt),
  index("idx_shipping_provider_labels_direction_status")
    .on(table.labelDirection, table.labelStatus, table.firstObservedAt),
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
  index("idx_shipping_provider_label_links_request_lookup")
    .on(table.shipmentRequestId, table.shippingProviderLabelId)
    .where(sql`${table.shipmentRequestId} IS NOT NULL`),
  index("idx_shipping_provider_label_links_engine_order_lookup")
    .on(table.shippingEngineOrderId, table.shippingProviderLabelId)
    .where(sql`${table.shippingEngineOrderId} IS NOT NULL`),
  index("idx_shipping_provider_label_links_physical_lookup")
    .on(table.physicalShipmentId, table.shippingProviderLabelId)
    .where(sql`${table.physicalShipmentId} IS NOT NULL`),
  index("idx_shipping_provider_label_links_legacy_lookup")
    .on(table.legacyWmsShipmentId, table.shippingProviderLabelId)
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
  uniqueIndex("uq_shipping_provider_label_events_id_label")
    .on(table.id, table.shippingProviderLabelId),
  index("idx_shipping_provider_label_events_label")
    .on(table.shippingProviderLabelId, table.receivedAt),
]);

export interface ShippingProviderLabelAttestedContentLine {
  readonly wmsShipmentItemId: number;
  readonly quantity: number;
}

export const shippingProviderLabelContentAttestations = wmsSchema.table(
  "shipping_provider_label_content_attestations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" })
      .notNull()
      .references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
    recoveryContractVersion: integer("recovery_contract_version").notNull(),
    recoveryStatus: varchar("recovery_status", { length: 50 }).notNull(),
    previewEvidenceHash: varchar("preview_evidence_hash", { length: 64 }).notNull(),
    providerEvidenceHash: varchar("provider_evidence_hash", { length: 64 }).notNull(),
    attestedContents: jsonb("attested_contents")
      .$type<readonly ShippingProviderLabelAttestedContentLine[]>()
      .notNull(),
    actorUserId: varchar("actor_user_id").notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    actorRole: varchar("actor_role", { length: 20 }).notNull(),
    reason: varchar("reason", { length: 500 }).notNull(),
    attestationHash: varchar("attestation_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("uq_shipping_provider_label_content_attestations_label_preview")
      .on(table.shippingProviderLabelId, table.previewEvidenceHash),
    uniqueIndex("uq_shipping_provider_label_content_attestations_label_hash")
      .on(table.shippingProviderLabelId, table.attestationHash),
    uniqueIndex("uq_shipping_provider_label_content_attestations_id_label")
      .on(table.id, table.shippingProviderLabelId),
    index("idx_shipping_provider_label_content_attestations_label")
      .on(table.shippingProviderLabelId, table.createdAt, table.id),
    check(
      "shipping_provider_label_content_attestations_contract_chk",
      sql`${table.recoveryContractVersion} = 1`,
    ),
    check(
      "shipping_provider_label_content_attestations_status_chk",
      sql`${table.recoveryStatus} IN ('provider_line_keys_authoritative', 'exact_unique_wms_match')`,
    ),
    check(
      "shipping_provider_label_content_attestations_preview_hash_chk",
      sql`${table.previewEvidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "shipping_provider_label_content_attestations_provider_hash_chk",
      sql`${table.providerEvidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "shipping_provider_label_content_attestations_hash_chk",
      sql`${table.attestationHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "shipping_provider_label_content_attestations_contents_chk",
      sql`jsonb_typeof(${table.attestedContents}) = 'array'
        AND jsonb_array_length(${table.attestedContents}) BETWEEN 1 AND 500`,
    ),
    check(
      "shipping_provider_label_content_attestations_actor_role_chk",
      sql`${table.actorRole} IN ('admin', 'lead')`,
    ),
    check(
      "shipping_provider_label_content_attestations_reason_chk",
      sql`BTRIM(${table.reason}) <> '' AND ${table.reason} = BTRIM(${table.reason})`,
    ),
  ],
);

export const shippingProviderLabelContentAttestationResolutions = wmsSchema.table(
  "shipping_provider_label_content_attestation_resolutions",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    shippingProviderLabelContentAttestationId: bigint(
      "shipping_provider_label_content_attestation_id",
      { mode: "number" },
    ).notNull(),
    shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" }).notNull(),
    shippingProviderLabelEventId: bigint("shipping_provider_label_event_id", { mode: "number" })
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.shippingProviderLabelContentAttestationId,
        table.shippingProviderLabelId,
      ],
      foreignColumns: [
        shippingProviderLabelContentAttestations.id,
        shippingProviderLabelContentAttestations.shippingProviderLabelId,
      ],
      name: "fk_shipping_provider_label_content_attestation_resolutions_attestation",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.shippingProviderLabelEventId, table.shippingProviderLabelId],
      foreignColumns: [
        shippingProviderLabelEvents.id,
        shippingProviderLabelEvents.shippingProviderLabelId,
      ],
      name: "fk_shipping_provider_label_content_attestation_resolutions_event",
    }).onDelete("restrict"),
    uniqueIndex("uq_shipping_provider_label_content_attestation_resolutions_pair")
      .on(table.shippingProviderLabelContentAttestationId, table.shippingProviderLabelEventId),
    uniqueIndex("uq_shipping_provider_label_content_attestation_resolutions_event")
      .on(table.shippingProviderLabelEventId),
    index("idx_shipping_provider_label_content_attestation_resolutions_attestation")
      .on(table.shippingProviderLabelContentAttestationId, table.shippingProviderLabelEventId),
  ],
);

export const packageAllocationGroups = wmsSchema.table("package_allocation_groups", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  groupKey: uuid("group_key").notNull(),
  currentVersion: integer("current_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  versionUpdatedAt: timestamp("version_updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_groups_key").on(table.groupKey),
  check(
    "package_allocation_groups_current_version_chk",
    sql`${table.currentVersion} >= 0`,
  ),
]);

export const packageAllocationPackageBindings = wmsSchema.table("package_allocation_package_bindings", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  packageAllocationGroupId: bigint("package_allocation_group_id", { mode: "number" })
    .notNull()
    .references(() => packageAllocationGroups.id, { onDelete: "restrict" }),
  packageKey: varchar("package_key", { length: 180 }).notNull(),
  provider: varchar("provider", { length: 40 }).notNull(),
  providerPhysicalShipmentId: varchar("provider_physical_shipment_id", { length: 200 }).notNull(),
  identityHash: varchar("identity_hash", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_package_bindings_group_key")
    .on(table.packageAllocationGroupId, table.packageKey),
  uniqueIndex("uq_package_allocation_package_bindings_provider_identity")
    .on(table.provider, table.providerPhysicalShipmentId),
  uniqueIndex("uq_package_allocation_package_bindings_id_group")
    .on(table.id, table.packageAllocationGroupId),
  check(
    "package_allocation_package_bindings_text_chk",
    sql`BTRIM(${table.packageKey}) <> ''
      AND BTRIM(${table.provider}) <> ''
      AND BTRIM(${table.providerPhysicalShipmentId}) <> ''`,
  ),
  check(
    "package_allocation_package_bindings_hash_chk",
    sql`${table.identityHash} ~ '^[0-9a-f]{64}$'`,
  ),
]);

export const packageAllocationSourceLines = wmsSchema.table("package_allocation_source_lines", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  sourceWmsShipmentItemId: integer("source_wms_shipment_item_id")
    .notNull()
    .references(() => outboundShipmentItems.id, { onDelete: "restrict" }),
  shipmentRequestItemId: bigint("shipment_request_item_id", { mode: "number" })
    .references(() => shipmentRequestItems.id, { onDelete: "restrict" }),
  sourceQuantity: integer("source_quantity").notNull(),
  shipmentItemPurpose: varchar("shipment_item_purpose", { length: 30 }).notNull(),
  orderItemId: integer("order_item_id")
    .references(() => orderItems.id, { onDelete: "restrict" }),
  replacementForOrderItemId: integer("replacement_for_order_item_id")
    .references(() => orderItems.id, { onDelete: "restrict" }),
  correctionForShipmentItemId: integer("correction_for_shipment_item_id")
    .references(() => outboundShipmentItems.id, { onDelete: "restrict" }),
  productVariantId: integer("product_variant_id")
    .references(() => productVariants.id, { onDelete: "restrict" }),
  sku: varchar("sku", { length: 100 }).notNull(),
  sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_source_lines_wms_item")
    .on(table.sourceWmsShipmentItemId),
  uniqueIndex("uq_package_allocation_source_lines_request_item")
    .on(table.shipmentRequestItemId),
  uniqueIndex("uq_package_allocation_source_lines_fingerprint")
    .on(table.sourceFingerprint),
  check("package_allocation_source_lines_quantity_chk", sql`${table.sourceQuantity} > 0`),
  check(
    "package_allocation_source_lines_purpose_chk",
    sql`${table.shipmentItemPurpose} IN ('customer_fulfillment', 'replacement', 'concession', 'omission_correction', 'unclassified')`,
  ),
  check(
    "package_allocation_source_lines_request_purpose_chk",
    sql`${table.shipmentRequestItemId} IS NULL OR ${table.shipmentItemPurpose} = 'customer_fulfillment'`,
  ),
  check(
    "package_allocation_source_lines_lineage_chk",
    sql`
      (
        ${table.shipmentItemPurpose} = 'customer_fulfillment'
        AND ${table.orderItemId} IS NOT NULL
        AND ${table.replacementForOrderItemId} IS NULL
        AND ${table.correctionForShipmentItemId} IS NULL
      )
      OR (
        ${table.shipmentItemPurpose} = 'replacement'
        AND ${table.orderItemId} IS NULL
        AND ${table.replacementForOrderItemId} IS NOT NULL
        AND ${table.correctionForShipmentItemId} IS NULL
      )
      OR (
        ${table.shipmentItemPurpose} = 'concession'
        AND ${table.orderItemId} IS NULL
        AND ${table.replacementForOrderItemId} IS NULL
        AND ${table.correctionForShipmentItemId} IS NULL
        AND ${table.productVariantId} IS NOT NULL
      )
      OR (
        ${table.shipmentItemPurpose} = 'omission_correction'
        AND ${table.orderItemId} IS NULL
        AND ${table.replacementForOrderItemId} IS NULL
        AND ${table.correctionForShipmentItemId} IS NOT NULL
        AND ${table.productVariantId} IS NOT NULL
      )
      OR (
        ${table.shipmentItemPurpose} = 'unclassified'
        AND ${table.orderItemId} IS NULL
        AND ${table.replacementForOrderItemId} IS NULL
        AND ${table.correctionForShipmentItemId} IS NULL
      )
    `,
  ),
  check("package_allocation_source_lines_sku_chk", sql`BTRIM(${table.sku}) <> ''`),
  check(
    "package_allocation_source_lines_fingerprint_chk",
    sql`${table.sourceFingerprint} ~ '^[0-9a-f]{64}$'`,
  ),
]);

export const packageAllocationKeys = wmsSchema.table("package_allocation_keys", {
  allocationKey: varchar("allocation_key", { length: 500 }).primaryKey(),
  packageAllocationSourceLineId: bigint("package_allocation_source_line_id", { mode: "number" })
    .notNull()
    .references(() => packageAllocationSourceLines.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_keys_source")
    .on(table.allocationKey, table.packageAllocationSourceLineId),
  check("package_allocation_keys_key_chk", sql`BTRIM(${table.allocationKey}) <> ''`),
]);

export const packageAllocationGroupSourceLines = wmsSchema.table("package_allocation_group_source_lines", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  packageAllocationGroupId: bigint("package_allocation_group_id", { mode: "number" })
    .notNull()
    .references(() => packageAllocationGroups.id, { onDelete: "restrict" }),
  packageAllocationSourceLineId: bigint("package_allocation_source_line_id", { mode: "number" })
    .notNull()
    .references(() => packageAllocationSourceLines.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_group_source_lines_membership")
    .on(table.packageAllocationGroupId, table.packageAllocationSourceLineId),
  uniqueIndex("uq_package_allocation_group_source_lines_source")
    .on(table.packageAllocationSourceLineId),
]);

export const packageAllocationPlans = wmsSchema.table("package_allocation_plans", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  packageAllocationGroupId: bigint("package_allocation_group_id", { mode: "number" })
    .notNull()
    .references(() => packageAllocationGroups.id, { onDelete: "restrict" }),
  planVersion: integer("plan_version").notNull(),
  expectedGroupVersion: integer("expected_group_version").notNull(),
  inputHash: varchar("input_hash", { length: 64 }).notNull(),
  stateHash: varchar("state_hash", { length: 64 }).notNull(),
  outcome: varchar("outcome", { length: 20 }).notNull(),
  plannerVersion: varchar("planner_version", { length: 100 }).notNull(),
  reason: varchar("reason", { length: 500 }).notNull(),
  createdBy: varchar("created_by", { length: 200 }).notNull(),
  stateSnapshot: jsonb("state_snapshot").notNull(),
  reviewSnapshot: jsonb("review_snapshot").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_plans_group_version")
    .on(table.packageAllocationGroupId, table.planVersion),
  uniqueIndex("uq_package_allocation_plans_group_input_hash")
    .on(table.packageAllocationGroupId, table.inputHash),
  uniqueIndex("uq_package_allocation_plans_id_group")
    .on(table.id, table.packageAllocationGroupId),
  check(
    "package_allocation_plans_version_chk",
    sql`${table.planVersion} > 0
      AND ${table.expectedGroupVersion} >= 0
      AND ${table.planVersion} = ${table.expectedGroupVersion} + 1`,
  ),
  check("package_allocation_plans_input_hash_chk", sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`),
  check("package_allocation_plans_state_hash_chk", sql`${table.stateHash} ~ '^[0-9a-f]{64}$'`),
  check("package_allocation_plans_outcome_chk", sql`${table.outcome} IN ('proposed', 'review')`),
  check(
    "package_allocation_plans_snapshots_chk",
    sql`jsonb_typeof(${table.stateSnapshot}) = 'object'
      AND jsonb_typeof(${table.reviewSnapshot}) = 'object'`,
  ),
  check(
    "package_allocation_plans_text_chk",
    sql`BTRIM(${table.plannerVersion}) <> ''
      AND BTRIM(${table.reason}) <> ''
      AND BTRIM(${table.createdBy}) <> ''`,
  ),
]);

export const packageAllocationEntries = wmsSchema.table("package_allocation_entries", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  packageAllocationPlanId: bigint("package_allocation_plan_id", { mode: "number" }).notNull(),
  packageAllocationGroupId: bigint("package_allocation_group_id", { mode: "number" }).notNull(),
  packageAllocationSourceLineId: bigint("package_allocation_source_line_id", { mode: "number" }).notNull(),
  allocationKey: varchar("allocation_key", { length: 500 }).notNull(),
  entryKey: varchar("entry_key", { length: 500 }).notNull(),
  allocationKind: varchar("allocation_kind", { length: 40 }).notNull(),
  targetKind: varchar("target_kind", { length: 40 }).notNull(),
  packageAllocationPackageBindingId: bigint("package_allocation_package_binding_id", { mode: "number" }),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" })
    .references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_entries_key")
    .on(table.packageAllocationPlanId, table.entryKey),
  uniqueIndex("uq_package_allocation_entries_semantic_target").on(
    table.packageAllocationPlanId,
    table.allocationKey,
    table.packageAllocationSourceLineId,
    table.allocationKind,
    table.targetKind,
    sql`COALESCE(${table.packageAllocationPackageBindingId}, 0)`,
  ),
  index("idx_package_allocation_entries_plan_source_kind").on(
    table.packageAllocationPlanId,
    table.packageAllocationSourceLineId,
    table.allocationKind,
  ),
  foreignKey({
    columns: [table.packageAllocationPlanId, table.packageAllocationGroupId],
    foreignColumns: [packageAllocationPlans.id, packageAllocationPlans.packageAllocationGroupId],
    name: "fk_package_allocation_entries_plan_group",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.packageAllocationPackageBindingId, table.packageAllocationGroupId],
    foreignColumns: [
      packageAllocationPackageBindings.id,
      packageAllocationPackageBindings.packageAllocationGroupId,
    ],
    name: "fk_package_allocation_entries_package_binding",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.allocationKey, table.packageAllocationSourceLineId],
    foreignColumns: [
      packageAllocationKeys.allocationKey,
      packageAllocationKeys.packageAllocationSourceLineId,
    ],
    name: "fk_package_allocation_entries_allocation_key",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.packageAllocationGroupId, table.packageAllocationSourceLineId],
    foreignColumns: [
      packageAllocationGroupSourceLines.packageAllocationGroupId,
      packageAllocationGroupSourceLines.packageAllocationSourceLineId,
    ],
    name: "fk_package_allocation_entries_group_source",
  }).onDelete("restrict"),
  check("package_allocation_entries_key_chk", sql`BTRIM(${table.entryKey}) <> ''`),
  check(
    "package_allocation_entries_allocation_key_chk",
    sql`BTRIM(${table.allocationKey}) <> ''`,
  ),
  check("package_allocation_entries_quantity_chk", sql`${table.quantity} > 0`),
  check(
    "package_allocation_entries_kind_chk",
    sql`${table.allocationKind} IN ('primary_transfer', 'additional_physical_consumption')`,
  ),
  check(
    "package_allocation_entries_target_chk",
    sql`${table.targetKind} IN ('package', 'awaiting_relabel', 'held_for_unpack')`,
  ),
  check(
    "package_allocation_entries_target_shape_chk",
    sql`
      (
        ${table.targetKind} = 'package'
        AND ${table.packageAllocationPackageBindingId} IS NOT NULL
      )
      OR (
        ${table.targetKind} IN ('awaiting_relabel', 'held_for_unpack')
        AND ${table.packageAllocationPackageBindingId} IS NULL
        AND ${table.shippingProviderLabelId} IS NULL
      )
    `,
  ),
  check(
    "package_allocation_entries_consumption_target_chk",
    sql`${table.allocationKind} <> 'additional_physical_consumption'
      OR ${table.targetKind} = 'package'`,
  ),
]);

export const packageAllocationEffectIntents = wmsSchema.table("package_allocation_effect_intents", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  packageAllocationPlanId: bigint("package_allocation_plan_id", { mode: "number" }).notNull(),
  packageAllocationGroupId: bigint("package_allocation_group_id", { mode: "number" }).notNull(),
  packageAllocationSourceLineId: bigint("package_allocation_source_line_id", { mode: "number" }),
  packageAllocationPackageBindingId: bigint("package_allocation_package_binding_id", { mode: "number" }),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" })
    .references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  intentKey: varchar("intent_key", { length: 500 }).notNull(),
  effectType: varchar("effect_type", { length: 80 }).notNull(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  quantity: integer("quantity"),
  payload: jsonb("payload").notNull().default({}),
  executable: boolean("executable").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_package_allocation_effect_intents_key").on(table.intentKey),
  foreignKey({
    columns: [table.packageAllocationPlanId, table.packageAllocationGroupId],
    foreignColumns: [packageAllocationPlans.id, packageAllocationPlans.packageAllocationGroupId],
    name: "fk_package_allocation_effect_intents_plan_group",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.packageAllocationPackageBindingId, table.packageAllocationGroupId],
    foreignColumns: [
      packageAllocationPackageBindings.id,
      packageAllocationPackageBindings.packageAllocationGroupId,
    ],
    name: "fk_package_allocation_effect_intents_package_binding",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.packageAllocationGroupId, table.packageAllocationSourceLineId],
    foreignColumns: [
      packageAllocationGroupSourceLines.packageAllocationGroupId,
      packageAllocationGroupSourceLines.packageAllocationSourceLineId,
    ],
    name: "fk_package_allocation_effect_intents_group_source",
  }).onDelete("restrict"),
  check("package_allocation_effect_intents_key_chk", sql`BTRIM(${table.intentKey}) <> ''`),
  check(
    "package_allocation_effect_intents_type_chk",
    sql`${table.effectType} IN (
      'commercial_fulfillment',
      'inventory_consumption',
      'active_label_tracking',
      'pre_possession_void_removal',
      'carrier_tracking',
      'notification_candidate',
      'notification_reconciliation'
    )`,
  ),
  check(
    "package_allocation_effect_intents_payload_hash_chk",
    sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
  ),
  check(
    "package_allocation_effect_intents_quantity_chk",
    sql`${table.quantity} IS NULL OR ${table.quantity} > 0`,
  ),
  check(
    "package_allocation_effect_intents_source_quantity_chk",
    sql`
      (${table.packageAllocationSourceLineId} IS NULL AND ${table.quantity} IS NULL)
      OR (${table.packageAllocationSourceLineId} IS NOT NULL AND ${table.quantity} IS NOT NULL)
    `,
  ),
  check(
    "package_allocation_effect_intents_payload_chk",
    sql`jsonb_typeof(${table.payload}) = 'object'`,
  ),
  check(
    "package_allocation_effect_intents_label_binding_chk",
    sql`${table.shippingProviderLabelId} IS NULL
      OR ${table.packageAllocationPackageBindingId} IS NOT NULL`,
  ),
  check("package_allocation_effect_intents_inert_chk", sql`${table.executable} = FALSE`),
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

export const carrierTrackingSubscriptionRequeues = wmsSchema.table("carrier_tracking_subscription_requeues", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierTrackingSubscriptionId: bigint("carrier_tracking_subscription_id", { mode: "number" }).notNull().references(() => carrierTrackingSubscriptions.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  operator: varchar("operator", { length: 200 }).notNull(),
  reason: text("reason").notNull(),
  previousStatus: varchar("previous_status", { length: 30 }).notNull(),
  previousAttemptCount: integer("previous_attempt_count").notNull(),
  previousConsecutiveFailureCount: integer("previous_consecutive_failure_count").notNull(),
  previousErrorCode: varchar("previous_error_code", { length: 100 }),
  previousErrorMessage: text("previous_error_message"),
  previousHttpStatus: integer("previous_http_status"),
  previousResponseEvidence: jsonb("previous_response_evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_tracking_subscription_requeues_idempotency")
    .on(table.carrierTrackingSubscriptionId, table.idempotencyKey),
  index("idx_carrier_tracking_subscription_requeues_subscription")
    .on(table.carrierTrackingSubscriptionId, table.createdAt, table.id),
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

export const carrierDispatchCommands = wmsSchema.table("carrier_dispatch_commands", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  shippingProviderLabelId: bigint("shipping_provider_label_id", { mode: "number" }).notNull().references(() => shippingProviderLabels.id, { onDelete: "restrict" }),
  carrierTrackingEventId: bigint("carrier_tracking_event_id", { mode: "number" }).notNull().references(() => carrierTrackingEvents.id, { onDelete: "restrict" }),
  commandKey: varchar("command_key", { length: 400 }).notNull(),
  source: varchar("source", { length: 60 }).notNull(),
  createdBy: varchar("created_by", { length: 200 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  leaseOwner: varchar("lease_owner", { length: 200 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  dispatchOccurredAt: timestamp("dispatch_occurred_at", { withTimezone: true }).notNull(),
  succeededAt: timestamp("succeeded_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: text("last_error_message"),
  resultEvidence: jsonb("result_evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_dispatch_commands_label").on(table.shippingProviderLabelId),
  uniqueIndex("uq_carrier_dispatch_commands_key").on(table.commandKey),
  index("idx_carrier_dispatch_commands_due")
    .on(table.nextAttemptAt, table.leaseExpiresAt, table.id),
  index("idx_carrier_dispatch_commands_status")
    .on(table.status, table.updatedAt, table.id),
]);

export const carrierDispatchAttempts = wmsSchema.table("carrier_dispatch_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierDispatchCommandId: bigint("carrier_dispatch_command_id", { mode: "number" }).notNull().references(() => carrierDispatchCommands.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  attemptOutcome: varchar("attempt_outcome", { length: 30 }).notNull(),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  requestEvidence: jsonb("request_evidence").notNull(),
  responseEvidence: jsonb("response_evidence").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_dispatch_attempts_number")
    .on(table.carrierDispatchCommandId, table.attemptNumber),
  index("idx_carrier_dispatch_attempts_command")
    .on(table.carrierDispatchCommandId, table.attemptNumber),
]);

export const carrierDispatchCommandRequeues = wmsSchema.table("carrier_dispatch_command_requeues", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  carrierDispatchCommandId: bigint("carrier_dispatch_command_id", { mode: "number" }).notNull().references(() => carrierDispatchCommands.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  operator: varchar("operator", { length: 200 }).notNull(),
  reason: text("reason").notNull(),
  repairCohort: varchar("repair_cohort", { length: 100 }).notNull(),
  previousStatus: varchar("previous_status", { length: 30 }).notNull(),
  previousAttemptCount: integer("previous_attempt_count").notNull(),
  previousConsecutiveFailureCount: integer("previous_consecutive_failure_count").notNull(),
  previousErrorCode: varchar("previous_error_code", { length: 100 }),
  previousErrorMessage: text("previous_error_message"),
  previousResultEvidence: jsonb("previous_result_evidence").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_carrier_dispatch_command_requeues_idempotency")
    .on(table.carrierDispatchCommandId, table.idempotencyKey),
  index("idx_carrier_dispatch_command_requeues_command")
    .on(table.carrierDispatchCommandId, table.createdAt, table.id),
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

export const channelFulfillmentPushRequeues = omsSchema.table("channel_fulfillment_push_requeues", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  channelFulfillmentPushId: bigint("channel_fulfillment_push_id", { mode: "number" }).notNull().references(() => channelFulfillmentPushes.id, { onDelete: "restrict" }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  operator: varchar("operator", { length: 200 }).notNull(),
  reason: text("reason").notNull(),
  previousStatus: varchar("previous_status", { length: 30 }).notNull(),
  previousAttemptCount: integer("previous_attempt_count").notNull(),
  previousErrorCode: varchar("previous_error_code", { length: 100 }),
  previousErrorMessage: text("previous_error_message"),
  previousRequestHash: varchar("previous_request_hash", { length: 64 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("uq_channel_fulfillment_push_requeues_idempotency")
    .on(table.channelFulfillmentPushId, table.idempotencyKey),
  index("idx_channel_fulfillment_push_requeues_command")
    .on(table.channelFulfillmentPushId, table.createdAt, table.id),
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
export const insertShippingEngineOrderProviderRefSchema = createInsertSchema(shippingEngineOrderProviderRefs).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingEngineOrderRequestSchema = createInsertSchema(shippingEngineOrderRequests).omit({ id: true, createdAt: true });
export const insertPhysicalShipmentSchema = createInsertSchema(physicalShipments).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPhysicalShipmentItemSchema = createInsertSchema(physicalShipmentItems).omit({ id: true, createdAt: true });
export const insertShippingProviderLabelSchema = createInsertSchema(shippingProviderLabels).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingProviderLabelLinkSchema = createInsertSchema(shippingProviderLabelLinks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShippingProviderLabelEventSchema = createInsertSchema(shippingProviderLabelEvents).omit({ id: true });
export const insertShippingProviderLabelContentAttestationSchema = createInsertSchema(shippingProviderLabelContentAttestations).omit({ id: true, createdAt: true });
export const insertShippingProviderLabelContentAttestationResolutionSchema = createInsertSchema(shippingProviderLabelContentAttestationResolutions).omit({ id: true, createdAt: true });
export const insertPackageAllocationGroupSchema = createInsertSchema(packageAllocationGroups).omit({ id: true, createdAt: true, versionUpdatedAt: true });
export const insertPackageAllocationPackageBindingSchema = createInsertSchema(packageAllocationPackageBindings).omit({ id: true, createdAt: true });
export const insertPackageAllocationSourceLineSchema = createInsertSchema(packageAllocationSourceLines).omit({ id: true, createdAt: true });
export const insertPackageAllocationKeySchema = createInsertSchema(packageAllocationKeys).omit({ createdAt: true });
export const insertPackageAllocationGroupSourceLineSchema = createInsertSchema(packageAllocationGroupSourceLines).omit({ id: true, createdAt: true });
export const insertPackageAllocationPlanSchema = createInsertSchema(packageAllocationPlans).omit({ id: true, createdAt: true });
export const insertPackageAllocationEntrySchema = createInsertSchema(packageAllocationEntries).omit({ id: true, createdAt: true });
export const insertPackageAllocationEffectIntentSchema = createInsertSchema(packageAllocationEffectIntents).omit({ id: true, createdAt: true });
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
export const insertCarrierDispatchCommandSchema = createInsertSchema(carrierDispatchCommands).omit({ id: true });
export const insertCarrierDispatchAttemptSchema = createInsertSchema(carrierDispatchAttempts).omit({ id: true });
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
export type InsertShippingEngineOrderProviderRef = z.infer<typeof insertShippingEngineOrderProviderRefSchema>;
export type ShippingEngineOrderProviderRef = typeof shippingEngineOrderProviderRefs.$inferSelect;
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
export type InsertShippingProviderLabelContentAttestation = z.infer<typeof insertShippingProviderLabelContentAttestationSchema>;
export type ShippingProviderLabelContentAttestation = typeof shippingProviderLabelContentAttestations.$inferSelect;
export type InsertShippingProviderLabelContentAttestationResolution = z.infer<typeof insertShippingProviderLabelContentAttestationResolutionSchema>;
export type ShippingProviderLabelContentAttestationResolution = typeof shippingProviderLabelContentAttestationResolutions.$inferSelect;
export type InsertPackageAllocationGroup = z.infer<typeof insertPackageAllocationGroupSchema>;
export type PackageAllocationGroup = typeof packageAllocationGroups.$inferSelect;
export type InsertPackageAllocationPackageBinding = z.infer<typeof insertPackageAllocationPackageBindingSchema>;
export type PackageAllocationPackageBinding = typeof packageAllocationPackageBindings.$inferSelect;
export type InsertPackageAllocationSourceLine = z.infer<typeof insertPackageAllocationSourceLineSchema>;
export type PackageAllocationSourceLine = typeof packageAllocationSourceLines.$inferSelect;
export type InsertPackageAllocationKey = z.infer<typeof insertPackageAllocationKeySchema>;
export type PackageAllocationKey = typeof packageAllocationKeys.$inferSelect;
export type InsertPackageAllocationGroupSourceLine = z.infer<typeof insertPackageAllocationGroupSourceLineSchema>;
export type PackageAllocationGroupSourceLine = typeof packageAllocationGroupSourceLines.$inferSelect;
export type InsertPackageAllocationPlan = z.infer<typeof insertPackageAllocationPlanSchema>;
export type PackageAllocationPlan = typeof packageAllocationPlans.$inferSelect;
export type InsertPackageAllocationEntry = z.infer<typeof insertPackageAllocationEntrySchema>;
export type PackageAllocationEntry = typeof packageAllocationEntries.$inferSelect;
export type InsertPackageAllocationEffectIntent = z.infer<typeof insertPackageAllocationEffectIntentSchema>;
export type PackageAllocationEffectIntent = typeof packageAllocationEffectIntents.$inferSelect;
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
export type CarrierDispatchCommand = typeof carrierDispatchCommands.$inferSelect;
export type CarrierDispatchAttempt = typeof carrierDispatchAttempts.$inferSelect;
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
