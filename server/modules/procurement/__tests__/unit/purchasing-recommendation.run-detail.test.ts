import { describe, expect, it } from "vitest";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";
import { buildPurchasingRecommendationRunDetail } from "../../purchasing-recommendation.run-detail";

describe("purchasing recommendation run detail", () => {
  it("builds a compact audit payload with actionable and skipped recommendation samples", () => {
    const recommendations = generatePurchasingRecommendations({
      lookbackDays: 30,
      rows: [
        {
          product_id: 1,
          variant_id: 11,
          base_sku: "ORDER-ME",
          product_name: "Order Me",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 5,
          order_uom_level: 2,
          preferred_vendor_id: 7,
          preferred_vendor_name: "Vendor",
        },
        {
          product_id: 2,
          variant_id: 22,
          base_sku: "NO-VENDOR",
          product_name: "No Vendor",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 5,
          order_uom_level: 2,
        },
      ],
      autoDraftSettings: { skipNoVendor: true },
      requireVendor: true,
    });

    const detail = buildPurchasingRecommendationRunDetail(recommendations, {
      lookbackDays: 30,
      settings: { skipNoVendor: true },
      generatedAt: new Date("2026-05-18T12:00:00.000Z"),
      poMutations: [{ vendorId: 7, poId: 99, action: "created", linesAdded: 1 }],
    });

    expect(detail).toMatchObject({
      version: 1,
      generatedAt: "2026-05-18T12:00:00.000Z",
      lookbackDays: 30,
      recommendationSummary: {
        actionableCount: 1,
        skippedNoVendor: 1,
      },
      statusCounts: {
        stockout: 2,
      },
      skippedReasonCounts: {
        no_vendor: 1,
      },
      poMutations: [{ vendorId: 7, poId: 99, action: "created", linesAdded: 1 }],
    });
    expect(detail.actionableRecommendations[0]).toMatchObject({
      sku: "ORDER-ME",
      suggestedOrderQty: 1,
      preferredVendorName: "Vendor",
    });
    expect(detail.skippedRecommendations[0]).toMatchObject({
      sku: "NO-VENDOR",
      skippedReason: "no_vendor",
    });
  });
});
