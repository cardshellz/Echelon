import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/158_rfq_allocation_override_evidence.sql"),
  "utf8",
);

describe("RFQ allocation override evidence migration", () => {
  it("requires exact request identity and complete approval evidence", () => {
    expect(migration).toContain("request_hash VARCHAR(64)");
    expect(migration).toContain("request_for_quotes_request_hash_chk");
    expect(migration).toContain("allocation_override_approved_by VARCHAR(255)");
    expect(migration).toContain("allocation_override_approved_at TIMESTAMPTZ");
    expect(migration).toContain("allocation_override_baseline_pieces INTEGER");
    expect(migration).toContain("allocation_override_excess_pieces INTEGER");
    expect(migration).toContain("request_for_quote_lines_override_evidence_chk");
  });

  it("fails closed on unattributable history and derives excess under a database lock", () => {
    expect(migration).toContain("Existing RFQ allocation overrides require explicit remediation");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("baseline_qty := GREATEST(recommendation_qty - allocated_qty, 0)");
    expect(migration).toContain("excess_qty := GREATEST(NEW.requested_pieces - baseline_qty, 0)");
    expect(migration).toContain("without complete approval evidence");
    expect(migration).toContain("does not match the locked recommendation baseline");
  });

  it("makes quantities and approvals immutable and prevents line reactivation", () => {
    expect(migration).toContain("RFQ line quantity and override evidence are immutable; cancel and replace the line");
    expect(migration).toContain("Inactive RFQ lines cannot be reactivated; create a replacement line");
  });
});
