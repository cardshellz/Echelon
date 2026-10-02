import { describe, expect, it } from "vitest";
import type { SupplySnapshotContentDto } from "@shared/types/inventory-availability-planner";
import { hubReserveSupply } from "../fixtures/inventory-hub-reserve.fixture";
import { planCanonicalClaim, projectCanonicalAtp, projectCanonicalAtpWarehouseBreakdown, sealSupplySnapshot } from "../../domain/inventory-availability-planner";

describe("hub ATP includes its linked reserve warehouses", () => {
  it("restores the B200/C2000 promise without including unrelated warehouses", () => {
    const snapshot = sealSupplySnapshot(hubReserveSupply());
    const before = structuredClone(snapshot);
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "warehouse", warehouseId: 1 } }))
      .toMatchObject({ atpUnits: "1985", directUnits: "5", convertibleUnits: "1980", blockers: [] });
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 174, scope: { kind: "warehouse", warehouseId: 1 } }).atpUnits).toBe("198");
    expect(snapshot).toEqual(before);
  });

  it("counts each physical warehouse once in network ATP and does not widen a reserve to its parent", () => {
    const snapshot = sealSupplySnapshot(hubReserveSupply());
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "network" } }).atpUnits).toBe("2055");
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "warehouse", warehouseId: 2 } }).atpUnits).toBe("1500");
  });

  it("deduplicates overlapping channel roots without relabeling reserve stock as hub stock", () => {
    const snapshot = sealSupplySnapshot(hubReserveSupply());
    for (const roots of [[1], [1, 2], [2, 1, 2, 1]]) {
      const breakdown = projectCanonicalAtpWarehouseBreakdown(snapshot, 173, roots);
      expect(breakdown.map(row => [row.warehouseId, row.projection.atpUnits]))
        .toEqual([[1, "485"], [2, "1500"]]);
    }
    expect(projectCanonicalAtpWarehouseBreakdown(snapshot, 173, [])).toEqual([]);
  });

  const exclusions: Array<[string, (supply: SupplySnapshotContentDto) => void]> = [
    ["unlinked reserve", supply => { supply.warehouses[1].hubWarehouseId = null; }],
    ["inactive reserve", supply => { supply.warehouses[1].isActive = false; }],
    ["inactive bin", supply => { supply.locations[2].isActive = false; }],
    ["frozen bin", supply => { supply.locations[2].isFrozen = true; }],
    ["receiving bin", supply => { supply.locations[2].locationType = "receiving"; }],
    ["staging bin", supply => { supply.locations[2].locationType = "staging"; }],
    ["quarantine bin", supply => { supply.locations[2].locationType = "quarantine"; }],
    ["explicit promise exclusion", supply => {
      supply.locations[2].promisePolicy = { policyId: 1, version: 1, lifecycleSelection: "active_head",
        eligibilityMode: "ineligible", definitionHash: "b".repeat(64) };
    }],
    ["fully reserved bin", supply => { supply.inventoryPositions[2].reservedQty = "150"; }],
  ];
  it.each(exclusions)("keeps %s out of hub ATP", (_name, exclude) => {
    const supply = hubReserveSupply();
    exclude(supply);
    const snapshot = sealSupplySnapshot(supply);
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "warehouse", warehouseId: 1 } }).atpUnits).toBe("485");
  });

  it("does not bypass an inactive or missing hub through its reserve link", () => {
    const supply = hubReserveSupply();
    supply.warehouses[0].isActive = false;
    const snapshot = sealSupplySnapshot(supply);
    for (const warehouseId of [1, 999]) {
      expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "warehouse", warehouseId } }))
        .toMatchObject({ atpUnits: "0", blockers: [expect.objectContaining({ code: "WAREHOUSE_NOT_ACTIVE" })] });
    }
  });

  it("applies reserve-specific safety and existing reservations once, before conversion", () => {
    const supply = hubReserveSupply();
    supply.inventoryPositions[2].reservedQty = "3";
    supply.safetyPolicies.push({ ...supply.safetyPolicies[0], policyId: 2, scopeKey: "warehouse:2:variant:174",
      scopeType: "warehouse_variant", productVariantId: 174, warehouseId: 2, policyMode: "fixed_units", fixedUnits: "10" });
    const snapshot = sealSupplySnapshot(supply);
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "warehouse", warehouseId: 1 } }).atpUnits).toBe("1855");
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 174, scope: { kind: "warehouse", warehouseId: 1 } }))
      .toMatchObject({ atpUnits: "185", exactPhysicalUnits: "199", claimedUnits: "4", protectedUnits: "10" });
  });

  it("retains direct stock but adds no converted stock when the path is blocked", () => {
    const supply = hubReserveSupply();
    supply.transformationModels[0].paths[0].authorityState = "blocked";
    const snapshot = sealSupplySnapshot(supply);
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "warehouse", warehouseId: 1 } }).atpUnits).toBe("5");
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 174, scope: { kind: "warehouse", warehouseId: 1 } }).atpUnits).toBe("198");
  });

  it("validates the breakdown boundary and snapshot fingerprint", () => {
    const snapshot = sealSupplySnapshot(hubReserveSupply());
    expect(() => projectCanonicalAtpWarehouseBreakdown(snapshot, 173, [-1])).toThrow();
    expect(() => projectCanonicalAtpWarehouseBreakdown(snapshot, 1.5, [1])).toThrow();
    expect(() => projectCanonicalAtpWarehouseBreakdown(snapshot, 999, [1])).toThrow(/target variant/);
    snapshot.warehouses[1].hubWarehouseId = null;
    expect(() => projectCanonicalAtpWarehouseBreakdown(snapshot, 173, [1])).toThrow(/fingerprint/);
  });

  it("keeps the one-hop hub contract deterministic without widening through chains or cycles", () => {
    const supply = hubReserveSupply();
    supply.warehouses[2].hubWarehouseId = 2;
    supply.warehouses[0].hubWarehouseId = 2;
    supply.warehouses.reverse();
    const snapshot = sealSupplySnapshot(supply);
    expect(projectCanonicalAtpWarehouseBreakdown(snapshot, 173, [1]).map(row => row.warehouseId)).toEqual([1, 2]);
    expect(projectCanonicalAtp(snapshot, { targetVariantId: 173, scope: { kind: "network" } }).atpUnits).toBe("2055");
  });

  it("keeps claim resources in the actual buildings and prevents a basket from spending the same cases twice", () => {
    const snapshot = sealSupplySnapshot(hubReserveSupply());
    const plan = planCanonicalClaim(snapshot, { requestKey: "hub-basket", scope: { kind: "warehouse", warehouseId: 1 }, lines: [
      { lineKey: "boxes", targetVariantId: 173, requestedQty: "500" },
      { lineKey: "cases", targetVariantId: 174, requestedQty: "149" },
    ] });
    expect(plan.lines).toMatchObject([{ plannedQty: "500", shortfallQty: "0" }, { plannedQty: "148", shortfallQty: "1" }]);
    expect(plan.resourceClaims).toEqual(expect.arrayContaining([
      expect.objectContaining({ lineKey: "boxes", warehouseId: 2, warehouseLocationId: 21, inventoryLevelId: 3, sourceVariantId: 174, claimedQty: "2" }),
      expect.objectContaining({ lineKey: "cases", warehouseId: 2, warehouseLocationId: 21, inventoryLevelId: 3, sourceVariantId: 174, claimedQty: "148" }),
    ]));
    expect(plan.resourceClaims.some(resource => resource.warehouseId === 3)).toBe(false);
    // A promise does not fabricate a local output bin or move reserve stock.
    expect(plan.operations.find(operation => operation.warehouseId === 2)).toMatchObject({ outputLocationId: null });
  });
});
