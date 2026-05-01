import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { channels } from "./channels.schema";
import { productLines, products, productVariants } from "./catalog.schema";
import { members, memberSubscriptions, plans } from "./membership.schema";
import { omsOrders } from "./oms.schema";
import { warehouses } from "./warehouse.schema";

export const dropshipSchema = pgSchema("dropship");

export const DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES = 48 * 60;
export const DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS = 30;
export const DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS = 200;
export const DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS = 0;

export const dropshipVendorStatusEnum = [
  "onboarding",
  "active",
  "paused",
  "lapsed",
  "suspended",
  "closed",
] as const;
export type DropshipVendorStatus = typeof dropshipVendorStatusEnum[number];

export const dropshipSourcePlatformEnum = [
  "ebay",
  "shopify",
  "tiktok",
  "instagram",
  "bigcommerce",
] as const;
export type DropshipSourcePlatform = typeof dropshipSourcePlatformEnum[number];

export const dropshipStoreConnectionStatusEnum = [
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
  "disconnected",
] as const;
export type DropshipStoreConnectionStatus = typeof dropshipStoreConnectionStatusEnum[number];

export const dropshipScopeTypeEnum = [
  "catalog",
  "product_line",
  "category",
  "product",
  "variant",
] as const;
export type DropshipScopeType = typeof dropshipScopeTypeEnum[number];

export const dropshipRuleActionEnum = ["include", "exclude"] as const;
export type DropshipRuleAction = typeof dropshipRuleActionEnum[number];

export const dropshipListingStatusEnum = [
  "not_listed",
  "preview_ready",
  "queued",
  "pushing",
  "active",
  "paused",
  "ended",
  "failed",
  "blocked",
  "drift_detected",
] as const;
export type DropshipListingStatus = typeof dropshipListingStatusEnum[number];

export const dropshipPricingPolicyModeEnum = [
  "off",
  "warn_only",
  "block_listing_push",
  "block_order_acceptance",
] as const;
export type DropshipPricingPolicyMode = typeof dropshipPricingPolicyModeEnum[number];

export const dropshipWalletLedgerTypeEnum = [
  "funding",
  "order_debit",
  "refund_credit",
  "return_credit",
  "return_fee",
  "insurance_pool_credit",
  "manual_adjustment",
] as const;
export type DropshipWalletLedgerType = typeof dropshipWalletLedgerTypeEnum[number];

export const dropshipWalletLedgerStatusEnum = [
  "pending",
  "settled",
  "failed",
  "voided",
] as const;
export type DropshipWalletLedgerStatus = typeof dropshipWalletLedgerStatusEnum[number];

export const dropshipFundingRailEnum = [
  "stripe_ach",
  "stripe_card",
  "usdc_base",
  "manual",
] as const;
export type DropshipFundingRail = typeof dropshipFundingRailEnum[number];

export const dropshipOrderIntakeStatusEnum = [
  "received",
  "processing",
  "accepted",
  "rejected",
  "retrying",
  "failed",
  "payment_hold",
  "cancelled",
  "exception",
] as const;
export type DropshipOrderIntakeStatus = typeof dropshipOrderIntakeStatusEnum[number];

export const dropshipRmaStatusEnum = [
  "requested",
  "in_transit",
  "received",
  "inspecting",
  "approved",
  "rejected",
  "credited",
  "closed",
] as const;
export type DropshipRmaStatus = typeof dropshipRmaStatusEnum[number];

export const dropshipFaultCategoryEnum = [
  "card_shellz",
  "vendor",
  "customer",
  "marketplace",
  "carrier",
] as const;
export type DropshipFaultCategory = typeof dropshipFaultCategoryEnum[number];

export const dropshipNotificationChannelEnum = [
  "email",
  "in_app",
  "sms",
  "webhook",
] as const;
export type DropshipNotificationChannel = typeof dropshipNotificationChannelEnum[number];

export const dropshipAuthIdentityStatusEnum = ["active", "locked", "disabled"] as const;
export type DropshipAuthIdentityStatus = typeof dropshipAuthIdentityStatusEnum[number];

export const dropshipSensitiveActionEnum = [
  "account_bootstrap",
  "connect_store",
  "disconnect_store",
  "change_password",
  "change_contact_email",
  "password_reset",
  "register_passkey",
  "add_funding_method",
  "remove_funding_method",
  "wallet_funding_high_value",
  "bulk_listing_push",
  "high_risk_order_acceptance",
] as const;
export type DropshipSensitiveAction = typeof dropshipSensitiveActionEnum[number];

export const dropshipStepUpMethodEnum = ["passkey", "email_mfa"] as const;
export type DropshipStepUpMethod = typeof dropshipStepUpMethodEnum[number];

export const dropshipVendors = dropshipSchema.table("dropship_vendors", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  memberId: varchar("member_id", { length: 255 }).notNull().references(() => members.id),
  currentSubscriptionId: varchar("current_subscription_id", { length: 255 }).references(() => memberSubscriptions.id),
  currentPlanId: varchar("current_plan_id", { length: 255 }).references(() => plans.id),
  businessName: varchar("business_name", { length: 200 }),
  contactName: varchar("contact_name", { length: 200 }),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 50 }),
  status: varchar("status", { length: 30 }).notNull().default("onboarding"),
  entitlementStatus: varchar("entitlement_status", { length: 30 }).notNull().default("unknown"),
  entitlementCheckedAt: timestamp("entitlement_checked_at", { withTimezone: true }),
  membershipGraceEndsAt: timestamp("membership_grace_ends_at", { withTimezone: true }),
  includedStoreConnections: integer("included_store_connections").notNull().default(1),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_vendors_member_idx").on(table.memberId),
  index("dropship_vendors_status_idx").on(table.status),
  check("dropship_vendors_status_chk", sql`${table.status} IN ('onboarding','active','paused','lapsed','suspended','closed')`),
  check("dropship_vendors_store_count_chk", sql`${table.includedStoreConnections} >= 1`),
]);

export const dropshipAuthIdentities = dropshipSchema.table("dropship_auth_identities", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  memberId: varchar("member_id", { length: 255 }).notNull().references(() => members.id, { onDelete: "cascade" }),
  primaryEmail: varchar("primary_email", { length: 255 }).notNull(),
  passwordHash: text("password_hash"),
  passwordHashAlgorithm: varchar("password_hash_algorithm", { length: 40 }),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
  lastCardShellzProofAt: timestamp("last_card_shellz_proof_at", { withTimezone: true }),
  passkeyEnrolledAt: timestamp("passkey_enrolled_at", { withTimezone: true }),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_auth_identity_member_idx").on(table.memberId),
  uniqueIndex("dropship_auth_identity_email_idx").on(table.primaryEmail),
  check("dropship_auth_identity_status_chk", sql`${table.status} IN ('active','locked','disabled')`),
  check("dropship_auth_identity_password_chk", sql`
    (${table.passwordHash} IS NULL AND ${table.passwordHashAlgorithm} IS NULL AND ${table.passwordUpdatedAt} IS NULL)
    OR (${table.passwordHash} IS NOT NULL AND ${table.passwordHashAlgorithm} IS NOT NULL AND ${table.passwordUpdatedAt} IS NOT NULL)
  `),
]);

