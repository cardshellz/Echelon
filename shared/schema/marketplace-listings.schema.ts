import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

import { products, productVariants } from "./catalog.schema";
import { channels } from "./channels.schema";
import { dropshipStoreConnections } from "./dropship.schema";

export const marketplaceSchema = pgSchema("marketplace");

export const marketplaceListingOwnerKindEnum = ["channel", "dropship"] as const;
export type MarketplaceListingOwnerKind =
  (typeof marketplaceListingOwnerKindEnum)[number];

export const marketplaceListingPublicationStatusEnum = [
  "planned",
  "staged",
  "active",
  "superseded",
  "withdrawn",
  "failed",
] as const;
export type MarketplaceListingPublicationStatus =
  (typeof marketplaceListingPublicationStatusEnum)[number];

export const marketplaceListingMemberDispositionEnum = [
  "included",
  "excluded",
] as const;
export type MarketplaceListingMemberDisposition =
  (typeof marketplaceListingMemberDispositionEnum)[number];

export const marketplaceListingReplacementStatusEnum = [
  "planned",
  "running",
  "compensating",
  "completed",
  "failed",
  "manual_recovery_required",
  "cancelled",
] as const;
export type MarketplaceListingReplacementStatus =
  (typeof marketplaceListingReplacementStatusEnum)[number];

export const marketplaceListingReplacementPhaseEnum = [
  "preflight",
  "cutover",
  "publish",
  "verify",
  "switch_mapping",
  "compensate",
  "complete",
] as const;
export type MarketplaceListingReplacementPhase =
  (typeof marketplaceListingReplacementPhaseEnum)[number];

export const marketplaceListingReplacementStepStatusEnum = [
  "pending",
  "running",
  "succeeded",
  "failed",
] as const;
export type MarketplaceListingReplacementStepStatus =
  (typeof marketplaceListingReplacementStepStatusEnum)[number];

export const marketplaceListingReplacementStepPathEnum = [
  "forward",
  "compensation",
] as const;
export type MarketplaceListingReplacementStepPath =
  (typeof marketplaceListingReplacementStepPathEnum)[number];

export const marketplaceListingActorTypeEnum = [
  "user",
  "service",
  "system",
] as const;
export type MarketplaceListingActorType =
  (typeof marketplaceListingActorTypeEnum)[number];

export const marketplaceListingScopes = marketplaceSchema.table(
  "listing_scopes",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    ownerKind: varchar("owner_kind", { length: 20 }).notNull(),
    provider: varchar("provider", { length: 40 }).notNull(),
    marketplaceId: varchar("marketplace_id", { length: 100 }).notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    createdByType: varchar("created_by_type", { length: 20 }).notNull(),
    createdById: varchar("created_by_id", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("listing_scopes_id_product_uq").on(table.id, table.productId),
    index("listing_scopes_product_idx").on(table.productId, table.id),
    check(
      "listing_scopes_owner_kind_chk",
      sql`${table.ownerKind} IN ('channel', 'dropship')`,
    ),
    check(
      "listing_scopes_provider_chk",
      sql`${table.provider} = lower(btrim(${table.provider}))
      AND ${table.provider} ~ '^[a-z][a-z0-9_-]{0,39}$'`,
    ),
    check(
      "listing_scopes_marketplace_chk",
      sql`${table.marketplaceId} = btrim(${table.marketplaceId}) AND ${table.marketplaceId} <> ''`,
    ),
    check(
      "listing_scopes_actor_chk",
      sql`${table.createdByType} IN ('user', 'service', 'system')
      AND ${table.createdById} = btrim(${table.createdById})
      AND ${table.createdById} <> ''`,
    ),
    check(
      "listing_scopes_time_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const marketplaceChannelListingScopes = marketplaceSchema.table(
  "channel_listing_scopes",
  {
    scopeId: bigint("scope_id", { mode: "number" }).primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "restrict" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    marketplaceId: varchar("marketplace_id", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scopeId, table.productId],
      foreignColumns: [
        marketplaceListingScopes.id,
        marketplaceListingScopes.productId,
      ],
      name: "channel_listing_scopes_scope_product_fk",
    }).onDelete("restrict"),
    unique("channel_listing_scopes_owner_uq").on(
      table.channelId,
      table.productId,
      table.marketplaceId,
    ),
    check(
      "channel_listing_scopes_marketplace_chk",
      sql`${table.marketplaceId} = btrim(${table.marketplaceId}) AND ${table.marketplaceId} <> ''`,
    ),
  ],
);

