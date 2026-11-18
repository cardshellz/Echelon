import { describe, expect, it } from "vitest";
import { caseBreakTargetQty, caseBreakTargetsForSource } from "../case-break-targets";
import type { AllowedInventoryConversion } from "@shared/types/inventory-conversions";

// Mirrors GLV-MAG-180PT: P50 (L1), C2500 (L3), C5000 (L3).
const p50 = { id: 109, productId: 54, unitsPerVariant: 50, hierarchyLevel: 1 };
const c2500 = { id: 779, productId: 54, unitsPerVariant: 2500, hierarchyLevel: 3 };
const c5000 = { id: 110, productId: 54, unitsPerVariant: 5000, hierarchyLevel: 3 };
const variants = [p50, c2500, c5000];

const rule = (
  sourceVariantId: number,
  destinationVariantId: number,
  outputQty: number,
  operationType: AllowedInventoryConversion["operationType"] = "break_pack",
  inputQty = 1,
): AllowedInventoryConversion => ({ sourceVariantId, destinationVariantId, operationType, inputQty, outputQty });

const activeModel = [
  rule(110, 109, 100),
  rule(779, 109, 50),
  rule(109, 110, 1, "assemble_pack", 100),
  rule(110, 779, 2),
];

describe("caseBreakTargetsForSource", () => {
  it("offers a same-hierarchy-level case when a break direction is saved", () => {
    const targets = caseBreakTargetsForSource(c5000, variants, activeModel);
    expect(targets.map(t => t.target.id)).toEqual([779, 109]);
    expect(targets[0].conversion).toEqual(rule(110, 779, 2));
  });

  it("offers nothing when no break direction is saved, even for lower-level variants", () => {
    expect(caseBreakTargetsForSource(c5000, variants, [])).toEqual([]);
  });

  it("never treats assemble, recipe, reverse or malformed rules as break targets", () => {
    const rules = [
      rule(109, 110, 1, "assemble_pack", 100),
      rule(110, 779, 2, "directed_conversion"),
      rule(779, 110, 1),
      { ...rule(110, 779, 2), inputQty: 0 },
      { sourceVariantId: "110", destinationVariantId: 779 },
      null,
    ];
    expect(caseBreakTargetsForSource(c5000, variants, rules)).toEqual([]);
  });

  it("ignores targets from another product, unknown variants, self-paths and duplicates", () => {
    const foreign = { id: 5, productId: 99, unitsPerVariant: 10, hierarchyLevel: 1 };
    const rules = [rule(110, 5, 500), rule(110, 4242, 1), rule(110, 110, 1), rule(110, 779, 2), rule(110, 779, 2)];
    const targets = caseBreakTargetsForSource(c5000, [...variants, foreign], rules);
    expect(targets.map(t => t.target.id)).toEqual([779]);
  });
});

describe("caseBreakTargetQty", () => {
  it("uses the saved rule's quantities", () => {
    expect(caseBreakTargetQty(3, rule(110, 779, 2))).toBe(6);
    expect(caseBreakTargetQty(1, rule(110, 109, 100))).toBe(100);
  });

  it("returns null for fractional output and invalid source quantities", () => {
    expect(caseBreakTargetQty(1, rule(110, 779, 3, "break_pack", 2))).toBeNull();
    expect(caseBreakTargetQty(2, rule(110, 779, 3, "break_pack", 2))).toBe(3);
    expect(caseBreakTargetQty(0, rule(110, 779, 2))).toBeNull();
    expect(caseBreakTargetQty(-1, rule(110, 779, 2))).toBeNull();
    expect(caseBreakTargetQty(1.5, rule(110, 779, 2))).toBeNull();
  });
});
