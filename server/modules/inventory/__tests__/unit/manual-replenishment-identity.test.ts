import { describe, expect, it } from "vitest";
import { manualReplenishmentIdentityRejection } from "../../application/create-manual-replenishment-task";

const variant = { isActive: true };
const location = (id: number, overrides: Partial<{
  warehouseId: number | null; isActive: number; isPickable: number; cycleCountFreezeId: number | null;
}> = {}) => ({ id, warehouseId: 1, isActive: 1, isPickable: 1, cycleCountFreezeId: null, ...overrides });

function check(overrides: Partial<Parameters<typeof manualReplenishmentIdentityRejection>[0]> = {}) {
  return manualReplenishmentIdentityRejection({
    replenMethod: "case_break",
    source: variant,
    destination: variant,
    from: location(10),
    to: location(20),
    ...overrides,
  });
}

describe("manualReplenishmentIdentityRejection", () => {
  it("accepts a case break between two locations", () => {
    expect(check()).toBeNull();
  });

  it("accepts a case break that stays in one location", () => {
    expect(check({ from: location(10), to: location(10) })).toBeNull();
  });

  it.each(["full_case", "pallet_drop"] as const)(
    "rejects a %s into its own location with a specific code",
    (replenMethod) => {
      expect(check({ replenMethod, from: location(10), to: location(10) })?.code)
        .toBe("MANUAL_REPLEN_SAME_LOCATION");
    },
  );

  it("still accepts a transfer between two locations", () => {
    expect(check({ replenMethod: "full_case" })).toBeNull();
  });

  it("names each failing condition", () => {
    expect(check({ source: undefined })?.code).toBe("MANUAL_REPLEN_VARIANT_NOT_FOUND");
    expect(check({ destination: { isActive: false } })?.code).toBe("MANUAL_REPLEN_VARIANT_INACTIVE");
    expect(check({ destination: { isActive: null } })?.code).toBe("MANUAL_REPLEN_VARIANT_INACTIVE");
    expect(check({ to: undefined })?.code).toBe("MANUAL_REPLEN_LOCATION_NOT_FOUND");
    expect(check({ from: location(10, { warehouseId: null }) })?.code).toBe("MANUAL_REPLEN_CROSS_WAREHOUSE");
    expect(check({ to: location(20, { warehouseId: 2 }) })?.code).toBe("MANUAL_REPLEN_CROSS_WAREHOUSE");
    expect(check({ from: location(10, { isActive: 0 }) })?.code).toBe("MANUAL_REPLEN_LOCATION_INACTIVE");
    expect(check({ to: location(20, { isPickable: 0 }) })?.code).toBe("MANUAL_REPLEN_DESTINATION_NOT_PICKABLE");
    expect(check({ from: location(10, { cycleCountFreezeId: 7 }) })?.code).toBe("MANUAL_REPLEN_LOCATION_FROZEN");
  });

  it("keeps every other rule for an in-place case break", () => {
    expect(check({ from: location(10, { isPickable: 0 }), to: location(10, { isPickable: 0 }) })?.code)
      .toBe("MANUAL_REPLEN_DESTINATION_NOT_PICKABLE");
    expect(check({ from: location(10, { cycleCountFreezeId: 3 }), to: location(10, { cycleCountFreezeId: 3 }) })?.code)
      .toBe("MANUAL_REPLEN_LOCATION_FROZEN");
    expect(check({ from: location(10, { isActive: 0 }), to: location(10, { isActive: 0 }) })?.code)
      .toBe("MANUAL_REPLEN_LOCATION_INACTIVE");
  });
});
