import { describe, expect, it } from "vitest";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";
import { buildPurchasingRecommendationRunDetail } from "../../purchasing-recommendation.run-detail";

describe("purchasing recommendation run detail", () => {
  it("builds a compact audit payload with actionable and skipped recommendation samples", () => {
    const recommendations = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
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
          vendor_product_id: 701,
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
      approvalPolicyDiagnostics: {
        policy: "high_confidence_only",
        mode: "draft_po",
        candidateScoreGateActive: false,
        qualityGateEligibleCount: 0,
        approvalPolicyEligibleCount: 0,
        approvalPolicyBlockedCount: 0,
        draftMutationEligibleCount: 0,
        approvedCandidateBandCounts: {},
        blockedCandidateBandCounts: {},
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
        demandMixSignalCounts: {
          not_available: 2,
        },
        demandSuppressionSignalCounts: {
          none: 2,
        },
        demandSuppressionReviewCount: 0,
        forecastTrustSignalCounts: {
          missing_latest_demand_timestamp: 2,
        },
        forecastTrustSeverityCounts: {
          watch: 2,
        },
        forecastTrustWatchCount: 2,
        forecastTrustReviewCount: 0,
        forecastInputGapCounts: {
          missing_latest_demand_at: 2,
          missing_demand_order_count: 2,
          missing_demand_active_days: 2,
          missing_prior_period: 2,
          missing_short_window: 2,
          missing_long_window: 2,
          missing_seasonal_window: 2,
        },
        supplierCycleSignalCounts: {
          no_supplier_cycle_data: 2,
        },
        supplierCycleOpenPoPastDueCount: 0,
        avgSupplierCycleSupplyCoverageRatio: 0,
        recommendationCandidateBandCounts: {
          review_candidate: 1,
          blocked: 1,
        },
        avgRecommendationCandidateScore: 65.5,
        strongRecommendationCandidateCount: 0,
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
        totalPaidDemandPieces: 0,
        totalZeroRevenueDemandPieces: 0,
        totalCouponDiscountDemandPieces: 0,
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
      recommendationCandidateScore: {
        score: 72,
        band: "review_candidate",
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
      recommendationCandidateScore: {
        score: 59,
        band: "blocked",
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

  it("records approval-policy outcomes separately from the high-confidence quality gate", () => {
    const recommendations = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 3,
          variant_id: 33,
          base_sku: "HIGH-CONF-REVIEW-CANDIDATE",
          product_name: "High Confidence Review Candidate",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 90,
          previous_outbound_pieces: 90,
          demand_order_count: 15,
          demand_active_days: 15,
          latest_demand_at: "2026-05-18T12:00:00.000Z",
          lead_time_days: 3,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 5,
          order_uom_level: 2,
          vendor_product_id: 703,
          preferred_vendor_id: 7,
          preferred_vendor_name: "Vendor",
          estimated_cost_cents: 1200,
          vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
        },
      ],
      autoDraftSettings: {
        approvalPolicy: "high_confidence_and_strong_candidate",
        candidateScoreStrongThreshold: 95,
        candidateScoreReviewThreshold: 80,
      },
    });

    const detail = buildPurchasingRecommendationRunDetail(recommendations, {
      lookbackDays: 30,
      settings: {
        approvalPolicy: "high_confidence_and_strong_candidate",
        candidateScoreStrongThreshold: 95,
        candidateScoreReviewThreshold: 80,
      },
      generatedAt: new Date("2026-05-18T12:00:00.000Z"),
    });

    expect(detail.recommendationSummary.autoDraftEligibleCount).toBe(1);
    expect(detail.approvalPolicyDiagnostics).toMatchObject({
      policy: "high_confidence_and_strong_candidate",
      mode: "draft_po",
      candidateScoreGateActive: true,
      qualityGateEligibleCount: 1,
      approvalPolicyEligibleCount: 0,
      approvalPolicyBlockedCount: 1,
      draftMutationEligibleCount: 0,
      approvedCandidateBandCounts: {},
      blockedCandidateBandCounts: {
        review_candidate: 1,
      },
    });
    expect(detail.approvalPolicyBlockedRecommendations).toHaveLength(1);
    expect(detail.approvalPolicyBlockedRecommendations[0]).toMatchObject({
      sku: "HIGH-CONF-REVIEW-CANDIDATE",
      qualityGate: {
        autoDraftEligible: true,
        reason: "high_confidence",
      },
      recommendationCandidateScore: {
        band: "review_candidate",
      },
    });
  });
});
