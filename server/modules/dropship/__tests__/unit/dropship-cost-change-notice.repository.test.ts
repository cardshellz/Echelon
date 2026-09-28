import type { Pool, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgDropshipCostChangeNoticeRepository } from "../../infrastructure/dropship-cost-change-notice.repository";

const NOW = new Date("2026-09-28T16:05:00.000Z");
const READING = new Date("2026-09-28T16:00:00.000Z");
const IN_TWO_WEEKS = new Date("2026-10-13T00:00:00.000Z");

interface Call { sql: string; values: unknown[] | undefined }

function fakePool(answers: Array<QueryResult<QueryResultRow> | Error> = []) {
  const calls: Call[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
    const next = answers.shift();
    if (next === undefined) return result([]);
    if (next instanceof Error) throw next;
    return next;
  });
  return { pool: { query } as unknown as Pool, calls };
}

function result<T extends QueryResultRow>(rows: T[], rowCount = rows.length): QueryResult<T> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

function logRow(patch: Record<string, unknown> = {}) {
  return {
    id: "31", entry_id: "11", vendor_id: 5, product_variant_id: 66, variant_sku: "ARM-ENV-SGL-P50", variant_name: "Single pack",
    product_name: "Armor Envelope", event_type: "increase_announced", from_cents: "809", to_cents: "999", effective_at: IN_TWO_WEEKS,
    observed_at: READING, recorded_by: "detection", policy_id: 3, ...patch,
  };
}

