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
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { productVariants } from "./catalog.schema";
import { channels } from "./channels.schema";
import { shipmentRequests } from "./fulfillment.schema";
import { orders } from "./orders.schema";
import { warehouses } from "./warehouse.schema";
import type {
  ShippingChannelEligibilityMode,
  ShippingChannelPolicyPurpose,
  ShippingChannelPolicyStatus,
  ShippingChannelRouteMode,
  ShippingDestinationScopeStatus,
} from "../types/shipping-channel-routing";
import type { ShippingFulfillmentMethodCapabilities } from "../types/shipping-fulfillment-routing";

// First-party shipping engine (quote plane). Design: docs/SHIPPING-ENGINE-DESIGN.md.
// The fulfillment plane (wms.fulfillment_plans → shipment_requests → physical_shipments)
// lives in fulfillment.schema.ts; pack plans here attach to shipment_requests rather
// than duplicating that chain. Channel pricing converges here through independently
// assigned rate books; channel billing policy remains outside.

export const shippingSchema = pgSchema("shipping");

export const SHIPPING_DEFAULT_FILL_FACTOR_BPS = 8500;

export const SHIPPING_BOX_KINDS = ["box", "mailer", "envelope"] as const;
export type ShippingBoxKind = (typeof SHIPPING_BOX_KINDS)[number];

export const SHIPPING_SERVICE_LEVEL_CODES = [
  "standard",
  "expedited",
  "express",
  "pallet_freight",
] as const;
export type ShippingServiceLevelCode = (typeof SHIPPING_SERVICE_LEVEL_CODES)[number];

export const SHIPPING_RATE_COVERAGE_AVAILABILITIES = [
  "offered",
  "not_offered",
] as const;
export type ShippingRateCoverageAvailability =
  (typeof SHIPPING_RATE_COVERAGE_AVAILABILITIES)[number];

export const SHIPPING_CARTON_ORIENTATIONS = [
  "LWH",
  "WLH",
  "WHL",
  "HWL",
  "HLW",
  "LHW",
] as const;
export type ShippingCartonOrientation = (typeof SHIPPING_CARTON_ORIENTATIONS)[number];

export interface ShippingCartonPlacement {
  productVariantId: number;
  sku: string | null;
  unitSequence: number;
  orientation: ShippingCartonOrientation;
  xMm: number;
  yMm: number;
  zMm: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

// ---------------------------------------------------------------------------
// Box suite
// ---------------------------------------------------------------------------

export const shippingBoxCatalog = shippingSchema.table("box_catalog", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 80 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull().default("box"),
  // Inner (usable) dimensions — cartonization fits against these, not outer dims.
  lengthMm: integer("length_mm").notNull(),
  widthMm: integer("width_mm").notNull(),
  heightMm: integer("height_mm").notNull(),
  tareWeightGrams: integer("tare_weight_grams").notNull().default(0),
  maxWeightGrams: integer("max_weight_grams"),
  costCents: integer("cost_cents").notNull().default(0),
  // Usable share of inner volume; cartonization treats the box as full at this
  // fraction so real-world padding/imperfect stacking never overstuffs.
  fillFactorBps: integer("fill_factor_bps").notNull().default(SHIPPING_DEFAULT_FILL_FACTOR_BPS),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_box_code_idx").on(table.code),
  check("shipping_box_kind_chk", sql`${table.kind} IN ('box', 'mailer', 'envelope')`),
  check("shipping_box_dims_chk", sql`${table.lengthMm} > 0 AND ${table.widthMm} > 0 AND ${table.heightMm} > 0 AND ${table.tareWeightGrams} >= 0`),
  check("shipping_box_cost_chk", sql`${table.costCents} >= 0`),
  check("shipping_box_fill_chk", sql`${table.fillFactorBps} > 0 AND ${table.fillFactorBps} <= 10000`),
]);

export const shippingBoxWarehouseStock = shippingSchema.table("box_warehouse_stock", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  boxId: integer("box_id").notNull().references(() => shippingBoxCatalog.id, { onDelete: "cascade" }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "cascade" }),
  isStocked: boolean("is_stocked").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_box_warehouse_idx").on(table.boxId, table.warehouseId),
]);

// ---------------------------------------------------------------------------
// Variant shipping attributes
// Physical dims/weight AND ships-in-own-container stay canonical on
// catalog.product_variants (consolidated in migration 185); this table holds
// packing BEHAVIOR only: rider/void co-mingling (see design doc).
// ---------------------------------------------------------------------------

export const shippingVariantAttrs = shippingSchema.table("variant_shipping_attrs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  // sioc_suggested marks system candidates (sealed case-level variants)
  // awaiting review; the confirmed SIOC flag lives on the variant.
  siocSuggested: boolean("sioc_suggested").notNull().default(false),
  // Rider: soft/thin item allowed to fill another parcel's void space.
  riderEligible: boolean("rider_eligible").notNull().default(false),
  // Void capacity this variant's parcel offers to riders (SIOC variants only in practice).
  riderVoidCm3: integer("rider_void_cm3"),
  riderVoidMaxWeightGrams: integer("rider_void_max_weight_grams"),
  riderVoidMaxItems: integer("rider_void_max_items"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_variant_attrs_variant_idx").on(table.productVariantId),
  check("shipping_variant_attrs_void_chk", sql`
    (${table.riderVoidCm3} IS NULL OR ${table.riderVoidCm3} > 0)
    AND (${table.riderVoidMaxWeightGrams} IS NULL OR ${table.riderVoidMaxWeightGrams} > 0)
    AND (${table.riderVoidMaxItems} IS NULL OR ${table.riderVoidMaxItems} > 0)
  `),
]);

// ---------------------------------------------------------------------------
// Zones and rate tables (lower-48 served from these; HI/AK/PR go live-rate
// with these rows as the timeout fallback — decided 2026-07-02)
// ---------------------------------------------------------------------------

export const shippingZoneSets = shippingSchema.table("zone_sets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 80 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_zone_set_code_idx").on(table.code),
  check("shipping_zone_set_status_chk", sql`${table.status} IN ('draft', 'active', 'retired')`),
]);

export const shippingRateBooks = shippingSchema.table("rate_books", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 80 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  zoneSetId: integer("zone_set_id").notNull().references(() => shippingZoneSets.id, { onDelete: "restrict" }),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_rate_book_code_idx").on(table.code),
  check("shipping_rate_book_status_chk", sql`${table.status} IN ('draft', 'active', 'retired')`),
]);

export const shippingRateBookAssignments = shippingSchema.table("rate_book_assignments", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateBookId: integer("rate_book_id").notNull().references(() => shippingRateBooks.id, { onDelete: "restrict" }),
  pricingChannel: varchar("pricing_channel", { length: 40 }).notNull(),
  ratePurpose: varchar("rate_purpose", { length: 60 }).notNull(),
  originWarehouseId: integer("origin_warehouse_id").references(() => warehouses.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_rate_book_assignment_global_idx")
    .on(table.pricingChannel, table.ratePurpose)
    .where(sql`${table.isActive} = true AND ${table.originWarehouseId} IS NULL`),
  uniqueIndex("shipping_rate_book_assignment_warehouse_idx")
    .on(table.pricingChannel, table.ratePurpose, table.originWarehouseId)
    .where(sql`${table.isActive} = true AND ${table.originWarehouseId} IS NOT NULL`),
]);

// ---------------------------------------------------------------------------
// Channel routing policy
//
// A versioned policy owns one complete channel + purpose decision set. Routes
// select the rate authority and destination eligibility authority; marketplace
// store connections remain adapter context and are deliberately not persisted
// here. No policy rows are seeded during the compatibility expansion phase.
// ---------------------------------------------------------------------------

