import { describe, expect, it, vi } from "vitest";
import * as money from "@shared/utils/money";
import { evaluateDollarInput } from "../../exact-money-input";

describe("dollar form validation boundary", () => {
  it.each([
    ["", 0], ["0.00", 0], ["-.46", -46], ["$1,234.569", 123456],
    ["12.34", 1234], ["90071992547409.91", Number.MAX_SAFE_INTEGER],
  ])("preserves the established signed/truncated policy for %s", (raw, cents) => {
    expect(evaluateDollarInput(raw)).toEqual({ valid: true, cents });
  });

  it.each([".", "-", "1e3", "12junk"])("classifies malformed input %s", raw => {
    expect(evaluateDollarInput(raw)).toEqual({ valid: false, code: "MONEY_INPUT_INVALID", message: "Enter a valid dollar amount." });
  });

  it.each(["90071992547409.92", "-90071992547409.92"])("classifies unsafe signed amount %s", raw => {
    expect(evaluateDollarInput(raw)).toEqual({ valid: false, code: "MONEY_INPUT_OVERFLOW", message: "The amount exceeds the supported limit. Enter a smaller dollar amount." });
  });

  it("propagates unexpected failures instead of misreporting them as invalid input", () => {
    const failure = new TypeError("Synthetic programmer failure");
    const reader = vi.spyOn(money, "dollarsToCents").mockImplementationOnce(() => { throw failure; });
    try { expect(() => evaluateDollarInput("12.34")).toThrow(failure); }
    finally { reader.mockRestore(); }
  });
});
