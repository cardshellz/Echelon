import { describe, expect, it } from "vitest";
import { parseNonnegativeHundredths, SUGGESTED_PRICING_RECIPE } from "../dropship-pricing-rules";

// The pricing rules form's drafts, review words and saved-rules follow-up went with the pricing rules panel in
// Listing settings PR 12; the step still parses with parseNonnegativeHundredths and suggests SUGGESTED_PRICING_RECIPE.
describe("pricing rule form contracts", () => {
  it.each([["0", 0], ["30", 3000], ["30.25", 3025], ["1.01", 101]])("parses %s exactly", (input, expected) => {
    expect(parseNonnegativeHundredths(input, "Value")).toBe(expected);
  });
  it.each(["-1", "1.001", "NaN", "1e2", "", "Infinity", "2,000"])("rejects %s", (input) => {
    expect(() => parseNonnegativeHundredths(input, "Value")).toThrow();
  });
});
describe("pricing drafts", () => {
  it("starts a store with no saved rules on reference retail + 0%, never on cost", () => {
    expect(SUGGESTED_PRICING_RECIPE).toEqual({ basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" });
  });
});
