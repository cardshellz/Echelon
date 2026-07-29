import { describe, expect, it } from "vitest";

async function loadCleanupModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../cleanup-oms-wms-authority-readiness");
}

describe("cleanup-oms-wms-authority-readiness", () => {
  it("defaults to dry-run with all operations and a bounded limit", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      help: false,
      limit: 100,
      operations: [
        "orphan-oms-line-refs",
        "nonpositive-shipment-items",
        "reopened-fully-picked-lines",
        "materialized-counter-drift",
      ],
      counterDirection: "all",
      counterDecreaseSafety: "none",
      summaryOnly: false,
      operator: "script:cleanup-oms-wms-authority-readiness",
    });
  });

  it("parses safe execute mode, operation subsets, all limit, counter direction, and operator", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--operation=orphan-oms-line-refs,materialized-counter-drift",
      "--counter-direction=recorded-below-actual",
      "--summary-only",
      "--operator=manual-prod-cleanup",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      operations: ["orphan-oms-line-refs", "materialized-counter-drift"],
      counterDirection: "recorded-below-actual",
      counterDecreaseSafety: "none",
      summaryOnly: true,
      operator: "manual-prod-cleanup",
    });
  });

  it("rejects ambiguous or invalid CLI input instead of guessing", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--operation="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--operation=not-real"])).toThrow(/Unknown cleanup operation/);
    expect(() => parseFlags(["--counter-direction="])).toThrow(/must be all/);
    expect(() => parseFlags(["--counter-direction=sideways"])).toThrow(/must be all/);
    expect(() => parseFlags([
      "--execute",
      "--operation=materialized-counter-drift",
    ])).toThrow(/requires an explicit counter direction/);
    expect(() => parseFlags([
      "--execute",
      "--operation=materialized-counter-drift",
      "--counter-direction=recorded-above-actual",
    ])).toThrow(/requires --counter-decrease-safety=zero-authority-zero-actual/);
    expect(() => parseFlags([
      "--counter-decrease-safety=unsafe",
    ])).toThrow(/must be none or zero-authority-zero-actual/);
    expect(() => parseFlags(["--operator="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("does not require a counter direction when execute excludes materialized-counter cleanup", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(parseFlags([
      "--execute",
      "--operation=orphan-oms-line-refs,nonpositive-shipment-items",
    ])).toMatchObject({
      mode: "execute",
      counterDirection: "all",
    });
  });

  it("permits only the zero-authority zero-actual policy for counter decreases", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(parseFlags([
      "--execute",
      "--operation=materialized-counter-drift",
      "--counter-direction=recorded-above-actual",
      "--counter-decrease-safety=zero-authority-zero-actual",
    ])).toMatchObject({
      mode: "execute",
      counterDirection: "recorded-above-actual",
      counterDecreaseSafety: "zero-authority-zero-actual",
    });
  });

  it("chunks audit snapshots into bounded inserts", async () => {
    const { chunkForAuditInsert } = await loadCleanupModule();
    const values = Array.from({ length: 1_201 }, (_, index) => index + 1);

    expect(chunkForAuditInsert(values)).toEqual([
      values.slice(0, 500),
      values.slice(500, 1_000),
      values.slice(1_000),
    ]);
    expect(chunkForAuditInsert([])).toEqual([]);
    expect(() => chunkForAuditInsert(values, 0)).toThrow(/positive integer/);
  });

  it("defines the cleanup operations proven by readiness evidence", async () => {
    const { buildCleanupOperations } = await loadCleanupModule();
    const operations = buildCleanupOperations();

    expect(operations.map((operation: any) => operation.id)).toEqual([
      "orphan-oms-line-refs",
      "nonpositive-shipment-items",
      "reopened-fully-picked-lines",
      "materialized-counter-drift",
    ]);
    expect(operations.every((operation: any) => operation.reason.length > 0)).toBe(true);
    expect(operations.every((operation: any) => operation.sourceTable.includes("."))).toBe(true);
  });

  it("limits orphan OMS-line cleanup to historical terminal WMS orders", async () => {
    const {
      orphanOmsLineRefsCandidateSql,
      orphanOmsLineRefsUnsafeCountSql,
    } = await loadCleanupModule();

    const sql = orphanOmsLineRefsCandidateSql(25, true);
    expect(sql).toContain("LEFT JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id");
    expect(sql).toContain("ol.id IS NULL");
    expect(sql).toContain("o.warehouse_status IN ('shipped', 'completed', 'cancelled')");
    expect(sql).toContain("o.completed_at IS NOT NULL");
    expect(sql).toContain("o.cancelled_at IS NOT NULL");
    expect(sql).toContain("FOR UPDATE OF oi");

    const unsafeSql = orphanOmsLineRefsUnsafeCountSql();
    expect(unsafeSql).toContain("AND NOT");
    expect(unsafeSql).toContain("o.warehouse_status IN ('shipped', 'completed', 'cancelled')");
  });

  it("limits nonpositive shipment-item cleanup to terminal shipment statuses", async () => {
    const {
      nonpositiveShipmentItemsCandidateSql,
      nonpositiveShipmentItemsUnsafeCountSql,
    } = await loadCleanupModule();

    const sql = nonpositiveShipmentItemsCandidateSql(null, true);
    expect(sql).toContain("COALESCE(si.qty, 0) <= 0");
    expect(sql).toContain("s.status IN ('shipped', 'cancelled', 'voided', 'returned', 'lost')");
    expect(sql).not.toContain("planned");
    expect(sql).not.toContain("queued");
    expect(sql).toContain("FOR UPDATE OF si");

    const unsafeSql = nonpositiveShipmentItemsUnsafeCountSql();
    expect(unsafeSql).toContain("AND NOT");
    expect(unsafeSql).toContain("s.status IN ('shipped', 'cancelled', 'voided', 'returned', 'lost')");
  });

  it("selects only fully picked shippable lines that were reopened", async () => {
    const { reopenedFullyPickedLinesCandidateSql } = await loadCleanupModule();
    const sql = reopenedFullyPickedLinesCandidateSql(25, true);

    expect(sql).toContain("COALESCE(oi.requires_shipping, 0) = 1");
    expect(sql).toContain("COALESCE(oi.quantity, 0) > 0");
    expect(sql).toContain("COALESCE(oi.picked_quantity, 0) >= oi.quantity");
    expect(sql).toContain("COALESCE(oi.status, '') IN ('pending', 'in_progress')");
    expect(sql).toContain("jsonb_build_object('status', 'completed')");
    expect(sql).toContain("FOR UPDATE OF oi");
  });

  it("defines a database guard against fully picked active lines", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const migration = fs.readFileSync(
      path.resolve(process.cwd(), "migrations/179_wms_fully_picked_status_guard.sql"),
      "utf8",
    );

    expect(migration).toContain("wms_order_items_fully_picked_status_chk");
    expect(migration).toContain("COALESCE(picked_quantity, 0) < COALESCE(quantity, 0)");
    expect(migration).toContain("COALESCE(status, '') NOT IN ('pending', 'in_progress')");
    expect(migration).toContain("NOT VALID");
  });

  it("uses cumulative non-cancelled authority consumption for materialized counter drift", async () => {
    const { materializedCounterDriftCandidateSql } = await loadCleanupModule();
    const sql = materializedCounterDriftCandidateSql(10, true);

    expect(sql).toContain("COALESCE(oi.status, '') <> 'cancelled'");
    expect(sql).not.toContain("o.warehouse_status IN");
    expect(sql).not.toContain("o.completed_at IS NULL");
    expect(sql).not.toContain("'completed', 'short'");
    expect(sql).toContain("actual_materialized_wms_quantity");
    expect(sql).toContain("'counter_direction'");
    expect(sql).toContain("COALESCE(ol.wms_materialized_quantity, 0) <> COALESCE(materialized.materialized_quantity, 0)");
    expect(sql).toContain("FOR UPDATE OF ol");
  });

  it("isolates materialized counter drift by direction and counts unsafe decreases", async () => {
    const {
      materializedCounterDriftCandidateSql,
      unsafeMaterializedCounterDecreaseCountSql,
      materializedCounterDecreaseCountSql,
    } = await loadCleanupModule();

    const belowSql = materializedCounterDriftCandidateSql(
      null,
      false,
      "recorded-below-actual",
    );
    expect(belowSql).toContain(
      "COALESCE(ol.wms_materialized_quantity, 0) < COALESCE(materialized.materialized_quantity, 0)",
    );

    const aboveSql = materializedCounterDriftCandidateSql(
      null,
      false,
      "recorded-above-actual",
    );
    expect(aboveSql).toContain(
      "COALESCE(ol.wms_materialized_quantity, 0) > COALESCE(materialized.materialized_quantity, 0)",
    );

    const safeAboveSql = materializedCounterDriftCandidateSql(
      null,
      false,
      "recorded-above-actual",
      "zero-authority-zero-actual",
    );
    expect(safeAboveSql).toContain(
      "COALESCE(ol.authority_fulfillable_quantity, 0) = 0",
    );
    expect(safeAboveSql).toContain(
      "COALESCE(materialized.materialized_quantity, 0) = 0",
    );

    const unsafeSql = unsafeMaterializedCounterDecreaseCountSql();
    expect(unsafeSql).toContain("COUNT(*)::int AS unsafe_count");
    expect(unsafeSql).toContain(
      "COALESCE(ol.wms_materialized_quantity, 0) > COALESCE(materialized.materialized_quantity, 0)",
    );
    expect(unsafeSql).toContain("AND NOT");
    expect(unsafeSql).toContain(
      "COALESCE(ol.authority_fulfillable_quantity, 0) = 0",
    );

    const allDecreaseSql = materializedCounterDecreaseCountSql();
    expect(allDecreaseSql).not.toContain("AND NOT");
  });

  it("does not reference WMS order-item timestamp columns that do not exist", async () => {
    const {
      orphanOmsLineRefsCandidateSql,
      materializedCounterDriftCandidateSql,
    } = await loadCleanupModule();

    expect(orphanOmsLineRefsCandidateSql(1, false)).not.toContain("oi.created_at");
    expect(materializedCounterDriftCandidateSql(1, false)).not.toContain("oi.created_at");
  });

  it("keeps cleanup operations auditable before database mutation statements", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "scripts/cleanup-oms-wms-authority-readiness.ts"),
      "utf8",
    );

    const auditFn = source.slice(
      source.indexOf("async function insertAuditRows"),
      source.indexOf("async function clearOrphanOmsLineRefs"),
    );
    expect(auditFn).toContain("chunkForAuditInsert(args.candidates)");
    expect(auditFn).toContain("FROM jsonb_to_recordset($7::jsonb)");
    expect(auditFn).toContain(
      "assertExpectedRowCount(args.operation.id, args.candidates.length, insertedCount)",
    );

    const clearFn = source.slice(
      source.indexOf("async function clearOrphanOmsLineRefs"),
      source.indexOf("async function deleteNonpositiveShipmentItems"),
    );
    expect(clearFn.indexOf("insertAuditRows")).toBeGreaterThan(-1);
    expect(clearFn.indexOf("UPDATE wms.order_items")).toBeGreaterThan(clearFn.indexOf("insertAuditRows"));
    expect(clearFn).toContain("assertExpectedRowCount");
    expect(clearFn).toContain("AND NOT EXISTS");
    expect(clearFn).toContain("WHERE ol.id = oi.oms_order_line_id");

    const deleteFn = source.slice(
      source.indexOf("async function deleteNonpositiveShipmentItems"),
      source.indexOf("async function refreshMaterializedCounters"),
    );
    expect(deleteFn.indexOf("insertAuditRows")).toBeGreaterThan(-1);
    expect(deleteFn.indexOf("DELETE FROM wms.outbound_shipment_items")).toBeGreaterThan(deleteFn.indexOf("insertAuditRows"));
    expect(deleteFn).toContain("assertExpectedRowCount");
    expect(deleteFn).toContain("COALESCE(si.qty, 0) <= 0");

    const reopenedFn = source.slice(
      source.indexOf("async function closeReopenedFullyPickedLines"),
      source.indexOf("async function refreshMaterializedCounters"),
    );
    expect(reopenedFn.indexOf("insertAuditRows")).toBeGreaterThan(-1);
    expect(reopenedFn.indexOf("UPDATE wms.order_items")).toBeGreaterThan(reopenedFn.indexOf("insertAuditRows"));
    expect(reopenedFn).toContain("COALESCE(oi.picked_quantity, 0) >= oi.quantity");
    expect(reopenedFn).toContain("assertExpectedRowCount");

    const counterFn = source.slice(
      source.indexOf("async function refreshMaterializedCounters"),
      source.indexOf("function assertExpectedRowCount"),
    );
    expect(counterFn.indexOf("insertAuditRows")).toBeGreaterThan(-1);
    expect(counterFn.indexOf("UPDATE oms.oms_order_lines")).toBeGreaterThan(counterFn.indexOf("insertAuditRows"));
    expect(counterFn).toContain(
      "COALESCE(ol.wms_materialized_quantity, 0) ${updateDirectionPredicate} input.actual_quantity",
    );
    expect(counterFn).toContain(
      "input.actual_quantity = COALESCE(materialized.actual_quantity, 0)",
    );
    expect(counterFn).toContain(
      "COALESCE(ol.authority_fulfillable_quantity, 0) = 0",
    );
    expect(counterFn).toContain("assertExpectedRowCount");
  });
});
