import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource(
  "migrations",
  "0620_vendor_invoice_unit_cost_mills_repair.sql",
);
const procurementSchema = readNormalizedSource(
  "shared",
  "schema",
  "procurement.schema.ts",
);

describe("vendor invoice unit-cost mills repair migration", () => {
  it("runs atomically and records immutable before/after repair evidence", () => {
    expect(migration.trimStart().startsWith("-- Repair legacy vendor invoice lines")).toBe(true);
    expect(migration).toContain("BEGIN;");
    expect(migration.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS procurement.vendor_invoice_unit_cost_repairs",
    );
    expect(migration).toContain("previous_unit_cost_mills BIGINT");
    expect(migration).toContain("repaired_unit_cost_mills BIGINT NOT NULL");
    expect(migration).toContain("previous_match_status VARCHAR(20) NOT NULL");
    expect(migration).toContain("vendor_invoice_unit_cost_repairs_immutable");
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON procurement.vendor_invoice_unit_cost_repairs",
    );
  });

  it("repairs only evidence-backed PO-linked null-mills rows", () => {
    expect(migration).toContain("WHERE vil.unit_cost_mills IS NULL");
    expect(migration).toContain("AND pol.unit_cost_mills IS NOT NULL");
    expect(migration).toContain(
      "link.vendor_invoice_id = vil.vendor_invoice_id\n        AND link.purchase_order_id = pol.purchase_order_id",
    );
    expect(migration).toContain(
      "vil.unit_cost_cents::numeric =\n      floor((pol.unit_cost_mills::numeric + 50) / 100)",
    );
    expect(migration).toContain(
      "vil.line_total_cents::numeric * pol.order_qty::numeric =\n        pol.total_product_cost_cents::numeric * vil.qty_invoiced::numeric",
    );
    expect(migration).toContain(
      "vil.line_total_cents::numeric * pol.order_qty::numeric =\n        pol.line_total_cents::numeric * vil.qty_invoiced::numeric",
    );
    expect(migration).toContain(
      "(vil.line_total_cents::numeric * 100) / vil.qty_invoiced::numeric + 0.5",
    );
  });

  it("is idempotent and never rewrites invoice extended totals", () => {
    expect(migration).toContain("'0620_linked_po_mills_v1'");
    expect(migration).toContain(
      "ON CONFLICT (vendor_invoice_line_id, repair_key) DO NOTHING",
    );
    const repairUpdateStart = migration.indexOf("UPDATE procurement.vendor_invoice_lines vil");
    const repairUpdateEnd = migration.indexOf("-- Recompute the same", repairUpdateStart);
    const repairUpdate = migration.slice(repairUpdateStart, repairUpdateEnd);
    expect(repairUpdate).toContain("unit_cost_mills = repair.repaired_unit_cost_mills");
    expect(repairUpdate).toContain("AND vil.unit_cost_mills IS NULL");
    expect(repairUpdate).not.toMatch(/line_total_cents\s*=/);
  });

  it("recomputes active match projections with application precedence", () => {
    expect(migration).toContain("AND vi.status <> 'voided'");
    expect(migration).toContain("SUM(qty_invoiced::numeric) AS aggregate_invoiced_qty");

    const priceIndex = migration.indexOf("THEN 'price_discrepancy'");
    const overBilledIndex = migration.indexOf("THEN 'over_billed'");
    const quantityIndex = migration.indexOf("THEN 'qty_discrepancy'");
    const matchedIndex = migration.indexOf("ELSE 'matched'");
    expect(priceIndex).toBeGreaterThanOrEqual(0);
    expect(overBilledIndex).toBeGreaterThan(priceIndex);
    expect(quantityIndex).toBeGreaterThan(overBilledIndex);
    expect(matchedIndex).toBeGreaterThan(quantityIndex);
  });

  it("requires mills and the rounded-cent mirror on future financial writes", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION procurement.require_vendor_invoice_unit_cost_mills()",
    );
    expect(migration).toContain("BEFORE INSERT ON procurement.vendor_invoice_lines");
    expect(migration).toContain(
      "BEFORE UPDATE OF unit_cost_cents, unit_cost_mills, qty_invoiced, line_total_cents",
    );
    expect(migration).toContain(
      "floor((NEW.unit_cost_mills::numeric + 50) / 100)",
    );
  });

  it("keeps the typed procurement schema aligned with the evidence ledger", () => {
    expect(procurementSchema).toContain(
      'procurementSchema.table(\n  "vendor_invoice_unit_cost_repairs"',
    );
    expect(procurementSchema).toContain(
      'repairedUnitCostMills: bigint("repaired_unit_cost_mills", { mode: "number" }).notNull()',
    );
    expect(procurementSchema).toContain(
      'uniqueIndex("vendor_invoice_unit_cost_repairs_identity_uq")',
    );
    expect(procurementSchema).toContain(
      'check("vendor_invoice_unit_cost_repairs_cents_mirror_chk"',
    );
  });
});
