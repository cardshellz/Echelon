import type {
  PurchasingRecommendationForecastInputGap,
  PurchasingRecommendationItem,
  PurchasingRecommendationResult,
} from "./purchasing-recommendation.engine";

export type ForecastInputGapActionCode =
  | "repair_order_velocity_source"
  | "rebuild_forecast_windows"
  | "verify_recent_demand"
  | "monitor_thin_sample";

export type ForecastInputGapAction = {
  code: ForecastInputGapActionCode;
  label: string;
  detail: string;
  href: string;
};

export type ForecastInputGapDiagnosticsSample = {
  recommendationId: string;
  sku: string;
  productName: string;
  productId: number;
  productVariantId: number | null;
  status: string;
  confidence: string;
  candidateBand: string;
  candidateScore: number;
  qualityGateReason: string;
  forecastTrustSignal: string;
  forecastTrustSeverity: string;
  forecastTrustDetail: string;
  latestDemandAgeDays: number | null;
  inputGaps: PurchasingRecommendationForecastInputGap[];
  action: ForecastInputGapAction;
};

export type ForecastInputGapDiagnostics = {
  totalRecommendations: number;
  totalIssueItems: number;
  inputGapItems: number;
  reviewItems: number;
  watchItems: number;
  trustedItems: number;
  forecastTrustHeldAutoDraft: number;
  gapCounts: Record<string, number>;
  trustSignalCounts: Record<string, number>;
  trustSeverityCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  samples: ForecastInputGapDiagnosticsSample[];
};

function increment(counts: Record<string, number>, key: string | null | undefined) {
  if (!key) return;
  counts[key] = (counts[key] ?? 0) + 1;
}

function forecastInputGapAction(item: PurchasingRecommendationItem): ForecastInputGapAction {
  const gaps = item.forecastProvenance.forecastTrust.inputGaps;
  const signal = item.forecastProvenance.forecastTrust.signal;

  if (
    gaps.includes("missing_latest_demand_at") ||
    gaps.includes("missing_demand_order_count") ||
    gaps.includes("missing_demand_active_days")
  ) {
    return {
      code: "repair_order_velocity_source",
      label: "Repair velocity source",
      detail: "Recent order velocity is missing demand timestamps or sample metadata.",
      href: "/reorder-analysis?reviewQueue=quality_review_required&reason=forecast_trust_review",
    };
  }

  if (
    gaps.includes("missing_prior_period") ||
    gaps.includes("missing_short_window") ||
    gaps.includes("missing_long_window") ||
    gaps.includes("missing_seasonal_window")
  ) {
    return {
      code: "rebuild_forecast_windows",
      label: "Rebuild forecast windows",
      detail: "One or more comparison windows are missing from the recommendation input.",
      href: "/reorder-analysis?reviewQueue=quality_review_required&reason=forecast_trust_review",
    };
  }

  if (signal === "no_recent_demand" || signal === "stale_recent_demand") {
    return {
      code: "verify_recent_demand",
      label: "Verify recent demand",
      detail: "Demand is absent or stale enough to hold automated purchasing.",
      href: "/reorder-analysis?reviewQueue=quality_review_required&reason=forecast_trust_review",
    };
  }

  return {
    code: "monitor_thin_sample",
    label: "Monitor thin sample",
    detail: "Forecast trust is weak, but the recommendation is not held by a source-data gap.",
    href: "/reorder-analysis",
  };
}

function buildSample(item: PurchasingRecommendationItem): ForecastInputGapDiagnosticsSample {
  const trust = item.forecastProvenance.forecastTrust;
  return {
    recommendationId: item.recommendationId,
    sku: item.sku,
    productName: item.productName,
    productId: item.productId,
    productVariantId: item.productVariantId ?? null,
    status: item.status,
    confidence: item.confidence,
    candidateBand: item.recommendationCandidateScore.band,
    candidateScore: item.recommendationCandidateScore.score,
    qualityGateReason: item.qualityGate.reason,
    forecastTrustSignal: trust.signal,
    forecastTrustSeverity: trust.severity,
    forecastTrustDetail: trust.detail,
    latestDemandAgeDays: trust.latestDemandAgeDays,
    inputGaps: trust.inputGaps,
    action: forecastInputGapAction(item),
  };
}

export function buildForecastInputGapDiagnostics(
  result: PurchasingRecommendationResult,
  options: { limit?: number } = {},
): ForecastInputGapDiagnostics {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const gapCounts: Record<string, number> = {};
  const trustSignalCounts: Record<string, number> = {};
  const trustSeverityCounts: Record<string, number> = {};
  const actionCounts: Record<string, number> = {};
  const issueItems: PurchasingRecommendationItem[] = [];
  let reviewItems = 0;
  let watchItems = 0;
  let trustedItems = 0;
  let inputGapItems = 0;
  let forecastTrustHeldAutoDraft = 0;

  for (const item of result.items) {
    const trust = item.forecastProvenance.forecastTrust;
    increment(trustSignalCounts, trust.signal);
    increment(trustSeverityCounts, trust.severity);

    if (trust.severity === "review") reviewItems += 1;
    if (trust.severity === "watch") watchItems += 1;
    if (trust.severity === "ok") trustedItems += 1;
    if (item.qualityGate.reason === "forecast_trust_review") forecastTrustHeldAutoDraft += 1;

    if (trust.inputGaps.length > 0) inputGapItems += 1;
    for (const gap of trust.inputGaps) {
      increment(gapCounts, gap);
    }

    if (trust.severity !== "ok" || trust.inputGaps.length > 0) {
      issueItems.push(item);
      increment(actionCounts, forecastInputGapAction(item).code);
    }
  }

  const samples = issueItems
    .sort((a, b) => {
      const severityScore = (item: PurchasingRecommendationItem) =>
        item.forecastProvenance.forecastTrust.severity === "review"
          ? 0
          : item.forecastProvenance.forecastTrust.severity === "watch"
            ? 1
            : 2;
      const severityDelta = severityScore(a) - severityScore(b);
      if (severityDelta !== 0) return severityDelta;
      const gapDelta =
        b.forecastProvenance.forecastTrust.inputGaps.length - a.forecastProvenance.forecastTrust.inputGaps.length;
      if (gapDelta !== 0) return gapDelta;
      return b.recommendationCandidateScore.score - a.recommendationCandidateScore.score;
    })
    .slice(0, limit)
    .map(buildSample);

  return {
    totalRecommendations: result.items.length,
    totalIssueItems: issueItems.length,
    inputGapItems,
    reviewItems,
    watchItems,
    trustedItems,
    forecastTrustHeldAutoDraft,
    gapCounts,
    trustSignalCounts,
    trustSeverityCounts,
    actionCounts,
    samples,
  };
}
