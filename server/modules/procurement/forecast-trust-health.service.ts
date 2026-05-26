import type { PurchasingRecommendationResult } from "./purchasing-recommendation.engine";
import {
  buildForecastInputGapDiagnostics,
  type ForecastInputGapActionSummary,
} from "./forecast-input-gap-diagnostics.service";

export type ForecastTrustHealthCounts = {
  trusted: number;
  watchRecommendations: number;
  reviewRecommendations: number;
  forecastTrustHeldAutoDraft: number;
  inputGapItems: number;
  noRecentDemand: number;
  staleRecentDemand: number;
  thinSample: number;
  missingLatestDemandTimestamp: number;
  missingPriorBaseline: number;
  missingLatestDemandAt: number;
  missingDemandOrderCount: number;
  missingDemandActiveDays: number;
  missingPriorPeriod: number;
  missingShortWindow: number;
  missingLongWindow: number;
  missingSeasonalWindow: number;
};

export type ForecastTrustHealth = {
  totalRecommendations: number;
  totalTrustItems: number;
  counts: ForecastTrustHealthCounts;
  actionCounts: Record<string, number>;
  actions: ForecastInputGapActionSummary[];
};

function emptyCounts(): ForecastTrustHealthCounts {
  return {
    trusted: 0,
    watchRecommendations: 0,
    reviewRecommendations: 0,
    forecastTrustHeldAutoDraft: 0,
    inputGapItems: 0,
    noRecentDemand: 0,
    staleRecentDemand: 0,
    thinSample: 0,
    missingLatestDemandTimestamp: 0,
    missingPriorBaseline: 0,
    missingLatestDemandAt: 0,
    missingDemandOrderCount: 0,
    missingDemandActiveDays: 0,
    missingPriorPeriod: 0,
    missingShortWindow: 0,
    missingLongWindow: 0,
    missingSeasonalWindow: 0,
  };
}

export function buildForecastTrustHealth(result: PurchasingRecommendationResult): ForecastTrustHealth {
  const counts = emptyCounts();
  const inputGapDiagnostics = buildForecastInputGapDiagnostics(result, { limit: 1 });
  let totalTrustItems = 0;

  for (const item of result.items) {
    const trust = item.forecastProvenance.forecastTrust;

    if (trust.severity === "ok") {
      counts.trusted += 1;
    } else {
      totalTrustItems += 1;
      if (trust.severity === "watch") counts.watchRecommendations += 1;
      if (trust.severity === "review") counts.reviewRecommendations += 1;
    }

    if (item.qualityGate.reason === "forecast_trust_review") {
      counts.forecastTrustHeldAutoDraft += 1;
    }

    switch (trust.signal) {
      case "no_recent_demand":
        counts.noRecentDemand += 1;
        break;
      case "stale_recent_demand":
        counts.staleRecentDemand += 1;
        break;
      case "thin_sample":
        counts.thinSample += 1;
        break;
      case "missing_latest_demand_timestamp":
        counts.missingLatestDemandTimestamp += 1;
        break;
      case "missing_prior_baseline":
        counts.missingPriorBaseline += 1;
        break;
      case "trusted":
        break;
    }

    if (trust.inputGaps.length > 0) counts.inputGapItems += 1;
    for (const gap of trust.inputGaps) {
      switch (gap) {
        case "missing_latest_demand_at":
          counts.missingLatestDemandAt += 1;
          break;
        case "missing_demand_order_count":
          counts.missingDemandOrderCount += 1;
          break;
        case "missing_demand_active_days":
          counts.missingDemandActiveDays += 1;
          break;
        case "missing_prior_period":
          counts.missingPriorPeriod += 1;
          break;
        case "missing_short_window":
          counts.missingShortWindow += 1;
          break;
        case "missing_long_window":
          counts.missingLongWindow += 1;
          break;
        case "missing_seasonal_window":
          counts.missingSeasonalWindow += 1;
          break;
      }
    }
  }

  return {
    totalRecommendations: result.items.length,
    totalTrustItems,
    counts,
    actionCounts: inputGapDiagnostics.actionCounts,
    actions: inputGapDiagnostics.actions,
  };
}
