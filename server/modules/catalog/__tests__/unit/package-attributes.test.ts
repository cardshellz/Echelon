import { describe, expect, it } from "vitest";
import {
  coercePackageAttributesOnVariantPayload,
  extractPackageAttributeUpdates,
  parsePackageAttributeBulkRows,
  PackageAttributeValidationError,
} from "../../package-attributes";

describe("catalog package attributes", () => {
  it("coerces valid package fields from a single variant payload", () => {
    expect(coercePackageAttributesOnVariantPayload({
      sku: "SHLZ-TOP-100PT-P20",
      weightGrams: 227,
      lengthMm: 203,
      widthMm: 102,
      heightMm: 25,
    })).toEqual({
      weightGrams: 227,
      lengthMm: 203,
      widthMm: 102,
      heightMm: 25,
    });
  });

  it("keeps null package fields so callers can clear stored package data", () => {
    expect(extractPackageAttributeUpdates({
      weightGrams: null,
      lengthMm: 203,
    })).toEqual({
      weightGrams: null,
      lengthMm: 203,
    });
  });

  it("rejects floating point and non-positive package values", () => {
    expect(() => extractPackageAttributeUpdates({ weightGrams: 1.5 })).toThrow(PackageAttributeValidationError);
    expect(() => extractPackageAttributeUpdates({ lengthMm: 0 })).toThrow(PackageAttributeValidationError);
    expect(() => extractPackageAttributeUpdates({ widthMm: -1 })).toThrow(PackageAttributeValidationError);
  });

  it("ignores non-package fields on normal variant payloads", () => {
    expect(coercePackageAttributesOnVariantPayload({
      name: "Pack of 20",
      sku: "SHLZ-TOP-100PT-P20",
    })).toEqual({});
  });

  it("rejects bulk rows with no package field updates", () => {
    expect(() => parsePackageAttributeBulkRows([
      { variantId: 10, updates: { sku: "NOT-A-PACKAGE-FIELD" } },
    ])).toThrow("At least one package attribute update is required");
  });

  it("normalizes bulk package update rows", () => {
    expect(parsePackageAttributeBulkRows([
      { variantId: "10", updates: { weightGrams: 227 } },
      { variantId: 11, updates: { lengthMm: null, widthMm: 102 } },
    ])).toEqual([
      { variantId: 10, updates: { weightGrams: 227 } },
      { variantId: 11, updates: { lengthMm: null, widthMm: 102 } },
    ]);
  });

  it("rejects invalid bulk rows before any database write can run", () => {
    expect(() => parsePackageAttributeBulkRows([])).toThrow("rows array required");
    expect(() => parsePackageAttributeBulkRows([{ variantId: 0, updates: { weightGrams: 100 } }])).toThrow("Row 1 has an invalid variantId");
    expect(() => parsePackageAttributeBulkRows([{ variantId: 12, updates: { heightMm: "10" } }])).toThrow("heightMm must be a positive integer or null");
  });
});
