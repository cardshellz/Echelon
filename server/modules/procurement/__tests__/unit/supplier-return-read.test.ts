import { describe, expect, it } from "vitest";
import { sumSupplierReturnCosts, supplierReturnCreditState, projectSupplierReturnList } from "../../supplier-return-read.domain";
import { returnResult } from "../../../../../test/fixtures/supplier-return";

describe("supplier return exact read projections", () => {
  it("retains sub-cent amounts without rounding while aggregating", () => {
    expect(sumSupplierReturnCosts([{ productMills: 1, packagingMills: 99, landedMills: 101, totalMills: 201 }, { productMills: 2, packagingMills: 1, landedMills: 0, totalMills: 3 }]))
      .toEqual({ productMills: 3, packagingMills: 100, landedMills: 101, totalMills: 204 });
  });
  it("rejects unsafe aggregate totals before any lossy numeric conversion", () => {
    expect(() => sumSupplierReturnCosts([{ productMills: Number.MAX_SAFE_INTEGER, packagingMills: 0, landedMills: 0, totalMills: Number.MAX_SAFE_INTEGER }, { productMills: 1, packagingMills: 0, landedMills: 0, totalMills: 1 }])).toThrow("exact supported");
  });
  it.each([{ productMills: -1, packagingMills: 0, landedMills: 0, totalMills: -1 }, { productMills: 1, packagingMills: 0, landedMills: 0, totalMills: 2 }, { productMills: 0.5, packagingMills: 0, landedMills: 0, totalMills: 0.5 }])("rejects invalid cost evidence %j", value => {
    expect(() => sumSupplierReturnCosts([value])).toThrow();
  });
  it.each([
    [[], "unmatched"], [["unmatched"], "unmatched"], [["matched"], "matched"], [["matched", "unmatched"], "partially_matched"],
    [["partially_matched"], "partially_matched"], [["matched", "review_required"], "review_required"],
  ] as const)("aggregates credit states %j as %s", (states, expected) => {
    const source = returnResult().return.lines[0];
    expect(supplierReturnCreditState(states.map(creditState => ({ ...source, creditState })))).toBe(expected);
  });
  it("shows current returned value separately from immutable original value", () => {
    const document = returnResult().return;
    document.lines[0].currentCosts = { ...document.lines[0].currentCosts, landedMills: 200, totalMills: document.lines[0].currentCosts.totalMills + 100 };
    const snapshot = structuredClone(document);
    const result = projectSupplierReturnList([document], null);
    expect(result.items[0].initialCosts).toEqual(document.lines[0].source.costs);
    expect(result.items[0].currentCosts).toEqual(document.lines[0].currentCosts);
    expect(result.items[0].returnedBasePieces).toBe(20);
    expect(document).toEqual(snapshot);
  });
});
