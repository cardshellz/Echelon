import { describe, expect, it } from "vitest";
import { evaluateListingPriceAgainstCost, LISTING_PRICE_BELOW_COST_WARNING } from "../../domain/listing-price-cost";

describe("evaluateListingPriceAgainstCost", () => {
  it("warns only when the price is under the cost of one sellable pack", () => {
    expect(evaluateListingPriceAgainstCost({ priceCents: 799, unitCostCents: 809 })).toEqual({ warnings: [LISTING_PRICE_BELOW_COST_WARNING] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 809, unitCostCents: 809 })).toEqual({ warnings: [] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 810, unitCostCents: 809 })).toEqual({ warnings: [] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 1, unitCostCents: 0 })).toEqual({ warnings: [] });
  });

  it("has nothing to say without a usable price or cost", () => {
    expect(evaluateListingPriceAgainstCost({ priceCents: null, unitCostCents: 809 })).toEqual({ warnings: [] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 799, unitCostCents: null })).toEqual({ warnings: [] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 7.99, unitCostCents: 809 })).toEqual({ warnings: [] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 799, unitCostCents: -1 })).toEqual({ warnings: [] });
    expect(evaluateListingPriceAgainstCost({ priceCents: 799, unitCostCents: Number.NaN })).toEqual({ warnings: [] });
  });

  it("never mutates its input", () => {
    const input = { priceCents: 799, unitCostCents: 809 };
    evaluateListingPriceAgainstCost(input);
    expect(input).toEqual({ priceCents: 799, unitCostCents: 809 });
  });
});
