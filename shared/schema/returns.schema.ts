import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { channels } from "./channels.schema";
import { dropshipStoreConnections, dropshipVendors, dropshipWalletLedger } from "./dropship.schema";
import { inventoryLots, inventoryTransactions } from "./inventory.schema";
import { omsOrderLines, omsOrders } from "./oms.schema";
import { orderItems, orders, returnItems, returns } from "./orders.schema";
import { warehouseLocations } from "./warehouse.schema";

export const returnsSchema = pgSchema("returns");
export const returnPolicyScopeKinds = ["global", "business_context", "channel_context", "vendor_context", "vendor_channel_context", "store"] as const;
export type ReturnPolicyScopeKind = typeof returnPolicyScopeKinds[number];
export const returnBusinessContexts = ["retail", "dropship"] as const;
export type ReturnBusinessContext = typeof returnBusinessContexts[number];
export const returnDestinations = ["card_shellz", "vendor", "marketplace"] as const;
export type ReturnDestination = typeof returnDestinations[number];
export const returnApprovalAuthorities = ["card_shellz", "marketplace", "vendor"] as const;
export const returnLabelProviders = ["shipstation", "marketplace", "vendor", "none"] as const;
export const returnShippingPayers = ["card_shellz", "vendor", "customer", "marketplace", "carrier"] as const;
export const returnInspectionRequirements = ["required", "conditional", "none"] as const;
export type ReturnInspectionRequirement = typeof returnInspectionRequirements[number];
export const returnInspectionOwners = ["card_shellz", "vendor", "marketplace"] as const;
export type ReturnInspectionOwner = typeof returnInspectionOwners[number];
export const returnRefundAuthorities = ["card_shellz", "marketplace", "vendor"] as const;
export const returnVendorSettlementTriggers = ["inspection_approved", "customer_refunded", "carrier_claim_paid", "none"] as const;

export const returnCaseStatuses = ["open", "closed", "cancelled", "exception"] as const;
export type ReturnCaseStatus = typeof returnCaseStatuses[number];
export const returnApprovalStatuses = ["pending", "approved", "rejected"] as const;
export type ReturnApprovalStatus = typeof returnApprovalStatuses[number];
export const returnLogisticsStatuses = ["not_required", "awaiting_return", "label_ready", "in_transit", "delivered", "partially_received", "received"] as const;
export type ReturnLogisticsStatus = typeof returnLogisticsStatuses[number];
export const returnInspectionStatuses = ["not_required", "pending", "in_progress", "approved", "rejected"] as const;
export type ReturnInspectionStatus = typeof returnInspectionStatuses[number];
export const returnDispositionTreatments = ["restock_sellable", "hold_non_sellable"] as const;
export type ReturnDispositionTreatment = typeof returnDispositionTreatments[number];
export const returnDispositionInspectionResolutions = ["approved", "rejected", "not_required"] as const;
export type ReturnDispositionInspectionResolution = typeof returnDispositionInspectionResolutions[number];
export const returnCustomerRefundStatuses = ["pending", "completed", "failed", "not_required"] as const;
export type ReturnCustomerRefundStatus = typeof returnCustomerRefundStatuses[number];
export const returnVendorSettlementStatuses = ["not_applicable", "pending", "eligible", "completed", "held", "failed"] as const;
export type ReturnVendorSettlementStatus = typeof returnVendorSettlementStatuses[number];

