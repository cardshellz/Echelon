import { describe, expect, it } from "vitest";
import { formatForecastWeight, formatOrderRounding } from "../reorder-explanation-format";

describe("forecast weight explanations", () => {
  it.each([[0.3, "30%"], [0.35, "35%"], [0.2, "20%"], [0.15, "15%"], [30 / 85, "35.29%"], [35 / 85, "41.18%"], [20 / 85, "23.53%"], [1, "100%"], [0, "0%"], [0.00001, "<0.01%"]])("renders normalized weight %s as %s", (weight, label) => {
    expect(formatForecastWeight(weight)).toBe(label);
  });
  it.each([NaN, Infinity, -0.1, 1.1, null, undefined, "0.3"])("does not fabricate a percentage for invalid weight %s", (weight) => {
    expect(formatForecastWeight(weight)).toBe("Weight unavailable");
  });
});

describe("captured order rounding explanations", () => {
  it("distinguishes supplier packs from price UOM and base-piece ordering", () => {
    expect(formatOrderRounding({ incrementPieces: 500, source: "vendor_pack" })).toBe("Round up in 500-piece increments (supplier case pack)");
    expect(formatOrderRounding({ incrementPieces: 6, source: "supplier_quote" })).toBe("Round up in 6-piece increments (supplier quote)");
    expect(formatOrderRounding({ incrementPieces: 1, source: "base_piece" })).toBe("Round up to whole pieces (no larger supplier increment recorded)");
  });

  it.each([undefined, null, {}, { incrementPieces: 0, source: "vendor_pack" }, { incrementPieces: 1.5, source: "supplier_quote" }, { incrementPieces: 500, source: "base_piece" }, { incrementPieces: 1, source: "vendor_pack" }, { incrementPieces: Number.MAX_SAFE_INTEGER + 1, source: "vendor_pack" }, { incrementPieces: 500, source: "warehouse_receive_pack" }])("keeps missing or malformed historical evidence explicit: %s", (value) => {
    expect(formatOrderRounding(value)).toBe("Rounding basis not recorded");
  });
});
