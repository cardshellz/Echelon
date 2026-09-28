import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import { COST_TRACKED_LISTING_STATUSES, COST_TRACKED_VENDOR_STATUSES, emptyEventCounts } from "../../application/dropship-cost-detection-service";
import {
  COST_SCHEDULE_VENDOR_LOCK_NAMESPACE,
  PgDropshipCostScheduleRepository,
  mapCostScheduleError,
  mapEntryRow,
  mapStateRow,
} from "../../infrastructure/dropship-cost-schedule.repository";

const NOW = new Date("2026-09-28T16:05:00.000Z");
const IN_TWO_WEEKS = new Date("2026-10-13T00:00:00.000Z");
const evidence = { source: "plan_percent", planId: "ops", overrideId: null, retailPriceCents: 899, discountBps: 1000 };

vi.mock("../../infrastructure/shellz-club-product-cost.adapter", () => ({
  PgShellzClubProductCostAdapter: {
    forTransaction: (client: unknown) => ({
      loadProductCosts: async (input: { vendorId: number; productVariantIds: readonly number[] }) => {
        const recorder = client as { costReads: unknown[] };
        recorder.costReads = [...(recorder.costReads ?? []), input];
        return new Map(input.productVariantIds.map((id) => [id, { status: "available", unitCostCents: 809 }]));
      },
    }),
  },
}));

interface Call { sql: string; values: unknown[] | undefined }

/** A pool whose single client records every statement and answers from a queue of results, in order. */
function fakePool(answers: Array<QueryResult<QueryResultRow> | Error> = []) {
  const calls: Call[] = [];
  const released: boolean[] = [];
  const client = {
    calls,
    costReads: [] as unknown[],
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim()) || sql.includes("pg_advisory_xact_lock")) return result([]);
      const next = answers.shift();
      if (next === undefined) return result([]);
      if (next instanceof Error) throw next;
      return next;
    }),
    release: vi.fn((discard?: boolean) => { released.push(Boolean(discard)); }),
  };
  const pool = {
    query: client.query,
    connect: vi.fn(async () => client as unknown as PoolClient),
  } as unknown as Pool;
  return { pool, client, calls, released };
}

function result<T extends QueryResultRow>(rows: T[], rowCount = rows.length): QueryResult<T> {
  return { rows, rowCount, command: "", oid: 0, fields: [] };
}

function stateRow(patch: Record<string, unknown> = {}) {
  return {
    pass_number: "3", pass_started_at: NOW, pass_completed_at: null, cursor_vendor_id: 5, policy_id: 3,
    pass_vendors_processed: 2, pass_variants_read: 40, pass_unavailable_readings: 1, pass_changes_recorded: 4,
    last_tick_at: NOW, ...patch,
  };
}

function entryRow(patch: Record<string, unknown> = {}) {
  return {
    id: "11", product_variant_id: 66, kind: "increase", from_cents: "809", unit_cost_cents: "999", effective_at: IN_TWO_WEEKS,
    observed_at: NOW, policy_id: 3, cost_source: "plan_percent", plan_id: "ops", override_id: null,
    retail_price_cents: "899", discount_bps: 1000, recorded_by: "detection", ...patch,
  };
}