export const returnPolicies = returnsSchema.table("return_policies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 160 }).notNull(),
  scopeKind: varchar("scope_kind", { length: 40 }).notNull(),
  scopeKey: varchar("scope_key", { length: 255 }).notNull(),
  businessContext: varchar("business_context", { length: 30 }),
  channelId: integer("channel_id").references(() => channels.id),
  vendorId: integer("vendor_id").references(() => dropshipVendors.id),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id),
  version: integer("version").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  returnWindowDays: integer("return_window_days").notNull(),
  returnDestination: varchar("return_destination", { length: 30 }).notNull(),
  approvalAuthority: varchar("approval_authority", { length: 30 }).notNull(),
  labelProvider: varchar("label_provider", { length: 30 }).notNull(),
  returnShippingPayer: varchar("return_shipping_payer", { length: 30 }).notNull(),
  inspectionRequirement: varchar("inspection_requirement", { length: 30 }).notNull(),
  inspectionOwner: varchar("inspection_owner", { length: 30 }).notNull(),
  customerRefundAuthority: varchar("customer_refund_authority", { length: 30 }).notNull(),
  vendorSettlementTrigger: varchar("vendor_settlement_trigger", { length: 40 }).notNull(),
  returnlessRefundAllowed: boolean("returnless_refund_allowed").notNull().default(false),
  notes: text("notes"),
  supersedesPolicyId: integer("supersedes_policy_id"),
  createdBy: varchar("created_by", { length: 255 }).notNull(),
  retiredBy: varchar("retired_by", { length: 255 }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_policies_active_scope_uq").on(table.scopeKey).where(sql`${table.status} = 'active'`),
  uniqueIndex("return_policies_scope_version_uq").on(table.scopeKey, table.version),
  index("return_policies_resolution_idx").on(table.status, table.businessContext, table.channelId, table.vendorId, table.storeConnectionId),
  check("return_policies_scope_kind_chk", sql`${table.scopeKind} IN ('global','business_context','channel_context','vendor_context','vendor_channel_context','store')`),
  check("return_policies_context_chk", sql`${table.businessContext} IS NULL OR ${table.businessContext} IN ('retail','dropship')`),
  check("return_policies_status_chk", sql`${table.status} IN ('active','retired')`),
  check("return_policies_window_chk", sql`${table.returnWindowDays} BETWEEN 0 AND 3650`),
  check("return_policies_destination_chk", sql`${table.returnDestination} IN ('card_shellz','vendor','marketplace')`),
  check("return_policies_approval_chk", sql`${table.approvalAuthority} IN ('card_shellz','marketplace','vendor')`),
  check("return_policies_label_chk", sql`${table.labelProvider} IN ('shipstation','marketplace','vendor','none')`),
  check("return_policies_payer_chk", sql`${table.returnShippingPayer} IN ('card_shellz','vendor','customer','marketplace','carrier')`),
  check("return_policies_inspection_requirement_chk", sql`${table.inspectionRequirement} IN ('required','conditional','none')`),
  check("return_policies_inspection_owner_chk", sql`${table.inspectionOwner} IN ('card_shellz','vendor','marketplace')`),
  check("return_policies_refund_authority_chk", sql`${table.customerRefundAuthority} IN ('card_shellz','marketplace','vendor')`),
  check("return_policies_settlement_trigger_chk", sql`${table.vendorSettlementTrigger} IN ('inspection_approved','customer_refunded','carrier_claim_paid','none')`),
  check("return_policies_scope_dimensions_chk", sql`
    (${table.scopeKind} = 'global' AND ${table.businessContext} IS NULL AND ${table.channelId} IS NULL AND ${table.vendorId} IS NULL AND ${table.storeConnectionId} IS NULL)
    OR (${table.scopeKind} = 'business_context' AND ${table.businessContext} IS NOT NULL AND ${table.channelId} IS NULL AND ${table.vendorId} IS NULL AND ${table.storeConnectionId} IS NULL)
    OR (${table.scopeKind} = 'channel_context' AND ${table.businessContext} IS NOT NULL AND ${table.channelId} IS NOT NULL AND ${table.vendorId} IS NULL AND ${table.storeConnectionId} IS NULL)
    OR (${table.scopeKind} = 'vendor_context' AND ${table.businessContext} = 'dropship' AND ${table.channelId} IS NULL AND ${table.vendorId} IS NOT NULL AND ${table.storeConnectionId} IS NULL)
    OR (${table.scopeKind} = 'vendor_channel_context' AND ${table.businessContext} = 'dropship' AND ${table.channelId} IS NOT NULL AND ${table.vendorId} IS NOT NULL AND ${table.storeConnectionId} IS NULL)
    OR (${table.scopeKind} = 'store' AND ${table.businessContext} = 'dropship' AND ${table.channelId} IS NOT NULL AND ${table.vendorId} IS NOT NULL AND ${table.storeConnectionId} IS NOT NULL)
  `),
]);

