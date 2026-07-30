import { describe, expect, it } from "vitest";
import {
  generatePurchasingRecommendations,
  passesAutoDraftApprovalPolicy,
} from "../../purchasing-recommendation.engine";
// Type-only import: no runtime dependency on the context service (or the db it loads).
import type { PurchasingRecommendationContext } from "../../purchasing-recommendation-context.service";

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

  it("keeps RFQ demand confidence high when only supplier price evidence is missing", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 11,
        variant_id: 111,
        base_sku: "NEEDS-QUOTE",
        product_name: "Needs Quote",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 60,
        previous_outbound_pieces: 60,
        demand_order_count: 12,
        demand_active_days: 10,
        latest_demand_at: "2026-05-18T12:00:00.000Z",
        on_order_pieces: 0,
        open_po_count: 0,
        lead_time_days: 14,
        vendor_lead_time_days: 5,
        safety_stock_days: 2,
        order_uom_units: 10,
        order_uom_level: 3,
        vendor_product_id: 771,
        preferred_vendor_id: 77,
        preferred_vendor_name: "Vendor",
      }],
    });

    expect(result.items[0]).toMatchObject({
      confidence: "medium",
      rfqConfidence: "high",
      supplierBasis: { costSource: "missing", costQuality: "missing" },
      qualityGate: { autoDraftEligible: false },
    });
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

  it("applies exclusion rules when the loader context shape is spread into the options", () => {
    // Regression for the context/engine key mismatch: the context service used
    // to return `rules` while the engine reads `exclusionRules`, so every call
    // site that spread the loaded context silently dropped rule-based
    // exclusions. This fixture is typed as the loader's return shape so a key
    // drift between the two modules fails compilation here.
    const context: PurchasingRecommendationContext = {
      defaults: { leadTimeDays: 14, safetyStockDays: 7 },
      exclusionRules: [{ field: "category", value: "dropship" }],
      productMetaById: new Map([[20, { sku: "DROP-1", category: "dropship" }]]),
    };
    const result = generatePurchasingRecommendations({
      // Frozen clock (CLAUDE.md §3): deterministic relative to fixture demand.
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
      ...context,
    });

    expect(result.items).toEqual([]);
    expect(result.summary.excludedCount).toBe(1);
    expect(result.skippedItems[0]).toMatchObject({
      productId: 20,
      skippedReason: "excluded",
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
      // Queue truth (PR feat/reorder-queue-truth): this zero-stock row has no
      // blended velocity and no forward demand, so it now classifies as
      // no_movement instead of stockout — the skip ladder therefore resolves
      // not_actionable_status before it ever reaches the zero-quantity check.
      skippedReason: "not_actionable_status",
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

  // Case rounding is a rule, not a hint (REORDER-ANALYSIS-DESIGN-SPEC §12
  // rev 3): whenever a case pack is known — quoted pieces-per-purchase-UOM
  // first, vendor_products.pack_size as fallback — the suggestion rounds UP
  // to a full case regardless of pricing basis. Previously only
  // per_purchase_uom quotes rounded; per-piece quotes fell back to single
  // pieces even when the vendor shipped in cases.
  it("rounds every suggestion up to a full case whenever a case pack is known", () => {
    const baseRow = {
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
      estimated_cost_mills: 50,
      vendor_quoted_at: "2026-05-18T12:00:00.000Z",
      vendor_product_updated_at: "2026-05-18T12:00:00.000Z",
    };
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [
        {
          // NEW behavior: per-piece pricing with a known vendor case pack
          // rounds up to the full case instead of ordering loose pieces.
          ...baseRow,
          product_id: 90,
          variant_id: 901,
          vendor_product_id: 9_010,
          preferred_vendor_id: 90,
          base_sku: "PER-PIECE-CASE",
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 50,
          vendor_pieces_per_purchase_uom: null,
          vendor_pack_size: 24,
        },
        {
          // Unchanged: the quoted purchase-UOM pack stays authoritative and
          // wins over pack_size when both are present.
          ...baseRow,
          product_id: 91,
          variant_id: 911,
          vendor_product_id: 9_110,
          preferred_vendor_id: 91,
          base_sku: "UOM-CASE",
          vendor_pricing_basis: "per_purchase_uom",
          vendor_purchase_uom: "pack",
          vendor_quoted_unit_cost_mills: 300,
          vendor_pieces_per_purchase_uom: 6,
          vendor_pack_size: 24,
        },
        {
          // Unchanged: with no known pack the increment stays one piece.
          ...baseRow,
          product_id: 92,
          variant_id: 921,
          vendor_product_id: 9_210,
          preferred_vendor_id: 92,
          base_sku: "NO-PACK",
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 50,
          vendor_pieces_per_purchase_uom: null,
        },
        {
          // The MOQ floor still applies before rounding: max(raw 6, MOQ 31)
          // then up to the next full 24-piece case.
          ...baseRow,
          product_id: 93,
          variant_id: 931,
          vendor_product_id: 9_310,
          preferred_vendor_id: 93,
          base_sku: "PACK-WITH-MOQ",
          vendor_pricing_basis: "per_piece",
          vendor_purchase_uom: null,
          vendor_quoted_unit_cost_mills: 50,
          vendor_pieces_per_purchase_uom: null,
          vendor_pack_size: 24,
          vendor_moq: 31,
        },
      ],
    });

    const bySku = new Map(result.items.map((item) => [item.sku, item]));
    expect(bySku.get("PER-PIECE-CASE")).toMatchObject({
      suggestedOrderPieces: 24,
      suggestedOrderQty: 24,
      orderUomUnits: 1,
      orderUomLabel: "pieces",
      forecastProvenance: expect.objectContaining({ orderUomSource: "base_piece" }),
      supplierBasis: expect.objectContaining({ packSize: 24, piecesPerPurchaseUom: null }),
    });
    expect(bySku.get("UOM-CASE")).toMatchObject({
      suggestedOrderPieces: 6,
      suggestedOrderQty: 1,
      orderUomUnits: 6,
      orderUomLabel: "pack",
      supplierBasis: expect.objectContaining({ packSize: 24, piecesPerPurchaseUom: 6 }),
    });
    expect(bySku.get("NO-PACK")).toMatchObject({
      suggestedOrderPieces: 6,
      suggestedOrderQty: 6,
      orderUomUnits: 1,
      supplierBasis: expect.objectContaining({ packSize: null }),
    });
    expect(bySku.get("PACK-WITH-MOQ")).toMatchObject({
      suggestedOrderPieces: 48,
      suggestedOrderQty: 48,
      orderUomUnits: 1,
      supplierBasis: expect.objectContaining({ packSize: 24, minimumOrderPieces: 31 }),
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

  // Queue truth (PR feat/reorder-queue-truth): zero available only classifies
  // as a stockout when there is demand to miss — observed velocity or
  // committed forward demand. A never-sold, never-stocked SKU is stagnant.
  it("classifies zero stock with zero demand as no_movement, never stockout", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 90,
        variant_id: 901,
        base_sku: "NEVER-SOLD",
        product_name: "Never Sold Never Stocked",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 0,
        previous_outbound_pieces: 0,
        demand_order_count: 0,
        demand_active_days: 0,
        latest_demand_at: null,
        on_order_pieces: 0,
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
      }],
    });

    expect(result.items[0]).toMatchObject({
      status: "no_movement",
      suggestedOrderPieces: 0,
      actionable: false,
      // The skip ladder resolves before the zero-quantity check now that the
      // status is no longer an actionable stockout.
      skippedReason: "not_actionable_status",
    });
    expect(result.summary).toMatchObject({
      outOfStock: 0,
      noMovement: 1,
      actionableCount: 0,
    });
  });

  it("keeps zero stock with real sales velocity classified as a stockout", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 91,
        variant_id: 911,
        base_sku: "VELOCITY-STOCKOUT",
        product_name: "Velocity Stockout",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 30,
        previous_outbound_pieces: 30,
        demand_order_count: 10,
        demand_active_days: 8,
        latest_demand_at: "2026-05-18T12:00:00.000Z",
        on_order_pieces: 0,
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        preferred_vendor_id: 91,
      }],
    });

    expect(result.items[0]).toMatchObject({ status: "stockout" });
    expect(result.items[0].suggestedOrderPieces).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({ outOfStock: 1, noMovement: 0 });
  });

  it("treats committed forward demand as a demand signal for the zero-stock stockout guard", () => {
    const result = generatePurchasingRecommendations({
      asOf: "2026-05-20T12:00:00.000Z",
      lookbackDays: 30,
      rows: [{
        product_id: 92,
        variant_id: 921,
        base_sku: "EVENT-ONLY-STOCKOUT",
        product_name: "Event Only Stockout",
        total_pieces: 0,
        total_reserved_pieces: 0,
        total_outbound_pieces: 0,
        previous_outbound_pieces: 0,
        demand_order_count: 0,
        demand_active_days: 0,
        latest_demand_at: null,
        on_order_pieces: 0,
        vendor_lead_time_days: 3,
        safety_stock_days: 1,
        order_uom_units: 10,
        preferred_vendor_id: 92,
        // Zero velocity, but a demand event commits 40 pieces inside the
        // horizon: running at zero stock IS a stockout against that demand.
        forward_demand_pieces: 40,
        forward_demand_raw_pieces: 40,
        forward_demand_event_count: 1,
      }],
    });

    expect(result.items[0]).toMatchObject({
      status: "stockout",
      forwardDemandBasis: expect.objectContaining({ forwardDemandPieces: 40 }),
    });
    expect(result.items[0].suggestedOrderPieces).toBeGreaterThan(0);
    expect(result.summary).toMatchObject({ outOfStock: 1, noMovement: 0 });
  });
});

