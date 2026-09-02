import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

import { products, productVariants } from "./catalog.schema";
import { channelConnections, channels } from "./channels.schema";
import { buildRecipes, inventoryLevels, inventoryLots } from "./inventory.schema";
import { orderItems, orders } from "./orders.schema";
import { warehouseLocations, warehouses } from "./warehouse.schema";

const inventoryPlanningSchema = pgSchema("inventory");
const warehousePlanningSchema = pgSchema("warehouse");

export const fulfillmentNodeTypeEnum = [
  "internal_warehouse",
  "third_party_logistics",
  "virtual",
] as const;
export type FulfillmentNodeType = typeof fulfillmentNodeTypeEnum[number];

export const fulfillmentNodes = warehousePlanningSchema.table("fulfillment_nodes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 60 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  nodeType: varchar("node_type", { length: 30 }).notNull(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  providerAccountId: integer("provider_account_id"),
  providerLocationId: integer("provider_location_id"),
  inventoryAuthority: varchar("inventory_authority", { length: 30 }).notNull(),
  fulfillmentAuthority: varchar("fulfillment_authority", { length: 30 }).notNull(),
  lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
  createdBy: varchar("created_by", { length: 100 }).notNull(),
  activatedBy: varchar("activated_by", { length: 100 }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredBy: varchar("retired_by", { length: 100 }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  codeUnique: uniqueIndex("fulfillment_nodes_code_uq").on(table.code),
  warehouseUnique: uniqueIndex("fulfillment_nodes_live_warehouse_uq").on(table.warehouseId)
    .where(sql`${table.lifecycleStatus} <> 'retired'`),
  idWarehouseUnique: uniqueIndex("fulfillment_nodes_id_warehouse_uq")
    .on(table.id, table.warehouseId),
  providerIdentityUnique: uniqueIndex("fulfillment_nodes_provider_identity_uq")
    .on(table.id, table.warehouseId, table.providerAccountId, table.providerLocationId),
  providerLocationAccountForeignKey: foreignKey({
    columns: [table.providerLocationId, table.providerAccountId],
    foreignColumns: [
      fulfillmentProviderLocations.id,
      fulfillmentProviderLocations.providerAccountId,
    ],
    name: "fulfillment_nodes_provider_location_account_fk",
  }).onDelete("restrict"),
  providerIdentityShapeValid: check(
    "fulfillment_nodes_provider_identity_shape_chk",
    sql`(${table.providerAccountId} IS NULL AND ${table.providerLocationId} IS NULL)
      OR (${table.providerAccountId} IS NOT NULL AND ${table.providerLocationId} IS NOT NULL)`,
  ),
  codeValid: check(
    "fulfillment_nodes_code_chk",
    sql`${table.code} = btrim(${table.code}) AND ${table.code} ~ '^[A-Z0-9][A-Z0-9_-]{0,59}$'`,
  ),
  typeValid: check(
    "fulfillment_nodes_type_chk",
    sql`${table.nodeType} IN ('internal_warehouse', 'third_party_logistics', 'virtual')`,
  ),
  inventoryAuthorityValid: check(
    "fulfillment_nodes_inventory_authority_chk",
    sql`${table.inventoryAuthority} IN ('echelon', 'external_provider', 'manual')`,
  ),
  fulfillmentAuthorityValid: check(
    "fulfillment_nodes_fulfillment_authority_chk",
    sql`${table.fulfillmentAuthority} IN ('echelon', 'external_provider', 'none')`,
  ),
  nameValid: check("fulfillment_nodes_name_chk", sql`btrim(${table.name}) <> ''`),
  statusValid: check(
    "fulfillment_nodes_status_chk",
    sql`${table.lifecycleStatus} IN ('draft', 'active', 'retired')`,
  ),
  lifecycleEvidenceValid: check(
    "fulfillment_nodes_lifecycle_evidence_chk",
    sql`(
      ${table.lifecycleStatus} = 'draft'
      AND ${table.activatedBy} IS NULL AND ${table.activatedAt} IS NULL
      AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL
    ) OR (
      ${table.lifecycleStatus} = 'active'
      AND ${table.activatedBy} IS NOT NULL AND btrim(${table.activatedBy}) <> ''
      AND ${table.activatedAt} IS NOT NULL
      AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL
    ) OR (
      ${table.lifecycleStatus} = 'retired'
      AND ${table.activatedBy} IS NOT NULL AND btrim(${table.activatedBy}) <> ''
      AND ${table.activatedAt} IS NOT NULL
      AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
      AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.activatedAt}
    )`,
  ),
}));