export const returnPolicyCommands = returnsSchema.table("return_policy_commands", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  response: jsonb("response").notNull(),
  actor: varchar("actor", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("return_policy_commands_idempotency_uq").on(table.idempotencyKey)]);

export type ReturnPolicy = typeof returnPolicies.$inferSelect;

export const returnCases = returnsSchema.table("return_cases", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  caseNumber: varchar("case_number", { length: 32 }).notNull(),
  sourceProvider: varchar("source_provider", { length: 40 }).notNull(),
  sourceEventType: varchar("source_event_type", { length: 40 }).notNull(),
  sourceEventId: varchar("source_event_id", { length: 160 }).notNull(),
  businessContext: varchar("business_context", { length: 30 }).notNull(),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  vendorId: integer("vendor_id").references(() => dropshipVendors.id),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).notNull().references(() => omsOrders.id),
  wmsOrderId: integer("wms_order_id").notNull().references(() => orders.id),
  wmsReturnId: bigint("wms_return_id", { mode: "number" }).notNull().references(() => returns.id),
  policyId: integer("policy_id").notNull().references(() => returnPolicies.id),
  policyVersion: integer("policy_version").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  caseStatus: varchar("case_status", { length: 24 }).notNull(),
  approvalStatus: varchar("approval_status", { length: 24 }).notNull(),
  logisticsStatus: varchar("logistics_status", { length: 24 }).notNull(),
  inspectionStatus: varchar("inspection_status", { length: 24 }).notNull(),
  customerRefundStatus: varchar("customer_refund_status", { length: 24 }).notNull(),
  vendorSettlementStatus: varchar("vendor_settlement_status", { length: 24 }).notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_cases_case_number_uq").on(table.caseNumber),
  uniqueIndex("return_cases_source_uq").on(table.sourceProvider, table.sourceEventType, table.sourceEventId),
  uniqueIndex("return_cases_wms_return_uq").on(table.wmsReturnId),
  index("return_cases_order_idx").on(table.omsOrderId, table.wmsOrderId),
  index("return_cases_channel_idx").on(table.channelId, table.createdAt),
]);

export const returnCaseItems = returnsSchema.table("return_case_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id, { onDelete: "cascade" }),
  wmsReturnItemId: bigint("wms_return_item_id", { mode: "number" }).notNull().references(() => returnItems.id),
  omsOrderLineId: bigint("oms_order_line_id", { mode: "number" }).references(() => omsOrderLines.id),
  wmsOrderItemId: integer("wms_order_item_id").references(() => orderItems.id),
  externalLineItemId: varchar("external_line_item_id", { length: 100 }),
  sku: varchar("sku", { length: 100 }),
  title: text("title"),
  quantity: integer("quantity").notNull(),
  unitPaidPriceCents: bigint("unit_paid_price_cents", { mode: "number" }).notNull(),
  sourceLineTotalCents: bigint("source_line_total_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_items_return_item_uq").on(table.returnCaseId, table.wmsReturnItemId),
  index("return_case_items_case_idx").on(table.returnCaseId),
]);

