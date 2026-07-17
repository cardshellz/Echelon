import { describe, expect, it } from "vitest";
import { buildPurchasingRfqQueue, isPurchasingRfqCandidate } from "../../purchasing-rfq.service";

function recommendation(overrides: Record<string, unknown> = {}) {
  return {
    recommendationId: "20:30:90",
    productId: 20,
    productVariantId: 30,
    sku: "SKU-RED",
    productName: "Red Card Shell",
    status: "order_now",
    skippedReason: "no_vendor",
    suggestedOrderPieces: 96,
    available: 12,
    onOrderPieces: 0,
    reorderPoint: 108,
    preferredVendorId: null,
    preferredVendorName: null,
    currentSupply: { effectiveSupplyPieces: 12 },
    demandBasis: { avgDailyUsagePieces: 2, periodUsagePieces: 180 },
    forecastProvenance: { demandWindowDays: 90 },
    supplierBasis: {
      vendorProductId: null,
      costSource: "missing",
      costQuality: "missing",
      estimatedCostMills: null,
      estimatedCostCents: null,
    },
    ...overrides,
  } as any;
}

describe("purchasing RFQ queue", () => {
  it("surfaces the exact SKU and required pieces without a vendor or price", () => {
    const item = recommendation();

    expect(isPurchasingRfqCandidate(item)).toBe(true);
    expect(buildPurchasingRfqQueue({ items: [], skippedItems: [item] })).toEqual([
      expect.objectContaining({
        recommendationId: "20:30:90",
        sku: "SKU-RED",
        requestedPieces: 96,
        supplierAssignmentRequired: true,
        preferredVendorId: null,
        vendorProductId: null,
      }),
    ]);
  });

  it("keeps a price-free requirement visible when a preferred vendor is already assigned", () => {
    const item = recommendation({
      skippedReason: null,
      preferredVendorId: 7,
      preferredVendorName: "Supply Co",
      supplierBasis: {
        vendorProductId: 44,
        costSource: "missing",
        costQuality: "missing",
        estimatedCostMills: null,
        estimatedCostCents: null,
      },
    });

    expect(buildPurchasingRfqQueue({ items: [item], skippedItems: [] })[0]).toMatchObject({
      requestedPieces: 96,
      preferredVendorId: 7,
      preferredVendorName: "Supply Co",
      vendorProductId: 44,
      supplierAssignmentRequired: false,
    });
  });

  it.each(["excluded", "already_on_order", "not_actionable_status", "zero_suggested_quantity"])(
    "does not create an RFQ candidate when the recommendation is %s",
    (skippedReason) => {
      expect(isPurchasingRfqCandidate(recommendation({ skippedReason }))).toBe(false);
    },
  );

  it("requires a positive base-piece quantity", () => {
    expect(isPurchasingRfqCandidate(recommendation({ suggestedOrderPieces: 0 }))).toBe(false);
    expect(isPurchasingRfqCandidate(recommendation({ suggestedOrderPieces: 1.5 }))).toBe(false);
  });

  it("preserves the demand evidence used to justify the RFQ quantity", () => {
    const [item] = buildPurchasingRfqQueue({ items: [], skippedItems: [recommendation()] });

    expect(item.demandSnapshot).toMatchObject({
      recommendationId: "20:30:90",
      availablePieces: 12,
      onOrderPieces: 0,
      effectiveSupplyPieces: 12,
      reorderPointPieces: 108,
      suggestedOrderPieces: 96,
      generatedForLookbackDays: 90,
    });
  });
});
