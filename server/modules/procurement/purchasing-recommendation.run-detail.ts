import type {
  AutoDraftRecommendationSettings,
  PurchasingRecommendationItem,
  PurchasingRecommendationResult,
} from "./purchasing-recommendation.engine";

export interface PurchasingRecommendationRunPoMutation {
  vendorId: number;
  poId: number;
  action: "created" | "updated" | "upserted";
  linesAdded: number;
}

export interface PurchasingRecommendationRunDetailOptions {
  lookbackDays: number;
  settings?: AutoDraftRecommendationSettings;
  generatedAt?: Date;
  poMutations?: PurchasingRecommendationRunPoMutation[];
}

export interface PurchasingRecommendationRunDetail {
  version: 1;
  generatedAt: string;
  lookbackDays: number;
  settings: AutoDraftRecommendationSettings;
  recommendationSummary: PurchasingRecommendationResult["summary"];
  forecastDiagnostics: ReturnType<typeof buildForecastDiagnostics>;
  statusCounts: Record<string, number>;
  skippedReasonCounts: Record<string, number>;
  actionableRecommendations: Array<ReturnType<typeof summarizeRecommendation>>;
  skippedRecommendations: Array<ReturnType<typeof summarizeRecommendation>>;
  poMutations: PurchasingRecommendationRunPoMutation[];
}