export const shippingDestinationScopes = shippingSchema.table("destination_scopes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 100 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  status: varchar("status", { length: 20 })
    .$type<ShippingDestinationScopeStatus>()
    .notNull()
    .default("draft"),
  metadata: jsonb("metadata"),
  createdBy: varchar("created_by", { length: 200 }).notNull(),
  lockVersion: integer("lock_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_destination_scope_code_idx").on(table.code),
  check("shipping_destination_scope_status_chk", sql`
    ${table.status} IN ('draft', 'active', 'retired')
  `),
  check("shipping_destination_scope_code_chk", sql`
    ${table.code} = btrim(${table.code})
    AND ${table.code} ~ '^[a-z0-9][a-z0-9-]{0,99}$'
  `),
  check("shipping_destination_scope_actor_chk", sql`
    ${table.createdBy} = btrim(${table.createdBy}) AND ${table.createdBy} <> ''
  `),
  check("shipping_destination_scope_lock_version_chk", sql`${table.lockVersion} > 0`),
]);

export const shippingDestinationScopeMembers = shippingSchema.table("destination_scope_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  destinationScopeId: integer("destination_scope_id")
    .notNull()
    .references(() => shippingDestinationScopes.id, { onDelete: "cascade" }),
  destinationCountry: varchar("destination_country", { length: 2 }).notNull(),
  destinationRegion: varchar("destination_region", { length: 10 }),
  postalPrefix: varchar("postal_prefix", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_destination_scope_member_idx").on(
    table.destinationScopeId,
    table.destinationCountry,
    sql`COALESCE(${table.destinationRegion}, '')`,
    sql`COALESCE(${table.postalPrefix}, '')`,
  ),
  index("shipping_destination_scope_member_lookup_idx").on(
    table.destinationCountry,
    table.destinationRegion,
    table.postalPrefix,
    table.destinationScopeId,
  ),
  check("shipping_destination_scope_member_country_chk", sql`
    ${table.destinationCountry} ~ '^[A-Z]{2}$'
  `),
  check("shipping_destination_scope_member_region_chk", sql`
    ${table.destinationRegion} IS NULL
    OR ${table.destinationRegion} ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
  `),
  check("shipping_destination_scope_member_postal_chk", sql`
    ${table.postalPrefix} IS NULL
    OR (
      ${table.postalPrefix} = btrim(${table.postalPrefix})
      AND ${table.postalPrefix} ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
    )
  `),
]);

// ---------------------------------------------------------------------------
// Pricing-program destination groups
//
// A destination scope is reusable channel-routing input. A pricing-program
// group gives that geography stable identity inside one rate book. Rate-table
// revisions snapshot the group and its members below so later group edits
// cannot silently change an active price revision.
// ---------------------------------------------------------------------------

export const shippingRateBookDestinationGroups = shippingSchema.table(
  "rate_book_destination_groups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    rateBookId: integer("rate_book_id")
      .notNull()
      .references(() => shippingRateBooks.id, { onDelete: "cascade" }),
    sourceDestinationScopeId: integer("source_destination_scope_id")
      .references(() => shippingDestinationScopes.id, { onDelete: "restrict" }),
    sourceDestinationScopeLockVersion: integer("source_destination_scope_lock_version"),
    name: varchar("name", { length: 160 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    lockVersion: integer("lock_version").notNull().default(1),
    createdBy: varchar("created_by", { length: 200 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shipping_rate_book_destination_group_name_idx")
      .on(table.rateBookId, sql`lower(${table.name})`)
      .where(sql`${table.status} = 'active'`),
    index("shipping_rate_book_destination_group_book_idx")
      .on(table.rateBookId, table.status, table.sortOrder, table.id),
    uniqueIndex("shipping_rate_book_destination_group_scope_idx")
      .on(table.rateBookId, table.sourceDestinationScopeId)
      .where(sql`${table.status} = 'active' AND ${table.sourceDestinationScopeId} IS NOT NULL`),
    index("shipping_rate_book_destination_group_source_idx")
      .on(table.sourceDestinationScopeId, table.status),
    check("shipping_rate_book_destination_group_name_chk", sql`
      ${table.name} = btrim(${table.name}) AND ${table.name} <> ''
    `),
    check("shipping_rate_book_destination_group_status_chk", sql`
      ${table.status} IN ('active', 'retired')
    `),
    check("shipping_rate_book_destination_group_sort_chk", sql`${table.sortOrder} >= 0`),
    check("shipping_rate_book_destination_group_lock_chk", sql`${table.lockVersion} > 0`),
    check("shipping_rate_book_destination_group_source_version_chk", sql`
      (
        ${table.sourceDestinationScopeId} IS NULL
        AND ${table.sourceDestinationScopeLockVersion} IS NULL
      )
      OR (
        ${table.sourceDestinationScopeId} IS NOT NULL
        AND ${table.sourceDestinationScopeLockVersion} > 0
      )
    `),
    check("shipping_rate_book_destination_group_actor_chk", sql`
      ${table.createdBy} = btrim(${table.createdBy}) AND ${table.createdBy} <> ''
    `),
  ],
);

export const shippingRateBookDestinationGroupMembers = shippingSchema.table(
  "rate_book_destination_group_members",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    destinationGroupId: integer("destination_group_id")
      .notNull()
      .references(() => shippingRateBookDestinationGroups.id, { onDelete: "cascade" }),
    destinationCountry: varchar("destination_country", { length: 2 }).notNull(),
    destinationRegion: varchar("destination_region", { length: 10 }),
    postalPrefix: varchar("postal_prefix", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shipping_rate_book_destination_group_member_idx").on(
      table.destinationGroupId,
      table.destinationCountry,
      sql`COALESCE(${table.destinationRegion}, '')`,
      sql`COALESCE(${table.postalPrefix}, '')`,
    ),
    index("shipping_rate_book_destination_group_member_lookup_idx").on(
      table.destinationCountry,
      table.destinationRegion,
      table.postalPrefix,
      table.destinationGroupId,
    ),
    check("shipping_rate_book_destination_group_member_country_chk", sql`
      ${table.destinationCountry} ~ '^[A-Z]{2}$'
    `),
    check("shipping_rate_book_destination_group_member_region_chk", sql`
      ${table.destinationRegion} IS NULL
      OR ${table.destinationRegion} ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    `),
    check("shipping_rate_book_destination_group_member_postal_chk", sql`
      ${table.postalPrefix} IS NULL
      OR (
        ${table.destinationRegion} IS NOT NULL
        AND
        ${table.postalPrefix} = btrim(${table.postalPrefix})
        AND ${table.postalPrefix} ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    `),
  ],
);

export const shippingChannelPolicies = shippingSchema.table("channel_policies", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "restrict" }),
  purpose: varchar("purpose", { length: 60 })
    .$type<ShippingChannelPolicyPurpose>()
    .notNull(),
  version: integer("version").notNull(),
  status: varchar("status", { length: 20 })
    .$type<ShippingChannelPolicyStatus>()
    .notNull()
    .default("draft"),
  metadata: jsonb("metadata"),
  createdBy: varchar("created_by", { length: 200 }).notNull(),
  activatedBy: varchar("activated_by", { length: 200 }),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  lockVersion: integer("lock_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_channel_policy_version_idx")
    .on(table.channelId, table.purpose, table.version),
  uniqueIndex("shipping_channel_policy_active_idx")
    .on(table.channelId, table.purpose)
    .where(sql`${table.status} = 'active'`),
  uniqueIndex("shipping_channel_policy_draft_idx")
    .on(table.channelId, table.purpose)
    .where(sql`${table.status} = 'draft'`),
  index("shipping_channel_policy_lookup_idx")
    .on(table.channelId, table.purpose, table.status),
  check("shipping_channel_policy_purpose_chk", sql`
    ${table.purpose} IN ('customer_checkout', 'vendor_fulfillment_charge')
  `),
  check("shipping_channel_policy_status_chk", sql`
    ${table.status} IN ('draft', 'active', 'retired')
  `),
  check("shipping_channel_policy_version_chk", sql`${table.version} > 0`),
  check("shipping_channel_policy_lock_version_chk", sql`${table.lockVersion} > 0`),
  check("shipping_channel_policy_actor_chk", sql`
    ${table.createdBy} = btrim(${table.createdBy})
    AND ${table.createdBy} <> ''
    AND (
      ${table.activatedBy} IS NULL
      OR (${table.activatedBy} = btrim(${table.activatedBy}) AND ${table.activatedBy} <> '')
    )
  `),
  check("shipping_channel_policy_lifecycle_chk", sql`
    (
      ${table.status} = 'draft'
      AND ${table.activatedBy} IS NULL
      AND ${table.activatedAt} IS NULL
      AND ${table.retiredAt} IS NULL
    )
    OR (
      ${table.status} = 'active'
      AND ${table.activatedBy} IS NOT NULL
      AND ${table.activatedAt} IS NOT NULL
      AND ${table.retiredAt} IS NULL
    )
    OR (
      ${table.status} = 'retired'
      AND ${table.retiredAt} IS NOT NULL
      AND (
        (
          ${table.activatedBy} IS NULL
          AND ${table.activatedAt} IS NULL
        )
        OR (
          ${table.activatedBy} IS NOT NULL
          AND ${table.activatedAt} IS NOT NULL
          AND ${table.retiredAt} >= ${table.activatedAt}
        )
      )
    )
  `),
]);