export const fulfillmentProviderAccounts = warehousePlanningSchema.table(
  "fulfillment_provider_accounts",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    provider: varchar("provider", { length: 60 }).notNull(),
    accountNamespace: varchar("account_namespace", { length: 60 }).notNull(),
    identityScheme: varchar("identity_scheme", { length: 60 }).notNull(),
    externalAccountId: varchar("external_account_id", { length: 240 }).notNull(),
    displayNameSnapshot: varchar("display_name_snapshot", { length: 200 }).notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    verifiedBy: varchar("verified_by", { length: 100 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUnique: uniqueIndex("fulfillment_provider_accounts_identity_uq").on(
      table.provider, table.accountNamespace, table.identityScheme, table.externalAccountId,
    ),
    identityValid: check(
      "fulfillment_provider_accounts_identity_chk",
      sql`${table.provider} = lower(btrim(${table.provider}))
        AND ${table.provider} ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
        AND ${table.accountNamespace} = lower(btrim(${table.accountNamespace}))
        AND ${table.accountNamespace} ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
        AND ${table.identityScheme} = lower(btrim(${table.identityScheme}))
        AND ${table.identityScheme} ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
        AND btrim(${table.externalAccountId}) <> ''
        AND btrim(${table.displayNameSnapshot}) <> ''
        AND ${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusValid: check(
      "fulfillment_provider_accounts_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'active', 'retired')`,
    ),
    lifecycleValid: check(
      "fulfillment_provider_accounts_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.verifiedBy} IS NULL AND ${table.verifiedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'active'
          AND ${table.verifiedBy} IS NOT NULL AND btrim(${table.verifiedBy}) <> ''
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.verifiedBy} IS NOT NULL AND btrim(${table.verifiedBy}) <> ''
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.verifiedAt})`,
    ),
  }),
);

export const fulfillmentProviderLocations = warehousePlanningSchema.table(
  "fulfillment_provider_locations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    providerAccountId: integer("provider_account_id").notNull()
      .references(() => fulfillmentProviderAccounts.id, { onDelete: "restrict" }),
    identityScheme: varchar("identity_scheme", { length: 60 }).notNull(),
    externalLocationId: varchar("external_location_id", { length: 240 }).notNull(),
    displayNameSnapshot: varchar("display_name_snapshot", { length: 200 }).notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    verifiedBy: varchar("verified_by", { length: 100 }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUnique: uniqueIndex("fulfillment_provider_locations_identity_uq")
      .on(table.providerAccountId, table.identityScheme, table.externalLocationId),
    idAccountUnique: uniqueIndex("fulfillment_provider_locations_id_account_uq")
      .on(table.id, table.providerAccountId),
    identityValid: check(
      "fulfillment_provider_locations_identity_chk",
      sql`${table.identityScheme} = lower(btrim(${table.identityScheme}))
        AND ${table.identityScheme} ~ '^[a-z0-9][a-z0-9_-]{0,59}$'
        AND btrim(${table.externalLocationId}) <> ''
        AND btrim(${table.displayNameSnapshot}) <> ''
        AND ${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    statusValid: check(
      "fulfillment_provider_locations_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'active', 'retired')`,
    ),
    lifecycleValid: check(
      "fulfillment_provider_locations_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.verifiedBy} IS NULL AND ${table.verifiedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'active'
          AND ${table.verifiedBy} IS NOT NULL AND btrim(${table.verifiedBy}) <> ''
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.verifiedBy} IS NOT NULL AND btrim(${table.verifiedBy}) <> ''
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.verifiedAt})`,
    ),
  }),
);

export const fulfillmentNodeProviderBindings = warehousePlanningSchema.table(
  "fulfillment_node_provider_bindings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    fulfillmentNodeId: integer("fulfillment_node_id").notNull(),
    warehouseId: integer("warehouse_id").notNull(),
    providerAccountId: integer("provider_account_id").notNull()
      .references(() => fulfillmentProviderAccounts.id, { onDelete: "restrict" }),
    providerLocationId: integer("provider_location_id").notNull(),
    capability: varchar("capability", { length: 40 }).notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    activatedBy: varchar("activated_by", { length: 100 }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nodeWarehouseForeignKey: foreignKey({
      columns: [table.fulfillmentNodeId, table.warehouseId],
      foreignColumns: [fulfillmentNodes.id, fulfillmentNodes.warehouseId],
      name: "fulfillment_node_provider_bindings_node_warehouse_fk",
    }).onDelete("restrict"),
    locationAccountForeignKey: foreignKey({
      columns: [table.providerLocationId, table.providerAccountId],
      foreignColumns: [fulfillmentProviderLocations.id, fulfillmentProviderLocations.providerAccountId],
      name: "fulfillment_node_provider_bindings_location_account_fk",
    }).onDelete("restrict"),
    nodeProviderForeignKey: foreignKey({
      columns: [table.fulfillmentNodeId, table.warehouseId,
        table.providerAccountId, table.providerLocationId],
      foreignColumns: [fulfillmentNodes.id, fulfillmentNodes.warehouseId,
        fulfillmentNodes.providerAccountId, fulfillmentNodes.providerLocationId],
      name: "fulfillment_node_provider_bindings_node_provider_fk",
    }).onDelete("restrict"),
    liveIdentityUnique: uniqueIndex("fulfillment_node_provider_bindings_live_identity_uq")
      .on(table.fulfillmentNodeId, table.providerAccountId, table.providerLocationId, table.capability)
      .where(sql`${table.lifecycleStatus} <> 'retired'`),
    activeNodeCapabilityUnique: uniqueIndex(
      "fulfillment_node_provider_bindings_active_node_capability_uq",
    ).on(table.fulfillmentNodeId, table.capability)
      .where(sql`${table.lifecycleStatus} = 'active'`),
    activeLocationCapabilityUnique: uniqueIndex(
      "fulfillment_node_provider_bindings_active_location_capability_uq",
    ).on(table.providerLocationId, table.capability)
      .where(sql`${table.lifecycleStatus} = 'active'`),
    capabilityValid: check(
      "fulfillment_node_provider_bindings_capability_chk",
      sql`${table.capability} IN (
        'inventory_observation', 'fulfillment_execution', 'custody_reconciliation'
      )`,
    ),
    statusValid: check(
      "fulfillment_node_provider_bindings_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'active', 'retired')`,
    ),
    lifecycleValid: check(
      "fulfillment_node_provider_bindings_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.activatedBy} IS NULL AND ${table.activatedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'active'
          AND ${table.activatedBy} IS NOT NULL AND btrim(${table.activatedBy}) <> ''
          AND ${table.activatedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.activatedBy} IS NOT NULL AND btrim(${table.activatedBy}) <> ''
          AND ${table.activatedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.activatedAt})`,
    ),
  }),
);

export const locationPromisePolicyVersions = inventoryPlanningSchema.table(
  "location_promise_policy_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    warehouseLocationId: integer("warehouse_location_id").notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    eligibilityMode: varchar("eligibility_mode", { length: 20 }).notNull(),
    definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
    supersedesPolicyId: integer("supersedes_policy_id")
      .references((): AnyPgColumn => locationPromisePolicyVersions.id, { onDelete: "restrict" }),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    locationVersionUnique: uniqueIndex("location_promise_policy_versions_location_version_uq")
      .on(table.warehouseLocationId, table.version),
    idLocationUnique: uniqueIndex("location_promise_policy_versions_id_location_uq")
      .on(table.id, table.warehouseLocationId),
    idempotencyUnique: uniqueIndex("location_promise_policy_versions_idempotency_uq")
      .on(table.idempotencyKey),
    oneDraft: uniqueIndex("location_promise_policy_versions_one_draft_uq")
      .on(table.warehouseLocationId)
      .where(sql`${table.lifecycleStatus} = 'draft'`),
    successorUnique: uniqueIndex("location_promise_policy_versions_successor_uq")
      .on(table.supersedesPolicyId)
      .where(sql`${table.supersedesPolicyId} IS NOT NULL`),
    versionPositive: check("location_promise_policy_versions_version_chk", sql`${table.version} > 0`),
    statusValid: check(
      "location_promise_policy_versions_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired')`,
    ),
    modeValid: check(
      "location_promise_policy_versions_mode_chk",
      sql`${table.eligibilityMode} IN ('inherit', 'eligible', 'ineligible')`,
    ),
    hashValid: check(
      "location_promise_policy_versions_hash_chk",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    reasonValid: check(
      "location_promise_policy_versions_reason_chk",
      sql`char_length(btrim(${table.changeReason})) BETWEEN 1 AND 1000`,
    ),
    predecessorValid: check(
      "location_promise_policy_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesPolicyId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesPolicyId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "location_promise_policy_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.sealedAt})`,
    ),
  }),
);

export const locationPromisePolicyHeads = inventoryPlanningSchema.table(
  "location_promise_policy_heads",
  {
    warehouseLocationId: integer("warehouse_location_id").primaryKey()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    activePolicyId: integer("active_policy_id"),
    draftPolicyId: integer("draft_policy_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(0)),
    updatedBy: varchar("updated_by", { length: 100 }).notNull(),
    updateReason: varchar("update_reason", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activePolicyForeignKey: foreignKey({
      columns: [table.activePolicyId, table.warehouseLocationId],
      foreignColumns: [locationPromisePolicyVersions.id, locationPromisePolicyVersions.warehouseLocationId],
      name: "location_promise_policy_heads_active_fk",
    }).onDelete("restrict"),
    draftPolicyForeignKey: foreignKey({
      columns: [table.draftPolicyId, table.warehouseLocationId],
      foreignColumns: [locationPromisePolicyVersions.id, locationPromisePolicyVersions.warehouseLocationId],
      name: "location_promise_policy_heads_draft_fk",
    }).onDelete("restrict"),
    distinctPointers: check(
      "location_promise_policy_heads_distinct_chk",
      sql`${table.activePolicyId} IS NULL OR ${table.draftPolicyId} IS NULL
        OR ${table.activePolicyId} <> ${table.draftPolicyId}`,
    ),
    revisionValid: check("location_promise_policy_heads_revision_chk", sql`${table.revision} >= 0`),
    reasonValid: check(
      "location_promise_policy_heads_reason_chk",
      sql`char_length(btrim(${table.updateReason})) BETWEEN 1 AND 1000`,
    ),
  }),
);

export const transformationModelVersions = inventoryPlanningSchema.table(
  "transformation_model_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    buildToPromiseEnabled: boolean("build_to_promise_enabled").notNull().default(false),
    definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
    validationState: varchar("validation_state", { length: 20 }).notNull(),
    validationErrors: jsonb("validation_errors").notNull().default(sql`'[]'::jsonb`),
    supersedesModelId: integer("supersedes_model_id")
      .references((): AnyPgColumn => transformationModelVersions.id, { onDelete: "restrict" }),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    origin: varchar("origin", { length: 30 }).notNull().default("operator"),
    originInputHash: varchar("origin_input_hash", { length: 64 }),
    originResultHash: varchar("origin_result_hash", { length: 64 }),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    supersededBy: varchar("superseded_by", { length: 100 }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersessionReason: varchar("supersession_reason", { length: 1000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    productVersionUnique: uniqueIndex("transformation_model_versions_product_version_uq")
      .on(table.productId, table.version),
    idProductUnique: uniqueIndex("transformation_model_versions_id_product_uq")
      .on(table.id, table.productId),
    idProductVersionUnique: uniqueIndex("transformation_model_versions_id_product_version_uq")
      .on(table.id, table.productId, table.version),
    reviewEvidenceUnique: uniqueIndex("transformation_model_versions_review_evidence_uq")
      .on(table.id, table.productId, table.version, table.definitionHash),
    idempotencyUnique: uniqueIndex("transformation_model_versions_idempotency_uq")
      .on(table.idempotencyKey),
    oneDraft: uniqueIndex("transformation_model_versions_one_draft_uq")
      .on(table.productId)
      .where(sql`${table.lifecycleStatus} = 'draft'`),
    successorUnique: uniqueIndex("transformation_model_versions_successor_uq")
      .on(table.supersedesModelId)
      .where(sql`${table.supersedesModelId} IS NOT NULL`),
    versionPositive: check("transformation_model_versions_version_chk", sql`${table.version} > 0`),
    statusValid: check(
      "transformation_model_versions_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired', 'superseded')`,
    ),
    validationValid: check(
      "transformation_model_versions_validation_chk",
      sql`${table.validationState} IN ('valid', 'invalid')
        AND jsonb_typeof(${table.validationErrors}) = 'array'
        AND ((${table.validationState} = 'valid' AND jsonb_array_length(${table.validationErrors}) = 0)
          OR (${table.validationState} = 'invalid' AND jsonb_array_length(${table.validationErrors}) > 0))`,
    ),
    hashValid: check(
      "transformation_model_versions_hash_chk",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    reasonValid: check(
      "transformation_model_versions_reason_chk",
      sql`char_length(btrim(${table.changeReason})) BETWEEN 1 AND 1000`,
    ),
    originValid: check(
      "transformation_model_versions_origin_chk",
      sql`(${table.origin} = 'operator'
          AND ${table.originInputHash} IS NULL
          AND ${table.originResultHash} IS NULL)
        OR (${table.origin} = 'phase3_backfill'
          AND ${table.originInputHash} IS NOT NULL
          AND ${table.originResultHash} IS NOT NULL
          AND ${table.originInputHash} ~ '^[0-9a-f]{64}$'
          AND ${table.originResultHash} ~ '^[0-9a-f]{64}$')`,
    ),
    predecessorValid: check(
      "transformation_model_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesModelId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesModelId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "transformation_model_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL
          AND ${table.supersededBy} IS NULL AND ${table.supersededAt} IS NULL
          AND ${table.supersessionReason} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.validationState} = 'valid'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL
          AND ${table.supersededBy} IS NULL AND ${table.supersededAt} IS NULL
          AND ${table.supersessionReason} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.sealedAt}
          AND ${table.supersededBy} IS NULL AND ${table.supersededAt} IS NULL
          AND ${table.supersessionReason} IS NULL)
        OR (${table.lifecycleStatus} = 'superseded'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL
          AND ${table.supersededBy} IS NOT NULL AND btrim(${table.supersededBy}) <> ''
          AND ${table.supersededAt} IS NOT NULL AND ${table.supersededAt} >= ${table.createdAt}
          AND char_length(btrim(${table.supersessionReason})) BETWEEN 1 AND 1000)`,
    ),
  }),
);

export const transformationModelPaths = inventoryPlanningSchema.table(
  "transformation_model_paths",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    modelId: integer("model_id").notNull()
      .references(() => transformationModelVersions.id, { onDelete: "cascade" }),
    sourceVariantId: integer("source_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    destinationVariantId: integer("destination_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    inputQty: integer("input_qty").notNull(),
    outputQty: integer("output_qty").notNull(),
    sourceUnitsPerVariant: integer("source_units_per_variant").notNull(),
    destinationUnitsPerVariant: integer("destination_units_per_variant").notNull(),
    operationType: varchar("operation_type", { length: 30 }).notNull(),
    authorityState: varchar("authority_state", { length: 20 }).notNull(),
    // SQL adds the composite FK after transformation_recipe_bindings exists.
    transformationRecipeBindingId: integer("transformation_recipe_binding_id"),
    validationState: varchar("validation_state", { length: 20 }).notNull(),
    validationErrors: jsonb("validation_errors").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUnique: uniqueIndex("transformation_model_paths_identity_uq")
      .on(table.modelId, table.sourceVariantId, table.destinationVariantId, table.operationType),
    idModelUnique: uniqueIndex("transformation_model_paths_id_model_uq")
      .on(table.id, table.modelId),
    destinationIndex: index("transformation_model_paths_destination_idx")
      .on(table.modelId, table.destinationVariantId, table.authorityState),
    distinctVariants: check(
      "transformation_model_paths_distinct_variants_chk",
      sql`${table.sourceVariantId} <> ${table.destinationVariantId}`,
    ),
    quantityValid: check(
      "transformation_model_paths_quantity_chk",
      sql`${table.inputQty} > 0 AND ${table.outputQty} > 0
        AND ${table.sourceUnitsPerVariant} > 0 AND ${table.destinationUnitsPerVariant} > 0`,
    ),
    packagingConservesBaseUnits: check(
      "transformation_model_paths_conservation_chk",
      sql`${table.authorityState} = 'blocked'
        OR ${table.inputQty}::bigint * ${table.sourceUnitsPerVariant}::bigint
          = ${table.outputQty}::bigint * ${table.destinationUnitsPerVariant}::bigint
        OR (${table.operationType} = 'directed_conversion'
          AND ${table.transformationRecipeBindingId} IS NOT NULL)`,
    ),
    operationValid: check(
      "transformation_model_paths_operation_chk",
      sql`${table.operationType} IN ('break_pack', 'assemble_pack', 'directed_conversion')`,
    ),
    recipeShapeValid: check(
      "transformation_model_paths_recipe_shape_chk",
      sql`${table.operationType} = 'directed_conversion'
        OR ${table.transformationRecipeBindingId} IS NULL`,
    ),
    authorityValid: check(
      "transformation_model_paths_authority_chk",
      sql`${table.authorityState} IN ('allowed', 'blocked')`,
    ),
    validationValid: check(
      "transformation_model_paths_validation_chk",
      sql`${table.validationState} IN ('valid', 'invalid')
        AND jsonb_typeof(${table.validationErrors}) = 'array'
        AND ((${table.validationState} = 'valid' AND jsonb_array_length(${table.validationErrors}) = 0)
          OR (${table.validationState} = 'invalid' AND jsonb_array_length(${table.validationErrors}) > 0))`,
    ),
    recipeBindingForeignKey: foreignKey({
      columns: [table.transformationRecipeBindingId, table.modelId],
      foreignColumns: [transformationRecipeBindings.id, transformationRecipeBindings.modelId],
      name: "transformation_model_paths_recipe_binding_fk",
    }).onDelete("restrict"),
  }),
);

export const transformationRecipeBindings = inventoryPlanningSchema.table(
  "transformation_recipe_bindings",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    modelId: integer("model_id").notNull()
      .references(() => transformationModelVersions.id, { onDelete: "cascade" }),
    recipeId: integer("recipe_id").notNull()
      .references(() => buildRecipes.id, { onDelete: "restrict" }),
    relationshipRole: varchar("relationship_role", { length: 30 }).notNull(),
    warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    recipeCodeSnapshot: varchar("recipe_code_snapshot", { length: 50 }).notNull(),
    recipeVersionSnapshot: integer("recipe_version_snapshot").notNull(),
    recipeDefinitionHash: varchar("recipe_definition_hash", { length: 64 }).notNull(),
    outputProductIdSnapshot: integer("output_product_id_snapshot").notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    outputVariantIdSnapshot: integer("output_variant_id_snapshot").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    outputUnitsPerVariantSnapshot: integer("output_units_per_variant_snapshot").notNull(),
    outputQtySnapshot: integer("output_qty_snapshot").notNull(),
    validationState: varchar("validation_state", { length: 20 }).notNull(),
    validationErrors: jsonb("validation_errors").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idModelUnique: uniqueIndex("transformation_recipe_bindings_id_model_uq")
      .on(table.id, table.modelId),
    outputVariantProductForeignKey: foreignKey({
      columns: [table.outputVariantIdSnapshot, table.outputProductIdSnapshot],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "transformation_recipe_bindings_output_variant_product_fk",
    }).onDelete("restrict"),
    scopeUnique: uniqueIndex("transformation_recipe_bindings_scope_uq")
      .on(table.modelId, table.recipeId, sql`COALESCE(${table.warehouseId}, 0)`),
    roleValid: check(
      "transformation_recipe_bindings_role_chk",
      sql`${table.relationshipRole} IN ('component_build', 'directional_conversion', 'disassembly')`,
    ),
    snapshotValid: check(
      "transformation_recipe_bindings_snapshot_chk",
      sql`${table.recipeVersionSnapshot} > 0
        AND btrim(${table.recipeCodeSnapshot}) <> ''
        AND ${table.recipeDefinitionHash} ~ '^[0-9a-f]{64}$'
        AND ${table.outputUnitsPerVariantSnapshot} > 0
        AND ${table.outputQtySnapshot} > 0`,
    ),
    validationValid: check(
      "transformation_recipe_bindings_validation_chk",
      sql`${table.validationState} IN ('valid', 'invalid')
        AND jsonb_typeof(${table.validationErrors}) = 'array'
        AND ((${table.validationState} = 'valid' AND jsonb_array_length(${table.validationErrors}) = 0)
          OR (${table.validationState} = 'invalid' AND jsonb_array_length(${table.validationErrors}) > 0))`,
    ),
  }),
);

export const transformationRecipeComponentSnapshots = inventoryPlanningSchema.table(
  "transformation_recipe_component_snapshots",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    transformationRecipeBindingId: integer("transformation_recipe_binding_id").notNull(),
    modelId: integer("model_id").notNull(),
    componentVariantId: integer("component_variant_id").notNull(),
    componentProductId: integer("component_product_id").notNull(),
    componentUnitsPerVariant: integer("component_units_per_variant").notNull(),
    componentQty: integer("component_qty").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    bindingModelForeignKey: foreignKey({
      columns: [table.transformationRecipeBindingId, table.modelId],
      foreignColumns: [transformationRecipeBindings.id, transformationRecipeBindings.modelId],
      name: "transformation_recipe_component_snapshots_binding_model_fk",
    }).onDelete("cascade"),
    variantProductForeignKey: foreignKey({
      columns: [table.componentVariantId, table.componentProductId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "transformation_recipe_component_snapshots_variant_product_fk",
    }).onDelete("restrict"),
    identityUnique: uniqueIndex("transformation_recipe_component_snapshots_identity_uq")
      .on(table.transformationRecipeBindingId, table.componentVariantId),
    idModelUnique: uniqueIndex("transformation_recipe_component_snapshots_id_model_uq")
      .on(table.id, table.modelId),
    quantityValid: check(
      "transformation_recipe_component_snapshots_quantity_chk",
      sql`${table.componentUnitsPerVariant} > 0 AND ${table.componentQty} > 0`,
    ),
  }),
);

export const transformationModelHeads = inventoryPlanningSchema.table(
  "transformation_model_heads",
  {
    productId: integer("product_id").primaryKey().references(() => products.id, { onDelete: "restrict" }),
    activeModelId: integer("active_model_id"),
    draftModelId: integer("draft_model_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(0)),
    updatedBy: varchar("updated_by", { length: 100 }).notNull(),
    updateReason: varchar("update_reason", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeModelForeignKey: foreignKey({
      columns: [table.activeModelId, table.productId],
      foreignColumns: [transformationModelVersions.id, transformationModelVersions.productId],
      name: "transformation_model_heads_active_fk",
    }).onDelete("restrict"),
    draftModelForeignKey: foreignKey({
      columns: [table.draftModelId, table.productId],
      foreignColumns: [transformationModelVersions.id, transformationModelVersions.productId],
      name: "transformation_model_heads_draft_fk",
    }).onDelete("restrict"),
    distinctPointers: check(
      "transformation_model_heads_distinct_chk",
      sql`${table.activeModelId} IS NULL OR ${table.draftModelId} IS NULL
        OR ${table.activeModelId} <> ${table.draftModelId}`,
    ),
    revisionValid: check("transformation_model_heads_revision_chk", sql`${table.revision} >= 0`),
    reasonValid: check(
      "transformation_model_heads_reason_chk",
      sql`char_length(btrim(${table.updateReason})) BETWEEN 1 AND 1000`,
    ),
  }),
);

export const transformationModelReviews = inventoryPlanningSchema.table(
  "transformation_model_reviews",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    modelId: integer("model_id").notNull(),
    productId: integer("product_id").notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    modelVersion: integer("model_version").notNull(),
    modelDefinitionHash: varchar("model_definition_hash", { length: 64 }).notNull(),
    decision: varchar("decision", { length: 30 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    reviewedBy: varchar("reviewed_by", { length: 100 }).notNull(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    modelForeignKey: foreignKey({
      columns: [table.modelId, table.productId, table.modelVersion, table.modelDefinitionHash],
      foreignColumns: [
        transformationModelVersions.id,
        transformationModelVersions.productId,
        transformationModelVersions.version,
        transformationModelVersions.definitionHash,
      ],
      name: "transformation_model_reviews_model_fk",
    }).onDelete("restrict"),
    modelDefinitionLookup: index("transformation_model_reviews_definition_lookup_idx")
      .on(table.modelId, table.modelDefinitionHash, table.reviewedAt, table.id),
    idempotencyUnique: uniqueIndex("transformation_model_reviews_idempotency_uq")
      .on(table.idempotencyKey),
    productLookup: index("transformation_model_reviews_product_lookup_idx")
      .on(table.productId, table.reviewedAt, table.id),
    decisionValid: check(
      "transformation_model_reviews_decision_chk",
      sql`${table.decision} IN ('approved', 'changes_required')`,
    ),
    hashValid: check(
      "transformation_model_reviews_hash_chk",
      sql`${table.modelDefinitionHash} ~ '^[0-9a-f]{64}$'
        AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    evidenceValid: check(
      "transformation_model_reviews_evidence_chk",
      sql`${table.modelVersion} > 0
        AND char_length(btrim(${table.reason})) BETWEEN 1 AND 1000
        AND char_length(btrim(${table.reviewedBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.idempotencyKey})) BETWEEN 1 AND 120`,
    ),
  }),
);

