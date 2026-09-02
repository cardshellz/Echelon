/**
 * Structural contract for how wms-sync stamps a bin onto a WMS order line.
 *
 * 2026-09: SHLZ-MAG-STND-P5 was assigned to E-12 in Slotting Setup, yet every
 * order line synced as UNASSIGNED because the resolver required
 * `is_primary = 1` and a pre-2026-05-14 writer bug had cleared that flag on
 * the SKU's only slot row. The flag must rank candidates, never gate them.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(resolve(__dirname, "../../wms-sync.service.ts"), "utf-8");
const RESOLVER = SRC.match(/async function resolveAssignedBinLocation\([\s\S]*?\n}\n/)?.[0] ?? "";

describe("wms-sync.service :: order-line bin resolution", () => {
  it("ranks the primary flag through the shared candidate selector instead of filtering on it", () => {
    expect(RESOLVER).not.toBe("");
    expect(RESOLVER).not.toMatch(/eq\(productLocations\.isPrimary,\s*1\)/);
    expect(RESOLVER).toContain("selectPickBinCandidate(rows)");
    expect(RESOLVER).not.toContain(".limit(1)");
    expect(SRC).toContain('import { selectPickBinCandidate } from "../warehouse/pick-bin-candidate"');
  });

  it("only considers slot rows that point at a real warehouse location", () => {
    expect(RESOLVER).toContain(".innerJoin(");
    expect(RESOLVER).toContain("eq(productLocations.warehouseLocationId, warehouseLocations.id)");
    expect(RESOLVER).toContain("eq(productLocations.productVariantId, variantId)");
  });

  it("selects every column the ranking depends on", () => {
    for (const column of [
      "slotId: productLocations.id",
      "slotStatus: productLocations.status",
      "isPrimary: productLocations.isPrimary",
      "locationIsActive: warehouseLocations.isActive",
      "locationIsPickable: warehouseLocations.isPickable",
      "locationType: warehouseLocations.locationType",
      "cycleCountFreezeId: warehouseLocations.cycleCountFreezeId",
    ]) {
      expect(RESOLVER, column).toContain(column);
    }
  });

  it("keeps the UNASSIGNED / zone U default for a variant with no bin-backed slot", () => {
    expect(SRC).toContain('location: binLocation?.location || "UNASSIGNED"');
    expect(SRC).toContain('zone: binLocation?.zone || "U"');
  });

  it("uses the ranked resolver everywhere a line's bin is derived", () => {
    expect(SRC).not.toContain("resolvePrimaryBinLocation");
    expect(SRC.match(/resolveAssignedBinLocation\(/g)?.length).toBe(4);
  });
});
