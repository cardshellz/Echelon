import { sql } from "drizzle-orm";
import { bigint, check, customType, index, integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";

const inventory = pgSchema("inventory");
const xid8 = customType<{ data: string }>({ dataType: () => "xid8" });

/** Operational invalidations only; no product inclusion or quantity authority. */
export const publicationSelectionWork = inventory.table("publication_selection_work", {
  productId: integer("product_id").primaryKey(),
  revision: bigint("revision", { mode: "bigint" }).notNull().default(BigInt(1)),
  acknowledgedRevision: bigint("acknowledged_revision", { mode: "bigint" }).notNull().default(BigInt(0)),
  lastInvalidatingXid: xid8("last_invalidating_xid").notNull().default(sql`pg_current_xact_id()`),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().default(sql`transaction_timestamp()`),
  nextBoundaryAt: timestamp("next_boundary_at", { withTimezone: true }),
  attemptCount: integer("attempt_count").notNull().default(0),
  lastErrorCode: text("last_error_code"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`transaction_timestamp()`),
}, table => [
  check("publication_selection_work_product_id_check", sql`${table.productId}>0`),
  check("publication_selection_work_revision_check", sql`${table.revision}>0`),
  check("publication_selection_work_check", sql`${table.acknowledgedRevision}>=0 AND ${table.acknowledgedRevision}<=${table.revision}`),
  check("publication_selection_work_attempt_count_check", sql`${table.attemptCount}>=0`),
  index("publication_selection_work_due").on(table.nextAttemptAt).where(sql`${table.revision}>${table.acknowledgedRevision}`),
  index("publication_selection_work_boundary").on(table.nextBoundaryAt).where(sql`${table.nextBoundaryAt} IS NOT NULL`),
]);

export const publicationSelectionAttempts = inventory.table("publication_selection_attempts", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  productId: integer("product_id").notNull(),
  revision: bigint("revision", { mode: "bigint" }).notNull(),
  outcome: text("outcome").notNull(),
  errorCode: text("error_code"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, table => [
  check("publication_selection_attempts_product_id_check", sql`${table.productId}>0`),
  check("publication_selection_attempts_revision_check", sql`${table.revision}>0`),
  check("publication_selection_attempts_outcome_check", sql`${table.outcome} IN ('planned','blocked')`),
  check("publication_selection_attempts_check", sql`(${table.outcome}='planned' AND ${table.errorCode} IS NULL) OR (${table.outcome}='blocked' AND ${table.errorCode} IS NOT NULL)`),
]);
