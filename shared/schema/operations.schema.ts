import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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

export const operationsSchema = pgSchema("operations");

export const controlTowerSourceRuns = operationsSchema.table("control_tower_source_runs", {
  id: varchar("id", { length: 36 }).primaryKey(),
  sourceName: varchar("source_name", { length: 120 }).notNull(),
  projectorVersion: integer("projector_version").notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  completeScan: boolean("complete_scan").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  rowsScanned: integer("rows_scanned").notNull().default(0),
  rowsCreated: integer("rows_created").notNull().default(0),
  rowsUpdated: integer("rows_updated").notNull().default(0),
  rowsResolved: integer("rows_resolved").notNull().default(0),
  rowsFailed: integer("rows_failed").notNull().default(0),
  sourceWatermark: timestamp("source_watermark", { withTimezone: true }),
  cursor: jsonb("cursor"),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_control_tower_source_runs_source_started").on(table.sourceName, table.startedAt),
]);

export const controlTowerWorkItems = operationsSchema.table("control_tower_work_items", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  sourceNamespace: varchar("source_namespace", { length: 120 }).notNull(),
  sourceType: varchar("source_type", { length: 80 }).notNull(),
  sourceKey: varchar("source_key", { length: 200 }).notNull(),
  sourceFingerprint: varchar("source_fingerprint", { length: 64 }).notNull(),
  projectionVersion: integer("projection_version").notNull(),
  domain: varchar("domain", { length: 30 }).notNull(),
  code: varchar("code", { length: 100 }).notNull(),
  entityType: varchar("entity_type", { length: 50 }).notNull(),
  entityId: varchar("entity_id", { length: 200 }).notNull(),
  entityRef: varchar("entity_ref", { length: 200 }),
  correlationId: varchar("correlation_id", { length: 200 }),
  rootCauseGroupKey: varchar("root_cause_group_key", { length: 200 }),
  title: varchar("title", { length: 200 }).notNull(),
  summary: text("summary").notNull(),
  expectedState: text("expected_state").notNull(),
  actualState: text("actual_state").notNull(),
  severity: varchar("severity", { length: 20 }).notNull(),
  urgency: varchar("urgency", { length: 20 }).notNull().default("normal"),
  impactTags: varchar("impact_tags", { length: 30 }).array().notNull().default(sql`ARRAY[]::varchar(30)[]`),
  actionability: varchar("actionability", { length: 30 }).notNull(),
  sourceStatus: varchar("source_status", { length: 30 }).notNull(),
  triageStatus: varchar("triage_status", { length: 30 }).notNull().default("needs_attention"),
  ownerTeam: varchar("owner_team", { length: 50 }),
  assignedUserId: varchar("assigned_user_id", { length: 120 }),
  assignedBy: varchar("assigned_by", { length: 120 }),
  recommendedAction: text("recommended_action").notNull(),
  responseDueAt: timestamp("response_due_at", { withTimezone: true }),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  lastChangedAt: timestamp("last_changed_at", { withTimezone: true }).notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  occurrenceCount: bigint("occurrence_count", { mode: "number" }).notNull().default(1),
  recurrenceCount: integer("recurrence_count").notNull().default(0),
  worsenedCount: integer("worsened_count").notNull().default(0),
  evidenceSummary: jsonb("evidence_summary").notNull().default({}),
  detailLocator: jsonb("detail_locator").notNull().default({}),
  availableActions: jsonb("available_actions").notNull().default([]),
  sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }).notNull(),
  lastSourceRunId: varchar("last_source_run_id", { length: 36 }).references(
    () => controlTowerSourceRuns.id,
    { onDelete: "set null" },
  ),
  rowVersion: integer("row_version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("control_tower_work_items_identity_uq").on(
    table.sourceNamespace,
    table.sourceType,
    table.sourceKey,
  ),
  index("idx_control_tower_work_items_queue").on(
    table.triageStatus,
    table.severity,
    table.responseDueAt,
    table.firstSeenAt,
    table.id,
  ),
  index("idx_control_tower_work_items_entity").on(table.entityType, table.entityId),
]);

export const controlTowerObservations = operationsSchema.table("control_tower_observations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  workItemId: bigint("work_item_id", { mode: "number" }).notNull().references(
    () => controlTowerWorkItems.id,
    { onDelete: "restrict" },
  ),
  sourceRunId: varchar("source_run_id", { length: 36 }).references(
    () => controlTowerSourceRuns.id,
    { onDelete: "set null" },
  ),
  observationKind: varchar("observation_kind", { length: 30 }).notNull(),
  priorSourceStatus: varchar("prior_source_status", { length: 30 }),
  currentSourceStatus: varchar("current_source_status", { length: 30 }),
  priorTriageStatus: varchar("prior_triage_status", { length: 30 }),
  currentTriageStatus: varchar("current_triage_status", { length: 30 }),
  changedFields: jsonb("changed_fields").notNull().default({}),
  evidenceSummary: jsonb("evidence_summary").notNull().default({}),
  observedMetric: numeric("observed_metric", { precision: 38, scale: 0 }),
  actorUserId: varchar("actor_user_id", { length: 120 }),
  note: text("note"),
  sourceObservedAt: timestamp("source_observed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_control_tower_observations_item_created").on(table.workItemId, table.createdAt),
]);

export const controlTowerActionAttempts = operationsSchema.table("control_tower_action_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  workItemId: bigint("work_item_id", { mode: "number" }).notNull().references(
    () => controlTowerWorkItems.id,
    { onDelete: "restrict" },
  ),
  actionCode: varchar("action_code", { length: 100 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 200 }).notNull().unique(),
  requestedBy: varchar("requested_by", { length: 120 }).notNull(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  requestPayload: jsonb("request_payload").notNull().default({}),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  workerId: varchar("worker_id", { length: 120 }),
  attemptCount: integer("attempt_count").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  resultSummary: jsonb("result_summary"),
  errorCode: varchar("error_code", { length: 100 }),
  errorMessage: text("error_message"),
  sourceAuditRefs: jsonb("source_audit_refs").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_control_tower_action_attempts_item").on(table.workItemId, table.requestedAt),
]);

export type ControlTowerSourceRun = typeof controlTowerSourceRuns.$inferSelect;
export type ControlTowerWorkItem = typeof controlTowerWorkItems.$inferSelect;
export type ControlTowerObservation = typeof controlTowerObservations.$inferSelect;
export type ControlTowerActionAttempt = typeof controlTowerActionAttempts.$inferSelect;
