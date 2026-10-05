import { describe, expect, it } from "vitest";
import {
  largestRemainder,
  parseIntegerString,
  roundHalfAwayFromZero,
  signedMillsToCents,
  toBps,
  toSafeNumber,
  toTenths,
} from "../program-finance-money";

const big = (value: number | string): bigint => BigInt(value);
const bigs = (values: ReadonlyArray<number>): bigint[] => values.map((value) => BigInt(value));

describe("signedMillsToCents", () => {
  it.each([
    [149, 1],
    [150, 2],
    [151, 2],
    [-149, -1],
    [-150, -2],
    [-151, -2],
    [0, 0],
    [49, 0],
    [50, 1],
    [-49, 0],
    [-50, -1],
    [376_400, 3_764],
    [189_600, 1_896],
  ])("rounds %i mills to %i cents, half away from zero", (mills, cents) => {
    expect(signedMillsToCents(big(mills))).toBe(big(cents));
  });

  it("stays exact beyond the safe integer range", () => {
    expect(signedMillsToCents(big("900719925474099150"))).toBe(big("9007199254740992"));
    expect(signedMillsToCents(big("-900719925474099150"))).toBe(big("-9007199254740992"));
    expect(signedMillsToCents(big("123456789012345678949"))).toBe(big("1234567890123456789"));
  });

  it("is the SQL fragment's rule: CASE WHEN m < 0 THEN -((-m + 50) / 100) ELSE (m + 50) / 100 END", () => {
    // Postgres bigint division truncates toward zero; so does BigInt division.
    const sqlRule = (m: bigint): bigint => (m < big(0) ? -((-m + big(50)) / big(100)) : (m + big(50)) / big(100));
    for (let mills = -1_005; mills <= 1_005; mills += 1) {
      expect(signedMillsToCents(big(mills))).toBe(sqlRule(big(mills)));
    }
  });
});

describe("roundHalfAwayFromZero", () => {
  it.each([
    [5, 2, 3],
    [-5, 2, -3],
    [5, -2, -3],
    [-5, -2, 3],
    [4, 3, 1],
    [-4, 3, -1],
    [2, 3, 1],
    [-2, 3, -1],
    [1, 3, 0],
    [-1, 3, 0],
    [0, 7, 0],
    [7, 7, 1],
    [-7, 7, -1],
  ])("rounds %i ÷ %i to %i", (numerator, denominator, expected) => {
    expect(roundHalfAwayFromZero(big(numerator), big(denominator))).toBe(big(expected));
  });

  it("gives null for a zero denominator, never zero", () => {
    expect(roundHalfAwayFromZero(big(0), big(0))).toBeNull();
    expect(roundHalfAwayFromZero(big(5), big(0))).toBeNull();
    expect(roundHalfAwayFromZero(big(-5), big(0))).toBeNull();
  });
});

describe("toTenths and toBps", () => {
  it("work out 3881 of 9730 as 39.9% and 39.89% (the fixture's margin)", () => {
    expect(toTenths(big(3_881), big(9_730))).toBe(big(399));
    expect(toBps(big(3_881), big(9_730))).toBe(big(3_989));
  });

  it.each([
    // [numerator, denominator, tenths, bps] from the contract §6.4 fixture
    [16_130, 2_600, 6_204, 62_038],
    [-211_700, 300_000, -706, -7_057],
    [3_756, 7_520, 499, 4_995],
    [125, 2_060, 61, 607],
    [1_710, 4_100, 417, 4_171],
  ])("work out %i of %i as %i tenths and %i bps", (numerator, denominator, tenths, bps) => {
    expect(toTenths(big(numerator), big(denominator))).toBe(big(tenths));
    expect(toBps(big(numerator), big(denominator))).toBe(big(bps));
  });

  it("keeps a loss negative", () => {
    expect(toTenths(big(-212), big(1_000))).toBe(big(-212));
    expect(toBps(big(-212), big(1_000))).toBe(big(-2_120));
  });

  it("gives null over a zero base", () => {
    expect(toTenths(big(10), big(0))).toBeNull();
    expect(toBps(big(10), big(0))).toBeNull();
  });
});

