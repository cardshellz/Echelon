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
});
