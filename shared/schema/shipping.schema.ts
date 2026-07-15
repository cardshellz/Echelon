import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
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
import { shipmentRequests } from "./fulfillment.schema";
import { orders } from "./orders.schema";
import { warehouses } from "./warehouse.schema";

// First-party shipping engine (quote plane). Design: docs/SHIPPING-ENGINE-DESIGN.md.
// The fulfillment plane (wms.fulfillment_plans → shipment_requests → physical_shipments)
// lives in fulfillment.schema.ts; pack plans here attach to shipment_requests rather
// than duplicating that chain. Channel pricing converges here through independently
// assigned rate books; channel billing policy remains outside.

export const shippingSchema = pgSchema("shipping");

export const SHIPPING_DEFAULT_FILL_FACTOR_BPS = 8500;

export const SHIPPING_BOX_KINDS = ["box", "mailer", "envelope"] as const;
export type ShippingBoxKind = (typeof SHIPPING_BOX_KINDS)[number];

export const SHIPPING_SERVICE_LEVEL_CODES = ["standard", "expedited", "express"] as const;
export type ShippingServiceLevelCode = (typeof SHIPPING_SERVICE_LEVEL_CODES)[number];

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
// Physical dims/weight stay canonical on catalog.product_variants; this table
// holds packing BEHAVIOR: SIOC, rider/void co-mingling (see design doc).
// ---------------------------------------------------------------------------

export const shippingVariantAttrs = shippingSchema.table("variant_shipping_attrs", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  productVariantId: integer("product_variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  // SIOC: parcel = the item's own packaging (no outer box). User-controlled;
  // sioc_suggested marks system candidates (sealed case-level variants) awaiting review.
  shipsInOwnContainer: boolean("ships_in_own_container").notNull().default(false),
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
  // Nullable during the expand phase; all new writers provide a book explicitly.
  rateBookId: integer("rate_book_id").references(() => shippingRateBooks.id, { onDelete: "restrict" }),
  carrier: varchar("carrier", { length: 50 }).notNull(),
  serviceCode: varchar("service_code", { length: 80 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("USD"),
  status: varchar("status", { length: 30 }).notNull().default("draft"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  // Provenance: how these rows were produced (e.g. shipstation-v2 calibration run id).
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("shipping_rate_table_carrier_service_idx").on(table.rateBookId, table.carrier, table.serviceCode, table.status),
  check("shipping_rate_table_status_chk", sql`${table.status} IN ('draft', 'active', 'superseded', 'retired')`),
]);

export const shippingRateTableRows = shippingSchema.table("rate_table_rows", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  rateTableId: integer("rate_table_id").notNull().references(() => shippingRateTables.id, { onDelete: "cascade" }),
  originWarehouseId: integer("origin_warehouse_id").references(() => warehouses.id, { onDelete: "set null" }),
  destinationZone: varchar("destination_zone", { length: 40 }).notNull(),
  minWeightGrams: integer("min_weight_grams").notNull().default(0),
  maxWeightGrams: integer("max_weight_grams").notNull(),
  rateCents: bigint("rate_cents", { mode: "number" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_rate_row_band_idx").on(table.rateTableId, table.originWarehouseId, table.destinationZone, table.minWeightGrams, table.maxWeightGrams),
  check("shipping_rate_row_weight_chk", sql`${table.minWeightGrams} >= 0 AND ${table.maxWeightGrams} >= ${table.minWeightGrams}`),
  check("shipping_rate_row_rate_chk", sql`${table.rateCents} >= 0`),
]);

// ---------------------------------------------------------------------------
// Service levels — what checkout SELLS (Standard/Expedited/Express).
// Methods map a level to the carrier services allowed to fulfill its promise;
// the engine picks the cheapest qualifying method at fulfillment time.
// ---------------------------------------------------------------------------

export const shippingServiceLevels = shippingSchema.table("service_levels", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  code: varchar("code", { length: 40 }).notNull(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  description: varchar("description", { length: 400 }),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_service_level_code_idx").on(table.code),
]);

export const shippingServiceLevelMethods = shippingSchema.table("service_level_methods", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  serviceLevelId: integer("service_level_id").notNull().references(() => shippingServiceLevels.id, { onDelete: "cascade" }),
  carrier: varchar("carrier", { length: 50 }).notNull(),
  serviceCode: varchar("service_code", { length: 80 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("shipping_level_method_idx").on(table.serviceLevelId, table.carrier, table.serviceCode),
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
export type ShippingPackPlan = typeof shippingPackPlans.$inferSelect;
export type ShippingPackPlanParcel = typeof shippingPackPlanParcels.$inferSelect;
