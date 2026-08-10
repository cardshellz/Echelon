import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { channels } from "./channels.schema";
import { dropshipStoreConnections, dropshipVendors } from "./dropship.schema";

export const returnsSchema = pgSchema("returns");
export const returnPolicyScopeKinds = ["global", "business_context", "channel_context", "vendor_context", "vendor_channel_context", "store"] as const;
export type ReturnPolicyScopeKind = typeof returnPolicyScopeKinds[number];
export const returnBusinessContexts = ["retail", "dropship"] as const;
export type ReturnBusinessContext = typeof returnBusinessContexts[number];
export const returnDestinations = ["card_shellz", "vendor", "marketplace"] as const;
export const returnApprovalAuthorities = ["card_shellz", "marketplace", "vendor"] as const;
export const returnLabelProviders = ["shipstation", "marketplace", "vendor", "none"] as const;
export const returnShippingPayers = ["card_shellz", "vendor", "customer", "marketplace", "carrier"] as const;
export const returnInspectionRequirements = ["required", "conditional", "none"] as const;
export const returnInspectionOwners = ["card_shellz", "vendor", "marketplace"] as const;
export const returnRefundAuthorities = ["card_shellz", "marketplace", "vendor"] as const;
export const returnVendorSettlementTriggers = ["inspection_approved", "customer_refunded", "carrier_claim_paid", "none"] as const;

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