export const returnCaseInspections = returnsSchema.table("return_case_inspections", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 24 }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  startedBy: varchar("started_by", { length: 255 }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: varchar("completed_by", { length: 255 }),
  notes: text("notes"),
  completionNotes: text("completion_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_inspections_active_uq").on(table.returnCaseId).where(sql`${table.status} = 'in_progress'`),
  index("return_case_inspections_case_idx").on(table.returnCaseId, table.startedAt, table.id),
  check("return_case_inspections_status_chk", sql`${table.status} IN ('in_progress','approved','rejected','cancelled')`),
  check("return_case_inspections_completion_chk", sql`
    (${table.status} = 'in_progress' AND ${table.completedAt} IS NULL AND ${table.completedBy} IS NULL)
    OR (${table.status} <> 'in_progress' AND ${table.completedAt} IS NOT NULL AND ${table.completedBy} IS NOT NULL)
  `),
  check("return_case_inspections_time_chk", sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`),
]);

// Append-only operator evidence describing the intended physical treatment of
// received units. Recording this evidence does not mutate inventory, refund a
// customer, settle a vendor balance, or close the Return Case.
export const returnCaseDispositions = returnsSchema.table("return_case_dispositions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id),
  inspectionId: bigint("inspection_id", { mode: "number" }).references(() => returnCaseInspections.id),
  inspectionResolution: varchar("inspection_resolution", { length: 24 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  recordedBy: varchar("recorded_by", { length: 255 }).notNull(),
  notes: text("notes"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_dispositions_idempotency_uq").on(table.idempotencyKey),
  index("return_case_dispositions_case_idx").on(table.returnCaseId, table.recordedAt, table.id),
  index("return_case_dispositions_inspection_idx").on(table.inspectionId),
  check("return_case_dispositions_inspection_resolution_chk", sql`${table.inspectionResolution} IN ('approved','rejected','not_required')`),
  check("return_case_dispositions_inspection_evidence_chk", sql`
    (${table.inspectionResolution} IN ('approved','rejected') AND ${table.inspectionId} IS NOT NULL)
    OR (${table.inspectionResolution} = 'not_required' AND ${table.inspectionId} IS NULL)
  `),
  check("return_case_dispositions_idempotency_key_chk", sql`btrim(${table.idempotencyKey}) <> ''`),
  check("return_case_dispositions_request_hash_chk", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("return_case_dispositions_actor_chk", sql`btrim(${table.recordedBy}) <> ''`),
]);

export const returnCaseDispositionItems = returnsSchema.table("return_case_disposition_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  dispositionId: bigint("disposition_id", { mode: "number" }).notNull().references(() => returnCaseDispositions.id),
  returnCaseItemId: bigint("return_case_item_id", { mode: "number" }).notNull().references(() => returnCaseItems.id),
  treatment: varchar("treatment", { length: 32 }).notNull(),
  quantity: integer("quantity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_disposition_items_item_uq").on(
    table.dispositionId,
    table.returnCaseItemId,
  ),
  index("return_case_disposition_items_case_item_idx").on(table.returnCaseItemId, table.id),
  check("return_case_disposition_items_treatment_chk", sql`${table.treatment} IN ('restock_sellable','hold_non_sellable')`),
  check("return_case_disposition_items_quantity_chk", sql`${table.quantity} > 0`),
]);

export const returnCaseInventoryTreatments = returnsSchema.table("return_case_inventory_treatments", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  appliedBy: varchar("applied_by", { length: 255 }).notNull(),
  notes: text("notes"),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("return_case_inventory_treatments_idempotency_uq").on(table.idempotencyKey),
  index("return_case_inventory_treatments_case_idx").on(table.returnCaseId, table.appliedAt, table.id),
  check("return_case_inventory_treatments_idempotency_key_chk", sql`btrim(${table.idempotencyKey}) <> ''`),
  check("return_case_inventory_treatments_request_hash_chk", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("return_case_inventory_treatments_actor_chk", sql`btrim(${table.appliedBy}) <> ''`),
]);

export const returnCaseInventoryTreatmentItems = returnsSchema.table("return_case_inventory_treatment_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  inventoryTreatmentId: bigint("inventory_treatment_id", { mode: "number" }).notNull()
    .references(() => returnCaseInventoryTreatments.id),
  dispositionItemId: bigint("disposition_item_id", { mode: "number" }).notNull()
    .references(() => returnCaseDispositionItems.id),
  returnCaseItemId: bigint("return_case_item_id", { mode: "number" }).notNull()
    .references(() => returnCaseItems.id),
  treatment: varchar("treatment", { length: 32 }).$type<ReturnDispositionTreatment>().notNull(),
  quantity: integer("quantity").notNull(),
  warehouseLocationId: integer("warehouse_location_id")
    .references(() => warehouseLocations.id),
  inventoryTransactionId: integer("inventory_transaction_id")
    .references(() => inventoryTransactions.id),
  inventoryLotId: integer("inventory_lot_id")
    .references(() => inventoryLots.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("return_case_inventory_treatment_items_source_uq").on(table.dispositionItemId),
  index("return_case_inventory_treatment_items_case_item_idx").on(table.returnCaseItemId, table.id),
  check("return_case_inventory_treatment_items_treatment_chk", sql`${table.treatment} IN ('restock_sellable','hold_non_sellable')`),
  check("return_case_inventory_treatment_items_quantity_chk", sql`${table.quantity} > 0`),
  check("return_case_inventory_treatment_items_effect_chk", sql`
    (${table.treatment} = 'restock_sellable'
      AND ${table.warehouseLocationId} IS NOT NULL
      AND ${table.inventoryTransactionId} IS NOT NULL
      AND ${table.inventoryLotId} IS NOT NULL)
    OR (${table.treatment} = 'hold_non_sellable'
      AND ${table.warehouseLocationId} IS NULL
      AND ${table.inventoryTransactionId} IS NULL
      AND ${table.inventoryLotId} IS NULL)
  `),
]);

export const returnCaseCustomerRefunds = returnsSchema.table("return_case_customer_refunds", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  provider: varchar("provider", { length: 30 }).$type<"shopify">().notNull(),
  externalOrderId: varchar("external_order_id", { length: 100 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  maximumRefundableCents: bigint("maximum_refundable_cents", { mode: "number" }).notNull(),
  status: varchar("status", { length: 24 }).$type<"pending" | "completed" | "failed">().notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  quoteHash: varchar("quote_hash", { length: 64 }).notNull(),
  quote: jsonb("quote").notNull(),
  notifyCustomer: boolean("notify_customer").notNull(),
  requestedBy: varchar("requested_by", { length: 255 }).notNull(),
  notes: text("notes"),
  providerRefundId: varchar("provider_refund_id", { length: 160 }),
  providerResult: jsonb("provider_result"),
  failureCode: varchar("failure_code", { length: 160 }),
  failureMessage: text("failure_message"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_customer_refunds_idempotency_uq").on(table.idempotencyKey),
  uniqueIndex("return_case_customer_refunds_pending_uq").on(table.returnCaseId)
    .where(sql`${table.status} = 'pending'`),
  uniqueIndex("return_case_customer_refunds_completed_uq").on(table.returnCaseId)
    .where(sql`${table.status} = 'completed'`),
  uniqueIndex("return_case_customer_refunds_provider_id_uq").on(table.channelId, table.providerRefundId)
    .where(sql`${table.providerRefundId} IS NOT NULL`),
  index("return_case_customer_refunds_case_idx").on(table.returnCaseId, table.requestedAt, table.id),
  check("return_case_customer_refunds_provider_chk", sql`${table.provider} = 'shopify'`),
  check("return_case_customer_refunds_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("return_case_customer_refunds_amount_chk", sql`
    ${table.amountCents} > 0 AND ${table.maximumRefundableCents} >= ${table.amountCents}
  `),
  check("return_case_customer_refunds_status_chk", sql`${table.status} IN ('pending','completed','failed')`),
  check("return_case_customer_refunds_hash_chk", sql`
    ${table.requestHash} ~ '^[0-9a-f]{64}$' AND ${table.quoteHash} ~ '^[0-9a-f]{64}$'
  `),
  check("return_case_customer_refunds_quote_chk", sql`jsonb_typeof(${table.quote}) = 'object'`),
  check("return_case_customer_refunds_actor_chk", sql`btrim(${table.requestedBy}) <> ''`),
  check("return_case_customer_refunds_completion_chk", sql`
    (${table.status} = 'pending' AND ${table.providerRefundId} IS NULL AND ${table.providerResult} IS NULL
      AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL AND ${table.completedAt} IS NULL)
    OR (${table.status} = 'completed' AND ${table.providerRefundId} IS NOT NULL AND ${table.providerResult} IS NOT NULL
      AND ${table.failureCode} IS NULL AND ${table.failureMessage} IS NULL AND ${table.completedAt} IS NOT NULL)
    OR (${table.status} = 'failed' AND ${table.providerRefundId} IS NULL AND ${table.providerResult} IS NULL
      AND ${table.failureCode} IS NOT NULL AND ${table.failureMessage} IS NOT NULL AND ${table.completedAt} IS NOT NULL)
  `),
  check("return_case_customer_refunds_time_chk", sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.requestedAt}`),
]);

