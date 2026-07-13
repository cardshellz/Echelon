import { describe, expect, it } from "vitest";
import {
  changePoLinePricingQuantity,
  evaluatePoLinePricingDraft,
} from "../PoLinePricingEditor";
import {
  createStoredPoLinePricingDraft,
  vendorCatalogPackSizeForPricing,
} from "../stored-po-line-pricing";

describe("stored PO line quote editing", () => {
  it("preserves the original purchase UOM, rate, and UOM quantity", () => {
    const result = createStoredPoLinePricingDraft({
      pricingBasis: "per_purchase_uom",
      orderQty: 120,
      purchaseUom: "case",
      purchaseUomQuantity: 5,
      piecesPerPurchaseUom: 24,
      quotedUnitCostMills: 631_700,
      unitCostMills: 26_321,
    });

    expect(result).toEqual({
      requiresLegacyConfirmation: false,
      draft: expect.objectContaining({
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: "5",
        piecesPerUom: "24",
        pricePerUomDollars: "63.1700",
      }),
    });

    const edited = { ...result.draft, uomQuantity: "6" };
    expect(evaluatePoLinePricingDraft(edited).pricing).toEqual({
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: 6,
      piecesPerUom: 24,
      quotedCostMillsPerUom: 631_700,
    });
  });

  it("requires a revised extended total after its quoted quantity changes", () => {
    const { draft } = createStoredPoLinePricingDraft({
      pricingBasis: "extended_total",
      orderQty: 100,
      quotedTotalCents: 26_317,
      unitCostMills: 26_317,
    });

    expect(draft.quotedTotalDollars).toBe("263.17");
    const changed = changePoLinePricingQuantity(draft, "120");
    expect(changed.quotedTotalDollars).toBe("");
    expect(evaluatePoLinePricingDraft(changed)).toMatchObject({
      pricing: null,
      normalized: null,
    });
  });

  it("never silently treats a legacy normalized price as a known quote", () => {
    const result = createStoredPoLinePricingDraft({
      pricingBasis: "legacy_unknown",
      orderQty: 40,
      unitCostMills: 12_345,
      unitCostCents: 123,
    });

    expect(result.requiresLegacyConfirmation).toBe(true);
    expect(result.draft).toMatchObject({
      basis: "per_piece",
      quantityPieces: "40",
      unitPriceDollars: "1.2345",
    });
  });

  it("does not substitute normalized cost when explicit quote provenance is corrupt", () => {
    const result = createStoredPoLinePricingDraft({
      pricingBasis: "per_piece",
      orderQty: 10,
      quotedUnitCostMills: null,
      unitCostMills: 50_000,
    });

    expect(result.requiresLegacyConfirmation).toBe(false);
    expect(result.draft.unitPriceDollars).toBe("");
    expect(evaluatePoLinePricingDraft(result.draft).pricing).toBeNull();
  });

  it("derives catalog pack size from purchase UOM rather than receive-as configuration", () => {
    expect(vendorCatalogPackSizeForPricing({
      basis: "per_purchase_uom",
      purchaseUom: "carton",
      uomQuantity: 3,
      piecesPerUom: 48,
      quotedCostMillsPerUom: 900_000,
    })).toBe(48);
    expect(vendorCatalogPackSizeForPricing({
      basis: "per_piece",
      quantityPieces: 144,
      unitCostMills: 18_750,
    })).toBe(1);
  });
});
