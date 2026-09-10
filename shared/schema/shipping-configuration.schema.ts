import { sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { productVariants } from "./catalog.schema";
import { dropshipBoxCatalog } from "./dropship.schema";
import { warehouses } from "./warehouse.schema";
import { channels } from "./channels.schema";
import {
  shippingSchema,
  shippingBoxCatalog,
  shippingRateBooks,
  shippingServiceLevels,
  shippingPackPlans,
  shippingPackPlanParcels,
} from "./shipping.schema";
import type { ProgramCharges } from "../shipping/configuration";

export const warehousePackagingRevisions = shippingSchema.table(
  "warehouse_packaging_revisions",
  {
    warehouseId: integer("warehouse_id")
      .primaryKey()
      .references(() => warehouses.id),
    revision: integer("revision").notNull(),
  },
  (t) => [
    check(
      "warehouse_packaging_revisions_revision_check",
      sql`${t.revision} > 0`,
    ),
  ],
);

export const warehousePackagingAvailability = shippingSchema.table(
  "warehouse_packaging_availability",
  {
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    boxId: integer("box_id")
      .notNull()
      .references(() => shippingBoxCatalog.id),
    available: boolean("available").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.warehouseId, t.boxId] }),
    index("warehouse_packaging_availability_box_idx").on(t.boxId),
  ],
);

export const shippingChannelPackagingPolicies = shippingSchema.table(
  "channel_packaging_policies",
  {
    channelId: integer("channel_id")
      .primaryKey()
      .references(() => channels.id),
    revision: integer("revision").notNull(),
    defaultSuiteId: integer("default_suite_id")
      .notNull()
      .references(() => shippingBoxSuites.id),
    requirement: text("requirement").notNull(),
  },
  (t) => [
    check("channel_packaging_revision_positive", sql`${t.revision}>0`),
    check(
      "channel_packaging_requirement",
      sql`${t.requirement} IN ('any','unbranded')`,
    ),
  ],
);

export const shippingChannelPackagingOverrides = shippingSchema.table(
  "channel_packaging_overrides",
  {
    channelId: integer("channel_id")
      .notNull()
      .references(() => shippingChannelPackagingPolicies.channelId),
    warehouseId: integer("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    suiteId: integer("suite_id")
      .notNull()
      .references(() => shippingBoxSuites.id),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.warehouseId] })],
);

export const shippingPackagingConfirmationEvents = shippingSchema.table(
  "packaging_confirmation_events",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    planId: bigint("plan_id", { mode: "number" })
      .notNull()
      .references(() => shippingPackPlans.id),
    parcelId: bigint("parcel_id", { mode: "number" })
      .notNull()
      .references(() => shippingPackPlanParcels.id),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    beforeState: jsonb("before_state").notNull(),
    afterState: jsonb("after_state").notNull(),
  },
);

// SQL migrations additionally own deferred current-revision FKs and immutable
// history triggers. Never replace those transactional guarantees with db:push.
export const shippingConfigurationCommands = shippingSchema.table(
  "configuration_commands",
  {
    commandId: uuid("command_id").primaryKey(),
    requestHash: text("request_hash").notNull(),
    actorId: text("actor_id").notNull(),
    resourceKey: text("resource_key").notNull(),
    beforeState: jsonb("before_state"),
    afterState: jsonb("after_state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("shipping_configuration_history_idx").on(
      t.resourceKey,
      t.createdAt.desc(),
    ),
    check(
      "configuration_commands_request_hash_check",
      sql`length(${t.requestHash}) = 64`,
    ),
  ],
);

export const shippingBoxSuites = shippingSchema.table(
  "box_suites",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    currentRevision: integer("current_revision").notNull(),
    archived: boolean("archived").notNull().default(false),
    imported: boolean("imported").notNull().default(false),
  },
  (t) => [
    uniqueIndex("shipping_box_suites_name_idx").on(sql`lower(${t.name})`),
    check("box_suites_name_check", sql`length(${t.name}) BETWEEN 1 AND 160`),
    check("box_suites_current_revision_check", sql`${t.currentRevision} > 0`),
  ],
);