export const promiseSafetyPolicyVersions = inventoryPlanningSchema.table(
  "promise_safety_policy_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    scopeKey: varchar("scope_key", { length: 160 }).notNull(),
    scopeType: varchar("scope_type", { length: 30 }).notNull(),
    productVariantId: integer("product_variant_id")
      .references(() => productVariants.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    policyMode: varchar("policy_mode", { length: 30 }).notNull(),
    fixedUnits: integer("fixed_units"),
    daysOfCoverMilliDays: integer("days_of_cover_milli_days"),
    untrustedDemandFallbackUnits: integer("untrusted_demand_fallback_units"),
    demandMethodVersion: varchar("demand_method_version", { length: 60 }),
    definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
    supersedesPolicyId: integer("supersedes_policy_id")
      .references((): AnyPgColumn => promiseSafetyPolicyVersions.id, { onDelete: "restrict" }),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    scopeVersionUnique: uniqueIndex("promise_safety_policy_versions_scope_version_uq")
      .on(table.scopeKey, table.version),
    idScopeUnique: uniqueIndex("promise_safety_policy_versions_id_scope_uq")
      .on(table.id, table.scopeKey),
    idempotencyUnique: uniqueIndex("promise_safety_policy_versions_idempotency_uq")
      .on(table.idempotencyKey),
    oneDraft: uniqueIndex("promise_safety_policy_versions_one_draft_uq")
      .on(table.scopeKey)
      .where(sql`${table.lifecycleStatus} = 'draft'`),
    successorUnique: uniqueIndex("promise_safety_policy_versions_successor_uq")
      .on(table.supersedesPolicyId)
      .where(sql`${table.supersedesPolicyId} IS NOT NULL`),
    scopeValid: check(
      "promise_safety_policy_versions_scope_chk",
      sql`(${table.scopeType} = 'business' AND ${table.scopeKey} = 'business'
          AND ${table.productVariantId} IS NULL AND ${table.warehouseId} IS NULL)
        OR (${table.scopeType} = 'network_variant'
          AND ${table.scopeKey} = 'network:variant:' || ${table.productVariantId}::text
          AND ${table.productVariantId} IS NOT NULL AND ${table.warehouseId} IS NULL)
        OR (${table.scopeType} = 'warehouse_variant'
          AND ${table.scopeKey} = 'warehouse:' || ${table.warehouseId}::text
            || ':variant:' || ${table.productVariantId}::text
          AND ${table.productVariantId} IS NOT NULL AND ${table.warehouseId} IS NOT NULL)`,
    ),
    versionPositive: check("promise_safety_policy_versions_version_chk", sql`${table.version} > 0`),
    statusValid: check(
      "promise_safety_policy_versions_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired')`,
    ),
    modeValid: check(
      "promise_safety_policy_versions_mode_chk",
      sql`${table.policyMode} IN ('inherit', 'off', 'fixed_units', 'days_of_cover')
        AND (${table.scopeType} <> 'business' OR ${table.policyMode} <> 'inherit')`,
    ),
    valueShapeValid: check(
      "promise_safety_policy_versions_value_shape_chk",
      sql`(${table.policyMode} = 'inherit'
          AND ${table.fixedUnits} IS NULL AND ${table.daysOfCoverMilliDays} IS NULL
          AND ${table.untrustedDemandFallbackUnits} IS NULL AND ${table.demandMethodVersion} IS NULL)
        OR (${table.policyMode} = 'off'
          AND ${table.fixedUnits} IS NULL AND ${table.daysOfCoverMilliDays} IS NULL
          AND ${table.untrustedDemandFallbackUnits} IS NULL AND ${table.demandMethodVersion} IS NULL)
        OR (${table.policyMode} = 'fixed_units'
          AND ${table.fixedUnits} IS NOT NULL AND ${table.fixedUnits} >= 0
          AND ${table.daysOfCoverMilliDays} IS NULL
          AND ${table.untrustedDemandFallbackUnits} IS NULL AND ${table.demandMethodVersion} IS NULL)
        OR (${table.policyMode} = 'days_of_cover'
          AND ${table.fixedUnits} IS NULL
          AND ${table.daysOfCoverMilliDays} IS NOT NULL AND ${table.daysOfCoverMilliDays} > 0
          AND ${table.untrustedDemandFallbackUnits} IS NOT NULL
          AND ${table.untrustedDemandFallbackUnits} >= 0
          AND ${table.demandMethodVersion} IS NOT NULL
          AND btrim(${table.demandMethodVersion}) <> '')`,
    ),
    hashValid: check(
      "promise_safety_policy_versions_hash_chk",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    reasonValid: check(
      "promise_safety_policy_versions_reason_chk",
      sql`char_length(btrim(${table.changeReason})) BETWEEN 1 AND 1000`,
    ),
    predecessorValid: check(
      "promise_safety_policy_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesPolicyId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesPolicyId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "promise_safety_policy_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.sealedAt})`,
    ),
  }),
);

export const promiseSafetyPolicyHeads = inventoryPlanningSchema.table(
  "promise_safety_policy_heads",
  {
    scopeKey: varchar("scope_key", { length: 160 }).primaryKey(),
    activePolicyId: integer("active_policy_id"),
    draftPolicyId: integer("draft_policy_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(0)),
    updatedBy: varchar("updated_by", { length: 100 }).notNull(),
    updateReason: varchar("update_reason", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activePolicyForeignKey: foreignKey({
      columns: [table.activePolicyId, table.scopeKey],
      foreignColumns: [promiseSafetyPolicyVersions.id, promiseSafetyPolicyVersions.scopeKey],
      name: "promise_safety_policy_heads_active_fk",
    }).onDelete("restrict"),
    draftPolicyForeignKey: foreignKey({
      columns: [table.draftPolicyId, table.scopeKey],
      foreignColumns: [promiseSafetyPolicyVersions.id, promiseSafetyPolicyVersions.scopeKey],
      name: "promise_safety_policy_heads_draft_fk",
    }).onDelete("restrict"),
    distinctPointers: check(
      "promise_safety_policy_heads_distinct_chk",
      sql`${table.activePolicyId} IS NULL OR ${table.draftPolicyId} IS NULL
        OR ${table.activePolicyId} <> ${table.draftPolicyId}`,
    ),
    revisionValid: check("promise_safety_policy_heads_revision_chk", sql`${table.revision} >= 0`),
    reasonValid: check(
      "promise_safety_policy_heads_reason_chk",
      sql`char_length(btrim(${table.updateReason})) BETWEEN 1 AND 1000`,
    ),
  }),
);

export const demandEvidenceSnapshots = inventoryPlanningSchema.table(
  "demand_evidence_snapshots",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    windowEndedAt: timestamp("window_ended_at", { withTimezone: true }).notNull(),
    irreversibleConsumptionUnits: bigint("irreversible_consumption_units", { mode: "bigint" }).notNull(),
    observedDays: integer("observed_days").notNull(),
    dailyDemandMilliUnits: bigint("daily_demand_milli_units", { mode: "bigint" }).notNull(),
    trustStatus: varchar("trust_status", { length: 20 }).notNull(),
    trustReasons: jsonb("trust_reasons").notNull().default(sql`'[]'::jsonb`),
    methodVersion: varchar("method_version", { length: 60 }).notNull(),
    inputFingerprint: varchar("input_fingerprint", { length: 64 }).notNull(),
    overrideBy: varchar("override_by", { length: 100 }),
    overrideReason: varchar("override_reason", { length: 1000 }),
    overrideExpiresAt: timestamp("override_expires_at", { withTimezone: true }),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIndex: index("demand_evidence_snapshots_lookup_idx")
      .on(
        table.productVariantId,
        table.warehouseId,
        table.calculatedAt.desc(),
        table.id.desc(),
      ),
    inputUnique: uniqueIndex("demand_evidence_snapshots_input_uq").on(
      table.productVariantId,
      sql`COALESCE(${table.warehouseId}, 0)`,
      table.methodVersion,
      table.windowStartedAt,
      table.windowEndedAt,
      table.inputFingerprint,
    ),
    windowValid: check(
      "demand_evidence_snapshots_window_chk",
      sql`${table.windowEndedAt} > ${table.windowStartedAt}
        AND ${table.calculatedAt} >= ${table.windowEndedAt}`,
    ),
    quantityValid: check(
      "demand_evidence_snapshots_quantity_chk",
      sql`${table.irreversibleConsumptionUnits} >= 0 AND ${table.observedDays} >= 0
        AND ${table.dailyDemandMilliUnits} >= 0`,
    ),
    trustValid: check(
      "demand_evidence_snapshots_trust_chk",
      sql`${table.trustStatus} IN ('trusted', 'untrusted', 'overridden')
        AND jsonb_typeof(${table.trustReasons}) = 'array'`,
    ),
    hashValid: check(
      "demand_evidence_snapshots_hash_chk",
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    overrideValid: check(
      "demand_evidence_snapshots_override_chk",
      sql`(${table.trustStatus} <> 'overridden'
          AND ${table.overrideBy} IS NULL AND ${table.overrideReason} IS NULL
          AND ${table.overrideExpiresAt} IS NULL)
        OR (${table.trustStatus} = 'overridden'
          AND ${table.overrideBy} IS NOT NULL AND btrim(${table.overrideBy}) <> ''
          AND ${table.overrideReason} IS NOT NULL AND btrim(${table.overrideReason}) <> ''
          AND ${table.overrideExpiresAt} IS NOT NULL
          AND ${table.overrideExpiresAt} > ${table.calculatedAt})`,
    ),
  }),
);

export const plannerShadowRuns = inventoryPlanningSchema.table(
  "planner_shadow_runs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    modelId: integer("model_id"),
    modelVersion: integer("model_version"),
    modelDefinitionHash: varchar("model_definition_hash", { length: 64 }),
    legacyInventoryStrategy: varchar("legacy_inventory_strategy", { length: 30 }).notNull(),
    snapshotFingerprint: varchar("snapshot_fingerprint", { length: 64 }).notNull(),
    snapshotPayload: jsonb("snapshot_payload").notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    blockerCodes: jsonb("blocker_codes").notNull().default(sql`'[]'::jsonb`),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestedBy: varchar("requested_by", { length: 100 }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    modelProductForeignKey: foreignKey({
      columns: [table.modelId, table.productId],
      foreignColumns: [transformationModelVersions.id, transformationModelVersions.productId],
      name: "planner_shadow_runs_model_product_fk",
    }).onDelete("restrict"),
    idempotencyUnique: uniqueIndex("planner_shadow_runs_idempotency_uq").on(table.idempotencyKey),
    productLookup: index("planner_shadow_runs_product_lookup_idx")
      .on(table.productId, table.completedAt.desc(), table.id.desc()),
    statusValid: check("planner_shadow_runs_status_chk", sql`${table.status} IN ('completed', 'blocked')`),
    legacyStrategyValid: check(
      "planner_shadow_runs_legacy_strategy_chk",
      sql`${table.legacyInventoryStrategy} IN ('physical_fungible', 'recipe_managed', 'physical_only')`,
    ),
    hashValid: check(
      "planner_shadow_runs_hash_chk",
      sql`${table.snapshotFingerprint} ~ '^[0-9a-f]{64}$'
        AND (${table.modelDefinitionHash} IS NULL OR ${table.modelDefinitionHash} ~ '^[0-9a-f]{64}$')`,
    ),
    modelEvidenceValid: check(
      "planner_shadow_runs_model_evidence_chk",
      sql`(${table.modelId} IS NULL AND ${table.modelVersion} IS NULL AND ${table.modelDefinitionHash} IS NULL)
        OR (${table.modelId} IS NOT NULL AND ${table.modelVersion} > 0
          AND ${table.modelDefinitionHash} IS NOT NULL)`,
    ),
    jsonValid: check(
      "planner_shadow_runs_json_chk",
      sql`jsonb_typeof(${table.snapshotPayload}) = 'object'
        AND jsonb_typeof(${table.blockerCodes}) = 'array'
        AND ${table.snapshotPayload} ->> 'schemaVersion' = 'inventory_availability_snapshot_v1'
        AND ${table.snapshotPayload} ->> 'snapshotFingerprint' = ${table.snapshotFingerprint}
        AND (${table.snapshotPayload} ->> 'productId')::integer = ${table.productId}
        AND ${table.snapshotPayload} ->> 'legacyInventoryStrategy' = ${table.legacyInventoryStrategy}
        AND (${table.snapshotPayload} ->> 'capturedAt')::timestamptz = ${table.capturedAt}`,
    ),
    actorValid: check(
      "planner_shadow_runs_actor_chk",
      sql`btrim(${table.requestedBy}) <> '' AND btrim(${table.idempotencyKey}) <> ''`,
    ),
    timeValid: check("planner_shadow_runs_time_chk", sql`${table.completedAt} >= ${table.capturedAt}`),
  }),
);

export const plannerShadowResults = inventoryPlanningSchema.table(
  "planner_shadow_results",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: bigint("run_id", { mode: "bigint" }).notNull()
      .references(() => plannerShadowRuns.id, { onDelete: "restrict" }),
    warehouseId: integer("warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    legacyAtpUnits: bigint("legacy_atp_units", { mode: "bigint" }).notNull(),
    proposedAtpUnits: bigint("proposed_atp_units", { mode: "bigint" }).notNull(),
    differenceUnits: bigint("difference_units", { mode: "bigint" }).notNull(),
    readinessState: varchar("readiness_state", { length: 20 }).notNull(),
    classifications: jsonb("classifications").notNull(),
    proposedProjection: jsonb("proposed_projection").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resultUnique: uniqueIndex("planner_shadow_results_scope_variant_uq")
      .on(table.runId, sql`COALESCE(${table.warehouseId}, 0)`, table.productVariantId),
    runLookup: index("planner_shadow_results_run_idx").on(table.runId, table.warehouseId, table.productVariantId),
    quantityValid: check(
      "planner_shadow_results_quantity_chk",
      sql`${table.legacyAtpUnits} >= 0 AND ${table.proposedAtpUnits} >= 0
        AND ${table.differenceUnits} = ${table.proposedAtpUnits} - ${table.legacyAtpUnits}`,
    ),
    readinessValid: check(
      "planner_shadow_results_readiness_chk",
      sql`${table.readinessState} IN ('ready', 'blocked')`,
    ),
    evidenceValid: check(
      "planner_shadow_results_evidence_chk",
      sql`jsonb_typeof(${table.classifications}) = 'array'
        AND jsonb_array_length(${table.classifications}) > 0
        AND jsonb_typeof(${table.proposedProjection}) = 'object'
        AND ${table.proposedProjection} ->> 'targetVariantId' = ${table.productVariantId}::text
        AND ${table.proposedProjection} ->> 'atpUnits' = ${table.proposedAtpUnits}::text
        AND ${table.proposedProjection} ->> 'status' = ${table.readinessState}
        AND ((${table.warehouseId} IS NULL
            AND ${table.proposedProjection} #>> '{scope,kind}' = 'network')
          OR (${table.warehouseId} IS NOT NULL
            AND ${table.proposedProjection} #>> '{scope,kind}' = 'warehouse'
            AND ${table.proposedProjection} #>> '{scope,warehouseId}' = ${table.warehouseId}::text))`,
    ),
  }),
);

export const plannerClaimSimulationRuns = inventoryPlanningSchema.table(
  "planner_claim_simulation_runs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    requestKey: varchar("request_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    rootProductIds: jsonb("root_product_ids").notNull(),
    snapshotFingerprint: varchar("snapshot_fingerprint", { length: 64 }).notNull(),
    snapshotPayload: jsonb("snapshot_payload").notNull(),
    planStatus: varchar("plan_status", { length: 20 }).notNull(),
    planPayload: jsonb("plan_payload").notNull(),
    blockerCodes: jsonb("blocker_codes").notNull().default(sql`'[]'::jsonb`),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    requestedBy: varchar("requested_by", { length: 100 }).notNull(),
    operationalWriteAttempted: boolean("operational_write_attempted").notNull().default(false),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("planner_claim_simulation_runs_idempotency_uq")
      .on(table.idempotencyKey),
    requestLookup: index("planner_claim_simulation_runs_request_idx")
      .on(table.requestKey, table.completedAt.desc(), table.id.desc()),
    hashValid: check(
      "planner_claim_simulation_runs_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND ${table.snapshotFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    statusValid: check(
      "planner_claim_simulation_runs_status_chk",
      sql`${table.planStatus} IN ('satisfied', 'partial', 'blocked')`,
    ),
    noOperationalWrite: check(
      "planner_claim_simulation_runs_nonwriting_chk",
      sql`${table.operationalWriteAttempted} = false`,
    ),
    evidenceValid: check(
      "planner_claim_simulation_runs_evidence_chk",
      sql`jsonb_typeof(${table.requestPayload}) = 'object'
        AND jsonb_typeof(${table.rootProductIds}) = 'array'
        AND jsonb_array_length(${table.rootProductIds}) > 0
        AND jsonb_typeof(${table.snapshotPayload}) = 'object'
        AND jsonb_typeof(${table.planPayload}) = 'object'
        AND jsonb_typeof(${table.blockerCodes}) = 'array'
        AND ${table.snapshotPayload} ->> 'schemaVersion' = 'inventory_availability_claim_snapshot_v1'
        AND ${table.snapshotPayload} ->> 'snapshotFingerprint' = ${table.snapshotFingerprint}
        AND ${table.requestPayload} ->> 'requestKey' = ${table.requestKey}
        AND ${table.planPayload} ->> 'requestKey' = ${table.requestKey}
        AND ${table.planPayload} ->> 'status' = ${table.planStatus}
        AND ${table.planPayload} ->> 'snapshotFingerprint' = ${table.snapshotFingerprint}`,
    ),
    actorValid: check(
      "planner_claim_simulation_runs_actor_chk",
      sql`btrim(${table.requestedBy}) <> '' AND btrim(${table.reason}) <> ''
        AND btrim(${table.idempotencyKey}) <> ''`,
    ),
    timeValid: check(
      "planner_claim_simulation_runs_time_chk",
      sql`${table.completedAt} >= ${table.capturedAt}`,
    ),
  }),
);

