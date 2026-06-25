import { describe, expect, it } from "vitest";

async function loadAuditModule() {
  process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
  return await import("../audit-oms-wms-authority-readiness");
}

describe("audit-oms-wms-authority-readiness", () => {
  it("parses CLI flags with safe read-only defaults", async () => {
    const { parseFlags } = await loadAuditModule();

    expect(parseFlags([])).toEqual({
      help: false,
      json: false,
      failOnIssues: false,
      sampleLimit: 10,
      checkId: null,
    });

    expect(parseFlags(["--json", "--fail-on-issues", "--limit=3", "--check=oms_line_over_materialized"]))
      .toEqual({
        help: false,
        json: true,
        failOnIssues: true,
        sampleLimit: 3,
        checkId: "oms_line_over_materialized",
      });
  });

  it("rejects invalid CLI input instead of silently choosing a fallback", async () => {
    const { parseFlags } = await loadAuditModule();

    expect(() => parseFlags(["--limit=0"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--limit=abc"])).toThrow(/positive integer/);
    expect(() => parseFlags(["--check="])).toThrow(/cannot be blank/);
  });

  it("defines checks for the Phase 4 OMS/WMS authority constraint surfaces", async () => {
    const { buildReadinessChecks } = await loadAuditModule();
    const checks = buildReadinessChecks();
    const ids = checks.map((check) => check.id);

    expect(ids).toContain("oms_wms_item_missing_oms_line_id");
    expect(ids).toContain("oms_wms_item_orphan_oms_line");
    expect(ids).toContain("oms_wms_item_wrong_order_lineage");
    expect(ids).toContain("oms_wms_duplicate_order_line_items");
    expect(ids).toContain("oms_line_multiple_active_wms_orders");
    expect(ids).toContain("oms_line_over_materialized");
    expect(ids).toContain("wms_order_materialized_counter_drift");
    expect(ids).toContain("active_engine_order_ref_duplicates");
    expect(ids).toContain("shipment_item_order_mismatch");
    expect(ids).toContain("negative_wms_order_item_quantities");

    expect(new Set(ids).size).toBe(ids.length);
    expect(checks.every((check) => check.constraintTarget.length > 0)).toBe(true);
  });

  it("keeps the audit SQL read-only", async () => {
    const { buildReadinessChecks } = await loadAuditModule();
    const mutatingSqlPattern = /\b(insert|update|delete|merge|alter|create|drop|truncate|grant|revoke)\b/i;

    for (const check of buildReadinessChecks()) {
      expect(check.sql, check.id).not.toMatch(mutatingSqlPattern);
    }
  });

  it("does not query nonexistent shipment order_number columns", async () => {
    const { buildReadinessChecks } = await loadAuditModule();
    const shipmentChecks = buildReadinessChecks()
      .filter((check) => check.id.includes("shipstation") || check.id.includes("engine_order_ref"));

    expect(shipmentChecks.length).toBeGreaterThan(0);
    for (const check of shipmentChecks) {
      expect(check.sql, check.id).not.toContain("s.order_number");
      expect(check.sql, check.id).toContain("LEFT JOIN wms.orders o ON o.id = s.order_id");
      expect(check.sql, check.id).toContain("o.order_number");
    }
  });

  it("exempts known combined-child mirror rows from external shipment identity duplicate checks", async () => {
    const { buildReadinessChecks } = await loadAuditModule();
    const identityChecks = buildReadinessChecks()
      .filter((check) =>
        check.id === "active_shipstation_order_id_duplicates" ||
        check.id === "active_shipstation_order_key_duplicates" ||
        check.id === "active_engine_order_ref_duplicates"
      );

    expect(identityChecks.length).toBe(3);
    for (const check of identityChecks) {
      expect(check.sql, check.id).toContain("echelon_combined_child");
      expect(check.sql, check.id).toContain("shipstation_combined_child");
    }
  });

  it("summarizes blocker and warning counts separately", async () => {
    const { buildReadinessChecks, summarizeResults } = await loadAuditModule();
    const checks = buildReadinessChecks();
    const blocker = checks.find((check) => check.severity === "blocker");
    const warning = checks.find((check) => check.severity === "warning");

    expect(blocker).toBeDefined();
    expect(warning).toBeDefined();

    const summary = summarizeResults([
      { check: blocker!, count: 2, samples: [] },
      { check: warning!, count: 3, samples: [] },
    ]);

    expect(summary).toEqual({
      checks: 2,
      blockers: 2,
      warnings: 3,
      issueCount: 5,
    });
  });
});