export const shippingBoxSuiteRevisions = shippingSchema.table(
  "box_suite_revisions",
  {
    suiteId: integer("suite_id")
      .notNull()
      .references(() => shippingBoxSuites.id),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    actorId: text("actor_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.suiteId, t.revision] }),
    check("box_suite_revisions_revision_check", sql`${t.revision} > 0`),
  ],
);

export const shippingBoxSuiteMembers = shippingSchema.table(
  "box_suite_members",
  {
    suiteId: integer("suite_id").notNull(),
    revision: integer("revision").notNull(),
    boxId: integer("box_id")
      .notNull()
      .references(() => shippingBoxCatalog.id),
  },
  (t) => [
    primaryKey({ columns: [t.suiteId, t.revision, t.boxId] }),
    foreignKey({
      columns: [t.suiteId, t.revision],
      foreignColumns: [
        shippingBoxSuiteRevisions.suiteId,
        shippingBoxSuiteRevisions.revision,
      ],
    }),
  ],
);

export const shippingPackagingAssignments = shippingSchema.table(
  "packaging_assignments",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    channel: text("channel").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    warehouseId: integer("warehouse_id").references(() => warehouses.id),
    suiteId: integer("suite_id")
      .notNull()
      .references(() => shippingBoxSuites.id),
    revision: integer("revision").notNull(),
  },
  (t) => [
    uniqueIndex("shipping_packaging_assignment_idx").on(
      t.channel,
      sql`COALESCE(${t.warehouseId},0)`,
    ),
    check(
      "packaging_assignments_channel_check",
      sql`${t.channel} IN ('shopify','internal','ebay','dropship')`,
    ),
    check("packaging_assignments_revision_check", sql`${t.revision} > 0`),
  ],
);

export const shippingRateBookChargeRevisions = shippingSchema.table(
  "rate_book_charge_revisions",
  {
    rateBookId: integer("rate_book_id")
      .notNull()
      .references(() => shippingRateBooks.id),
    revision: integer("revision").notNull(),
    charges: jsonb("charges").$type<ProgramCharges>().notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    actorId: text("actor_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.rateBookId, t.revision] }),
    uniqueIndex("shipping_program_charge_current_idx")
      .on(t.rateBookId)
      .where(sql`${t.effectiveTo} IS NULL`),
    check("rate_book_charge_revisions_revision_check", sql`${t.revision} > 0`),
    check(
      "rate_book_charge_revisions_charges_check",
      sql`jsonb_typeof(${t.charges})='object'`,
    ),
    check(
      "rate_book_charge_revisions_check",
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),
  ],
);

export const shippingLegacyDropshipBoxMap = shippingSchema.table(
  "legacy_dropship_box_map",
  {
    legacyBoxId: integer("legacy_box_id")
      .primaryKey()
      .references(() => dropshipBoxCatalog.id),
    boxId: integer("box_id")
      .notNull()
      .unique()
      .references(() => shippingBoxCatalog.id),
  },
);

export const shippingFulfillmentChannelServices = shippingSchema.table(
  "fulfillment_channel_services",
  {
    channel: text("channel").primaryKey(),
    serviceLevelId: integer("service_level_id")
      .notNull()
      .references(() => shippingServiceLevels.id),
    revision: integer("revision").notNull(),
  },
  (t) => [
    check(
      "fulfillment_channel_services_channel_check",
      sql`${t.channel} IN ('shopify','internal','ebay','dropship')`,
    ),
    check(
      "fulfillment_channel_services_revision_check",
      sql`${t.revision} > 0`,
    ),
  ],
);

export const shippingChannelPackingPreferences = shippingSchema.table(
  "channel_packing_preferences",
  {
    channel: text("channel").notNull(),
    productVariantId: integer("product_variant_id")
      .notNull()
      .references(() => productVariants.id),
    preferredBoxId: integer("preferred_box_id").references(
      () => shippingBoxCatalog.id,
    ),
    legacyCarrier: text("legacy_carrier"),
    legacyService: text("legacy_service"),
    source: text("source").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.channel, t.productVariantId] }),
    check(
      "channel_packing_preferences_channel_check",
      sql`${t.channel} IN ('shopify','internal','ebay','dropship')`,
    ),
  ],
);
