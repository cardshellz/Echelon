export type PurchasingForecastMethod = "recent_order_velocity_v1" | "weighted_blend_v1";

export interface PurchasingForecastPolicy {
  method: PurchasingForecastMethod;
  shortWindowDays: number;
  standardWindowDays: number;
  longWindowDays: number;
  seasonalEnabled: boolean;
  seasonalWindowDays: number;
  weights: {
    short: number;
    standard: number;
    long: number;
    seasonal: number;
  };
  forwardDemandEnabled: boolean;
  forwardDemandHorizonDays: number;
  forwardDemandConfidenceWeights: {
    high: number;
    medium: number;
    low: number;
  };
  automationMinimumOrderCount: number;
  automationMinimumActiveDays: number;
}

export const DEFAULT_PURCHASING_FORECAST_POLICY: PurchasingForecastPolicy = {
  method: "weighted_blend_v1",
  shortWindowDays: 7,
  standardWindowDays: 30,
  longWindowDays: 90,
  seasonalEnabled: true,
  seasonalWindowDays: 30,
  weights: { short: 30, standard: 35, long: 20, seasonal: 15 },
  forwardDemandEnabled: true,
  forwardDemandHorizonDays: 90,
  forwardDemandConfidenceWeights: { high: 100, medium: 70, low: 40 },
  automationMinimumOrderCount: 2,
  automationMinimumActiveDays: 2,
};

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function normalizePurchasingForecastPolicy(
  value?: Partial<PurchasingForecastPolicy> | null,
): PurchasingForecastPolicy {
  const defaults = DEFAULT_PURCHASING_FORECAST_POLICY;
  const method = value?.method === "recent_order_velocity_v1" ? "recent_order_velocity_v1" : "weighted_blend_v1";
  const seasonalEnabled = value?.seasonalEnabled ?? defaults.seasonalEnabled;
  const weights = {
    short: boundedInteger(value?.weights?.short, defaults.weights.short, 0, 100),
    standard: boundedInteger(value?.weights?.standard, defaults.weights.standard, 0, 100),
    long: boundedInteger(value?.weights?.long, defaults.weights.long, 0, 100),
    seasonal: boundedInteger(value?.weights?.seasonal, defaults.weights.seasonal, 0, 100),
  };
  const enabledWeightTotal = weights.short + weights.standard + weights.long + (seasonalEnabled ? weights.seasonal : 0);
  const normalizedWeights = enabledWeightTotal > 0 ? weights : defaults.weights;

  return {
    method,
    shortWindowDays: boundedInteger(value?.shortWindowDays, defaults.shortWindowDays, 1, 60),
    standardWindowDays: boundedInteger(value?.standardWindowDays, defaults.standardWindowDays, 7, 180),
    longWindowDays: boundedInteger(value?.longWindowDays, defaults.longWindowDays, 30, 730),
    seasonalEnabled,
    seasonalWindowDays: boundedInteger(value?.seasonalWindowDays, defaults.seasonalWindowDays, 7, 120),
    weights: normalizedWeights,
    forwardDemandEnabled: value?.forwardDemandEnabled ?? defaults.forwardDemandEnabled,
    forwardDemandHorizonDays: boundedInteger(
      value?.forwardDemandHorizonDays,
      defaults.forwardDemandHorizonDays,
      1,
      365,
    ),
    forwardDemandConfidenceWeights: {
      high: boundedInteger(
        value?.forwardDemandConfidenceWeights?.high,
        defaults.forwardDemandConfidenceWeights.high,
        0,
        100,
      ),
      medium: boundedInteger(
        value?.forwardDemandConfidenceWeights?.medium,
        defaults.forwardDemandConfidenceWeights.medium,
        0,
        100,
      ),
      low: boundedInteger(
        value?.forwardDemandConfidenceWeights?.low,
        defaults.forwardDemandConfidenceWeights.low,
        0,
        100,
      ),
    },
    automationMinimumOrderCount: boundedInteger(
      value?.automationMinimumOrderCount,
      defaults.automationMinimumOrderCount,
      1,
      100,
    ),
    automationMinimumActiveDays: boundedInteger(
      value?.automationMinimumActiveDays,
      defaults.automationMinimumActiveDays,
      1,
      100,
    ),
  };
}
