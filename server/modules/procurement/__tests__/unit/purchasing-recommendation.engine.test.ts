import { describe, expect, it } from "vitest";
import {
  generatePurchasingRecommendations,
  passesAutoDraftApprovalPolicy,
} from "../../purchasing-recommendation.engine";

describe("purchasing recommendation engine", () => {
  it("produces an explainable actionable recommendation using vendor lead time and per-piece ordering", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 10,
          variant_id: 101,
          base_sku: "SKU-CASE",
          product_name: "Case Product",
          total_pieces: 12,
          total_reserved_pieces: 2,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 50,
          demand_order_count: 12,
          demand_active_days: 10,
          latest_demand_at: "2026-05-18T12:00:00.000Z",
          short_window_days: 7,
          short_outbound_pieces: 21,
          previous_short_outbound_pieces: 7,
          short_demand_order_count: 6,
          short_demand_active_days: 5,
          short_latest_demand_at: "2026-05-18T12:00:00.000Z",
          long_window_days: 90,
          long_outbound_pieces: 135,
          previous_long_outbound_pieces: 150,
          long_demand_order_count: 36,
          long_demand_active_days: 24,
          long_latest_demand_at: "2026-05-18T12:00:00.000Z",
          seasonal_window_days: 30,
          seasonal_outbound_pieces: 30,
          previous_seasonal_outbound_pieces: 45,
          seasonal_demand_order_count: 10,
          seasonal_demand_active_days: 8,
          seasonal_latest_demand_at: "2025-05-18T12:00:00.000Z",
          on_order_pieces: 0,
          open_po_count: 0,
          lead_time_days: 14,
          vendor_lead_time_days: 5,
          safety_stock_days: 2,
          order_uom_units: 10,
          order_uom_level: 3,
          vendor_product_id: 770,
          preferred_vendor_id: 77,
          preferred_vendor_name: "Vendor",
          estimated_cost_mills: 12500,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 12500,
          vendor_pieces_per_purchase_uom: null,
          vendor_quote_reference: "QUOTE-770",
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
          vendor_quote_valid_until: "2026-06-30",
          last_cost_cents: 120,
          vendor_product_updated_at: new Date().toISOString(),
        },
      ],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    expect(result.summary).toMatchObject({
      totalProducts: 1,
      belowReorderPoint: 1,
      actionableCount: 1,
      highConfidenceCount: 1,
      mediumConfidenceCount: 0,
      lowConfidenceCount: 0,
      autoDraftEligibleCount: 1,
      autoDraftReviewRequiredCount: 0,
    });
    expect(result.items[0]).toMatchObject({
      recommendationId: "10:101:30",
      status: "order_now",
      leadTimeDays: 5,
      reorderPoint: 14,
      suggestedOrderQty: 4,
      suggestedOrderPieces: 4,
      orderUomLabel: "pieces",
      preferredVendorId: 77,
      estimatedCostMills: 12500,
      estimatedCostCents: 125,
      confidence: "high",
      confidenceFactors: expect.arrayContaining([
        "Recent demand history is sufficient for velocity-based forecasting.",
        "Demand sample includes 12 orders across 10 active days.",
        "Demand is stable versus the prior lookback window.",
        "Vendor-specific lead time is configured.",
        "Preferred vendor cost uses mills precision.",
        "Preferred vendor cost was verified recently.",
        "Product safety stock is configured.",
      ]),
      supplierBasis: {
        vendorProductId: 770,
        costSource: "vendor_unit_cost_mills",
        costQuality: "current",
        estimatedCostMills: 12500,
        estimatedCostCents: 125,
        lastCostCents: 120,
      },
      supplierCycleDiagnostics: {
        signal: "no_supplier_cycle_data",
        supplyCoverageRatio: 0.71,
        openPoCoverageRatio: null,
      },
      recommendationCandidateScore: {
        score: 91,
        band: "strong_candidate",
        demandScore: 91,
        supplyScore: 85,
        readinessScore: 100,
        signals: expect.arrayContaining([
          "status:order_now",
          "short:accelerating",
          "baseline:above_baseline",
          "seasonal:above_seasonal",
          "quality_gate:high_confidence",
        ]),
        blockers: [],
      },
      qualityControls: [],
      autopilotBlockers: [],
      demandBasis: {
        lookbackDays: 30,
        periodUsagePieces: 60,
        priorPeriodUsagePieces: 50,
        avgDailyUsagePieces: 2,
        demandQuality: "normal",
        demandTrend: "stable",
        demandOrderCount: 12,
        demandActiveDays: 10,
        latestDemandAt: "2026-05-18T12:00:00.000Z",
      },
      leadTimeBasis: {
        leadTimeDays: 5,
        leadTimeSource: "vendor_product",
        safetyStockDays: 2,
        safetyStockSource: "product",
        reorderPointPieces: 14,
      },
      forecastProvenance: {
        forecastMethod: "recent_order_velocity_v1",
        forecastVersion: 1,
        demandSource: "recent_order_velocity",
        demandWindowDays: 30,
        demandQuality: "normal",
        demandTrend: "stable",
        priorPeriodUsagePieces: 50,
        demandOrderCount: 12,
        demandActiveDays: 10,
        latestDemandAt: "2026-05-18T12:00:00.000Z",
        leadTimeSource: "vendor_product",
        safetyStockSource: "product",
        orderUomSource: "base_piece",
          demandWindowDiagnostics: {
            shortWindow: {
              label: "short",
            lookbackDays: 7,
            periodUsagePieces: 21,
            priorPeriodUsagePieces: 7,
            avgDailyUsagePieces: 3,
            demandQuality: "thin_history",
            demandTrend: "rising",
              demandOrderCount: 6,
              demandActiveDays: 5,
            },
            longWindow: {
              label: "long",
              lookbackDays: 90,
              periodUsagePieces: 135,
              priorPeriodUsagePieces: 150,
              avgDailyUsagePieces: 1.5,
              demandQuality: "normal",
              demandTrend: "stable",
              demandOrderCount: 36,
              demandActiveDays: 24,
            },
            seasonalWindow: {
              label: "seasonal",
              lookbackDays: 30,
              periodUsagePieces: 30,
              priorPeriodUsagePieces: 45,
              avgDailyUsagePieces: 1,
              demandQuality: "normal",
              demandTrend: "stable",
              demandOrderCount: 10,
              demandActiveDays: 8,
            },
            accelerationRatio: 1.5,
            accelerationSignal: "accelerating",
            baselineRatio: 1.33,
            baselineSignal: "above_baseline",
            seasonalRatio: 2,
            seasonalSignal: "above_seasonal",
          },
        },
      reviewSignal: {
        action: "create_po",
        severity: "critical",
        label: "Create PO",
      },
      qualityGate: {
        autoDraftEligible: true,
        reason: "high_confidence",
        label: "Auto-draft eligible",
      },
      actionable: true,
      skippedReason: null,
    });
    expect(result.items[0].explanation).toContain("Recommend 4 pieces");
  });

  it.each([
    {
      label: "expired",
      quotedAt: "2026-07-01T12:00:00.000Z",
      quoteValidUntil: "2026-07-10",
      quality: "expired",
      code: "expired_supplier_quote",
    },
    {
      label: "older than the automation limit despite a recent catalog metadata update",
      quotedAt: "2025-07-10T17:59:59.000Z",
      quoteValidUntil: null,
      quality: "stale",
      code: "stale_supplier_cost",
    },
    {
      label: "more than the allowed clock skew in the future",
      quotedAt: "2026-07-11T18:06:00.000Z",
      quoteValidUntil: null,
      quality: "future",
      code: "future_supplier_quote",
    },
  ])("blocks a $label supplier quote from auto-draft", ({ quotedAt, quoteValidUntil, quality, code }) => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-07-11T18:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 11,
        variant_id: 111,
        base_sku: "QUOTE-GUARD",
        product_name: "Quote Guard Product",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-07-10T12:00:00.000Z",
        on_order_pieces: 0,
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        order_uom_level: 3,
        vendor_product_id: 771,
        preferred_vendor_id: 77,
        estimated_cost_mills: 12_500,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 12_500,
        vendor_pieces_per_purchase_uom: null,
        vendor_quote_reference: "QUOTE-GUARD-1",
        vendor_quoted_at: quotedAt,
        vendor_quoted_at_date: quotedAt.slice(0, 10),
        vendor_quote_valid_until: quoteValidUntil,
        vendor_product_updated_at: "2026-07-11T17:59:00.000Z",
        recommendation_analysis_as_of: "2026-07-11T18:00:00.000Z",
        recommendation_analysis_date: "2026-07-11",
      }],
    });

    expect(result.items[0]).toMatchObject({
      confidence: "medium",
      supplierBasis: {
        costQuality: quality,
        quoteReference: "QUOTE-GUARD-1",
        quotedAt,
        quoteValidUntil,
      },
      qualityGate: { autoDraftEligible: false, reason: "quality_control_block" },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({ area: "supplier_cost", severity: "block", code }),
      ]),
    });
  });

  it("blocks otherwise high-confidence recommendations without receivable supplier bindings", () => {
    const baseRow = {
      base_sku: "SKU-BLOCKED",
      product_name: "Blocked Product",
      total_pieces: 12,
      total_reserved_pieces: 2,
      total_outbound_pieces: 60,
      previous_outbound_pieces: 50,
      demand_order_count: 12,
      demand_active_days: 10,
      latest_demand_at: "2026-05-18T12:00:00.000Z",
      on_order_pieces: 0,
      open_po_count: 0,
      vendor_lead_time_days: 5,
      safety_stock_days: 2,
      order_uom_units: 10,
      order_uom_level: 3,
      preferred_vendor_id: 77,
      estimated_cost_mills: 12500,
      vendor_pricing_basis: "per_piece",
      vendor_purchase_uom: null,
      vendor_quoted_unit_cost_mills: 12500,
      vendor_pieces_per_purchase_uom: null,
      vendor_quoted_at: "2026-05-18T12:00:00.000Z",
      vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
    };
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          ...baseRow,
          product_id: 13,
          vendor_product_id: 771,
        },
        {
          ...baseRow,
          product_id: 14,
          variant_id: 114,
          vendor_product_id: null,
        },
      ],
    });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({
      confidence: "high",
      actionable: true,
      qualityGate: {
        autoDraftEligible: false,
        reason: "quality_control_block",
        detail: expect.stringContaining("Missing receive configuration"),
      },
      qualityControls: expect.arrayContaining([
        expect.objectContaining({
          area: "receive_configuration",
          severity: "block",
          code: "missing_receive_configuration",
        }),
      ]),
    });
    expect(result.items[1]).toMatchObject({
      confidence: "high",
      actionable: true,
      qualityGate: {
        autoDraftEligible: false,
        reason: "quality_control_block",
        detail: expect.stringContaining("Missing supplier catalog binding"),
      },
      qualityControls: expect.arrayContaining([
        expect.objectContaining({
          area: "supplier_catalog",
          severity: "block",
          code: "missing_supplier_catalog_binding",
        }),
      ]),
    });
    expect(result.items.map((item) => passesAutoDraftApprovalPolicy(item))).toEqual([false, false]);
    expect(result.summary).toMatchObject({
      actionableCount: 2,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 2,
    });
  });

  it("uses configurable candidate score thresholds for read-only banding", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      autoDraftSettings: {
        candidateScoreStrongThreshold: 95,
        candidateScoreReviewThreshold: 90,
      },
      rows: [
        {
          product_id: 11,
          variant_id: 111,
          base_sku: "SKU-THRESHOLD",
          product_name: "Threshold Product",
          total_pieces: 12,
          total_reserved_pieces: 2,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 50,
          demand_order_count: 12,
          demand_active_days: 10,
          latest_demand_at: "2026-05-18T12:00:00.000Z",
          short_window_days: 7,
          short_outbound_pieces: 21,
          previous_short_outbound_pieces: 7,
          long_window_days: 90,
          long_outbound_pieces: 135,
          previous_long_outbound_pieces: 150,
          seasonal_window_days: 30,
          seasonal_outbound_pieces: 30,
          previous_seasonal_outbound_pieces: 45,
          on_order_pieces: 0,
          vendor_lead_time_days: 5,
          safety_stock_days: 2,
          order_uom_units: 10,
          order_uom_level: 3,
          vendor_product_id: 770,
          preferred_vendor_id: 77,
          estimated_cost_mills: 12500,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 12500,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
          vendor_product_updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(result.items[0].recommendationCandidateScore).toMatchObject({
      score: 91,
      band: "review_candidate",
    });
    expect(result.items[0].qualityGate).toMatchObject({
      autoDraftEligible: true,
      reason: "high_confidence",
    });
  });

  it("can require a strong candidate band in the guarded auto-draft approval policy", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      autoDraftSettings: {
        candidateScoreStrongThreshold: 95,
        candidateScoreReviewThreshold: 90,
      },
      rows: [
        {
          product_id: 12,
          variant_id: 112,
          base_sku: "SKU-STRICT-POLICY",
          product_name: "Strict Policy Product",
          total_pieces: 12,
          total_reserved_pieces: 2,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 50,
          demand_order_count: 12,
          demand_active_days: 10,
          latest_demand_at: "2026-05-18T12:00:00.000Z",
          short_window_days: 7,
          short_outbound_pieces: 21,
          previous_short_outbound_pieces: 7,
          long_window_days: 90,
          long_outbound_pieces: 135,
          previous_long_outbound_pieces: 150,
          seasonal_window_days: 30,
          seasonal_outbound_pieces: 30,
          previous_seasonal_outbound_pieces: 45,
          on_order_pieces: 0,
          vendor_lead_time_days: 5,
          safety_stock_days: 2,
          order_uom_units: 10,
          order_uom_level: 3,
          vendor_product_id: 770,
          preferred_vendor_id: 77,
          estimated_cost_mills: 12500,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 12500,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
          vendor_product_updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(result.items[0].qualityGate.autoDraftEligible).toBe(true);
    expect(result.items[0].recommendationCandidateScore.band).toBe("review_candidate");
    expect(passesAutoDraftApprovalPolicy(result.items[0], { approvalPolicy: "high_confidence_only" })).toBe(true);
    expect(passesAutoDraftApprovalPolicy(result.items[0], {
      approvalPolicy: "high_confidence_and_strong_candidate",
    })).toBe(false);
  });

  it("keeps excluded products out of visible recommendations and reports the skip", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 20,
          base_sku: "DROP-1",
          product_name: "Dropship Item",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          order_uom_units: 1,
        },
      ],
      productMetaById: new Map([[20, { sku: "DROP-1", category: "dropship" }]]),
      exclusionRules: [{ field: "category", value: "dropship" }],
    });

    expect(result.items).toEqual([]);
    expect(result.summary.excludedCount).toBe(1);
    expect(result.skippedItems[0]).toMatchObject({
      productId: 20,
      skippedReason: "excluded",
      reviewSignal: {
        action: "review_exclusion",
        severity: "info",
      },
      qualityGate: {
        autoDraftEligible: false,
        reason: "not_actionable",
      },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({
          area: "vendor",
          severity: "block",
          code: "missing_vendor",
        }),
      ]),
      actionable: false,
    });
  });

  it("marks auto-draft recommendations blocked when preferred vendor is required", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 10,
      rows: [
        {
          product_id: 30,
          base_sku: "NO-VENDOR",
          product_name: "No Vendor Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 20,
          on_order_pieces: 0,
          lead_time_days: 2,
          safety_stock_days: 1,
          order_uom_units: 5,
          order_uom_level: 2,
        },
      ],
      autoDraftSettings: { skipNoVendor: true },
      requireVendor: true,
    });

    expect(result.items[0]).toMatchObject({
      status: "stockout",
      suggestedOrderQty: 6,
      actionable: false,
      skippedReason: "no_vendor",
      reviewSignal: {
        action: "assign_vendor",
        severity: "critical",
        label: "Assign preferred vendor",
      },
      qualityGate: {
        autoDraftEligible: false,
        reason: "not_actionable",
      },
    });
    expect(result.summary).toMatchObject({
      skippedNoVendor: 1,
      actionableCount: 0,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 0,
    });
  });

  it("explains recommendations skipped because open PO supply covers demand", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 10,
      rows: [
        {
          product_id: 40,
          base_sku: "ON-ORDER",
          product_name: "On Order Product",
          total_pieces: 1,
          total_reserved_pieces: 0,
          total_outbound_pieces: 20,
          on_order_pieces: 20,
          open_po_count: 2,
          lead_time_days: 2,
          safety_stock_days: 1,
          order_uom_units: 5,
          order_uom_level: 2,
          preferred_vendor_id: 7,
        },
      ],
      autoDraftSettings: { skipOnOpenPo: true },
    });

    expect(result.items[0]).toMatchObject({
      status: "on_order",
      actionable: false,
      skippedReason: "already_on_order",
      supplierCycleDiagnostics: {
        signal: "open_supply_covers_cycle",
        supplyCoverageRatio: 3.5,
        openPoCoverageRatio: 3.33,
      },
      recommendationCandidateScore: {
        score: 29,
        band: "watch",
        demandScore: 35,
        supplyScore: 20,
        readinessScore: 35,
        blockers: expect.arrayContaining([
          "thin_history",
          "product_lead_time_fallback",
          "missing_supplier_cost",
          "skipped:already_on_order",
        ]),
      },
      reviewSignal: {
        action: "review_open_po",
        severity: "info",
      },
      qualityGate: {
        autoDraftEligible: false,
        reason: "not_actionable",
      },
    });
    expect(result.summary).toMatchObject({
      skippedOnOrder: 1,
      actionableCount: 0,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 0,
    });
  });

  it("downgrades confidence and records default forecast provenance for thin history", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 50,
          variant_id: 501,
          base_sku: "THIN",
          product_name: "Thin History Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 2,
          on_order_pieces: 0,
          order_uom_units: null,
          vendor_product_id: 5010,
          preferred_vendor_id: 10,
          estimated_cost_mills: 100,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 100,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        },
      ],
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
    });

    expect(result.items[0]).toMatchObject({
      confidence: "medium",
      qualityGate: {
        autoDraftEligible: false,
        reason: "medium_confidence_review",
        label: "Review before auto-draft",
        detail: expect.stringContaining("Thin demand history"),
      },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({
          area: "demand",
          severity: "review",
          code: "thin_history",
        }),
        expect.objectContaining({
          area: "lead_time",
          severity: "review",
          code: "default_lead_time",
        }),
      ]),
      confidenceFactors: expect.arrayContaining([
        "Limited demand history in the lookback window.",
        "Lead time uses the default fallback.",
        "Safety stock uses the default fallback.",
        "Order quantity uses base pieces independently of the warehouse receive configuration.",
      ]),
      demandBasis: {
        demandQuality: "thin_history",
        periodUsagePieces: 2,
      },
      leadTimeBasis: {
        leadTimeSource: "default",
        safetyStockSource: "default",
      },
      forecastProvenance: {
        demandQuality: "thin_history",
        leadTimeSource: "default",
        safetyStockSource: "default",
        orderUomSource: "base_piece",
      },
    });
    expect(result.summary).toMatchObject({
      actionableCount: 1,
      mediumConfidenceCount: 1,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 1,
    });
  });

  it("downgrades confidence when current demand is falling against the prior period", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 60,
          variant_id: 601,
          base_sku: "FALLING",
          product_name: "Falling Demand Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 150,
          demand_order_count: 15,
          demand_active_days: 12,
          on_order_pieces: 0,
          lead_time_days: 3,
          vendor_lead_time_days: 2,
          safety_stock_days: 1,
          order_uom_units: 10,
          vendor_product_id: 6010,
          preferred_vendor_id: 10,
          estimated_cost_mills: 100,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 100,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      confidence: "medium",
      qualityGate: {
        autoDraftEligible: false,
        reason: "medium_confidence_review",
        detail: expect.stringContaining("Falling demand"),
      },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({
          area: "demand",
          severity: "review",
          code: "falling_demand",
        }),
      ]),
      demandBasis: {
        demandQuality: "normal",
        demandTrend: "falling",
        priorPeriodUsagePieces: 150,
      },
      forecastProvenance: {
        demandTrend: "falling",
        priorPeriodUsagePieces: 150,
        demandOrderCount: 15,
        demandActiveDays: 12,
      },
      confidenceFactors: expect.arrayContaining([
        "Demand sample includes 15 orders across 12 active days.",
        "Demand is falling versus the prior lookback window.",
      ]),
    });
    expect(result.summary).toMatchObject({
      actionableCount: 1,
      mediumConfidenceCount: 1,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 1,
    });
  });

  it("flags possible velocity suppression when demand falls during a stockout", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 61,
          variant_id: 611,
          base_sku: "STOCKOUT-SUPPRESSED",
          product_name: "Stockout Suppressed Demand",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 18,
          previous_outbound_pieces: 60,
          demand_order_count: 8,
          demand_active_days: 6,
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          preferred_vendor_id: 10,
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      status: "stockout",
      demandBasis: {
        demandTrend: "falling",
        demandSuppressionRisk: {
          signal: "stockout_velocity_suppression",
          severity: "review",
          constrainedAvailablePieces: 0,
        },
      },
      forecastProvenance: {
        demandTrend: "falling",
        demandSuppressionRisk: {
          signal: "stockout_velocity_suppression",
          severity: "review",
          constrainedAvailablePieces: 0,
        },
      },
    });
    expect(result.items[0].qualityControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "falling_demand",
        }),
      ]),
    );
  });

  it("exposes read-only forecast trust diagnostics for stale and incomplete forecast inputs", () => {
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      asOf: "2026-05-24T00:00:00.000Z",
      rows: [
        {
          product_id: 62,
          variant_id: 621,
          base_sku: "STALE-FORECAST",
          product_name: "Stale Forecast Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          previous_outbound_pieces: 30,
          demand_order_count: 8,
          demand_active_days: 6,
          latest_demand_at: "2026-04-01T00:00:00.000Z",
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          preferred_vendor_id: 10,
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      demandBasis: {
        demandQuality: "normal",
        forecastTrust: {
          signal: "stale_recent_demand",
          severity: "review",
          latestDemandAgeDays: 53,
          staleDemandThresholdDays: 30,
          hasPriorBaseline: true,
          hasShortWindow: false,
          hasLongWindow: false,
          hasSeasonalWindow: false,
          inputGaps: expect.arrayContaining([
            "missing_short_window",
            "missing_long_window",
            "missing_seasonal_window",
          ]),
        },
      },
      forecastProvenance: {
        forecastTrust: {
          signal: "stale_recent_demand",
          severity: "review",
          detail: expect.stringContaining("Most recent demand is 53 days old"),
        },
      },
    });
  });

  it("uses latest known demand for trust freshness without hiding no-recent-demand forecasts", () => {
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      asOf: "2026-05-24T00:00:00.000Z",
      rows: [
        {
          product_id: 64,
          variant_id: 641,
          base_sku: "NO-RECENT-KNOWN-DEMAND",
          product_name: "No Recent Known Demand Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 0,
          previous_outbound_pieces: 12,
          demand_order_count: 0,
          demand_active_days: 0,
          latest_demand_at: null,
          latest_known_demand_at: "2026-04-15T00:00:00.000Z",
          short_window_days: 7,
          short_outbound_pieces: 0,
          previous_short_outbound_pieces: 0,
          short_demand_order_count: 0,
          short_demand_active_days: 0,
          long_window_days: 90,
          long_outbound_pieces: 12,
          previous_long_outbound_pieces: 24,
          long_demand_order_count: 2,
          long_demand_active_days: 2,
          seasonal_window_days: 30,
          seasonal_outbound_pieces: 4,
          previous_seasonal_outbound_pieces: 4,
          seasonal_demand_order_count: 1,
          seasonal_demand_active_days: 1,
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          vendor_product_id: 6410,
          preferred_vendor_id: 10,
          estimated_cost_cents: 250,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 25000,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
          vendor_product_updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      skippedReason: "zero_suggested_quantity",
      demandBasis: {
        demandQuality: "no_recent_demand",
        latestDemandAt: null,
        forecastTrust: {
          signal: "no_recent_demand",
          severity: "review",
          latestDemandAgeDays: 39,
          inputGaps: [],
        },
      },
      forecastProvenance: {
        forecastTrust: {
          signal: "no_recent_demand",
          latestDemandAgeDays: 39,
        },
      },
    });
    expect(result.items[0].demandBasis.forecastTrust.inputGaps).not.toContain("missing_latest_demand_at");
  });

  it("holds otherwise high-confidence recommendations when forecast trust has review severity", () => {
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      asOf: "2026-05-24T00:00:00.000Z",
      rows: [
        {
          product_id: 63,
          variant_id: 631,
          base_sku: "STALE-HIGH-CONF",
          product_name: "Stale High Confidence Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 60,
          demand_order_count: 12,
          demand_active_days: 10,
          latest_demand_at: "2026-04-01T00:00:00.000Z",
          short_window_days: 7,
          short_outbound_pieces: 14,
          previous_short_outbound_pieces: 14,
          short_demand_order_count: 5,
          short_demand_active_days: 4,
          long_window_days: 90,
          long_outbound_pieces: 180,
          previous_long_outbound_pieces: 180,
          long_demand_order_count: 24,
          long_demand_active_days: 20,
          seasonal_window_days: 30,
          seasonal_outbound_pieces: 60,
          previous_seasonal_outbound_pieces: 60,
          seasonal_demand_order_count: 12,
          seasonal_demand_active_days: 10,
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          vendor_product_id: 6310,
          preferred_vendor_id: 10,
          estimated_cost_cents: 250,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 25000,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
          vendor_product_updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      confidence: "high",
      qualityGate: {
        autoDraftEligible: false,
        reason: "forecast_trust_review",
        label: "Forecast trust review",
        detail: expect.stringContaining("stale recent demand"),
      },
      forecastProvenance: {
        forecastTrust: {
          signal: "stale_recent_demand",
          severity: "review",
        },
      },
      recommendationCandidateScore: {
        signals: expect.arrayContaining(["quality_gate:forecast_trust_review"]),
      },
    });
    expect(result.summary).toMatchObject({
      highConfidenceCount: 1,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 1,
    });
    expect(passesAutoDraftApprovalPolicy(result.items[0], { approvalPolicy: "high_confidence_only" })).toBe(false);
  });

  it("keeps zero-revenue demand in usage while requiring review before auto-draft", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 65,
          variant_id: 650,
          base_sku: "PROMO-DEMAND",
          product_name: "Promo Demand Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 58,
          paid_demand_pieces: 20,
          zero_revenue_demand_pieces: 40,
          coupon_discount_demand_pieces: 45,
          demand_order_count: 15,
          demand_active_days: 12,
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          order_uom_level: 3,
          vendor_product_id: 6500,
          preferred_vendor_id: 10,
          estimated_cost_cents: 250,
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 25000,
          vendor_pieces_per_purchase_uom: null,
          vendor_quoted_at: "2026-05-18T12:00:00.000Z",
          vendor_product_updated_at: new Date().toISOString(),
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      status: "stockout",
      suggestedOrderPieces: 8,
      confidence: "medium",
      qualityGate: {
        autoDraftEligible: false,
        reason: "medium_confidence_review",
      },
      demandBasis: {
        periodUsagePieces: 60,
        paidDemandPieces: 20,
        zeroRevenueDemandPieces: 40,
        couponDiscountDemandPieces: 45,
        zeroRevenueDemandShare: 0.67,
        couponDiscountDemandShare: 0.75,
        demandMixSignal: "mostly_zero_revenue",
      },
      forecastProvenance: {
        periodUsagePieces: 60,
        paidDemandPieces: 20,
        zeroRevenueDemandPieces: 40,
        couponDiscountDemandPieces: 45,
        demandMixSignal: "mostly_zero_revenue",
      },
      qualityControls: expect.arrayContaining([
        expect.objectContaining({
          area: "demand",
          severity: "review",
          code: "zero_revenue_demand_mix",
        }),
      ]),
      recommendationCandidateScore: {
        signals: expect.arrayContaining(["demand_mix:mostly_zero_revenue"]),
        blockers: expect.arrayContaining(["zero_revenue_demand_mix"]),
      },
      confidenceFactors: expect.arrayContaining([
        "Demand mix: 20 paid pieces, 40 zero-revenue pieces, and 45 coupon-discounted pieces.",
      ]),
    });
    expect(result.summary).toMatchObject({
      actionableCount: 1,
      mediumConfidenceCount: 1,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 1,
    });
  });

  it("downgrades confidence and exposes stale last-purchase supplier cost fallback", () => {
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): fixtures pin latest_demand_at to
      // 2026-05-18 — without asOf these tests rot as wall-time passes
      // (demand goes "stale" after the 30-day lookback and the trust
      // signal degrades the candidate score).
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          product_id: 70,
          variant_id: 701,
          base_sku: "STALE-COST",
          product_name: "Stale Supplier Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 60,
          previous_outbound_pieces: 55,
          demand_order_count: 12,
          demand_active_days: 10,
          on_order_pieces: 0,
          vendor_lead_time_days: 4,
          safety_stock_days: 2,
          order_uom_units: 10,
          vendor_product_id: 7010,
          preferred_vendor_id: 10,
          last_cost_cents: 225,
          vendor_product_last_purchased_at: "2024-01-01T00:00:00.000Z",
          vendor_product_updated_at: "2024-01-01T00:00:00.000Z",
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      confidence: "medium",
      estimatedCostMills: 22500,
      estimatedCostCents: 225,
      qualityGate: {
        autoDraftEligible: false,
        reason: "quality_control_block",
      },
      supplierBasis: {
        vendorProductId: 7010,
        costSource: "last_purchase_cost",
        costQuality: "stale",
        estimatedCostMills: 22500,
        estimatedCostCents: 225,
        lastCostCents: 225,
      },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({
          area: "supplier_cost",
          severity: "review",
          code: "last_purchase_cost",
        }),
        expect.objectContaining({
          area: "supplier_cost",
          severity: "review",
          code: "stale_supplier_cost",
        }),
        expect.objectContaining({
          area: "supplier_catalog",
          severity: "block",
          code: "supplier_quote_basis_unconfirmed",
        }),
      ]),
      confidenceFactors: expect.arrayContaining([
        "Preferred vendor cost uses last purchase fallback.",
        "Preferred vendor cost was last verified over 365 days ago.",
      ]),
    });
    expect(result.summary).toMatchObject({
      actionableCount: 1,
      mediumConfidenceCount: 1,
      autoDraftEligibleCount: 0,
      autoDraftReviewRequiredCount: 1,
    });
  });

  it("requires legacy quote-basis review and ignores receive-pack units when applying a supplier quote UOM", () => {
    const baseRow = {
      variant_id: 801,
      total_pieces: 0,
      total_reserved_pieces: 0,
      total_outbound_pieces: 60,
      previous_outbound_pieces: 60,
      demand_order_count: 12,
      demand_active_days: 10,
      latest_demand_at: "2026-05-18T12:00:00.000Z",
      on_order_pieces: 0,
      vendor_lead_time_days: 2,
      safety_stock_days: 1,
      order_uom_units: 10,
      vendor_product_id: 8_010,
      preferred_vendor_id: 80,
      estimated_cost_mills: 50,
      vendor_quoted_at: "2026-05-18T12:00:00.000Z",
      vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
    };
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          ...baseRow,
          product_id: 80,
          base_sku: "LEGACY-QUOTE",
          vendor_pricing_basis: "legacy_unknown",
        },
        {
          ...baseRow,
          product_id: 81,
          variant_id: 811,
          vendor_product_id: 8_110,
          base_sku: "UOM-MISMATCH",
          vendor_pricing_basis: "per_purchase_uom",
          vendor_purchase_uom: "pack",
          vendor_quoted_unit_cost_mills: 300,
          vendor_pieces_per_purchase_uom: 6,
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      supplierBasis: { pricingBasis: "legacy_unknown" },
      qualityGate: { autoDraftEligible: false, reason: "quality_control_block" },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({ code: "supplier_quote_basis_unconfirmed", severity: "block" }),
      ]),
    });
    expect(result.items[1]).toMatchObject({
      suggestedOrderQty: 1,
      suggestedOrderPieces: 6,
      orderUomUnits: 6,
      orderUomLabel: "pack",
      supplierBasis: {
        pricingBasis: "per_purchase_uom",
        purchaseUom: "pack",
        quotedUnitCostMills: 300,
        piecesPerPurchaseUom: 6,
      },
    });
    expect(result.items[1].autopilotBlockers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "supplier_quote_uom_quantity_mismatch" }),
    ]));
  });

  it("treats a current zero-dollar supplier quote as a present nonnegative cost", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 84,
        variant_id: 841,
        base_sku: "NO-CHARGE",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-05-18T12:00:00.000Z",
        on_order_pieces: 0,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        vendor_product_id: 8_410,
        preferred_vendor_id: 84,
        estimated_cost_mills: 0,
        estimated_cost_cents: 0,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 0,
        vendor_pieces_per_purchase_uom: null,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
      }],
    });

    expect(result.items[0]).toMatchObject({
      estimatedCostMills: 0,
      estimatedCostCents: 0,
      orderUomUnits: 1,
      supplierBasis: {
        costSource: "vendor_unit_cost_mills",
        costQuality: "current",
        estimatedCostMills: 0,
        estimatedCostCents: 0,
        quotedUnitCostMills: 0,
      },
      qualityGate: { autoDraftEligible: true },
    });
  });

  it("rounds a real reorder need up to the vendor MOQ using only the supplier quote increment", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 82,
        variant_id: 821,
        base_sku: "MOQ-UOM",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-05-18T12:00:00.000Z",
        on_order_pieces: 0,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        vendor_product_id: 8_210,
        preferred_vendor_id: 82,
        estimated_cost_mills: 50,
        vendor_pricing_basis: "per_purchase_uom",
        vendor_purchase_uom: "pack",
        vendor_quoted_unit_cost_mills: 300,
        vendor_pieces_per_purchase_uom: 6,
        vendor_moq: 31,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
      }],
    });

    // MOQ is 31 pieces and quote packs are 6. The warehouse receive pack of
    // 10 does not constrain purchasing, so the next valid quantity is 36.
    expect(result.items[0]).toMatchObject({
      suggestedOrderQty: 6,
      suggestedOrderPieces: 36,
      orderUomUnits: 6,
      orderUomLabel: "pack",
      forecastProvenance: { orderUomSource: "supplier_quote" },
      supplierBasis: {
        minimumOrderPieces: 31,
        piecesPerPurchaseUom: 6,
      },
      qualityGate: { autoDraftEligible: true },
    });
  });

  it("blocks automation when a stored vendor MOQ is not a positive base-piece integer", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 83,
        variant_id: 831,
        base_sku: "BAD-MOQ",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-05-18T12:00:00.000Z",
        on_order_pieces: 0,
        vendor_lead_time_days: 2,
        safety_stock_days: 1,
        order_uom_units: 10,
        vendor_product_id: 8_310,
        preferred_vendor_id: 83,
        estimated_cost_mills: 50,
        vendor_pricing_basis: "per_piece",
        vendor_purchase_uom: null,
        vendor_quoted_unit_cost_mills: 50,
        vendor_pieces_per_purchase_uom: null,
        vendor_moq: 0,
        vendor_quoted_at: "2026-05-18T12:00:00.000Z",
      }],
    });

    expect(result.items[0]).toMatchObject({
      supplierBasis: { minimumOrderPieces: null },
      qualityGate: { autoDraftEligible: false, reason: "quality_control_block" },
      autopilotBlockers: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_supplier_minimum_order", severity: "block" }),
      ]),
    });
  });
});
