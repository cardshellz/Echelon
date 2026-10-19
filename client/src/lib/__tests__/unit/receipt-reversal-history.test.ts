import { describe, expect, it } from "vitest";
import { parseReceiptReversalHistory } from "../../receipt-reversal-history";
const row = { id: 61, receivingOrderId: 31, receivingLineId: 7, qty: 2, reason: "Reviewed correction", reversalScope: "line",
  orderReversalId: null, baseUnitsReversed: 20, lotUnitCostMills: 2500, allowNegative: false, apReconciliationReopened: true,
  idempotencyKey: "legacy-key", createdBy: "operator-a", createdAt: "2026-10-19T12:00:00Z" };
describe("receipt reversal history boundary", () => {
  it("accepts verified empty and populated arrays without changing source rows", () => {
    expect(parseReceiptReversalHistory([], 31)).toEqual([]); expect(parseReceiptReversalHistory([row], 31)).toEqual([row]);
    expect(parseReceiptReversalHistory([{ ...row, createdBy: null, baseUnitsReversed: null, lotUnitCostMills: null }], 31)).toHaveLength(1);
  });
  it.each([{}, { reversals: [] }, [row, row], [{ ...row, receivingOrderId: 99 }], [{ ...row, createdAt: "bad" }],
    [{ ...row, qty: 0 }], [{ ...row, qty: 0.5 }], [{ ...row, allowNegative: 1 }]].map(raw => ({ raw })))("fails closed for malformed audit evidence $raw", ({ raw }) => {
    expect(() => parseReceiptReversalHistory(raw, 31)).toThrow(/could not be verified/);
  });
});
