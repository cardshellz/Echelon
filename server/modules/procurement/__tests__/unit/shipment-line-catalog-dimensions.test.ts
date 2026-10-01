import { describe, expect, it } from "vitest";
import { shipmentLineEditableSchema } from "@shared/procurement/shipment-line-command";
import { catalogDimensionsForShipmentLine } from "../../shipment-line-catalog-dimensions";

// ESS-TOP-STD-SLV-CLR-C1000 as stored in catalog.product_variants: 18.001 lb
// and 18 x 9 x 6 in. Its PO line could not be added to a shipment because
// 8165.12 g converted to 8.16512 kg.
const caseOf1000 = {
  weightGrams: "8165.12",
  lengthMm: "457.20",
  widthMm: "228.60",
  heightMm: "152.40",
};

describe("catalogDimensionsForShipmentLine", () => {
  it("converts the reported case to values a shipment line can hold", () => {
    const dimensions = catalogDimensionsForShipmentLine(caseOf1000);
    expect(dimensions).toEqual({
      weightKg: "8.165",
      lengthCm: "45.72",
      widthCm: "22.86",
      heightCm: "15.24",
    });
    expect(shipmentLineEditableSchema.safeParse({
      ...dimensions,
      qtyShipped: 525_000,
      cartonCount: 525,
    }).success).toBe(true);
  });

  it("rounds half-up at the line's scale", () => {
    expect(catalogDimensionsForShipmentLine({ weightGrams: "1.50" }).weightKg).toBe("0.002");
    expect(catalogDimensionsForShipmentLine({ weightGrams: "1.49" }).weightKg).toBe("0.001");
    expect(catalogDimensionsForShipmentLine({ lengthMm: "123.45" }).lengthCm).toBe("12.35");
    expect(catalogDimensionsForShipmentLine({ lengthMm: "123.44" }).lengthCm).toBe("12.34");
  });

  it("keeps already representable values exact", () => {
    expect(catalogDimensionsForShipmentLine({
      weightGrams: "8165.00",
      lengthMm: "1000",
      widthMm: "0.00",
      heightMm: "152.4",
    })).toEqual({ weightKg: "8.165", lengthCm: "100", widthCm: "0", heightCm: "15.24" });
  });

  it("passes missing values through as null", () => {
    const empty = { weightKg: null, lengthCm: null, widthCm: null, heightCm: null };
    expect(catalogDimensionsForShipmentLine(undefined)).toEqual(empty);
    expect(catalogDimensionsForShipmentLine(null)).toEqual(empty);
    expect(catalogDimensionsForShipmentLine({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    })).toEqual(empty);
  });

  it("does not turn invalid catalog data into a valid line", () => {
    const negative = catalogDimensionsForShipmentLine({ weightGrams: "-5.00" });
    expect(negative.weightKg).toBe("-0.005");
    expect(shipmentLineEditableSchema.safeParse({ weightKg: negative.weightKg }).success).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = { ...caseOf1000 };
    catalogDimensionsForShipmentLine(input);
    expect(input).toEqual(caseOf1000);
  });
});
