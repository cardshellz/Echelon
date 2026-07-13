import { describe, expect, it } from "vitest";
import {
  changePoLinePricingQuantity,
  createEmptyPoLinePricingDraft,
  createPerPiecePricingDraft,
  createVendorCatalogPricingDraft,
  evaluatePoLinePricingDraft,
  formatVendorCatalogQuote,
  receiveConfigurationQuantitySummary,
  vendorCatalogQuoteStatus,
} from "../PoLinePricingEditor";
import { formatCatalogCandidateQuote } from "../AddToCatalogDialog";

describe("PO line pricing editor conversion", () => {
  it("preserves a four-decimal per-piece vendor quote", () => {
    const result = evaluatePoLinePricingDraft(
      createPerPiecePricingDraft(120, 26_320),
    );

    expect(result.error).toBeNull();
    expect(result.pricing).toEqual({
      basis: "per_piece",
      quantityPieces: 120,
      unitCostMills: 26_320,
    });
    expect(result.normalized?.totalProductCostCents).toBe(31_584);
  });

  it("keeps purchase UOM pricing separate from receiving configuration", () => {
    const result = evaluatePoLinePricingDraft(
      createEmptyPoLinePricingDraft({
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: "10",
        piecesPerUom: "24",
        pricePerUomDollars: "63.1700",
      }),
    );

    expect(result.pricing).toEqual({
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: 10,
      piecesPerUom: 24,
      quotedCostMillsPerUom: 631_700,
    });
    expect(result.normalized?.orderQty).toBe(240);
    expect(result.normalized?.totalProductCostCents).toBe(63_170);
  });

  it("preserves an exact extended-total quote", () => {
    const result = evaluatePoLinePricingDraft(
      createEmptyPoLinePricingDraft({
        basis: "extended_total",
        quantityPieces: "100",
        quotedTotalDollars: "263.17",
      }),
    );

    expect(result.pricing).toEqual({
      basis: "extended_total",
      quantityPieces: 100,
      quotedTotalCents: 26_317,
    });
    expect(result.normalized?.totalProductCostCents).toBe(26_317);
  });

  it("requires a fresh total when an extended-quote quantity changes", () => {
    const original = createEmptyPoLinePricingDraft({
      basis: "extended_total",
      quantityPieces: "100",
      quotedTotalDollars: "263.17",
    });

    expect(changePoLinePricingQuantity(original, "120")).toMatchObject({
      quantityPieces: "120",
      quotedTotalDollars: "",
    });
  });

  it("prefills a catalog row using its original purchase-UOM quote", () => {
    const draft = createVendorCatalogPricingDraft({
      pricingBasis: "per_purchase_uom",
      purchaseUom: "case",
      piecesPerPurchaseUom: 24,
      quotedUnitCostMills: 631_700,
      unitCostMills: 26_321,
      moq: 240,
    });

    expect(draft).toMatchObject({
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: "10",
      piecesPerUom: "24",
      pricePerUomDollars: "63.1700",
    });
  });

  it("keeps a legacy normalized catalog cost blank until its quote is verified", () => {
    const draft = createVendorCatalogPricingDraft({
      pricingBasis: "legacy_unknown",
      unitCostMills: 26_321,
      unitCostCents: 263,
      moq: 5,
    });

    expect(draft).toMatchObject({
      basis: "per_piece",
      quantityPieces: "5",
      unitPriceDollars: "",
    });
    expect(evaluatePoLinePricingDraft(draft).pricing).toBeNull();
    expect(formatVendorCatalogQuote({
      pricingBasis: "legacy_unknown",
      unitCostMills: 26_321,
    })).toBe("$2.6321 normalized cost (quote basis unknown)");
  });

  it("describes partial receive configurations without rounding them up", () => {
    expect(receiveConfigurationQuantitySummary(14, 6)).toBe(
      "2 full configurations at 6 pieces each plus 2 loose pieces",
    );
    expect(receiveConfigurationQuantitySummary(12, 6)).toBe(
      "2 full configurations at 6 pieces each",
    );
  });

  it("shows a catalog candidate in the original vendor-facing UOM", () => {
    expect(formatCatalogCandidateQuote({
      clientId: "line-1",
      productId: 1,
      productVariantId: 2,
      productName: "Widget",
      sku: "W-1",
      unitCostCents: 263,
      unitCostMills: 26_321,
      pricing: {
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: 10,
        piecesPerUom: 24,
        quotedCostMillsPerUom: 631_700,
      },
    })).toEqual({
      amount: "$63.1700 per case",
      detail: "24 pieces per case",
    });
  });

  it("does not truncate a large legacy catalog amount through 32-bit arithmetic", () => {
    expect(formatCatalogCandidateQuote({
      clientId: "line-large",
      productId: 1,
      productVariantId: 2,
      productName: "Industrial equipment",
      sku: "EQ-1",
      unitCostCents: 3_000_000_000,
    }).amount).toBe("$30,000,000.0000 per item");
  });

  it("rejects excess precision instead of silently truncating", () => {
    const unitResult = evaluatePoLinePricingDraft(
      createEmptyPoLinePricingDraft({ unitPriceDollars: "1.23456" }),
    );
    const totalResult = evaluatePoLinePricingDraft(
      createEmptyPoLinePricingDraft({
        basis: "extended_total",
        quantityPieces: "1",
        quotedTotalDollars: "1.001",
      }),
    );

    expect(unitResult.pricing).toBeNull();
    expect(unitResult.error).toContain("4 decimal places");
    expect(totalResult.pricing).toBeNull();
    expect(totalResult.error).toContain("2 decimal places");
  });

  it("rejects quantities that cannot fit the database integer columns", () => {
    const result = evaluatePoLinePricingDraft(
      createEmptyPoLinePricingDraft({ quantityPieces: "2147483648", unitPriceDollars: "1.0000" }),
    );

    expect(result.pricing).toBeNull();
    expect(result.error).toContain("2,147,483,647");
  });

  it("rejects a purchase-UOM combination whose derived piece quantity overflows", () => {
    const result = evaluatePoLinePricingDraft(
      createEmptyPoLinePricingDraft({
        basis: "per_purchase_uom",
        purchaseUom: "case",
        uomQuantity: "50000",
        piecesPerUom: "50000",
        pricePerUomDollars: "1.0000",
      }),
    );

    expect(result.pricing).toBeNull();
    expect(result.error).toContain("2,147,483,647");
  });

  it("classifies catalog quote freshness before claiming automated provenance", () => {
    const evaluatedAt = new Date("2026-07-13T12:00:00.000Z");
    const base = {
      pricingBasis: "per_piece",
      quotedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(vendorCatalogQuoteStatus(base, evaluatedAt)).toBe("usable");
    expect(vendorCatalogQuoteStatus({
      ...base,
      quoteValidUntil: "2026-07-12",
    }, evaluatedAt)).toBe("expired");
    expect(vendorCatalogQuoteStatus({
      ...base,
      quotedAt: "2025-01-01T00:00:00.000Z",
    }, evaluatedAt)).toBe("stale");
    expect(vendorCatalogQuoteStatus({
      ...base,
      quotedAt: "2026-07-13T12:06:00.000Z",
    }, evaluatedAt)).toBe("future");
    expect(vendorCatalogQuoteStatus({ pricingBasis: "legacy_unknown" }, evaluatedAt)).toBe("legacy");
  });
});
