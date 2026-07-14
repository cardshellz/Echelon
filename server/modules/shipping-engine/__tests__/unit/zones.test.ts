import { describe, expect, it } from "vitest";
import { resolveZone, type ZoneRule } from "../../domain/zones";

let nextId = 1;

function rule(overrides: Partial<ZoneRule> & Pick<ZoneRule, "zone">): ZoneRule {
  return {
    id: nextId++,
    destinationCountry: "US",
    destinationRegion: null,
    postalPrefix: null,
    priority: 0,
    isActive: true,
    ...overrides,
  };
}

describe("resolveZone", () => {
  it("returns null when no rules are given", () => {
    expect(resolveZone([], "US", "90210")).toBeNull();
  });

  it("returns null when no rule matches the country", () => {
    const rules = [rule({ zone: "Z1", destinationCountry: "CA" })];
    expect(resolveZone(rules, "US", "90210")).toBeNull();
  });

  it("matches a NULL-prefix rule as the country-wide default", () => {
    const rules = [rule({ zone: "D49" })];
    expect(resolveZone(rules, "US", "90210")).toBe("D49");
  });

  it("prefers a matching prefix over the country-wide default", () => {
    const rules = [
      rule({ zone: "D49" }),
      rule({ zone: "HIPRAK", postalPrefix: "9" }),
    ];
    expect(resolveZone(rules, "US", "96813")).toBe("HIPRAK");
  });

  it("falls back to the default when no prefix matches", () => {
    const rules = [
      rule({ zone: "D49" }),
      rule({ zone: "HIPRAK", postalPrefix: "967" }),
    ];
    expect(resolveZone(rules, "US", "30301")).toBe("D49");
  });

  it("longest matching prefix wins over a shorter one", () => {
    const rules = [
      rule({ zone: "WEST", postalPrefix: "9" }),
      rule({ zone: "HI", postalPrefix: "967" }),
    ];
    expect(resolveZone(rules, "US", "96789")).toBe("HI");
  });

  it("longest prefix wins even when the shorter prefix has higher priority", () => {
    // Deliberate deviation from the dropship SQL (priority-first): a specific
    // prefix rule can never be shadowed by a high-priority broad rule.
    const rules = [
      rule({ zone: "WEST", postalPrefix: "9", priority: 100 }),
      rule({ zone: "HI", postalPrefix: "967", priority: 0 }),
    ];
    expect(resolveZone(rules, "US", "96789")).toBe("HI");
  });

  it("priority breaks ties between equal-length prefixes", () => {
    const rules = [
      rule({ zone: "LOW", postalPrefix: "967", priority: 1 }),
      rule({ zone: "HIGH", postalPrefix: "967", priority: 5 }),
    ];
    expect(resolveZone(rules, "US", "96789")).toBe("HIGH");
  });

  it("lowest id wins when prefix length and priority both tie", () => {
    const rules = [
      rule({ id: 20, zone: "SECOND", postalPrefix: "967", priority: 3 }),
      rule({ id: 10, zone: "FIRST", postalPrefix: "967", priority: 3 }),
    ];
    expect(resolveZone(rules, "US", "96789")).toBe("FIRST");
  });

  it("skips inactive rules", () => {
    const rules = [
      rule({ zone: "HI", postalPrefix: "967", isActive: false }),
      rule({ zone: "D49" }),
    ];
    expect(resolveZone(rules, "US", "96789")).toBe("D49");
  });

  it("matches a state default when the destination state matches", () => {
    const rules = [
      rule({ zone: "HI", destinationRegion: "HI" }),
      rule({ zone: "D49" }),
    ];
    expect(resolveZone(rules, "US", "96789", "HI")).toBe("HI");
  });

  it("does not apply a state rate to a different state", () => {
    const rules = [
      rule({ zone: "HI", destinationRegion: "HI" }),
      rule({ zone: "D49" }),
    ];
    expect(resolveZone(rules, "US", "90210", "CA")).toBe("D49");
  });

  it("prefers a state default over a country default", () => {
    const rules = [
      rule({ zone: "US", priority: 100 }),
      rule({ zone: "PA", destinationRegion: "PA" }),
    ];
    expect(resolveZone(rules, "US", "16066", "PA")).toBe("PA");
  });

  it("prefers a ZIP override over its state default", () => {
    const rules = [
      rule({ zone: "PA", destinationRegion: "PA" }),
      rule({ zone: "PA-160", destinationRegion: "PA", postalPrefix: "160" }),
    ];
    expect(resolveZone(rules, "US", "16066", "PA")).toBe("PA-160");
    expect(resolveZone(rules, "US", "17046", "PA")).toBe("PA");
  });

  it("matches country and postal prefix case-insensitively with trimming", () => {
    const rules = [rule({ zone: "GTA", destinationCountry: "ca", postalPrefix: "m5v" })];
    expect(resolveZone(rules, " CA ", " m5v 2t6 ")).toBe("GTA");
  });

  it("treats a blank (whitespace) prefix like a NULL country-wide default", () => {
    const rules = [
      rule({ zone: "DEFAULT", postalPrefix: "  " }),
      rule({ zone: "HI", postalPrefix: "967" }),
    ];
    expect(resolveZone(rules, "US", "30301")).toBe("DEFAULT");
    expect(resolveZone(rules, "US", "96789")).toBe("HI");
  });

  it("does not match a prefix longer than the postal code", () => {
    const rules = [rule({ zone: "LONG", postalPrefix: "902101234" })];
    expect(resolveZone(rules, "US", "90210")).toBeNull();
  });

  it("returns null for a blank country", () => {
    const rules = [rule({ zone: "D49" })];
    expect(resolveZone(rules, "  ", "90210")).toBeNull();
  });
});
