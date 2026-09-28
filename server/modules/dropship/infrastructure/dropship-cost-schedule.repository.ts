import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  costScheduleEventType,
  costScheduleLogAmounts,
  costScheduleEventTypes,
  type CostReadingEvidence,
  type CostScheduleEventType,
  type CostScheduleOperation,
} from "../domain/cost-schedule";
import { DropshipError } from "../domain/errors";
import type { DropshipProductCost } from "../application/dropship-product-cost";
import {
  COST_TRACKED_LISTING_STATUSES,
  COST_TRACKED_VENDOR_STATUSES,
  costScheduleRecorders,
  emptyEventCounts,
  type CostDetectionVendorCounts,
  type CostScheduleEventCounts,
  type CostScheduleRecorder,
  type CostScheduleVendorTransaction,
  type CostScheduleWriteInput,
  type DropshipCostChangeLogView,
  type DropshipCostDetectionState,
  type DropshipCostScheduleChangeView,
  type DropshipCostScheduleRepository,
  type StoredCostScheduleEntry,
} from "../application/dropship-cost-detection-service";
import { rollbackQuietly } from "./dropship-admin-config-command";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";

/**
 * PG repository for the .ops cost schedule (migration 0711).
 *
 * A vendor's schedule is only ever written under the vendor's schedule lock,
 * inside one transaction with the change log rows and the pass cursor, so a
 * change is never half-recorded and no vendor is skipped or done twice.
 * Entries are immutable except for withdrawal and lowering an announced
 * increase (DB trigger); the change log is append-only (DB trigger). Money
 * columns are bigint, which pg returns as strings: every amount read back is
 * validated as a safe integer before it is trusted.
 */

/** Advisory lock namespace shared with acceptance (C3): one writer per vendor schedule. */
export const COST_SCHEDULE_VENDOR_LOCK_NAMESPACE = "dropship_cost_schedule";

const STATE_ROW_ID = 1;

interface StateRow {
  pass_number: string | number;
  pass_started_at: Date | null;
  pass_completed_at: Date | null;
  cursor_vendor_id: number | null;
  policy_id: number | null;
  pass_vendors_processed: number;
  pass_variants_read: number;
  pass_unavailable_readings: number;
  pass_changes_recorded: number;
  last_tick_at: Date | null;
}

interface EntryRow {
  id: string | number;
  product_variant_id: number;
  kind: string;
  from_cents: string | number | null;
  unit_cost_cents: string | number;
  effective_at: Date;
  observed_at: Date;
  policy_id: number | null;
  cost_source: string;
  plan_id: string;
  override_id: string | null;
  retail_price_cents: string | number | null;
  discount_bps: number | null;
  recorded_by: string;
}

interface PendingRow extends EntryRow {
  vendor_id: number;
  business_name: string | null;
  variant_sku: string | null;
  variant_name: string;
  product_name: string;
}

interface LogRow {
  id: string | number;
  entry_id: string | number;
  vendor_id: number;
  business_name: string | null;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  product_name: string;
  event_type: string;
  from_cents: string | number | null;
  to_cents: string | number | null;
  effective_at: Date;
  retail_driven: boolean;
  observed_at: Date;
  policy_id: number | null;
  cost_source: string;
  recorded_by: string;
  created_at: Date;
}

