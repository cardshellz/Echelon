import { describe, expect, it } from "vitest";
import { buildSupplierSetupGaps } from "../../supplier-setup-gaps.service";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

describe("buildSupplierSetupGaps", () => {
  it("only counts missing vendor as blocked when it blocks the current recommendation", () => {
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      asOf: "2026-05-24T00:00:00.000Z",
      requireVendor: true,
      autoDraftSettings: {
        autoDraftMode: "draft_po",
        approvalPolicy: "high_confidence_only",
        includeOrderSoon: false,
        skipOnOpenPo: true,
        skipNoVendor: true,
      },
      rows: [
        {
          product_id: 70,
          variant_id: 701,
          base_sku: "NO-VENDOR-BLOCKING",
          product_name: "No Vendor Blocking Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          previous_outbound_pieces: 30,
          demand_order_count: 10,
          demand_active_days: 8,
          latest_demand_at: "2026-05-23T00:00:00.000Z",
          on_order_pieces: 0,
          open_po_count: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          preferred_vendor_id: null,
          estimated_cost_cents: 250,
        },
        {
          product_id: 71,
          variant_id: 711,
          base_sku: "NO-VENDOR-NOT-CURRENT",
          product_name: "No Vendor Not Current Product",
          total_pieces: 100,
          total_reserved_pieces: 0,
          total_outbound_pieces: 0,
          previous_outbound_pieces: 0,
          demand_order_count: 0,
          demand_active_days: 0,
          latest_demand_at: null,
          on_order_pieces: 0,
          open_po_count: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          preferred_vendor_id: null,
          estimated_cost_cents: 250,
        },
      ],
    });

    const gaps = buildSupplierSetupGaps(result);

    expect(gaps).toMatchObject({
      totalGapItems: 2,
      counts: {
        missingVendor: 2,
        blockedRecommendations: 1,
        reviewRecommendations: 1,
      },
    });
    expect(gaps.items[0]).toMatchObject({
      sku: "NO-VENDOR-BLOCKING",
      skippedReason: "no_vendor",
      blocksCurrentRecommendation: true,
      gaps: [expect.objectContaining({ code: "missing_vendor" })],
      action: {
        action: "assign_preferred_vendor",
        label: "Assign vendor",
        href: expect.stringMatching(/^\/suppliers\?/),
      },
    });
    const setupUrl = new URL(gaps.items[0].action.href, "https://echelon.example");
    expect(Object.fromEntries(setupUrl.searchParams)).toEqual({
      setupProductId: "70",
      setupAction: "assign_preferred_vendor",
      recommendationId: "70:701:30",
      returnTo: "/purchasing",
      setupVariantId: "701",
    });
    expect(gaps.items[1]).toMatchObject({
      sku: "NO-VENDOR-NOT-CURRENT",
      skippedReason: "not_actionable_status",
      blocksCurrentRecommendation: false,
      gaps: [expect.objectContaining({ code: "missing_vendor" })],
    });
  });
});
