import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readMigration() {
  return fs.readFileSync(
    path.resolve(process.cwd(), "migrations/109_oms_wms_reconciliation_exceptions.sql"),
    "utf8",
  );
}

describe("OMS/WMS reconciliation exceptions migration", () => {
  it("creates the Phase 5 reconciliation exception table", () => {
    const sql = readMigration();

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS wms.reconciliation_exceptions");
    expect(sql).toContain("classification VARCHAR(30) NOT NULL");
    expect(sql).toContain("rule VARCHAR(80) NOT NULL");
    expect(sql).toContain("idempotency_key VARCHAR(500) NOT NULL");
    expect(sql).toContain("details JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(sql).toContain("REFERENCES wms.orders(id)");
    expect(sql).toContain("REFERENCES wms.outbound_shipments(id)");
  });

  it("locks classifications to the authority remediation vocabulary", () => {
    const sql = readMigration();

    expect(sql).toContain("'safe_auto_repair'");
    expect(sql).toContain("'manual_review'");
    expect(sql).toContain("'hard_block'");
    expect(sql).toContain("'historical_ignore'");
  });

  it("deduplicates active review exceptions by idempotency key", () => {
    const sql = readMigration();

    expect(sql).toContain("uq_wms_reconciliation_exceptions_open_idem");
    expect(sql).toContain("ON wms.reconciliation_exceptions (idempotency_key)");
    expect(sql).toContain("WHERE status IN ('open', 'acknowledged')");
    expect(sql).toContain("idx_wms_reconciliation_exceptions_status");
    expect(sql).toContain("idx_wms_reconciliation_exceptions_external");
  });
});
