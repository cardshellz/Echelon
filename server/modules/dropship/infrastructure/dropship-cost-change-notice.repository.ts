import type { Pool } from "pg";
import { pool as defaultPool } from "../../../db";
import { costChangeEventTypeValues, type CostChangeEventType } from "../../../../shared/dropship/cost-change-policy";
import { costChangeNoticeDecisions, type CostChangeNoticeDecision } from "../domain/cost-change-notice";
import { DropshipError } from "../domain/errors";
import type {
  CostChangeNoticeDecisionRecord,
  CostChangeNoticeGroup,
  CostChangeNoticeLogRow,
  DropshipCostChangeNoticeRepository,
  VendorCostChangeLogView,
  VendorCostChangeView,
} from "../application/dropship-cost-change-notice-service";
import { costScheduleRecorders, type CostScheduleRecorder } from "../application/dropship-cost-detection-service";
import { mapCostScheduleError } from "./dropship-cost-schedule.repository";

/**
 * PG repository for cost change notices (migration 0712) and the vendor's
 * view of their cost changes. Decisions are append-only; recording ignores a
 * row already decided, so a pass replayed after a crash is safe.
 */

interface GroupRow {
  vendor_id: number;
  observed_at: Date;
  recorded_by: string;
  first_log_id: string | number;
  row_count: string | number;
}

interface LogRow {
  id: string | number;
  entry_id: string | number;
  vendor_id: number;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  product_name: string;
  event_type: string;
  from_cents: string | number | null;
  to_cents: string | number | null;
  effective_at: Date;
  observed_at: Date;
  recorded_by: string;
  policy_id: number | null;
}

interface AnnouncedRow {
  id: string | number;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  product_name: string;
  kind: string;
  from_cents: string | number | null;
  unit_cost_cents: string | number;
  effective_at: Date;
  observed_at: Date;
}

interface RecentRow extends Omit<LogRow, "vendor_id" | "recorded_by" | "policy_id" | "entry_id"> {
  notice_decision: string | null;
}

const LABEL_JOINS = `JOIN catalog.product_variants pv ON pv.id = l.product_variant_id
       JOIN catalog.products p ON p.id = pv.product_id`;

