import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  evaluateReceiveWarnings,
  ReceiveValidationService,
  DEFAULT_COST_VARIANCE_WARN_PCT,
  __testing__,
} from "../../receive-validation.service";

/** Receipt commands validate and freeze the count configuration. Warnings
 * compare per-piece costs only; PO preferences cannot override that receipt. */

const baseInput = {
  receivingLineId: 1001,
  purchaseOrderLineId: 5001,
  receivedQty: 360,
};

describe("saved receipt configuration owns the receive unit", () => {
  it.each([
    { receivePack: 10000, poPack: 1, legacyPack: 1 },
    { receivePack: 5000, poPack: 1, legacyPack: 1 },
    { receivePack: 1000, poPack: 1, legacyPack: 1 },
    { receivePack: 800, poPack: 1, legacyPack: 1 },
    { receivePack: 1, poPack: 750, legacyPack: 750 },
    { receivePack: 50, poPack: 100, legacyPack: 24 },
    { receivePack: 10000, poPack: null, legacyPack: 1 },
    { receivePack: 50, poPack: null, legacyPack: null },
  ])("accepts saved pack $receivePack with PO preference $poPack", ({ receivePack, poPack, legacyPack }) => {
    const warnings = evaluateReceiveWarnings({
      ...baseInput, unitCostMills: 10000,
      variant: { id: 11, unitsPerVariant: receivePack, isBaseUnit: receivePack === 1 },
      poLine: { id: 5001, orderQty: 800000, unitCostMills: 10000,
        expectedReceiveUnitsPerVariant: poPack, unitsPerUom: legacyPack },
    });
    expect(warnings).toEqual([]);
  });

  it("does not turn catalog classification or parent metadata into a receipt warning", () => {
    expect(evaluateReceiveWarnings({ ...baseInput,
      variant: { id: 11, unitsPerVariant: 10000, isBaseUnit: true, parentVariantId: null, name: "Case of 10000" },
      poLine: { id: 5001, expectedReceiveUnitsPerVariant: 1 }, siblingsHaveParent: true,
    })).toEqual([]);
  });

  it("still reports a genuine per-piece price variance for a different receiving pack", () => {
    const warnings = evaluateReceiveWarnings({ ...baseInput, unitCostMills: 13000,
      variant: { id: 11, unitsPerVariant: 10000 },
      poLine: { id: 5001, expectedReceiveUnitsPerVariant: 1, unitCostMills: 10000 },
    });
    expect(warnings.map(warning => warning.kind)).toEqual(["cost_variance_soft"]);
    expect(warnings[0].payload).toMatchObject({ actualUnitCostMills: 13000, poUnitCostMills: 10000 });
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

describe("receive-validation helpers (pure)", () => {
  const { isHardVariance, isSoftVariance, resolvePerPieceMills, normalizeWarnPct } = __testing__;

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

  it("keeps maximum safe monetary values exact and rejects overflowing cents conversion", () => {
    expect(isHardVariance(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(isSoftVariance(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 25)).toBe(false);
    expect(resolvePerPieceMills(null, Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(resolvePerPieceMills(0, 100)).toBe(0);
    expect(resolvePerPieceMills(null, 100)).toBe(10000);
  });

  it("warn pct normalization falls back to default on garbage", () => {
    expect(normalizeWarnPct(undefined)).toBe(DEFAULT_COST_VARIANCE_WARN_PCT);
    expect(normalizeWarnPct(NaN)).toBe(DEFAULT_COST_VARIANCE_WARN_PCT);
    expect(normalizeWarnPct(-5)).toBe(DEFAULT_COST_VARIANCE_WARN_PCT);
    expect(normalizeWarnPct(50)).toBe(50);
  });
});


describe("ReceiveValidationService per-piece cost read", () => {
  const row = (id: number, overrides: Record<string, unknown> = {}) => ({
    receiving_line_id: id, purchase_order_line_id: 5000 + id, received_qty: 80,
    unit_cost: null, unit_cost_mills: "10000", matched_po_line_id: 5000 + id,
    po_unit_cost_cents: null, po_unit_cost_mills: "10000", ...overrides,
  });

  it("reads an entire multi-pack receipt without consulting catalog or PO pack preferences", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: Array.from({ length: 10 }, (_, index) => row(index + 1)) });
    expect(await new ReceiveValidationService({ execute }).evaluateOrder(31)).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([31]);
    expect(query.sql).not.toMatch(/catalog\.product_variants|units_per_variant|units_per_uom|expected_receive_units_per_variant/);
  });

  it("attributes a real cost warning to its receipt and purchase line", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [row(7), row(8, { unit_cost_mills: "14000" })] });
    const warnings = await new ReceiveValidationService({ execute }).evaluateOrder(31);
    expect(warnings).toMatchObject([{ kind: "cost_variance_soft", receivingLineId: 8, purchaseOrderLineId: 5008 }]);
    expect(warnings).toHaveLength(1);
  });

  it("retains a configured threshold and accepts a blind receipt without a matching PO price", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [row(7, { unit_cost_mills: "14000" }), row(8, { matched_po_line_id: null })] });
    const getSetting = vi.fn().mockResolvedValue("50");
    expect(await new ReceiveValidationService({ execute }, getSetting).evaluateOrder(31)).toEqual([]);
    expect(getSetting).toHaveBeenCalledWith("receiving_cost_variance_warn_pct");
  });

  it("propagates an unavailable read instead of pretending there are no warnings", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("cost review read unavailable"));
    await expect(new ReceiveValidationService({ execute }).evaluateOrder(31)).rejects.toThrow("cost review read unavailable");
  });
});
