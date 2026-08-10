import { describe, it, expect } from "vitest";
import {
  evaluateReceiveWarnings,
  DEFAULT_COST_VARIANCE_WARN_PCT,
  __testing__,
} from "../../receive-validation.service";

/**
 * Spec D, Part 2 — receive-time validation warnings.
 *
 * Each detector is exercised on its trigger AND its non-trigger boundary:
 *   1. uom_disagreement (variant upv vs PO line UOM fields)
 *   2. base_unit_pack_conflict (is_base_unit variant vs PO pack > 1)
 *   3. cost_variance_soft (> ±25% default; configurable)
 *   4. cost_variance_hard (> 5× or < 0.2×)
 *   5. variant_base_unit_misconfig (upv > 1 && is_base_unit)
 *   6. variant_missing_parent (no parent while siblings have one)
 *
 * Plus the dogfood case: case variant misconfigured as base unit posting
 * 360 cases as 360 pieces triggers both UOM and base-unit warnings.
 */

const baseInput = {
  receivingLineId: 1001,
  purchaseOrderLineId: 5001,
  receivedQty: 360,
};

describe("evaluateReceiveWarnings — UOM disagreement", () => {
  it("fires when variant upv disagrees with PO expected_receive_units_per_variant", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 1, isBaseUnit: true },
      poLine: {
        id: 5001,
        orderQty: 270000,
        expectedReceiveUnitsPerVariant: 750,
        unitsPerUom: 750,
      },
    });
    const uom = warnings.find((w) => w.kind === "uom_disagreement");
    expect(uom).toBeDefined();
    expect(uom!.severity).toBe("warn");
    expect(uom!.payload).toMatchObject({
      variantUnitsPerVariant: 1,
      poImpliedPackSize: 750,
    });
  });

  it("falls back to legacy units_per_uom when expected_receive_units_per_variant is unset", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 12 },
      poLine: { id: 5001, orderQty: 1200, unitsPerUom: 24, expectedReceiveUnitsPerVariant: null },
    });
    expect(warnings.some((w) => w.kind === "uom_disagreement")).toBe(true);
  });

  it("does not fire when variant upv matches the PO line", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 750 },
      poLine: { id: 5001, orderQty: 270000, expectedReceiveUnitsPerVariant: 750 },
    });
    expect(warnings.some((w) => w.kind === "uom_disagreement")).toBe(false);
  });

  it("does not fire when the PO line implies pieces (pack size 1)", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 1 },
      poLine: { id: 5001, orderQty: 100, expectedReceiveUnitsPerVariant: 1, unitsPerUom: 1 },
    });
    expect(warnings.some((w) => w.kind === "uom_disagreement")).toBe(false);
  });

  it("fires base_unit_pack_conflict when a base-unit variant receives against a pack-sized PO line", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 1, isBaseUnit: true },
      poLine: { id: 5001, orderQty: 270000, expectedReceiveUnitsPerVariant: 750 },
    });
    const conflict = warnings.find((w) => w.kind === "base_unit_pack_conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.detail).toContain("March 2026");
  });

  it("dogfood: case variant misconfigured as base unit triggers both UOM warnings", () => {
    // PO-20260317-001 shape: orderQty 270,000 pieces, UOM 750/case; the
    // receiving variant is the misconfigured base-unit "case".
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 1, isBaseUnit: true, name: "Each" },
      poLine: {
        id: 5001,
        orderQty: 270000,
        expectedReceiveUnitsPerVariant: 750,
        unitsPerUom: 750,
        unitCostMills: 44,
      },
      unitCostMills: 44,
    });
    const kinds = warnings.map((w) => w.kind);
    expect(kinds).toContain("uom_disagreement");
    expect(kinds).toContain("base_unit_pack_conflict");
  });
});

