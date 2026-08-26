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
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

import { products, productVariants } from "./catalog.schema";
import { buildRecipes } from "./inventory.schema";
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
    createdBy: varchar("created_by", { length: 100 }).notNull(),
    sealedBy: varchar("sealed_by", { length: 100 }),
    sealedAt: timestamp("sealed_at", { withTimezone: true }),
    retiredBy: varchar("retired_by", { length: 100 }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
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
      sql`${table.lifecycleStatus} IN ('draft', 'sealed', 'retired')`,
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
    predecessorValid: check(
      "transformation_model_versions_predecessor_chk",
      sql`(${table.version} = 1 AND ${table.supersedesModelId} IS NULL)
        OR (${table.version} > 1 AND ${table.supersedesModelId} IS NOT NULL)`,
    ),
    lifecycleValid: check(
      "transformation_model_versions_lifecycle_chk",
      sql`(${table.lifecycleStatus} = 'draft'
          AND ${table.sealedBy} IS NULL AND ${table.sealedAt} IS NULL
          AND ${table.retiredBy} IS NULL AND ${table.retiredAt} IS NULL)
        OR (${table.lifecycleStatus} = 'sealed'
          AND ${table.validationState} = 'valid'
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
      sql`${table.irreversibleConsumptionUnits} >= 0 AND ${table.observedDays} > 0
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

export type FulfillmentNode = typeof fulfillmentNodes.$inferSelect;
export type FulfillmentProviderAccount = typeof fulfillmentProviderAccounts.$inferSelect;
export type FulfillmentProviderLocation = typeof fulfillmentProviderLocations.$inferSelect;
export type FulfillmentNodeProviderBinding = typeof fulfillmentNodeProviderBindings.$inferSelect;
export type LocationPromisePolicyVersion = typeof locationPromisePolicyVersions.$inferSelect;
export type TransformationModelVersion = typeof transformationModelVersions.$inferSelect;
export type TransformationModelPath = typeof transformationModelPaths.$inferSelect;
export type TransformationRecipeBinding = typeof transformationRecipeBindings.$inferSelect;
export type TransformationRecipeComponentSnapshot =
  typeof transformationRecipeComponentSnapshots.$inferSelect;
export type PromiseSafetyPolicyVersion = typeof promiseSafetyPolicyVersions.$inferSelect;
export type DemandEvidenceSnapshot = typeof demandEvidenceSnapshots.$inferSelect;

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
export type InsertTransformationModelPath = z.infer<typeof insertTransformationModelPathSchema>;
export type InsertTransformationRecipeBinding = z.infer<
  typeof insertTransformationRecipeBindingSchema
>;
export type InsertTransformationRecipeComponentSnapshot = z.infer<
  typeof insertTransformationRecipeComponentSnapshotSchema
>;
export type InsertPromiseSafetyPolicyVersion = z.infer<typeof insertPromiseSafetyPolicyVersionSchema>;
export type InsertDemandEvidenceSnapshot = z.infer<typeof insertDemandEvidenceSnapshotSchema>;