export const dropshipPasskeyCredentials = dropshipSchema.table("dropship_passkey_credentials", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  authIdentityId: integer("auth_identity_id").notNull().references(() => dropshipAuthIdentities.id, { onDelete: "cascade" }),
  memberId: varchar("member_id", { length: 255 }).notNull().references(() => members.id, { onDelete: "cascade" }),
  credentialId: varchar("credential_id", { length: 512 }).notNull(),
  publicKey: text("public_key").notNull(),
  signCount: integer("sign_count").notNull().default(0),
  transports: jsonb("transports"),
  aaguid: varchar("aaguid", { length: 80 }),
  backupEligible: boolean("backup_eligible"),
  backupState: boolean("backup_state"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("dropship_passkey_credential_idx").on(table.credentialId),
  index("dropship_passkey_member_idx").on(table.memberId),
  check("dropship_passkey_sign_count_chk", sql`${table.signCount} >= 0`),
]);

export const dropshipSensitiveActionChallenges = dropshipSchema.table("dropship_sensitive_action_challenges", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  memberId: varchar("member_id", { length: 255 }).notNull().references(() => members.id, { onDelete: "cascade" }),
  action: varchar("action", { length: 80 }).notNull(),
  method: varchar("method", { length: 30 }).notNull(),
  challengeHash: varchar("challenge_hash", { length: 255 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_sensitive_challenge_idem_idx").on(table.idempotencyKey),
  index("dropship_sensitive_challenge_member_idx").on(table.memberId, table.createdAt),
  check("dropship_sensitive_challenge_action_chk", sql`${table.action} IN ('account_bootstrap','connect_store','disconnect_store','change_password','change_contact_email','password_reset','register_passkey','add_funding_method','remove_funding_method','wallet_funding_high_value','bulk_listing_push','high_risk_order_acceptance')`),
  check("dropship_sensitive_challenge_method_chk", sql`${table.method} IN ('passkey','email_mfa')`),
  check("dropship_sensitive_challenge_attempts_chk", sql`${table.attempts} >= 0`),
]);

export const dropshipStoreConnections = dropshipSchema.table("dropship_store_connections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  platform: varchar("platform", { length: 30 }).notNull(),
  externalAccountId: varchar("external_account_id", { length: 255 }),
  externalDisplayName: varchar("external_display_name", { length: 255 }),
  shopDomain: varchar("shop_domain", { length: 255 }),
  accessTokenRef: text("access_token_ref"),
  refreshTokenRef: text("refresh_token_ref"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  status: varchar("status", { length: 30 }).notNull().default("disconnected"),
  setupStatus: varchar("setup_status", { length: 30 }).notNull().default("pending"),
  disconnectReason: text("disconnect_reason"),
  disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastOrderSyncAt: timestamp("last_order_sync_at", { withTimezone: true }),
  lastInventorySyncAt: timestamp("last_inventory_sync_at", { withTimezone: true }),
  config: jsonb("config"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_store_conn_vendor_idx").on(table.vendorId),
  index("dropship_store_conn_platform_idx").on(table.platform),
  uniqueIndex("dropship_store_conn_active_vendor_idx")
    .on(table.vendorId)
    .where(sql`status IN ('connected','needs_reauth','refresh_failed','grace_period','paused')`),
  check("dropship_store_conn_platform_chk", sql`${table.platform} IN ('ebay','shopify','tiktok','instagram','bigcommerce')`),
  check("dropship_store_conn_status_chk", sql`${table.status} IN ('connected','needs_reauth','refresh_failed','grace_period','paused','disconnected')`),
]);

export const dropshipStoreConnectionTokens = dropshipSchema.table("dropship_store_connection_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  storeConnectionId: integer("store_connection_id").notNull().references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  tokenKind: varchar("token_kind", { length: 30 }).notNull(),
  tokenRef: varchar("token_ref", { length: 160 }).notNull(),
  keyId: varchar("key_id", { length: 120 }).notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_store_token_ref_idx").on(table.tokenRef),
  uniqueIndex("dropship_store_token_connection_kind_idx").on(table.storeConnectionId, table.tokenKind),
  check("dropship_store_token_kind_chk", sql`${table.tokenKind} IN ('access','refresh')`),
  check("dropship_store_token_ref_chk", sql`length(${table.tokenRef}) >= 24`),
]);

export const dropshipStoreSetupChecks = dropshipSchema.table("dropship_store_setup_checks", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  checkKey: varchar("check_key", { length: 100 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  severity: varchar("severity", { length: 20 }).notNull().default("blocker"),
  message: text("message"),
  details: jsonb("details"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_setup_check_store_key_idx")
    .on(table.storeConnectionId, table.checkKey)
    .where(sql`${table.storeConnectionId} IS NOT NULL`),
  uniqueIndex("dropship_setup_check_vendor_key_idx")
    .on(table.vendorId, table.checkKey)
    .where(sql`${table.storeConnectionId} IS NULL`),
  index("dropship_setup_check_status_idx").on(table.status),
]);

export const dropshipSetupBlockers = dropshipSchema.table("dropship_setup_blockers", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }),
  blockerKey: varchar("blocker_key", { length: 120 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull().default("blocker"),
  status: varchar("status", { length: 30 }).notNull().default("open"),
  message: text("message").notNull(),
  details: jsonb("details"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_setup_blocker_entity_key_idx")
    .on(table.vendorId, table.entityType, table.entityId, table.blockerKey)
    .where(sql`${table.status} <> 'resolved'`),
  index("dropship_setup_blocker_status_idx").on(table.status),
  check("dropship_setup_blocker_status_chk", sql`${table.status} IN ('open','acknowledged','resolved')`),
]);

export const dropshipCatalogRuleSetRevisions = dropshipSchema.table("dropship_catalog_rule_set_revisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 128 }).notNull(),
  actorType: varchar("actor_type", { length: 40 }).notNull(),
  actorId: varchar("actor_id", { length: 255 }),
  ruleCount: integer("rule_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_catalog_rule_rev_idem_idx").on(table.idempotencyKey),
  index("dropship_catalog_rule_rev_created_idx").on(table.createdAt),
  check("dropship_catalog_rule_rev_actor_chk", sql`${table.actorType} IN ('admin','system')`),
  check("dropship_catalog_rule_rev_count_chk", sql`${table.ruleCount} >= 0`),
]);

export const dropshipCatalogRules = dropshipSchema.table("dropship_catalog_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  revisionId: integer("revision_id").references(() => dropshipCatalogRuleSetRevisions.id, { onDelete: "set null" }),
  scopeType: varchar("scope_type", { length: 30 }).notNull(),
  action: varchar("action", { length: 20 }).notNull().default("include"),
  productLineId: integer("product_line_id").references(() => productLines.id),
  productId: integer("product_id").references(() => products.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  category: varchar("category", { length: 200 }),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  notes: text("notes"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_catalog_rules_revision_idx").on(table.revisionId),
  index("dropship_catalog_rules_scope_idx").on(table.scopeType, table.isActive),
  check("dropship_catalog_rules_scope_chk", sql`${table.scopeType} IN ('catalog','product_line','category','product','variant')`),
  check("dropship_catalog_rules_action_chk", sql`${table.action} IN ('include','exclude')`),
  check("dropship_catalog_rules_target_chk", sql`
    (
      ${table.scopeType} = 'catalog'
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'product_line'
      AND ${table.productLineId} IS NOT NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'category'
      AND ${table.category} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
    )
    OR (
      ${table.scopeType} = 'product'
      AND ${table.productId} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'variant'
      AND ${table.productVariantId} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.category} IS NULL
    )
  `),
]);

export const dropshipVendorSelectionRuleSetRevisions = dropshipSchema.table("dropship_vendor_selection_rule_set_revisions", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 128 }).notNull(),
  actorType: varchar("actor_type", { length: 40 }).notNull(),
  actorId: varchar("actor_id", { length: 255 }),
  ruleCount: integer("rule_count").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_selection_rule_rev_vendor_idem_idx").on(table.vendorId, table.idempotencyKey),
  index("dropship_selection_rule_rev_vendor_created_idx").on(table.vendorId, table.createdAt),
  check("dropship_selection_rule_rev_actor_chk", sql`${table.actorType} IN ('vendor','admin','system')`),
  check("dropship_selection_rule_rev_count_chk", sql`${table.ruleCount} >= 0`),
]);

