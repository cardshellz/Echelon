/**
 * Unit tests for shared/validation/currency.ts.
 *
 * Rule #3 (no floats for money) + Rule #4 (validate at boundaries) are
 * encoded here as tests. Every cents-accepting function is probed with:
 *   - zero
 *   - positive int
 *   - negative
 *   - NaN / Infinity
 *   - fractional / float
 *   - non-number types
 *   - MAX_SAFE_INTEGER edge
 */

import { describe, it, expect } from "vitest";
import {
  CentsSchema,
  PositiveCentsSchema,
  CurrencyCodeSchema,
  CurrencyValidationError,
  ensureCents,
  ensurePositiveCents,
  ensureCurrencyCode,
  isLineSumWithinTolerance,
} from "../validation/currency";

describe("CentsSchema", () => {
  it("accepts non-negative integers", () => {
    expect(CentsSchema.parse(0)).toBe(0);
    expect(CentsSchema.parse(1)).toBe(1);
    expect(CentsSchema.parse(123)).toBe(123);
    expect(CentsSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects negatives", () => {
    expect(CentsSchema.safeParse(-1).success).toBe(false);
    expect(CentsSchema.safeParse(-0.01).success).toBe(false);
  });

  it("rejects floats (no fractional cents)", () => {
    expect(CentsSchema.safeParse(1.5).success).toBe(false);
    expect(CentsSchema.safeParse(0.001).success).toBe(false);
    expect(CentsSchema.safeParse(100.999).success).toBe(false);
  });

  it("rejects NaN / Infinity", () => {
    expect(CentsSchema.safeParse(NaN).success).toBe(false);
    expect(CentsSchema.safeParse(Infinity).success).toBe(false);
    expect(CentsSchema.safeParse(-Infinity).success).toBe(false);
  });

  it("rejects non-number types", () => {
    for (const v of ["123", "0", null, undefined, true, false, {}, [], 123n]) {
      expect(CentsSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe("PositiveCentsSchema", () => {
  it("rejects zero (that's the point)", () => {
    expect(PositiveCentsSchema.safeParse(0).success).toBe(false);
  });

  it("accepts positive integers", () => {
    expect(PositiveCentsSchema.parse(1)).toBe(1);
    expect(PositiveCentsSchema.parse(9999999)).toBe(9999999);
  });

  it("rejects everything CentsSchema rejects", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, "1" as unknown, null, undefined]) {
      expect(PositiveCentsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("ensureCents / ensurePositiveCents — throwing guards", () => {
  it("ensureCents returns the value on success", () => {
    expect(ensureCents("tax_cents", 0)).toBe(0);
    expect(ensureCents("tax_cents", 500)).toBe(500);
  });

  it("ensureCents throws CurrencyValidationError with field name in message", () => {
    try {
      ensureCents("tax_cents", -1);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CurrencyValidationError);
      const cve = err as CurrencyValidationError;
      expect(cve.field).toBe("tax_cents");
      expect(cve.value).toBe(-1);
      expect(cve.code).toBe("CURRENCY_VALIDATION_ERROR");
      expect(cve.message).toContain("tax_cents");
    }
  });

  it("ensurePositiveCents throws on zero", () => {
    expect(() => ensurePositiveCents("unit_price_cents", 0)).toThrow(
      CurrencyValidationError,
    );
  });

  it("ensurePositiveCents throws on float", () => {
    expect(() => ensurePositiveCents("amount_paid_cents", 1.5)).toThrow(
      CurrencyValidationError,
    );
  });

  it("ensurePositiveCents throws on NaN", () => {
    expect(() => ensurePositiveCents("amount_paid_cents", NaN)).toThrow(
      CurrencyValidationError,
    );
  });

  it("ensurePositiveCents throws on string (no coercion)", () => {
    expect(() =>
      ensurePositiveCents("amount_paid_cents", "100" as unknown),
    ).toThrow(CurrencyValidationError);
  });
});

describe("CurrencyCodeSchema / ensureCurrencyCode", () => {
  it("accepts upper-case 3-letter codes", () => {
    expect(CurrencyCodeSchema.parse("USD")).toBe("USD");
    expect(CurrencyCodeSchema.parse("EUR")).toBe("EUR");
    expect(CurrencyCodeSchema.parse("JPY")).toBe("JPY");
  });

  it("trims whitespace", () => {
    expect(CurrencyCodeSchema.parse(" USD ")).toBe("USD");
  });

  it("rejects lower-case (stricter than permissive)", () => {
    expect(CurrencyCodeSchema.safeParse("usd").success).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(CurrencyCodeSchema.safeParse("US").success).toBe(false);
    expect(CurrencyCodeSchema.safeParse("USDX").success).toBe(false);
    expect(CurrencyCodeSchema.safeParse("").success).toBe(false);
  });

  it("rejects non-letter chars", () => {
    expect(CurrencyCodeSchema.safeParse("US1").success).toBe(false);
    expect(CurrencyCodeSchema.safeParse("$$$").success).toBe(false);
  });

  it("ensureCurrencyCode throws with field name", () => {
    try {
      ensureCurrencyCode("currency", "usd");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CurrencyValidationError);
      expect((err as CurrencyValidationError).field).toBe("currency");
    }
  });
});

describe("isLineSumWithinTolerance", () => {
  it("exact match → true", () => {
    expect(isLineSumWithinTolerance(1000, 1000, 3)).toBe(true);
  });

  it("within tolerance per line → true", () => {
    // 3 lines * 1¢ tolerance = 3¢ allowed slop.
    expect(isLineSumWithinTolerance(1000, 1003, 3)).toBe(true);
    expect(isLineSumWithinTolerance(1000, 997, 3)).toBe(true);
  });

  it("outside tolerance → false", () => {
    expect(isLineSumWithinTolerance(1000, 1004, 3)).toBe(false);
    expect(isLineSumWithinTolerance(1000, 996, 3)).toBe(false);
  });

  it("zero lines → only exact match passes", () => {
    expect(isLineSumWithinTolerance(0, 0, 0)).toBe(true);
    expect(isLineSumWithinTolerance(0, 1, 0)).toBe(false);
  });

  it("custom tolerance respected", () => {
    // 2 lines * 5¢ = 10¢ allowed.
    expect(isLineSumWithinTolerance(1000, 1010, 2, 5)).toBe(true);
    expect(isLineSumWithinTolerance(1000, 1011, 2, 5)).toBe(false);
  });

  it("throws on non-integer / negative cents inputs", () => {
    expect(() => isLineSumWithinTolerance(1.5, 1000, 1)).toThrow(
      CurrencyValidationError,
    );
    expect(() => isLineSumWithinTolerance(1000, -1, 1)).toThrow(
      CurrencyValidationError,
    );
  });

  it("throws on negative line count or tolerance", () => {
    expect(() => isLineSumWithinTolerance(0, 0, -1)).toThrow(
      CurrencyValidationError,
    );
    expect(() => isLineSumWithinTolerance(0, 0, 1, -1)).toThrow(
      CurrencyValidationError,
    );
  });
});