export const marketplaceDropshipListingScopes = marketplaceSchema.table(
  "dropship_listing_scopes",
  {
    scopeId: bigint("scope_id", { mode: "number" }).primaryKey(),
    storeConnectionId: integer("store_connection_id")
      .notNull()
      .references(() => dropshipStoreConnections.id, { onDelete: "restrict" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    marketplaceId: varchar("marketplace_id", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scopeId, table.productId],
      foreignColumns: [
        marketplaceListingScopes.id,
        marketplaceListingScopes.productId,
      ],
      name: "dropship_listing_scopes_scope_product_fk",
    }).onDelete("restrict"),
    unique("dropship_listing_scopes_owner_uq").on(
      table.storeConnectionId,
      table.productId,
      table.marketplaceId,
    ),
    check(
      "dropship_listing_scopes_marketplace_chk",
      sql`${table.marketplaceId} = btrim(${table.marketplaceId}) AND ${table.marketplaceId} <> ''`,
    ),
  ],
);

export const marketplaceListingPublications = marketplaceSchema.table(
  "listing_publications",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    scopeId: bigint("scope_id", { mode: "number" }).notNull(),
    productId: integer("product_id").notNull(),
    generation: integer("generation").notNull(),
    supersedesPublicationId: bigint("supersedes_publication_id", {
      mode: "number",
    }),
    status: varchar("status", { length: 30 }).notNull(),
    desiredStateHash: varchar("desired_state_hash", { length: 64 }).notNull(),
    providerPublicationKey: varchar("provider_publication_key", {
      length: 255,
    }),
    externalListingId: varchar("external_listing_id", { length: 255 }),
    externalUrl: text("external_url"),
    metadata: jsonb("metadata").notNull().default({}),
    createdByType: varchar("created_by_type", { length: 20 }).notNull(),
    createdById: varchar("created_by_id", { length: 255 }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.scopeId, table.productId],
      foreignColumns: [
        marketplaceListingScopes.id,
        marketplaceListingScopes.productId,
      ],
      name: "listing_publications_scope_product_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.supersedesPublicationId, table.scopeId],
      foreignColumns: [table.id, table.scopeId],
      name: "listing_publications_supersedes_scope_fk",
    }).onDelete("restrict"),
    unique("listing_publications_id_scope_uq").on(table.id, table.scopeId),
    unique("listing_publications_id_scope_product_uq").on(
      table.id,
      table.scopeId,
      table.productId,
    ),
    unique("listing_publications_scope_generation_uq").on(
      table.scopeId,
      table.generation,
    ),
    uniqueIndex("listing_publications_active_scope_uidx")
      .on(table.scopeId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("listing_publications_external_listing_uidx")
      .on(table.scopeId, table.externalListingId)
      .where(sql`${table.externalListingId} IS NOT NULL`),
    uniqueIndex("listing_publications_provider_key_uidx")
      .on(table.scopeId, table.providerPublicationKey)
      .where(sql`${table.providerPublicationKey} IS NOT NULL`),
    index("listing_publications_scope_history_idx").on(
      table.scopeId,
      table.generation,
    ),
    check("listing_publications_generation_chk", sql`${table.generation} > 0`),
    check(
      "listing_publications_status_chk",
      sql`${table.status} IN ('planned','staged','active','superseded','withdrawn','failed')`,
    ),
    check(
      "listing_publications_hash_chk",
      sql`${table.desiredStateHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "listing_publications_external_identity_chk",
      sql`(${table.providerPublicationKey} IS NULL OR (
          ${table.providerPublicationKey} = btrim(${table.providerPublicationKey})
          AND ${table.providerPublicationKey} <> ''
        )) AND (${table.externalListingId} IS NULL OR (
          ${table.externalListingId} = btrim(${table.externalListingId})
          AND ${table.externalListingId} <> ''
        ))
        AND (${table.externalUrl} IS NULL OR ${table.externalListingId} IS NOT NULL)
        AND (${table.publishedAt} IS NULL OR ${table.externalListingId} IS NOT NULL)`,
    ),
    check(
      "listing_publications_metadata_chk",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    check(
      "listing_publications_actor_chk",
      sql`${table.createdByType} IN ('user', 'service', 'system')
        AND ${table.createdById} = btrim(${table.createdById})
        AND ${table.createdById} <> ''`,
    ),
    check(
      "listing_publications_time_chk",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.publishedAt} IS NULL OR ${table.publishedAt} >= ${table.createdAt})
        AND (${table.verifiedAt} IS NULL OR (
          ${table.publishedAt} IS NOT NULL AND ${table.verifiedAt} >= ${table.publishedAt}
        ))
        AND (${table.retiredAt} IS NULL OR (
          ${table.verifiedAt} IS NOT NULL AND ${table.retiredAt} >= ${table.verifiedAt}
        ))`,
    ),
    check(
      "listing_publications_lifecycle_chk",
      sql`(
          ${table.status} = 'planned'
          AND ${table.providerPublicationKey} IS NULL
          AND ${table.externalListingId} IS NULL
          AND ${table.externalUrl} IS NULL
          AND ${table.publishedAt} IS NULL
          AND ${table.verifiedAt} IS NULL
          AND ${table.retiredAt} IS NULL
        ) OR (
          ${table.status} = 'staged'
          AND ${table.verifiedAt} IS NULL
          AND ${table.retiredAt} IS NULL
        ) OR (
          ${table.status} = 'failed'
          AND ${table.verifiedAt} IS NULL
          AND ${table.retiredAt} IS NULL
        ) OR (
          ${table.status} = 'active'
          AND ${table.externalListingId} IS NOT NULL
          AND ${table.publishedAt} IS NOT NULL
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.retiredAt} IS NULL
        ) OR (
          ${table.status} IN ('superseded','withdrawn')
          AND ${table.externalListingId} IS NOT NULL
          AND ${table.publishedAt} IS NOT NULL
          AND ${table.verifiedAt} IS NOT NULL
          AND ${table.retiredAt} IS NOT NULL
        )`,
    ),
  ],
);