export const dropshipVendorSelectionRules = dropshipSchema.table("dropship_vendor_selection_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  revisionId: integer("revision_id").references(() => dropshipVendorSelectionRuleSetRevisions.id, { onDelete: "set null" }),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  scopeType: varchar("scope_type", { length: 30 }).notNull(),
  action: varchar("action", { length: 20 }).notNull().default("include"),
  productLineId: integer("product_line_id").references(() => productLines.id),
  productId: integer("product_id").references(() => products.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  category: varchar("category", { length: 200 }),
  autoConnectNewSkus: boolean("auto_connect_new_skus").notNull().default(true),
  autoListNewSkus: boolean("auto_list_new_skus").notNull().default(false),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_selection_rules_revision_idx").on(table.revisionId),
  index("dropship_selection_rules_vendor_idx").on(table.vendorId, table.isActive),
  check("dropship_selection_rules_scope_chk", sql`${table.scopeType} IN ('catalog','product_line','category','product','variant')`),
  check("dropship_selection_rules_action_chk", sql`${table.action} IN ('include','exclude')`),
  check("dropship_selection_rules_target_chk", sql`
    (
      ${table.scopeType} = 'catalog'
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'product_line'
      AND ${table.productLineId} IS NOT NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'category'
      AND ${table.category} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
    )
    OR (
      ${table.scopeType} = 'product'
      AND ${table.productId} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'variant'
      AND ${table.productVariantId} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.category} IS NULL
    )
  `),
]);

export const dropshipVendorVariantOverrides = dropshipSchema.table("dropship_vendor_variant_overrides", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  enabledOverride: boolean("enabled_override"),
  marketplaceQuantityCap: integer("marketplace_quantity_cap"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_variant_override_vendor_variant_idx").on(table.vendorId, table.productVariantId),
  check("dropship_variant_override_cap_chk", sql`${table.marketplaceQuantityCap} IS NULL OR ${table.marketplaceQuantityCap} >= 0`),
]);

export const dropshipPricingPolicies = dropshipSchema.table("dropship_pricing_policies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  scopeType: varchar("scope_type", { length: 30 }).notNull().default("catalog"),
  productLineId: integer("product_line_id").references(() => productLines.id),
  productId: integer("product_id").references(() => products.id),
  productVariantId: integer("product_variant_id").references(() => productVariants.id),
  category: varchar("category", { length: 200 }),
  mode: varchar("mode", { length: 40 }).notNull().default("warn_only"),
  floorPriceCents: bigint("floor_price_cents", { mode: "number" }),
  ceilingPriceCents: bigint("ceiling_price_cents", { mode: "number" }),
  warningMarginBps: integer("warning_margin_bps"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_pricing_policies_scope_idx").on(table.scopeType, table.isActive),
  check("dropship_pricing_policies_scope_chk", sql`${table.scopeType} IN ('catalog','product_line','category','product','variant')`),
  check("dropship_pricing_policies_mode_chk", sql`${table.mode} IN ('off','warn_only','block_listing_push','block_order_acceptance')`),
  check("dropship_pricing_policies_floor_chk", sql`${table.floorPriceCents} IS NULL OR ${table.floorPriceCents} >= 0`),
  check("dropship_pricing_policies_ceiling_chk", sql`${table.ceilingPriceCents} IS NULL OR ${table.ceilingPriceCents} >= 0`),
  check("dropship_pricing_policies_target_chk", sql`
    (
      ${table.scopeType} = 'catalog'
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'product_line'
      AND ${table.productLineId} IS NOT NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'category'
      AND ${table.category} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.productVariantId} IS NULL
    )
    OR (
      ${table.scopeType} = 'product'
      AND ${table.productId} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productVariantId} IS NULL
      AND ${table.category} IS NULL
    )
    OR (
      ${table.scopeType} = 'variant'
      AND ${table.productVariantId} IS NOT NULL
      AND ${table.productLineId} IS NULL
      AND ${table.productId} IS NULL
      AND ${table.category} IS NULL
    )
  `),
]);

export const dropshipVendorListings = dropshipSchema.table("dropship_vendor_listings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").notNull().references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  platform: varchar("platform", { length: 30 }).notNull(),
  externalListingId: varchar("external_listing_id", { length: 255 }),
  externalOfferId: varchar("external_offer_id", { length: 255 }),
  status: varchar("status", { length: 40 }).notNull().default("not_listed"),
  vendorRetailPriceCents: bigint("vendor_retail_price_cents", { mode: "number" }),
  observedMarketplacePriceCents: bigint("observed_marketplace_price_cents", { mode: "number" }),
  pushedQuantity: integer("pushed_quantity").notNull().default(0),
  quantityCap: integer("quantity_cap"),
  lastPreviewHash: varchar("last_preview_hash", { length: 128 }),
  driftDetectedAt: timestamp("drift_detected_at", { withTimezone: true }),
  lastPushedAt: timestamp("last_pushed_at", { withTimezone: true }),
  lastMarketplaceSyncAt: timestamp("last_marketplace_sync_at", { withTimezone: true }),
  pausedReason: text("paused_reason"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_listing_store_variant_idx").on(table.storeConnectionId, table.productVariantId),
  index("dropship_listing_vendor_status_idx").on(table.vendorId, table.status),
  check("dropship_listing_platform_chk", sql`${table.platform} IN ('ebay','shopify','tiktok','instagram','bigcommerce')`),
  check("dropship_listing_status_chk", sql`${table.status} IN ('not_listed','preview_ready','queued','pushing','active','paused','ended','failed','blocked','drift_detected')`),
  check("dropship_listing_price_chk", sql`${table.vendorRetailPriceCents} IS NULL OR ${table.vendorRetailPriceCents} >= 0`),
  check("dropship_listing_qty_chk", sql`${table.pushedQuantity} >= 0 AND (${table.quantityCap} IS NULL OR ${table.quantityCap} >= 0)`),
]);

export const dropshipListingPushJobs = dropshipSchema.table("dropship_listing_push_jobs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").notNull().references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  jobType: varchar("job_type", { length: 40 }).notNull().default("push"),
  status: varchar("status", { length: 30 }).notNull().default("queued"),
  requestedScope: jsonb("requested_scope"),
  requestedBy: varchar("requested_by", { length: 255 }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("dropship_listing_job_idem_idx").on(table.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  index("dropship_listing_job_status_idx").on(table.status),
  check("dropship_listing_job_status_chk", sql`${table.status} IN ('queued','processing','completed','failed','cancelled')`),
]);

