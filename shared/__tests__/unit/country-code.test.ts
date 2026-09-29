import { describe, expect, it } from "vitest";
import { normalizeCountryToIso2 } from "../../country-code";

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
    "constructor", "__proto__", "toString", 1, {}, []])("leaves unsupported input unknown: %j", input => {
    expect(normalizeCountryToIso2(input)).toBeNull();
  });
});
