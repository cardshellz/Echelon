import { describe, it, expect } from "vitest";
import { parseLotCostCsvRow } from "../../cogs.service";

describe("parseLotCostCsvRow (sku + per-piece)", () => {
  it("parses sku + cost_per_piece (dollars) to per-piece mills", () => {
    expect(parseLotCostCsvRow({ sku: "ARM-ENV-SGL-P50", cost_per_piece: "0.04" })).toEqual({
      ok: true, sku: "ARM-ENV-SGL-P50", costPerPieceMills: 400,
    });
  });

  it("preserves sub-cent precision in mills ($1 = 10,000 mills)", () => {
    expect(parseLotCostCsvRow({ sku: "X", cost_per_piece: "0.0008" })).toEqual({
      ok: true, sku: "X", costPerPieceMills: 8,
    });
  });

  it("strips $ , and whitespace", () => {
    expect(parseLotCostCsvRow({ sku: " X ", cost_per_piece: "$1,234.5600" })).toEqual({
      ok: true, sku: "X", costPerPieceMills: 12345600,
    });
  });

  it("rejects missing sku, missing cost, non-numeric, and negative", () => {
    expect(parseLotCostCsvRow({ cost_per_piece: "1" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ sku: "X" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ sku: "X", cost_per_piece: "xyz" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ sku: "X", cost_per_piece: "-3" }).ok).toBe(false);
  });
});