function increment(map: Record<string, number>, key: string | null | undefined) {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

function buildForecastDiagnostics(result: PurchasingRecommendationResult) {
  const demandQualityCounts: Record<string, number> = {};
  const demandTrendCounts: Record<string, number> = {};
  const shortWindowDemandQualityCounts: Record<string, number> = {};
  const shortWindowDemandTrendCounts: Record<string, number> = {};
  const longWindowDemandQualityCounts: Record<string, number> = {};
  const longWindowDemandTrendCounts: Record<string, number> = {};
  const seasonalWindowDemandQualityCounts: Record<string, number> = {};
  const seasonalWindowDemandTrendCounts: Record<string, number> = {};
  const demandAccelerationSignalCounts: Record<string, number> = {};
  const demandBaselineSignalCounts: Record<string, number> = {};
  const demandSeasonalitySignalCounts: Record<string, number> = {};
  const forecastMethodCounts: Record<string, number> = {};
  const qualityControlCounts: Record<string, number> = {};
  const qualityControlAreaCounts: Record<string, number> = {};
  const qualityControlSeverityCounts: Record<string, number> = {};
  const autopilotBlockerCounts: Record<string, number> = {};
  const autopilotBlockerAreaCounts: Record<string, number> = {};
  const autopilotBlockerSeverityCounts: Record<string, number> = {};
  const supplierCycleSignalCounts: Record<string, number> = {};
  const recommendationCandidateBandCounts: Record<string, number> = {};
  let totalPeriodUsagePieces = 0;
  let avgDailyUsageTotal = 0;
  let latestDemandAt: string | Date | null = null;
  let autopilotBlockerItemCount = 0;
  let openPoPastDueCount = 0;
  let supplyCoverageRatioTotal = 0;
  let supplyCoverageRatioCount = 0;
  let candidateScoreTotal = 0;
  let strongCandidateCount = 0;

  for (const item of result.items) {
    const provenance = item.forecastProvenance;
    increment(demandQualityCounts, provenance.demandQuality);
    increment(demandTrendCounts, provenance.demandTrend);
    increment(shortWindowDemandQualityCounts, provenance.demandWindowDiagnostics.shortWindow.demandQuality);
    increment(shortWindowDemandTrendCounts, provenance.demandWindowDiagnostics.shortWindow.demandTrend);
    increment(longWindowDemandQualityCounts, provenance.demandWindowDiagnostics.longWindow.demandQuality);
    increment(longWindowDemandTrendCounts, provenance.demandWindowDiagnostics.longWindow.demandTrend);
    if (provenance.demandWindowDiagnostics.seasonalWindow) {
      increment(seasonalWindowDemandQualityCounts, provenance.demandWindowDiagnostics.seasonalWindow.demandQuality);
      increment(seasonalWindowDemandTrendCounts, provenance.demandWindowDiagnostics.seasonalWindow.demandTrend);
    }
    increment(demandAccelerationSignalCounts, provenance.demandWindowDiagnostics.accelerationSignal);
    increment(demandBaselineSignalCounts, provenance.demandWindowDiagnostics.baselineSignal);
    increment(demandSeasonalitySignalCounts, provenance.demandWindowDiagnostics.seasonalSignal);
    increment(supplierCycleSignalCounts, item.supplierCycleDiagnostics.signal);
    increment(recommendationCandidateBandCounts, item.recommendationCandidateScore.band);
    candidateScoreTotal += item.recommendationCandidateScore.score;
    if (item.recommendationCandidateScore.band === "strong_candidate") strongCandidateCount += 1;
    if (item.supplierCycleDiagnostics.signal === "open_supply_past_due") openPoPastDueCount += 1;
    if (item.supplierCycleDiagnostics.supplyCoverageRatio != null) {
      supplyCoverageRatioTotal += item.supplierCycleDiagnostics.supplyCoverageRatio;
      supplyCoverageRatioCount += 1;
    }
    increment(forecastMethodCounts, provenance.forecastMethod);
    for (const control of item.qualityControls) {
      increment(qualityControlCounts, control.code);
      increment(qualityControlAreaCounts, control.area);
      increment(qualityControlSeverityCounts, control.severity);
    }
    if (item.autopilotBlockers.length > 0) autopilotBlockerItemCount += 1;
    for (const blocker of item.autopilotBlockers) {
      increment(autopilotBlockerCounts, blocker.code);
      increment(autopilotBlockerAreaCounts, blocker.area);
      increment(autopilotBlockerSeverityCounts, blocker.severity);
    }
    totalPeriodUsagePieces += provenance.periodUsagePieces;
    avgDailyUsageTotal += provenance.avgDailyUsagePieces;

    if (provenance.latestDemandAt) {
      const current = new Date(provenance.latestDemandAt).getTime();
      const latest = latestDemandAt ? new Date(latestDemandAt).getTime() : Number.NEGATIVE_INFINITY;
      if (Number.isFinite(current) && current > latest) latestDemandAt = provenance.latestDemandAt;
    }
  }

  const recommendationCount = result.items.length;
  return {
    recommendationCount,
    forecastMethodCounts,
    demandQualityCounts,
    demandTrendCounts,
    shortWindowDemandQualityCounts,
    shortWindowDemandTrendCounts,
    longWindowDemandQualityCounts,
    longWindowDemandTrendCounts,
    seasonalWindowDemandQualityCounts,
    seasonalWindowDemandTrendCounts,
    demandAccelerationSignalCounts,
    demandBaselineSignalCounts,
    demandSeasonalitySignalCounts,
    supplierCycleSignalCounts,
    supplierCycleOpenPoPastDueCount: openPoPastDueCount,
    avgSupplierCycleSupplyCoverageRatio:
      supplyCoverageRatioCount > 0 ? Math.round((supplyCoverageRatioTotal / supplyCoverageRatioCount) * 100) / 100 : null,
    recommendationCandidateBandCounts,
    avgRecommendationCandidateScore:
      recommendationCount > 0 ? Math.round((candidateScoreTotal / recommendationCount) * 100) / 100 : 0,
    strongRecommendationCandidateCount: strongCandidateCount,
    qualityControlCounts,
    qualityControlAreaCounts,
    qualityControlSeverityCounts,
    autopilotBlockerCounts,
    autopilotBlockerAreaCounts,
    autopilotBlockerSeverityCounts,
    autopilotBlockerItemCount,
    totalPeriodUsagePieces,
    avgDailyUsagePieces:
      recommendationCount > 0 ? Math.round((avgDailyUsageTotal / recommendationCount) * 100) / 100 : 0,
    latestDemandAt,
  };
}

function summarizeRecommendation(item: PurchasingRecommendationItem) {
  return {
    recommendationId: item.recommendationId,
    productId: item.productId,
    productVariantId: item.productVariantId ?? null,
    sku: item.sku,
    productName: item.productName,
    status: item.status,
    actionable: item.actionable,
    skippedReason: item.skippedReason,
    preferredVendorId: item.preferredVendorId,
    preferredVendorName: item.preferredVendorName,
    available: item.available,
    onOrderPieces: item.onOrderPieces,
    reorderPoint: item.reorderPoint,
    avgDailyUsage: item.avgDailyUsage,
    leadTimeDays: item.leadTimeDays,
    safetyStockDays: item.safetyStockDays,
    suggestedOrderQty: item.suggestedOrderQty,
    suggestedOrderPieces: item.suggestedOrderPieces,
    orderUomLabel: item.orderUomLabel,
    estimatedCostCents: item.estimatedCostCents,
    confidence: item.confidence,
    confidenceFactors: item.confidenceFactors,
    forecastProvenance: item.forecastProvenance,
    supplierBasis: item.supplierBasis,
    supplierCycleDiagnostics: item.supplierCycleDiagnostics,
    recommendationCandidateScore: item.recommendationCandidateScore,
    qualityControls: item.qualityControls,
    autopilotBlockers: item.autopilotBlockers,
    qualityGate: item.qualityGate,
    explanation: item.explanation,
    reviewSignal: item.reviewSignal,
  };
}

export function buildPurchasingRecommendationRunDetail(
  result: PurchasingRecommendationResult,
  options: PurchasingRecommendationRunDetailOptions,
): PurchasingRecommendationRunDetail {
  const statusCounts: Record<string, number> = {};
  const skippedReasonCounts: Record<string, number> = {};

  for (const item of result.items) {
    increment(statusCounts, item.status);
  }
  for (const item of result.skippedItems) {
    increment(skippedReasonCounts, item.skippedReason);
  }

  return {
    version: 1,
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    lookbackDays: options.lookbackDays,
    settings: options.settings ?? {},
    recommendationSummary: result.summary,
    forecastDiagnostics: buildForecastDiagnostics(result),
    statusCounts,
    skippedReasonCounts,
    actionableRecommendations: result.items
      .filter((item) => item.actionable)
      .slice(0, 25)
      .map(summarizeRecommendation),
    skippedRecommendations: result.skippedItems
      .slice(0, 25)
      .map(summarizeRecommendation),
    poMutations: options.poMutations ?? [],
  };
}