export const shippingChannelPolicyRoutes = shippingSchema.table("channel_policy_routes", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  policyId: integer("policy_id")
    .notNull()
    .references(() => shippingChannelPolicies.id, { onDelete: "cascade" }),
  sourceDestinationScopeId: integer("source_destination_scope_id")
    .references(() => shippingDestinationScopes.id, { onDelete: "restrict" }),
  originWarehouseId: integer("origin_warehouse_id")
    .references(() => warehouses.id, { onDelete: "restrict" }),
  mode: varchar("mode", { length: 30 })
    .$type<ShippingChannelRouteMode>()
    .notNull(),
  eligibilityMode: varchar("eligibility_mode", { length: 30 })
    .$type<ShippingChannelEligibilityMode>()
    .notNull(),
  rateBookId: integer("rate_book_id")
    .references(() => shippingRateBooks.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_channel_policy_route_scope_idx").on(
    table.policyId,
    sql`COALESCE(${table.originWarehouseId}, 0)`,
    sql`COALESCE(${table.sourceDestinationScopeId}, 0)`,
  ),
  index("shipping_channel_policy_route_lookup_idx").on(
    table.policyId,
    table.originWarehouseId,
    table.sourceDestinationScopeId,
  ),
  check("shipping_channel_policy_route_mode_chk", sql`
    ${table.mode} IN ('engine_quoted', 'channel_managed', 'disabled')
  `),
  check("shipping_channel_policy_route_eligibility_chk", sql`
    ${table.eligibilityMode} IN ('engine', 'channel', 'intersection', 'none')
  `),
  check("shipping_channel_policy_route_rate_book_chk", sql`
    (
      ${table.mode} = 'engine_quoted'
      AND ${table.rateBookId} IS NOT NULL
      AND ${table.eligibilityMode} <> 'none'
    )
    OR (
      ${table.mode} = 'channel_managed'
      AND ${table.rateBookId} IS NULL
      AND ${table.eligibilityMode} <> 'none'
    )
    OR (
      ${table.mode} = 'disabled'
      AND ${table.rateBookId} IS NULL
      AND ${table.eligibilityMode} = 'none'
    )
  `),
]);

export const shippingChannelPolicyRouteDestinations = shippingSchema.table(
  "channel_policy_route_destinations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    routeId: integer("route_id")
      .notNull()
      .references(() => shippingChannelPolicyRoutes.id, { onDelete: "cascade" }),
    destinationCountry: varchar("destination_country", { length: 2 }).notNull(),
    destinationRegion: varchar("destination_region", { length: 10 }),
    postalPrefix: varchar("postal_prefix", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shipping_channel_policy_route_destination_idx").on(
      table.routeId,
      table.destinationCountry,
      sql`COALESCE(${table.destinationRegion}, '')`,
      sql`COALESCE(${table.postalPrefix}, '')`,
    ),
    index("shipping_channel_policy_route_destination_lookup_idx").on(
      table.destinationCountry,
      table.destinationRegion,
      table.postalPrefix,
      table.routeId,
    ),
    check("shipping_channel_policy_route_destination_country_chk", sql`
      ${table.destinationCountry} ~ '^[A-Z]{2}$'
    `),
    check("shipping_channel_policy_route_destination_region_chk", sql`
      ${table.destinationRegion} IS NULL
      OR ${table.destinationRegion} ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    `),
    check("shipping_channel_policy_route_destination_postal_chk", sql`
      ${table.postalPrefix} IS NULL
      OR (
        ${table.postalPrefix} = btrim(${table.postalPrefix})
        AND ${table.postalPrefix} ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    `),
  ],
);

export const shippingZoneRules = shippingSchema.table("zone_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  // Nullable during the expand phase so pre-deploy writers remain compatible.
  zoneSetId: integer("zone_set_id").references(() => shippingZoneSets.id, { onDelete: "cascade" }),
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
  index("shipping_zone_rules_lookup_idx").on(table.zoneSetId, table.originWarehouseId, table.destinationCountry, table.postalPrefix, table.isActive),
]);

export const shippingRateTables = shippingSchema.table("rate_tables", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateBookId: integer("rate_book_id").notNull().references(() => shippingRateBooks.id, { onDelete: "restrict" }),
  serviceLevelId: integer("service_level_id").notNull().references(() => shippingServiceLevels.id, { onDelete: "restrict" }),
  pricingBasis: varchar("pricing_basis", { length: 30 }).notNull().default("shipment_weight"),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  // Provenance: how these rows were produced (e.g. shipstation-v2 calibration run id).
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shipping_rate_table_service_level_idx").on(table.rateBookId, table.serviceLevelId, table.status),
  check("shipping_rate_table_status_chk", sql`${table.status} IN ('draft', 'active', 'superseded', 'retired')`),
  check("shipping_rate_table_pricing_basis_chk", sql`${table.pricingBasis} IN ('shipment_weight', 'pallet_count')`),
]);

