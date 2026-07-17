import { describe, expect, it } from "vitest";
import {
  DEFAULT_PURCHASING_FORECAST_POLICY,
  normalizePurchasingForecastPolicy,
} from "../../purchasing-forecast-policy";

describe("purchasing forecast policy", () => {
  it("provides an automation-safe multi-window default", () => {
    expect(DEFAULT_PURCHASING_FORECAST_POLICY).toMatchObject({
      method: "weighted_blend_v1",
      shortWindowDays: 7,
      standardWindowDays: 30,
      longWindowDays: 90,
      seasonalEnabled: true,
      forwardDemandEnabled: true,
      forwardDemandHorizonDays: 90,
    });
    expect(Object.values(DEFAULT_PURCHASING_FORECAST_POLICY.weights).reduce((sum, value) => sum + value, 0)).toBe(100);
  });

  it("preserves valid operator configuration and falls back for out-of-range values", () => {
    const normalized = normalizePurchasingForecastPolicy({
      shortWindowDays: 14,
      longWindowDays: 180,
      weights: { short: 40, standard: 30, long: 20, seasonal: 10 },
      forwardDemandHorizonDays: 200,
      forwardDemandConfidenceWeights: { high: 95, medium: 65, low: 25 },
      automationMinimumOrderCount: 8,
      automationMinimumActiveDays: 5,
    });
    expect(normalized).toMatchObject({
      shortWindowDays: 14,
      longWindowDays: 180,
      weights: { short: 40, standard: 30, long: 20, seasonal: 10 },
      forwardDemandHorizonDays: 200,
      forwardDemandConfidenceWeights: { high: 95, medium: 65, low: 25 },
      automationMinimumOrderCount: 8,
      automationMinimumActiveDays: 5,
    });

    expect(normalizePurchasingForecastPolicy({ shortWindowDays: 0 }).shortWindowDays)
      .toBe(DEFAULT_PURCHASING_FORECAST_POLICY.shortWindowDays);
  });
});
