import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODE_ALIASES, CountryCodeValidationError, ISO_COUNTRY_CODES, isCountryCode,
  normalizeCountryToIso2, parseCountryCode, requireCountryCode, resolveProviderCountryCode,
} from "../../country-code";

describe("shared country identity normalization", () => {
  it.each([
    ["US", "US"], [" us ", "US"], ["United States", "US"],
    ["united states of america", "US"], ["USA", "US"], ["U.S.", "US"],
    ["Canada", "CA"], ["ca", "CA"], ["United Kingdom", "GB"], ["UK", "GB"],
    ["México", "MX"], ["Türkiye", "TR"], ["Puerto Rico", "PR"],
  ])("resolves %s to %s", (input, expected) => {
    expect(normalizeCountryToIso2(input)).toBe(expected);
  });

  it.each([null, undefined, "", "  ", "XX", "ZZ", "Freedonia", "US extra", "United States / Canada",
    "constructor", "__proto__", "toString", "America", "Virgin Islands", 1, {}, []])("leaves unsupported input unknown: %j", input => {
    expect(normalizeCountryToIso2(input)).toBeNull();
  });
});

describe("country write contracts", () => {
  it("accepts every canonical code and only canonical values as CountryCode", () => {
    expect(new Set(ISO_COUNTRY_CODES).size).toBe(249);
    for (const code of ISO_COUNTRY_CODES) {
      expect(parseCountryCode(code)).toBe(code);
      expect(isCountryCode(code)).toBe(true);
    }
    for (const value of ["us", "US ", "UK", "ZZ", null, {}, "constructor"]) {
      expect(isCountryCode(value)).toBe(false);
    }
  });

  it("keeps every documented compatibility alias tied to a real country", () => {
    for (const [alias, code] of Object.entries(COUNTRY_CODE_ALIASES)) {
      expect(parseCountryCode(alias)).toBe(code);
      expect(isCountryCode(code)).toBe(true);
    }
  });

  it.each([undefined, null, "", " \t\n "])("stores missing %j as NULL but prohibits shipping it", input => {
    expect(parseCountryCode(input)).toBeNull();
    expect(() => requireCountryCode(input)).toThrowError(expect.objectContaining({
      name: "CountryCodeValidationError", code: "ORDER_COUNTRY_REQUIRED", status: 400,
    }));
  });

  it.each(["ZZ", "Atlantis", "America", "Virgin Islands", "US".padEnd(101), false, 1, {}, [], "__proto__"])(
    "rejects malformed nonempty input without exposing it: %j", input => {
      try { parseCountryCode(input); expect.fail("Expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(CountryCodeValidationError);
        expect(error).toMatchObject({ code: "ORDER_COUNTRY_INVALID", status: 400, field: "country" });
        expect((error as Error).message).toBe("Choose a recognized country or provide its two-letter country code.");
      }
    },
  );

  it("uses names only when the provider code is absent, never as a fallback for a bad code", () => {
    for (const absent of [undefined, null, "", "  "]) {
      expect(resolveProviderCountryCode(absent, "United States")).toBe("US");
    }
    expect(resolveProviderCountryCode("CA", "United States")).toBe("CA");
    for (const invalid of ["ZZ", {}, 0]) {
      expect(() => resolveProviderCountryCode(invalid, "United States")).toThrow(CountryCodeValidationError);
    }
    expect(resolveProviderCountryCode(undefined, undefined)).toBeNull();
  });
});