export const dropshipListingPushJobItems = dropshipSchema.table("dropship_listing_push_job_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  jobId: integer("job_id").notNull().references(() => dropshipListingPushJobs.id, { onDelete: "cascade" }),
  listingId: integer("listing_id").references(() => dropshipVendorListings.id, { onDelete: "set null" }),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id),
  action: varchar("action", { length: 40 }).notNull().default("push"),
  status: varchar("status", { length: 30 }).notNull().default("queued"),
  previewHash: varchar("preview_hash", { length: 128 }),
  externalListingId: varchar("external_listing_id", { length: 255 }),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  result: jsonb("result"),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_listing_job_item_job_variant_idx").on(table.jobId, table.productVariantId),
  uniqueIndex("dropship_listing_job_item_idem_idx").on(table.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  index("dropship_listing_job_item_status_idx").on(table.status),
  check("dropship_listing_job_item_status_chk", sql`${table.status} IN ('queued','processing','completed','failed','blocked','cancelled')`),
]);

export const dropshipListingSyncEvents = dropshipSchema.table("dropship_listing_sync_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  listingId: integer("listing_id").notNull().references(() => dropshipVendorListings.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  source: varchar("source", { length: 40 }).notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_listing_sync_listing_idx").on(table.listingId),
]);

export const dropshipWalletAccounts = dropshipSchema.table("dropship_wallet_accounts", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  availableBalanceCents: bigint("available_balance_cents", { mode: "number" }).notNull().default(0),
  pendingBalanceCents: bigint("pending_balance_cents", { mode: "number" }).notNull().default(0),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_wallet_vendor_idx").on(table.vendorId),
  check("dropship_wallet_available_chk", sql`${table.availableBalanceCents} >= 0`),
  check("dropship_wallet_pending_chk", sql`${table.pendingBalanceCents} >= 0`),
]);

export const dropshipFundingMethods = dropshipSchema.table("dropship_funding_methods", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  rail: varchar("rail", { length: 40 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  providerCustomerId: varchar("provider_customer_id", { length: 255 }),
  providerPaymentMethodId: varchar("provider_payment_method_id", { length: 255 }),
  usdcWalletAddress: varchar("usdc_wallet_address", { length: 128 }),
  displayLabel: varchar("display_label", { length: 200 }),
  isDefault: boolean("is_default").notNull().default(false),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_funding_default_vendor_idx").on(table.vendorId).where(sql`is_default = true AND status = 'active'`),
  index("dropship_funding_vendor_idx").on(table.vendorId),
  check("dropship_funding_rail_chk", sql`${table.rail} IN ('stripe_ach','stripe_card','usdc_base','manual')`),
]);

export const dropshipAutoReloadSettings = dropshipSchema.table("dropship_auto_reload_settings", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  fundingMethodId: integer("funding_method_id").references(() => dropshipFundingMethods.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  minimumBalanceCents: bigint("minimum_balance_cents", { mode: "number" }).notNull().default(5000),
  maxSingleReloadCents: bigint("max_single_reload_cents", { mode: "number" }),
  paymentHoldTimeoutMinutes: integer("payment_hold_timeout_minutes").notNull().default(DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_auto_reload_vendor_idx").on(table.vendorId),
  check("dropship_auto_reload_min_chk", sql`${table.minimumBalanceCents} >= 0`),
  check("dropship_auto_reload_max_chk", sql`${table.maxSingleReloadCents} IS NULL OR ${table.maxSingleReloadCents} >= 0`),
  check("dropship_auto_reload_timeout_chk", sql`${table.paymentHoldTimeoutMinutes} > 0`),
]);

export const dropshipWalletLedger = dropshipSchema.table("dropship_wallet_ledger", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  walletAccountId: integer("wallet_account_id").references(() => dropshipWalletAccounts.id, { onDelete: "cascade" }),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 40 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  availableBalanceAfterCents: bigint("available_balance_after_cents", { mode: "number" }),
  pendingBalanceAfterCents: bigint("pending_balance_after_cents", { mode: "number" }),
  referenceType: varchar("reference_type", { length: 80 }),
  referenceId: varchar("reference_id", { length: 255 }),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  fundingMethodId: integer("funding_method_id").references(() => dropshipFundingMethods.id, { onDelete: "set null" }),
  externalTransactionId: varchar("external_transaction_id", { length: 255 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("dropship_wallet_ref_idx")
    .on(table.referenceType, table.referenceId)
    .where(sql`${table.referenceType} IS NOT NULL AND ${table.referenceId} IS NOT NULL`),
  uniqueIndex("dropship_wallet_idem_idx").on(table.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
  index("dropship_wallet_ledger_vendor_idx").on(table.vendorId),
  check("dropship_wallet_ledger_type_chk", sql`${table.type} IN ('funding','order_debit','refund_credit','return_credit','return_fee','insurance_pool_credit','manual_adjustment')`),
  check("dropship_wallet_ledger_status_chk", sql`${table.status} IN ('pending','settled','failed','voided')`),
  check("dropship_wallet_ledger_amount_chk", sql`${table.amountCents} <> 0`),
  check("dropship_wallet_ledger_reference_chk", sql`
    (${table.referenceType} IS NULL AND ${table.referenceId} IS NULL)
    OR (${table.referenceType} IS NOT NULL AND ${table.referenceId} IS NOT NULL)
  `),
  check("dropship_wallet_ledger_balance_chk", sql`
    (${table.availableBalanceAfterCents} IS NULL OR ${table.availableBalanceAfterCents} >= 0)
    AND (${table.pendingBalanceAfterCents} IS NULL OR ${table.pendingBalanceAfterCents} >= 0)
  `),
]);

export const dropshipBoxCatalog = dropshipSchema.table("dropship_box_catalog", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 80 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  lengthMm: integer("length_mm").notNull(),
  widthMm: integer("width_mm").notNull(),
  heightMm: integer("height_mm").notNull(),
  tareWeightGrams: integer("tare_weight_grams").notNull().default(0),
  maxWeightGrams: integer("max_weight_grams"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_box_code_idx").on(table.code),
  check("dropship_box_dims_chk", sql`${table.lengthMm} > 0 AND ${table.widthMm} > 0 AND ${table.heightMm} > 0 AND ${table.tareWeightGrams} >= 0`),
]);

export const dropshipPackageProfiles = dropshipSchema.table("dropship_package_profiles", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  weightGrams: integer("weight_grams").notNull(),
  lengthMm: integer("length_mm").notNull(),
  widthMm: integer("width_mm").notNull(),
  heightMm: integer("height_mm").notNull(),
  shipAlone: boolean("ship_alone").notNull().default(false),
  defaultCarrier: varchar("default_carrier", { length: 50 }),
  defaultService: varchar("default_service", { length: 80 }),
  defaultBoxId: integer("default_box_id").references(() => dropshipBoxCatalog.id, { onDelete: "set null" }),
  maxUnitsPerPackage: integer("max_units_per_package"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_package_profile_variant_idx").on(table.productVariantId),
  check("dropship_package_profile_dims_chk", sql`${table.weightGrams} > 0 AND ${table.lengthMm} > 0 AND ${table.widthMm} > 0 AND ${table.heightMm} > 0`),
  check("dropship_package_profile_units_chk", sql`${table.maxUnitsPerPackage} IS NULL OR ${table.maxUnitsPerPackage} > 0`),
]);

export const dropshipRateTables = dropshipSchema.table("dropship_rate_tables", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  carrier: varchar("carrier", { length: 50 }).notNull(),
  service: varchar("service", { length: 80 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_rate_table_carrier_service_idx").on(table.carrier, table.service, table.status),
]);

export const dropshipRateTableRows = dropshipSchema.table("dropship_rate_table_rows", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateTableId: integer("rate_table_id").notNull().references(() => dropshipRateTables.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
  destinationZone: varchar("destination_zone", { length: 40 }).notNull(),
  minWeightGrams: integer("min_weight_grams").notNull().default(0),
  maxWeightGrams: integer("max_weight_grams").notNull(),
  rateCents: bigint("rate_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_rate_row_band_idx").on(table.rateTableId, table.warehouseId, table.destinationZone, table.minWeightGrams, table.maxWeightGrams),
  check("dropship_rate_row_weight_chk", sql`${table.minWeightGrams} >= 0 AND ${table.maxWeightGrams} >= ${table.minWeightGrams}`),
  check("dropship_rate_row_rate_chk", sql`${table.rateCents} >= 0`),
]);

export const dropshipZoneRules = dropshipSchema.table("dropship_zone_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  originWarehouseId: integer("origin_warehouse_id").notNull().references(() => warehouses.id, { onDelete: "cascade" }),
  destinationCountry: varchar("destination_country", { length: 2 }).notNull().default("US"),
  destinationRegion: varchar("destination_region", { length: 100 }),
  postalPrefix: varchar("postal_prefix", { length: 20 }),
  zone: varchar("zone", { length: 40 }).notNull(),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_zone_rules_lookup_idx").on(table.originWarehouseId, table.destinationCountry, table.postalPrefix, table.isActive),
]);

export const dropshipInsurancePoolConfig = dropshipSchema.table("dropship_insurance_pool_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 120 }).notNull(),
  feeBps: integer("fee_bps").notNull().default(DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS),
  minFeeCents: bigint("min_fee_cents", { mode: "number" }),
  maxFeeCents: bigint("max_fee_cents", { mode: "number" }),
  isActive: boolean("is_active").notNull().default(true),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("dropship_insurance_bps_chk", sql`${table.feeBps} >= 0 AND ${table.feeBps} <= 10000`),
  check("dropship_insurance_fee_bounds_chk", sql`
    (${table.minFeeCents} IS NULL OR ${table.minFeeCents} >= 0)
    AND (${table.maxFeeCents} IS NULL OR ${table.maxFeeCents} >= 0)
    AND (${table.minFeeCents} IS NULL OR ${table.maxFeeCents} IS NULL OR ${table.maxFeeCents} >= ${table.minFeeCents})
  `),
]);

export const dropshipShippingMarkupConfig = dropshipSchema.table("dropship_shipping_markup_config", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 120 }).notNull(),
  markupBps: integer("markup_bps").notNull().default(DROPSHIP_DEFAULT_SHIPPING_MARKUP_BPS),
  fixedMarkupCents: bigint("fixed_markup_cents", { mode: "number" }).notNull().default(0),
  minMarkupCents: bigint("min_markup_cents", { mode: "number" }),
  maxMarkupCents: bigint("max_markup_cents", { mode: "number" }),
  isActive: boolean("is_active").notNull().default(true),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).defaultNow().notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("dropship_shipping_markup_bps_chk", sql`${table.markupBps} >= 0 AND ${table.markupBps} <= 10000`),
  check("dropship_shipping_markup_bounds_chk", sql`
    ${table.fixedMarkupCents} >= 0
    AND (${table.minMarkupCents} IS NULL OR ${table.minMarkupCents} >= 0)
    AND (${table.maxMarkupCents} IS NULL OR ${table.maxMarkupCents} >= 0)
    AND (${table.minMarkupCents} IS NULL OR ${table.maxMarkupCents} IS NULL OR ${table.maxMarkupCents} >= ${table.minMarkupCents})
  `),
]);

