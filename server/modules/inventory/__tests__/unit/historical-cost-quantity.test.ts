import { describe, expect, it } from "vitest";
import { historicalCostQuantityGap } from "../../domain/historical-cost-quantity";

describe("historical cost quantity reconciliation", () => {
  it("retains the four-case and one-box discrepancies without treating them as sales", () => {
    expect(historicalCostQuantityGap({ originalQuantity: 220, onHandQuantity: 157, recordedOutflowQuantity: 59 }))
      .toEqual({ originalQuantity: 220, onHandQuantity: 157, recordedOutflowQuantity: 59, unresolvedQuantity: 4 });
    expect(historicalCostQuantityGap({ originalQuantity: 20, onHandQuantity: 0, recordedOutflowQuantity: 19 })?.unresolvedQuantity).toBe(1);
  });
  it.each([[100, 60, 40], [100, 0, 100], [100, 100, 0], [2_147_483_647, 0, 2_147_483_647]])(
    "does not invent a gap for reconciled original %i, stock %i, outflow %i", (originalQuantity, onHandQuantity, recordedOutflowQuantity) => {
      expect(historicalCostQuantityGap({ originalQuantity, onHandQuantity, recordedOutflowQuantity })).toBeNull();
    },
  );
  it("never mutates the source snapshot", () => {
    const input = Object.freeze({ originalQuantity: 20, onHandQuantity: 0, recordedOutflowQuantity: 19 });
    historicalCostQuantityGap(input);
    expect(input).toEqual({ originalQuantity: 20, onHandQuantity: 0, recordedOutflowQuantity: 19 });
  });
  it.each([
    { originalQuantity: 0, onHandQuantity: 0, recordedOutflowQuantity: 0 },
    { originalQuantity: 1, onHandQuantity: 2, recordedOutflowQuantity: 0 },
    { originalQuantity: 20, onHandQuantity: 1, recordedOutflowQuantity: 20 },
    { originalQuantity: 20, onHandQuantity: -1, recordedOutflowQuantity: 19 },
    { originalQuantity: 20, onHandQuantity: 0, recordedOutflowQuantity: -1 },
    { originalQuantity: 20.1, onHandQuantity: 0, recordedOutflowQuantity: 0 },
    { originalQuantity: 2_147_483_648, onHandQuantity: 0, recordedOutflowQuantity: 0 },
    { originalQuantity: NaN, onHandQuantity: 0, recordedOutflowQuantity: 0 },
  ])("rejects invalid or excessive recorded quantities %j", input => {
    expect(() => historicalCostQuantityGap(input)).toThrow();
  });
});