describe("catalog dimension and inbound ETA pass-through", () => {
  // Frozen clock (CLAUDE.md §3): keeps demand recency deterministic.
  const asOf = "2026-05-20T12:00:00.000Z";
  const baseRow = {
    product_id: 5,
    variant_id: 51,
    base_sku: "SKU-P1",
    product_name: "Product",
    variant_count: 1,
    total_pieces: 5,
    total_reserved_pieces: 1,
    total_outbound_pieces: 60,
    demand_order_count: 12,
    demand_active_days: 10,
    latest_demand_at: "2026-05-18T12:00:00.000Z",
    on_order_pieces: 0,
    open_po_count: 0,
    earliest_expected: null,
    lead_time_days: 2,
    safety_stock_days: 1,
  };

  it("passes category, product lines, and earliest inbound ETA through to items", () => {
    const result = generatePurchasingRecommendations({
      asOf,
      lookbackDays: 30,
      rows: [{
        ...baseRow,
        product_category: "Card Sleeves",
        product_line_names: ["Pro Line", "Shield Line"],
        // Keep effective supply (4 available + 1 on order) below the reorder
        // point so the row stays actionable and lands in result.items.
        on_order_pieces: 1,
        open_po_count: 1,
        earliest_expected: "2026-08-04T00:00:00.000Z",
      }],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      category: "Card Sleeves",
      productLines: ["Pro Line", "Shield Line"],
      onOrderPieces: 1,
      earliestInboundEta: "2026-08-04",
    });
  });

  it("normalizes a Date-typed earliest_expected to a local calendar date", () => {
    // node-postgres materializes `timestamp without time zone` as local-time
    // Dates; the ETA must reflect the stored calendar date, not a UTC shift.
    const result = generatePurchasingRecommendations({
      asOf,
      lookbackDays: 30,
      rows: [{
        ...baseRow,
        on_order_pieces: 1,
        open_po_count: 1,
        earliest_expected: new Date(2026, 7, 4),
      }],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].earliestInboundEta).toBe("2026-08-04");
  });

  it("defaults category to null, product lines to empty, and ETA to null when absent", () => {
    const result = generatePurchasingRecommendations({
      asOf,
      lookbackDays: 30,
      rows: [{ ...baseRow }],
    });

    expect(result.items[0]).toMatchObject({
      category: null,
      productLines: [],
      earliestInboundEta: null,
    });
  });

  it("drops blank category strings and non-string product line entries", () => {
    const result = generatePurchasingRecommendations({
      asOf,
      lookbackDays: 30,
      rows: [{
        ...baseRow,
        product_category: "   ",
        product_line_names: ["  Shield Line  ", "", 42, null],
      }],
    });

    expect(result.items[0]).toMatchObject({
      category: null,
      productLines: ["Shield Line"],
    });
  });

  it("carries the same fields on skipped items", () => {
    const result = generatePurchasingRecommendations({
      asOf,
      lookbackDays: 30,
      rows: [{
        ...baseRow,
        total_pieces: 500,
        product_category: "Storage",
        product_line_names: ["Vault Line"],
        on_order_pieces: 3,
        open_po_count: 1,
        earliest_expected: "2026-09-01T00:00:00.000Z",
      }],
    });

    // Non-excluded skipped rows are dual-listed: present in items and in
    // skippedItems with a skippedReason. Both carry the new fields.
    expect(result.skippedItems).toHaveLength(1);
    expect(result.skippedItems[0]).toMatchObject({
      skippedReason: "not_actionable_status",
      category: "Storage",
      productLines: ["Vault Line"],
      earliestInboundEta: "2026-09-01",
    });
  });
});
