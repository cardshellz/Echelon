import { describe, expect, it } from "vitest";
import { centsToDollarString } from "../../money";

/** Reference formatter in BigInt, independent of the one under test. */
function bigIntReference(cents: number): string {
  const value = BigInt(cents);
  const whole = value / BigInt(100);
  const fractional = value % BigInt(100);
  return `${whole}.${fractional.toString().padStart(2, "0")}`;
}

/** Every whole-cent price up to $10,000.00: the range the old float formatting is pinned against. */
const TO_FIXED_COMPARISON_MAX_CENTS = 1_000_000;

describe("centsToDollarString", () => {
  it("formats whole cents with exactly two decimals", () => {
    expect(centsToDollarString(0)).toBe("0.00");
    expect(centsToDollarString(1)).toBe("0.01");
    expect(centsToDollarString(9)).toBe("0.09");
    expect(centsToDollarString(10)).toBe("0.10");
    expect(centsToDollarString(99)).toBe("0.99");
    expect(centsToDollarString(100)).toBe("1.00");
    expect(centsToDollarString(799)).toBe("7.99");
    expect(centsToDollarString(1005)).toBe("10.05");
    expect(centsToDollarString(16999)).toBe("169.99");
    expect(centsToDollarString(100000)).toBe("1000.00");
  });

  it("is exact at the largest safe integer", () => {
    expect(centsToDollarString(Number.MAX_SAFE_INTEGER)).toBe("90071992547409.91");
    expect(centsToDollarString(Number.MAX_SAFE_INTEGER)).toBe(bigIntReference(Number.MAX_SAFE_INTEGER));
  });

  it("gives the same string as the old (cents / 100).toFixed(2) for every price up to $10,000.00", () => {
    const mismatches: number[] = [];
    for (let cents = 0; cents <= TO_FIXED_COMPARISON_MAX_CENTS; cents += 1) {
      if (centsToDollarString(cents) !== (cents / 100).toFixed(2)) mismatches.push(cents);
    }
    expect(mismatches).toEqual([]);
  });

  it("matches an independent BigInt formatter far above that range", () => {
    for (const cents of [1_000_001, 123_456_789, 2 ** 31, 2 ** 40 + 7, 2 ** 52 + 99, Number.MAX_SAFE_INTEGER - 1]) {
      expect(centsToDollarString(cents)).toBe(bigIntReference(cents));
    }
  });

  it.each([
    ["a fractional amount", 1234.5],
    ["a negative amount", -1],
    ["a negative fraction", -0.01],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("refuses %s", (_label, cents) => {
    expect(() => centsToDollarString(cents)).toThrow(RangeError);
  });

  it("formats negative zero as zero", () => {
    expect(centsToDollarString(-0)).toBe("0.00");
  });
});
