import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  boxDimensionMmSchema, databaseMillimetersSchema, dimensionInputToMm,
  formatDimensionInches, MAX_DIMENSION_MM,
} from "../../dimensions";
import { saveCatalogBoxSchema } from "../../packaging-policy";
import { insertShippingBoxSchema, shippingBoxCatalog, shippingPackPlanParcels } from "../../../schema/shipping.schema";

describe("canonical box dimensions", () => {
  it("is independent of global Decimal precision and rounding", () => {
    const previous = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 3, rounding: Decimal.ROUND_DOWN });
      expect(dimensionInputToMm("8.001", "Length")).toBe(203.2254);
      expect(formatDimensionInches(203.2254)).toBe("8.001");
    } finally {
      Decimal.set(previous);
    }
  });
  it.each([
    ["8", 203.2], ["4", 101.6], ["6", 152.4], ["12", 304.8],
    ["13", 330.2], ["9", 228.6], ["8.125", 206.375], ["8.001", 203.2254],
    ["0.001", 0.0254],
  ])("preserves %s inches exactly through repeated edits", (inches, mm) => {
    expect(dimensionInputToMm(inches, "Length")).toBe(mm);
    for (let i = 0; i < 10; i++) {
      const reopened = formatDimensionInches(mm);
      expect(reopened).toBe(inches);
      expect(dimensionInputToMm(reopened, "Length", mm)).toBe(mm);
    }
  });
  it("preserves unchanged legacy/metric measurements rather than remeasuring rounded text", () => {
    for (const mm of [203, 102, 0.0001, 200.1234, MAX_DIMENSION_MM]) {
      expect(dimensionInputToMm(formatDimensionInches(mm), "Length", mm)).toBe(mm);
    }
    expect(dimensionInputToMm(" 7.9920 ", "Length", 203)).toBe(203);
    expect(dimensionInputToMm("8", "Length", 203)).toBe(203.2);
    expect(dimensionInputToMm("8.000", "Length", 203.2)).toBe(203.2);
    expect(dimensionInputToMm("", "Outer length", 203.2)).toBeNull();
    expect(formatDimensionInches(null)).toBe("");
  });
  it.each(["0", "-8", "NaN", "Infinity", "1e6", "0x10", "1,000", "8abc", "8.0001", "999999999999999999"])(
    "rejects invalid inch input %s", (input) => expect(() => dimensionInputToMm(input, "Length")).toThrow(),
  );
  it.each([0, -1, NaN, Infinity, MAX_DIMENSION_MM + 1, 203.22541, "203.2", null, true])(
    "does not silently coerce or round HTTP dimensions %s", (input) => {
      expect(boxDimensionMmSchema.safeParse(input).success).toBe(false);
    },
  );
  it("converts pg numerics only at the database boundary", () => {
    expect(databaseMillimetersSchema.parse("203.2254")).toBe(203.2254);
    expect(databaseMillimetersSchema.parse(203)).toBe(203);
    expect(databaseMillimetersSchema.parse("0.0000")).toBe(0);
    for (const input of ["", "203bad", "NaN", "Infinity", "203.22541", true, null]) {
      expect(databaseMillimetersSchema.safeParse(input).success).toBe(false);
    }
  });
  const command = {
    code: "8X6X4", name: "Measured box", kind: "box", branding: "unbranded",
    lengthMm: 203.2, widthMm: 152.4, heightMm: 101.6,
    outerLengthMm: 209.55, outerWidthMm: 158.75, outerHeightMm: 107.95,
    tareWeightGrams: 45, maxWeightGrams: null, costCents: 25,
    fillFactorBps: 8500, isActive: true, expectedRevision: 0,
    commandId: "123e4567-e89b-42d3-a456-426614174000",
  };
  it("accepts decimal dimensions while retaining whole cents, weights, IDs and fill basis points", () => {
    expect(saveCatalogBoxSchema.parse(command)).toEqual(command);
    expect(insertShippingBoxSchema.parse(command)).toMatchObject({ lengthMm: 203.2, outerLengthMm: 209.55 });
    for (const change of [{ costCents: 25.5 }, { tareWeightGrams: 1.5 }, { id: 1.5 }, { fillFactorBps: 8500.5 },
      { outerWidthMm: null }, { outerLengthMm: 203.1999 }, { heightMm: 1.00001 }]) {
      expect(saveCatalogBoxSchema.safeParse({ ...command, ...change }).success).toBe(false);
    }
  });
  it("keeps Drizzle DTOs numeric and rejects invalid writes without changing global pg parsing", () => {
    for (const column of [shippingBoxCatalog.lengthMm, shippingBoxCatalog.outerWidthMm, shippingPackPlanParcels.heightMm]) {
      expect(column.getSQLType()).toBe("numeric(14,4)");
      expect(column.mapToDriverValue(203.2254)).toBe("203.2254");
      expect(column.mapFromDriverValue("203.2254")).toBe(203.2254);
      expect(() => column.mapToDriverValue(203.22541)).toThrow();
      expect(() => column.mapFromDriverValue("NaN")).toThrow();
    }
  });
});