describe("PgDropshipCostScheduleRepository", () => {
  describe("detection state", () => {
    it("reads the singleton row into validated numbers", async () => {
      const { pool, calls } = fakePool([result([stateRow()])]);
      const state = await new PgDropshipCostScheduleRepository(pool).readDetectionState();
      expect(calls[0]?.values).toEqual([1]);
      expect(state).toEqual({
        passNumber: 3, passStartedAt: NOW, passCompletedAt: null, cursorVendorId: 5, policyId: 3,
        passVendorsProcessed: 2, passVariantsRead: 40, passUnavailableReadings: 1, passChangesRecorded: 4, lastTickAt: NOW,
      });
    });

    it("treats a missing state row as fatal and a missing table as transient", async () => {
      await expect(new PgDropshipCostScheduleRepository(fakePool([result([])]).pool).readDetectionState())
        .rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_STATE_MISSING", context: { classification: "fatal" } });
      const missing = Object.assign(new Error("relation does not exist"), { code: "42P01" });
      await expect(new PgDropshipCostScheduleRepository(fakePool([missing]).pool).readDetectionState())
        .rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_TABLE_MISSING", context: { classification: "transient" } });
    });

    it("starts a pass by advancing the number, clearing the cursor and counters, and stamping the policy", async () => {
      const { pool, calls } = fakePool([result([stateRow({ pass_number: 4, cursor_vendor_id: null, pass_vendors_processed: 0 })])]);
      const state = await new PgDropshipCostScheduleRepository(pool).startPass({ now: NOW, policyId: 3 });
      expect(calls[0]?.sql).toContain("SET pass_number = pass_number + 1, pass_started_at = $2, pass_completed_at = NULL, cursor_vendor_id = NULL");
      expect(calls[0]?.sql).toContain("pass_vendors_processed = 0, pass_variants_read = 0, pass_unavailable_readings = 0");
      expect(calls[0]?.values).toEqual([1, NOW, 3]);
      expect(state).toMatchObject({ passNumber: 4, cursorVendorId: null, passVendorsProcessed: 0 });
    });

    it("completes a pass and records ticks, refusing a tick that found no row", async () => {
      const { pool, calls } = fakePool([result([stateRow({ pass_completed_at: NOW, cursor_vendor_id: null })]), result([], 1), result([], 0)]);
      const repository = new PgDropshipCostScheduleRepository(pool);
      expect(await repository.completePass({ now: NOW })).toMatchObject({ passCompletedAt: NOW, cursorVendorId: null });
      expect(calls[0]?.sql).toContain("SET pass_completed_at = $2, cursor_vendor_id = NULL");
      await repository.recordTick({ now: NOW });
      expect(calls[1]?.sql).toContain("SET last_tick_at = $2");
      await expect(repository.recordTick({ now: NOW })).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_STATE_MISSING" });
    });

    it("refuses a stored counter that is not a whole number", () => {
      expect(() => mapStateRow(stateRow({ pass_number: "3.5" }) as never))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
      expect(() => mapStateRow(stateRow({ pass_variants_read: -1 }) as never))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
    });
  });

  describe("listVendorsAfter", () => {
    it("walks watched vendors in id order after the cursor, bounded", async () => {
      const { pool, calls } = fakePool([result([{ id: 6 }, { id: 9 }])]);
      const ids = await new PgDropshipCostScheduleRepository(pool).listVendorsAfter({ afterVendorId: 5, limit: 2 });
      expect(ids).toEqual([6, 9]);
      expect(calls[0]?.sql).toContain("WHERE status = ANY($1::text[]) AND ($2::integer IS NULL OR id > $2) ORDER BY id ASC LIMIT $3");
      expect(calls[0]?.values).toEqual([COST_TRACKED_VENDOR_STATUSES, 5, 2]);
      expect(COST_TRACKED_VENDOR_STATUSES).toEqual(["active", "paused"]);
    });

    it("refuses a bad limit or cursor without querying", async () => {
      const { pool, calls } = fakePool();
      const repository = new PgDropshipCostScheduleRepository(pool);
      await expect(repository.listVendorsAfter({ afterVendorId: null, limit: 0 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_INPUT" });
      await expect(repository.listVendorsAfter({ afterVendorId: -1, limit: 5 })).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_INPUT" });
      expect(calls).toEqual([]);
    });
  });

  describe("withVendorSchedule", () => {
    it("holds the vendor's schedule lock for the whole transaction and commits the work", async () => {
      const { pool, calls, released, client } = fakePool([
        result([{ product_variant_id: 66 }, { product_variant_id: 67 }]),
        result([entryRow(), entryRow({ id: "10", kind: "baseline", from_cents: null, unit_cost_cents: "809", effective_at: new Date("2026-09-01T00:00:00.000Z") })]),
      ]);
      const repository = new PgDropshipCostScheduleRepository(pool);

      const outcome = await repository.withVendorSchedule(5, async (transaction) => {
        const variantIds = await transaction.listTrackedVariantIds();
        const entries = await transaction.loadEntries(variantIds);
        const costs = await transaction.readLiveCosts(variantIds);
        return { variantIds, entries, costs };
      });

      expect(calls.map((call) => call.sql.slice(0, 30))).toEqual([
        "BEGIN",
        "SELECT pg_advisory_xact_lock(h",
        "SELECT DISTINCT product_varian",
        "SELECT id, product_variant_id,",
        "COMMIT",
      ]);
      expect(calls[1]?.values).toEqual([COST_SCHEDULE_VENDOR_LOCK_NAMESPACE, 5]);
      expect(calls[2]?.values).toEqual([5, COST_TRACKED_LISTING_STATUSES]);
      expect(COST_TRACKED_LISTING_STATUSES).not.toContain("not_listed");
      expect(COST_TRACKED_LISTING_STATUSES).not.toContain("ended");
      expect(calls[3]?.sql).toContain("WHERE vendor_id = $1 AND withdrawn_at IS NULL AND product_variant_id = ANY($2::int[])");
      expect(calls[3]?.values).toEqual([5, [66, 67]]);
      expect(outcome.variantIds).toEqual([66, 67]);
      expect([...outcome.entries.get(66)!].map((entry) => [entry.entryId, entry.unitCostCents, entry.kind, entry.fromCents]))
        .toEqual([[11, 999, "increase", 809], [10, 809, "baseline", null]]);
      expect(outcome.entries.get(66)?.[0]?.evidence).toEqual(evidence);
      expect(client.costReads).toEqual([{ vendorId: 5, productVariantIds: [66, 67] }]);
      expect(outcome.costs.get(66)).toMatchObject({ unitCostCents: 809 });
      expect(released).toEqual([false]);
    });

    it("rolls back and releases when the work fails, and maps a guard refusal", async () => {
      const guard = Object.assign(new Error("dropship_cost_change_log is append-only"), { code: "P0001" });
      const { pool, calls, released } = fakePool([guard]);
      const repository = new PgDropshipCostScheduleRepository(pool);

      await expect(repository.withVendorSchedule(5, async (transaction) => transaction.listTrackedVariantIds()))
        .rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_IMMUTABLE", context: { classification: "permanent" } });
      expect(calls.map((call) => call.sql)).toEqual(expect.arrayContaining(["BEGIN", "ROLLBACK"]));
      expect(calls.map((call) => call.sql)).not.toContain("COMMIT");
      expect(released).toEqual([false]);
    });

    it("refuses an invalid vendor id before touching the pool", async () => {
      const { pool, calls } = fakePool();
      await expect(new PgDropshipCostScheduleRepository(pool).withVendorSchedule(0, async () => undefined))
        .rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_INVALID_INPUT" });
      expect(calls).toEqual([]);
    });
  });

  describe("writeReconciliation", () => {
    it("inserts every new entry in one statement, lowers and withdraws in place, and logs each operation with its reading", async () => {
      const { pool, calls } = fakePool([
        result([{ id: "21", product_variant_id: 66 }, { id: "22", product_variant_id: 68 }]),
        result([], 1),
        result([], 1),
        result([], 4),
      ]);
      const repository = new PgDropshipCostScheduleRepository(pool);

      const counts = await repository.withVendorSchedule(5, (transaction) => transaction.writeReconciliation({
        vendorId: 5,
        observedAt: NOW,
        policyId: 3,
        recordedBy: "acceptance",
        variants: [
          { productVariantId: 66, evidence, retailDriven: false, operations: [
            { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
          ] },
          { productVariantId: 67, evidence: { ...evidence, retailPriceCents: 999 }, retailDriven: true, operations: [
            { kind: "reduce", entryId: 11, fromCents: 999, unitCostCents: 899, effectiveAt: IN_TWO_WEEKS },
            { kind: "withdraw", entryId: 12, unitCostCents: 1099, effectiveAt: IN_TWO_WEEKS },
          ] },
          { productVariantId: 68, evidence: { source: "variant_fixed_price", planId: "ops", overrideId: "o-9", retailPriceCents: null, discountBps: null },
            retailDriven: false, operations: [{ kind: "baseline", unitCostCents: 709, effectiveAt: NOW }] },
        ],
      }));

      expect(counts).toEqual({ ...emptyEventCounts(), increase_announced: 1, increase_reduced: 1, change_withdrawn: 1, baseline: 1 });
      const [, , insertEntries, lower, withdraw, insertLog] = calls;
      expect(insertEntries?.sql).toContain("INSERT INTO dropship.dropship_cost_schedule_entries");
      expect(insertEntries?.sql).toContain("RETURNING id, product_variant_id");
      expect(insertEntries?.values).toEqual([
        5, NOW, 3,
        [66, 68], ["increase", "baseline"], [809, null], [999, 709], [IN_TWO_WEEKS, NOW],
        ["plan_percent", "variant_fixed_price"], ["ops", "ops"], [null, "o-9"], [899, null], [1000, null],
        "acceptance",
      ]);
      expect(lower?.sql).toContain("SET unit_cost_cents = $5");
      expect(lower?.sql).toContain("AND kind = 'increase' AND unit_cost_cents = $4");
      expect(lower?.values).toEqual([11, 5, 67, 999, 899]);
      expect(withdraw?.sql).toContain("SET withdrawn_at = $5");
      expect(withdraw?.sql).toContain("withdrawn_at IS NULL AND unit_cost_cents = $4");
      expect(withdraw?.values).toEqual([12, 5, 67, 1099, NOW]);
      expect(insertLog?.sql).toContain("INSERT INTO dropship.dropship_cost_change_log");
      expect(insertLog?.values).toEqual([
        5, NOW, 3,
        [66, 67, 67, 68],
        [21, 11, 12, 22],
        ["increase_announced", "increase_reduced", "change_withdrawn", "baseline"],
        [809, 999, 1099, null],
        [999, 899, null, 709],
        [IN_TWO_WEEKS, IN_TWO_WEEKS, IN_TWO_WEEKS, NOW],
        [false, true, true, false],
        ["plan_percent", "plan_percent", "plan_percent", "variant_fixed_price"],
        ["ops", "ops", "ops", "ops"],
        [null, null, null, "o-9"],
        [899, 999, 999, null],
        [1000, 1000, 1000, null],
        "acceptance",
      ]);
      expect(calls.at(-1)?.sql).toBe("COMMIT");
    });

    it("rolls back when an entry to lower or withdraw no longer matches the domain's view", async () => {
      const { pool, calls } = fakePool([result([]), result([], 0)]);
      await expect(new PgDropshipCostScheduleRepository(pool).withVendorSchedule(5, (transaction) => transaction.writeReconciliation({
        vendorId: 5, observedAt: NOW, policyId: 3, recordedBy: "detection",
        variants: [{ productVariantId: 67, evidence, retailDriven: false, operations: [
          { kind: "withdraw", entryId: 12, unitCostCents: 1099, effectiveAt: IN_TWO_WEEKS },
        ] }],
      }))).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_ENTRY_STALE", context: { entryId: 12, productVariantId: 67 } });
      expect(calls.map((call) => call.sql)).toContain("ROLLBACK");
      expect(calls.some((call) => call.sql.includes("dropship_cost_change_log"))).toBe(false);
    });

    it("refuses a write for another vendor, two new entries for one variant, or an insert that returned too few ids", async () => {
      const otherVendor = new PgDropshipCostScheduleRepository(fakePool().pool);
      await expect(otherVendor.withVendorSchedule(5, (transaction) => transaction.writeReconciliation({
        vendorId: 6, observedAt: NOW, policyId: 3, recordedBy: "detection", variants: [],
      }))).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_VENDOR_MISMATCH" });

      const twoAdds = new PgDropshipCostScheduleRepository(fakePool().pool);
      await expect(twoAdds.withVendorSchedule(5, (transaction) => transaction.writeReconciliation({
        vendorId: 5, observedAt: NOW, policyId: 3, recordedBy: "detection",
        variants: [{ productVariantId: 66, evidence, retailDriven: false, operations: [
          { kind: "baseline", unitCostCents: 809, effectiveAt: NOW },
          { kind: "add", direction: "increase", fromCents: 809, unitCostCents: 999, effectiveAt: IN_TWO_WEEKS },
        ] }],
      }))).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_WRITE_INVALID" });

      const shortInsert = new PgDropshipCostScheduleRepository(fakePool([result([])]).pool);
      await expect(shortInsert.withVendorSchedule(5, (transaction) => transaction.writeReconciliation({
        vendorId: 5, observedAt: NOW, policyId: 3, recordedBy: "detection",
        variants: [{ productVariantId: 66, evidence, retailDriven: false, operations: [{ kind: "baseline", unitCostCents: 809, effectiveAt: NOW }] }],
      }))).rejects.toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_WRITE_INVALID" });
    });
  });

  describe("advanceCursor", () => {
    it("moves the cursor forward with the vendor's counts, only past its current position", async () => {
      const { pool, calls } = fakePool([result([], 1)]);
      await new PgDropshipCostScheduleRepository(pool).withVendorSchedule(5, (transaction) => transaction.advanceCursor({
        vendorId: 5, counts: { variantsRead: 12, unavailableReadings: 1, changesRecorded: 3 }, now: NOW,
      }));
      const update = calls[2];
      expect(update?.sql).toContain("SET cursor_vendor_id = $2, pass_vendors_processed = pass_vendors_processed + 1");
      expect(update?.sql).toContain("WHERE id = $1 AND pass_started_at IS NOT NULL AND (cursor_vendor_id IS NULL OR cursor_vendor_id < $2)");
      expect(update?.values).toEqual([1, 5, 12, 1, 3, NOW]);
    });

    it("rolls the vendor's transaction back when another worker already passed it", async () => {
      const { pool, calls } = fakePool([result([], 0)]);
      await expect(new PgDropshipCostScheduleRepository(pool).withVendorSchedule(5, (transaction) => transaction.advanceCursor({
        vendorId: 5, counts: { variantsRead: 1, unavailableReadings: 0, changesRecorded: 0 }, now: NOW,
      }))).rejects.toMatchObject({ code: "DROPSHIP_COST_DETECTION_CURSOR_CONFLICT", context: { classification: "transient" } });
      expect(calls.map((call) => call.sql)).toContain("ROLLBACK");
    });
  });

  describe("admin reads", () => {
    it("lists announced changes soonest first with their vendor and variant labels", async () => {
      const { pool, calls } = fakePool([result([{
        ...entryRow(), vendor_id: 5, business_name: "Shellz Vendor", variant_sku: "ARM-ENV-SGL-P50", variant_name: "Single pack", product_name: "Armor Envelope",
      }])]);
      const pending = await new PgDropshipCostScheduleRepository(pool).listPendingChanges({ now: NOW, limit: 200 });
      expect(calls[0]?.sql).toContain("WHERE e.withdrawn_at IS NULL AND e.effective_at > $1 ORDER BY e.effective_at ASC, e.id ASC LIMIT $2");
      expect(calls[0]?.values).toEqual([NOW, 200]);
      expect(pending).toEqual([{
        entryId: 11, vendorId: 5, vendorBusinessName: "Shellz Vendor", productVariantId: 66, variantSku: "ARM-ENV-SGL-P50",
        variantName: "Single pack", productName: "Armor Envelope", kind: "increase", fromCents: 809, unitCostCents: 999,
        effectiveAt: IN_TWO_WEEKS, observedAt: NOW, policyId: 3, costSource: "plan_percent", recordedBy: "detection",
      }]);
    });

    it("pages the change log newest first before a cursor", async () => {
      const { pool, calls } = fakePool([result([{
        id: "31", entry_id: "11", vendor_id: 5, business_name: null, product_variant_id: 66, variant_sku: null, variant_name: "Single pack",
        product_name: "Armor Envelope", event_type: "change_withdrawn", from_cents: "1099", to_cents: null, effective_at: IN_TWO_WEEKS,
        retail_driven: true, observed_at: NOW, policy_id: null, cost_source: "retail", recorded_by: "acceptance", created_at: NOW,
      }])]);
      const rows = await new PgDropshipCostScheduleRepository(pool).listChangeLog({ limit: 51, beforeId: 40 });
      expect(calls[0]?.sql).toContain("WHERE ($1::bigint IS NULL OR l.id < $1) ORDER BY l.id DESC LIMIT $2");
      expect(calls[0]?.values).toEqual([40, 51]);
      expect(rows).toEqual([{
        logId: 31, entryId: 11, vendorId: 5, vendorBusinessName: null, productVariantId: 66, variantSku: null, variantName: "Single pack",
        productName: "Armor Envelope", eventType: "change_withdrawn", fromCents: 1099, toCents: null, effectiveAt: IN_TWO_WEEKS,
        retailDriven: true, observedAt: NOW, policyId: null, costSource: "retail", recordedBy: "acceptance", createdAt: NOW,
      }]);
    });

    it("refuses a stored amount, kind or event it cannot trust", () => {
      expect(() => mapEntryRow(entryRow({ unit_cost_cents: "9.99" }) as never)).toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
      expect(() => mapEntryRow(entryRow({ unit_cost_cents: "-1" }) as never)).toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
      expect(() => mapEntryRow(entryRow({ kind: "surprise" }) as never)).toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
      expect(() => mapEntryRow(entryRow({ id: "0" }) as never)).toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
      expect(() => mapEntryRow(entryRow({ recorded_by: "someone" }) as never)).toThrow(expect.objectContaining({ code: "DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE" }));
      expect(mapEntryRow(entryRow({ unit_cost_cents: 999 }) as never).unitCostCents).toBe(999);
    });
  });

  describe("mapCostScheduleError", () => {
    it("classifies the failures it can provoke and leaves the rest alone", () => {
      expect(mapCostScheduleError(Object.assign(new Error(""), { code: "23514" }))).toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_WRITE_INVALID", context: { classification: "permanent" } });
      expect(mapCostScheduleError(Object.assign(new Error(""), { code: "23503" }))).toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_WRITE_INVALID" });
      expect(mapCostScheduleError(Object.assign(new Error("guard"), { code: "P0001" }))).toMatchObject({ code: "DROPSHIP_COST_SCHEDULE_IMMUTABLE", context: { detail: "guard" } });
      const plain = new Error("network");
      expect(mapCostScheduleError(plain)).toBe(plain);
    });
  });
});
