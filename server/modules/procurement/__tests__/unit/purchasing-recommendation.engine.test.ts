import { describe, expect, it } from "vitest";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

describe("purchasing recommendation engine", () => {
  it("produces an explainable actionable recommendation using vendor lead time and order UOM", () => {
    const result = generatePurchasingRecommendations({
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
      suggestedOrderQty: 1,
      suggestedOrderPieces: 10,
      orderUomLabel: "Case",
      preferredVendorId: 77,
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
        estimatedCostCents: 125,
        lastCostCents: 120,
      },
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
        orderUomSource: "variant",
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
    expect(result.items[0].explanation).toContain("Recommend 1 Case");
  });

  it("keeps excluded products out of visible recommendations and reports the skip", () => {
    const result = generatePurchasingRecommendations({
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
      actionable: false,
    });
  });

  it("marks auto-draft recommendations blocked when preferred vendor is required", () => {
    const result = generatePurchasingRecommendations({
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
      suggestedOrderQty: 2,
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
      lookbackDays: 30,
      rows: [
        {
          product_id: 50,
          base_sku: "THIN",
          product_name: "Thin History Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 2,
          on_order_pieces: 0,
          order_uom_units: null,
          preferred_vendor_id: 10,
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
      },
      confidenceFactors: expect.arrayContaining([
        "Limited demand history in the lookback window.",
        "Lead time uses the default fallback.",
        "Safety stock uses the default fallback.",
        "Order UOM defaults to each because no higher ordering unit is configured.",
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
        orderUomSource: "default_each",
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
          preferred_vendor_id: 10,
        },
      ],
    });

    expect(result.items[0]).toMatchObject({
      confidence: "medium",
      qualityGate: {
        autoDraftEligible: false,
        reason: "medium_confidence_review",
      },
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

  it("downgrades confidence and exposes stale last-purchase supplier cost fallback", () => {
    const result = generatePurchasingRecommendations({
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
      estimatedCostCents: 225,
      qualityGate: {
        autoDraftEligible: false,
        reason: "medium_confidence_review",
      },
      supplierBasis: {
        vendorProductId: 7010,
        costSource: "last_purchase_cost",
        costQuality: "stale",
        estimatedCostCents: 225,
        lastCostCents: 225,
      },
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
});