export const dropshipShippingQuoteSnapshots = dropshipSchema.table("dropship_shipping_quote_snapshots", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id, { onDelete: "set null" }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  rateTableId: integer("rate_table_id").references(() => dropshipRateTables.id),
  destinationCountry: varchar("destination_country", { length: 2 }).notNull().default("US"),
  destinationPostalCode: varchar("destination_postal_code", { length: 20 }),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  requestHash: varchar("request_hash", { length: 128 }),
  packageCount: integer("package_count").notNull(),
  baseRateCents: bigint("base_rate_cents", { mode: "number" }).notNull(),
  markupCents: bigint("markup_cents", { mode: "number" }).notNull().default(0),
  insurancePoolCents: bigint("insurance_pool_cents", { mode: "number" }).notNull().default(0),
  dunnageCents: bigint("dunnage_cents", { mode: "number" }).notNull().default(0),
  totalShippingCents: bigint("total_shipping_cents", { mode: "number" }).notNull(),
  quotePayload: jsonb("quote_payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_shipping_quote_vendor_idx").on(table.vendorId, table.createdAt),
  uniqueIndex("dropship_shipping_quote_vendor_idem_idx")
    .on(table.vendorId, table.idempotencyKey)
    .where(sql`idempotency_key IS NOT NULL`),
  check("dropship_shipping_quote_total_chk", sql`
    ${table.packageCount} > 0
    AND ${table.baseRateCents} >= 0
    AND ${table.markupCents} >= 0
    AND ${table.insurancePoolCents} >= 0
    AND ${table.dunnageCents} >= 0
    AND ${table.totalShippingCents} >= 0
  `),
]);

export const dropshipOrderIntake = dropshipSchema.table("dropship_order_intake", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").notNull().references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  platform: varchar("platform", { length: 30 }).notNull(),
  externalOrderId: varchar("external_order_id", { length: 255 }).notNull(),
  externalOrderNumber: varchar("external_order_number", { length: 100 }),
  sourceOrderId: varchar("source_order_id", { length: 255 }),
  status: varchar("status", { length: 40 }).notNull().default("received"),
  paymentHoldExpiresAt: timestamp("payment_hold_expires_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  cancellationStatus: varchar("cancellation_status", { length: 40 }),
  rawPayload: jsonb("raw_payload"),
  normalizedPayload: jsonb("normalized_payload"),
  payloadHash: varchar("payload_hash", { length: 128 }),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).references(() => omsOrders.id, { onDelete: "set null" }),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_order_intake_store_external_idx").on(table.storeConnectionId, table.externalOrderId),
  index("dropship_order_intake_status_idx").on(table.status),
  index("dropship_order_intake_vendor_idx").on(table.vendorId, table.receivedAt),
  check("dropship_order_intake_platform_chk", sql`${table.platform} IN ('ebay','shopify','tiktok','instagram','bigcommerce')`),
  check("dropship_order_intake_status_chk", sql`${table.status} IN ('received','processing','accepted','rejected','retrying','failed','payment_hold','cancelled','exception')`),
]);

export const dropshipOrderEconomicsSnapshots = dropshipSchema.table("dropship_order_economics_snapshots", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  intakeId: integer("intake_id").notNull().references(() => dropshipOrderIntake.id, { onDelete: "cascade" }),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).references(() => omsOrders.id, { onDelete: "set null" }),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").notNull().references(() => dropshipStoreConnections.id, { onDelete: "cascade" }),
  memberId: varchar("member_id", { length: 255 }).notNull(),
  membershipPlanId: varchar("membership_plan_id", { length: 255 }),
  shippingQuoteSnapshotId: integer("shipping_quote_snapshot_id").references(() => dropshipShippingQuoteSnapshots.id, { onDelete: "set null" }),
  warehouseId: integer("warehouse_id").references(() => warehouses.id),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  retailSubtotalCents: bigint("retail_subtotal_cents", { mode: "number" }).notNull(),
  wholesaleSubtotalCents: bigint("wholesale_subtotal_cents", { mode: "number" }).notNull(),
  shippingCents: bigint("shipping_cents", { mode: "number" }).notNull(),
  insurancePoolCents: bigint("insurance_pool_cents", { mode: "number" }).notNull().default(0),
  feesCents: bigint("fees_cents", { mode: "number" }).notNull().default(0),
  totalDebitCents: bigint("total_debit_cents", { mode: "number" }).notNull(),
  pricingSnapshot: jsonb("pricing_snapshot"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_order_econ_intake_idx").on(table.intakeId),
  check("dropship_order_econ_nonnegative_chk", sql`${table.retailSubtotalCents} >= 0 AND ${table.wholesaleSubtotalCents} >= 0 AND ${table.shippingCents} >= 0 AND ${table.totalDebitCents} >= 0`),
]);