describe("parseIntegerString", () => {
  it.each([
    ["0", 0],
    ["-0", 0],
    ["12", 12],
    ["-12", -12],
    ["007", 7],
  ])("reads %s", (text, value) => {
    expect(parseIntegerString(text)).toBe(big(value));
  });

  it("reads integers beyond the safe range exactly, as Postgres numeric sends them", () => {
    expect(parseIntegerString("9223372036854775808")).toBe(big("9223372036854775808"));
    expect(parseIntegerString("-90071992547409920")).toBe(big("-90071992547409920"));
  });

  it.each(["1.5", "1e3", "", " 1", "1 ", "+1", "-", "--1", "0x10", "1_000", "NaN", "Infinity", "١٢"])("refuses %j", (text) => {
    expect(parseIntegerString(text)).toBeNull();
  });

  it("reads String() of an int4 number and refuses String() of a fraction or an exponent form", () => {
    expect(parseIntegerString(String(42))).toBe(big(42));
    expect(parseIntegerString(String(1.5))).toBeNull();
    expect(parseIntegerString(String(1e21))).toBeNull();
  });
});

describe("toSafeNumber", () => {
  it("returns numbers within the safe range", () => {
    expect(toSafeNumber(big(0))).toBe(0);
    expect(toSafeNumber(big(-1_250))).toBe(-1_250);
    expect(toSafeNumber(big(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(toSafeNumber(big(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
  });

  it("returns null past it, never a rounded number", () => {
    expect(toSafeNumber(big(Number.MAX_SAFE_INTEGER) + big(1))).toBeNull();
    expect(toSafeNumber(big(Number.MIN_SAFE_INTEGER) - big(1))).toBeNull();
    expect(toSafeNumber(big("9223372036854775807"))).toBeNull();
  });
});

describe("largestRemainder", () => {
  it("splits the fixture's dollar into 40/39/20/1 cents (kept, cost of goods, labels, pool)", () => {
    expect(largestRemainder(bigs([3_881, 3_764, 1_935, 150]), big(9_730), big(100))).toEqual(bigs([40, 39, 20, 1]));
  });

  it("splits the fixture's bar into 2072/2010/1033/80/4805 bps", () => {
    expect(largestRemainder(bigs([3_881, 3_764, 1_935, 150, 9_000]), big(18_730), big(10_000))).toEqual(
      bigs([2_072, 2_010, 1_033, 80, 4_805]),
    );
  });

  it("gives a tied unit to the part listed first", () => {
    // Kept and labels both leave a remainder of 8630 of 9730 above; here three equal parts share 100.
    expect(largestRemainder(bigs([1, 1, 1]), big(3), big(100))).toEqual(bigs([34, 33, 33]));
    expect(largestRemainder(bigs([1, 1, 1, 1, 1, 1]), big(6), big(100))).toEqual(bigs([17, 17, 17, 17, 16, 16]));
  });

  it("always adds up to the scale", () => {
    const cases: Array<[number[], number]> = [
      [[1, 2, 3, 4], 100],
      [[999, 1], 10_000],
      [[0, 0, 7], 100],
      [[123_456_789, 987_654_321, 5], 10_000],
    ];
    for (const [parts, scale] of cases) {
      const total = parts.reduce((sum, part) => sum + part, 0);
      const shares = largestRemainder(bigs(parts), big(total), big(scale));
      expect(shares?.reduce((sum, share) => sum + share, big(0))).toBe(big(scale));
    }
  });

  it("gives everything to a single part", () => {
    expect(largestRemainder(bigs([0, 500, 0]), big(500), big(100))).toEqual(bigs([0, 100, 0]));
  });

  it("refuses a negative part, a non-positive total or scale, no parts, or parts that miss the total", () => {
    expect(largestRemainder(bigs([-212, 1_212]), big(1_000), big(100))).toBeNull();
    expect(largestRemainder(bigs([0, 0]), big(0), big(100))).toBeNull();
    expect(largestRemainder(bigs([5, 5]), big(10), big(0))).toBeNull();
    expect(largestRemainder([], big(10), big(100))).toBeNull();
    expect(largestRemainder(bigs([3, 3]), big(10), big(100))).toBeNull();
  });

  it("does not change its input", () => {
    const parts = bigs([3_881, 3_764, 1_935, 150]);
    const copy = [...parts];
    largestRemainder(parts, big(9_730), big(100));
    expect(parts).toEqual(copy);
  });
});
