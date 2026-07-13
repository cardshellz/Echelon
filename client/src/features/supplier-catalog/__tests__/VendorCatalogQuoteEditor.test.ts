import { describe, expect, it } from "vitest";
import {
  beginVendorCatalogQuoteReview,
  buildVendorCatalogQuoteWrite,
  createNewVendorCatalogQuoteDraft,
  createVendorCatalogQuoteDraft,
  evaluateVendorCatalogQuoteDraft,
  formatVendorCatalogQuoteSummary,
} from "../VendorCatalogQuoteEditor";

const NOW = new Date("2026-07-13T12:00:00.000Z");

describe("vendor catalog quote editing", () => {
  it("creates a new mapping with an explicit four-decimal per-piece quote", () => {
    const draft = {
      ...createNewVendorCatalogQuoteDraft(NOW),
      unitPriceDollars: "2.6321",
      quoteReference: "Q-1042",
      quoteValidUntil: "2026-08-31",
    };

    expect(buildVendorCatalogQuoteWrite(draft, null, NOW)).toEqual({
      pricing: {
        basis: "per_piece",
        quantityPieces: 1,
        unitCostMills: 26_321,
      },
      quoteReference: "Q-1042",
      quotedAt: "2026-07-13",
      quoteValidUntil: "2026-08-31",
    });
  });

  it("preserves the supplier's purchase-UOM price and derives a normalized preview", () => {
    const draft = {
      ...createNewVendorCatalogQuoteDraft(NOW),
      basis: "per_purchase_uom" as const,
      purchaseUom: "case",
      piecesPerUom: "24",
      pricePerUomDollars: "63.1700",
    };

    const result = evaluateVendorCatalogQuoteDraft(draft, NOW);

    expect(result.pricing).toEqual({
      basis: "per_purchase_uom",
      purchaseUom: "case",
      uomQuantity: 1,
      piecesPerUom: 24,
      quotedCostMillsPerUom: 631_700,
    });
    expect(result.normalized?.unitCostMills).toBe(26_321);
  });

  it("omits all economics and metadata when only non-price fields change", () => {
    const original = {
      pricingBasis: "per_piece",
      quotedUnitCostMills: 26_321,
      unitCostMills: 26_321,
      quoteReference: "Q-1",
      quotedAt: "2026-06-01T14:37:22.000Z",
      quoteValidUntil: "2026-08-01",
    };
    const draft = createVendorCatalogQuoteDraft(original);

    expect(buildVendorCatalogQuoteWrite(draft, original, NOW)).toEqual({});
  });

  it("sends only changed metadata and never refreshes quotedAt implicitly", () => {
    const original = {
      pricingBasis: "per_piece",
      quotedUnitCostMills: 26_321,
      unitCostMills: 26_321,
      quoteReference: "Q-1",
      quotedAt: "2026-06-01T14:37:22.000Z",
      quoteValidUntil: "2026-08-01",
    };
    const draft = {
      ...createVendorCatalogQuoteDraft(original),
      quoteReference: "Q-1-revised",
      quoteValidUntil: "2026-09-01",
    };

    expect(buildVendorCatalogQuoteWrite(draft, original, NOW)).toEqual({
      quoteReference: "Q-1-revised",
      quoteValidUntil: "2026-09-01",
    });
  });

  it("retains the original timestamp when repricing on the same quote date", () => {
    const original = {
      pricingBasis: "per_piece",
      quotedUnitCostMills: 26_321,
      unitCostMills: 26_321,
      quoteReference: "Q-1",
      quotedAt: "2026-06-01T14:37:22.000Z",
      quoteValidUntil: null,
    };
    const draft = {
      ...createVendorCatalogQuoteDraft(original),
      unitPriceDollars: "2.7000",
    };

    expect(buildVendorCatalogQuoteWrite(draft, original, NOW)).toMatchObject({
      pricing: {
        basis: "per_piece",
        unitCostMills: 27_000,
      },
      quotedAt: "2026-06-01T14:37:22.000Z",
    });
  });

  it("leaves a legacy price untouched until an operator identifies its quote basis", () => {
    const original = {
      pricingBasis: "legacy_unknown",
      unitCostMills: 26_321,
      unitCostCents: 263,
    };
    const reviewDraft = createVendorCatalogQuoteDraft(original);

    expect(reviewDraft.state).toBe("review_required");
    expect(buildVendorCatalogQuoteWrite(reviewDraft, original, NOW)).toEqual({});

    const replacement = beginVendorCatalogQuoteReview(reviewDraft, NOW);
    expect(replacement.state).toBe("explicit");
    expect(replacement.unitPriceDollars).toBe("");
    expect(replacement.pricePerUomDollars).toBe("");
  });

  it("does not flatten an explicit purchase-UOM row when reopening it", () => {
    const original = {
      pricingBasis: "per_purchase_uom",
      purchaseUom: "carton",
      piecesPerPurchaseUom: 18,
      quotedUnitCostMills: 425_375,
      unitCostMills: 23_632,
      quoteReference: "EMAIL-8",
      quotedAt: "2026-07-01T09:00:00.000Z",
    };
    const draft = createVendorCatalogQuoteDraft(original);

    expect(draft).toMatchObject({
      state: "explicit",
      basis: "per_purchase_uom",
      purchaseUom: "carton",
      piecesPerUom: "18",
      pricePerUomDollars: "42.5375",
    });
    expect(buildVendorCatalogQuoteWrite(draft, original, NOW)).toEqual({});
  });

  it("labels legacy normalized costs as review-required instead of vendor quotes", () => {
    expect(formatVendorCatalogQuoteSummary({
      pricingBasis: "legacy_unknown",
      unitCostMills: 26_321,
    })).toEqual({
      amount: "$2.6321 normalized cost",
      detail: "Quote basis unknown — review required",
      reviewRequired: true,
    });
  });

  it("does not reinterpret a missing explicit quote amount as a zero-dollar quote", () => {
    const original = {
      pricingBasis: "per_piece",
      quotedUnitCostMills: null,
      unitCostMills: 0,
      quotedAt: "2026-07-01T00:00:00.000Z",
    };

    expect(createVendorCatalogQuoteDraft(original)).toMatchObject({
      state: "review_required",
      reviewReason: "incomplete_explicit",
    });
    expect(formatVendorCatalogQuoteSummary(original).reviewRequired).toBe(true);
  });

  it("rejects excess precision and invalid quote dates", () => {
    const excessivePrecision = {
      ...createNewVendorCatalogQuoteDraft(NOW),
      unitPriceDollars: "1.23456",
    };
    const invalidDates = {
      ...createNewVendorCatalogQuoteDraft(NOW),
      unitPriceDollars: "1.0000",
      quoteValidUntil: "2026-07-12",
    };

    expect(evaluateVendorCatalogQuoteDraft(excessivePrecision, NOW).error).toContain("4 decimal places");
    expect(evaluateVendorCatalogQuoteDraft(invalidDates, NOW).error).toContain("earlier than the quote date");
  });
});