export const marketplaceListingPublicationMembers = marketplaceSchema.table(
  "listing_publication_members",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    publicationId: bigint("publication_id", { mode: "number" }).notNull(),
    scopeId: bigint("scope_id", { mode: "number" }).notNull(),
    productId: integer("product_id").notNull(),
    productVariantId: integer("product_variant_id").notNull(),
    skuSnapshot: varchar("sku_snapshot", { length: 100 }).notNull(),
    disposition: varchar("disposition", { length: 20 }).notNull(),
    reasonCode: varchar("reason_code", { length: 100 }),
    externalVariantId: varchar("external_variant_id", { length: 255 }),
    externalOfferId: varchar("external_offer_id", { length: 255 }),
    externalInventoryItemId: varchar("external_inventory_item_id", {
      length: 255,
    }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.publicationId, table.scopeId, table.productId],
      foreignColumns: [
        marketplaceListingPublications.id,
        marketplaceListingPublications.scopeId,
        marketplaceListingPublications.productId,
      ],
      name: "listing_publication_members_publication_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.productVariantId, table.productId],
      foreignColumns: [productVariants.id, productVariants.productId],
      name: "listing_publication_members_variant_product_fk",
    }).onDelete("restrict"),
    unique("listing_publication_members_publication_variant_uq").on(
      table.publicationId,
      table.productVariantId,
    ),
    unique("listing_publication_members_publication_sku_uq").on(
      table.publicationId,
      table.skuSnapshot,
    ),
    index("listing_publication_members_variant_history_idx").on(
      table.productVariantId,
      table.publicationId,
    ),
    check(
      "listing_publication_members_sku_chk",
      sql`${table.skuSnapshot} = btrim(${table.skuSnapshot}) AND ${table.skuSnapshot} <> ''`,
    ),
    check(
      "listing_publication_members_disposition_chk",
      sql`${table.disposition} IN ('included','excluded')`,
    ),
    check(
      "listing_publication_members_reason_chk",
      sql`(
          ${table.disposition} = 'included' AND ${table.reasonCode} IS NULL
        ) OR (
          ${table.disposition} = 'excluded'
          AND ${table.reasonCode} IS NOT NULL
          AND ${table.reasonCode} = btrim(${table.reasonCode})
          AND ${table.reasonCode} <> ''
        )`,
    ),
    check(
      "listing_publication_members_external_identity_chk",
      sql`(${table.externalVariantId} IS NULL OR (
          ${table.externalVariantId} = btrim(${table.externalVariantId})
          AND ${table.externalVariantId} <> ''
        )) AND (${table.externalOfferId} IS NULL OR (
          ${table.externalOfferId} = btrim(${table.externalOfferId})
          AND ${table.externalOfferId} <> ''
        )) AND (${table.externalInventoryItemId} IS NULL OR (
          ${table.externalInventoryItemId} = btrim(${table.externalInventoryItemId})
          AND ${table.externalInventoryItemId} <> ''
        ))`,
    ),
    check(
      "listing_publication_members_metadata_chk",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    check(
      "listing_publication_members_time_chk",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const marketplaceListingReplacementOperations = marketplaceSchema.table(
  "listing_replacement_operations",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    scopeId: bigint("scope_id", { mode: "number" }).notNull(),
    sourcePublicationId: bigint("source_publication_id", {
      mode: "number",
    }).notNull(),
    targetPublicationId: bigint("target_publication_id", {
      mode: "number",
    }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    desiredStateHash: varchar("desired_state_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 40 }).notNull().default("planned"),
    currentPhase: varchar("current_phase", { length: 30 })
      .notNull()
      .default("preflight"),
    stateVersion: integer("state_version").notNull().default(1),
    attemptCount: integer("attempt_count").notNull().default(0),
    attemptLimit: integer("attempt_limit").notNull().default(5),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    requestedByType: varchar("requested_by_type", { length: 20 }).notNull(),
    requestedById: varchar("requested_by_id", { length: 255 }).notNull(),
    correlationId: varchar("correlation_id", { length: 100 }),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 2000 }),
    recoveryContext: jsonb("recovery_context"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.sourcePublicationId, table.scopeId],
      foreignColumns: [
        marketplaceListingPublications.id,
        marketplaceListingPublications.scopeId,
      ],
      name: "listing_replacement_operations_source_scope_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.targetPublicationId, table.scopeId],
      foreignColumns: [
        marketplaceListingPublications.id,
        marketplaceListingPublications.scopeId,
      ],
      name: "listing_replacement_operations_target_scope_fk",
    }).onDelete("restrict"),
    unique("listing_replacement_operations_scope_idem_uq").on(
      table.scopeId,
      table.idempotencyKey,
    ),
    unique("listing_replacement_operations_target_uq").on(
      table.targetPublicationId,
    ),
    uniqueIndex("listing_replacement_operations_active_scope_uidx")
      .on(table.scopeId)
      .where(
        sql`${table.status} IN ('planned','running','compensating','manual_recovery_required')`,
      ),
    index("listing_replacement_operations_lease_idx")
      .on(table.leaseExpiresAt, table.id)
      .where(sql`${table.status} IN ('running','compensating')`),
    index("listing_replacement_operations_history_idx").on(
      table.scopeId,
      table.createdAt,
      table.id,
    ),
    check(
      "listing_replacement_operations_publication_chk",
      sql`${table.sourcePublicationId} <> ${table.targetPublicationId}`,
    ),
    check(
      "listing_replacement_operations_idempotency_chk",
      sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND ${table.idempotencyKey} <> ''`,
    ),
    check(
      "listing_replacement_operations_hash_chk",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'
        AND ${table.desiredStateHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "listing_replacement_operations_status_chk",
      sql`${table.status} IN (
        'planned','running','compensating','completed','failed',
        'manual_recovery_required','cancelled'
      )`,
    ),
    check(
      "listing_replacement_operations_phase_chk",
      sql`${table.currentPhase} IN (
        'preflight','cutover','publish','verify','switch_mapping','compensate','complete'
      )`,
    ),
    check(
      "listing_replacement_operations_attempt_chk",
      sql`${table.attemptCount} >= 0
        AND ${table.attemptLimit} BETWEEN 1 AND 100
        AND ${table.attemptCount} <= ${table.attemptLimit}
        AND ${table.stateVersion} > 0`,
    ),
    check(
      "listing_replacement_operations_actor_chk",
      sql`${table.requestedByType} IN ('user','service','system')
        AND ${table.requestedById} = btrim(${table.requestedById})
        AND ${table.requestedById} <> ''`,
    ),
    check(
      "listing_replacement_operations_error_chk",
      sql`(${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL)
        OR (
          ${table.errorCode} IS NOT NULL
          AND btrim(${table.errorCode}) <> ''
          AND ${table.errorMessage} IS NOT NULL
          AND btrim(${table.errorMessage}) <> ''
        )`,
    ),
    check(
      "listing_replacement_operations_recovery_context_chk",
      sql`${table.recoveryContext} IS NULL OR jsonb_typeof(${table.recoveryContext}) = 'object'`,
    ),
    check(
      "listing_replacement_operations_time_chk",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})
        AND (${table.completedAt} IS NULL OR (
          ${table.completedAt} >= ${table.createdAt}
          AND (${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})
        ))
        AND (${table.leaseExpiresAt} IS NULL OR ${table.leaseExpiresAt} > ${table.updatedAt})`,
    ),
    check(
      "listing_replacement_operations_lifecycle_chk",
      sql`(
          ${table.status} = 'planned'
          AND ${table.currentPhase} = 'preflight'
          AND ${table.attemptCount} = 0
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
          AND ${table.startedAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'running'
          AND ${table.currentPhase} IN (
            'preflight','cutover','publish','verify','switch_mapping'
          )
          AND ${table.attemptCount} > 0
          AND ${table.leaseToken} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'compensating'
          AND ${table.currentPhase} = 'compensate'
          AND ${table.attemptCount} > 0
          AND ${table.leaseToken} IS NOT NULL
          AND ${table.leaseExpiresAt} IS NOT NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'completed'
          AND ${table.currentPhase} = 'complete'
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'failed'
          AND ${table.currentPhase} IN ('preflight','compensate')
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NOT NULL
        ) OR (
          ${table.status} = 'manual_recovery_required'
          AND ${table.currentPhase} <> 'complete'
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NOT NULL
        ) OR (
          ${table.status} = 'cancelled'
          AND ${table.currentPhase} = 'preflight'
          AND ${table.leaseToken} IS NULL
          AND ${table.leaseExpiresAt} IS NULL
          AND ${table.startedAt} IS NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NULL
        )`,
    ),
  ],
);

