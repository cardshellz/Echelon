import { describe, expect, it } from "vitest";
import { normalizeUsPostalRegion } from "../../domain/us-geography";

describe("normalizeUsPostalRegion", () => {
  it("accepts postal abbreviations and full state names", () => {
    expect(normalizeUsPostalRegion("pa")).toBe("PA");
    expect(normalizeUsPostalRegion("Pennsylvania")).toBe("PA");
  });

  it("normalizes common Virgin Islands spellings", () => {
    expect(normalizeUsPostalRegion("U.S. Virgin Islands")).toBe("VI");
    expect(normalizeUsPostalRegion("Virgin Islands")).toBe("VI");
  });

  it("accepts military mail region codes and names", () => {
    expect(normalizeUsPostalRegion("aa")).toBe("AA");
    expect(normalizeUsPostalRegion("Armed Forces Europe")).toBe("AE");
    expect(normalizeUsPostalRegion("Armed Forces Pacific")).toBe("AP");
  });

  it("returns null for missing or unknown regions", () => {
    expect(normalizeUsPostalRegion(null)).toBeNull();
    expect(normalizeUsPostalRegion("Atlantis")).toBeNull();
  });
});
