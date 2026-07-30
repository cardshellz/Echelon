import { describe, expect, it } from "vitest";
import { poundsToRateTestGrams } from "../pricing-programs/rate-test-weight";

describe("manual rate-test weight conversion", () => {
  it.each([
    [2, 907],
    [3, 1_361],
    [51, 23_133],
  ])("rounds %s lb to the nearest whole gram", (pounds, grams) => {
    expect(poundsToRateTestGrams(pounds)).toBe(grams);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.000_1])(
    "rejects unsupported weight %s",
    (pounds) => {
      expect(poundsToRateTestGrams(pounds)).toBeNull();
    },
  );
});
