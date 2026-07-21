import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource("migrations", "155_receipt_line_idempotency.sql");
const schema = readNormalizedSource("shared", "schema", "inventory.schema.ts");
const receiveUseCase = readNormalizedSource(
  "server",
  "modules",
  "inventory",
  "application",
  "inventory.use-cases.ts",
);

describe("receipt line idempotency migration", () => {
  it("keys new receipt ledger rows by the exact receiving line", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS receiving_line_id integer");
    expect(migration).toContain("FOREIGN KEY (receiving_line_id)");
    expect(migration).toContain("REFERENCES procurement.receiving_lines(id)");
    expect(migration).toContain("DROP INDEX IF EXISTS inventory.uq_inventory_transactions_receipt_dedup");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_line_dedup");
    expect(migration).toContain("ON inventory.inventory_transactions (receiving_line_id)");
    expect(migration).toContain("receiving_line_id IS NOT NULL");
  });

  it("retains replay protection for legacy callers without a receiving line", () => {
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_transactions_receipt_legacy_dedup");
    expect(migration).toContain("receiving_line_id IS NULL");
    expect(migration).toContain("receiving_order_id, product_variant_id, to_location_id");
  });

  it("keeps schema and receive behavior aligned with the migration", () => {
    expect(schema).toContain("receivingLineId: integer(\"receiving_line_id\")");
    expect(schema).toContain("references(() => receivingLines.id)");
    expect(receiveUseCase).toContain("receivingLineId?: number");
    expect(receiveUseCase).toContain("AND receiving_line_id = ${params.receivingLineId}");
    expect(receiveUseCase).toContain("receivingLineId: params.receivingLineId ?? null");
  });
});
