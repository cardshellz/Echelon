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
        autoDraftEligibleCount: 0,
        autoDraftReviewRequiredCount: 1,
        skippedNoVendor: 1,
      },
      statusCounts: {
        stockout: 2,
      },
      skippedReasonCounts: {
        no_vendor: 1,
      },
      forecastDiagnostics: {
        recommendationCount: 2,
        forecastMethodCounts: {
          recent_order_velocity_v1: 2,
        },
        demandQualityCounts: {
          normal: 2,
        },
        demandTrendCounts: {
          not_available: 2,
        },
        shortWindowDemandQualityCounts: {
          normal: 2,
        },
        shortWindowDemandTrendCounts: {
          not_available: 2,
        },
        longWindowDemandQualityCounts: {
          normal: 2,
        },
        longWindowDemandTrendCounts: {
          not_available: 2,
        },
        seasonalWindowDemandQualityCounts: {},
        seasonalWindowDemandTrendCounts: {},
        demandAccelerationSignalCounts: {
          steady: 2,
        },
        demandBaselineSignalCounts: {
          near_baseline: 2,
        },
        demandSeasonalitySignalCounts: {
          not_available: 2,
        },
        supplierCycleSignalCounts: {
          no_supplier_cycle_data: 2,
        },
        supplierCycleOpenPoPastDueCount: 0,
        avgSupplierCycleSupplyCoverageRatio: 0,
        qualityControlCounts: {
          product_lead_time_fallback: 2,
          missing_supplier_cost: 1,
          missing_vendor: 1,
        },
        qualityControlAreaCounts: {
          lead_time: 2,
          supplier_cost: 1,
          vendor: 1,
        },
        qualityControlSeverityCounts: {
          review: 3,
          block: 1,
        },
        autopilotBlockerCounts: {
          product_lead_time_fallback: 2,
          missing_supplier_cost: 1,
          missing_vendor: 1,
        },
        autopilotBlockerAreaCounts: {
          lead_time: 2,
          supplier_cost: 1,
          vendor: 1,
        },
        autopilotBlockerSeverityCounts: {
          review: 3,
          block: 1,
        },
        autopilotBlockerItemCount: 2,
        totalPeriodUsagePieces: 60,
        avgDailyUsagePieces: 1,
        latestDemandAt: null,
      },
      poMutations: [{ vendorId: 7, poId: 99, action: "created", linesAdded: 1 }],
    });
    expect(detail.actionableRecommendations[0]).toMatchObject({
      sku: "ORDER-ME",
      suggestedOrderQty: 1,
      preferredVendorName: "Vendor",
      confidenceFactors: expect.arrayContaining([
        "Recent demand history is sufficient for velocity-based forecasting.",
      ]),
      forecastProvenance: {
        demandSource: "recent_order_velocity",
        demandWindowDays: 30,
        demandQuality: "normal",
        periodUsagePieces: 30,
        avgDailyUsagePieces: 1,
        leadTimeSource: "product",
        safetyStockSource: "product",
        orderUomSource: "variant",
      },
      reviewSignal: {
        action: "create_po",
        severity: "critical",
      },
      qualityGate: {
        autoDraftEligible: false,
        reason: "medium_confidence_review",
      },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({
          area: "lead_time",
          severity: "review",
          code: "product_lead_time_fallback",
        }),
        expect.objectContaining({
          area: "supplier_cost",
          severity: "review",
          code: "missing_supplier_cost",
        }),
      ]),
    });
    expect(detail.skippedRecommendations[0]).toMatchObject({
      sku: "NO-VENDOR",
      skippedReason: "no_vendor",
      reviewSignal: {
        action: "assign_vendor",
        severity: "critical",
      },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({
          area: "vendor",
          severity: "block",
          code: "missing_vendor",
        }),
      ]),
    });
  });
});
