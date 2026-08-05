import { describe, expect, it } from "vitest";
import {
  buildVariantPackagePayload,
  formatMeasurementInput,
  GRAMS_PER_POUND,
  MILLIMETERS_PER_INCH,
  normalizeCsvHeader,
  parseCsvRows,
  variantPackageInputFromVariant,
} from "../variant-package";

describe("variant package helpers", () => {
  it("converts stored grams and millimeters to editable pound and inch inputs", () => {
    expect(variantPackageInputFromVariant({
      weightGrams: 226.8,
      lengthMm: 203.2,
      widthMm: 101.6,
      heightMm: 25.4,
    })).toEqual({
      weightLb: "0.5",
      lengthIn: "8",
      widthIn: "4",
      heightIn: "1",
    });
  });

  it("rounds stored values to 2-decimal precision and omits blanks when requested", () => {
    // 0.5 lb = 226.796185 g → stored as 226.8 (numeric(10,2) storage).
    // 4 in = 101.6 mm exactly.
    expect(buildVariantPackagePayload({
      weightLb: "0.5",
      lengthIn: "",
      widthIn: "4",
      heightIn: "",
    }, "omit")).toEqual({
      weightGrams: 226.8,
      widthMm: 101.6,
    });
  });

  it("round-trips inch inputs through millimeter storage without drift", () => {
    // Regression: integer mm storage turned 6x4x3in into 5.984x4.016x2.992.
    const stored = buildVariantPackagePayload({
      weightLb: "1",
      lengthIn: "6",
      widthIn: "4",
      heightIn: "3",
    }, "omit");
    expect(stored).toEqual({
      weightGrams: 453.59,
      lengthMm: 152.4,
      widthMm: 101.6,
      heightMm: 76.2,
    });

    const displayed = variantPackageInputFromVariant({
      weightGrams: stored.weightGrams,
      lengthMm: stored.lengthMm,
      widthMm: stored.widthMm,
      heightMm: stored.heightMm,
    });
    expect(displayed).toEqual({
      weightLb: "1",
      lengthIn: "6",
      widthIn: "4",
      heightIn: "3",
    });
  });

  it("clears blanks when the bulk edit clear mode is enabled", () => {
    expect(buildVariantPackagePayload({
      weightLb: "",
      lengthIn: "8",
      widthIn: "",
      heightIn: "",
    }, "null")).toEqual({
      weightGrams: null,
      lengthMm: 203.2,
      widthMm: null,
      heightMm: null,
    });
  });

  it("rejects invalid measurements before the request is submitted", () => {
    expect(() => buildVariantPackagePayload({
      weightLb: "-1",
      lengthIn: "",
      widthIn: "",
      heightIn: "",
    }, "omit")).toThrow("Package weight must be greater than zero");
  });

  it("parses quoted CSV rows and normalizes operator-entered headers", () => {
    expect(parseCsvRows('sku,product_name,weight_lb\n"SKU-1","Toploader, Blue",0.5\n')).toEqual([
      ["sku", "product_name", "weight_lb"],
      ["SKU-1", "Toploader, Blue", "0.5"],
    ]);
    expect(normalizeCsvHeader("Weight lbs")).toBe("weight_lbs");
    expect(formatMeasurementInput(null, GRAMS_PER_POUND)).toBe("");
  });
});
