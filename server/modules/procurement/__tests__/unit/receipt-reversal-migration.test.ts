import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource("migrations", "187_receipt_reversals.sql");
const procurementSchema = readNormalizedSource("shared", "schema", "procurement.schema.ts");
const inventorySchema = readNormalizedSource("shared", "schema", "inventory.schema.ts");

describe("receipt reversals migration (Spec D)", () => {
  it("adds reversed_qty to receiving_lines with the 0 <= reversed_qty <= received_qty invariant", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS reversed_qty integer NOT NULL DEFAULT 0");
    expect(migration).toContain("receiving_lines_reversed_qty_chk");
    expect(migration).toContain("CHECK (reversed_qty >= 0 AND reversed_qty <= received_qty)");
  });

  it("creates procurement.receipt_reversals with a unique idempotency key", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS procurement.receipt_reversals");
    expect(migration).toContain("idempotency_key varchar(100) NOT NULL");
    expect(migration).toContain("receipt_reversals_idempotency_key_idx");
    expect(migration).toContain("ON procurement.receipt_reversals(idempotency_key)");
    expect(migration).toContain("CONSTRAINT receipt_reversals_qty_chk CHECK (qty > 0)");
  });

  it("extends the po_exceptions kind CHECK with receive warning kinds", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS po_exceptions_kind_chk");
    for (const kind of [
      "receive_uom_disagreement",
      "receive_base_unit_pack_conflict",
      "receive_cost_variance_soft",
      "receive_cost_variance_hard",
      "receive_variant_base_unit_misconfig",
      "receive_variant_missing_parent",
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
  });

  it("keeps the Drizzle schema aligned with the migration", () => {
    expect(procurementSchema).toContain('reversedQty: integer("reversed_qty")');
    expect(procurementSchema).toContain('procurementSchema.table("receipt_reversals"');
    expect(procurementSchema).toContain('idempotencyKey: varchar("idempotency_key"');
    for (const kind of [
      "receive_uom_disagreement",
      "receive_base_unit_pack_conflict",
      "receive_cost_variance_soft",
      "receive_cost_variance_hard",
      "receive_variant_base_unit_misconfig",
      "receive_variant_missing_parent",
    ]) {
      expect(procurementSchema).toContain(`'${kind}'`);
    }
    // Ledger transaction type for reversal audit rows.
    expect(inventorySchema).toContain('"receipt_reversal"');
  });
});
