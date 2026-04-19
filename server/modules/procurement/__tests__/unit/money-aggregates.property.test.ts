import { describe, it, expect } from "vitest";

// P0-c-4 / B1 / H25: Money Aggregates Property Test Simulator
// Validates money math constraints (round, exact cents summing) prior to bigInt migration

describe("Money Aggregate Properties (Integer Precision)", () => {
  
  function calculatePoTotalCents(lines: { qty: number, unitCostCents: number, discountCents: number, taxRate: number }[]) {
    // Current PO simulation: 
    // quantity * unitCost - discount + tax (using cents)
    return lines.reduce((total, line) => {
      const lineSubtotal = (line.qty * line.unitCostCents) - line.discountCents;
      const taxAmount = Math.round(lineSubtotal * line.taxRate); 
      const lineTotal = lineSubtotal + taxAmount;
      return total + lineTotal;
    }, 0);
  }

  it("should rigidly compute large integers without floating point decay", () => {
    // 50 million units at $123.45 ($6 billion) -> 617,250,000,000 cents
    const result = calculatePoTotalCents([
      { qty: 50_000_000, unitCostCents: 12345, discountCents: 0, taxRate: 0 }
    ]);
    expect(result).toBe(617250000000);
    // Ensure Node doesn't consider it unsafe yet
    expect(Number.isSafeInteger(result)).toBe(true);
  });

  it("should accurately round sub-cent tax calculations to the nearest cent", () => {
    // $10.00 unit cost at 8.125% tax.
    // tax = $0.8125 -> 81.25 cents -> Math.round -> 81 cents
    // total = 1081 cents
    const result = calculatePoTotalCents([
      { qty: 1, unitCostCents: 1000, discountCents: 0, taxRate: 0.08125 }
    ]);
    expect(result).toBe(1081);
  });

  it("should compute AP Invoice 3-way match delta correctly based on exact cents", () => {
    const poTotalCents = calculatePoTotalCents([
      { qty: 100, unitCostCents: 455, discountCents: 500, taxRate: 0 } // Net: 45500 - 500 = 45000
    ]);
    
    // Assume AP invoice claims 451.05 total (freight etc)
    const apTotalCents = 45105;
    const delta = apTotalCents - poTotalCents; // delta = 105 cents = $1.05

    expect(delta).toBe(105);
  });

  it("preserves sum identity regardless of permutation order for integer aggregations", () => {
    const lineA = { qty: 25, unitCostCents: 1111, discountCents: 0, taxRate: 0.05 };
    const lineB = { qty: 3, unitCostCents: 99999, discountCents: 15, taxRate: 0.07 };
    
    // (A then B) vs (B then A)
    const sumOrder1 = calculatePoTotalCents([lineA, lineB]);
    const sumOrder2 = calculatePoTotalCents([lineB, lineA]);
    
    expect(sumOrder1).toStrictEqual(sumOrder2);
  });
});