export const dropshipRmas = dropshipSchema.table("dropship_rmas", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rmaNumber: varchar("rma_number", { length: 80 }).notNull(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id, { onDelete: "set null" }),
  intakeId: integer("intake_id").references(() => dropshipOrderIntake.id, { onDelete: "set null" }),
  omsOrderId: bigint("oms_order_id", { mode: "number" }).references(() => omsOrders.id, { onDelete: "set null" }),
  status: varchar("status", { length: 40 }).notNull().default("requested"),
  reasonCode: varchar("reason_code", { length: 80 }),
  faultCategory: varchar("fault_category", { length: 40 }),
  returnWindowDays: integer("return_window_days").notNull().default(DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS),
  labelSource: varchar("label_source", { length: 40 }),
  returnTrackingNumber: varchar("return_tracking_number", { length: 120 }),
  vendorNotes: text("vendor_notes"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  inspectedAt: timestamp("inspected_at", { withTimezone: true }),
  creditedAt: timestamp("credited_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_rma_number_idx").on(table.rmaNumber),
  index("dropship_rma_vendor_status_idx").on(table.vendorId, table.status),
  check("dropship_rma_status_chk", sql`${table.status} IN ('requested','in_transit','received','inspecting','approved','rejected','credited','closed')`),
  check("dropship_rma_window_chk", sql`${table.returnWindowDays} > 0`),
  check("dropship_rma_fault_chk", sql`${table.faultCategory} IS NULL OR ${table.faultCategory} IN ('card_shellz','vendor','customer','marketplace','carrier')`),
]);

export const dropshipRmaItems = dropshipSchema.table("dropship_rma_items", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rmaId: integer("rma_id").notNull().references(() => dropshipRmas.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").references(() => productVariants.id, { onDelete: "set null" }),
  quantity: integer("quantity").notNull(),
  status: varchar("status", { length: 40 }).notNull().default("requested"),
  requestedCreditCents: bigint("requested_credit_cents", { mode: "number" }),
  finalCreditCents: bigint("final_credit_cents", { mode: "number" }),
  feeCents: bigint("fee_cents", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("dropship_rma_item_qty_chk", sql`${table.quantity} > 0`),
  check("dropship_rma_item_money_chk", sql`
    (${table.requestedCreditCents} IS NULL OR ${table.requestedCreditCents} >= 0)
    AND (${table.finalCreditCents} IS NULL OR ${table.finalCreditCents} >= 0)
    AND (${table.feeCents} IS NULL OR ${table.feeCents} >= 0)
  `),
]);

export const dropshipRmaInspections = dropshipSchema.table("dropship_rma_inspections", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rmaId: integer("rma_id").notNull().references(() => dropshipRmas.id, { onDelete: "cascade" }),
  outcome: varchar("outcome", { length: 40 }).notNull(),
  faultCategory: varchar("fault_category", { length: 40 }),
  notes: text("notes"),
  photos: jsonb("photos"),
  creditCents: bigint("credit_cents", { mode: "number" }).notNull().default(0),
  feeCents: bigint("fee_cents", { mode: "number" }).notNull().default(0),
  inspectedBy: varchar("inspected_by", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_rma_inspection_rma_idx").on(table.rmaId),
  check("dropship_rma_inspection_fault_chk", sql`${table.faultCategory} IS NULL OR ${table.faultCategory} IN ('card_shellz','vendor','customer','marketplace','carrier')`),
  check("dropship_rma_inspection_money_chk", sql`${table.creditCents} >= 0 AND ${table.feeCents} >= 0`),
]);

export const dropshipCarrierClaims = dropshipSchema.table("dropship_carrier_claims", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rmaId: integer("rma_id").references(() => dropshipRmas.id, { onDelete: "set null" }),
  intakeId: integer("intake_id").references(() => dropshipOrderIntake.id, { onDelete: "set null" }),
  carrier: varchar("carrier", { length: 80 }),
  trackingNumber: varchar("tracking_number", { length: 120 }),
  status: varchar("status", { length: 40 }).notNull().default("pending"),
  externalClaimId: varchar("external_claim_id", { length: 255 }),
  claimAmountCents: bigint("claim_amount_cents", { mode: "number" }),
  insurancePoolCreditCents: bigint("insurance_pool_credit_cents", { mode: "number" }),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_carrier_claim_status_idx").on(table.status),
  check("dropship_carrier_claim_money_chk", sql`
    (${table.claimAmountCents} IS NULL OR ${table.claimAmountCents} >= 0)
    AND (${table.insurancePoolCreditCents} IS NULL OR ${table.insurancePoolCreditCents} >= 0)
  `),
]);

export const dropshipNotificationEvents = dropshipSchema.table("dropship_notification_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  channel: varchar("channel", { length: 30 }).notNull(),
  critical: boolean("critical").notNull().default(false),
  title: varchar("title", { length: 300 }).notNull(),
  message: text("message"),
  payload: jsonb("payload"),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_notification_vendor_idx").on(table.vendorId, table.createdAt),
  check("dropship_notification_channel_chk", sql`${table.channel} IN ('email','in_app','sms','webhook')`),
]);

export const dropshipNotificationPreferences = dropshipSchema.table("dropship_notification_preferences", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  eventType: varchar("event_type", { length: 100 }).notNull(),
  critical: boolean("critical").notNull().default(false),
  emailEnabled: boolean("email_enabled").notNull().default(true),
  inAppEnabled: boolean("in_app_enabled").notNull().default(true),
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  webhookEnabled: boolean("webhook_enabled").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("dropship_notification_pref_vendor_event_idx").on(table.vendorId, table.eventType),
  check("dropship_notification_pref_critical_chk", sql`critical = false OR (email_enabled = true AND in_app_enabled = true)`),
]);

export const dropshipAuditEvents = dropshipSchema.table("dropship_audit_events", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").references(() => dropshipVendors.id, { onDelete: "set null" }),
  storeConnectionId: integer("store_connection_id").references(() => dropshipStoreConnections.id, { onDelete: "set null" }),
  entityType: varchar("entity_type", { length: 80 }).notNull(),
  entityId: varchar("entity_id", { length: 255 }),
  eventType: varchar("event_type", { length: 120 }).notNull(),
  actorType: varchar("actor_type", { length: 40 }).notNull().default("system"),
  actorId: varchar("actor_id", { length: 255 }),
  severity: varchar("severity", { length: 20 }).notNull().default("info"),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("dropship_audit_vendor_created_idx").on(table.vendorId, table.createdAt),
  index("dropship_audit_entity_idx").on(table.entityType, table.entityId),
]);

