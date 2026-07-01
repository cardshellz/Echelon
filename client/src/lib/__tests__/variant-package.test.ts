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
      weightGrams: 227,
      lengthMm: 203,
      widthMm: 102,
      heightMm: 25,
    })).toEqual({
      weightLb: "0.5",
      lengthIn: "7.992",
      widthIn: "4.016",
      heightIn: "0.984",
    });
  });

  it("builds integer storage payloads and omits blanks when requested", () => {
    expect(buildVariantPackagePayload({
      weightLb: "0.5",
      lengthIn: "",
      widthIn: "4",
      heightIn: "",
    }, "omit")).toEqual({
      weightGrams: 227,
      widthMm: 102,
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
      lengthMm: 203,
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
