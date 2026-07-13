import { describe, expect, it } from "vitest";
import { resolveRecommendationPoCost } from "../../recommendation-po-cost";

describe("resolveRecommendationPoCost", () => {
  it("keeps sub-cent unit cost in mills and rounds only the complete PO line", () => {
    expect(resolveRecommendationPoCost({
      estimatedCostMills: 50,
      estimatedCostCents: 1,
      orderQtyPieces: 300,
    })).toEqual({
      unitCostMills: 50,
      unitCostCents: 1,
      totalProductCostCents: 150,
      lineTotalCents: 150,
    });
  });

  it("does not round a fractional-cent unit cost before multiplying by quantity", () => {
    expect(resolveRecommendationPoCost({
      estimatedCostMills: 375,
      estimatedCostCents: 4,
      orderQtyPieces: 100,
    })).toEqual({
      unitCostMills: 375,
      unitCostCents: 4,
      totalProductCostCents: 375,
      lineTotalCents: 375,
    });
  });

  it("derives an exact mills value for legacy cent-only supplier costs", () => {
    expect(resolveRecommendationPoCost({
      estimatedCostMills: null,
      estimatedCostCents: 5,
      orderQtyPieces: 300,
    })).toEqual({
      unitCostMills: 500,
      unitCostCents: 5,
      totalProductCostCents: 1_500,
      lineTotalCents: 1_500,
    });
  });

  it("accepts a zero-cent mirror when an authoritative positive mill cost rounds below one cent", () => {
    expect(resolveRecommendationPoCost({
      estimatedCostMills: 20,
      estimatedCostCents: 0,
      orderQtyPieces: 100,
    })).toEqual({
      unitCostMills: 20,
      unitCostCents: 0,
      totalProductCostCents: 20,
      lineTotalCents: 20,
    });
  });

  it("accepts an explicit zero-dollar supplier cost", () => {
    expect(resolveRecommendationPoCost({
      estimatedCostMills: 0,
      estimatedCostCents: 0,
      orderQtyPieces: 100,
    })).toEqual({
      unitCostMills: 0,
      unitCostCents: 0,
      totalProductCostCents: 0,
      lineTotalCents: 0,
    });
  });

  it("rejects a stale cent mirror instead of silently persisting inconsistent money", () => {
    expect(() => resolveRecommendationPoCost({
      estimatedCostMills: 50,
      estimatedCostCents: 2,
      orderQtyPieces: 300,
    })).toThrow("estimatedCostCents must equal the rounded estimatedCostMills mirror (1)");
  });

  it.each([
    { estimatedCostMills: null, estimatedCostCents: null, orderQtyPieces: 1 },
    { estimatedCostMills: -1, estimatedCostCents: 0, orderQtyPieces: 1 },
    { estimatedCostMills: 50, estimatedCostCents: 1, orderQtyPieces: 0 },
    { estimatedCostMills: 50.5, estimatedCostCents: 1, orderQtyPieces: 1 },
  ])("rejects missing or unsafe cost input %#", (input) => {
    expect(() => resolveRecommendationPoCost(input)).toThrow(RangeError);
  });
});