describe("PgDropshipCostChangeNoticeRepository", () => {
  it("lists undecided readings oldest first, bounded", async () => {
    const { pool, calls } = fakePool([result([{ vendor_id: 5, observed_at: READING, recorded_by: "detection", first_log_id: "31", row_count: "4" }])]);
    const groups = await new PgDropshipCostChangeNoticeRepository(pool).listUnnoticedGroups({ limit: 20 });
    expect(calls[0]?.sql).toContain("LEFT JOIN dropship.dropship_cost_change_notices n ON n.log_id = l.id WHERE n.log_id IS NULL");
    expect(calls[0]?.sql).toContain("GROUP BY l.vendor_id, l.observed_at, l.recorded_by ORDER BY MIN(l.id) ASC LIMIT $1");
    expect(calls[0]?.values).toEqual([20]);
    expect(groups).toEqual([{ vendorId: 5, observedAt: READING, recordedBy: "detection", firstLogId: 31, rowCount: 4 }]);
  });

  it("loads a reading's undecided rows with their labels, in log order", async () => {
    const { pool, calls } = fakePool([result([logRow()])]);
    const rows = await new PgDropshipCostChangeNoticeRepository(pool).loadGroupRows({ vendorId: 5, observedAt: READING, recordedBy: "detection" });
    expect(calls[0]?.sql).toContain("WHERE l.vendor_id = $1 AND l.observed_at = $2 AND l.recorded_by = $3 AND n.log_id IS NULL ORDER BY l.id ASC");
    expect(calls[0]?.values).toEqual([5, READING, "detection"]);
    expect(rows).toEqual([{
      logId: 31, entryId: 11, vendorId: 5, productVariantId: 66, variantSku: "ARM-ENV-SGL-P50", variantName: "Single pack",
      productName: "Armor Envelope", eventType: "increase_announced", fromCents: 809, toCents: 999, effectiveAt: IN_TWO_WEEKS,
      observedAt: READING, recordedBy: "detection", policyId: 3,
    }]);
  });

  it("finds which entries had their announcement sent, without querying for none", async () => {
    const { pool, calls } = fakePool([result([{ entry_id: "11" }])]);
    const repository = new PgDropshipCostChangeNoticeRepository(pool);
    expect(await repository.listSentEntryIds([])).toEqual(new Set());
    expect(calls).toEqual([]);
    expect(await repository.listSentEntryIds([11, 12, 11])).toEqual(new Set([11]));
    expect(calls[0]?.sql).toContain("WHERE decision = 'sent' AND entry_id = ANY($1::bigint[])");
    expect(calls[0]?.values).toEqual([[11, 12]]);
  });

  it("records every decision in one statement and ignores rows already decided", async () => {
    const { pool, calls } = fakePool([result([], 2)]);
    const written = await new PgDropshipCostChangeNoticeRepository(pool).recordDecisions([
      { logId: 31, vendorId: 5, productVariantId: 66, entryId: 11, eventType: "increase_announced", decision: "sent", noticeKind: "announced",
        noticeEventType: "dropship_cost_change_announced", idempotencyKey: "dropship-cost-change:5:announced:detection:x", policyId: 3, decidedAt: NOW },
      { logId: 32, vendorId: 5, productVariantId: 67, entryId: 12, eventType: "baseline", decision: "skipped_baseline", noticeKind: null,
        noticeEventType: null, idempotencyKey: null, policyId: 3, decidedAt: NOW },
      { logId: 33, vendorId: 5, productVariantId: 68, entryId: 13, eventType: "increase_announced", decision: "skipped_below_minimum", noticeKind: null,
        noticeEventType: null, idempotencyKey: null, policyId: null, decidedAt: NOW },
    ]);
    expect(written).toBe(2);
    expect(calls[0]?.sql).toContain("INSERT INTO dropship.dropship_cost_change_notices");
    expect(calls[0]?.sql).toContain("ON CONFLICT (log_id) DO NOTHING");
    expect(calls[0]?.values).toEqual([
      [31, 32, 33], [5, 5, 5], [66, 67, 68], [11, 12, 13],
      ["increase_announced", "baseline", "increase_announced"],
      ["sent", "skipped_baseline", "skipped_below_minimum"],
      ["announced", null, null],
      ["dropship_cost_change_announced", null, null],
      ["dropship-cost-change:5:announced:detection:x", null, null],
      [3, 3, null],
      [NOW, NOW, NOW],
    ]);
    expect(await new PgDropshipCostChangeNoticeRepository(fakePool().pool).recordDecisions([])).toBe(0);
  });

  it("serves a vendor's announced changes and recent log with notice decisions", async () => {
    const { pool, calls } = fakePool([
      result([{ id: "11", product_variant_id: 66, variant_sku: "SKU", variant_name: "Pack", product_name: "Armor", kind: "increase",
        from_cents: "809", unit_cost_cents: "999", effective_at: IN_TWO_WEEKS, observed_at: READING }]),
      result([{ ...logRow(), notice_decision: "sent" }, { ...logRow({ id: "30", event_type: "decrease_applied", to_cents: "699" }), notice_decision: null }]),
    ]);
    const repository = new PgDropshipCostChangeNoticeRepository(pool);
    const announced = await repository.listVendorAnnouncedChanges({ vendorId: 5, now: NOW, limit: 200 });
    expect(calls[0]?.sql).toContain("WHERE e.vendor_id = $1 AND e.withdrawn_at IS NULL AND e.effective_at > $2 AND e.kind IN ('increase', 'decrease')");
    expect(calls[0]?.values).toEqual([5, NOW, 200]);
    expect(announced).toEqual([{ entryId: 11, productVariantId: 66, variantSku: "SKU", variantName: "Pack", productName: "Armor", kind: "increase",
      fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS, announcedAt: READING }]);
    const since = new Date("2026-08-29T16:05:00.000Z");
    const recent = await repository.listVendorRecentChanges({ vendorId: 5, since, limit: 200 });
    expect(calls[1]?.sql).toContain("WHERE l.vendor_id = $1 AND l.observed_at >= $2 AND l.event_type <> 'baseline' ORDER BY l.id DESC LIMIT $3");
    expect(calls[1]?.values).toEqual([5, since, 200]);
    expect(recent.map((row) => [row.logId, row.eventType, row.toCents, row.noticeDecision])).toEqual([[31, "increase_announced", 999, "sent"], [30, "decrease_applied", 699, null]]);
  });

  it("refuses bad inputs before querying and classifies a missing table", async () => {
    const { pool, calls } = fakePool([Object.assign(new Error("relation does not exist"), { code: "42P01" })]);
    const repository = new PgDropshipCostChangeNoticeRepository(pool);
    await expect(repository.listUnnoticedGroups({ limit: 0 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_INPUT" });
    await expect(repository.listVendorAnnouncedChanges({ vendorId: -1, now: NOW, limit: 10 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_INPUT" });
    expect(calls).toEqual([]);
    await expect(repository.listUnnoticedGroups({ limit: 5 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_TABLE_MISSING", context: { classification: "transient" } });
  });

  it("refuses a stored decision, recorder or amount it cannot trust", async () => {
    const bad = new PgDropshipCostChangeNoticeRepository(fakePool([result([{ ...logRow({ recorded_by: "someone" }) }])]).pool);
    await expect(bad.loadGroupRows({ vendorId: 5, observedAt: READING, recordedBy: "detection" })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" });
    const badDecision = new PgDropshipCostChangeNoticeRepository(fakePool([result([{ ...logRow(), notice_decision: "maybe" }])]).pool);
    await expect(badDecision.listVendorRecentChanges({ vendorId: 5, since: NOW, limit: 10 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" });
    const badCents = new PgDropshipCostChangeNoticeRepository(fakePool([result([{ ...logRow({ to_cents: "9.99" }) }])]).pool);
    await expect(badCents.loadGroupRows({ vendorId: 5, observedAt: READING, recordedBy: "detection" })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" });
  });
});
