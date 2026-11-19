import { describe, expect, it } from "vitest";
import { formatAccountUsdCents } from "../account-display-money";
describe("exact saved-account money display", () => {
  it("formats zero, individual cents and the largest supported amount exactly", () => {
    for (const [input, output] of [[0, "$0.00"], [1, "$0.01"], [100, "$1.00"], [741, "$7.41"],
      [Number.MAX_SAFE_INTEGER, "$90,071,992,547,409.91"]] as const) expect(formatAccountUsdCents(input)).toBe(output);
  });
  it("rejects invalid, negative, fractional and overflowing cents", () => {
    for (const value of [NaN, Infinity, -1, 1.1, Number.MAX_SAFE_INTEGER + 1])
      expect(() => formatAccountUsdCents(value)).toThrow("ACCOUNT_DISPLAY_MONEY_INVALID");
  });
});
