import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "migrations", "130_atomic_recommendation_po_handoffs.sql"),
  "utf8",
);
const automaticMigration = readFileSync(
  join(process.cwd(), "migrations", "132_automatic_recommendation_handoff_provenance.sql"),
  "utf8",
);

describe("recommendation PO handoff migration", () => {
  it("enforces one handoff per acceptance and exact PO-line ownership", () => {
    expect(migration).toContain("UNIQUE INDEX IF NOT EXISTS purch_rec_po_handoff_accepted_decision_uidx");
    expect(migration).toContain("FOREIGN KEY (purchase_order_id, purchase_order_line_id)");
    expect(migration).toContain("REFERENCES procurement.purchase_order_lines (purchase_order_id, id)");
    expect(migration).toContain("FOREIGN KEY (accepted_decision_id, recommendation_id, kind)");
    expect(migration).toContain("FOREIGN KEY (handoff_decision_id, recommendation_id, kind)");
  });

  it("validates decision roles and makes mappings immutable", () => {
    expect(migration).toContain("decision.decision = 'accepted_for_po'");
    expect(migration).toContain("decision.decision = 'po_handoff_created'");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("purchasing recommendation PO handoffs are immutable");
  });

  it("binds automatic decision pairs to one auto-draft run", () => {
    expect(automaticMigration).toContain("purch_rec_decisions_auto_draft_run_chk");
    expect(automaticMigration).toContain("purch_rec_decisions_auto_draft_run_rec_kind_decision_uidx");
    expect(automaticMigration).toContain("accepted_source IS DISTINCT FROM handoff_source");
    expect(automaticMigration).toContain("accepted_run_id IS DISTINCT FROM handoff_run_id");
    expect(automaticMigration).toContain("automatic recommendation handoffs require an auto-draft run");
  });
});