export const inventoryAvailabilityActivationRuns = inventoryPlanningSchema.table(
  "availability_activation_runs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    sourceDryRunId: bigint("source_dry_run_id", { mode: "bigint" })
      .references((): AnyPgColumn => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    mode: varchar("mode", { length: 20 }).notNull(),
    scope: varchar("scope", { length: 30 }).notNull().default("full_catalog"),
    state: varchar("state", { length: 40 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    resultHash: varchar("result_hash", { length: 64 }),
    expectedCatalogInputHash: varchar("expected_catalog_input_hash", { length: 64 }).notNull(),
    expectedCatalogResultHash: varchar("expected_catalog_result_hash", { length: 64 }).notNull(),
    capturedCatalogInputHash: varchar("captured_catalog_input_hash", { length: 64 }).notNull(),
    capturedCatalogResultHash: varchar("captured_catalog_result_hash", { length: 64 }).notNull(),
    evidencePayload: jsonb("evidence_payload").notNull(),
    blockerCodes: jsonb("blocker_codes").notNull().default(sql`'[]'::jsonb`),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    requestedBy: varchar("requested_by", { length: 100 }).notNull(),
    runtimeAuthorityChanged: boolean("runtime_authority_changed").notNull().default(false),
    providerWriteAttempted: boolean("provider_write_attempted").notNull().default(false),
    outboxEnqueued: boolean("outbox_enqueued").notNull().default(false),
    providerPublicationRequired: boolean("provider_publication_required").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }),
    publicationVerifiedAt: timestamp("publication_verified_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("availability_activation_runs_idempotency_uq")
      .on(table.idempotencyKey),
    stateLookup: index("availability_activation_runs_state_idx")
      .on(table.state, table.startedAt.desc(), table.id.desc()),
    modeValid: check(
      "availability_activation_runs_mode_chk",
      sql`${table.mode} IN ('dry_run', 'activation', 'rollback')`,
    ),
    scopeValid: check(
      "availability_activation_runs_scope_chk",
      sql`${table.scope} = 'full_catalog'`,
    ),
    stateValid: check(
      "availability_activation_runs_state_chk",
      sql`${table.state} IN (
        'validating', 'blocked', 'ready_for_publication', 'publishing',
        'publication_verified', 'activating', 'active', 'failed'
      )`,
    ),
    dryRunValid: check(
      "availability_activation_runs_dry_run_chk",
      sql`${table.mode} <> 'dry_run' OR (
        ${table.state} IN ('blocked', 'ready_for_publication')
        AND ${table.runtimeAuthorityChanged} = false
        AND ${table.providerWriteAttempted} = false
        AND ${table.outboxEnqueued} = false
        AND ${table.completedAt} IS NOT NULL
      )`,
    ),
    hashValid: check(
      "availability_activation_runs_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND (${table.resultHash} IS NULL OR ${table.resultHash} ~ '^[0-9a-f]{64}$')
        AND ${table.expectedCatalogInputHash} ~ '^[0-9a-f]{64}$'
        AND ${table.expectedCatalogResultHash} ~ '^[0-9a-f]{64}$'
        AND ${table.capturedCatalogInputHash} ~ '^[0-9a-f]{64}$'
        AND ${table.capturedCatalogResultHash} ~ '^[0-9a-f]{64}$'`,
    ),
    evidenceValid: check(
      "availability_activation_runs_evidence_chk",
      sql`jsonb_typeof(${table.evidencePayload}) = 'object'
        AND jsonb_typeof(${table.blockerCodes}) = 'array'`,
    ),
    actorValid: check(
      "availability_activation_runs_actor_chk",
      sql`btrim(${table.requestedBy}) <> '' AND btrim(${table.reason}) <> ''
        AND btrim(${table.idempotencyKey}) <> ''`,
    ),
    timeValid: check(
      "availability_activation_runs_time_chk",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt}`,
    ),
  }),
);

export const inventoryAvailabilityRuntimeAuthority = inventoryPlanningSchema.table(
  "availability_runtime_authority",
  {
    singletonKey: boolean("singleton_key").primaryKey().default(true),
    authority: varchar("authority", { length: 20 }).notNull().default("legacy"),
    activationRunId: bigint("activation_run_id", { mode: "bigint" })
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(1)),
    changedBy: varchar("changed_by", { length: 100 }).notNull(),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    singletonValid: check("availability_runtime_authority_singleton_chk", sql`${table.singletonKey} = true`),
    authorityValid: check(
      "availability_runtime_authority_value_chk",
      sql`${table.authority} IN ('legacy', 'canonical')`,
    ),
    revisionValid: check("availability_runtime_authority_revision_chk", sql`${table.revision} > 0`),
    activationValid: check(
      "availability_runtime_authority_activation_chk",
      sql`(${table.authority} = 'legacy' AND ${table.activationRunId} IS NULL)
        OR (${table.authority} = 'canonical' AND ${table.activationRunId} IS NOT NULL)`,
    ),
  }),
);

export const inventoryAvailabilityClaims = inventoryPlanningSchema.table(
  "availability_claims",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimKey: varchar("claim_key", { length: 200 }).notNull(),
    orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    revision: integer("revision").notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    planStatus: varchar("plan_status", { length: 20 }).notNull(),
    scopeKind: varchar("scope_kind", { length: 20 }).notNull(),
    scopeWarehouseId: integer("scope_warehouse_id")
      .references(() => warehouses.id, { onDelete: "restrict" }),
    activationRunId: bigint("activation_run_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    runtimeAuthorityRevision: bigint("runtime_authority_revision", { mode: "bigint" }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    planHash: varchar("plan_hash", { length: 64 }).notNull(),
    snapshotFingerprint: varchar("snapshot_fingerprint", { length: 64 }).notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    planPayload: jsonb("plan_payload").notNull(),
    modelEvidence: jsonb("model_evidence").notNull(),
    requestedBy: varchar("requested_by", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyUnique: uniqueIndex("availability_claims_key_uq").on(table.claimKey),
    orderRevisionUnique: uniqueIndex("availability_claims_order_revision_uq")
      .on(table.orderId, table.revision),
    idKeyUnique: uniqueIndex("availability_claims_id_key_uq").on(table.id, table.claimKey),
    activeOrderUnique: uniqueIndex("availability_claims_one_active_order_uq")
      .on(table.orderId).where(sql`${table.status} = 'active'`),
    orderLookup: index("availability_claims_order_idx").on(table.orderId, table.revision.desc(), table.id.desc()),
    revisionValid: check("availability_claims_revision_chk", sql`${table.revision} > 0`),
    statusValid: check(
      "availability_claims_status_chk",
      sql`${table.status} IN ('active', 'released', 'cancelled', 'superseded', 'failed')`,
    ),
    planStatusValid: check(
      "availability_claims_plan_status_chk",
      sql`${table.planStatus} IN ('satisfied', 'partial')`,
    ),
    scopeValid: check(
      "availability_claims_scope_chk",
      sql`(${table.scopeKind} = 'network' AND ${table.scopeWarehouseId} IS NULL)
        OR (${table.scopeKind} = 'warehouse' AND ${table.scopeWarehouseId} IS NOT NULL)`,
    ),
    hashValid: check(
      "availability_claims_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND ${table.planHash} ~ '^[0-9a-f]{64}$'
        AND ${table.snapshotFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    authorityValid: check(
      "availability_claims_authority_chk",
      sql`${table.runtimeAuthorityRevision} > 0`,
    ),
    actorValid: check(
      "availability_claims_actor_chk",
      sql`btrim(${table.claimKey}) <> '' AND btrim(${table.requestedBy}) <> '' AND btrim(${table.reason}) <> ''`,
    ),
    evidenceValid: check(
      "availability_claims_evidence_chk",
      sql`jsonb_typeof(${table.requestPayload}) = 'object'
        AND jsonb_typeof(${table.planPayload}) = 'object'
        AND jsonb_typeof(${table.modelEvidence}) = 'array'
        AND ${table.requestPayload} ->> 'requestKey' = ${table.claimKey}
        AND ${table.planPayload} ->> 'requestKey' = ${table.claimKey}
        AND ${table.planPayload} ->> 'status' = ${table.planStatus}
        AND ${table.planPayload} ->> 'snapshotFingerprint' = ${table.snapshotFingerprint}`,
    ),
    lifecycleValid: check(
      "availability_claims_lifecycle_chk",
      sql`(${table.status} = 'active' AND ${table.releasedAt} IS NULL
            AND ${table.cancelledAt} IS NULL AND ${table.supersededAt} IS NULL)
        OR (${table.status} = 'released' AND ${table.releasedAt} IS NOT NULL
            AND ${table.cancelledAt} IS NULL AND ${table.supersededAt} IS NULL)
        OR (${table.status} = 'cancelled' AND ${table.cancelledAt} IS NOT NULL
            AND ${table.supersededAt} IS NULL)
        OR (${table.status} = 'superseded' AND ${table.supersededAt} IS NOT NULL)
        OR ${table.status} = 'failed'`,
    ),
  }),
);

export const inventoryAvailabilityClaimLines = inventoryPlanningSchema.table(
  "availability_claim_lines",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: bigint("claim_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityClaims.id, { onDelete: "restrict" }),
    lineKey: varchar("line_key", { length: 200 }).notNull(),
    orderItemId: integer("order_item_id").notNull().references(() => orderItems.id, { onDelete: "restrict" }),
    targetVariantId: integer("target_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    requestedQty: bigint("requested_qty", { mode: "bigint" }).notNull(),
    plannedQty: bigint("planned_qty", { mode: "bigint" }).notNull(),
    shortfallQty: bigint("shortfall_qty", { mode: "bigint" }).notNull(),
    releasedTargetQty: bigint("released_target_qty", { mode: "bigint" }).notNull().default(BigInt(0)),
    consumedTargetQty: bigint("consumed_target_qty", { mode: "bigint" }).notNull().default(BigInt(0)),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimKeyUnique: uniqueIndex("availability_claim_lines_claim_key_uq").on(table.claimId, table.lineKey),
    claimItemUnique: uniqueIndex("availability_claim_lines_claim_item_uq").on(table.claimId, table.orderItemId),
    idClaimUnique: uniqueIndex("availability_claim_lines_id_claim_uq").on(table.id, table.claimId),
    orderItemLookup: index("availability_claim_lines_order_item_idx").on(table.orderItemId, table.claimId.desc()),
    quantityValid: check(
      "availability_claim_lines_quantity_chk",
      sql`${table.requestedQty} > 0
        AND ${table.plannedQty} >= 0
        AND ${table.shortfallQty} >= 0
        AND ${table.requestedQty} = ${table.plannedQty} + ${table.shortfallQty}
        AND ${table.releasedTargetQty} >= 0
        AND ${table.consumedTargetQty} >= 0
        AND ${table.releasedTargetQty} + ${table.consumedTargetQty} <= ${table.plannedQty}`,
    ),
  }),
);

export const inventoryAvailabilityClaimOperations = inventoryPlanningSchema.table(
  "availability_claim_operations",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: bigint("claim_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityClaims.id, { onDelete: "restrict" }),
    claimLineId: bigint("claim_line_id", { mode: "bigint" }).notNull(),
    operationKey: varchar("operation_key", { length: 300 }).notNull(),
    parentOperationKey: varchar("parent_operation_key", { length: 300 }),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
    operationType: varchar("operation_type", { length: 30 }).notNull(),
    authorityId: integer("authority_id").notNull(),
    destinationVariantId: integer("destination_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    plannedExecutions: bigint("planned_executions", { mode: "bigint" }).notNull(),
    outputQty: bigint("output_qty", { mode: "bigint" }).notNull(),
    committedOutputQty: bigint("committed_output_qty", { mode: "bigint" }),
    outputLocationId: integer("output_location_id")
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 30 }).notNull().default("pending"),
    executedExecutions: bigint("executed_executions", { mode: "bigint" }).notNull().default(BigInt(0)),
    releasedExecutions: bigint("released_executions", { mode: "bigint" }).notNull().default(BigInt(0)),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lineForeignKey: foreignKey({
      columns: [table.claimLineId, table.claimId],
      foreignColumns: [inventoryAvailabilityClaimLines.id, inventoryAvailabilityClaimLines.claimId],
      name: "availability_claim_operations_line_fk",
    }).onDelete("restrict"),
    parentForeignKey: foreignKey({
      columns: [table.claimId, table.parentOperationKey],
      foreignColumns: [table.claimId, table.operationKey],
      name: "availability_claim_operations_parent_fk",
    }),
    claimKeyUnique: uniqueIndex("availability_claim_operations_claim_key_uq")
      .on(table.claimId, table.operationKey),
    idClaimUnique: uniqueIndex("availability_claim_operations_id_claim_uq").on(table.id, table.claimId),
    dispatchLookup: index("availability_claim_operations_dispatch_idx")
      .on(table.status, table.warehouseId, table.id)
      .where(sql`${table.status} IN ('pending', 'ready', 'failed')`),
    typeValid: check(
      "availability_claim_operations_type_chk",
      sql`${table.operationType} IN ('break_pack', 'assemble_pack', 'directed_conversion', 'component_build')`,
    ),
    statusValid: check(
      "availability_claim_operations_status_chk",
      sql`${table.status} IN ('pending', 'ready', 'executing', 'completed', 'released', 'failed')`,
    ),
    quantityValid: check(
      "availability_claim_operations_quantity_chk",
      sql`${table.plannedExecutions} > 0 AND ${table.outputQty} > 0
        AND ${table.executedExecutions} >= 0 AND ${table.releasedExecutions} >= 0
        AND ${table.executedExecutions} + ${table.releasedExecutions} <= ${table.plannedExecutions}`,
    ),
    committedOutputValid: check(
      "availability_claim_operations_committed_output_chk",
      sql`${table.committedOutputQty} IS NULL
        OR (${table.committedOutputQty} > 0 AND ${table.committedOutputQty} <= ${table.outputQty})`,
    ),
    authorityValid: check("availability_claim_operations_authority_chk", sql`${table.authorityId} > 0`),
  }),
);

