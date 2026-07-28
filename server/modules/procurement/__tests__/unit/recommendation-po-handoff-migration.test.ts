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
const quantityOverrideMigration = readFileSync(
  join(process.cwd(), "migrations", "177_recommendation_po_handoff_quantity_override.sql"),
  "utf8",
);
const zeroBaselineMigration = readFileSync(
  join(process.cwd(), "migrations", "178_recommendation_po_handoff_zero_baseline_topoff.sql"),
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

  // Migration 177: Order Builder quantity-override evidence mirrors the
  // migration-158 RFQ shape — all-null, or fully evidenced for excess only.
  it("requires all-or-nothing quantity-override evidence on handoffs", () => {
    expect(quantityOverrideMigration).toContain("quantity_override_baseline_pieces INTEGER");
    expect(quantityOverrideMigration).toContain("quantity_override_requested_pieces INTEGER");
    expect(quantityOverrideMigration).toContain("quantity_override_reason TEXT");
    expect(quantityOverrideMigration).toContain("quantity_override_approved_by VARCHAR(255)");
    expect(quantityOverrideMigration).toContain("quantity_override_approved_at TIMESTAMP WITHOUT TIME ZONE");
    expect(quantityOverrideMigration).toContain("purch_rec_po_handoff_qty_override_evidence_chk");
    expect(quantityOverrideMigration).toContain("quantity_override_requested_pieces > quantity_override_baseline_pieces");
    expect(quantityOverrideMigration).toContain("LENGTH(BTRIM(quantity_override_reason)) >= 3");
    expect(quantityOverrideMigration).toContain("NULLIF(BTRIM(quantity_override_approved_by), '') IS NOT NULL");
    expect(quantityOverrideMigration).toContain("quantity_override_approved_at IS NOT NULL");
  });

  // Migration 178: healthy top-offs — the baseline floor relaxes to >= 0 so a
  // zero-suggestion acceptance can carry override evidence; every other
  // evidence rule from 177 is re-stated verbatim in the swapped constraint.
  it("allows a zero override baseline while keeping the excess-only evidence rules", () => {
    expect(zeroBaselineMigration).toContain(
      "DROP CONSTRAINT IF EXISTS purch_rec_po_handoff_qty_override_evidence_chk",
    );
    expect(zeroBaselineMigration).toContain("purch_rec_po_handoff_qty_override_evidence_chk");
    expect(zeroBaselineMigration).toContain("quantity_override_baseline_pieces >= 0");
    expect(zeroBaselineMigration).not.toContain("quantity_override_baseline_pieces > 0");
    expect(zeroBaselineMigration).toContain("quantity_override_requested_pieces > quantity_override_baseline_pieces");
    expect(zeroBaselineMigration).toContain("LENGTH(BTRIM(quantity_override_reason)) >= 3");
    expect(zeroBaselineMigration).toContain("NULLIF(BTRIM(quantity_override_approved_by), '') IS NOT NULL");
    expect(zeroBaselineMigration).toContain("quantity_override_approved_at IS NOT NULL");
  });

  // The Drizzle table definition must agree with migration 178: a schema-first
  // regeneration that re-tightened the baseline floor to > 0 would make
  // zero-baseline (healthy top-off) override evidence unrepresentable again.
  it("keeps the shared Drizzle CHECK in lockstep with migration 178", () => {
    const sharedSchema = readFileSync(
      join(process.cwd(), "shared", "schema", "procurement.schema.ts"),
      "utf8",
    );
    const checkStart = sharedSchema.indexOf("purch_rec_po_handoff_qty_override_evidence_chk");
    expect(checkStart).toBeGreaterThan(-1);
    const checkBody = sharedSchema.slice(checkStart, checkStart + 800);
    expect(checkBody).toContain("quantityOverrideBaselinePieces} >= 0");
    expect(checkBody).not.toContain("quantityOverrideBaselinePieces} > 0");
    expect(checkBody).toContain(
      "quantityOverrideRequestedPieces} > ${table.quantityOverrideBaselinePieces}",
    );
  });
});
