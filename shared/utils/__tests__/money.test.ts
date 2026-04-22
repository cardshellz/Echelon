// shared/utils/__tests__/money.test.ts
//
// Unit tests for the money helpers (cents + mills).
// Integer math only; no floating point anywhere on the money path.

import { describe, it, expect } from "vitest";
import {
  dollarsToCents,
  dollarsToMills,
  millsToDollarString,
  formatMills,
  millsToCents,
  centsToMills,
  computeLineTotalCentsFromMills,
} from "../money";

describe("dollarsToCents (legacy)", () => {
  it("parses whole dollars", () => {
    expect(dollarsToCents("12")).toBe(1200);
    expect(dollarsToCents("0")).toBe(0);
  });

  it("parses 2-decimal input", () => {
    expect(dollarsToCents("12.34")).toBe(1234);
    expect(dollarsToCents(".34")).toBe(34);
  });

  it("returns 0 on empty input", () => {
    expect(dollarsToCents("")).toBe(0);
  });
});

describe("dollarsToMills", () => {
  it("parses the canonical spec example", () => {
    expect(dollarsToMills("0.0375")).toBe(375);
  });

  it("parses whole dollars", () => {
    expect(dollarsToMills("1")).toBe(10000);
    expect(dollarsToMills("0")).toBe(0);
    expect(dollarsToMills("10")).toBe(100000);
  });

  it("parses 4-decimal precision exactly", () => {
    expect(dollarsToMills("1.2345")).toBe(12345);
    expect(dollarsToMills("0.0001")).toBe(1);
    expect(dollarsToMills("0.9999")).toBe(9999);
  });

  it("pads short fractional parts to 4 decimals", () => {
    expect(dollarsToMills("1.2")).toBe(12000);
    expect(dollarsToMills("1.23")).toBe(12300);
    expect(dollarsToMills("1.234")).toBe(12340);
  });

  it("rounds half-up at the 5th decimal", () => {
    // 5 rounds up
    expect(dollarsToMills("0.12345")).toBe(1235);
    // 4 rounds down
    expect(dollarsToMills("0.12344")).toBe(1234);
    // 9 rounds up
    expect(dollarsToMills("0.12349")).toBe(1235);
    // carry across: 0.99995 → 10000 mills ($1.0000)
    expect(dollarsToMills("0.99995")).toBe(10000);
  });

  it("ignores extra digits past the 5th (truncated before rounding)", () => {
    // We only look at the 5th digit for rounding. Anything beyond it is
    // dropped per spec ("half-up at 5th decimal").
    expect(dollarsToMills("0.123449999")).toBe(1234);
    expect(dollarsToMills("0.123450001")).toBe(1235);
  });

  it("treats empty and lone dot as 0", () => {
    expect(dollarsToMills("")).toBe(0);
    expect(dollarsToMills(".")).toBe(0);
    expect(dollarsToMills("  ")).toBe(0);
  });

  it("rejects non-numeric input", () => {
    expect(() => dollarsToMills("abc")).toThrow(RangeError);
    expect(() => dollarsToMills("1.2.3")).toThrow(RangeError);
    expect(() => dollarsToMills("$1.00")).toThrow(RangeError);
    expect(() => dollarsToMills("1,234.50")).toThrow(RangeError);
  });

  it("rejects negative input", () => {
    expect(() => dollarsToMills("-1")).toThrow(RangeError);
    expect(() => dollarsToMills("-0.0001")).toThrow(RangeError);
  });

  it("accepts a numeric (not string) input for convenience", () => {
    expect(dollarsToMills(0)).toBe(0);
    // JS converts 1.2345 to a string via String(); may be lossy in edge
    // cases but we accept exact decimals that survive Number→string round-trip.
    expect(dollarsToMills(1)).toBe(10000);
  });
});