export const marketplaceListingReplacementSteps = marketplaceSchema.table(
  "listing_replacement_steps",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    operationId: bigint("operation_id", { mode: "number" })
      .notNull()
      .references(() => marketplaceListingReplacementOperations.id, {
        onDelete: "restrict",
      }),
    sequence: integer("sequence").notNull(),
    stepKey: varchar("step_key", { length: 100 }).notNull(),
    phase: varchar("phase", { length: 30 }).notNull(),
    executionPath: varchar("execution_path", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    stateVersion: integer("state_version").notNull().default(1),
    attemptCount: integer("attempt_count").notNull().default(0),
    attemptLimit: integer("attempt_limit").notNull().default(5),
    requestPayload: jsonb("request_payload").notNull().default({}),
    resultEvidence: jsonb("result_evidence"),
    errorCode: varchar("error_code", { length: 100 }),
    errorMessage: varchar("error_message", { length: 2000 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    unique("listing_replacement_steps_id_operation_phase_uq").on(
      table.id,
      table.operationId,
      table.phase,
    ),
    unique("listing_replacement_steps_operation_sequence_uq").on(
      table.operationId,
      table.executionPath,
      table.sequence,
    ),
    unique("listing_replacement_steps_operation_key_uq").on(
      table.operationId,
      table.stepKey,
    ),
    unique("listing_replacement_steps_operation_idem_uq").on(
      table.operationId,
      table.idempotencyKey,
    ),
    uniqueIndex("listing_replacement_steps_running_operation_uidx")
      .on(table.operationId)
      .where(sql`${table.status} = 'running'`),
    check("listing_replacement_steps_sequence_chk", sql`${table.sequence} > 0`),
    check(
      "listing_replacement_steps_key_chk",
      sql`${table.stepKey} = btrim(${table.stepKey})
        AND ${table.stepKey} ~ '^[a-z][a-z0-9_.:-]{0,99}$'`,
    ),
    check(
      "listing_replacement_steps_phase_chk",
      sql`${table.phase} IN (
        'preflight','cutover','publish','verify','switch_mapping','compensate'
      )`,
    ),
    check(
      "listing_replacement_steps_execution_path_chk",
      sql`${table.executionPath} IN ('forward','compensation')`,
    ),
    check(
      "listing_replacement_steps_path_phase_chk",
      sql`(${table.executionPath} = 'forward' AND ${table.phase} IN (
          'preflight','cutover','publish','verify','switch_mapping'
        )) OR (${table.executionPath} = 'compensation' AND ${table.phase} = 'compensate')`,
    ),
    check(
      "listing_replacement_steps_status_chk",
      sql`${table.status} IN ('pending','running','succeeded','failed')`,
    ),
    check(
      "listing_replacement_steps_idempotency_chk",
      sql`${table.idempotencyKey} = btrim(${table.idempotencyKey})
        AND ${table.idempotencyKey} <> ''
        AND ${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "listing_replacement_steps_attempt_chk",
      sql`${table.stateVersion} > 0
        AND ${table.attemptCount} >= 0
        AND ${table.attemptLimit} BETWEEN 1 AND 100
        AND ${table.attemptCount} <= ${table.attemptLimit}`,
    ),
    check(
      "listing_replacement_steps_payload_chk",
      sql`jsonb_typeof(${table.requestPayload}) = 'object'
        AND (${table.resultEvidence} IS NULL OR jsonb_typeof(${table.resultEvidence}) = 'object')`,
    ),
    check(
      "listing_replacement_steps_error_chk",
      sql`(${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL)
        OR (
          ${table.errorCode} IS NOT NULL
          AND btrim(${table.errorCode}) <> ''
          AND ${table.errorMessage} IS NOT NULL
          AND btrim(${table.errorMessage}) <> ''
        )`,
    ),
    check(
      "listing_replacement_steps_time_chk",
      sql`${table.updatedAt} >= ${table.createdAt}
        AND (${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})
        AND (${table.completedAt} IS NULL OR (
          ${table.completedAt} >= ${table.createdAt}
          AND (${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})
        ))`,
    ),
    check(
      "listing_replacement_steps_lifecycle_chk",
      sql`(
          ${table.status} = 'pending'
          AND ${table.attemptCount} = 0
          AND ${table.startedAt} IS NULL
          AND ${table.completedAt} IS NULL
          AND ${table.resultEvidence} IS NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'running'
          AND ${table.attemptCount} > 0
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NULL
          AND ${table.resultEvidence} IS NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'succeeded'
          AND ${table.attemptCount} > 0
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.resultEvidence} IS NOT NULL
          AND ${table.errorCode} IS NULL
        ) OR (
          ${table.status} = 'failed'
          AND ${table.attemptCount} > 0
          AND ${table.startedAt} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL
          AND ${table.errorCode} IS NOT NULL
        )`,
    ),
  ],
);

export const marketplaceListingReplacementEvents = marketplaceSchema.table(
  "listing_replacement_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    operationId: bigint("operation_id", { mode: "number" })
      .notNull()
      .references(() => marketplaceListingReplacementOperations.id, {
        onDelete: "restrict",
      }),
    sequence: integer("sequence").notNull(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    phase: varchar("phase", { length: 30 }).notNull(),
    stepId: bigint("step_id", { mode: "number" }),
    actorType: varchar("actor_type", { length: 20 }).notNull(),
    actorId: varchar("actor_id", { length: 255 }).notNull(),
    fromStatus: varchar("from_status", { length: 40 }),
    toStatus: varchar("to_status", { length: 40 }).notNull(),
    attempt: integer("attempt").notNull().default(0),
    subjectStateVersion: integer("subject_state_version").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.stepId, table.operationId, table.phase],
      foreignColumns: [
        marketplaceListingReplacementSteps.id,
        marketplaceListingReplacementSteps.operationId,
        marketplaceListingReplacementSteps.phase,
      ],
      name: "listing_replacement_events_step_operation_phase_fk",
    }).onDelete("restrict"),
    unique("listing_replacement_events_operation_sequence_uq").on(
      table.operationId,
      table.sequence,
    ),
    uniqueIndex("listing_replacement_events_operation_version_uidx")
      .on(table.operationId, table.subjectStateVersion)
      .where(sql`${table.stepId} IS NULL`),
    uniqueIndex("listing_replacement_events_step_version_uidx")
      .on(table.operationId, table.stepId, table.subjectStateVersion)
      .where(sql`${table.stepId} IS NOT NULL`),
    index("listing_replacement_events_operation_time_idx").on(
      table.operationId,
      table.createdAt,
      table.id,
    ),
    check(
      "listing_replacement_events_sequence_chk",
      sql`${table.sequence} > 0`,
    ),
    check(
      "listing_replacement_events_type_chk",
      sql`${table.eventType} = btrim(${table.eventType})
        AND ${table.eventType} ~ '^[a-z][a-z0-9_.:-]{0,99}$'`,
    ),
    check(
      "listing_replacement_events_phase_chk",
      sql`${table.phase} IN (
        'preflight','cutover','publish','verify','switch_mapping','compensate','complete'
      )`,
    ),
    check(
      "listing_replacement_events_actor_chk",
      sql`${table.actorType} IN ('user','service','system')
        AND ${table.actorId} = btrim(${table.actorId})
        AND ${table.actorId} <> ''`,
    ),
    check(
      "listing_replacement_events_status_chk",
      sql`(
          ${table.stepId} IS NULL
          AND (${table.fromStatus} IS NULL OR ${table.fromStatus} IN (
            'planned','running','compensating','completed','failed',
            'manual_recovery_required','cancelled'
          ))
          AND ${table.toStatus} IN (
            'planned','running','compensating','completed','failed',
            'manual_recovery_required','cancelled'
          )
        ) OR (
          ${table.stepId} IS NOT NULL
          AND (${table.fromStatus} IS NULL OR ${table.fromStatus} IN (
            'pending','running','succeeded','failed'
          ))
          AND ${table.toStatus} IN (
            'pending','running','succeeded','failed'
          )
        )`,
    ),
    check(
      "listing_replacement_events_attempt_chk",
      sql`${table.attempt} >= 0 AND ${table.subjectStateVersion} > 0`,
    ),
    check(
      "listing_replacement_events_evidence_chk",
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
  ],
);

const generatedColumns = {
  id: true,
  createdAt: true,
  updatedAt: true,
} as const;

const createdAtColumn = { createdAt: true } as const;
const eventGeneratedColumns = { id: true, createdAt: true } as const;

export const insertMarketplaceListingScopeSchema = createInsertSchema(
  marketplaceListingScopes,
).omit(generatedColumns);
export const insertMarketplaceChannelListingScopeSchema = createInsertSchema(
  marketplaceChannelListingScopes,
).omit(createdAtColumn);
export const insertMarketplaceDropshipListingScopeSchema = createInsertSchema(
  marketplaceDropshipListingScopes,
).omit(createdAtColumn);
export const insertMarketplaceListingPublicationSchema = createInsertSchema(
  marketplaceListingPublications,
).omit(generatedColumns);
export const insertMarketplaceListingPublicationMemberSchema =
  createInsertSchema(marketplaceListingPublicationMembers).omit(
    generatedColumns,
  );
export const insertMarketplaceListingReplacementOperationSchema =
  createInsertSchema(marketplaceListingReplacementOperations).omit(
    generatedColumns,
  );
export const insertMarketplaceListingReplacementStepSchema = createInsertSchema(
  marketplaceListingReplacementSteps,
).omit(generatedColumns);
export const insertMarketplaceListingReplacementEventSchema =
  createInsertSchema(marketplaceListingReplacementEvents).omit(
    eventGeneratedColumns,
  );

export type MarketplaceListingScope =
  typeof marketplaceListingScopes.$inferSelect;
export type MarketplaceChannelListingScope =
  typeof marketplaceChannelListingScopes.$inferSelect;
export type MarketplaceDropshipListingScope =
  typeof marketplaceDropshipListingScopes.$inferSelect;
export type MarketplaceListingPublication =
  typeof marketplaceListingPublications.$inferSelect;
export type MarketplaceListingPublicationMember =
  typeof marketplaceListingPublicationMembers.$inferSelect;
export type MarketplaceListingReplacementOperation =
  typeof marketplaceListingReplacementOperations.$inferSelect;
export type MarketplaceListingReplacementStep =
  typeof marketplaceListingReplacementSteps.$inferSelect;
export type MarketplaceListingReplacementEvent =
  typeof marketplaceListingReplacementEvents.$inferSelect;

export type NewMarketplaceListingScope =
  typeof marketplaceListingScopes.$inferInsert;
export type NewMarketplaceChannelListingScope =
  typeof marketplaceChannelListingScopes.$inferInsert;
export type NewMarketplaceDropshipListingScope =
  typeof marketplaceDropshipListingScopes.$inferInsert;
export type NewMarketplaceListingPublication =
  typeof marketplaceListingPublications.$inferInsert;
export type NewMarketplaceListingPublicationMember =
  typeof marketplaceListingPublicationMembers.$inferInsert;
export type NewMarketplaceListingReplacementOperation =
  typeof marketplaceListingReplacementOperations.$inferInsert;
export type NewMarketplaceListingReplacementStep =
  typeof marketplaceListingReplacementSteps.$inferInsert;
export type NewMarketplaceListingReplacementEvent =
  typeof marketplaceListingReplacementEvents.$inferInsert;