export const inventoryAvailabilityClaimOperationInputs = inventoryPlanningSchema.table(
  "availability_claim_operation_inputs",
  {
    claimOperationId: bigint("claim_operation_id", { mode: "bigint" }).notNull(),
    claimId: bigint("claim_id", { mode: "bigint" }).notNull(),
    sourceVariantId: integer("source_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    requiredQty: bigint("required_qty", { mode: "bigint" }).notNull(),
    inputOrdinal: integer("input_ordinal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.claimOperationId, table.sourceVariantId] }),
    operationForeignKey: foreignKey({
      columns: [table.claimOperationId, table.claimId],
      foreignColumns: [inventoryAvailabilityClaimOperations.id, inventoryAvailabilityClaimOperations.claimId],
      name: "availability_claim_operation_inputs_operation_fk",
    }).onDelete("restrict"),
    ordinalUnique: uniqueIndex("availability_claim_operation_inputs_ordinal_uq")
      .on(table.claimOperationId, table.inputOrdinal),
    quantityValid: check("availability_claim_operation_inputs_quantity_chk", sql`${table.requiredQty} > 0`),
    ordinalValid: check("availability_claim_operation_inputs_ordinal_chk", sql`${table.inputOrdinal} >= 0`),
  }),
);

export const inventoryAvailabilityClaimResources = inventoryPlanningSchema.table(
  "availability_claim_resources",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: bigint("claim_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityClaims.id, { onDelete: "restrict" }),
    claimLineId: bigint("claim_line_id", { mode: "bigint" }).notNull(),
    consumerOperationKey: varchar("consumer_operation_key", { length: 300 }),
    producerOperationKey: varchar("producer_operation_key", { length: 300 }),
    warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
    warehouseLocationId: integer("warehouse_location_id").notNull()
      .references(() => warehouseLocations.id, { onDelete: "restrict" }),
    inventoryLevelId: integer("inventory_level_id").notNull()
      .references(() => inventoryLevels.id, { onDelete: "restrict" }),
    sourceVariantId: integer("source_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    claimedQty: bigint("claimed_qty", { mode: "bigint" }).notNull(),
    releasedQty: bigint("released_qty", { mode: "bigint" }).notNull().default(BigInt(0)),
    consumedQty: bigint("consumed_qty", { mode: "bigint" }).notNull().default(BigInt(0)),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lineForeignKey: foreignKey({
      columns: [table.claimLineId, table.claimId],
      foreignColumns: [inventoryAvailabilityClaimLines.id, inventoryAvailabilityClaimLines.claimId],
      name: "availability_claim_resources_line_fk",
    }).onDelete("restrict"),
    operationForeignKey: foreignKey({
      columns: [table.claimId, table.consumerOperationKey],
      foreignColumns: [inventoryAvailabilityClaimOperations.claimId, inventoryAvailabilityClaimOperations.operationKey],
      name: "availability_claim_resources_operation_fk",
    }),
    producerOperationForeignKey: foreignKey({
      columns: [table.claimId, table.producerOperationKey],
      foreignColumns: [inventoryAvailabilityClaimOperations.claimId, inventoryAvailabilityClaimOperations.operationKey],
      name: "availability_claim_resources_producer_operation_fk",
    }),
    identityUnique: uniqueIndex("availability_claim_resources_identity_uq").on(
      table.claimLineId,
      table.warehouseId,
      table.warehouseLocationId,
      table.inventoryLevelId,
      table.sourceVariantId,
      sql`COALESCE(${table.consumerOperationKey}, '')`,
      sql`COALESCE(${table.producerOperationKey}, '')`,
    ),
    idClaimUnique: uniqueIndex("availability_claim_resources_id_claim_uq").on(table.id, table.claimId),
    levelLookup: index("availability_claim_resources_level_idx").on(table.inventoryLevelId, table.claimId),
    quantityValid: check(
      "availability_claim_resources_quantity_chk",
      sql`${table.claimedQty} > 0 AND ${table.releasedQty} >= 0 AND ${table.consumedQty} >= 0
        AND ${table.releasedQty} + ${table.consumedQty} <= ${table.claimedQty}`,
    ),
  }),
);

export const inventoryAvailabilityClaimLotAllocations = inventoryPlanningSchema.table(
  "availability_claim_lot_allocations",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: bigint("claim_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityClaims.id, { onDelete: "restrict" }),
    claimResourceId: bigint("claim_resource_id", { mode: "bigint" }).notNull(),
    inventoryLotId: integer("inventory_lot_id").notNull()
      .references(() => inventoryLots.id, { onDelete: "restrict" }),
    claimedQty: bigint("claimed_qty", { mode: "bigint" }).notNull(),
    releasedQty: bigint("released_qty", { mode: "bigint" }).notNull().default(BigInt(0)),
    consumedQty: bigint("consumed_qty", { mode: "bigint" }).notNull().default(BigInt(0)),
    unitCostMills: bigint("unit_cost_mills", { mode: "bigint" }).notNull(),
    poUnitCostMills: bigint("po_unit_cost_mills", { mode: "bigint" }),
    packagingUnitCostMills: bigint("packaging_unit_cost_mills", { mode: "bigint" }),
    landedUnitCostMills: bigint("landed_unit_cost_mills", { mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resourceForeignKey: foreignKey({
      columns: [table.claimResourceId, table.claimId],
      foreignColumns: [inventoryAvailabilityClaimResources.id, inventoryAvailabilityClaimResources.claimId],
      name: "availability_claim_lot_allocations_resource_fk",
    }).onDelete("restrict"),
    resourceLotUnique: uniqueIndex("availability_claim_lot_allocations_resource_lot_uq")
      .on(table.claimResourceId, table.inventoryLotId),
    lotLookup: index("availability_claim_lot_allocations_lot_idx").on(table.inventoryLotId, table.claimId),
    quantityValid: check(
      "availability_claim_lot_allocations_quantity_chk",
      sql`${table.claimedQty} > 0 AND ${table.releasedQty} >= 0 AND ${table.consumedQty} >= 0
        AND ${table.releasedQty} + ${table.consumedQty} <= ${table.claimedQty}`,
    ),
    costValid: check("availability_claim_lot_allocations_cost_chk", sql`${table.unitCostMills} >= 0`),
    costBreakdownValid: check(
      "availability_claim_lot_allocations_cost_breakdown_chk",
      sql`(${table.poUnitCostMills} IS NULL AND ${table.packagingUnitCostMills} IS NULL
          AND ${table.landedUnitCostMills} IS NULL)
        OR (${table.poUnitCostMills} >= 0 AND ${table.packagingUnitCostMills} >= 0
          AND ${table.landedUnitCostMills} >= 0
          AND ${table.poUnitCostMills} + ${table.packagingUnitCostMills}
            + ${table.landedUnitCostMills} = ${table.unitCostMills})`,
    ),
  }),
);

export const inventoryAvailabilityClaimCommands = inventoryPlanningSchema.table(
  "availability_claim_commands",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: bigint("claim_id", { mode: "bigint" })
      .references(() => inventoryAvailabilityClaims.id, { onDelete: "restrict" }),
    orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
    commandType: varchar("command_type", { length: 30 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    resultHash: varchar("result_hash", { length: 64 }).notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    resultPayload: jsonb("result_payload").notNull(),
    actor: varchar("actor", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("availability_claim_commands_idempotency_uq").on(table.idempotencyKey),
    claimLookup: index("availability_claim_commands_claim_idx").on(table.claimId, table.occurredAt, table.id),
    typeValid: check(
      "availability_claim_commands_type_chk",
      sql`${table.commandType} IN ('claim', 'release', 'cancel', 'execute')`,
    ),
    hashValid: check(
      "availability_claim_commands_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$' AND ${table.resultHash} ~ '^[0-9a-f]{64}$'`,
    ),
    actorValid: check(
      "availability_claim_commands_actor_chk",
      sql`btrim(${table.idempotencyKey}) <> '' AND btrim(${table.actor}) <> '' AND btrim(${table.reason}) <> ''`,
    ),
    evidenceValid: check(
      "availability_claim_commands_evidence_chk",
      sql`jsonb_typeof(${table.requestPayload}) = 'object' AND jsonb_typeof(${table.resultPayload}) = 'object'`,
    ),
  }),
);

export const inventoryAvailabilityClaimEvents = inventoryPlanningSchema.table(
  "availability_claim_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    claimId: bigint("claim_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityClaims.id, { onDelete: "restrict" }),
    eventType: varchar("event_type", { length: 50 }).notNull(),
    fromStatus: varchar("from_status", { length: 30 }),
    toStatus: varchar("to_status", { length: 30 }),
    evidencePayload: jsonb("evidence_payload").notNull(),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    actor: varchar("actor", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    claimLookup: index("availability_claim_events_claim_idx").on(table.claimId, table.occurredAt, table.id),
    hashValid: check("availability_claim_events_hash_chk", sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    actorValid: check(
      "availability_claim_events_actor_chk",
      sql`btrim(${table.eventType}) <> '' AND btrim(${table.actor}) <> '' AND btrim(${table.reason}) <> ''`,
    ),
    evidenceValid: check(
      "availability_claim_events_evidence_chk",
      sql`jsonb_typeof(${table.evidencePayload}) = 'object'`,
    ),
  }),
);

export const inventoryAvailabilityActivationCommands = inventoryPlanningSchema.table(
  "availability_activation_commands",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    activationRunId: bigint("activation_run_id", { mode: "bigint" })
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    commandType: varchar("command_type", { length: 30 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    resultHash: varchar("result_hash", { length: 64 }).notNull(),
    requestPayload: jsonb("request_payload").notNull(),
    resultPayload: jsonb("result_payload").notNull(),
    actor: varchar("actor", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("availability_activation_commands_idempotency_uq")
      .on(table.idempotencyKey),
    typeValid: check(
      "availability_activation_commands_type_chk",
      sql`${table.commandType} IN ('prepare', 'abort')`,
    ),
    hashValid: check(
      "availability_activation_commands_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$' AND ${table.resultHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const inventoryAvailabilityActivationFreezes = inventoryPlanningSchema.table(
  "availability_activation_freezes",
  {
    activationRunId: bigint("activation_run_id", { mode: "bigint" }).primaryKey()
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    sourceDryRunId: bigint("source_dry_run_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    acquiredBy: varchar("acquired_by", { length: 100 }).notNull(),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
    releasedBy: varchar("released_by", { length: 100 }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: varchar("release_reason", { length: 1000 }),
  },
  (table) => ({
    evidenceValid: check(
      "availability_activation_freezes_hash_chk",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);

export const inventoryAvailabilityActivationProductEvidence = inventoryPlanningSchema.table(
  "availability_activation_product_evidence",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    activationRunId: bigint("activation_run_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 20 }).notNull(),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    evidencePayload: jsonb("evidence_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    productUnique: uniqueIndex("availability_activation_product_evidence_run_product_uq")
      .on(table.activationRunId, table.productId),
    statusValid: check(
      "availability_activation_product_evidence_status_chk",
      sql`${table.status} IN ('ready', 'blocked')`,
    ),
    evidenceValid: check(
      "availability_activation_product_evidence_payload_chk",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(${table.evidencePayload}) = 'object'`,
    ),
  }),
);

export const inventoryPublicationTargets = inventoryPlanningSchema.table(
  "inventory_publication_targets",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
    channelConnectionId: integer("channel_connection_id").notNull(),
    fulfillmentNodeId: integer("fulfillment_node_id").notNull()
      .references(() => fulfillmentNodes.id, { onDelete: "restrict" }),
    providerScopeType: varchar("provider_scope_type", { length: 30 }).notNull(),
    externalScopeId: varchar("external_scope_id", { length: 240 }).notNull(),
    publicationAuthority: varchar("publication_authority", { length: 30 }).notNull(),
    state: varchar("state", { length: 20 }).notNull().default("disabled"),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    activatedBy: varchar("activated_by", { length: 100 }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(1)),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    connectionChannelForeignKey: foreignKey({
      columns: [table.channelConnectionId, table.channelId],
      foreignColumns: [channelConnections.id, channelConnections.channelId],
      name: "inventory_publication_targets_connection_channel_fk",
    }).onDelete("restrict"),
    identityUnique: uniqueIndex("inventory_publication_targets_identity_uq").on(
      table.channelConnectionId,
      table.fulfillmentNodeId,
      table.providerScopeType,
      table.externalScopeId,
    ),
    stateValid: check(
      "inventory_publication_targets_state_chk",
      sql`${table.state} IN ('disabled', 'preview', 'live')`,
    ),
    scopeValid: check(
      "inventory_publication_targets_scope_chk",
      sql`${table.providerScopeType} IN ('account', 'location')
        AND btrim(${table.externalScopeId}) <> ''`,
    ),
    authorityValid: check(
      "inventory_publication_targets_authority_chk",
      sql`${table.publicationAuthority} IN ('echelon', 'external_provider', 'manual')`,
    ),
    actorValid: check(
      "inventory_publication_targets_actor_chk",
      sql`btrim(${table.createdBy}) <> '' AND btrim(${table.changeReason}) <> ''`,
    ),
    activationValid: check(
      "inventory_publication_targets_activation_chk",
      sql`(${table.state} = 'disabled' AND ${table.activatedBy} IS NULL AND ${table.activatedAt} IS NULL)
        OR (${table.state} IN ('preview', 'live')
          AND ${table.activatedBy} IS NOT NULL AND btrim(${table.activatedBy}) <> ''
          AND ${table.activatedAt} IS NOT NULL)`,
    ),
    revisionValid: check("inventory_publication_targets_revision_chk", sql`${table.revision} > 0`),
  }),
);

export const channelExposurePolicyVersions = inventoryPlanningSchema.table(
  "channel_exposure_policy_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    scopeKey: varchar("scope_key", { length: 200 }).notNull(),
    channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
    scopeType: varchar("scope_type", { length: 20 }).notNull(),
    productId: integer("product_id").references(() => products.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id"),
    version: integer("version").notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    allocationSemantics: varchar("allocation_semantics", { length: 20 }),
    eligible: boolean("eligible"),
    shareBps: integer("share_bps"),
    holdbackSellableUnits: bigint("holdback_sellable_units", { mode: "bigint" }),
    maxPublishMode: varchar("max_publish_mode", { length: 20 }),
    maxPublishSellableUnits: bigint("max_publish_sellable_units", { mode: "bigint" }),
    minPublishSellableUnits: bigint("min_publish_sellable_units", { mode: "bigint" }),
    definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
    supersedesPolicyId: integer("supersedes_policy_id")
      .references((): AnyPgColumn => channelExposurePolicyVersions.id, { onDelete: "restrict" }),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    variantProductForeignKey: foreignKey({
      columns: [table.productVariantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "channel_exposure_policy_versions_variant_product_fk",
    }).onDelete("restrict"),
    scopeVersionUnique: uniqueIndex("channel_exposure_policy_versions_scope_version_uq")
      .on(table.scopeKey, table.version),
    idScopeUnique: uniqueIndex("channel_exposure_policy_versions_id_scope_uq")
      .on(table.id, table.scopeKey),
    idempotencyUnique: uniqueIndex("channel_exposure_policy_versions_idempotency_uq")
      .on(table.idempotencyKey),
    oneDraft: uniqueIndex("channel_exposure_policy_versions_one_draft_uq")
      .on(table.scopeKey).where(sql`${table.lifecycleStatus} = 'draft'`),
    successorUnique: uniqueIndex("channel_exposure_policy_versions_successor_uq")
      .on(table.supersedesPolicyId).where(sql`${table.supersedesPolicyId} IS NOT NULL`),
    resolutionIndex: index("channel_exposure_policy_versions_resolution_idx")
      .on(table.channelId, table.productId, table.productVariantId, table.id),
    scopeValid: check(
      "channel_exposure_policy_versions_scope_chk",
      sql`(${table.scopeType} = 'channel'
          AND ${table.scopeKey} = 'channel:' || ${table.channelId}::text
          AND ${table.productId} IS NULL AND ${table.productVariantId} IS NULL)
        OR (${table.scopeType} = 'product'
          AND ${table.scopeKey} = 'channel:' || ${table.channelId}::text
            || ':product:' || ${table.productId}::text
          AND ${table.productId} IS NOT NULL AND ${table.productVariantId} IS NULL)
        OR (${table.scopeType} = 'variant'
          AND ${table.scopeKey} = 'channel:' || ${table.channelId}::text
            || ':variant:' || ${table.productVariantId}::text
          AND ${table.productId} IS NOT NULL AND ${table.productVariantId} IS NOT NULL)`,
    ),
    valuePresent: check(
      "channel_exposure_policy_versions_value_chk",
      sql`${table.allocationSemantics} IS NOT NULL OR ${table.eligible} IS NOT NULL
        OR ${table.shareBps} IS NOT NULL OR ${table.holdbackSellableUnits} IS NOT NULL
        OR ${table.maxPublishMode} IS NOT NULL
        OR ${table.minPublishSellableUnits} IS NOT NULL`,
    ),
    semanticsValid: check(
      "channel_exposure_policy_versions_semantics_chk",
      sql`${table.allocationSemantics} IS NULL
        OR ${table.allocationSemantics} IN ('exposure', 'partitioned')`,
    ),
    quantitiesValid: check(
      "channel_exposure_policy_versions_quantity_chk",
      sql`(${table.shareBps} IS NULL OR ${table.shareBps} BETWEEN 0 AND 10000)
        AND (${table.holdbackSellableUnits} IS NULL OR ${table.holdbackSellableUnits} >= 0)
        AND ((${table.maxPublishMode} IS NULL AND ${table.maxPublishSellableUnits} IS NULL)
          OR (${table.maxPublishMode} = 'unlimited' AND ${table.maxPublishSellableUnits} IS NULL)
          OR (${table.maxPublishMode} = 'units' AND ${table.maxPublishSellableUnits} IS NOT NULL
            AND ${table.maxPublishSellableUnits} >= 0))
        AND (${table.minPublishSellableUnits} IS NULL OR ${table.minPublishSellableUnits} >= 0)`,
    ),
    versionPositive: check("channel_exposure_policy_versions_version_chk", sql`${table.version} > 0`),
    statusValid: check(
      "channel_exposure_policy_versions_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired')`,
    ),
    hashValid: check(
      "channel_exposure_policy_versions_hash_chk",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    actorValid: check(
      "channel_exposure_policy_versions_actor_chk",
      sql`char_length(btrim(${table.createdBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.changeReason})) BETWEEN 1 AND 1000`,
    ),
    predecessorValid: check(
      "channel_exposure_policy_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesPolicyId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesPolicyId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "channel_exposure_policy_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.sealedAt})`,
    ),
  }),
);

export const channelExposurePolicyHeads = inventoryPlanningSchema.table(
  "channel_exposure_policy_heads",
  {
    scopeKey: varchar("scope_key", { length: 200 }).primaryKey(),
    channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "restrict" }),
    activePolicyId: integer("active_policy_id"),
    draftPolicyId: integer("draft_policy_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(1)),
    updatedBy: varchar("updated_by", { length: 100 }).notNull(),
    updateReason: varchar("update_reason", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activePolicyForeignKey: foreignKey({
      columns: [table.activePolicyId, table.scopeKey],
      foreignColumns: [channelExposurePolicyVersions.id, channelExposurePolicyVersions.scopeKey],
      name: "channel_exposure_policy_heads_active_fk",
    }).onDelete("restrict"),
    draftPolicyForeignKey: foreignKey({
      columns: [table.draftPolicyId, table.scopeKey],
      foreignColumns: [channelExposurePolicyVersions.id, channelExposurePolicyVersions.scopeKey],
      name: "channel_exposure_policy_heads_draft_fk",
    }).onDelete("restrict"),
    pointersDistinct: check(
      "channel_exposure_policy_heads_distinct_chk",
      sql`${table.activePolicyId} IS NULL OR ${table.draftPolicyId} IS NULL
        OR ${table.activePolicyId} <> ${table.draftPolicyId}`,
    ),
    revisionValid: check("channel_exposure_policy_heads_revision_chk", sql`${table.revision} >= 0`),
    actorValid: check(
      "channel_exposure_policy_heads_actor_chk",
      sql`char_length(btrim(${table.updatedBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.updateReason})) BETWEEN 1 AND 1000`,
    ),
  }),
);

export const publicationSourceBindingVersions = inventoryPlanningSchema.table(
  "publication_source_binding_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    publicationTargetId: integer("publication_target_id").notNull()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
    supersedesBindingId: integer("supersedes_binding_id")
      .references((): AnyPgColumn => publicationSourceBindingVersions.id, { onDelete: "restrict" }),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetVersionUnique: uniqueIndex("publication_source_binding_versions_target_version_uq")
      .on(table.publicationTargetId, table.version),
    idTargetUnique: uniqueIndex("publication_source_binding_versions_id_target_uq")
      .on(table.id, table.publicationTargetId),
    idempotencyUnique: uniqueIndex("publication_source_binding_versions_idempotency_uq")
      .on(table.idempotencyKey),
    oneDraft: uniqueIndex("publication_source_binding_versions_one_draft_uq")
      .on(table.publicationTargetId).where(sql`${table.lifecycleStatus} = 'draft'`),
    successorUnique: uniqueIndex("publication_source_binding_versions_successor_uq")
      .on(table.supersedesBindingId).where(sql`${table.supersedesBindingId} IS NOT NULL`),
    versionPositive: check("publication_source_binding_versions_version_chk", sql`${table.version} > 0`),
    statusValid: check(
      "publication_source_binding_versions_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired')`,
    ),
    hashValid: check(
      "publication_source_binding_versions_hash_chk",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    actorValid: check(
      "publication_source_binding_versions_actor_chk",
      sql`char_length(btrim(${table.createdBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.changeReason})) BETWEEN 1 AND 1000`,
    ),
    predecessorValid: check(
      "publication_source_binding_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesBindingId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesBindingId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "publication_source_binding_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.sealedAt})`,
    ),
  }),
);

export const publicationSourceBindingMembers = inventoryPlanningSchema.table(
  "publication_source_binding_members",
  {
    bindingId: integer("binding_id").notNull(),
    publicationTargetId: integer("publication_target_id").notNull(),
    fulfillmentNodeId: integer("fulfillment_node_id").notNull()
      .references(() => fulfillmentNodes.id, { onDelete: "restrict" }),
    priority: integer("priority").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.bindingId, table.fulfillmentNodeId] }),
    bindingForeignKey: foreignKey({
      columns: [table.bindingId, table.publicationTargetId],
      foreignColumns: [publicationSourceBindingVersions.id, publicationSourceBindingVersions.publicationTargetId],
      name: "publication_source_binding_members_binding_fk",
    }).onDelete("cascade"),
    priorityUnique: uniqueIndex("publication_source_binding_members_priority_uq")
      .on(table.bindingId, table.priority),
    targetIndex: index("publication_source_binding_members_target_idx")
      .on(table.publicationTargetId, table.bindingId, table.priority),
    priorityValid: check("publication_source_binding_members_priority_chk", sql`${table.priority} > 0`),
  }),
);

export const publicationSourceBindingHeads = inventoryPlanningSchema.table(
  "publication_source_binding_heads",
  {
    publicationTargetId: integer("publication_target_id").primaryKey()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    activeBindingId: integer("active_binding_id"),
    draftBindingId: integer("draft_binding_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(1)),
    updatedBy: varchar("updated_by", { length: 100 }).notNull(),
    updateReason: varchar("update_reason", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeBindingForeignKey: foreignKey({
      columns: [table.activeBindingId, table.publicationTargetId],
      foreignColumns: [publicationSourceBindingVersions.id, publicationSourceBindingVersions.publicationTargetId],
      name: "publication_source_binding_heads_active_fk",
    }).onDelete("restrict"),
    draftBindingForeignKey: foreignKey({
      columns: [table.draftBindingId, table.publicationTargetId],
      foreignColumns: [publicationSourceBindingVersions.id, publicationSourceBindingVersions.publicationTargetId],
      name: "publication_source_binding_heads_draft_fk",
    }).onDelete("restrict"),
    pointersDistinct: check(
      "publication_source_binding_heads_distinct_chk",
      sql`${table.activeBindingId} IS NULL OR ${table.draftBindingId} IS NULL
        OR ${table.activeBindingId} <> ${table.draftBindingId}`,
    ),
    revisionValid: check("publication_source_binding_heads_revision_chk", sql`${table.revision} >= 0`),
    actorValid: check(
      "publication_source_binding_heads_actor_chk",
      sql`char_length(btrim(${table.updatedBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.updateReason})) BETWEEN 1 AND 1000`,
    ),
  }),
);

export const publicationVariantMappingVersions = inventoryPlanningSchema.table(
  "publication_variant_mapping_versions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    publicationTargetId: integer("publication_target_id").notNull()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    lifecycleStatus: varchar("lifecycle_status", { length: 20 }).notNull().default("draft"),
    externalInventoryItemId: varchar("external_inventory_item_id", { length: 240 }).notNull(),
    externalSku: varchar("external_sku", { length: 100 }),
    definitionHash: varchar("definition_hash", { length: 64 }).notNull(),
    supersedesMappingId: integer("supersedes_mapping_id")
      .references((): AnyPgColumn => publicationVariantMappingVersions.id, { onDelete: "restrict" }),
    changeReason: varchar("change_reason", { length: 1000 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    targetVariantVersionUnique: uniqueIndex("publication_variant_mapping_versions_target_variant_version_uq")
      .on(table.publicationTargetId, table.productVariantId, table.version),
    idScopeUnique: uniqueIndex("publication_variant_mapping_versions_id_scope_uq")
      .on(table.id, table.publicationTargetId, table.productVariantId),
    idempotencyUnique: uniqueIndex("publication_variant_mapping_versions_idempotency_uq")
      .on(table.idempotencyKey),
    oneDraft: uniqueIndex("publication_variant_mapping_versions_one_draft_uq")
      .on(table.publicationTargetId, table.productVariantId)
      .where(sql`${table.lifecycleStatus} = 'draft'`),
    successorUnique: uniqueIndex("publication_variant_mapping_versions_successor_uq")
      .on(table.supersedesMappingId).where(sql`${table.supersedesMappingId} IS NOT NULL`),
    resolutionIndex: index("publication_variant_mapping_versions_resolution_idx")
      .on(table.publicationTargetId, table.productVariantId, table.id),
    versionValid: check("publication_variant_mapping_versions_version_chk", sql`${table.version} > 0`),
    statusValid: check(
      "publication_variant_mapping_versions_status_chk",
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired')`,
    ),
    identityValid: check(
      "publication_variant_mapping_versions_identity_chk",
      sql`char_length(btrim(${table.externalInventoryItemId})) BETWEEN 1 AND 240
        AND (${table.externalSku} IS NULL
          OR char_length(btrim(${table.externalSku})) BETWEEN 1 AND 100)`,
    ),
    hashValid: check(
      "publication_variant_mapping_versions_hash_chk",
      sql`${table.definitionHash} ~ '^[0-9a-f]{64}$' AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    actorValid: check(
      "publication_variant_mapping_versions_actor_chk",
      sql`char_length(btrim(${table.createdBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.changeReason})) BETWEEN 1 AND 1000`,
    ),
    predecessorValid: check(
      "publication_variant_mapping_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesMappingId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesMappingId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "publication_variant_mapping_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'retired'
          AND ${table.sealedBy} IS NOT NULL AND btrim(${table.sealedBy}) <> ''
          AND ${table.sealedAt} IS NOT NULL
          AND ${table.retiredBy} IS NOT NULL AND btrim(${table.retiredBy}) <> ''
          AND ${table.retiredAt} IS NOT NULL AND ${table.retiredAt} >= ${table.sealedAt})`,
    ),
  }),
);

export const publicationVariantMappingHeads = inventoryPlanningSchema.table(
  "publication_variant_mapping_heads",
  {
    publicationTargetId: integer("publication_target_id").notNull()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    activeMappingId: integer("active_mapping_id"),
    draftMappingId: integer("draft_mapping_id"),
    revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(1)),
    updatedBy: varchar("updated_by", { length: 100 }).notNull(),
    updateReason: varchar("update_reason", { length: 1000 }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    primaryKey: primaryKey({ columns: [table.publicationTargetId, table.productVariantId] }),
    activeMappingForeignKey: foreignKey({
      columns: [table.activeMappingId, table.publicationTargetId, table.productVariantId],
      foreignColumns: [
        publicationVariantMappingVersions.id,
        publicationVariantMappingVersions.publicationTargetId,
        publicationVariantMappingVersions.productVariantId,
      ],
      name: "publication_variant_mapping_heads_active_fk",
    }).onDelete("restrict"),
    draftMappingForeignKey: foreignKey({
      columns: [table.draftMappingId, table.publicationTargetId, table.productVariantId],
      foreignColumns: [
        publicationVariantMappingVersions.id,
        publicationVariantMappingVersions.publicationTargetId,
        publicationVariantMappingVersions.productVariantId,
      ],
      name: "publication_variant_mapping_heads_draft_fk",
    }).onDelete("restrict"),
    pointersDistinct: check(
      "publication_variant_mapping_heads_distinct_chk",
      sql`${table.activeMappingId} IS NULL OR ${table.draftMappingId} IS NULL
        OR ${table.activeMappingId} <> ${table.draftMappingId}`,
    ),
    revisionValid: check("publication_variant_mapping_heads_revision_chk", sql`${table.revision} > 0`),
    actorValid: check(
      "publication_variant_mapping_heads_actor_chk",
      sql`char_length(btrim(${table.updatedBy})) BETWEEN 1 AND 100
        AND char_length(btrim(${table.updateReason})) BETWEEN 1 AND 1000`,
    ),
  }),
);

export const inventoryPublicationOutbox = inventoryPlanningSchema.table(
  "inventory_publication_outbox",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    activationRunId: bigint("activation_run_id", { mode: "bigint" })
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    publicationTargetId: integer("publication_target_id").notNull()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    desiredRevision: bigint("desired_revision", { mode: "bigint" }).notNull(),
    desiredQuantity: bigint("desired_quantity", { mode: "bigint" }).notNull(),
    channelConnectionIdSnapshot: integer("channel_connection_id_snapshot").notNull(),
    externalScopeIdSnapshot: varchar("external_scope_id_snapshot", { length: 240 }).notNull(),
    externalInventoryItemIdSnapshot: varchar("external_inventory_item_id_snapshot", { length: 240 }).notNull(),
    publicationPhase: varchar("publication_phase", { length: 20 }).notNull().default("legacy"),
    channelIdSnapshot: integer("channel_id_snapshot"),
    providerKeySnapshot: varchar("provider_key_snapshot", { length: 60 }),
    providerScopeTypeSnapshot: varchar("provider_scope_type_snapshot", { length: 30 }),
    externalSkuSnapshot: varchar("external_sku_snapshot", { length: 100 }),
    publicationTargetRevisionSnapshot: bigint("publication_target_revision_snapshot", { mode: "bigint" }),
    state: varchar("state", { length: 30 }).notNull().default("desired"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    leaseToken: varchar("lease_token", { length: 120 }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastErrorClass: varchar("last_error_class", { length: 60 }),
    lastErrorMessage: varchar("last_error_message", { length: 2000 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    revisionUnique: uniqueIndex("inventory_publication_outbox_target_variant_revision_uq")
      .on(table.publicationTargetId, table.productVariantId, table.desiredRevision),
    idempotencyUnique: uniqueIndex("inventory_publication_outbox_idempotency_uq")
      .on(table.idempotencyKey),
    dispatchLookup: index("inventory_publication_outbox_dispatch_idx")
      .on(table.state, table.availableAt, table.id),
    quantityValid: check(
      "inventory_publication_outbox_quantity_chk",
      sql`${table.desiredRevision} > 0 AND ${table.desiredQuantity} >= 0 AND ${table.attemptCount} >= 0`,
    ),
    stateValid: check(
      "inventory_publication_outbox_state_chk",
      sql`${table.state} IN (
        'desired', 'queued', 'leased', 'acknowledged', 'verified', 'drifted',
        'retryable', 'dead_letter', 'superseded', 'cancelled'
      )`,
    ),
    phaseValid: check(
      "inventory_publication_outbox_phase_chk",
      sql`${table.publicationPhase} IN ('legacy', 'conservative', 'full')`,
    ),
    hashValid: check(
      "inventory_publication_outbox_hash_chk",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    identityValid: check(
      "inventory_publication_outbox_identity_chk",
      sql`btrim(${table.idempotencyKey}) <> ''
        AND btrim(${table.externalScopeIdSnapshot}) <> ''
        AND btrim(${table.externalInventoryItemIdSnapshot}) <> ''`,
    ),
    leaseValid: check(
      "inventory_publication_outbox_lease_chk",
      sql`(${table.state} = 'leased' AND ${table.leaseToken} IS NOT NULL
          AND btrim(${table.leaseToken}) <> '' AND ${table.leaseExpiresAt} IS NOT NULL)
        OR (${table.state} <> 'leased' AND ${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)`,
    ),
  }),
);

export const inventoryPublicationAttempts = inventoryPlanningSchema.table(
  "inventory_publication_attempts",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    outboxId: bigint("outbox_id", { mode: "bigint" }).notNull()
      .references(() => inventoryPublicationOutbox.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    outcome: varchar("outcome", { length: 30 }).notNull(),
    providerRequestKey: varchar("provider_request_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseHash: varchar("response_hash", { length: 64 }),
    errorClass: varchar("error_class", { length: 60 }),
    errorMessage: varchar("error_message", { length: 2000 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    attemptUnique: uniqueIndex("inventory_publication_attempts_outbox_attempt_uq")
      .on(table.outboxId, table.attemptNumber),
    outcomeValid: check(
      "inventory_publication_attempts_outcome_chk",
      sql`${table.outcome} IN ('acknowledged', 'retryable', 'dead_letter', 'cancelled')`,
    ),
    evidenceValid: check(
      "inventory_publication_attempts_evidence_chk",
      sql`${table.attemptNumber} > 0
        AND ${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND (${table.responseHash} IS NULL OR ${table.responseHash} ~ '^[0-9a-f]{64}$')
        AND btrim(${table.providerRequestKey}) <> ''
        AND ${table.completedAt} >= ${table.startedAt}`,
    ),
  }),
);

export const inventoryPublicationReadbackRuns = inventoryPlanningSchema.table(
  "inventory_publication_readback_runs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    state: varchar("state", { length: 20 }).notNull().default("running"),
    idempotencyKey: varchar("idempotency_key", { length: 120 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    resultHash: varchar("result_hash", { length: 64 }),
    resultPayload: jsonb("result_payload"),
    requestedBy: varchar("requested_by", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyUnique: uniqueIndex("inventory_publication_readback_runs_idempotency_uq")
      .on(table.idempotencyKey),
    stateValid: check(
      "inventory_publication_readback_runs_state_chk",
      sql`${table.state} IN ('running', 'completed', 'partial')`,
    ),
    hashValid: check(
      "inventory_publication_readback_runs_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND (${table.resultHash} IS NULL OR ${table.resultHash} ~ '^[0-9a-f]{64}$')`,
    ),
  }),
);

export const inventoryPublicationReadbackRunItems = inventoryPlanningSchema.table(
  "inventory_publication_readback_run_items",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    readbackRunId: bigint("readback_run_id", { mode: "bigint" }).notNull()
      .references(() => inventoryPublicationReadbackRuns.id, { onDelete: "restrict" }),
    publicationTargetId: integer("publication_target_id").notNull()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 20 }).notNull(),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    evidencePayload: jsonb("evidence_payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identityUnique: uniqueIndex("inventory_publication_readback_run_items_identity_uq")
      .on(table.readbackRunId, table.publicationTargetId, table.productVariantId),
    statusValid: check(
      "inventory_publication_readback_run_items_status_chk",
      sql`${table.status} IN ('observed', 'failed')`,
    ),
    evidenceValid: check(
      "inventory_publication_readback_run_items_evidence_chk",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$' AND jsonb_typeof(${table.evidencePayload}) = 'object'`,
    ),
  }),
);

export const inventoryPublicationReadbacks = inventoryPlanningSchema.table(
  "inventory_publication_readbacks",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    publicationTargetId: integer("publication_target_id").notNull()
      .references(() => inventoryPublicationTargets.id, { onDelete: "restrict" }),
    productVariantId: integer("product_variant_id").notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    outboxId: bigint("outbox_id", { mode: "bigint" })
      .references(() => inventoryPublicationOutbox.id, { onDelete: "restrict" }),
    readbackRunId: bigint("readback_run_id", { mode: "bigint" })
      .references(() => inventoryPublicationReadbackRuns.id, { onDelete: "restrict" }),
    channelConnectionIdSnapshot: integer("channel_connection_id_snapshot"),
    providerScopeTypeSnapshot: varchar("provider_scope_type_snapshot", { length: 30 }),
    externalScopeIdSnapshot: varchar("external_scope_id_snapshot", { length: 240 }),
    publicationTargetRevisionSnapshot: bigint("publication_target_revision_snapshot", { mode: "bigint" }),
    externalInventoryItemIdSnapshot: varchar("external_inventory_item_id_snapshot", { length: 240 }),
    observedQuantity: bigint("observed_quantity", { mode: "bigint" }).notNull(),
    matchesDesired: boolean("matches_desired"),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    observationUnique: uniqueIndex("inventory_publication_readbacks_target_variant_observed_uq")
      .on(table.publicationTargetId, table.productVariantId, table.observedAt, table.evidenceHash),
    evidenceValid: check(
      "inventory_publication_readbacks_evidence_chk",
      sql`${table.observedQuantity} >= 0
        AND ${table.evidenceHash} ~ '^[0-9a-f]{64}$'
        AND ((${table.outboxId} IS NULL AND ${table.matchesDesired} IS NULL)
          OR (${table.outboxId} IS NOT NULL AND ${table.matchesDesired} IS NOT NULL))`,
    ),
    identitySnapshotValid: check(
      "inventory_publication_readbacks_identity_snapshot_chk",
      sql`${table.externalInventoryItemIdSnapshot} IS NULL
        OR char_length(btrim(${table.externalInventoryItemIdSnapshot})) BETWEEN 1 AND 240`,
    ),
  }),
);

export const inventoryAvailabilityActivationEvents = inventoryPlanningSchema.table(
  "availability_activation_events",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    activationRunId: bigint("activation_run_id", { mode: "bigint" }).notNull()
      .references(() => inventoryAvailabilityActivationRuns.id, { onDelete: "restrict" }),
    fromState: varchar("from_state", { length: 40 }),
    toState: varchar("to_state", { length: 40 }).notNull(),
    actor: varchar("actor", { length: 100 }).notNull(),
    reason: varchar("reason", { length: 1000 }).notNull(),
    evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
    evidencePayload: jsonb("evidence_payload").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookup: index("availability_activation_events_run_idx")
      .on(table.activationRunId, table.occurredAt, table.id),
    evidenceValid: check(
      "availability_activation_events_evidence_chk",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'
        AND btrim(${table.actor}) <> '' AND btrim(${table.reason}) <> ''`,
    ),
  }),
);

const generatedFields = { id: true, createdAt: true, updatedAt: true } as const;

export const insertFulfillmentNodeSchema = createInsertSchema(fulfillmentNodes).omit(generatedFields);
export const insertFulfillmentProviderAccountSchema = createInsertSchema(fulfillmentProviderAccounts)
  .omit(generatedFields);
export const insertFulfillmentProviderLocationSchema = createInsertSchema(fulfillmentProviderLocations)
  .omit(generatedFields);
export const insertFulfillmentNodeProviderBindingSchema = createInsertSchema(
  fulfillmentNodeProviderBindings,
).omit(generatedFields);
export const insertLocationPromisePolicyVersionSchema = createInsertSchema(
  locationPromisePolicyVersions,
).omit(generatedFields);
export const insertTransformationModelVersionSchema = createInsertSchema(transformationModelVersions)
  .omit(generatedFields);
export const insertTransformationModelReviewSchema = createInsertSchema(transformationModelReviews)
  .omit({ id: true, createdAt: true });
export const insertTransformationModelPathSchema = createInsertSchema(transformationModelPaths)
  .omit({ id: true, createdAt: true });
export const insertTransformationRecipeBindingSchema = createInsertSchema(
  transformationRecipeBindings,
).omit({ id: true, createdAt: true });
export const insertTransformationRecipeComponentSnapshotSchema = createInsertSchema(
  transformationRecipeComponentSnapshots,
).omit({ id: true, createdAt: true });
export const insertPromiseSafetyPolicyVersionSchema = createInsertSchema(promiseSafetyPolicyVersions)
  .omit(generatedFields);
export const insertDemandEvidenceSnapshotSchema = createInsertSchema(demandEvidenceSnapshots)
  .omit({ id: true, createdAt: true });
export const insertPlannerShadowRunSchema = createInsertSchema(plannerShadowRuns)
  .omit({ id: true, createdAt: true });
export const insertPlannerShadowResultSchema = createInsertSchema(plannerShadowResults)
  .omit({ id: true, createdAt: true });
export const insertPlannerClaimSimulationRunSchema = createInsertSchema(plannerClaimSimulationRuns)
  .omit({ id: true, createdAt: true });
export const insertInventoryAvailabilityActivationRunSchema = createInsertSchema(
  inventoryAvailabilityActivationRuns,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryAvailabilityRuntimeAuthoritySchema = createInsertSchema(
  inventoryAvailabilityRuntimeAuthority,
).omit({ changedAt: true });
export const insertInventoryAvailabilityClaimSchema = createInsertSchema(inventoryAvailabilityClaims)
  .omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryAvailabilityClaimLineSchema = createInsertSchema(inventoryAvailabilityClaimLines)
  .omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryAvailabilityClaimOperationSchema = createInsertSchema(
  inventoryAvailabilityClaimOperations,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryAvailabilityClaimOperationInputSchema = createInsertSchema(
  inventoryAvailabilityClaimOperationInputs,
).omit({ createdAt: true });
export const insertInventoryAvailabilityClaimResourceSchema = createInsertSchema(
  inventoryAvailabilityClaimResources,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryAvailabilityClaimLotAllocationSchema = createInsertSchema(
  inventoryAvailabilityClaimLotAllocations,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryAvailabilityClaimCommandSchema = createInsertSchema(
  inventoryAvailabilityClaimCommands,
).omit({ id: true, createdAt: true });
export const insertInventoryAvailabilityClaimEventSchema = createInsertSchema(
  inventoryAvailabilityClaimEvents,
).omit({ id: true, createdAt: true });
export const insertInventoryAvailabilityActivationCommandSchema = createInsertSchema(
  inventoryAvailabilityActivationCommands,
).omit({ id: true, createdAt: true });
export const insertInventoryAvailabilityActivationFreezeSchema = createInsertSchema(
  inventoryAvailabilityActivationFreezes,
);
export const insertInventoryAvailabilityActivationProductEvidenceSchema = createInsertSchema(
  inventoryAvailabilityActivationProductEvidence,
).omit({ id: true, createdAt: true });
export const insertInventoryPublicationTargetSchema = createInsertSchema(inventoryPublicationTargets)
  .omit(generatedFields);
export const insertChannelExposurePolicyVersionSchema = createInsertSchema(channelExposurePolicyVersions)
  .omit(generatedFields);
export const insertPublicationSourceBindingVersionSchema = createInsertSchema(
  publicationSourceBindingVersions,
).omit(generatedFields);
export const insertPublicationSourceBindingMemberSchema = createInsertSchema(
  publicationSourceBindingMembers,
).omit({ createdAt: true });
export const insertPublicationVariantMappingVersionSchema = createInsertSchema(
  publicationVariantMappingVersions,
).omit(generatedFields);
export const insertInventoryPublicationOutboxSchema = createInsertSchema(inventoryPublicationOutbox)
  .omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryPublicationAttemptSchema = createInsertSchema(inventoryPublicationAttempts)
  .omit({ id: true, createdAt: true });
export const insertInventoryPublicationReadbackRunSchema = createInsertSchema(
  inventoryPublicationReadbackRuns,
).omit({ id: true, createdAt: true, updatedAt: true });
export const insertInventoryPublicationReadbackRunItemSchema = createInsertSchema(
  inventoryPublicationReadbackRunItems,
).omit({ id: true, createdAt: true });
export const insertInventoryPublicationReadbackSchema = createInsertSchema(inventoryPublicationReadbacks)
  .omit({ id: true, recordedAt: true });
export const insertInventoryAvailabilityActivationEventSchema = createInsertSchema(
  inventoryAvailabilityActivationEvents,
).omit({ id: true, createdAt: true });

export type FulfillmentNode = typeof fulfillmentNodes.$inferSelect;
export type FulfillmentProviderAccount = typeof fulfillmentProviderAccounts.$inferSelect;
export type FulfillmentProviderLocation = typeof fulfillmentProviderLocations.$inferSelect;
export type FulfillmentNodeProviderBinding = typeof fulfillmentNodeProviderBindings.$inferSelect;
export type LocationPromisePolicyVersion = typeof locationPromisePolicyVersions.$inferSelect;
export type TransformationModelVersion = typeof transformationModelVersions.$inferSelect;
export type TransformationModelReview = typeof transformationModelReviews.$inferSelect;
export type TransformationModelPath = typeof transformationModelPaths.$inferSelect;
export type TransformationRecipeBinding = typeof transformationRecipeBindings.$inferSelect;
export type TransformationRecipeComponentSnapshot =
  typeof transformationRecipeComponentSnapshots.$inferSelect;
export type PromiseSafetyPolicyVersion = typeof promiseSafetyPolicyVersions.$inferSelect;
export type DemandEvidenceSnapshot = typeof demandEvidenceSnapshots.$inferSelect;
export type PlannerShadowRun = typeof plannerShadowRuns.$inferSelect;
export type PlannerShadowResult = typeof plannerShadowResults.$inferSelect;
export type PlannerClaimSimulationRun = typeof plannerClaimSimulationRuns.$inferSelect;
export type InventoryAvailabilityActivationRun = typeof inventoryAvailabilityActivationRuns.$inferSelect;
export type InventoryAvailabilityRuntimeAuthority = typeof inventoryAvailabilityRuntimeAuthority.$inferSelect;
export type InventoryAvailabilityClaim = typeof inventoryAvailabilityClaims.$inferSelect;
export type InventoryAvailabilityClaimLine = typeof inventoryAvailabilityClaimLines.$inferSelect;
export type InventoryAvailabilityClaimOperation = typeof inventoryAvailabilityClaimOperations.$inferSelect;
export type InventoryAvailabilityClaimOperationInput =
  typeof inventoryAvailabilityClaimOperationInputs.$inferSelect;
export type InventoryAvailabilityClaimResource = typeof inventoryAvailabilityClaimResources.$inferSelect;
export type InventoryAvailabilityClaimLotAllocation =
  typeof inventoryAvailabilityClaimLotAllocations.$inferSelect;
export type InventoryAvailabilityClaimCommand = typeof inventoryAvailabilityClaimCommands.$inferSelect;
export type InventoryAvailabilityClaimEvent = typeof inventoryAvailabilityClaimEvents.$inferSelect;
export type InventoryAvailabilityActivationCommand = typeof inventoryAvailabilityActivationCommands.$inferSelect;
export type InventoryAvailabilityActivationFreeze = typeof inventoryAvailabilityActivationFreezes.$inferSelect;
export type InventoryAvailabilityActivationProductEvidence =
  typeof inventoryAvailabilityActivationProductEvidence.$inferSelect;
export type InventoryPublicationTarget = typeof inventoryPublicationTargets.$inferSelect;
export type ChannelExposurePolicyVersion = typeof channelExposurePolicyVersions.$inferSelect;
export type ChannelExposurePolicyHead = typeof channelExposurePolicyHeads.$inferSelect;
export type PublicationSourceBindingVersion = typeof publicationSourceBindingVersions.$inferSelect;
export type PublicationSourceBindingMember = typeof publicationSourceBindingMembers.$inferSelect;
export type PublicationSourceBindingHead = typeof publicationSourceBindingHeads.$inferSelect;
export type PublicationVariantMappingVersion = typeof publicationVariantMappingVersions.$inferSelect;
export type PublicationVariantMappingHead = typeof publicationVariantMappingHeads.$inferSelect;
export type InventoryPublicationOutboxEntry = typeof inventoryPublicationOutbox.$inferSelect;
export type InventoryPublicationAttempt = typeof inventoryPublicationAttempts.$inferSelect;
export type InventoryPublicationReadbackRun = typeof inventoryPublicationReadbackRuns.$inferSelect;
export type InventoryPublicationReadbackRunItem = typeof inventoryPublicationReadbackRunItems.$inferSelect;
export type InventoryPublicationReadback = typeof inventoryPublicationReadbacks.$inferSelect;
export type InventoryAvailabilityActivationEvent = typeof inventoryAvailabilityActivationEvents.$inferSelect;

export type InsertFulfillmentNode = z.infer<typeof insertFulfillmentNodeSchema>;
export type InsertFulfillmentProviderAccount = z.infer<typeof insertFulfillmentProviderAccountSchema>;
export type InsertFulfillmentProviderLocation = z.infer<typeof insertFulfillmentProviderLocationSchema>;
export type InsertFulfillmentNodeProviderBinding = z.infer<
  typeof insertFulfillmentNodeProviderBindingSchema
>;
export type InsertLocationPromisePolicyVersion = z.infer<
  typeof insertLocationPromisePolicyVersionSchema
>;
export type InsertTransformationModelVersion = z.infer<typeof insertTransformationModelVersionSchema>;
export type InsertTransformationModelReview = z.infer<typeof insertTransformationModelReviewSchema>;
export type InsertTransformationModelPath = z.infer<typeof insertTransformationModelPathSchema>;
export type InsertTransformationRecipeBinding = z.infer<
  typeof insertTransformationRecipeBindingSchema
>;
export type InsertTransformationRecipeComponentSnapshot = z.infer<
  typeof insertTransformationRecipeComponentSnapshotSchema
>;
export type InsertPromiseSafetyPolicyVersion = z.infer<typeof insertPromiseSafetyPolicyVersionSchema>;
export type InsertDemandEvidenceSnapshot = z.infer<typeof insertDemandEvidenceSnapshotSchema>;
export type InsertPlannerShadowRun = z.infer<typeof insertPlannerShadowRunSchema>;
export type InsertPlannerShadowResult = z.infer<typeof insertPlannerShadowResultSchema>;
export type InsertPlannerClaimSimulationRun = z.infer<typeof insertPlannerClaimSimulationRunSchema>;
export type InsertInventoryAvailabilityActivationRun = z.infer<
  typeof insertInventoryAvailabilityActivationRunSchema
>;
export type InsertInventoryAvailabilityRuntimeAuthority = z.infer<
  typeof insertInventoryAvailabilityRuntimeAuthoritySchema
>;
export type InsertInventoryAvailabilityClaim = z.infer<typeof insertInventoryAvailabilityClaimSchema>;
export type InsertInventoryAvailabilityClaimLine = z.infer<
  typeof insertInventoryAvailabilityClaimLineSchema
>;
export type InsertInventoryAvailabilityClaimOperation = z.infer<
  typeof insertInventoryAvailabilityClaimOperationSchema
>;
export type InsertInventoryAvailabilityClaimOperationInput = z.infer<
  typeof insertInventoryAvailabilityClaimOperationInputSchema
>;
export type InsertInventoryAvailabilityClaimResource = z.infer<
  typeof insertInventoryAvailabilityClaimResourceSchema
>;
export type InsertInventoryAvailabilityClaimLotAllocation = z.infer<
  typeof insertInventoryAvailabilityClaimLotAllocationSchema
>;
export type InsertInventoryAvailabilityClaimCommand = z.infer<
  typeof insertInventoryAvailabilityClaimCommandSchema
>;
export type InsertInventoryAvailabilityClaimEvent = z.infer<
  typeof insertInventoryAvailabilityClaimEventSchema
>;
export type InsertInventoryAvailabilityActivationCommand = z.infer<
  typeof insertInventoryAvailabilityActivationCommandSchema
>;
export type InsertInventoryAvailabilityActivationFreeze = z.infer<
  typeof insertInventoryAvailabilityActivationFreezeSchema
>;
export type InsertInventoryAvailabilityActivationProductEvidence = z.infer<
  typeof insertInventoryAvailabilityActivationProductEvidenceSchema
>;
export type InsertInventoryPublicationTarget = z.infer<typeof insertInventoryPublicationTargetSchema>;
export type InsertChannelExposurePolicyVersion = z.infer<
  typeof insertChannelExposurePolicyVersionSchema
>;
export type InsertPublicationSourceBindingVersion = z.infer<
  typeof insertPublicationSourceBindingVersionSchema
>;
export type InsertPublicationSourceBindingMember = z.infer<
  typeof insertPublicationSourceBindingMemberSchema
>;
export type InsertPublicationVariantMappingVersion = z.infer<
  typeof insertPublicationVariantMappingVersionSchema
>;
export type InsertInventoryPublicationOutboxEntry = z.infer<
  typeof insertInventoryPublicationOutboxSchema
>;
export type InsertInventoryPublicationAttempt = z.infer<typeof insertInventoryPublicationAttemptSchema>;
export type InsertInventoryPublicationReadbackRun = z.infer<
  typeof insertInventoryPublicationReadbackRunSchema
>;
export type InsertInventoryPublicationReadbackRunItem = z.infer<
  typeof insertInventoryPublicationReadbackRunItemSchema
>;
export type InsertInventoryPublicationReadback = z.infer<typeof insertInventoryPublicationReadbackSchema>;
export type InsertInventoryAvailabilityActivationEvent = z.infer<
  typeof insertInventoryAvailabilityActivationEventSchema
>;