export const dropshipUsdcLedgerEntries = dropshipSchema.table("dropship_usdc_ledger_entries", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  vendorId: integer("vendor_id").notNull().references(() => dropshipVendors.id, { onDelete: "cascade" }),
  walletLedgerId: integer("wallet_ledger_id").references(() => dropshipWalletLedger.id, { onDelete: "set null" }),
  chainId: integer("chain_id").notNull().default(8453),
  transactionHash: varchar("transaction_hash", { length: 100 }).notNull(),
  fromAddress: varchar("from_address", { length: 128 }),
  toAddress: varchar("to_address", { length: 128 }),
  amountAtomicUnits: numeric("amount_atomic_units", { precision: 78, scale: 0 }).notNull(),
  confirmations: integer("confirmations").notNull().default(0),
  status: varchar("status", { length: 30 }).notNull().default("pending"),
  observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  settledAt: timestamp("settled_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("dropship_usdc_tx_idx").on(table.chainId, table.transactionHash),
  check("dropship_usdc_amount_chk", sql`${table.amountAtomicUnits} > 0`),
  check("dropship_usdc_confirmations_chk", sql`${table.confirmations} >= 0`),
]);

const omitGenerated = {
  id: true,
  createdAt: true,
  updatedAt: true,
} as const;

const omitIdCreated = {
  id: true,
  createdAt: true,
} as const;

export const insertDropshipVendorSchema = createInsertSchema(dropshipVendors).omit(omitGenerated);
export type InsertDropshipVendor = z.infer<typeof insertDropshipVendorSchema>;
export type DropshipVendor = typeof dropshipVendors.$inferSelect;

export const insertDropshipAuthIdentitySchema = createInsertSchema(dropshipAuthIdentities).omit(omitGenerated);
export type InsertDropshipAuthIdentity = z.infer<typeof insertDropshipAuthIdentitySchema>;
export type DropshipAuthIdentity = typeof dropshipAuthIdentities.$inferSelect;

export const insertDropshipPasskeyCredentialSchema = createInsertSchema(dropshipPasskeyCredentials).omit(omitIdCreated);
export type InsertDropshipPasskeyCredential = z.infer<typeof insertDropshipPasskeyCredentialSchema>;
export type DropshipPasskeyCredential = typeof dropshipPasskeyCredentials.$inferSelect;

export const insertDropshipSensitiveActionChallengeSchema = createInsertSchema(dropshipSensitiveActionChallenges).omit(omitIdCreated);
export type InsertDropshipSensitiveActionChallenge = z.infer<typeof insertDropshipSensitiveActionChallengeSchema>;
export type DropshipSensitiveActionChallenge = typeof dropshipSensitiveActionChallenges.$inferSelect;

export const insertDropshipStoreConnectionSchema = createInsertSchema(dropshipStoreConnections).omit(omitGenerated);
export type InsertDropshipStoreConnection = z.infer<typeof insertDropshipStoreConnectionSchema>;
export type DropshipStoreConnection = typeof dropshipStoreConnections.$inferSelect;

export const insertDropshipStoreConnectionTokenSchema = createInsertSchema(dropshipStoreConnectionTokens).omit(omitGenerated);
export type InsertDropshipStoreConnectionToken = z.infer<typeof insertDropshipStoreConnectionTokenSchema>;
export type DropshipStoreConnectionToken = typeof dropshipStoreConnectionTokens.$inferSelect;

export const insertDropshipStoreSetupCheckSchema = createInsertSchema(dropshipStoreSetupChecks).omit(omitGenerated);
export type InsertDropshipStoreSetupCheck = z.infer<typeof insertDropshipStoreSetupCheckSchema>;
export type DropshipStoreSetupCheck = typeof dropshipStoreSetupChecks.$inferSelect;

export const insertDropshipSetupBlockerSchema = createInsertSchema(dropshipSetupBlockers).omit(omitGenerated);
export type InsertDropshipSetupBlocker = z.infer<typeof insertDropshipSetupBlockerSchema>;
export type DropshipSetupBlocker = typeof dropshipSetupBlockers.$inferSelect;

export const insertDropshipCatalogRuleSetRevisionSchema = createInsertSchema(dropshipCatalogRuleSetRevisions).omit(omitIdCreated);
export type InsertDropshipCatalogRuleSetRevision = z.infer<typeof insertDropshipCatalogRuleSetRevisionSchema>;
export type DropshipCatalogRuleSetRevision = typeof dropshipCatalogRuleSetRevisions.$inferSelect;

export const insertDropshipCatalogRuleSchema = createInsertSchema(dropshipCatalogRules).omit(omitGenerated);
export type InsertDropshipCatalogRule = z.infer<typeof insertDropshipCatalogRuleSchema>;
export type DropshipCatalogRule = typeof dropshipCatalogRules.$inferSelect;

export const insertDropshipVendorSelectionRuleSetRevisionSchema = createInsertSchema(dropshipVendorSelectionRuleSetRevisions).omit(omitIdCreated);
export type InsertDropshipVendorSelectionRuleSetRevision = z.infer<typeof insertDropshipVendorSelectionRuleSetRevisionSchema>;
export type DropshipVendorSelectionRuleSetRevision = typeof dropshipVendorSelectionRuleSetRevisions.$inferSelect;

export const insertDropshipVendorSelectionRuleSchema = createInsertSchema(dropshipVendorSelectionRules).omit(omitGenerated);
export type InsertDropshipVendorSelectionRule = z.infer<typeof insertDropshipVendorSelectionRuleSchema>;
export type DropshipVendorSelectionRule = typeof dropshipVendorSelectionRules.$inferSelect;

export const insertDropshipVendorVariantOverrideSchema = createInsertSchema(dropshipVendorVariantOverrides).omit(omitGenerated);
export type InsertDropshipVendorVariantOverride = z.infer<typeof insertDropshipVendorVariantOverrideSchema>;
export type DropshipVendorVariantOverride = typeof dropshipVendorVariantOverrides.$inferSelect;

export const insertDropshipPricingPolicySchema = createInsertSchema(dropshipPricingPolicies).omit(omitGenerated);
export type InsertDropshipPricingPolicy = z.infer<typeof insertDropshipPricingPolicySchema>;
export type DropshipPricingPolicy = typeof dropshipPricingPolicies.$inferSelect;

export const insertDropshipVendorListingSchema = createInsertSchema(dropshipVendorListings).omit(omitGenerated);
export type InsertDropshipVendorListing = z.infer<typeof insertDropshipVendorListingSchema>;
export type DropshipVendorListing = typeof dropshipVendorListings.$inferSelect;

export const insertDropshipListingPushJobSchema = createInsertSchema(dropshipListingPushJobs).omit(omitGenerated);
export type InsertDropshipListingPushJob = z.infer<typeof insertDropshipListingPushJobSchema>;
export type DropshipListingPushJob = typeof dropshipListingPushJobs.$inferSelect;

export const insertDropshipListingPushJobItemSchema = createInsertSchema(dropshipListingPushJobItems).omit(omitGenerated);
export type InsertDropshipListingPushJobItem = z.infer<typeof insertDropshipListingPushJobItemSchema>;
export type DropshipListingPushJobItem = typeof dropshipListingPushJobItems.$inferSelect;

export const insertDropshipListingSyncEventSchema = createInsertSchema(dropshipListingSyncEvents).omit(omitIdCreated);
export type InsertDropshipListingSyncEvent = z.infer<typeof insertDropshipListingSyncEventSchema>;
export type DropshipListingSyncEvent = typeof dropshipListingSyncEvents.$inferSelect;

