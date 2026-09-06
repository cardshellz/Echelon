import { pgSchema, integer, varchar, uuid, jsonb, boolean, timestamp, primaryKey, unique, foreignKey } from "drizzle-orm/pg-core";
import { warehouses, warehouseLocations } from "./warehouse.schema";
import { users } from "./identity.schema";
import type { WorkConfiguration, SaveWorkConfiguration, WorkAccess, WorkCapability } from "../warehouse-work";

const warehouseWorkSchema = pgSchema("warehouse");
export const workConfigurationRevisions = warehouseWorkSchema.table("work_configuration_revisions", {
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  revision: integer("revision").notNull(),
  commandId: uuid("command_id").notNull(),
  requestBody: jsonb("request_body").$type<SaveWorkConfiguration>().notNull(),
  configuration: jsonb("configuration").$type<WorkConfiguration>().notNull(),
  beforeConfiguration: jsonb("before_configuration").$type<WorkConfiguration>().notNull(),
  accessChanged: boolean("access_changed").notNull(),
  actorId: varchar("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  reason: varchar("reason", { length: 500 }).notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.warehouseId, table.revision] }), unique().on(table.warehouseId, table.commandId)]);

export const workStations = warehouseWorkSchema.table("work_stations", {
  id: uuid("id").primaryKey(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  code: varchar("code", { length: 30 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  locationId: integer("location_id").notNull().references(() => warehouseLocations.id, { onDelete: "restrict" }),
  capabilities: jsonb("capabilities").$type<WorkCapability[]>().notNull(),
  enabled: boolean("enabled").notNull(),
  configurationRevision: integer("configuration_revision").notNull(),
}, (table) => [
  unique().on(table.warehouseId, table.id), unique().on(table.warehouseId, table.code),
  foreignKey({ columns: [table.warehouseId, table.configurationRevision], foreignColumns: [workConfigurationRevisions.warehouseId, workConfigurationRevisions.revision] }),
]);

export const workAccessScopes = warehouseWorkSchema.table("work_access_scopes", {
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  capabilities: jsonb("capabilities").$type<WorkCapability[]>().notNull(),
  scope: jsonb("scope").$type<WorkAccess["scope"]>().notNull(),
  configurationRevision: integer("configuration_revision").notNull(),
}, (table) => [
  primaryKey({ columns: [table.warehouseId, table.userId] }),
  foreignKey({ columns: [table.warehouseId, table.configurationRevision], foreignColumns: [workConfigurationRevisions.warehouseId, workConfigurationRevisions.revision] }),
]);
