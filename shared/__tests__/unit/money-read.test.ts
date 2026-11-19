import { describe, expect, it } from "vitest";
import { parseRoundedDecimalCents } from "../../money-read";
import { CurrencyValidationError, ensureCents, ensurePositiveCents } from "../../validation/currency";
import { dollarsToCents } from "../../utils/money";
import { parseDecimalCents, readIntegerCents, readIntegerMills, formatCentsExact, sumCents, MoneyInputError, centsToJsonDollars, decimalForJson, scaleCentsByRate } from "../../money-read";

describe("declared money source units", () => {
  it("retains explicit legacy rounding and human input policies without floating point", () => {
    expect(parseRoundedDecimalCents("69.005", "legacy threshold")).toBe(6901);
    expect(parseRoundedDecimalCents("69.004", "legacy threshold")).toBe(6900);
    expect(() => parseDecimalCents("69.005")).toThrow(MoneyInputError);
    expect(dollarsToCents("-0.46")).toBe(-46);
    expect(dollarsToCents("-.46")).toBe(-46);
    expect(dollarsToCents("$1,234.569")).toBe(123456);
    expect(() => dollarsToCents("1.00junk")).toThrow(RangeError);
  });

  it("validates safe integer cents without a secondary bigint serialization error", () => {
    expect(ensureCents("total", Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of [Number.MAX_SAFE_INTEGER + 1, BigInt(1), null, "100"]) {
      expect(() => ensureCents("total", value)).toThrow(CurrencyValidationError);
      expect(() => ensurePositiveCents("total", value)).toThrow(CurrencyValidationError);
    }
  });
  it("never guesses units from numeric versus textual input", () => {
    for (const value of [5, "5"]) {
      expect(parseDecimalCents(value)).toBe(500);
      expect(readIntegerCents(value)).toBe(5);
    }
    expect(readIntegerCents(BigInt(5))).toBe(5);
    expect(parseDecimalCents("0.29")).toBe(29);
    expect(parseDecimalCents("2.33")).toBe(233);
    expect(parseDecimalCents("0.00")).toBe(0);
    expect(readIntegerCents("0")).toBe(0);
  });
  it("retains signed credits only when the caller explicitly allows them", () => {
    expect(parseDecimalCents("-0.46", "credit", true)).toBe(-46);
    expect(readIntegerCents("-46", "credit", true)).toBe(-46);
    expect(() => parseDecimalCents("-0.46")).toThrow(MoneyInputError);
    expect(() => readIntegerCents("-46")).toThrow(MoneyInputError);
  });
  it.each([null, undefined, "", " ", "1foo", "1e2", "$1.00", "1,000.00", "1.005", NaN, Infinity, false, {}, []])(
    "rejects invalid dollar evidence %s instead of inventing a rounded or zero amount", (value) => {
      expect(() => parseDecimalCents(value)).toThrow(MoneyInputError);
    },
  );
  it.each([null, undefined, "", " ", "1foo", "1e2", "1.0", 0.1, NaN, Infinity, false, {}, []])(
    "rejects invalid integer-cent evidence %s", (value) => {
      expect(() => readIntegerCents(value)).toThrow(MoneyInputError);
    },
  );
  it("checks precision before converting exact integers to a JS number", () => {
    expect(parseDecimalCents("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(readIntegerCents("9007199254740991")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseDecimalCents("90071992547409.92")).toThrow(MoneyInputError);
    expect(() => readIntegerCents("9007199254740992")).toThrow(MoneyInputError);
    expect(() => readIntegerCents(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyInputError);
    expect(formatCentsExact(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
  });
  it("formats and sums integer cents without silent overflow", () => {
    expect(formatCentsExact(-46)).toBe("-0.46");
    expect(formatCentsExact("100")).toBe("1.00");
    expect(sumCents([233, 549, 47])).toBe(829);
    expect(sumCents([])).toBe(0);
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyInputError);
  });
  it("retains four-place unit-cost precision without reinterpreting mills as cents", () => {
    expect(readIntegerMills("375")).toBe(375);
    expect(() => readIntegerMills("3.75")).toThrow(MoneyInputError);
  });
  it("validates numeric-dollar transport amounts and scales rates exactly", () => {
    expect(centsToJsonDollars(29)).toBe(0.29);
    expect(decimalForJson("2.33")).toBe(2.33);
    expect(scaleCentsByRate(233, "0.15")).toBe(35);
    expect(scaleCentsByRate(1, "0.5")).toBe(1);
    expect(() => scaleCentsByRate(233, "0.1junk")).toThrow(MoneyInputError);
    expect(() => centsToJsonDollars(Number.MAX_SAFE_INTEGER)).toThrow(MoneyInputError);
  });
});
