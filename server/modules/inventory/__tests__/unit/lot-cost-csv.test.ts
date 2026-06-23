import { describe, it, expect } from "vitest";
import { parseLotCostCsvRow } from "../../cogs.service";

describe("parseLotCostCsvRow (per-piece, product-keyed)", () => {
  it("parses product_id + cost_per_piece (dollars) to per-piece mills", () => {
    expect(parseLotCostCsvRow({ product_id: "33", cost_per_piece: "0.04" })).toEqual({
      ok: true, productId: 33, costPerPieceMills: 400,
    });
  });

  it("preserves sub-cent precision in mills ($1 = 10,000 mills)", () => {
    expect(parseLotCostCsvRow({ product_id: "5", cost_per_piece: "0.0008" })).toEqual({
      ok: true, productId: 5, costPerPieceMills: 8,
    });
  });

  it("strips $ , and whitespace", () => {
    expect(parseLotCostCsvRow({ product_id: " 5 ", cost_per_piece: "$1,234.5600" })).toEqual({
      ok: true, productId: 5, costPerPieceMills: 12345600,
    });
  });

  it("rejects missing/invalid product_id, missing cost, non-numeric, and negative", () => {
    expect(parseLotCostCsvRow({ cost_per_piece: "1" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ product_id: "abc", cost_per_piece: "1" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ product_id: "0", cost_per_piece: "1" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ product_id: "5" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ product_id: "5", cost_per_piece: "xyz" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ product_id: "5", cost_per_piece: "-3" }).ok).toBe(false);
  });
});
