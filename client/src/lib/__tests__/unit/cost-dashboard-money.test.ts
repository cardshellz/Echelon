import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  formatDashboardCents,
  formatDashboardMills,
  formatDashboardLotCost,
  formatDashboardLotValue,
  parseDashboardRecostInput,
} from "../../cost-dashboard-money";

describe("cost dashboard display units", () => {
  it.each([
    [450000, "$4,500.00"], [23000, "$230.00"], [230, "$2.30"],
    [0, "$0.00"], [-0, "$0.00"], [1, "$0.01"], [-10, "-$0.10"],
    [3.75, "$0.0375"], [0.01, "$0.0001"], [-0.25, "-$0.0025"],
    ["450000", "$4,500.00"], ["-3000", "-$30.00"], ["3.7500", "$0.0375"],
    [Number.MAX_SAFE_INTEGER, "$90,071,992,547,409.91"],
    ["9223372036854775807", "$92,233,720,368,547,758.07"],
    [BigInt("-9223372036854775808"), "-$92,233,720,368,547,758.08"],
  ])("formats %s cents as %s", (value, expected) => {
    expect(formatDashboardCents(value)).toBe(expected);
  });

  it.each([null, undefined])("keeps missing %s distinct from recorded zero", (value) => {
    expect(formatDashboardCents(value)).toBe("Not recorded");
    expect(formatDashboardMills(value)).toBe("Not recorded");
  });

  it.each([NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "", " ", "NaN", "Infinity", "$23", "23 cents", "1e3", "1".repeat(65), {}, [], true])(
    "does not display invalid money %j as zero or a trusted amount", (value) => {
      expect(formatDashboardCents(value)).toBe("Unavailable");
      expect(formatDashboardMills(value)).toBe("Unavailable");
    },
  );

  it.each([[375, "$0.0375"], [1, "$0.0001"], [0, "$0.00"], [-25, "-$0.0025"], ["23000", "$2.30"], [375.5, "Unavailable"]])(
    "formats %s integer mills as %s", (value, expected) => expect(formatDashboardMills(value)).toBe(expected),
  );

  it("does not inherit unrelated Decimal precision or rounding changes", () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 3, rounding: Decimal.ROUND_DOWN });
      expect(formatDashboardCents("9223372036854775807")).toBe("$92,233,720,368,547,758.07");
    } finally {
      Decimal.set(previous);
    }
  });
});

describe("lot display follows existing mills and legacy-cent evidence", () => {
  it("uses nonzero total mills ahead of the rounded cent mirror", () => {
    expect(formatDashboardLotCost({ total_unit_cost_mills: "375", unit_cost_mills: "350", total_unit_cost_cents: "4" })).toBe("$0.0375");
  });

  it("uses the legacy unit mills when total mills is the default zero", () => {
    expect(formatDashboardLotCost({ total_unit_cost_mills: "0", unit_cost_mills: "375", total_unit_cost_cents: "4" })).toBe("$0.0375");
  });

  it("retains populated cents when newly added mill columns contain only default zero", () => {
    expect(formatDashboardLotCost({ total_unit_cost_mills: "0", unit_cost_mills: "0", total_unit_cost_cents: "230", unit_cost_cents: "225" })).toBe("$2.30");
    expect(formatDashboardLotCost({ total_unit_cost_mills: 0, unit_cost_mills: null, total_unit_cost_cents: 0, unit_cost_cents: 230 })).toBe("$2.30");
  });

  it("distinguishes zero, absent evidence and invalid authoritative evidence", () => {
    expect(formatDashboardLotCost({ total_unit_cost_mills: "0", unit_cost_cents: "0" })).toBe("$0.00");
    expect(formatDashboardLotCost({})).toBe("Not recorded");
    expect(formatDashboardLotCost({ total_unit_cost_mills: "broken", total_unit_cost_cents: "230" })).toBe("Unavailable");
  });

  it("keeps product and freight components separate, including a signed freight amount", () => {
    const lot = { po_unit_cost_mills: "350", po_unit_cost_cents: "4", landed_cost_mills: "-25", landed_cost_cents: "0", total_unit_cost_mills: "325" };
    expect(formatDashboardLotCost(lot, "product")).toBe("$0.0350");
    expect(formatDashboardLotCost(lot, "landed")).toBe("-$0.0025");
    expect(formatDashboardLotCost(lot)).toBe("$0.0325");
    expect(formatDashboardLotCost({ po_unit_cost_mills: 0, po_unit_cost_cents: 230 }, "product")).toBe("$2.30");
    expect(formatDashboardLotCost({ landed_cost_mills: 0, landed_cost_cents: 20 }, "landed")).toBe("$0.20");
  });

  it("sums exact units before formatting instead of accumulating rounded cent mirrors", () => {
    const lots = Object.freeze([
      Object.freeze({ qty_on_hand: 100, total_unit_cost_mills: "375", total_unit_cost_cents: "4" }),
      Object.freeze({ qty_on_hand: 10, total_unit_cost_mills: "0", unit_cost_mills: "0", total_unit_cost_cents: "230" }),
      Object.freeze({ qty_on_hand: 1, total_unit_cost_mills: "0", total_unit_cost_cents: "0" }),
    ]);
    expect(formatDashboardLotValue(lots)).toBe("$26.75");
    expect(formatDashboardLotValue([])).toBe("$0.00");
    expect(formatDashboardLotValue([{ qty_on_hand: 3, total_unit_cost_cents: "0.1" }])).toBe("$0.0030");
  });

  it("does not hide a missing cost or invalid quantity inside a product total", () => {
    expect(formatDashboardLotValue([{ qty_on_hand: 5 }])).toBe("Not recorded");
    expect(formatDashboardLotValue([{ qty_on_hand: -1, unit_cost_cents: 100 }])).toBe("Unavailable");
    expect(formatDashboardLotValue([{ qty_on_hand: 0.5, unit_cost_cents: 100 }])).toBe("Unavailable");
    expect(formatDashboardLotValue([{ qty_on_hand: "invalid", unit_cost_cents: 100 }])).toBe("Unavailable");
  });

  it.each([
    ["0", 0, 0], ["0.0375", 375, 0.0375], [".0001", 1, 0.0001],
    ["112589990684.2623", 1125899906842623, 112589990684.2623],
    ["112589990684.2624", 1125899906842624, 112589990684.2624],
  ])("retains exact representable product input %s for the existing numeric route", (raw, mills, dollars) => {
    const parsed = parseDashboardRecostInput(String(raw));
    expect(parsed).toEqual({ valid: true, perPieceMills: mills, dollars });
    // Contract assertion for the unchanged legacy route, not production math.
    if (parsed.valid) expect(Math.round(parsed.dollars * 10000)).toBe(parsed.perPieceMills);
  });

  it.each(["0.00015", "0.000049", "-1", "1e3", "$2", "1.2.3"])("rejects unsupported precision or syntax %s before recost", (raw) => {
    expect(parseDashboardRecostInput(raw)).toEqual({ valid: false, error: "Enter a nonnegative amount with at most 4 decimal places." });
  });

  it.each(["112589990684.2625", "805101709452.9024"])("rejects %s beyond the exact numeric transport limit", (raw) => {
    expect(parseDashboardRecostInput(raw)).toMatchObject({ valid: false, error: expect.stringContaining("exact numeric limit") });
  });

  it("keeps empty input inactive and rejects unsafe integer mills", () => {
    expect(parseDashboardRecostInput(" ")).toEqual({ valid: false, error: null });
    expect(parseDashboardRecostInput("900719925474.0992")).toEqual({ valid: false, error: "The amount exceeds the supported limit." });
  });
});