export const returnCaseCustomerRefundItems = returnsSchema.table("return_case_customer_refund_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  customerRefundId: bigint("customer_refund_id", { mode: "number" }).notNull()
    .references(() => returnCaseCustomerRefunds.id),
  returnCaseItemId: bigint("return_case_item_id", { mode: "number" }).notNull()
    .references(() => returnCaseItems.id),
  externalLineItemId: varchar("external_line_item_id", { length: 100 }).notNull(),
  quantity: integer("quantity").notNull(),
  subtotalCents: bigint("subtotal_cents", { mode: "number" }).notNull(),
  taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
  totalCents: bigint("total_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_customer_refund_items_item_uq").on(table.customerRefundId, table.returnCaseItemId),
  uniqueIndex("return_case_customer_refund_items_external_uq").on(table.customerRefundId, table.externalLineItemId),
  index("return_case_customer_refund_items_case_item_idx").on(table.returnCaseItemId, table.id),
  check("return_case_customer_refund_items_quantity_chk", sql`${table.quantity} > 0`),
  check("return_case_customer_refund_items_money_chk", sql`
    ${table.subtotalCents} >= 0 AND ${table.taxCents} >= 0
    AND ${table.totalCents} = ${table.subtotalCents} + ${table.taxCents}
  `),
]);

