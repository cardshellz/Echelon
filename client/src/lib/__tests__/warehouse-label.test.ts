import { describe, expect, it } from "vitest";
import { warehouseLabel } from "../warehouse-label";

describe("warehouseLabel", () => {
  const warehouses = [{ id: 1, code: "LEON", name: "20 Leonberg" }, { id: 2, code: "RTE-19", name: "RTE-19" }];
  it("identifies the building, not just its bin", () => {
    expect(warehouseLabel(1, warehouses)).toBe("LEON — 20 Leonberg");
    expect(warehouseLabel(2, warehouses)).toBe("RTE-19");
  });
  it("keeps unknown and unassigned buildings explicit", () => {
    expect(warehouseLabel(3, warehouses)).toBe("Warehouse #3");
    expect(warehouseLabel(null, warehouses)).toBe("Warehouse unassigned");
  });
});
