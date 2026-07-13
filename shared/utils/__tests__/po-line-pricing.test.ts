import { describe, expect, it } from "vitest";
import {
  MILLS_PER_CENT,
  PO_LINE_PRICING_BASES,
  normalizePoLinePricing,
  type PoLinePricingInput,
} from "../po-line-pricing";

describe("normalizePoLinePricing", () => {
  it("exports the stable pricing bases and precision constant", () => {
    expect(PO_LINE_PRICING_BASES).toEqual([
      "per_piece",
      "per_purchase_uom",
      "extended_total",
    ]);
    expect(MILLS_PER_CENT).toBe(100);
  });

  describe("per-piece quotes", () => {
    it("keeps exact per-piece mills authoritative and derives the line total", () => {
      expect(
        normalizePoLinePricing({
          basis: "per_piece",
          quantityPieces: 100,
          unitCostMills: 26_320,
        }),
      ).toEqual({
        pricingBasis: "per_piece",
        orderQty: 100,
        purchaseUom: null,
        purchaseUomQuantity: null,
        piecesPerPurchaseUom: null,
        quotedUnitCostMills: 26_320,
        quotedTotalCents: null,
        unitCostMills: 26_320,
        unitCostCents: 263,
        totalProductCostCents: 26_320,
        pricingRemainderMills: 0,
        quotedExtendedMills: 2_632_000,
      });
    });

    it("rounds sub-cent unit and extended values half-up", () => {
      const belowHalf = normalizePoLinePricing({
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: 349,
      });
      const atHalf = normalizePoLinePricing({
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: 350,
      });

      expect(belowHalf.unitCostCents).toBe(3);
      expect(belowHalf.totalProductCostCents).toBe(3);
      expect(atHalf.unitCostCents).toBe(4);
      expect(atHalf.totalProductCostCents).toBe(4);
    });

    it("allows a free line without weakening the positive quantity rule", () => {
      expect(
        normalizePoLinePricing({
          basis: "per_piece",
          quantityPieces: 5,
          unitCostMills: 0,
        }),
      ).toMatchObject({
        orderQty: 5,
        unitCostMills: 0,
        totalProductCostCents: 0,
        quotedExtendedMills: 0,
      });
    });
  });

  describe("per-purchase-UOM quotes", () => {
    it("normalizes an evenly divisible case quote to pieces", () => {
      expect(
        normalizePoLinePricing({
          basis: "per_purchase_uom",
          purchaseUom: "case",
          uomQuantity: 10,
          piecesPerUom: 24,
          quotedCostMillsPerUom: 631_200,
        }),
      ).toEqual({
        pricingBasis: "per_purchase_uom",
        orderQty: 240,
        purchaseUom: "case",
        purchaseUomQuantity: 10,
        piecesPerPurchaseUom: 24,
        quotedUnitCostMills: 631_200,
        quotedTotalCents: null,
        unitCostMills: 26_300,
        unitCostCents: 263,
        totalProductCostCents: 63_120,
        pricingRemainderMills: 0,
        quotedExtendedMills: 6_312_000,
      });
    });

    it("preserves a negative remainder when per-piece mills round up", () => {
      const result = normalizePoLinePricing({
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: 10,
        piecesPerUom: 24,
        quotedCostMillsPerUom: 631_700,
      });

      expect(result).toMatchObject({
        orderQty: 240,
        unitCostMills: 26_321,
        totalProductCostCents: 63_170,
        pricingRemainderMills: -40,
        quotedExtendedMills: 6_317_000,
      });
      expect(
        result.unitCostMills * result.orderQty + result.pricingRemainderMills,
      ).toBe(result.quotedExtendedMills);
    });

    it("preserves a positive remainder when per-piece mills round down", () => {
      const result = normalizePoLinePricing({
        basis: "per_purchase_uom",
        purchaseUom: "pack",
        uomQuantity: 2,
        piecesPerUom: 3,
        quotedCostMillsPerUom: 1_000,
      });

      expect(result.unitCostMills).toBe(333);
      expect(result.pricingRemainderMills).toBe(2);
      expect(
        result.unitCostMills * result.orderQty + result.pricingRemainderMills,
      ).toBe(result.quotedExtendedMills);
    });

    it("uses half-up rounding at an exact normalization tie", () => {
      const result = normalizePoLinePricing({
        basis: "per_purchase_uom",
        purchaseUom: "pair",
        uomQuantity: 1,
        piecesPerUom: 2,
        quotedCostMillsPerUom: 1_001,
      });

      expect(result.unitCostMills).toBe(501);
      expect(result.pricingRemainderMills).toBe(-1);
      expect(result.totalProductCostCents).toBe(10);
    });

    it("trims the UOM label without changing the economic inputs", () => {
      expect(
        normalizePoLinePricing({
          basis: "per_purchase_uom",
          purchaseUom: "  carton  ",
          uomQuantity: 1,
          piecesPerUom: 1,
          quotedCostMillsPerUom: 100,
        }).purchaseUom,
      ).toBe("carton");
    });
  });

  describe("extended-total quotes", () => {
    it("keeps the vendor total exact while deriving per-piece mills", () => {
      expect(
        normalizePoLinePricing({
          basis: "extended_total",
          quantityPieces: 3,
          quotedTotalCents: 1_000,
        }),
      ).toEqual({
        pricingBasis: "extended_total",
        orderQty: 3,
        purchaseUom: null,
        purchaseUomQuantity: null,
        piecesPerPurchaseUom: null,
        quotedUnitCostMills: null,
        quotedTotalCents: 1_000,
        unitCostMills: 33_333,
        unitCostCents: 333,
        totalProductCostCents: 1_000,
        pricingRemainderMills: 1,
        quotedExtendedMills: 100_000,
      });
    });

    it("retains an exact cent total even when normalized unit cents are zero", () => {
      const result = normalizePoLinePricing({
        basis: "extended_total",
        quantityPieces: 8,
        quotedTotalCents: 1,
      });

      expect(result.unitCostMills).toBe(13);
      expect(result.unitCostCents).toBe(0);
      expect(result.totalProductCostCents).toBe(1);
      expect(result.pricingRemainderMills).toBe(-4);
      expect(result.quotedExtendedMills).toBe(100);
    });
  });

  describe("validation", () => {
    it.each([
      {
        basis: "per_piece",
        quantityPieces: 0,
        unitCostMills: 100,
      },
      {
        basis: "per_piece",
        quantityPieces: -1,
        unitCostMills: 100,
      },
      {
        basis: "per_piece",
        quantityPieces: 1.5,
        unitCostMills: 100,
      },
      {
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: -1,
      },
      {
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: 1.5,
      },
      {
        basis: "extended_total",
        quantityPieces: Number.NaN,
        quotedTotalCents: 100,
      },
      {
        basis: "extended_total",
        quantityPieces: 1,
        quotedTotalCents: Number.POSITIVE_INFINITY,
      },
      {
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: 0,
        piecesPerUom: 12,
        quotedCostMillsPerUom: 100,
      },
      {
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: 1,
        piecesPerUom: 0,
        quotedCostMillsPerUom: 100,
      },
      {
        basis: "per_purchase_uom",
        purchaseUom: "   ",
        uomQuantity: 1,
        piecesPerUom: 12,
        quotedCostMillsPerUom: 100,
      },
      {
        basis: "per_purchase_uom",
        purchaseUom: "x".repeat(51),
        uomQuantity: 1,
        piecesPerUom: 12,
        quotedCostMillsPerUom: 100,
      },
    ])("rejects invalid pricing input %#", (input) => {
      expect(() =>
        normalizePoLinePricing(input as PoLinePricingInput),
      ).toThrow(RangeError);
    });

    it("rejects a missing input and an unsupported basis at runtime", () => {
      expect(() =>
        normalizePoLinePricing(null as unknown as PoLinePricingInput),
      ).toThrow(RangeError);
      expect(() =>
        normalizePoLinePricing({ basis: "other" } as unknown as PoLinePricingInput),
      ).toThrow(/unsupported pricing basis/);
    });
  });

  describe("safe-integer boundaries", () => {
    it("accepts an exact safe-integer quoted extension", () => {
      const result = normalizePoLinePricing({
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: Number.MAX_SAFE_INTEGER,
      });

      expect(result.quotedExtendedMills).toBe(Number.MAX_SAFE_INTEGER);
    });

    it("rejects per-piece multiplication overflow", () => {
      expect(() =>
        normalizePoLinePricing({
          basis: "per_piece",
          quantityPieces: 2,
          unitCostMills: Number.MAX_SAFE_INTEGER,
        }),
      ).toThrow(/quotedExtendedMills exceeds the safe integer range/);
    });

    it("rejects purchase-UOM quantity and quote multiplication overflow", () => {
      expect(() =>
        normalizePoLinePricing({
          basis: "per_purchase_uom",
          purchaseUom: "case",
          uomQuantity: Number.MAX_SAFE_INTEGER,
          piecesPerUom: 2,
          quotedCostMillsPerUom: 1,
        }),
      ).toThrow(/orderQty exceeds the safe integer range/);

      expect(() =>
        normalizePoLinePricing({
          basis: "per_purchase_uom",
          purchaseUom: "case",
          uomQuantity: 2,
          piecesPerUom: 1,
          quotedCostMillsPerUom: Number.MAX_SAFE_INTEGER,
        }),
      ).toThrow(/quotedExtendedMills exceeds the safe integer range/);
    });

    it("rejects cents-to-mills overflow for extended totals", () => {
      const tooManyCents = Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1;

      expect(() =>
        normalizePoLinePricing({
          basis: "extended_total",
          quantityPieces: 1,
          quotedTotalCents: tooManyCents,
        }),
      ).toThrow(/quotedExtendedMills exceeds the safe integer range/);
    });

    it("rejects unsafe numeric inputs before conversion to BigInt", () => {
      expect(() =>
        normalizePoLinePricing({
          basis: "per_piece",
          quantityPieces: Number.MAX_SAFE_INTEGER + 1,
          unitCostMills: 1,
        }),
      ).toThrow(/positive safe integer/);
    });
  });
});