describe("millsToDollarString", () => {
  it("always emits 4 decimals", () => {
    expect(millsToDollarString(0)).toBe("0.0000");
    expect(millsToDollarString(1)).toBe("0.0001");
    expect(millsToDollarString(375)).toBe("0.0375");
    expect(millsToDollarString(10000)).toBe("1.0000");
    expect(millsToDollarString(12345)).toBe("1.2345");
  });

  it("rejects non-integer input", () => {
    expect(() => millsToDollarString(1.5)).toThrow(RangeError);
  });

  it("rejects negative input", () => {
    expect(() => millsToDollarString(-1)).toThrow(RangeError);
  });
});

describe("formatMills", () => {
  it("formats with currency prefix and thousands separator", () => {
    expect(formatMills(0)).toBe("$0.0000");
    expect(formatMills(375)).toBe("$0.0375");
    expect(formatMills(12345)).toBe("$1.2345");
    expect(formatMills(12345678)).toBe("$1,234.5678");
  });

  it("renders null/undefined as $0.0000 (view-safe fallback)", () => {
    expect(formatMills(null)).toBe("$0.0000");
    expect(formatMills(undefined)).toBe("$0.0000");
  });

  it("does not throw on bad input; returns fallback", () => {
    expect(formatMills(-1)).toBe("$0.0000");
    expect(formatMills(1.5 as any)).toBe("$0.0000");
  });
});

describe("millsToCents", () => {
  it("rounds half-up at the 2nd decimal", () => {
    // 349 mills = $0.0349 → 3 cents
    expect(millsToCents(349)).toBe(3);
    // 350 mills = $0.0350 → 4 cents (half-up at 50 remainder)
    expect(millsToCents(350)).toBe(4);
    // 351 mills = $0.0351 → 4 cents
    expect(millsToCents(351)).toBe(4);
    // 374 → 4
    expect(millsToCents(374)).toBe(4);
    // 375 → 4 (round up at remainder=75)
    expect(millsToCents(375)).toBe(4);
    // 376 → 4
    expect(millsToCents(376)).toBe(4);
  });

  it("handles exact cent boundaries", () => {
    expect(millsToCents(0)).toBe(0);
    expect(millsToCents(100)).toBe(1);
    expect(millsToCents(10000)).toBe(100);
  });

  it("rejects non-integer / negative", () => {
    expect(() => millsToCents(1.5)).toThrow(RangeError);
    expect(() => millsToCents(-1)).toThrow(RangeError);
  });
});

describe("centsToMills", () => {
  it("multiplies by 100 exactly", () => {
    expect(centsToMills(0)).toBe(0);
    expect(centsToMills(1)).toBe(100);
    expect(centsToMills(100)).toBe(10000);
    expect(centsToMills(1234)).toBe(123400);
  });

  it("round-trips through millsToCents when cents are whole", () => {
    for (const cents of [0, 1, 5, 100, 999, 12345]) {
      expect(millsToCents(centsToMills(cents))).toBe(cents);
    }
  });

  it("rejects non-integer / negative", () => {
    expect(() => centsToMills(1.5)).toThrow(RangeError);
    expect(() => centsToMills(-1)).toThrow(RangeError);
  });
});

