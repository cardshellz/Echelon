import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

import { productVariants } from "./catalog.schema";
import { buildOrders } from "./inventory.schema";
import { orderItems, orders } from "./orders.schema";
import { warehouses } from "./warehouse.schema";

export const orderBuildDemandStatusEnum = [
  "planning",
  "awaiting_build",
  "fulfilled",
  "cancelled",
  "failed",
] as const;
export type OrderBuildDemandStatus = typeof orderBuildDemandStatusEnum[number];

const wmsSchema = pgSchema("wms");

export const orderBuildDemands = wmsSchema.table("order_build_demands", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  orderId: integer("order_id").notNull().references(() => orders.id, { onDelete: "restrict" }),
  orderItemId: integer("order_item_id").notNull()
    .references(() => orderItems.id, { onDelete: "restrict" }),
  targetVariantId: integer("target_variant_id").notNull()
    .references(() => productVariants.id, { onDelete: "restrict" }),
  warehouseId: integer("warehouse_id").notNull()
    .references(() => warehouses.id, { onDelete: "restrict" }),
  rootBuildOrderId: integer("root_build_order_id")
    .references(() => buildOrders.id, { onDelete: "restrict" }),
  requestedQty: integer("requested_qty").notNull(),
  promisedQty: integer("promised_qty").notNull(),
  status: varchar("status", { length: 30 }).notNull().default("planning"),
  holdApplied: boolean("hold_applied").notNull().default(false),
  holdReason: varchar("hold_reason", { length: 200 }).notNull(),
  failureCode: varchar("failure_code", { length: 60 }),
  failureMessage: text("failure_message"),
  createdBy: varchar("created_by", { length: 100 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orderItemUnique: uniqueIndex("order_build_demands_order_item_uidx").on(table.orderItemId),
  rootBuildOrderUnique: uniqueIndex("order_build_demands_root_build_order_uidx")
    .on(table.rootBuildOrderId),
  statusCreatedIndex: index("order_build_demands_status_created_idx")
    .on(table.status, table.createdAt),
  orderIndex: index("order_build_demands_order_idx").on(table.orderId, table.status),
  requestedQtyPositive: check("order_build_demands_requested_qty_chk", sql`${table.requestedQty} > 0`),
  promisedQtyPositive: check("order_build_demands_promised_qty_chk", sql`${table.promisedQty} > 0`),
  statusValid: check(
    "order_build_demands_status_chk",
    sql`${table.status} IN ('planning', 'awaiting_build', 'fulfilled', 'cancelled', 'failed')`,
  ),
  rootRequiredAfterPlanning: check(
    "order_build_demands_root_required_chk",
    sql`${table.status} = 'planning' OR ${table.rootBuildOrderId} IS NOT NULL`,
  ),
}));

export type OrderBuildDemand = typeof orderBuildDemands.$inferSelect;