export const shippingRateTableRows = shippingSchema.table("rate_table_rows", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateTableId: integer("rate_table_id").notNull().references(() => shippingRateTables.id, { onDelete: "cascade" }),
  originWarehouseId: integer("origin_warehouse_id").references(() => warehouses.id, { onDelete: "restrict" }),
  destinationCountry: varchar("destination_country", { length: 2 }).notNull().default("US"),
  destinationRegion: varchar("destination_region", { length: 2 }).notNull(),
  postalPrefix: varchar("postal_prefix", { length: 5 }),
  minMeasure: integer("min_measure").notNull().default(0),
  maxMeasure: integer("max_measure"),
  maxShipmentWeightGrams: integer("max_shipment_weight_grams"),
  chargeModel: varchar("charge_model", { length: 40 }).notNull().default("fixed_band"),
  rateCents: bigint("rate_cents", { mode: "number" }).notNull(),
  perStartedPoundCents: bigint("per_started_pound_cents", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_rate_row_band_idx").on(
    table.rateTableId,
    sql`COALESCE(${table.originWarehouseId}, 0)`,
    table.destinationCountry,
    table.destinationRegion,
    sql`COALESCE(${table.postalPrefix}, '')`,
    table.minMeasure,
    sql`COALESCE(${table.maxMeasure}, -1)`,
    sql`COALESCE(${table.maxShipmentWeightGrams}, 0)`,
    table.chargeModel,
  ),
  index("shipping_rate_row_lookup_idx").on(
    table.rateTableId,
    table.destinationCountry,
    table.destinationRegion,
    table.postalPrefix,
    table.originWarehouseId,
  ),
  check("shipping_rate_row_country_chk", sql`${table.destinationCountry} ~ '^[A-Z]{2}$'`),
  check("shipping_rate_row_region_chk", sql`${table.destinationRegion} ~ '^[A-Z]{2}$'`),
  check("shipping_rate_row_postal_prefix_chk", sql`${table.postalPrefix} IS NULL OR ${table.postalPrefix} ~ '^[0-9]{1,5}$'`),
  check("shipping_rate_row_measure_chk", sql`
    ${table.minMeasure} >= 0
    AND (${table.maxMeasure} IS NULL OR ${table.maxMeasure} >= ${table.minMeasure})
  `),
  check("shipping_rate_row_shipment_weight_chk", sql`
    ${table.maxShipmentWeightGrams} IS NULL OR ${table.maxShipmentWeightGrams} > 0
  `),
  check("shipping_rate_row_rate_chk", sql`${table.rateCents} >= 0`),
  check("shipping_rate_row_charge_model_chk", sql`
    ${table.chargeModel} IN ('fixed_band', 'base_plus_per_started_pound')
  `),
  check("shipping_rate_row_charge_config_chk", sql`
    (
      ${table.chargeModel} = 'fixed_band'
      AND ${table.perStartedPoundCents} IS NULL
    )
    OR (
      ${table.chargeModel} = 'base_plus_per_started_pound'
      AND ${table.minMeasure} = 0
      AND ${table.maxMeasure} IS NULL
      AND ${table.maxShipmentWeightGrams} IS NULL
      AND ${table.perStartedPoundCents} IS NOT NULL
      AND ${table.perStartedPoundCents} >= 0
    )
  `),
]);

// Frozen destination/service coverage intent for one rate-table revision.
// Runtime amount selection continues to use rate_table_rows; these records
// make omitted rates distinguishable from an explicit not-offered decision.
export const shippingRateTableCoverages = shippingSchema.table(
  "rate_table_coverages",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    rateTableId: integer("rate_table_id")
      .notNull()
      .references(() => shippingRateTables.id, { onDelete: "cascade" }),
    destinationGroupId: integer("destination_group_id")
      .notNull()
      .references(() => shippingRateBookDestinationGroups.id, { onDelete: "restrict" }),
    sourceDestinationScopeId: integer("source_destination_scope_id")
      .references(() => shippingDestinationScopes.id, { onDelete: "restrict" }),
    sourceDestinationScopeLockVersion:
      integer("source_destination_scope_lock_version"),
    originWarehouseId: integer("origin_warehouse_id")
      .references(() => warehouses.id, { onDelete: "restrict" }),
    availability: varchar("availability", { length: 20 })
      .$type<ShippingRateCoverageAvailability>()
      .notNull(),
    destinationGroupLockVersion: integer("destination_group_lock_version").notNull(),
    destinationGroupName: varchar("destination_group_name", { length: 160 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shipping_rate_table_coverage_group_idx").on(
      table.rateTableId,
      table.destinationGroupId,
      sql`COALESCE(${table.originWarehouseId}, 0)`,
    ),
    index("shipping_rate_table_coverage_table_idx")
      .on(table.rateTableId, table.sortOrder, table.id),
    check("shipping_rate_table_coverage_availability_chk", sql`
      ${table.availability} IN ('offered', 'not_offered')
    `),
    check("shipping_rate_table_coverage_group_version_chk", sql`
      ${table.destinationGroupLockVersion} > 0
    `),
    check("shipping_rate_table_coverage_source_version_chk", sql`
      (
        ${table.sourceDestinationScopeId} IS NULL
        AND ${table.sourceDestinationScopeLockVersion} IS NULL
      )
      OR (
        ${table.sourceDestinationScopeId} IS NOT NULL
        AND ${table.sourceDestinationScopeLockVersion} > 0
      )
    `),
    index("shipping_rate_table_coverage_source_idx").on(
      table.sourceDestinationScopeId,
      table.sourceDestinationScopeLockVersion,
    ),
    check("shipping_rate_table_coverage_name_chk", sql`
      ${table.destinationGroupName} = btrim(${table.destinationGroupName})
      AND ${table.destinationGroupName} <> ''
    `),
    check("shipping_rate_table_coverage_sort_chk", sql`${table.sortOrder} >= 0`),
  ],
);

export const shippingRateTableCoverageDestinations = shippingSchema.table(
  "rate_table_coverage_destinations",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    rateTableCoverageId: integer("rate_table_coverage_id")
      .notNull()
      .references(() => shippingRateTableCoverages.id, { onDelete: "cascade" }),
    destinationCountry: varchar("destination_country", { length: 2 }).notNull(),
    destinationRegion: varchar("destination_region", { length: 10 }),
    postalPrefix: varchar("postal_prefix", { length: 20 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("shipping_rate_table_coverage_destination_idx").on(
      table.rateTableCoverageId,
      table.destinationCountry,
      sql`COALESCE(${table.destinationRegion}, '')`,
      sql`COALESCE(${table.postalPrefix}, '')`,
    ),
    index("shipping_rate_table_coverage_destination_lookup_idx").on(
      table.destinationCountry,
      table.destinationRegion,
      table.postalPrefix,
      table.rateTableCoverageId,
    ),
    check("shipping_rate_table_coverage_destination_country_chk", sql`
      ${table.destinationCountry} ~ '^[A-Z]{2}$'
    `),
    check("shipping_rate_table_coverage_destination_region_chk", sql`
      ${table.destinationRegion} IS NULL
      OR ${table.destinationRegion} ~ '^[A-Z0-9][A-Z0-9-]{0,9}$'
    `),
    check("shipping_rate_table_coverage_destination_postal_chk", sql`
      ${table.postalPrefix} IS NULL
      OR (
        ${table.destinationRegion} IS NOT NULL
        AND
        ${table.postalPrefix} = btrim(${table.postalPrefix})
        AND ${table.postalPrefix} ~ '^[A-Z0-9][A-Z0-9 -]{0,19}$'
      )
    `),
  ],
);

// ---------------------------------------------------------------------------
// Product-aware pricing policies
//
// Product sets are reusable authoring aids. Rate-rule members are immutable
// snapshots on a rate-table revision, so later catalog reclassification cannot
// silently change a live checkout price.
// ---------------------------------------------------------------------------

export const SHIPPING_PRODUCT_SET_SELECTOR_KINDS = [
  "manual",
  "shipping_group",
  "product_line",
  "category",
  "sioc",
] as const;
export type ShippingProductSetSelectorKind =
  (typeof SHIPPING_PRODUCT_SET_SELECTOR_KINDS)[number];

export const shippingProductSets = shippingSchema.table("product_sets", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 100 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  selectorKind: varchar("selector_kind", { length: 30 }).notNull(),
  selectorRef: varchar("selector_ref", { length: 160 }),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_product_set_code_idx").on(table.code),
  check("shipping_product_set_selector_kind_chk", sql`
    ${table.selectorKind} IN ('manual', 'shipping_group', 'product_line', 'category', 'sioc')
  `),
  check("shipping_product_set_status_chk", sql`${table.status} IN ('active', 'archived')`),
  check("shipping_product_set_selector_ref_chk", sql`
    (${table.selectorKind} = 'manual' AND ${table.selectorRef} IS NULL)
    OR (${table.selectorKind} <> 'manual' AND ${table.selectorRef} IS NOT NULL)
  `),
]);

