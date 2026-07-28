import { describe, expect, it } from "vitest";
import { resolveRecommendationPoQuantity } from "../../recommendation-po-quantity";

describe("resolveRecommendationPoQuantity", () => {
  it("keeps PO order quantity in base pieces while preserving the receive configuration", () => {
    expect(resolveRecommendationPoQuantity({
      suggestedOrderQty: 3,
      suggestedOrderPieces: 300,
      orderUomUnits: 100,
    })).toEqual({
      orderQtyPieces: 300,
      orderUomQty: 3,
      orderUomUnits: 100,
    });
  });

  it("rejects a recommendation whose UOM and piece quantities disagree", () => {
    expect(() => resolveRecommendationPoQuantity({
      suggestedOrderQty: 3,
      suggestedOrderPieces: 3,
      orderUomUnits: 100,
    })).toThrow("suggestedOrderPieces must equal suggestedOrderQty * orderUomUnits (300)");
  });

  it.each([
    { suggestedOrderQty: 0, suggestedOrderPieces: 10, orderUomUnits: 10 },
    { suggestedOrderQty: 1, suggestedOrderPieces: 0, orderUomUnits: 10 },
    { suggestedOrderQty: 1, suggestedOrderPieces: 10, orderUomUnits: 0 },
    { suggestedOrderQty: 1.5, suggestedOrderPieces: 15, orderUomUnits: 10 },
  ])("rejects invalid quantity input %#", (input) => {
    expect(() => resolveRecommendationPoQuantity(input)).toThrow(RangeError);
  });

  // Healthy top-off: a zero-suggestion baseline is only valid behind the
  // explicit opt-in, and only when BOTH quantities are exactly zero.
  it("accepts an all-zero baseline only when allowZeroBaseline is set", () => {
    expect(resolveRecommendationPoQuantity(
      { suggestedOrderQty: 0, suggestedOrderPieces: 0, orderUomUnits: 100 },
      { allowZeroBaseline: true },
    )).toEqual({
      orderQtyPieces: 0,
      orderUomQty: 0,
      orderUomUnits: 100,
    });
    expect(() => resolveRecommendationPoQuantity({
      suggestedOrderQty: 0,
      suggestedOrderPieces: 0,
      orderUomUnits: 100,
    })).toThrow(RangeError);
  });

  it.each([
    // Pieces without qty (and vice versa) still violate the consistency rule.
    { suggestedOrderQty: 0, suggestedOrderPieces: 10, orderUomUnits: 10 },
    { suggestedOrderQty: 1, suggestedOrderPieces: 0, orderUomUnits: 10 },
    // The receive/order UOM must stay positive even for a zero baseline.
    { suggestedOrderQty: 0, suggestedOrderPieces: 0, orderUomUnits: 0 },
    { suggestedOrderQty: -1, suggestedOrderPieces: 0, orderUomUnits: 10 },
  ])("rejects inconsistent zero-baseline input %# even with allowZeroBaseline", (input) => {
    expect(() => resolveRecommendationPoQuantity(input, { allowZeroBaseline: true })).toThrow(RangeError);
  });
});
