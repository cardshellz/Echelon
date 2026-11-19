import { sql, type SQL } from "drizzle-orm";

/**
 * Catch-up parking's operations health (Channels PR5, PLAN-CH-v3 section 6 Ops Health): read-only SQL that OMS
 * operations health embeds (published through server/modules/inventory-planning/quantity-catchup-health.ts), the same
 * shape as stock-link-health.sql.ts. Dependency-free on purpose (drizzle `sql` only): a read-only caller must not load
 * the catch-up worker or its pool. Only pending rows count; a completed or settled row has nothing left to wait for.
 */
export interface QuantityCatchupHealthCheck {
  code: string;
  severity: "critical" | "warning" | "info";
  message: string;
  countSql: SQL;
  sampleSql: SQL;
}

const SAMPLE_LIMIT = 10;
/** A stock update waiting for a link this long is raised (plan: "warning after 1 h"). */
export const QUANTITY_CATCHUP_HEALTH_PARKED_HOURS = 1;

const SAMPLE_COLUMNS = `c.id::text AS catchup_id, c.scope->>'providerKey' AS provider_key, c.scope->>'connectionId' AS connection_id,
  c.scope->>'externalScopeId' AS external_scope_id, c.scope->>'externalInventoryItemId' AS external_inventory_item_id,
  c.scope->>'productVariantId' AS product_variant_id, c.failure_class, c.last_error_code, c.attempt_count,
  c.parked_at, c.requires_review_at, c.next_attempt_at`;

function clockText(now: Date | undefined): string {
  if (now === undefined) return "now()";
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("A catch-up health clock must be a valid Date.");
  return `'${now.toISOString()}'::timestamptz`;
}

function issue(where: string, order: string): Pick<QuantityCatchupHealthCheck, "countSql" | "sampleSql"> {
  const rows = `FROM inventory.quantity_publication_catchup c WHERE c.completed_revision < c.revision AND (${where})`;
  return {
    countSql: sql.raw(`SELECT COUNT(*)::int AS count ${rows}`),
    sampleSql: sql.raw(`SELECT ${SAMPLE_COLUMNS} ${rows} ORDER BY ${order}, c.id LIMIT ${SAMPLE_LIMIT}`),
  };
}

/** The checks, compared with `now` (default: the database clock; a test injects its clock). */
export function quantityCatchupHealthChecks(options: { now?: Date } = {}): readonly QuantityCatchupHealthCheck[] {
  const now = clockText(options.now);
  return Object.freeze([
    {
      code: "QUANTITY_CATCHUP_PARKED",
      severity: "warning",
      // PROPOSED: owner wording
      message: "Some stock updates are waiting for a stock link to their store item. They resume automatically once the size is linked.",
      ...issue(`c.failure_class = 'parked' AND c.parked_at < ${now} - interval '${QUANTITY_CATCHUP_HEALTH_PARKED_HOURS} hours'`, "c.parked_at"),
    },
    {
      code: "QUANTITY_CATCHUP_REVIEW_REQUIRED",
      severity: "critical",
      // PROPOSED: owner wording
      message: "Some stock updates failed for good and were stopped. Review them; a newer stock change for the item tries again.",
      ...issue("c.requires_review_at IS NOT NULL", "c.requires_review_at"),
    },
  ] satisfies QuantityCatchupHealthCheck[]);
}

/** The checks against the database clock. */
export const QUANTITY_CATCHUP_HEALTH_CHECKS: readonly QuantityCatchupHealthCheck[] = quantityCatchupHealthChecks();