export const insertDropshipWalletAccountSchema = createInsertSchema(dropshipWalletAccounts).omit(omitGenerated);
export type InsertDropshipWalletAccount = z.infer<typeof insertDropshipWalletAccountSchema>;
export type DropshipWalletAccount = typeof dropshipWalletAccounts.$inferSelect;

export const insertDropshipFundingMethodSchema = createInsertSchema(dropshipFundingMethods).omit(omitGenerated);
export type InsertDropshipFundingMethod = z.infer<typeof insertDropshipFundingMethodSchema>;
export type DropshipFundingMethod = typeof dropshipFundingMethods.$inferSelect;

export const insertDropshipAutoReloadSettingSchema = createInsertSchema(dropshipAutoReloadSettings).omit(omitGenerated);
export type InsertDropshipAutoReloadSetting = z.infer<typeof insertDropshipAutoReloadSettingSchema>;
export type DropshipAutoReloadSetting = typeof dropshipAutoReloadSettings.$inferSelect;

export const insertDropshipWalletLedgerSchema = createInsertSchema(dropshipWalletLedger).omit(omitIdCreated);
export type InsertDropshipWalletLedger = z.infer<typeof insertDropshipWalletLedgerSchema>;
export type DropshipWalletLedger = typeof dropshipWalletLedger.$inferSelect;

export const insertDropshipBoxCatalogSchema = createInsertSchema(dropshipBoxCatalog).omit(omitGenerated);
export type InsertDropshipBoxCatalog = z.infer<typeof insertDropshipBoxCatalogSchema>;
export type DropshipBoxCatalog = typeof dropshipBoxCatalog.$inferSelect;

export const insertDropshipPackageProfileSchema = createInsertSchema(dropshipPackageProfiles).omit(omitGenerated);
export type InsertDropshipPackageProfile = z.infer<typeof insertDropshipPackageProfileSchema>;
export type DropshipPackageProfile = typeof dropshipPackageProfiles.$inferSelect;

export const insertDropshipRateTableSchema = createInsertSchema(dropshipRateTables).omit(omitIdCreated);
export type InsertDropshipRateTable = z.infer<typeof insertDropshipRateTableSchema>;
export type DropshipRateTable = typeof dropshipRateTables.$inferSelect;

export const insertDropshipRateTableRowSchema = createInsertSchema(dropshipRateTableRows).omit(omitIdCreated);
export type InsertDropshipRateTableRow = z.infer<typeof insertDropshipRateTableRowSchema>;
export type DropshipRateTableRow = typeof dropshipRateTableRows.$inferSelect;

export const insertDropshipZoneRuleSchema = createInsertSchema(dropshipZoneRules).omit(omitGenerated);
export type InsertDropshipZoneRule = z.infer<typeof insertDropshipZoneRuleSchema>;
export type DropshipZoneRule = typeof dropshipZoneRules.$inferSelect;

export const insertDropshipInsurancePoolConfigSchema = createInsertSchema(dropshipInsurancePoolConfig).omit(omitIdCreated);
export type InsertDropshipInsurancePoolConfig = z.infer<typeof insertDropshipInsurancePoolConfigSchema>;
export type DropshipInsurancePoolConfig = typeof dropshipInsurancePoolConfig.$inferSelect;

export const insertDropshipShippingMarkupConfigSchema = createInsertSchema(dropshipShippingMarkupConfig).omit(omitIdCreated);
export type InsertDropshipShippingMarkupConfig = z.infer<typeof insertDropshipShippingMarkupConfigSchema>;
export type DropshipShippingMarkupConfig = typeof dropshipShippingMarkupConfig.$inferSelect;

export const insertDropshipShippingQuoteSnapshotSchema = createInsertSchema(dropshipShippingQuoteSnapshots).omit(omitIdCreated);
export type InsertDropshipShippingQuoteSnapshot = z.infer<typeof insertDropshipShippingQuoteSnapshotSchema>;
export type DropshipShippingQuoteSnapshot = typeof dropshipShippingQuoteSnapshots.$inferSelect;

export const insertDropshipOrderIntakeSchema = createInsertSchema(dropshipOrderIntake).omit({
  id: true,
  receivedAt: true,
  updatedAt: true,
} as const);
export type InsertDropshipOrderIntake = z.infer<typeof insertDropshipOrderIntakeSchema>;
export type DropshipOrderIntake = typeof dropshipOrderIntake.$inferSelect;

export const insertDropshipOrderEconomicsSnapshotSchema = createInsertSchema(dropshipOrderEconomicsSnapshots).omit(omitIdCreated);
export type InsertDropshipOrderEconomicsSnapshot = z.infer<typeof insertDropshipOrderEconomicsSnapshotSchema>;
export type DropshipOrderEconomicsSnapshot = typeof dropshipOrderEconomicsSnapshots.$inferSelect;

export const insertDropshipRmaSchema = createInsertSchema(dropshipRmas).omit({
  id: true,
  requestedAt: true,
  updatedAt: true,
} as const);
export type InsertDropshipRma = z.infer<typeof insertDropshipRmaSchema>;
export type DropshipRma = typeof dropshipRmas.$inferSelect;

export const insertDropshipRmaItemSchema = createInsertSchema(dropshipRmaItems).omit(omitIdCreated);
export type InsertDropshipRmaItem = z.infer<typeof insertDropshipRmaItemSchema>;
export type DropshipRmaItem = typeof dropshipRmaItems.$inferSelect;

export const insertDropshipRmaInspectionSchema = createInsertSchema(dropshipRmaInspections).omit(omitIdCreated);
export type InsertDropshipRmaInspection = z.infer<typeof insertDropshipRmaInspectionSchema>;
export type DropshipRmaInspection = typeof dropshipRmaInspections.$inferSelect;

export const insertDropshipCarrierClaimSchema = createInsertSchema(dropshipCarrierClaims).omit(omitGenerated);
export type InsertDropshipCarrierClaim = z.infer<typeof insertDropshipCarrierClaimSchema>;
export type DropshipCarrierClaim = typeof dropshipCarrierClaims.$inferSelect;

export const insertDropshipNotificationEventSchema = createInsertSchema(dropshipNotificationEvents).omit(omitIdCreated);
export type InsertDropshipNotificationEvent = z.infer<typeof insertDropshipNotificationEventSchema>;
export type DropshipNotificationEvent = typeof dropshipNotificationEvents.$inferSelect;

export const insertDropshipNotificationPreferenceSchema = createInsertSchema(dropshipNotificationPreferences).omit(omitGenerated);
export type InsertDropshipNotificationPreference = z.infer<typeof insertDropshipNotificationPreferenceSchema>;
export type DropshipNotificationPreference = typeof dropshipNotificationPreferences.$inferSelect;

export const insertDropshipAuditEventSchema = createInsertSchema(dropshipAuditEvents).omit(omitIdCreated);
export type InsertDropshipAuditEvent = z.infer<typeof insertDropshipAuditEventSchema>;
export type DropshipAuditEvent = typeof dropshipAuditEvents.$inferSelect;

export const insertDropshipUsdcLedgerEntrySchema = createInsertSchema(dropshipUsdcLedgerEntries).omit({
  id: true,
  observedAt: true,
} as const);
export type InsertDropshipUsdcLedgerEntry = z.infer<typeof insertDropshipUsdcLedgerEntrySchema>;
export type DropshipUsdcLedgerEntry = typeof dropshipUsdcLedgerEntries.$inferSelect;