export class PgDropshipCostChangeNoticeRepository implements DropshipCostChangeNoticeRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async listUnnoticedGroups(input: { limit: number }): Promise<CostChangeNoticeGroup[]> {
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<GroupRow>(
        `SELECT l.vendor_id, l.observed_at, l.recorded_by, MIN(l.id) AS first_log_id, COUNT(*) AS row_count
         FROM dropship.dropship_cost_change_log l
         LEFT JOIN dropship.dropship_cost_change_notices n ON n.log_id = l.id
         WHERE n.log_id IS NULL
         GROUP BY l.vendor_id, l.observed_at, l.recorded_by
         ORDER BY MIN(l.id) ASC
         LIMIT $1`,
        [input.limit],
      );
      return result.rows.map((row) => ({
        vendorId: row.vendor_id,
        observedAt: row.observed_at,
        recordedBy: toRecorder(row.recorded_by),
        firstLogId: toId(row.first_log_id, "first_log_id"),
        rowCount: toCount(row.row_count, "row_count"),
      }));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async loadGroupRows(group: Pick<CostChangeNoticeGroup, "vendorId" | "observedAt" | "recordedBy">): Promise<CostChangeNoticeLogRow[]> {
    assertPositiveInteger(group.vendorId, "vendorId");
    try {
      const result = await this.dbPool.query<LogRow>(
        `SELECT l.id, l.entry_id, l.vendor_id, l.product_variant_id, pv.sku AS variant_sku, pv.name AS variant_name, p.name AS product_name,
                l.event_type, l.from_cents, l.to_cents, l.effective_at, l.observed_at, l.recorded_by, l.policy_id
         FROM dropship.dropship_cost_change_log l
         ${LABEL_JOINS}
         LEFT JOIN dropship.dropship_cost_change_notices n ON n.log_id = l.id
         WHERE l.vendor_id = $1 AND l.observed_at = $2 AND l.recorded_by = $3 AND n.log_id IS NULL
         ORDER BY l.id ASC`,
        [group.vendorId, group.observedAt, group.recordedBy],
      );
      return result.rows.map(mapLogRow);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listSentEntryIds(entryIds: readonly number[]): Promise<ReadonlySet<number>> {
    const unique = [...new Set(entryIds)];
    if (unique.length === 0) return new Set();
    for (const id of unique) assertPositiveInteger(id, "entryId");
    try {
      const result = await this.dbPool.query<{ entry_id: string | number }>(
        `SELECT DISTINCT entry_id FROM dropship.dropship_cost_change_notices
         WHERE decision = 'sent' AND entry_id = ANY($1::bigint[])`,
        [unique],
      );
      return new Set(result.rows.map((row) => toId(row.entry_id, "entry_id")));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async recordDecisions(records: readonly CostChangeNoticeDecisionRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    try {
      const result = await this.dbPool.query(
        `INSERT INTO dropship.dropship_cost_change_notices
           (log_id, vendor_id, product_variant_id, entry_id, event_type, decision, notice_kind, notice_event_type,
            idempotency_key, policy_id, decided_at, created_at)
         SELECT r.log_id, r.vendor_id, r.product_variant_id, r.entry_id, r.event_type, r.decision, r.notice_kind,
                r.notice_event_type, r.idempotency_key, r.policy_id, r.decided_at, r.decided_at
         FROM unnest($1::bigint[], $2::int[], $3::int[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::text[],
                     $9::text[], $10::int[], $11::timestamptz[])
           AS r(log_id, vendor_id, product_variant_id, entry_id, event_type, decision, notice_kind, notice_event_type,
                idempotency_key, policy_id, decided_at)
         ON CONFLICT (log_id) DO NOTHING`,
        [
          records.map((record) => record.logId),
          records.map((record) => record.vendorId),
          records.map((record) => record.productVariantId),
          records.map((record) => record.entryId),
          records.map((record) => record.eventType),
          records.map((record) => record.decision),
          records.map((record) => record.noticeKind),
          records.map((record) => record.noticeEventType),
          records.map((record) => record.idempotencyKey),
          records.map((record) => record.policyId),
          records.map((record) => record.decidedAt),
        ],
      );
      return result.rowCount ?? 0;
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listVendorAnnouncedChanges(input: { vendorId: number; now: Date; limit: number }): Promise<VendorCostChangeView[]> {
    assertPositiveInteger(input.vendorId, "vendorId");
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<AnnouncedRow>(
        `SELECT e.id, e.product_variant_id, pv.sku AS variant_sku, pv.name AS variant_name, p.name AS product_name,
                e.kind, e.from_cents, e.unit_cost_cents, e.effective_at, e.observed_at
         FROM dropship.dropship_cost_schedule_entries e
         JOIN catalog.product_variants pv ON pv.id = e.product_variant_id
         JOIN catalog.products p ON p.id = pv.product_id
         WHERE e.vendor_id = $1 AND e.withdrawn_at IS NULL AND e.effective_at > $2 AND e.kind IN ('increase', 'decrease')
         ORDER BY e.effective_at ASC, e.id ASC
         LIMIT $3`,
        [input.vendorId, input.now, input.limit],
      );
      return result.rows.map((row) => ({
        entryId: toId(row.id, "entry id"),
        productVariantId: row.product_variant_id,
        variantSku: row.variant_sku,
        variantName: row.variant_name,
        productName: row.product_name,
        kind: toChangeKind(row.kind),
        fromCents: toCents(row.from_cents ?? Number.NaN, "from_cents"),
        unitCostCents: toCents(row.unit_cost_cents, "unit_cost_cents"),
        effectiveAt: row.effective_at,
        announcedAt: row.observed_at,
      }));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listVendorRecentChanges(input: { vendorId: number; since: Date; limit: number }): Promise<VendorCostChangeLogView[]> {
    assertPositiveInteger(input.vendorId, "vendorId");
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<RecentRow>(
        `SELECT l.id, l.product_variant_id, pv.sku AS variant_sku, pv.name AS variant_name, p.name AS product_name,
                l.event_type, l.from_cents, l.to_cents, l.effective_at, l.observed_at, n.decision AS notice_decision
         FROM dropship.dropship_cost_change_log l
         ${LABEL_JOINS}
         LEFT JOIN dropship.dropship_cost_change_notices n ON n.log_id = l.id
         WHERE l.vendor_id = $1 AND l.observed_at >= $2 AND l.event_type <> 'baseline'
         ORDER BY l.id DESC
         LIMIT $3`,
        [input.vendorId, input.since, input.limit],
      );
      return result.rows.map((row) => ({
        logId: toId(row.id, "log id"),
        productVariantId: row.product_variant_id,
        variantSku: row.variant_sku,
        variantName: row.variant_name,
        productName: row.product_name,
        eventType: toEventType(row.event_type),
        fromCents: row.from_cents === null ? null : toCents(row.from_cents, "from_cents"),
        toCents: row.to_cents === null ? null : toCents(row.to_cents, "to_cents"),
        effectiveAt: row.effective_at,
        observedAt: row.observed_at,
        noticeDecision: row.notice_decision === null ? null : toDecision(row.notice_decision),
      }));
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }
}

function mapLogRow(row: LogRow): CostChangeNoticeLogRow {
  return {
    logId: toId(row.id, "log id"),
    entryId: toId(row.entry_id, "entry id"),
    vendorId: row.vendor_id,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    productName: row.product_name,
    eventType: toEventType(row.event_type),
    fromCents: row.from_cents === null ? null : toCents(row.from_cents, "from_cents"),
    toCents: row.to_cents === null ? null : toCents(row.to_cents, "to_cents"),
    effectiveAt: row.effective_at,
    observedAt: row.observed_at,
    recordedBy: toRecorder(row.recorded_by),
    policyId: row.policy_id,
  };
}

function toEventType(value: string): CostChangeEventType {
  if ((costChangeEventTypeValues as readonly string[]).includes(value)) return value as CostChangeEventType;
  throw invalidStoredValue("event_type", value);
}

function toDecision(value: string): CostChangeNoticeDecision {
  if ((costChangeNoticeDecisions as readonly string[]).includes(value)) return value as CostChangeNoticeDecision;
  throw invalidStoredValue("decision", value);
}

function toRecorder(value: string): CostScheduleRecorder {
  if ((costScheduleRecorders as readonly string[]).includes(value)) return value as CostScheduleRecorder;
  throw invalidStoredValue("recorded_by", value);
}

function toChangeKind(value: string): "increase" | "decrease" {
  if (value === "increase" || value === "decrease") return value;
  throw invalidStoredValue("kind", value);
}

/** bigint columns arrive as strings; anything that is not a whole number of cents is refused, never coerced. */
function toCents(value: string | number, column: string): number {
  const cents = typeof value === "number" ? value : /^-?\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(cents) || cents < 0) throw invalidStoredValue(column, value);
  return cents;
}

function toId(value: string | number, name: string): number {
  const id = toCents(value, name);
  if (id <= 0) throw invalidStoredValue(name, value);
  return id;
}

function toCount(value: string | number, column: string): number {
  return toCents(value, column);
}

function invalidStoredValue(column: string, value: unknown): DropshipError {
  return new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE", "A stored cost change notice value failed its contract.",
    { classification: "fatal", column, value: String(value) });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_INPUT", `${name} must be a positive integer.`,
      { classification: "permanent", [name]: value });
  }
}
