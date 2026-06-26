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
        "materialized-counter-drift",
      ],
      operator: "script:cleanup-oms-wms-authority-readiness",
    });
  });

  it("parses execute mode, operation subsets, all limit, and operator", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--operation=orphan-oms-line-refs,materialized-counter-drift",
      "--operator=manual-prod-cleanup",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      operations: ["orphan-oms-line-refs", "materialized-counter-drift"],
      operator: "manual-prod-cleanup",
    });
  });

  it("rejects ambiguous or invalid CLI input instead of guessing", async () => {
    const { parseFlags } = await loadCleanupModule();

    expect(() => parseFlags(["--execute", "--dry-run"])).toThrow(/Cannot pass both/);
    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer or all/);
    expect(() => parseFlags(["--operation="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--operation=not-real"])).toThrow(/Unknown cleanup operation/);
    expect(() => parseFlags(["--operator="])).toThrow(/cannot be blank/);
    expect(() => parseFlags(["--bogus"])).toThrow(/Unknown flag/);
  });

  it("defines the three cleanup operations proven by the readiness audit output", async () => {
    const { buildCleanupOperations } = await loadCleanupModule();
    const operations = buildCleanupOperations();

    expect(operations.map((operation: any) => operation.id)).toEqual([
      "orphan-oms-line-refs",
      "nonpositive-shipment-items",
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

  it("uses the readiness audit current-open predicate for materialized counter drift", async () => {
    const { materializedCounterDriftCandidateSql } = await loadCleanupModule();
    const sql = materializedCounterDriftCandidateSql(10, true);

    expect(sql).toContain("o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')");
    expect(sql).toContain("o.cancelled_at IS NULL");
    expect(sql).toContain("o.completed_at IS NULL");
    expect(sql).toContain("COALESCE(oi.status, '') NOT IN ('cancelled', 'completed', 'short')");
    expect(sql).toContain("COALESCE(ol.wms_materialized_quantity, 0) <> COALESCE(am.materialized_quantity, 0)");
    expect(sql).toContain("FOR UPDATE OF ol");
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
  });
});
