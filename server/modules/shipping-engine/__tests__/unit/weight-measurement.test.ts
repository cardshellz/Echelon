import { describe, expect, it } from "vitest";
import { sumRateSelectionWeightGrams } from "../../domain/weight-measurement";

describe("shipping rating weight measurement", () => {
  it.each([
    [1, 454],
    [2, 907],
    [3, 1_361],
  ])("keeps %i rounded one-pound units on the matching pound boundary", (quantity, grams) => {
    expect(sumRateSelectionWeightGrams([{
      quantity,
      unitWeightGrams: 454,
      weightSource: "channel_fallback",
    }])).toBe(grams);
  });

  it("applies the same precision contract to canonical catalog grams", () => {
    expect(sumRateSelectionWeightGrams([{
      quantity: 2,
      unitWeightGrams: 454,
      weightSource: "echelon_catalog",
    }])).toBe(907);
  });

  it("keeps a genuinely over-two-pound single measurement above the boundary", () => {
    expect(sumRateSelectionWeightGrams([{
      quantity: 1,
      unitWeightGrams: 908,
      weightSource: "channel_fallback",
    }])).toBe(908);
  });

  it("does not infer precision for an unclassified exact measurement", () => {
    expect(sumRateSelectionWeightGrams([{
      quantity: 2,
      unitWeightGrams: 454,
    }])).toBe(908);
  });

  it("rejects invalid quantities and missing weights", () => {
    expect(sumRateSelectionWeightGrams([{
      quantity: 0,
      unitWeightGrams: 454,
      weightSource: "channel_fallback",
    }])).toBeNull();
    expect(sumRateSelectionWeightGrams([{
      quantity: 1,
      unitWeightGrams: null,
      weightSource: "missing",
    }])).toBeNull();
  });
});
