import { describe, expect, it } from "vitest";

import {
  bpsToPercentText,
  describePackUnit,
  formatPercent,
  formatRelativeTime,
  formatUnits,
  parseWholeUnits,
  percentTextToBps,
} from "../format";
import { NOW } from "./fixtures";

describe("percentages never touch floating point", () => {
  it("parses whole and fractional percentages into basis points", () => {
    expect(percentTextToBps("50")).toEqual({ ok: true, value: 5_000 });
    expect(percentTextToBps("12.5")).toEqual({ ok: true, value: 1_250 });
    expect(percentTextToBps("0.01")).toEqual({ ok: true, value: 1 });
    expect(percentTextToBps("100")).toEqual({ ok: true, value: 10_000 });
    expect(percentTextToBps(" 0 ")).toEqual({ ok: true, value: 0 });
  });

  it("rejects values outside 0–100, too many decimals, and junk", () => {
    expect(percentTextToBps("100.01").ok).toBe(false);
    expect(percentTextToBps("101").ok).toBe(false);
    expect(percentTextToBps("12.345").ok).toBe(false);
    expect(percentTextToBps("-5").ok).toBe(false);
    expect(percentTextToBps("abc").ok).toBe(false);
    expect(percentTextToBps("").ok).toBe(false);
  });

  it("round-trips basis points through the text form", () => {
    for (const bps of [0, 1, 10, 100, 1_250, 3_333, 5_000, 9_999, 10_000]) {
      const text = bpsToPercentText(bps);
      expect(percentTextToBps(text)).toEqual({ ok: true, value: bps });
    }
    expect(bpsToPercentText(1_250)).toBe("12.5");
    expect(bpsToPercentText(1_205)).toBe("12.05");
    expect(formatPercent(8_000)).toBe("80%");
  });
});

describe("whole units", () => {
  it("accepts nonnegative whole numbers as bigint-safe strings", () => {
    expect(parseWholeUnits("0", "Keep back")).toEqual({ ok: true, value: "0" });
    expect(parseWholeUnits(" 42 ", "Keep back")).toEqual({ ok: true, value: "42" });
    expect(parseWholeUnits("99999999999999999999", "Keep back")).toEqual({ ok: true, value: "99999999999999999999" });
  });

  it("rejects decimals, negatives, leading zeros and blanks", () => {
    for (const bad of ["1.5", "-1", "007", "", "x"]) {
      expect(parseWholeUnits(bad, "Keep back").ok).toBe(false);
    }
  });

  it("formats large counts without losing precision", () => {
    expect(formatUnits("1234567")).toBe("1,234,567");
    expect(formatUnits("99999999999999999999")).toBe("99,999,999,999,999,999,999");
    expect(formatUnits("0")).toBe("0");
  });
});

describe("labels", () => {
  it("names the exact sellable unit so packs are never read as pieces", () => {
    expect(describePackUnit(5)).toBe("1 unit = 5 pieces");
    expect(describePackUnit(1)).toBe("1 unit = 1 piece");
  });

  it("renders relative time from an injected clock and never guesses on bad input", () => {
    expect(formatRelativeTime("2026-09-15T11:57:00.000Z", NOW)).toBe("3 minutes ago");
    expect(formatRelativeTime("not-a-date", NOW)).toBe("at an unknown time");
  });
});
