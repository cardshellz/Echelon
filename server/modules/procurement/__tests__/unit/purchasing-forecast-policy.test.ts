import { describe, expect, it } from "vitest";
import {
  buildPurchasingForecastPolicyCohort,
  DEFAULT_PURCHASING_FORECAST_POLICY,
  normalizePurchasingForecastPolicy,
  PURCHASING_FORECAST_POLICY_CAPTURE_VERSION,
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

  it("builds a deterministic cohort from only forecast-affecting settings", () => {
    expect(buildPurchasingForecastPolicyCohort().fingerprint)
      .toBe("87bdbe7ba1ec6b5d2aea618c28cc86c90fd58aff5fc937c67db81c87d388f75f");
    const first = buildPurchasingForecastPolicyCohort({
      weights: { short: 40, standard: 30, long: 20, seasonal: 10 },
      forwardDemandConfidenceWeights: { high: 90, medium: 60, low: 30 },
      automationMinimumOrderCount: 9,
      automationMinimumActiveDays: 8,
    });
    const second = buildPurchasingForecastPolicyCohort({
      weights: { short: 40, standard: 30, long: 20, seasonal: 10 },
      forwardDemandConfidenceWeights: { high: 90, medium: 60, low: 30 },
      automationMinimumOrderCount: 1,
      automationMinimumActiveDays: 1,
    });

    expect(first.captureVersion).toBe(PURCHASING_FORECAST_POLICY_CAPTURE_VERSION);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toEqual(second);
    expect(first.snapshot).not.toHaveProperty("automationMinimumOrderCount");
    expect(first.snapshot).not.toHaveProperty("automationMinimumActiveDays");
  });

  it("changes the cohort when forecast quantity or overlay policy changes", () => {
    const baseline = buildPurchasingForecastPolicyCohort();
    expect(buildPurchasingForecastPolicyCohort({
      weights: { short: 35, standard: 30, long: 20, seasonal: 15 },
    }).fingerprint).not.toBe(baseline.fingerprint);
    expect(buildPurchasingForecastPolicyCohort({
      forwardDemandConfidenceWeights: { high: 100, medium: 65, low: 40 },
    }).fingerprint).not.toBe(baseline.fingerprint);
  });
});
