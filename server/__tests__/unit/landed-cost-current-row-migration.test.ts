import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource("migrations", "156_landed_cost_current_row_uniqueness.sql");
const schema = readNormalizedSource("shared", "schema", "procurement.schema.ts");

describe("landed cost current-row uniqueness migration", () => {
  it("fails closed when existing financial projections contain duplicates", () => {
    expect(migration).toContain("GROUP BY shipment_cost_id, inbound_shipment_line_id");
    expect(migration).toContain("GROUP BY inbound_shipment_line_id");
    expect(migration).toContain("HAVING COUNT(*) > 1");
    expect(migration).toContain("require manual reconciliation");
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });

  it("enforces one allocation per cost-line pair and one snapshot per shipment line", () => {
    expect(migration).toContain("inbound_freight_allocations_cost_line_uidx");
    expect(migration).toContain("(shipment_cost_id, inbound_shipment_line_id)");
    expect(migration).toContain("landed_cost_snapshots_shipment_line_uidx");
    expect(migration).toContain("(inbound_shipment_line_id)");
  });

  it("keeps the Drizzle schema aligned with both unique indexes", () => {
    expect(schema).toContain('uniqueIndex("inbound_freight_allocations_cost_line_uidx")');
    expect(schema).toContain('.on(table.shipmentCostId, table.inboundShipmentLineId)');
    expect(schema).toContain('uniqueIndex("landed_cost_snapshots_shipment_line_uidx")');
    expect(schema).toContain('.on(table.inboundShipmentLineId)');
    expect(schema).toContain('.where(sql`${table.inboundShipmentLineId} IS NOT NULL`)');
  });
});
