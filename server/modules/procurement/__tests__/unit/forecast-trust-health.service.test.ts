import { describe, expect, it } from "vitest";
import { buildForecastTrustHealth } from "../../forecast-trust-health.service";
import { generatePurchasingRecommendations } from "../../purchasing-recommendation.engine";

describe("buildForecastTrustHealth", () => {
  it("summarizes forecast trust review and watch signals from recommendation output", () => {
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
          vendor_product_updated_at: "2026-05-20T00:00:00.000Z",
        },
        {
          product_id: 64,
          variant_id: 641,
          base_sku: "MISSING-LATEST",
          product_name: "Missing Latest Demand Product",
          total_pieces: 0,
          total_reserved_pieces: 0,
          total_outbound_pieces: 30,
          previous_outbound_pieces: 30,
          demand_order_count: 8,
          demand_active_days: 6,
          latest_demand_at: null,
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          vendor_product_id: 6410,
          preferred_vendor_id: 10,
          estimated_cost_cents: 250,
          vendor_product_updated_at: "2026-05-20T00:00:00.000Z",
        },
      ],
    });

    expect(buildForecastTrustHealth(result)).toMatchObject({
      totalRecommendations: 2,
      totalTrustItems: 2,
      counts: {
        reviewRecommendations: 1,
        watchRecommendations: 1,
        forecastTrustHeldAutoDraft: 1,
        staleRecentDemand: 1,
        missingLatestDemandTimestamp: 1,
        missingLatestDemandAt: 1,
      },
      actionCounts: {
        verify_recent_demand: 1,
        repair_order_velocity_source: 1,
      },
      actions: expect.arrayContaining([
        expect.objectContaining({
          code: "verify_recent_demand",
          label: "Verify recent demand",
          severity: "warning",
          count: 1,
        }),
        expect.objectContaining({
          code: "repair_order_velocity_source",
          label: "Repair velocity source",
          severity: "warning",
          count: 1,
        }),
      ]),
    });
  });

  it("does not classify no-recent-demand rows as velocity source repairs only because latest demand is blank", () => {
    const result = generatePurchasingRecommendations({
      lookbackDays: 30,
      asOf: "2026-05-24T00:00:00.000Z",
      rows: [
        {
          product_id: 65,
          variant_id: 651,
          base_sku: "NO-DEMAND-NO-LATEST",
          product_name: "No Demand No Latest Product",
          total_pieces: 100,
          total_reserved_pieces: 0,
          total_outbound_pieces: 0,
          previous_outbound_pieces: 0,
          demand_order_count: 0,
          demand_active_days: 0,
          latest_demand_at: null,
          short_window_days: 7,
          short_outbound_pieces: 0,
          previous_short_outbound_pieces: 0,
          short_demand_order_count: 0,
          short_demand_active_days: 0,
          short_latest_demand_at: null,
          long_window_days: 90,
          long_outbound_pieces: 0,
          previous_long_outbound_pieces: 0,
          long_demand_order_count: 0,
          long_demand_active_days: 0,
          long_latest_demand_at: null,
          seasonal_window_days: 30,
          seasonal_outbound_pieces: 0,
          previous_seasonal_outbound_pieces: 0,
          seasonal_demand_order_count: 0,
          seasonal_demand_active_days: 0,
          seasonal_latest_demand_at: null,
          on_order_pieces: 0,
          vendor_lead_time_days: 3,
          safety_stock_days: 1,
          order_uom_units: 10,
          vendor_product_id: 6510,
          preferred_vendor_id: 10,
          estimated_cost_cents: 250,
          vendor_product_updated_at: "2026-05-20T00:00:00.000Z",
        },
      ],
    });
    const health = buildForecastTrustHealth(result);

    expect(result.items[0].forecastProvenance.forecastTrust).toMatchObject({
      signal: "no_recent_demand",
      inputGaps: ["missing_latest_demand_at"],
    });
    expect(health).toMatchObject({
      actionCounts: {
        verify_recent_demand: 1,
      },
      actions: [
        expect.objectContaining({
          code: "verify_recent_demand",
          count: 1,
        }),
      ],
    });
    expect(health.actionCounts.repair_order_velocity_source).toBeUndefined();
  });
});
