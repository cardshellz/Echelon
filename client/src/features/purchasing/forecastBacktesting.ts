import { z } from "zod";

export const forecastEvaluationHorizons = [7, 30, 90] as const;
export type ForecastEvaluationHorizon = typeof forecastEvaluationHorizons[number];

const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveSafeInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const nullableNonnegativeSafeInteger = nonnegativeSafeInteger.nullable();
const nullableSafeInteger = safeInteger.nullable();
const horizonSchema = z.union([z.literal(7), z.literal(30), z.literal(90)]);

const forecastBacktestSummarySchema = z.object({
  horizonDays: horizonSchema,
  evaluationCount: nonnegativeSafeInteger,
  actualDemandPieces: nonnegativeSafeInteger,
  forecastDemandMicros: nonnegativeSafeInteger,
  baselineDemandMicros: nonnegativeSafeInteger,
  forecastAbsoluteErrorMicros: nonnegativeSafeInteger,
  baselineAbsoluteErrorMicros: nonnegativeSafeInteger,
  forecastBiasMicros: safeInteger,
  baselineBiasMicros: safeInteger,
  forecastWapeBasisPoints: nonnegativeSafeInteger.nullable(),
  baselineWapeBasisPoints: nonnegativeSafeInteger.nullable(),
  forecastWapeImprovementBasisPoints: safeInteger.nullable(),
  forecastWinCount: nonnegativeSafeInteger,
  baselineWinCount: nonnegativeSafeInteger,
  tieCount: nonnegativeSafeInteger,
  zeroActualCount: nonnegativeSafeInteger,
  observationsWithForwardDemand: nonnegativeSafeInteger,
  overlayEvaluationCount: nonnegativeSafeInteger,
  overlayActualDemandPieces: nonnegativeSafeInteger,
  overlayRawDemandPieces: nonnegativeSafeInteger,
  overlayWeightedDemandPieces: nonnegativeSafeInteger,
  overlayCohortForecastAbsoluteErrorMicros: nonnegativeSafeInteger,
  overlayAdjustedForecastDemandMicros: nonnegativeSafeInteger,
  overlayAdjustedAbsoluteErrorMicros: nonnegativeSafeInteger,
  overlayAdjustedBiasMicros: safeInteger,
  overlayCohortForecastWapeBasisPoints: nonnegativeSafeInteger.nullable(),
  overlayAdjustedWapeBasisPoints: nonnegativeSafeInteger.nullable(),
  overlayWapeImprovementBasisPoints: safeInteger.nullable(),
  overlayWinCount: nonnegativeSafeInteger,
  historicalForecastWinCount: nonnegativeSafeInteger,
  overlayTieCount: nonnegativeSafeInteger,
  observationsWithAttributedOverlay: nonnegativeSafeInteger,
}).passthrough().superRefine((summary, context) => {
  if (
    summary.forecastWinCount + summary.baselineWinCount + summary.tieCount
    !== summary.evaluationCount
  ) {
    context.addIssue({ code: "custom", message: "Historical outcome counts do not match evaluation count" });
  }
  if (
    summary.overlayWinCount + summary.historicalForecastWinCount + summary.overlayTieCount
    !== summary.overlayEvaluationCount
  ) {
    context.addIssue({ code: "custom", message: "Overlay outcome counts do not match overlay evaluation count" });
  }
  if (
    summary.overlayEvaluationCount > summary.evaluationCount
    || summary.observationsWithAttributedOverlay > summary.overlayEvaluationCount
  ) {
    context.addIssue({ code: "custom", message: "Overlay coverage counts are inconsistent" });
  }
});

const overlayExclusionReasonSchema = z.enum([
  "legacy_evaluation",
  "capture_incomplete",
  "capture_coverage_unavailable",
  "capture_horizon_insufficient",
  "capture_planning_date_mismatch",
]);

