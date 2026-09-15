/**
 * Readiness refuses a quantity that exceeds canonical ATP and nothing else, so
 * a rule entered with the wrong unit basis, or a legacy days-of-cover floor
 * that has no canonical equivalent, yields a wrong but under-ATP number that
 * passes every blocker. This summary is what makes such a row visible without
 * reading a full-catalog report by hand.
 */
import { describe, expect, it } from "vitest";

import { summarizeCutoverDivergence } from "../../domain/inventory-channel-exposure";

const row = (legacyCalculatedUnits: string, desiredUnits: string) =>
  ({ legacyCalculatedUnits, desiredUnits });

describe("summarizeCutoverDivergence", () => {
  it("reports an empty catalog without inventing a divergence", () => {
    expect(summarizeCutoverDivergence([])).toEqual({
      rowsMatchingLegacy: 0,
      rowsAboveLegacy: 0,
      rowsBelowLegacy: 0,
      largestIncreaseUnits: "0",
      largestDecreaseUnits: "0",
    });
  });

  it("counts a configuration that reproduces legacy exactly", () => {
    const summary = summarizeCutoverDivergence([row("10", "10"), row("0", "0"), row("7", "7")]);

    expect(summary).toMatchObject({ rowsMatchingLegacy: 3, rowsAboveLegacy: 0, rowsBelowLegacy: 0 });
    expect(summary.largestIncreaseUnits).toBe("0");
    expect(summary.largestDecreaseUnits).toBe("0");
  });

  it("separates increases from decreases and reports each extreme", () => {
    const summary = summarizeCutoverDivergence([
      row("10", "14"),
      row("100", "40"),
      row("5", "5"),
      row("8", "9"),
    ]);

    expect(summary).toEqual({
      rowsMatchingLegacy: 1,
      rowsAboveLegacy: 2,
      rowsBelowLegacy: 1,
      largestIncreaseUnits: "4",
      largestDecreaseUnits: "60",
    });
  });

  // The legacy caps and floors are counted in base pieces while the canonical
  // fields are whole sellable units, so copying a number across a 12-piece pack
  // publishes twelve times too much. That row is under ATP and passes readiness.
  it("surfaces a unit-basis error that no blocker would refuse", () => {
    const summary = summarizeCutoverDivergence([row("10", "120")]);

    expect(summary.rowsAboveLegacy).toBe(1);
    expect(summary.largestIncreaseUnits).toBe("110");
  });

  // A days-of-cover floor zeroes a row in legacy and has no canonical
  // equivalent, so the row silently starts publishing after cutover.
  it("surfaces a floor that stopped being applied", () => {
    const summary = summarizeCutoverDivergence([row("0", "43")]);

    expect(summary.rowsAboveLegacy).toBe(1);
    expect(summary.largestIncreaseUnits).toBe("43");
  });

  // Quantities are Postgres bigints carried as strings; a Number conversion
  // would lose precision and understate the divergence it exists to reveal.
  it("keeps full precision beyond the safe integer range", () => {
    const legacy = "9007199254740993";
    const desired = "9007199254740995";

    expect(summarizeCutoverDivergence([row(legacy, desired)])).toMatchObject({
      rowsAboveLegacy: 1,
      largestIncreaseUnits: "2",
    });
  });

  it("scales over a large catalog without losing either extreme", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => row("100", String(100 + (index % 7))));

    const summary = summarizeCutoverDivergence([...rows, row("100", "1"), row("1", "500")]);

    expect(summary.largestDecreaseUnits).toBe("99");
    expect(summary.largestIncreaseUnits).toBe("499");
    expect(summary.rowsMatchingLegacy + summary.rowsAboveLegacy + summary.rowsBelowLegacy)
      .toBe(rows.length + 2);
  });
});