describe("evaluateReceiveWarnings — cost variance", () => {
  const poLine = {
    id: 5001,
    orderQty: 1000,
    unitCostMills: 10000, // $1.0000 per piece
  };

  it("fires soft warning beyond ±25% (default threshold)", () => {
    // $1.30 vs $1.00 = +30%.
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      unitCostMills: 13000,
      poLine,
    });
    const soft = warnings.find((w) => w.kind === "cost_variance_soft");
    expect(soft).toBeDefined();
    expect(soft!.severity).toBe("warn");
  });

  it("does not fire within ±25%", () => {
    // $1.25 vs $1.00 = exactly +25% → NOT over the threshold.
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      unitCostMills: 12500,
      poLine,
    });
    expect(warnings.some((w) => w.kind === "cost_variance_soft")).toBe(false);
    expect(warnings.some((w) => w.kind === "cost_variance_hard")).toBe(false);
  });

  it("respects a configured threshold", () => {
    // +30% with a 50% threshold → no warning.
    const warnings = evaluateReceiveWarnings(
      { ...baseInput, unitCostMills: 13000, poLine },
      { costVarianceWarnPct: 50 },
    );
    expect(warnings.some((w) => w.kind === "cost_variance_soft")).toBe(false);
  });

  it("fires hard warning at > 5× (order of magnitude)", () => {
    // $6.00 vs $1.00 = 6×.
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      unitCostMills: 60000,
      poLine,
    });
    const hard = warnings.find((w) => w.kind === "cost_variance_hard");
    expect(hard).toBeDefined();
    expect(hard!.severity).toBe("error");
    // Hard supersedes soft.
    expect(warnings.some((w) => w.kind === "cost_variance_soft")).toBe(false);
  });

  it("fires hard warning at < 0.2×", () => {
    // $0.10 vs $1.00 = 0.1×.
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      unitCostMills: 1000,
      poLine,
    });
    expect(warnings.some((w) => w.kind === "cost_variance_hard")).toBe(true);
  });

  it("boundary: exactly 5× is NOT hard (must exceed)", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      unitCostMills: 50000,
      poLine,
    });
    expect(warnings.some((w) => w.kind === "cost_variance_hard")).toBe(false);
    // But it IS soft (> 25%).
    expect(warnings.some((w) => w.kind === "cost_variance_soft")).toBe(true);
  });

  it("derives mills from cents when mills are absent", () => {
    // 130 cents = 13000 mills = +30% vs $1.00.
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      unitCostCents: 130,
      poLine: { ...poLine, unitCostMills: null, unitCostCents: 100 },
    });
    expect(warnings.some((w) => w.kind === "cost_variance_soft")).toBe(true);
  });

  it("stays silent when either side has no cost", () => {
    expect(
      evaluateReceiveWarnings({ ...baseInput, poLine }).some((w) =>
        w.kind.startsWith("cost_variance"),
      ),
    ).toBe(false);
    expect(
      evaluateReceiveWarnings({
        ...baseInput,
        unitCostMills: 99999,
        poLine: { ...poLine, unitCostMills: null, unitCostCents: null },
      }).some((w) => w.kind.startsWith("cost_variance")),
    ).toBe(false);
  });
});

describe("evaluateReceiveWarnings — variant config sanity", () => {
  it("flags a case-sized variant marked is_base_unit", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 750, isBaseUnit: true, name: "Case of 750" },
    });
    const w = warnings.find((x) => x.kind === "variant_base_unit_misconfig");
    expect(w).toBeDefined();
    expect(w!.detail).toContain("750");
  });

  it("does not flag a base-unit variant with pack size 1", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 1, isBaseUnit: true, name: "Each" },
    });
    expect(warnings.some((x) => x.kind === "variant_base_unit_misconfig")).toBe(false);
  });

  it("flags a case variant missing parent_variant_id when siblings have one", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 50, isBaseUnit: false, parentVariantId: null },
      siblingsHaveParent: true,
    });
    expect(warnings.some((x) => x.kind === "variant_missing_parent")).toBe(true);
  });

  it("does not flag missing parent when no siblings have one", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 50, parentVariantId: null },
      siblingsHaveParent: false,
    });
    expect(warnings.some((x) => x.kind === "variant_missing_parent")).toBe(false);
  });

  it("does not flag when the variant has a parent", () => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput,
      variant: { id: 11, unitsPerVariant: 50, parentVariantId: 10 },
      siblingsHaveParent: true,
    });
    expect(warnings.some((x) => x.kind === "variant_missing_parent")).toBe(false);
  });
});

describe("receive-validation helpers (pure)", () => {
  const { isHardVariance, isSoftVariance, resolvePoImpliedPackSize, normalizeWarnPct } = __testing__;

  it("hard variance uses integer cross-multiplication (no float drift)", () => {
    expect(isHardVariance(50001, 10000)).toBe(true);  // just over 5×
    expect(isHardVariance(50000, 10000)).toBe(false); // exactly 5×
    expect(isHardVariance(1999, 10000)).toBe(true);   // just under 0.2×
    expect(isHardVariance(2000, 10000)).toBe(false);  // exactly 0.2×
  });

  it("soft variance boundary is exact", () => {
    expect(isSoftVariance(12501, 10000, 25)).toBe(true);
    expect(isSoftVariance(12500, 10000, 25)).toBe(false);
  });

  it("PO implied pack prefers expected_receive_units_per_variant", () => {
    expect(resolvePoImpliedPackSize({ expectedReceiveUnitsPerVariant: 750, unitsPerUom: 24 })).toBe(750);
    expect(resolvePoImpliedPackSize({ expectedReceiveUnitsPerVariant: null, unitsPerUom: 24 })).toBe(24);
    expect(resolvePoImpliedPackSize({ expectedReceiveUnitsPerVariant: null, unitsPerUom: null })).toBeNull();
  });

  it("warn pct normalization falls back to default on garbage", () => {
    expect(normalizeWarnPct(undefined)).toBe(DEFAULT_COST_VARIANCE_WARN_PCT);
    expect(normalizeWarnPct(NaN)).toBe(DEFAULT_COST_VARIANCE_WARN_PCT);
    expect(normalizeWarnPct(-5)).toBe(DEFAULT_COST_VARIANCE_WARN_PCT);
    expect(normalizeWarnPct(50)).toBe(50);
  });
});