const forecastBacktestItemSchema = z.object({
  id: positiveSafeInteger,
  observationId: positiveSafeInteger,
  runId: positiveSafeInteger,
  productId: positiveSafeInteger,
  productSku: z.string().min(1),
  productName: z.string().min(1),
  horizonDays: horizonSchema,
  observedFrom: z.string().datetime(),
  observedThroughExclusive: z.string().datetime(),
  actualDemandPieces: nonnegativeSafeInteger,
  forecastDemandMicros: nonnegativeSafeInteger,
  baselineDemandMicros: nonnegativeSafeInteger,
  forecastAbsoluteErrorMicros: nonnegativeSafeInteger,
  baselineAbsoluteErrorMicros: nonnegativeSafeInteger,
  overlayEvaluable: z.boolean(),
  overlayExclusionReason: overlayExclusionReasonSchema.nullable(),
  overlayContributionCount: nullableNonnegativeSafeInteger,
  overlayRawDemandPieces: nullableNonnegativeSafeInteger,
  overlayWeightedDemandPieces: nullableNonnegativeSafeInteger,
  overlayAdjustedForecastDemandMicros: nullableNonnegativeSafeInteger,
  overlayAdjustedAbsoluteErrorMicros: nullableNonnegativeSafeInteger,
  overlayAdjustedBiasMicros: nullableSafeInteger,
  outcome: z.enum(["forecast_wins", "baseline_wins", "tie"]),
  forecastErrorImprovementMicros: safeInteger,
  forwardDemandOverlayIncluded: z.boolean(),
  overlayOutcome: z.enum(["overlay_wins", "historical_forecast_wins", "tie"]).nullable(),
  overlayErrorImprovementMicros: nullableSafeInteger,
  evaluatedAt: z.string().datetime(),
}).passthrough().superRefine((item, context) => {
  const overlayMetrics = [
    item.overlayContributionCount,
    item.overlayRawDemandPieces,
    item.overlayWeightedDemandPieces,
    item.overlayAdjustedForecastDemandMicros,
    item.overlayAdjustedAbsoluteErrorMicros,
    item.overlayAdjustedBiasMicros,
    item.overlayOutcome,
    item.overlayErrorImprovementMicros,
  ];
  if (item.overlayEvaluable) {
    if (item.overlayExclusionReason !== null || overlayMetrics.some((value) => value === null)) {
      context.addIssue({ code: "custom", message: "Evaluable overlay row is missing metrics" });
    }
  } else if (
    item.overlayExclusionReason === null
    || overlayMetrics.some((value) => value !== null)
    || item.forwardDemandOverlayIncluded
  ) {
    context.addIssue({ code: "custom", message: "Excluded overlay row contains scoring metrics" });
  }
});

export const forecastBacktestReportSchema = z.object({
  evaluationVersion: positiveSafeInteger,
  measurement: z.object({
    scope: z.literal("product_all_warehouses"),
    predictionScope: z.literal("historical_rate_with_optional_start_date_overlay"),
    historicalPredictionScope: z.literal("historical_rate_only"),
    horizons: z.array(horizonSchema).min(1),
    wapeUnit: z.literal("basis_points"),
    quantityUnit: z.literal("base_piece"),
    predictionPrecision: z.literal("micro_piece"),
    overlayAttributionVersion: positiveSafeInteger,
    overlayAttributionInterval: z.string(),
    overlayEligibility: z.string(),
  }).passthrough(),
  summaries: z.array(forecastBacktestSummarySchema),
  itemCount: nonnegativeSafeInteger,
  items: z.array(forecastBacktestItemSchema),
}).passthrough().superRefine((report, context) => {
  if (report.itemCount !== report.items.length) {
    context.addIssue({ code: "custom", message: "Forecast report item count does not match items" });
  }
  const horizons = report.summaries.map((summary) => summary.horizonDays);
  if (new Set(horizons).size !== horizons.length) {
    context.addIssue({ code: "custom", message: "Forecast report contains duplicate horizon summaries" });
  }
});

export const forecastBacktestEvaluationResultSchema = z.object({
  evaluationVersion: positiveSafeInteger,
  evaluatedAt: z.string().datetime(),
  horizons: z.array(horizonSchema).min(1),
  limit: positiveSafeInteger,
  candidateCount: nonnegativeSafeInteger,
  insertedCount: nonnegativeSafeInteger,
  concurrentReplayCount: nonnegativeSafeInteger,
  batchLimitReached: z.boolean(),
  candidateCountsByHorizon: z.record(z.string(), nonnegativeSafeInteger),
  insertedCountsByHorizon: z.record(z.string(), nonnegativeSafeInteger),
  serializationRetryCount: nonnegativeSafeInteger,
}).passthrough().superRefine((result, context) => {
  if (result.insertedCount + result.concurrentReplayCount !== result.candidateCount) {
    context.addIssue({ code: "custom", message: "Evaluation result counts do not reconcile" });
  }
});

export type ForecastBacktestReport = z.infer<typeof forecastBacktestReportSchema>;
export type ForecastBacktestSummary = z.infer<typeof forecastBacktestSummarySchema>;
export type ForecastBacktestItem = z.infer<typeof forecastBacktestItemSchema>;
export type ForecastBacktestEvaluationResult = z.infer<typeof forecastBacktestEvaluationResultSchema>;

export function formatWapeBasisPoints(value: number | null): string {
  return value === null ? "N/A" : `${(value / 100).toFixed(2)}%`;
}

export function formatWapeImprovement(value: number | null): string {
  if (value === null) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value / 100).toFixed(2)} pp`;
}

export function formatMicrosAsPieces(value: number | null): string {
  if (value === null) return "N/A";
  return (value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatEvaluationDate(value: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).format(new Date(value));
}

export function formatOverlayExclusionReason(
  reason: ForecastBacktestItem["overlayExclusionReason"],
): string {
  switch (reason) {
    case "legacy_evaluation":
      return "Legacy evaluation";
    case "capture_incomplete":
      return "Capture incomplete";
    case "capture_coverage_unavailable":
      return "Coverage unavailable";
    case "capture_horizon_insufficient":
      return "Horizon not covered";
    case "capture_planning_date_mismatch":
      return "Planning date mismatch";
    default:
      return "Not excluded";
  }
}
