import { sql } from "drizzle-orm";
import { pgSchema, bigint, integer, varchar, uuid, jsonb, timestamp, unique, foreignKey, index, check } from "drizzle-orm/pg-core";
import { warehouses } from "./warehouse.schema";
import { users } from "./identity.schema";
import { inventoryAvailabilityClaimOperations } from "./inventory-planning.schema";
import { workStations, workConfigurationRevisions } from "./warehouse-work.schema";
import type { AssemblyTask, AssemblyTaskContext } from "../warehouse-assembly-work";

const warehouseSchema = pgSchema("warehouse");
export const warehouseWorkItems = warehouseSchema.table("work_items", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  claimId: bigint("claim_id", { mode: "bigint" }).notNull(),
  claimOperationId: bigint("claim_operation_id", { mode: "bigint" }).notNull().unique(),
  stationId: uuid("station_id").notNull(),
  configurationRevision: integer("configuration_revision").notNull(),
  context: jsonb("context").$type<AssemblyTaskContext>().notNull(),
  state: varchar("state", { length: 30 }).notNull(),
  version: integer("version").notNull(),
  assignedTo: varchar("assigned_to").references(() => users.id, { onDelete: "restrict" }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  blockedReason: varchar("blocked_reason", { length: 1000 }),
  receivedBy: varchar("received_by").references(() => users.id, { onDelete: "restrict" }),
  receivedAt: timestamp("received_at", { withTimezone: true }),
}, (table) => [
  foreignKey({ columns: [table.claimOperationId, table.claimId], foreignColumns: [inventoryAvailabilityClaimOperations.id, inventoryAvailabilityClaimOperations.claimId] }).onDelete("restrict"),
  foreignKey({ columns: [table.warehouseId, table.stationId], foreignColumns: [workStations.warehouseId, workStations.id] }).onDelete("restrict"),
  foreignKey({ columns: [table.warehouseId, table.configurationRevision], foreignColumns: [workConfigurationRevisions.warehouseId, workConfigurationRevisions.revision] }).onDelete("restrict"),
  index("work_items_queue_idx").on(table.warehouseId, table.stationId, table.id.desc()).where(sql`${table.state} NOT IN ('completed','cancelled')`),
  index("work_items_warehouse_history_idx").on(table.warehouseId, table.id.desc()),
  index("work_items_claim_idx").on(table.claimId, table.id),
  index("work_items_employee_idx").on(table.assignedTo, table.id.desc()).where(sql`${table.state} IN ('in_progress','blocked')`),
  check("work_items_state_check", sql`${table.state} IN ('queued','in_progress','blocked','completed','cancelled')`),
  check("work_items_version_check", sql`${table.version} > 0 AND ${table.version} <= 2147483646`),
]);
export const warehouseWorkItemEvents = warehouseSchema.table("work_item_events", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  workItemId: bigint("work_item_id", { mode: "bigint" }).notNull().references(() => warehouseWorkItems.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  eventType: varchar("event_type", { length: 30 }).notNull(),
  commandKey: varchar("command_key", { length: 512 }).notNull().unique(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  actorId: varchar("actor_id", { length: 255 }).notNull(),
  reason: varchar("reason", { length: 1000 }).notNull(),
  beforeState: jsonb("before_state").$type<AssemblyTask>(),
  afterState: jsonb("after_state").$type<AssemblyTask>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (table) => [unique().on(table.workItemId, table.version)]);
