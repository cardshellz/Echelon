import { describe, expect, it } from "vitest";
import { deriveShipmentCostAdjustment as deriveAdjustment, type ShipmentAdjustmentSnapshot } from "../../domain/shipment-cost-adjustment";

const deriveShipmentCostAdjustment = (before: ShipmentAdjustmentSnapshot, after: ShipmentAdjustmentSnapshot, source: "legacy" | "exact" = "legacy") =>
  deriveAdjustment(before, after, source);

const zero = { totalLandedCostCents: 0, freightAllocatedCents: 0, dutyAllocatedCents: 0,
  insuranceAllocatedCents: 0, otherAllocatedCents: 0 };

describe("closed shipment adjustment audit", () => {
  it("labels a legacy product projection correction without claiming freight changed", () => {
    const adjustment = deriveShipmentCostAdjustment(zero, { ...zero, totalLandedCostCents: 490 });
    expect(adjustment?.adjustmentAmountCents).toBe(490);
    expect(adjustment?.reason).toContain("Legacy product projection recalculation (prior exact PO source unavailable).");
    expect(adjustment?.reason).toContain("Product projection: 0 -> 490 cents (+490)");
    expect(adjustment?.reason).toContain("Freight: 0 -> 0 cents (+0)");
    expect(adjustment?.reason).toContain("Total landed: 0 -> 490 cents (+490)");
    expect(adjustment?.reason).not.toContain("landed charge reallocation");
  });

  it("records product and charge changes separately while preserving the complete total delta", () => {
    const before = { ...zero, totalLandedCostCents: 100, freightAllocatedCents: 100 };
    const after = { ...zero, totalLandedCostCents: 640, freightAllocatedCents: 150 };
    const adjustment = deriveShipmentCostAdjustment(before, after);
    expect(adjustment?.adjustmentAmountCents).toBe(540);
    expect(adjustment?.reason).toContain("and landed charge reallocation.");
    expect(adjustment?.reason).toContain("Product projection: 0 -> 490 cents (+490)");
    expect(adjustment?.reason).toContain("Freight: 100 -> 150 cents (+50)");
    expect(adjustment?.reason).toContain("Total landed: 100 -> 640 cents (+540)");
  });

  it("distinguishes a change to an existing exact PO projection", () => {
    const adjustment = deriveShipmentCostAdjustment({ ...zero, totalLandedCostCents: 490 },
      { ...zero, totalLandedCostCents: 500 }, "exact");
    expect(adjustment?.adjustmentAmountCents).toBe(10);
    expect(adjustment?.reason).toContain("Product projection change.");
    expect(adjustment?.reason).not.toContain("Legacy");
  });

  it("retains negative and net-zero audit deltas without losing component changes", () => {
    const before = { ...zero, totalLandedCostCents: 100, freightAllocatedCents: 100 };
    const reduced = deriveShipmentCostAdjustment(before, { ...zero, totalLandedCostCents: 50, freightAllocatedCents: 50 });
    expect(reduced?.adjustmentAmountCents).toBe(-50);
    expect(reduced?.reason).toContain("Post-close landed charge reallocation.");
    const offsetting = deriveShipmentCostAdjustment(before, { ...zero, totalLandedCostCents: 100, freightAllocatedCents: 50 });
    expect(offsetting?.adjustmentAmountCents).toBe(0);
    expect(offsetting?.reason).toContain("Product projection: 0 -> 50 cents (+50)");
    expect(offsetting?.reason).toContain("Freight: 100 -> 50 cents (-50)");
  });

  it.each([null, undefined, NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, "9007199254740993", ""])(
    "rejects missing or unsafe prior total %s", (value) => {
      expect(() => deriveShipmentCostAdjustment({ ...zero, totalLandedCostCents: value }, zero)).toThrow(/explicit/);
    },
  );
  it("rejects missing components and inconsistent component sums instead of inventing zero", () => {
    expect(() => deriveShipmentCostAdjustment({ ...zero, freightAllocatedCents: null }, zero)).toThrow(/Prior freight/);
    expect(() => deriveShipmentCostAdjustment({ ...zero, freightAllocatedCents: 1 }, zero)).toThrow(/exceed/);
    expect(() => deriveShipmentCostAdjustment({ ...zero, totalLandedCostCents: Number.MAX_SAFE_INTEGER,
      freightAllocatedCents: Number.MAX_SAFE_INTEGER, dutyAllocatedCents: 1 }, zero)).toThrow(/exceed/);
  });
  it("preserves exact supported limits and does not mutate snapshots", () => {
    const before = Object.freeze({ ...zero, totalLandedCostCents: Number.MAX_SAFE_INTEGER });
    const after = Object.freeze({ ...zero });
    expect(deriveShipmentCostAdjustment(before, after)?.adjustmentAmountCents).toBe(-Number.MAX_SAFE_INTEGER);
    expect(deriveShipmentCostAdjustment(before, before)).toBeNull();
  });
});