describe("computeLineTotalCentsFromMills", () => {
  it("zero qty or zero cost → 0", () => {
    expect(computeLineTotalCentsFromMills(0, 100)).toBe(0);
    expect(computeLineTotalCentsFromMills(12345, 0)).toBe(0);
  });

  it("exact multiples collapse to whole cents", () => {
    // 100 mills × 1 = 100 mill-units = 1 cent
    expect(computeLineTotalCentsFromMills(100, 1)).toBe(1);
    // $1.0000 × 3 = $3.00 → 300 cents
    expect(computeLineTotalCentsFromMills(10000, 3)).toBe(300);
  });

  it("rounds half-up at the sub-cent boundary", () => {
    // 375 mills × 1 = 375 mill-units → round(375/100) half-up → 4
    expect(computeLineTotalCentsFromMills(375, 1)).toBe(4);
    // 374 × 1 = 374 → 4 (74 >= 50? yes, half-up rounds up at >=50)
    expect(computeLineTotalCentsFromMills(374, 1)).toBe(4);
    // 349 × 1 = 349 → 3 (49 < 50)
    expect(computeLineTotalCentsFromMills(349, 1)).toBe(3);
    // 350 × 1 = 350 → 4 (exactly 50 → up)
    expect(computeLineTotalCentsFromMills(350, 1)).toBe(4);
    // 376 × 1 = 376 → 4 (76 >= 50)
    expect(computeLineTotalCentsFromMills(376, 1)).toBe(4);
  });

  it("handles multi-qty rounding boundaries", () => {
    // 375 mills × 4 = 1500 mill-units = 15 cents exactly ($0.0375 × 4 = $0.15)
    expect(computeLineTotalCentsFromMills(375, 4)).toBe(15);
    // 375 × 3 = 1125 mill-units → 11.25 cents. roundHalfUp(1125, 100):
    // quotient=11, remainder=25; 25*2=50, 50 < 100 → does NOT round up → 11.
    // (Half-up only triggers when remainder*2 >= denominator; at exactly
    //  .25 of a cent we're below the half-cent boundary.)
    expect(computeLineTotalCentsFromMills(375, 3)).toBe(11);
    // 374 × 3 = 1122 → quotient=11, remainder=22 → 11
    expect(computeLineTotalCentsFromMills(374, 3)).toBe(11);
    // 376 × 3 = 1128 → quotient=11, remainder=28 → 11
    expect(computeLineTotalCentsFromMills(376, 3)).toBe(11);
    // 350 × 3 = 1050 → quotient=10, remainder=50 → ties up → 11
    expect(computeLineTotalCentsFromMills(350, 3)).toBe(11);
    // 349 × 3 = 1047 → 10 (remainder 47 < 50 half-boundary)
    expect(computeLineTotalCentsFromMills(349, 3)).toBe(10);
  });

  it("realistic per-unit × qty cases", () => {
    // $1.2345 × 10 = $12.345 → 1235 cents ($12.35)
    expect(computeLineTotalCentsFromMills(12345, 10)).toBe(1235);
    // $0.0001 × 10000 = $1.00 → 100 cents
    expect(computeLineTotalCentsFromMills(1, 10000)).toBe(100);
  });

  it("rejects non-integer / negative", () => {
    expect(() => computeLineTotalCentsFromMills(1.5, 1)).toThrow(RangeError);
    expect(() => computeLineTotalCentsFromMills(1, 1.5)).toThrow(RangeError);
    expect(() => computeLineTotalCentsFromMills(-1, 1)).toThrow(RangeError);
    expect(() => computeLineTotalCentsFromMills(1, -1)).toThrow(RangeError);
  });

  it("rejects overflow before it can poison downstream math", () => {
    // unit_cost_mills * orderQty exceeding Number.MAX_SAFE_INTEGER fails loud.
    expect(() =>
      computeLineTotalCentsFromMills(Number.MAX_SAFE_INTEGER, 2),
    ).toThrow(RangeError);
  });
});

describe("safe-integer boundaries", () => {
  it("dollarsToMills rejects dollar values near safe-int overflow", () => {
    // 2^53 mills / 10000 ≈ 9.007e11 dollars. A 20-digit whole input is
    // definitely past that and must throw.
    expect(() => dollarsToMills("99999999999999999999")).toThrow(RangeError);
  });

  it("centsToMills rejects overflow", () => {
    // Number.MAX_SAFE_INTEGER = 9007199254740991
    // Any cents > MAX_SAFE_INTEGER / 100 overflows when multiplied.
    const tooBig = Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1;
    expect(() => centsToMills(tooBig)).toThrow(RangeError);
  });
});