export const returnCaseCustomerRefundTransactions = returnsSchema.table("return_case_customer_refund_transactions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  customerRefundId: bigint("customer_refund_id", { mode: "number" }).notNull()
    .references(() => returnCaseCustomerRefunds.id),
  position: integer("position").notNull(),
  parentTransactionId: varchar("parent_transaction_id", { length: 160 }).notNull(),
  gateway: varchar("gateway", { length: 160 }).notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_customer_refund_transactions_position_uq").on(table.customerRefundId, table.position),
  uniqueIndex("return_case_customer_refund_transactions_parent_uq").on(table.customerRefundId, table.parentTransactionId),
  check("return_case_customer_refund_transactions_position_chk", sql`${table.position} >= 0`),
  check("return_case_customer_refund_transactions_amount_chk", sql`${table.amountCents} > 0`),
  check("return_case_customer_refund_transactions_text_chk", sql`
    btrim(${table.parentTransactionId}) <> '' AND btrim(${table.gateway}) <> ''
  `),
]);

export const returnCaseVendorSettlements = returnsSchema.table("return_case_vendor_settlements", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id),
  faultCategory: varchar("fault_category", { length: 24 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull(),
  productCreditCents: bigint("product_credit_cents", { mode: "number" }).notNull(),
  originalShippingCreditCents: bigint("original_shipping_credit_cents", { mode: "number" }).notNull(),
  restockingFeeCents: bigint("restocking_fee_cents", { mode: "number" }).notNull(),
  processingFeeCents: bigint("processing_fee_cents", { mode: "number" }).notNull(),
  returnShippingFeeCents: bigint("return_shipping_fee_cents", { mode: "number" }).notNull(),
  grossCreditCents: bigint("gross_credit_cents", { mode: "number" }).notNull(),
  totalFeeCents: bigint("total_fee_cents", { mode: "number" }).notNull(),
  netSettlementCents: bigint("net_settlement_cents", { mode: "number" }).notNull(),
  returnShippingActualCents: bigint("return_shipping_actual_cents", { mode: "number" }),
  restockingFeePolicyId: integer("restocking_fee_policy_id"),
  processingFeePolicyId: integer("processing_fee_policy_id"),
  returnShippingFeePolicyId: integer("return_shipping_fee_policy_id"),
  settlementBreakdown: jsonb("settlement_breakdown").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  quoteHash: varchar("quote_hash", { length: 64 }).notNull(),
  recordedBy: varchar("recorded_by", { length: 255 }).notNull(),
  notes: text("notes"),
  settledAt: timestamp("settled_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_vendor_settlements_case_uq").on(table.returnCaseId),
  uniqueIndex("return_case_vendor_settlements_idempotency_uq").on(table.idempotencyKey),
  index("return_case_vendor_settlements_vendor_idx").on(table.vendorId, table.settledAt, table.id),
  check("return_case_vendor_settlements_fault_chk", sql`${table.faultCategory} IN ('card_shellz','vendor','customer','marketplace','carrier')`),
  check("return_case_vendor_settlements_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  check("return_case_vendor_settlements_money_chk", sql`
    ${table.productCreditCents} >= 0 AND ${table.originalShippingCreditCents} >= 0
    AND ${table.restockingFeeCents} >= 0 AND ${table.processingFeeCents} >= 0
    AND ${table.returnShippingFeeCents} >= 0
    AND ${table.grossCreditCents} = ${table.productCreditCents} + ${table.originalShippingCreditCents}
    AND ${table.totalFeeCents} = ${table.restockingFeeCents} + ${table.processingFeeCents} + ${table.returnShippingFeeCents}
    AND ${table.netSettlementCents} = ${table.grossCreditCents} - ${table.totalFeeCents}
    AND (${table.returnShippingActualCents} IS NULL OR ${table.returnShippingActualCents} >= 0)
  `),
  check("return_case_vendor_settlements_hash_chk", sql`
    ${table.requestHash} ~ '^[0-9a-f]{64}$' AND ${table.quoteHash} ~ '^[0-9a-f]{64}$'
  `),
  check("return_case_vendor_settlements_breakdown_chk", sql`jsonb_typeof(${table.settlementBreakdown}) = 'object'`),
  check("return_case_vendor_settlements_actor_chk", sql`btrim(${table.recordedBy}) <> ''`),
]);

export const returnCaseVendorSettlementLedgerEntries = returnsSchema.table("return_case_vendor_settlement_ledger_entries", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  vendorSettlementId: bigint("vendor_settlement_id", { mode: "number" }).notNull()
    .references(() => returnCaseVendorSettlements.id),
  walletLedgerId: integer("wallet_ledger_id").notNull().references(() => dropshipWalletLedger.id),
  entryRole: varchar("entry_role", { length: 16 }).$type<"credit" | "fee">().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_vendor_settlement_ledger_entry_uq").on(table.vendorSettlementId, table.entryRole),
  uniqueIndex("return_case_vendor_settlement_wallet_ledger_uq").on(table.walletLedgerId),
  check("return_case_vendor_settlement_ledger_role_chk", sql`${table.entryRole} IN ('credit','fee')`),
]);

export const returnCaseCommands = returnsSchema.table("return_case_commands", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id, { onDelete: "cascade" }),
  commandType: varchar("command_type", { length: 50 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  response: jsonb("response").notNull(),
  actor: varchar("actor", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("return_case_commands_idempotency_uq").on(table.idempotencyKey),
  index("return_case_commands_case_idx").on(table.returnCaseId, table.createdAt, table.id),
  check("return_case_commands_type_chk", sql`${table.commandType} IN ('record_receipt','start_inspection','complete_inspection','record_disposition','apply_inventory_treatment','issue_customer_refund','settle_vendor_account')`),
  check("return_case_commands_hash_chk", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("return_case_commands_response_chk", sql`jsonb_typeof(${table.response}) = 'object'`),
]);
export const returnCaseEvents = returnsSchema.table("return_case_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  returnCaseId: bigint("return_case_id", { mode: "number" }).notNull().references(() => returnCases.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  actor: varchar("actor", { length: 255 }).notNull(),
  details: jsonb("details").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("return_case_events_case_idx").on(table.returnCaseId, table.occurredAt, table.id)]);

export type ReturnCase = typeof returnCases.$inferSelect;
export type InsertReturnCase = typeof returnCases.$inferInsert;
export type ReturnCaseItem = typeof returnCaseItems.$inferSelect;
export type InsertReturnCaseItem = typeof returnCaseItems.$inferInsert;
export type ReturnCaseEvent = typeof returnCaseEvents.$inferSelect;
export type InsertReturnCaseEvent = typeof returnCaseEvents.$inferInsert;
export type ReturnCaseInspection = typeof returnCaseInspections.$inferSelect;
export type InsertReturnCaseInspection = typeof returnCaseInspections.$inferInsert;
export type ReturnCaseCommand = typeof returnCaseCommands.$inferSelect;
export type InsertReturnCaseCommand = typeof returnCaseCommands.$inferInsert;
export type ReturnCaseDisposition = typeof returnCaseDispositions.$inferSelect;
export type InsertReturnCaseDisposition = typeof returnCaseDispositions.$inferInsert;
export type ReturnCaseDispositionItem = typeof returnCaseDispositionItems.$inferSelect;
export type InsertReturnCaseDispositionItem = typeof returnCaseDispositionItems.$inferInsert;
export type ReturnCaseInventoryTreatment = typeof returnCaseInventoryTreatments.$inferSelect;
export type InsertReturnCaseInventoryTreatment = typeof returnCaseInventoryTreatments.$inferInsert;
export type ReturnCaseInventoryTreatmentItem = typeof returnCaseInventoryTreatmentItems.$inferSelect;
export type InsertReturnCaseInventoryTreatmentItem = typeof returnCaseInventoryTreatmentItems.$inferInsert;
export type ReturnCaseCustomerRefund = typeof returnCaseCustomerRefunds.$inferSelect;
export type InsertReturnCaseCustomerRefund = typeof returnCaseCustomerRefunds.$inferInsert;
export type ReturnCaseCustomerRefundItem = typeof returnCaseCustomerRefundItems.$inferSelect;
export type InsertReturnCaseCustomerRefundItem = typeof returnCaseCustomerRefundItems.$inferInsert;
export type ReturnCaseCustomerRefundTransaction = typeof returnCaseCustomerRefundTransactions.$inferSelect;
export type InsertReturnCaseCustomerRefundTransaction = typeof returnCaseCustomerRefundTransactions.$inferInsert;
export type ReturnCaseVendorSettlement = typeof returnCaseVendorSettlements.$inferSelect;
export type InsertReturnCaseVendorSettlement = typeof returnCaseVendorSettlements.$inferInsert;
export type ReturnCaseVendorSettlementLedgerEntry = typeof returnCaseVendorSettlementLedgerEntries.$inferSelect;
export type InsertReturnCaseVendorSettlementLedgerEntry = typeof returnCaseVendorSettlementLedgerEntries.$inferInsert;