export class PgDropshipCostScheduleRepository implements DropshipCostScheduleRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async readDetectionState(): Promise<DropshipCostDetectionState> {
    try {
      const result = await this.dbPool.query<StateRow>(
        `SELECT * FROM dropship.dropship_cost_detection_state WHERE id = $1`,
        [STATE_ROW_ID],
      );
      return mapStateRow(result.rows[0]);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async startPass(input: { now: Date; policyId: number | null }): Promise<DropshipCostDetectionState> {
    try {
      const result = await this.dbPool.query<StateRow>(
        `UPDATE dropship.dropship_cost_detection_state
         SET pass_number = pass_number + 1, pass_started_at = $2, pass_completed_at = NULL, cursor_vendor_id = NULL,
             policy_id = $3, pass_vendors_processed = 0, pass_variants_read = 0, pass_unavailable_readings = 0,
             pass_changes_recorded = 0, updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [STATE_ROW_ID, input.now, input.policyId],
      );
      return mapStateRow(result.rows[0]);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async completePass(input: { now: Date }): Promise<DropshipCostDetectionState> {
    try {
      const result = await this.dbPool.query<StateRow>(
        `UPDATE dropship.dropship_cost_detection_state
         SET pass_completed_at = $2, cursor_vendor_id = NULL, updated_at = $2
         WHERE id = $1
         RETURNING *`,
        [STATE_ROW_ID, input.now],
      );
      return mapStateRow(result.rows[0]);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async recordTick(input: { now: Date }): Promise<void> {
    try {
      const result = await this.dbPool.query(
        `UPDATE dropship.dropship_cost_detection_state SET last_tick_at = $2, updated_at = $2 WHERE id = $1`,
        [STATE_ROW_ID, input.now],
      );
      if (result.rowCount !== 1) throw stateMissing();
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listVendorsAfter(input: { afterVendorId: number | null; limit: number }): Promise<number[]> {
    assertPositiveInteger(input.limit, "limit");
    if (input.afterVendorId !== null) assertPositiveInteger(input.afterVendorId, "afterVendorId");
    try {
      const result = await this.dbPool.query<{ id: number }>(
        `SELECT id FROM dropship.dropship_vendors
         WHERE status = ANY($1::text[]) AND ($2::integer IS NULL OR id > $2)
         ORDER BY id ASC
         LIMIT $3`,
        [COST_TRACKED_VENDOR_STATUSES, input.afterVendorId, input.limit],
      );
      return result.rows.map((row) => row.id);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async withVendorSchedule<T>(vendorId: number, work: (transaction: CostScheduleVendorTransaction) => Promise<T>): Promise<T> {
    assertPositiveInteger(vendorId, "vendorId");
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), $2::integer)", [COST_SCHEDULE_VENDOR_LOCK_NAMESPACE, vendorId]);
      const result = await work(new VendorScheduleTransaction(client, vendorId));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw mapCostScheduleError(error);
    } finally {
      client.release();
    }
  }

  async listPendingChanges(input: { now: Date; limit: number }): Promise<DropshipCostScheduleChangeView[]> {
    assertPositiveInteger(input.limit, "limit");
    try {
      const result = await this.dbPool.query<PendingRow>(
        `SELECT e.id, e.vendor_id, v.business_name, e.product_variant_id, pv.sku AS variant_sku, pv.name AS variant_name,
                p.name AS product_name, e.kind, e.from_cents, e.unit_cost_cents, e.effective_at, e.observed_at,
                e.policy_id, e.cost_source, e.plan_id, e.override_id, e.retail_price_cents, e.discount_bps, e.recorded_by
         FROM dropship.dropship_cost_schedule_entries e
         JOIN dropship.dropship_vendors v ON v.id = e.vendor_id
         JOIN catalog.product_variants pv ON pv.id = e.product_variant_id
         JOIN catalog.products p ON p.id = pv.product_id
         WHERE e.withdrawn_at IS NULL AND e.effective_at > $1
         ORDER BY e.effective_at ASC, e.id ASC
         LIMIT $2`,
        [input.now, input.limit],
      );
      return result.rows.map(mapPendingRow);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }

  async listChangeLog(input: { limit: number; beforeId: number | null }): Promise<DropshipCostChangeLogView[]> {
    assertPositiveInteger(input.limit, "limit");
    if (input.beforeId !== null) assertPositiveInteger(input.beforeId, "beforeId");
    try {
      const result = await this.dbPool.query<LogRow>(
        `SELECT l.id, l.entry_id, l.vendor_id, v.business_name, l.product_variant_id, pv.sku AS variant_sku,
                pv.name AS variant_name, p.name AS product_name, l.event_type, l.from_cents, l.to_cents, l.effective_at,
                l.retail_driven, l.observed_at, l.policy_id, l.cost_source, l.recorded_by, l.created_at
         FROM dropship.dropship_cost_change_log l
         JOIN dropship.dropship_vendors v ON v.id = l.vendor_id
         JOIN catalog.product_variants pv ON pv.id = l.product_variant_id
         JOIN catalog.products p ON p.id = pv.product_id
         WHERE ($1::bigint IS NULL OR l.id < $1)
         ORDER BY l.id DESC
         LIMIT $2`,
        [input.beforeId, input.limit],
      );
      return result.rows.map(mapLogRow);
    } catch (error) {
      throw mapCostScheduleError(error);
    }
  }
}

class VendorScheduleTransaction implements CostScheduleVendorTransaction {
  constructor(private readonly client: PoolClient, private readonly vendorId: number) {}

  async listTrackedVariantIds(): Promise<number[]> {
    const result = await this.client.query<{ product_variant_id: number }>(
      `SELECT DISTINCT product_variant_id
       FROM dropship.dropship_vendor_listings
       WHERE vendor_id = $1 AND status = ANY($2::text[])
       ORDER BY product_variant_id ASC`,
      [this.vendorId, COST_TRACKED_LISTING_STATUSES],
    );
    return result.rows.map((row) => row.product_variant_id);
  }

  async loadEntries(productVariantIds: readonly number[]): Promise<ReadonlyMap<number, StoredCostScheduleEntry[]>> {
    const entries = new Map<number, StoredCostScheduleEntry[]>();
    if (productVariantIds.length === 0) return entries;
    const result = await this.client.query<EntryRow>(
      `SELECT id, product_variant_id, kind, from_cents, unit_cost_cents, effective_at, observed_at, policy_id,
              cost_source, plan_id, override_id, retail_price_cents, discount_bps, recorded_by
       FROM dropship.dropship_cost_schedule_entries
       WHERE vendor_id = $1 AND withdrawn_at IS NULL AND product_variant_id = ANY($2::int[])
       ORDER BY effective_at ASC, id ASC`,
      [this.vendorId, [...productVariantIds]],
    );
    for (const row of result.rows) {
      const entry = mapEntryRow(row);
      const list = entries.get(row.product_variant_id);
      if (list) list.push(entry);
      else entries.set(row.product_variant_id, [entry]);
    }
    return entries;
  }

  async readLiveCosts(productVariantIds: readonly number[]): Promise<ReadonlyMap<number, DropshipProductCost>> {
    return PgShellzClubProductCostAdapter.forTransaction(this.client)
      .loadProductCosts({ vendorId: this.vendorId, productVariantIds });
  }

  async writeReconciliation(input: CostScheduleWriteInput): Promise<CostScheduleEventCounts> {
    if (input.vendorId !== this.vendorId) {
      throw new DropshipError("DROPSHIP_COST_SCHEDULE_VENDOR_MISMATCH", "A cost schedule write named a different vendor than its transaction.",
        { classification: "permanent", vendorId: input.vendorId, transactionVendorId: this.vendorId });
    }
    const counts = emptyEventCounts();
    const newEntryIds = await this.insertEntries(input);
    const logRows: LogInsert[] = [];
    for (const variant of input.variants) {
      for (const operation of variant.operations) {
        const eventType = costScheduleEventType(operation, input.observedAt);
        counts[eventType] += 1;
        let entryId: number;
        if (operation.kind === "baseline" || operation.kind === "add") {
          entryId = requiredEntryId(newEntryIds, variant.productVariantId);
        } else if (operation.kind === "reduce") {
          entryId = operation.entryId;
          await this.lowerAnnouncedIncrease(variant.productVariantId, operation);
        } else {
          entryId = operation.entryId;
          await this.withdrawEntry(variant.productVariantId, operation, input.observedAt);
        }
        const amounts = costScheduleLogAmounts(operation);
        logRows.push({
          productVariantId: variant.productVariantId, entryId, eventType, fromCents: amounts.fromCents, toCents: amounts.toCents,
          effectiveAt: operation.effectiveAt, retailDriven: variant.retailDriven, evidence: variant.evidence,
        });
      }
    }
    await this.insertLogRows(input, logRows);
    return counts;
  }

  async advanceCursor(input: { vendorId: number; counts: CostDetectionVendorCounts; now: Date }): Promise<void> {
    if (input.vendorId !== this.vendorId) {
      throw new DropshipError("DROPSHIP_COST_SCHEDULE_VENDOR_MISMATCH", "A cursor advance named a different vendor than its transaction.",
        { classification: "permanent", vendorId: input.vendorId, transactionVendorId: this.vendorId });
    }
    // The cursor only moves forward. A stale worker that reaches a vendor
    // already passed rolls its whole transaction back; the writes are redone
    // by whoever holds the cursor, so nothing is recorded twice.
    const result = await this.client.query(
      `UPDATE dropship.dropship_cost_detection_state
       SET cursor_vendor_id = $2,
           pass_vendors_processed = pass_vendors_processed + 1,
           pass_variants_read = pass_variants_read + $3,
           pass_unavailable_readings = pass_unavailable_readings + $4,
           pass_changes_recorded = pass_changes_recorded + $5,
           updated_at = $6
       WHERE id = $1 AND pass_started_at IS NOT NULL AND (cursor_vendor_id IS NULL OR cursor_vendor_id < $2)`,
      [STATE_ROW_ID, input.vendorId, input.counts.variantsRead, input.counts.unavailableReadings,
        input.counts.changesRecorded, input.now],
    );
    if (result.rowCount !== 1) {
      throw new DropshipError("DROPSHIP_COST_DETECTION_CURSOR_CONFLICT",
        "The detection cursor already passed this vendor; another worker owns the pass.",
        { classification: "transient", vendorId: input.vendorId });
    }
  }

  /** Every baseline and add of the write in one statement; a variant gets at most one new entry per reconciliation. */
  private async insertEntries(input: CostScheduleWriteInput): Promise<Map<number, number>> {
    const rows: EntryInsert[] = [];
    for (const variant of input.variants) {
      const adds = variant.operations.filter((operation) => operation.kind === "baseline" || operation.kind === "add");
      if (adds.length > 1) {
        throw new DropshipError("DROPSHIP_COST_SCHEDULE_WRITE_INVALID", "A reconciliation may add at most one entry per variant.",
          { classification: "permanent", productVariantId: variant.productVariantId, adds: adds.length });
      }
      const operation = adds[0];
      if (!operation) continue;
      rows.push({
        productVariantId: variant.productVariantId,
        kind: operation.kind === "baseline" ? "baseline" : operation.direction,
        fromCents: operation.kind === "baseline" ? null : operation.fromCents,
        unitCostCents: operation.unitCostCents,
        effectiveAt: operation.effectiveAt,
        evidence: variant.evidence,
      });
    }
    const ids = new Map<number, number>();
    if (rows.length === 0) return ids;
    const result = await this.client.query<{ id: string | number; product_variant_id: number }>(
      `INSERT INTO dropship.dropship_cost_schedule_entries
         (vendor_id, product_variant_id, kind, from_cents, unit_cost_cents, effective_at, observed_at, policy_id,
          cost_source, plan_id, override_id, retail_price_cents, discount_bps, recorded_by, created_at)
       SELECT $1::integer, r.product_variant_id, r.kind, r.from_cents, r.unit_cost_cents, r.effective_at, $2::timestamptz, $3::integer,
              r.cost_source, r.plan_id, r.override_id, r.retail_price_cents, r.discount_bps, $14::text, $2::timestamptz
       FROM unnest($4::int[], $5::text[], $6::bigint[], $7::bigint[], $8::timestamptz[], $9::text[], $10::text[],
                   $11::text[], $12::bigint[], $13::int[])
         AS r(product_variant_id, kind, from_cents, unit_cost_cents, effective_at, cost_source, plan_id, override_id,
              retail_price_cents, discount_bps)
       RETURNING id, product_variant_id`,
      [
        this.vendorId,
        input.observedAt,
        input.policyId,
        rows.map((row) => row.productVariantId),
        rows.map((row) => row.kind),
        rows.map((row) => row.fromCents),
        rows.map((row) => row.unitCostCents),
        rows.map((row) => row.effectiveAt),
        rows.map((row) => row.evidence.source),
        rows.map((row) => row.evidence.planId),
        rows.map((row) => row.evidence.overrideId),
        rows.map((row) => row.evidence.retailPriceCents),
        rows.map((row) => row.evidence.discountBps),
        input.recordedBy,
      ],
    );
    for (const row of result.rows) ids.set(row.product_variant_id, toId(row.id, "entry id"));
    if (ids.size !== rows.length) {
      throw new DropshipError("DROPSHIP_COST_SCHEDULE_WRITE_INVALID", "The schedule insert did not return one id per new entry.",
        { classification: "permanent", expected: rows.length, returned: ids.size });
    }
    return ids;
  }

  private async lowerAnnouncedIncrease(productVariantId: number, operation: Extract<CostScheduleOperation, { kind: "reduce" }>): Promise<void> {
    const result = await this.client.query(
      `UPDATE dropship.dropship_cost_schedule_entries
       SET unit_cost_cents = $5
       WHERE id = $1 AND vendor_id = $2 AND product_variant_id = $3 AND withdrawn_at IS NULL
         AND kind = 'increase' AND unit_cost_cents = $4`,
      [operation.entryId, this.vendorId, productVariantId, operation.fromCents, operation.unitCostCents],
    );
    if (result.rowCount !== 1) throw staleEntry(operation.entryId, productVariantId);
  }

  private async withdrawEntry(productVariantId: number, operation: Extract<CostScheduleOperation, { kind: "withdraw" }>, now: Date): Promise<void> {
    const result = await this.client.query(
      `UPDATE dropship.dropship_cost_schedule_entries
       SET withdrawn_at = $5
       WHERE id = $1 AND vendor_id = $2 AND product_variant_id = $3 AND withdrawn_at IS NULL AND unit_cost_cents = $4`,
      [operation.entryId, this.vendorId, productVariantId, operation.unitCostCents, now],
    );
    if (result.rowCount !== 1) throw staleEntry(operation.entryId, productVariantId);
  }

  private async insertLogRows(input: CostScheduleWriteInput, rows: readonly LogInsert[]): Promise<void> {
    if (rows.length === 0) return;
    const result = await this.client.query(
      `INSERT INTO dropship.dropship_cost_change_log
         (vendor_id, product_variant_id, entry_id, event_type, from_cents, to_cents, effective_at, retail_driven,
          observed_at, policy_id, cost_source, plan_id, override_id, retail_price_cents, discount_bps, recorded_by, created_at)
       SELECT $1::integer, r.product_variant_id, r.entry_id, r.event_type, r.from_cents, r.to_cents, r.effective_at, r.retail_driven,
              $2::timestamptz, $3::integer, r.cost_source, r.plan_id, r.override_id, r.retail_price_cents, r.discount_bps, $16::text,
              $2::timestamptz
       FROM unnest($4::int[], $5::bigint[], $6::text[], $7::bigint[], $8::bigint[], $9::timestamptz[], $10::boolean[],
                   $11::text[], $12::text[], $13::text[], $14::bigint[], $15::int[])
         AS r(product_variant_id, entry_id, event_type, from_cents, to_cents, effective_at, retail_driven,
              cost_source, plan_id, override_id, retail_price_cents, discount_bps)`,
      [
        this.vendorId,
        input.observedAt,
        input.policyId,
        rows.map((row) => row.productVariantId),
        rows.map((row) => row.entryId),
        rows.map((row) => row.eventType),
        rows.map((row) => row.fromCents),
        rows.map((row) => row.toCents),
        rows.map((row) => row.effectiveAt),
        rows.map((row) => row.retailDriven),
        rows.map((row) => row.evidence.source),
        rows.map((row) => row.evidence.planId),
        rows.map((row) => row.evidence.overrideId),
        rows.map((row) => row.evidence.retailPriceCents),
        rows.map((row) => row.evidence.discountBps),
        input.recordedBy,
      ],
    );
    if (result.rowCount !== rows.length) {
      throw new DropshipError("DROPSHIP_COST_SCHEDULE_WRITE_INVALID", "The change log insert did not write one row per operation.",
        { classification: "permanent", expected: rows.length, written: result.rowCount });
    }
  }
}

interface EntryInsert {
  productVariantId: number;
  kind: "baseline" | "increase" | "decrease";
  fromCents: number | null;
  unitCostCents: number;
  effectiveAt: Date;
  evidence: CostReadingEvidence;
}

interface LogInsert {
  productVariantId: number;
  entryId: number;
  eventType: CostScheduleEventType;
  fromCents: number | null;
  toCents: number | null;
  effectiveAt: Date;
  retailDriven: boolean;
  evidence: CostReadingEvidence;
}

function requiredEntryId(ids: ReadonlyMap<number, number>, productVariantId: number): number {
  const id = ids.get(productVariantId);
  if (id === undefined) {
    throw new DropshipError("DROPSHIP_COST_SCHEDULE_WRITE_INVALID", "A new entry's id was not returned for its variant.",
      { classification: "permanent", productVariantId });
  }
  return id;
}

function staleEntry(entryId: number, productVariantId: number): DropshipError {
  // The entry no longer matches what the domain reconciled against. The
  // vendor lock makes this an invariant failure, not a race: roll back and
  // let the next pass re-read.
  return new DropshipError("DROPSHIP_COST_SCHEDULE_ENTRY_STALE", "A cost schedule entry changed under its reconciliation.",
    { classification: "permanent", entryId, productVariantId });
}

function stateMissing(): DropshipError {
  return new DropshipError("DROPSHIP_COST_DETECTION_STATE_MISSING", "The cost detection state row is missing; migration 0711 seeds it.",
    { classification: "fatal" });
}

export function mapStateRow(row: StateRow | undefined): DropshipCostDetectionState {
  if (!row) throw stateMissing();
  return {
    passNumber: toCount(row.pass_number, "pass_number"),
    passStartedAt: row.pass_started_at,
    passCompletedAt: row.pass_completed_at,
    cursorVendorId: row.cursor_vendor_id,
    policyId: row.policy_id,
    passVendorsProcessed: toCount(row.pass_vendors_processed, "pass_vendors_processed"),
    passVariantsRead: toCount(row.pass_variants_read, "pass_variants_read"),
    passUnavailableReadings: toCount(row.pass_unavailable_readings, "pass_unavailable_readings"),
    passChangesRecorded: toCount(row.pass_changes_recorded, "pass_changes_recorded"),
    lastTickAt: row.last_tick_at,
  };
}

export function mapEntryRow(row: EntryRow): StoredCostScheduleEntry {
  return {
    entryId: toId(row.id, "entry id"),
    kind: toKind(row.kind),
    fromCents: row.from_cents === null ? null : toCents(row.from_cents, "from_cents"),
    unitCostCents: toCents(row.unit_cost_cents, "unit_cost_cents"),
    effectiveAt: row.effective_at,
    observedAt: row.observed_at,
    policyId: row.policy_id,
    recordedBy: toRecorder(row.recorded_by),
    evidence: {
      source: row.cost_source,
      planId: row.plan_id,
      overrideId: row.override_id,
      retailPriceCents: row.retail_price_cents === null ? null : toCents(row.retail_price_cents, "retail_price_cents"),
      discountBps: row.discount_bps,
    },
  };
}

function mapPendingRow(row: PendingRow): DropshipCostScheduleChangeView {
  const entry = mapEntryRow(row);
  return {
    entryId: entry.entryId,
    vendorId: row.vendor_id,
    vendorBusinessName: row.business_name,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    productName: row.product_name,
    kind: entry.kind,
    fromCents: entry.fromCents,
    unitCostCents: entry.unitCostCents,
    effectiveAt: entry.effectiveAt,
    observedAt: entry.observedAt,
    policyId: entry.policyId,
    costSource: entry.evidence.source,
    recordedBy: entry.recordedBy,
  };
}

function mapLogRow(row: LogRow): DropshipCostChangeLogView {
  return {
    logId: toId(row.id, "log id"),
    entryId: toId(row.entry_id, "entry id"),
    vendorId: row.vendor_id,
    vendorBusinessName: row.business_name,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    productName: row.product_name,
    eventType: toEventType(row.event_type),
    fromCents: row.from_cents === null ? null : toCents(row.from_cents, "from_cents"),
    toCents: row.to_cents === null ? null : toCents(row.to_cents, "to_cents"),
    effectiveAt: row.effective_at,
    retailDriven: row.retail_driven,
    observedAt: row.observed_at,
    policyId: row.policy_id,
    costSource: row.cost_source,
    recordedBy: toRecorder(row.recorded_by),
    createdAt: row.created_at,
  };
}

function toKind(value: string): "baseline" | "increase" | "decrease" {
  if (value === "baseline" || value === "increase" || value === "decrease") return value;
  throw invalidStoredValue("kind", value);
}

function toRecorder(value: string): CostScheduleRecorder {
  if ((costScheduleRecorders as readonly string[]).includes(value)) return value as CostScheduleRecorder;
  throw invalidStoredValue("recorded_by", value);
}

function toEventType(value: string): CostScheduleEventType {
  if ((costScheduleEventTypes as readonly string[]).includes(value)) return value as CostScheduleEventType;
  throw invalidStoredValue("event_type", value);
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
  // The table's CHECKs make this unreachable unless they were bypassed: abort and alert.
  return new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE", "A stored cost schedule value failed its contract.",
    { classification: "fatal", column, value: String(value) });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DropshipError("DROPSHIP_COST_SCHEDULE_INVALID_INPUT", `${name} must be a positive integer.`,
      { classification: "permanent", [name]: value });
  }
}

/** The PG failures this repository can provoke, as classified dropship errors. Anything else propagates untouched. */
export function mapCostScheduleError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "42P01") {
      return new DropshipError("DROPSHIP_COST_SCHEDULE_TABLE_MISSING", "Dropship cost schedule tables do not exist yet.",
        { classification: "transient", sqlState: code });
    }
    if (code === "23514" || code === "23503") {
      return new DropshipError("DROPSHIP_COST_SCHEDULE_WRITE_INVALID", "A cost schedule write violated a database invariant.",
        { classification: "permanent", sqlState: code });
    }
    if (code === "P0001") {
      return new DropshipError("DROPSHIP_COST_SCHEDULE_IMMUTABLE", "A cost schedule write was refused by the immutability guard.",
        { classification: "permanent", sqlState: code, detail: error instanceof Error ? error.message : undefined });
    }
  }
  return error;
}
