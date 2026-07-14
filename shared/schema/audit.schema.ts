import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  level: text("level").default("AUDIT").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  changes: jsonb("changes"),
  context: jsonb("context"),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export const financialCommandResults = pgTable("financial_command_results", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  actorType: varchar("actor_type", { length: 40 }).notNull(),
  actorId: varchar("actor_id", { length: 200 }).notNull(),
  method: varchar("method", { length: 10 }).notNull(),
  routeTemplate: varchar("route_template", { length: 300 }).notNull(),
  resourceKey: varchar("resource_key", { length: 300 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  commandName: varchar("command_name", { length: 120 }).notNull(),
  contractVersion: integer("contract_version").notNull().default(1),
  status: varchar("status", { length: 20 }).notNull().default("claimed"),
  leaseToken: varchar("lease_token", { length: 100 }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(1),
  httpStatus: integer("http_status"),
  responseBody: jsonb("response_body"),
  resultType: varchar("result_type", { length: 100 }),
  resultId: varchar("result_id", { length: 200 }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: varchar("last_error_message", { length: 1000 }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => ({
  scopeUq: uniqueIndex("financial_command_results_scope_uidx").on(
    table.actorType,
    table.actorId,
    table.method,
    table.routeTemplate,
    table.resourceKey,
    table.idempotencyKey,
  ),
  claimedLeaseIdx: index("financial_command_results_claimed_lease_idx")
    .on(table.leaseExpiresAt, table.id)
    .where(sql`${table.status} = 'claimed'`),
  retryDueIdx: index("financial_command_results_retry_due_idx")
    .on(table.nextAttemptAt, table.id)
    .where(sql`${table.status} = 'retryable'`),
  expiresIdx: index("financial_command_results_expires_idx").on(table.expiresAt, table.id),
  resultIdx: index("financial_command_results_result_idx")
    .on(table.resultType, table.resultId)
    .where(sql`${table.resultType} IS NOT NULL AND ${table.resultId} IS NOT NULL`),
  actorTypeCheck: check(
    "financial_command_results_actor_type_chk",
    sql`${table.actorType} IN ('user', 'service', 'system')`,
  ),
  actorIdCheck: check(
    "financial_command_results_actor_id_chk",
    sql`${table.actorId} = btrim(${table.actorId}) AND ${table.actorId} <> ''`,
  ),
  methodCheck: check(
    "financial_command_results_method_chk",
    sql`${table.method} IN ('POST', 'PUT', 'PATCH', 'DELETE')`,
  ),
  routeTemplateCheck: check(
    "financial_command_results_route_template_chk",
    sql`${table.routeTemplate} = btrim(${table.routeTemplate})
      AND ${table.routeTemplate} LIKE '/%'
      AND position('?' IN ${table.routeTemplate}) = 0`,
  ),
  resourceKeyCheck: check(
    "financial_command_results_resource_key_chk",
    sql`${table.resourceKey} = btrim(${table.resourceKey}) AND ${table.resourceKey} <> ''`,
  ),
  idempotencyKeyCheck: check(
    "financial_command_results_idempotency_key_chk",
    sql`${table.idempotencyKey} = btrim(${table.idempotencyKey}) AND ${table.idempotencyKey} <> ''`,
  ),
  requestHashCheck: check(
    "financial_command_results_request_hash_chk",
    sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
  ),
  commandNameCheck: check(
    "financial_command_results_command_name_chk",
    sql`${table.commandName} = btrim(${table.commandName})
      AND ${table.commandName} ~ '^[a-z][a-z0-9_.:-]*$'`,
  ),
  contractVersionCheck: check(
    "financial_command_results_contract_version_chk",
    sql`${table.contractVersion} > 0`,
  ),
  statusCheck: check(
    "financial_command_results_status_chk",
    sql`${table.status} IN ('claimed', 'succeeded', 'rejected', 'retryable', 'dead')`,
  ),
  attemptCountCheck: check(
    "financial_command_results_attempt_count_chk",
    sql`${table.attemptCount} > 0`,
  ),
  resultIdentityCheck: check(
    "financial_command_results_result_identity_chk",
    sql`(${table.resultType} IS NULL AND ${table.resultId} IS NULL)
      OR (
        ${table.resultType} = btrim(${table.resultType})
        AND ${table.resultType} <> ''
        AND ${table.resultId} = btrim(${table.resultId})
        AND ${table.resultId} <> ''
      )`,
  ),
  timeOrderCheck: check(
    "financial_command_results_time_order_chk",
    sql`${table.updatedAt} >= ${table.createdAt}
      AND ${table.expiresAt} > ${table.createdAt}
      AND (${table.leaseExpiresAt} IS NULL OR (
        ${table.leaseExpiresAt} > ${table.updatedAt}
        AND ${table.leaseExpiresAt} <= ${table.expiresAt}
      ))
      AND (${table.nextAttemptAt} IS NULL OR (
        ${table.nextAttemptAt} >= ${table.updatedAt}
        AND ${table.nextAttemptAt} < ${table.expiresAt}
      ))
      AND (${table.completedAt} IS NULL OR (
        ${table.completedAt} >= ${table.createdAt}
        AND ${table.completedAt} <= ${table.updatedAt}
        AND ${table.completedAt} < ${table.expiresAt}
      ))`,
  ),
  lifecycleCheck: check(
    "financial_command_results_lifecycle_chk",
    sql`(
      ${table.status} = 'claimed'
      AND ${table.leaseToken} IS NOT NULL
      AND btrim(${table.leaseToken}) <> ''
      AND ${table.leaseExpiresAt} IS NOT NULL
      AND ${table.nextAttemptAt} IS NULL
      AND ${table.completedAt} IS NULL
      AND ${table.httpStatus} IS NULL
      AND ${table.responseBody} IS NULL
      AND ${table.resultType} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.lastErrorCode} IS NULL
      AND ${table.lastErrorMessage} IS NULL
    ) OR (
      ${table.status} = 'succeeded'
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
      AND ${table.nextAttemptAt} IS NULL
      AND ${table.completedAt} IS NOT NULL
      AND ${table.httpStatus} BETWEEN 200 AND 299
      AND ${table.responseBody} IS NOT NULL
      AND ${table.lastErrorCode} IS NULL
      AND ${table.lastErrorMessage} IS NULL
    ) OR (
      ${table.status} = 'rejected'
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
      AND ${table.nextAttemptAt} IS NULL
      AND ${table.completedAt} IS NOT NULL
      AND ${table.httpStatus} BETWEEN 400 AND 499
      AND ${table.responseBody} IS NOT NULL
      AND ${table.resultType} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.lastErrorCode} IS NOT NULL
      AND btrim(${table.lastErrorCode}) <> ''
      AND ${table.lastErrorMessage} IS NOT NULL
      AND btrim(${table.lastErrorMessage}) <> ''
    ) OR (
      ${table.status} = 'retryable'
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
      AND ${table.nextAttemptAt} IS NOT NULL
      AND ${table.completedAt} IS NULL
      AND ${table.httpStatus} IS NULL
      AND ${table.responseBody} IS NULL
      AND ${table.resultType} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.lastErrorCode} IS NOT NULL
      AND btrim(${table.lastErrorCode}) <> ''
      AND ${table.lastErrorMessage} IS NOT NULL
      AND btrim(${table.lastErrorMessage}) <> ''
    ) OR (
      ${table.status} = 'dead'
      AND ${table.leaseToken} IS NULL
      AND ${table.leaseExpiresAt} IS NULL
      AND ${table.nextAttemptAt} IS NULL
      AND ${table.completedAt} IS NOT NULL
      AND ${table.httpStatus} IS NULL
      AND ${table.responseBody} IS NULL
      AND ${table.resultType} IS NULL
      AND ${table.resultId} IS NULL
      AND ${table.lastErrorCode} IS NOT NULL
      AND btrim(${table.lastErrorCode}) <> ''
      AND ${table.lastErrorMessage} IS NOT NULL
      AND btrim(${table.lastErrorMessage}) <> ''
    )`,
  ),
}));

export type FinancialCommandResult = typeof financialCommandResults.$inferSelect;
export type InsertFinancialCommandResult = typeof financialCommandResults.$inferInsert;