export const shippingProductSetMembers = shippingSchema.table("product_set_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productSetId: integer("product_set_id").notNull()
    .references(() => shippingProductSets.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull()
    .references(() => productVariants.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_product_set_member_idx").on(table.productSetId, table.productVariantId),
  index("shipping_product_set_member_variant_idx").on(table.productVariantId),
]);

export const SHIPPING_RATE_RULE_KINDS = [
  "restriction",
  "base_charge",
  "adjustment",
  "threshold",
] as const;
export type ShippingRateRuleKind = (typeof SHIPPING_RATE_RULE_KINDS)[number];

export const SHIPPING_RATE_RULE_ACTIONS = [
  "block",
  "free",
  "fixed",
  "fixed_band",
  "base_plus_per_started_pound",
  "base_plus_per_additional_unit",
  "surcharge",
  "free_threshold",
] as const;
export type ShippingRateRuleAction = (typeof SHIPPING_RATE_RULE_ACTIONS)[number];

export const SHIPPING_RATE_RULE_MEASUREMENT_SCOPES = [
  "order",
  "matched_items",
  "each_item",
  "carton",
] as const;
export type ShippingRateRuleMeasurementScope =
  (typeof SHIPPING_RATE_RULE_MEASUREMENT_SCOPES)[number];

export interface ShippingRateRuleDestinationScope {
  country: string;
  regions: string[];
  postalPrefixes: Array<{ region: string; prefixes: string[] }>;
}

export const shippingRateRules = shippingSchema.table("rate_rules", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateTableId: integer("rate_table_id").notNull()
    .references(() => shippingRateTables.id, { onDelete: "cascade" }),
  sourceProductSetId: integer("source_product_set_id")
    .references(() => shippingProductSets.id, { onDelete: "set null" }),
  name: varchar("name", { length: 160 }).notNull(),
  kind: varchar("kind", { length: 30 }).notNull(),
  action: varchar("action", { length: 50 }).notNull(),
  measurementScope: varchar("measurement_scope", { length: 30 }).notNull(),
  destinationScope: jsonb("destination_scope").$type<ShippingRateRuleDestinationScope>().notNull(),
  rateCents: bigint("rate_cents", { mode: "number" }),
  perStartedPoundCents: bigint("per_started_pound_cents", { mode: "number" }),
  perAdditionalUnitCents: bigint("per_additional_unit_cents", { mode: "number" }),
  thresholdCents: bigint("threshold_cents", { mode: "number" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shipping_rate_rule_table_idx").on(table.rateTableId, table.isActive),
  check("shipping_rate_rule_kind_chk", sql`
    ${table.kind} IN ('restriction', 'base_charge', 'adjustment', 'threshold')
  `),
  check("shipping_rate_rule_action_chk", sql`
    ${table.action} IN ('block', 'free', 'fixed', 'fixed_band', 'base_plus_per_started_pound', 'base_plus_per_additional_unit', 'surcharge', 'free_threshold')
  `),
  check("shipping_rate_rule_measurement_scope_chk", sql`
    ${table.measurementScope} IN ('order', 'matched_items', 'each_item', 'carton')
  `),
  check("shipping_rate_rule_money_chk", sql`
    (${table.rateCents} IS NULL OR ${table.rateCents} >= 0)
    AND (${table.perStartedPoundCents} IS NULL OR ${table.perStartedPoundCents} >= 0)
    AND (${table.perAdditionalUnitCents} IS NULL OR ${table.perAdditionalUnitCents} >= 0)
    AND (${table.thresholdCents} IS NULL OR ${table.thresholdCents} >= 0)
  `),
  check("shipping_rate_rule_additional_unit_chk", sql`
    (
      ${table.action} = 'base_plus_per_additional_unit'
      AND ${table.rateCents} IS NOT NULL
      AND ${table.perAdditionalUnitCents} IS NOT NULL
      AND ${table.measurementScope} = 'matched_items'
      AND ${table.perStartedPoundCents} IS NULL
      AND ${table.thresholdCents} IS NULL
    )
    OR (
      ${table.action} <> 'base_plus_per_additional_unit'
      AND ${table.perAdditionalUnitCents} IS NULL
    )
  `),
]);

export const shippingRateRuleMembers = shippingSchema.table("rate_rule_members", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateRuleId: integer("rate_rule_id").notNull()
    .references(() => shippingRateRules.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull()
    .references(() => productVariants.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_rate_rule_member_idx").on(table.rateRuleId, table.productVariantId),
  index("shipping_rate_rule_member_variant_idx").on(table.productVariantId),
]);

export const shippingRateRuleBands = shippingSchema.table("rate_rule_bands", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateRuleId: integer("rate_rule_id").notNull()
    .references(() => shippingRateRules.id, { onDelete: "cascade" }),
  minMeasure: integer("min_measure").notNull().default(0),
  maxMeasure: integer("max_measure"),
  rateCents: bigint("rate_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_rate_rule_band_idx").on(
    table.rateRuleId,
    table.minMeasure,
    sql`COALESCE(${table.maxMeasure}, -1)`,
  ),
  check("shipping_rate_rule_band_measure_chk", sql`
    ${table.minMeasure} >= 0
    AND (${table.maxMeasure} IS NULL OR ${table.maxMeasure} >= ${table.minMeasure})
  `),
  check("shipping_rate_rule_band_rate_chk", sql`${table.rateCents} >= 0`),
]);

// ---------------------------------------------------------------------------
// Service levels are Card Shellz-owned checkout options such as Standard,
// Priority, Overnight, and Pallet Freight. Provider methods are future
// fulfillment mappings and are deliberately separate from customer pricing.
// ---------------------------------------------------------------------------

export const shippingServiceLevels = shippingSchema.table("service_levels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 40 }).notNull(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  description: varchar("description", { length: 400 }),
  fulfillmentMode: varchar("fulfillment_mode", { length: 30 }).notNull().default("parcel"),
  promiseMinBusinessDays: integer("promise_min_business_days"),
  promiseMaxBusinessDays: integer("promise_max_business_days"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_service_level_code_idx").on(table.code),
  check("shipping_service_level_fulfillment_mode_chk", sql`${table.fulfillmentMode} IN ('parcel', 'freight')`),
  check("shipping_service_level_promise_chk", sql`
    (
      ${table.promiseMinBusinessDays} IS NULL
      AND ${table.promiseMaxBusinessDays} IS NULL
    )
    OR (
      ${table.promiseMinBusinessDays} IS NOT NULL
      AND ${table.promiseMaxBusinessDays} IS NOT NULL
      AND ${table.promiseMinBusinessDays} >= 0
      AND ${table.promiseMaxBusinessDays} >= ${table.promiseMinBusinessDays}
    )
  `),
]);

export const shippingFulfillmentRoutingRevisions = shippingSchema.table("fulfillment_routing_revisions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  serviceLevelId: integer("service_level_id").notNull()
    .references(() => shippingServiceLevels.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  catalogHash: varchar("catalog_hash", { length: 64 }).notNull(),
  catalogFetchedAt: timestamp("catalog_fetched_at", { withTimezone: true }).notNull(),
  supersedesRevisionId: bigint("supersedes_revision_id", { mode: "number" }),
  methodsSnapshot: jsonb("methods_snapshot").$type<unknown[]>().notNull(),
  actorUserId: varchar("actor_user_id", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_fulfillment_routing_revision_version_idx").on(
    table.serviceLevelId,
    table.revision,
  ),
  uniqueIndex("shipping_fulfillment_routing_revision_id_scope_idx").on(
    table.id,
    table.serviceLevelId,
  ),
  uniqueIndex("shipping_fulfillment_routing_revision_head_idx").on(
    table.id,
    table.serviceLevelId,
    table.revision,
  ),
  uniqueIndex("shipping_fulfillment_routing_revision_idempotency_idx").on(
    table.serviceLevelId,
    table.idempotencyKey,
  ),
  foreignKey({
    columns: [table.supersedesRevisionId, table.serviceLevelId],
    foreignColumns: [table.id, table.serviceLevelId],
    name: "shipping_fulfillment_routing_revision_supersedes_fk",
  }).onDelete("restrict"),
  check("shipping_fulfillment_routing_revision_positive_chk", sql`${table.revision} > 0`),
  check("shipping_fulfillment_routing_revision_request_hash_chk", sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  check("shipping_fulfillment_routing_revision_catalog_hash_chk", sql`${table.catalogHash} ~ '^[0-9a-f]{64}$'`),
  check("shipping_fulfillment_routing_revision_idempotency_chk", sql`
    char_length(btrim(${table.idempotencyKey})) BETWEEN 16 AND 200
  `),
  check("shipping_fulfillment_routing_revision_actor_chk", sql`
    char_length(btrim(${table.actorUserId})) BETWEEN 1 AND 120
  `),
  check("shipping_fulfillment_routing_revision_snapshot_chk", sql`
    jsonb_typeof(${table.methodsSnapshot}) = 'array'
  `),
  check("shipping_fulfillment_routing_revision_chain_chk", sql`
    (${table.revision} = 1 AND ${table.supersedesRevisionId} IS NULL)
    OR (${table.revision} > 1 AND ${table.supersedesRevisionId} IS NOT NULL)
  `),
]);

export const shippingFulfillmentProviderConnections = shippingSchema.table("fulfillment_provider_connections", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  provider: varchar("provider", { length: 80 }).notNull(),
  name: varchar("name", { length: 160 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  credentialSource: varchar("credential_source", { length: 20 }).notNull(),
  credentialRef: varchar("credential_ref", { length: 120 }),
  systemManaged: boolean("system_managed").notNull().default(false),
  revision: integer("revision").notNull().default(1),
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 120 }),
  lastErrorMessage: varchar("last_error_message", { length: 500 }),
  createdBy: varchar("created_by", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedBy: varchar("updated_by", { length: 120 }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_fulfillment_provider_connection_id_provider_idx").on(
    table.id,
    table.provider,
  ),
  uniqueIndex("shipping_fulfillment_provider_connection_name_idx").on(
    table.provider,
    sql`lower(${table.name})`,
  ),
  check("shipping_fulfillment_provider_connection_provider_chk", sql`
    ${table.provider} ~ '^[a-z][a-z0-9_]{1,79}$'
  `),
  check("shipping_fulfillment_provider_connection_name_chk", sql`
    char_length(btrim(${table.name})) BETWEEN 1 AND 160
  `),
  check("shipping_fulfillment_provider_connection_status_chk", sql`
    ${table.status} IN ('active', 'disabled', 'error')
  `),
  check("shipping_fulfillment_provider_connection_credential_source_chk", sql`
    ${table.credentialSource} IN ('environment', 'vault')
  `),
  check("shipping_fulfillment_provider_connection_credential_ref_chk", sql`
    (
      ${table.credentialSource} = 'environment'
      AND ${table.credentialRef} IS NOT NULL
      AND char_length(btrim(${table.credentialRef})) BETWEEN 1 AND 120
      AND ${table.systemManaged} = TRUE
    )
    OR (
      ${table.credentialSource} = 'vault'
      AND ${table.credentialRef} IS NULL
      AND ${table.systemManaged} = FALSE
    )
  `),
  check("shipping_fulfillment_provider_connection_revision_chk", sql`${table.revision} > 0`),
  check("shipping_fulfillment_provider_connection_error_chk", sql`
    (
      ${table.status} = 'error'
      AND ${table.lastErrorCode} IS NOT NULL
      AND ${table.lastErrorMessage} IS NOT NULL
    )
    OR (
      ${table.status} <> 'error'
      AND ${table.lastErrorCode} IS NULL
      AND ${table.lastErrorMessage} IS NULL
    )
  `),
  check("shipping_fulfillment_provider_connection_actor_chk", sql`
    char_length(btrim(${table.createdBy})) BETWEEN 1 AND 120
    AND char_length(btrim(${table.updatedBy})) BETWEEN 1 AND 120
  `),
]);

export const shippingFulfillmentProviderCredentials = shippingSchema.table("fulfillment_provider_credentials", {
  connectionId: bigint("connection_id", { mode: "number" }).primaryKey()
    .references(() => shippingFulfillmentProviderConnections.id, { onDelete: "restrict" }),
  keyId: varchar("key_id", { length: 120 }).notNull(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  authTag: text("auth_tag").notNull(),
  updatedBy: varchar("updated_by", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("shipping_fulfillment_provider_credential_payload_chk", sql`
    char_length(btrim(${table.keyId})) BETWEEN 1 AND 120
    AND char_length(btrim(${table.ciphertext})) > 0
    AND char_length(btrim(${table.iv})) > 0
    AND char_length(btrim(${table.authTag})) > 0
    AND char_length(btrim(${table.updatedBy})) BETWEEN 1 AND 120
  `),
]);

export const shippingFulfillmentProviderConnectionEvents = shippingSchema.table("fulfillment_provider_connection_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  connectionId: bigint("connection_id", { mode: "number" }).notNull()
    .references(() => shippingFulfillmentProviderConnections.id, { onDelete: "restrict" }),
  action: varchar("action", { length: 40 }).notNull(),
  connectionRevision: integer("connection_revision").notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown> | null>(),
  afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>().notNull(),
  actorUserId: varchar("actor_user_id", { length: 120 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_fulfillment_provider_connection_event_idempotency_idx")
    .on(table.idempotencyKey),
  uniqueIndex("shipping_fulfillment_provider_connection_event_revision_idx")
    .on(table.connectionId, table.connectionRevision),
  check("shipping_fulfillment_provider_connection_event_action_chk", sql`
    ${table.action} IN (
      'created', 'credential_replaced', 'verified', 'verification_failed',
      'enabled', 'disabled'
    )
  `),
  check("shipping_fulfillment_provider_connection_event_revision_chk", sql`
    ${table.connectionRevision} > 0
  `),
  check("shipping_fulfillment_provider_connection_event_idempotency_chk", sql`
    char_length(btrim(${table.idempotencyKey})) BETWEEN 16 AND 200
  `),
  check("shipping_fulfillment_provider_connection_event_request_hash_chk", sql`
    ${table.requestHash} ~ '^[0-9a-f]{64}$'
  `),
  check("shipping_fulfillment_provider_connection_event_snapshot_chk", sql`
    (${table.beforeSnapshot} IS NULL OR jsonb_typeof(${table.beforeSnapshot}) = 'object')
    AND jsonb_typeof(${table.afterSnapshot}) = 'object'
  `),
  check("shipping_fulfillment_provider_connection_event_actor_chk", sql`
    char_length(btrim(${table.actorUserId})) BETWEEN 1 AND 120
  `),
]);

export const shippingFulfillmentRoutingProfiles = shippingSchema.table("fulfillment_routing_profiles", {
  serviceLevelId: integer("service_level_id").primaryKey()
    .references(() => shippingServiceLevels.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull().default(0),
  currentRevisionId: bigint("current_revision_id", { mode: "number" }),
  updatedBy: varchar("updated_by", { length: 120 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.currentRevisionId, table.serviceLevelId, table.revision],
    foreignColumns: [
      shippingFulfillmentRoutingRevisions.id,
      shippingFulfillmentRoutingRevisions.serviceLevelId,
      shippingFulfillmentRoutingRevisions.revision,
    ],
    name: "shipping_fulfillment_routing_profile_current_revision_fk",
  }).onDelete("restrict"),
  check("shipping_fulfillment_routing_profile_revision_chk", sql`${table.revision} >= 0`),
  check("shipping_fulfillment_routing_profile_state_chk", sql`
    (
      ${table.revision} = 0
      AND ${table.currentRevisionId} IS NULL
      AND ${table.updatedBy} IS NULL
    )
    OR (
      ${table.revision} > 0
      AND ${table.currentRevisionId} IS NOT NULL
      AND ${table.updatedBy} IS NOT NULL
      AND char_length(btrim(${table.updatedBy})) BETWEEN 1 AND 120
    )
  `),
]);

export const shippingServiceLevelMethods = shippingSchema.table("service_level_methods", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  serviceLevelId: integer("service_level_id").notNull().references(() => shippingServiceLevels.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  providerConnectionId: bigint("provider_connection_id", { mode: "number" }),
  providerAccountId: varchar("provider_account_id", { length: 120 }),
  providerAccountName: varchar("provider_account_name", { length: 160 }),
  carrier: varchar("carrier", { length: 50 }).notNull(),
  carrierName: varchar("carrier_name", { length: 160 }),
  serviceCode: varchar("service_code", { length: 80 }).notNull(),
  serviceName: varchar("service_name", { length: 160 }),
  priority: integer("priority").notNull(),
  domestic: boolean("domestic").notNull().default(false),
  international: boolean("international").notNull().default(false),
  providerCapabilities: jsonb("provider_capabilities")
    // Migration 0650 uses a write guard so historical scoped rows may remain
    // null while new scoped rows are required to persist a valid snapshot.
    .$type<ShippingFulfillmentMethodCapabilities | null>(),
  revisionId: bigint("revision_id", { mode: "number" }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_level_method_identity_idx").on(
    table.serviceLevelId,
    table.providerConnectionId,
    table.providerAccountId,
    table.serviceCode,
    table.domestic,
    table.international,
  ),
  uniqueIndex("shipping_level_method_priority_idx")
    .on(table.serviceLevelId, table.priority)
    .where(sql`${table.providerConnectionId} IS NOT NULL`),
  foreignKey({
    columns: [table.providerConnectionId, table.provider],
    foreignColumns: [
      shippingFulfillmentProviderConnections.id,
      shippingFulfillmentProviderConnections.provider,
    ],
    name: "shipping_level_method_provider_connection_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.revisionId, table.serviceLevelId],
    foreignColumns: [
      shippingFulfillmentRoutingRevisions.id,
      shippingFulfillmentRoutingRevisions.serviceLevelId,
    ],
    name: "shipping_level_method_revision_fk",
  }).onDelete("restrict"),
  check("shipping_level_method_provider_chk", sql`
    ${table.provider} = 'legacy_unscoped'
    OR ${table.provider} ~ '^[a-z][a-z0-9_]{1,79}$'
  `),
  check("shipping_level_method_priority_chk", sql`${table.priority} > 0`),
  check("shipping_level_method_scope_chk", sql`
    ${table.provider} = 'legacy_unscoped'
    OR ${table.domestic}
    OR ${table.international}
  `),
  check("shipping_level_method_capabilities_chk", sql`
    ${table.providerCapabilities} IS NULL
    OR CASE
      WHEN jsonb_typeof(${table.providerCapabilities}) = 'object' THEN
        jsonb_typeof(${table.providerCapabilities} -> 'supportsMultiPackage') IS NOT DISTINCT FROM 'boolean'
        AND jsonb_typeof(${table.providerCapabilities} -> 'supportsReturns') IS NOT DISTINCT FROM 'boolean'
        AND jsonb_typeof(${table.providerCapabilities} -> 'supportsPrepaidDutiesTaxes') IS NOT DISTINCT FROM 'boolean'
        AND jsonb_typeof(${table.providerCapabilities} -> 'sendRates') IS NOT DISTINCT FROM 'boolean'
        AND CASE
          WHEN jsonb_typeof(${table.providerCapabilities} -> 'displaySchemes') = 'array'
            THEN jsonb_array_length(${table.providerCapabilities} -> 'displaySchemes') <= 20
          ELSE FALSE
        END
      ELSE FALSE
    END
  `),
  check("shipping_level_method_identity_chk", sql`
    (
      ${table.provider} = 'legacy_unscoped'
      AND ${table.providerConnectionId} IS NULL
      AND ${table.providerAccountId} IS NULL
      AND ${table.revisionId} IS NULL
    )
    OR (
      ${table.provider} <> 'legacy_unscoped'
      AND ${table.providerConnectionId} IS NOT NULL
      AND ${table.providerAccountId} IS NOT NULL
      AND ${table.providerAccountName} IS NOT NULL
      AND ${table.carrierName} IS NOT NULL
      AND ${table.serviceName} IS NOT NULL
      AND char_length(btrim(${table.carrier})) BETWEEN 1 AND 50
      AND char_length(btrim(${table.serviceCode})) BETWEEN 1 AND 80
      AND char_length(btrim(${table.providerAccountId})) BETWEEN 1 AND 120
      AND char_length(btrim(${table.providerAccountName})) BETWEEN 1 AND 160
      AND char_length(btrim(${table.carrierName})) BETWEEN 1 AND 160
      AND char_length(btrim(${table.serviceName})) BETWEEN 1 AND 160
      AND ${table.revisionId} IS NOT NULL
    )
  `),
]);

export const shippingTransitMatrix = shippingSchema.table("transit_matrix", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  carrier: varchar("carrier", { length: 50 }).notNull(),
  serviceCode: varchar("service_code", { length: 80 }).notNull(),
  originWarehouseId: integer("origin_warehouse_id").notNull().references(() => warehouses.id, { onDelete: "cascade" }),
  destinationZone: varchar("destination_zone", { length: 40 }).notNull(),
  minBusinessDays: integer("min_business_days").notNull(),
  maxBusinessDays: integer("max_business_days").notNull(),
  // Source of the estimate: carrier published standard vs observed actuals.
  source: varchar("source", { length: 40 }).notNull().default("carrier_standard"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_transit_idx").on(table.carrier, table.serviceCode, table.originWarehouseId, table.destinationZone),
  check("shipping_transit_days_chk", sql`${table.minBusinessDays} >= 0 AND ${table.maxBusinessDays} >= ${table.minBusinessDays}`),
]);

// ---------------------------------------------------------------------------
// Pack plans — ONE record consumed by both pricing and the pack station so the
// quoted box choice and the physical pack can never diverge. Order-time plans
// attach to wms.shipment_requests (canonical fulfillment chain, migration 115).
// ---------------------------------------------------------------------------

export const shippingPackPlans = shippingSchema.table("pack_plans", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  wmsOrderId: integer("wms_order_id").references(() => orders.id, { onDelete: "cascade" }),
  shipmentRequestId: bigint("shipment_request_id", { mode: "number" }).references(() => shipmentRequests.id, { onDelete: "set null" }),
  status: varchar("status", { length: 30 }).notNull().default("active"),
  engineVersion: varchar("engine_version", { length: 80 }).notNull(),
  // Hash of the cartonization input (items+attrs+boxes) for cheap staleness checks.
  inputHash: varchar("input_hash", { length: 128 }),
  warnings: jsonb("warnings"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shipping_pack_plans_order_idx").on(table.wmsOrderId),
  index("shipping_pack_plans_request_idx").on(table.shipmentRequestId),
  uniqueIndex("shipping_pack_plans_active_request_idx").on(table.shipmentRequestId).where(sql`${table.status} = 'active' AND ${table.shipmentRequestId} IS NOT NULL`),
  check("shipping_pack_plans_status_chk", sql`${table.status} IN ('active', 'superseded', 'packed', 'cancelled')`),
]);

export const shippingPackPlanParcels = shippingSchema.table("pack_plan_parcels", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  packPlanId: bigint("pack_plan_id", { mode: "number" }).notNull().references(() => shippingPackPlans.id, { onDelete: "cascade" }),
  parcelSequence: integer("parcel_sequence").notNull(),
  // Exactly one of: a catalog box, or a SIOC variant whose packaging IS the parcel.
  boxId: integer("box_id").references(() => shippingBoxCatalog.id, { onDelete: "restrict" }),
  siocProductVariantId: integer("sioc_product_variant_id").references(() => productVariants.id, { onDelete: "restrict" }),
  estWeightGrams: integer("est_weight_grams").notNull(),
  billableWeightGrams: integer("billable_weight_grams").notNull(),
  lengthMm: integer("length_mm").notNull(),
  widthMm: integer("width_mm").notNull(),
  heightMm: integer("height_mm").notNull(),
  // Verified per-unit positions and rotations produced by the cartonizer.
  placements: jsonb("placements")
    .$type<ShippingCartonPlacement[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // Pack-station confirmation (migration 121): the ACTUAL box + weight used.
  // Predicted vs actual on the same row is the cartonizer calibration dataset.
  actualBoxId: integer("actual_box_id").references(() => shippingBoxCatalog.id, { onDelete: "set null" }),
  actualWeightGrams: integer("actual_weight_grams"),
  packedAt: timestamp("packed_at", { withTimezone: true }),
  packedBy: varchar("packed_by", { length: 120 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_parcel_seq_idx").on(table.packPlanId, table.parcelSequence),
  check("shipping_parcel_container_chk", sql`
    (${table.boxId} IS NOT NULL AND ${table.siocProductVariantId} IS NULL)
    OR (${table.boxId} IS NULL AND ${table.siocProductVariantId} IS NOT NULL)
  `),
  check("shipping_parcel_weights_chk", sql`${table.estWeightGrams} > 0 AND ${table.billableWeightGrams} > 0`),
  check("shipping_parcel_placements_array_chk", sql`jsonb_typeof(${table.placements}) = 'array'`),
  check("shipping_parcel_actual_weight_chk", sql`${table.actualWeightGrams} IS NULL OR ${table.actualWeightGrams} > 0`),
]);

export const shippingPackPlanParcelItems = shippingSchema.table("pack_plan_parcel_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  parcelId: bigint("parcel_id", { mode: "number" }).notNull().references(() => shippingPackPlanParcels.id, { onDelete: "cascade" }),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  // Rider items were absorbed from another shipping group's partition (void fill).
  isRider: boolean("is_rider").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_parcel_item_idx").on(table.parcelId, table.productVariantId),
  check("shipping_parcel_item_qty_chk", sql`${table.quantity} > 0`),
]);

// ---------------------------------------------------------------------------
// Quote snapshots — shadow-mode and checkout observability. Every quote the
// engine produces (shadow comparison vs Parcelify, live callback responses)
// lands here; this is the calibration dataset.
// ---------------------------------------------------------------------------

export const shippingQuoteSnapshots = shippingSchema.table("quote_snapshots", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  source: varchar("source", { length: 30 }).notNull(),
  destinationCountry: varchar("destination_country", { length: 2 }).notNull().default("US"),
  destinationPostalCode: varchar("destination_postal_code", { length: 20 }),
  resolvedZone: varchar("resolved_zone", { length: 40 }),
  requestHash: varchar("request_hash", { length: 128 }),
  requestPayload: jsonb("request_payload").notNull(),
  packing: jsonb("packing"),
  rates: jsonb("rates"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shipping_quote_snapshots_created_idx").on(table.createdAt),
  index("shipping_quote_snapshots_hash_idx").on(table.requestHash),
  check("shipping_quote_snapshots_source_chk", sql`${table.source} IN ('shadow', 'checkout', 'preview', 'manual')`),
]);

// ---------------------------------------------------------------------------
// Insert schemas (zod) for the admin CRUD surfaces
// ---------------------------------------------------------------------------

export const insertShippingBoxSchema = createInsertSchema(shippingBoxCatalog, {
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(SHIPPING_BOX_KINDS),
  lengthMm: z.number().int().positive(),
  widthMm: z.number().int().positive(),
  heightMm: z.number().int().positive(),
  tareWeightGrams: z.number().int().min(0),
  maxWeightGrams: z.number().int().positive().nullable().optional(),
  costCents: z.number().int().min(0),
  fillFactorBps: z.number().int().min(1).max(10000),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const insertShippingVariantAttrsSchema = createInsertSchema(shippingVariantAttrs, {
  productVariantId: z.number().int().positive(),
  riderVoidCm3: z.number().int().positive().nullable().optional(),
  riderVoidMaxWeightGrams: z.number().int().positive().nullable().optional(),
  riderVoidMaxItems: z.number().int().positive().nullable().optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export type ShippingBox = typeof shippingBoxCatalog.$inferSelect;
export type InsertShippingBox = z.infer<typeof insertShippingBoxSchema>;
export type ShippingVariantAttrs = typeof shippingVariantAttrs.$inferSelect;
export type ShippingServiceLevelRecord = typeof shippingServiceLevels.$inferSelect;
export type ShippingFulfillmentRoutingProfileRecord = typeof shippingFulfillmentRoutingProfiles.$inferSelect;
export type ShippingFulfillmentRoutingRevisionRecord = typeof shippingFulfillmentRoutingRevisions.$inferSelect;
export type ShippingFulfillmentProviderConnectionRecord = typeof shippingFulfillmentProviderConnections.$inferSelect;
export type ShippingFulfillmentProviderCredentialRecord = typeof shippingFulfillmentProviderCredentials.$inferSelect;
export type ShippingFulfillmentProviderConnectionEventRecord = typeof shippingFulfillmentProviderConnectionEvents.$inferSelect;
export type ShippingServiceLevelMethodRecord = typeof shippingServiceLevelMethods.$inferSelect;
export type ShippingPackPlan = typeof shippingPackPlans.$inferSelect;
export type ShippingPackPlanParcel = typeof shippingPackPlanParcels.$inferSelect;
