import { describe, expect, it } from "vitest";
import { shipmentAllocationsEqual } from "../../domain/shipment-allocation-equality";
import { buildShipmentAllocationBasis, buildShipmentAllocationEvidence } from "../../domain/shipment-allocation-basis";
import type { InsertInboundFreightAllocation } from "@shared/schema";

const basis = buildShipmentAllocationBasis([{ lineId: 1, qtyShipped: 3, totalVolumeCbm: "0.001", totalWeightKg: "1", chargeableWeightKg: "1" }], "by_line_count");
const row: InsertInboundFreightAllocation = { shipmentCostId: 7, inboundShipmentLineId: 1,
  allocatedCents: 100, allocationBasisValue: "1.000000", allocationBasisTotal: "1.000000",
  sharePercent: "100.0000", basisEvidence: buildShipmentAllocationEvidence(basis, 1) };

describe("stable allocation evidence", () => {
  it("ignores decimal padding and row ordering while preserving exact source evidence", () => {
    const second = { ...row, inboundShipmentLineId: 2 };
    expect(shipmentAllocationsEqual([row, second], [second, { ...row, sharePercent: "100", allocationBasisTotal: "1" }])).toBe(true);
    expect(shipmentAllocationsEqual([], [])).toBe(true);
  });
  it.each([
    { allocatedCents: 101 }, { allocationBasisValue: "1.000001" }, { allocationBasisTotal: "2" },
    { sharePercent: "99.9999" }, { basisEvidence: null }, { inboundShipmentLineId: 2 }, { shipmentCostId: 8 },
    { allocationBasisValue: "NaN" }, { allocationBasisValue: "broken" },
  ])("detects meaningful change or malformed saved value %j", patch => {
    expect(shipmentAllocationsEqual([{ ...row, ...patch }], [row])).toBe(false);
  });
  it("does not accept missing or duplicate product allocations", () => {
    expect(shipmentAllocationsEqual([row], [])).toBe(false);
    expect(shipmentAllocationsEqual([row, row], [row, row])).toBe(false);
    expect(shipmentAllocationsEqual([row, { ...row, inboundShipmentLineId: 2 }], [row, row])).toBe(false);
  });
});
