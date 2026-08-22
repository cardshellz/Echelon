import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { channels } from "./channels.schema";
import { dropshipStoreConnections, dropshipVendors } from "./dropship.schema";
import { omsOrderLines, omsOrders } from "./oms.schema";
import { orderItems, orders, returnItems, returns } from "./orders.schema";

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
  check("return_case_commands_type_chk", sql`${table.commandType} IN ('record_receipt','start_inspection')`),
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
