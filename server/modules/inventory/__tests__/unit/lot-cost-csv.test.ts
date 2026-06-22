import { describe, it, expect } from "vitest";
import { parseLotCostCsvRow } from "../../cogs.service";

describe("parseLotCostCsvRow", () => {
  it("parses sku + unit_cost (dollars) to mills; lot_number optional", () => {
    expect(parseLotCostCsvRow({ sku: "ABC", unit_cost: "1.50" })).toEqual({
      ok: true, sku: "ABC", lotNumber: null, costMills: 15000,
    });
    expect(parseLotCostCsvRow({ sku: "ABC", unit_cost: "1.50", lot_number: "LOT-RECON-1" })).toEqual({
      ok: true, sku: "ABC", lotNumber: "LOT-RECON-1", costMills: 15000,
    });
  });

  it("preserves sub-cent precision in mills ($1 = 10,000 mills)", () => {
    expect(parseLotCostCsvRow({ sku: "X", unit_cost: "1.505" })).toEqual({
      ok: true, sku: "X", lotNumber: null, costMills: 15050,
    });
  });

  it("strips $ , and whitespace", () => {
    expect(parseLotCostCsvRow({ sku: "X", unit_cost: "$1,234.56" })).toEqual({
      ok: true, sku: "X", lotNumber: null, costMills: 12345600,
    });
    expect(parseLotCostCsvRow({ sku: "  X  ", unit_cost: " 2.00 " }).ok).toBe(true);
  });

  it("rejects missing sku / unit_cost, non-numeric, and negative costs", () => {
    expect(parseLotCostCsvRow({ unit_cost: "1" })).toEqual({ ok: false, error: "missing sku" });
    expect(parseLotCostCsvRow({ sku: "X" })).toEqual({ ok: false, error: "missing unit_cost" });
    expect(parseLotCostCsvRow({ sku: "X", unit_cost: "abc" }).ok).toBe(false);
    expect(parseLotCostCsvRow({ sku: "X", unit_cost: "-5" }).ok).toBe(false);
  });

  it("treats an empty lot_number as 'all un-costed lots for the SKU' (null)", () => {
    const r = parseLotCostCsvRow({ sku: "X", unit_cost: "1.00", lot_number: "" });
    expect(r.ok && r.lotNumber).toBe(null);
  });
});
