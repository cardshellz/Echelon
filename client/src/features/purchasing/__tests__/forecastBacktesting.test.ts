import { describe, expect, it } from "vitest";
import {
  forecastBacktestEvaluationResultSchema,
  forecastBacktestReportSchema,
  formatEvaluationDate,
  formatMicrosAsPieces,
  formatOverlayExclusionReason,
  formatWapeBasisPoints,
  formatWapeImprovement,
} from "../forecastBacktesting";

function summary() {
  return {
    horizonDays: 30,
    evaluationCount: 2,
    actualDemandPieces: 100,
    forecastDemandMicros: 100_000_000,
    baselineDemandMicros: 110_000_000,
    forecastAbsoluteErrorMicros: 10_000_000,
    baselineAbsoluteErrorMicros: 20_000_000,
    forecastBiasMicros: 0,
    baselineBiasMicros: 10_000_000,
    forecastWapeBasisPoints: 1_000,
    baselineWapeBasisPoints: 2_000,
    forecastWapeImprovementBasisPoints: 1_000,
    forecastWinCount: 1,
    baselineWinCount: 0,
    tieCount: 1,
    zeroActualCount: 0,
    observationsWithForwardDemand: 1,
    overlayEvaluationCount: 1,
    overlayActualDemandPieces: 50,
    overlayRawDemandPieces: 6,
    overlayWeightedDemandPieces: 5,
    overlayCohortForecastAbsoluteErrorMicros: 5_000_000,
    overlayAdjustedForecastDemandMicros: 50_000_000,
    overlayAdjustedAbsoluteErrorMicros: 0,
    overlayAdjustedBiasMicros: 0,
    overlayCohortForecastWapeBasisPoints: 1_000,
    overlayAdjustedWapeBasisPoints: 0,
    overlayWapeImprovementBasisPoints: 1_000,
    overlayWinCount: 1,
    historicalForecastWinCount: 0,
    overlayTieCount: 0,
    observationsWithAttributedOverlay: 1,
  };
}

function excludedItem() {
  return {
    id: 1,
    observationId: 2,
    runId: 3,
    productId: 4,
    productSku: "SKU-4",
    productName: "Product 4",
    horizonDays: 30,
    observedFrom: "2026-01-01T00:00:00.000Z",
    observedThroughExclusive: "2026-01-31T00:00:00.000Z",
    actualDemandPieces: 50,
    forecastDemandMicros: 45_000_000,
    baselineDemandMicros: 40_000_000,
    forecastAbsoluteErrorMicros: 5_000_000,
    baselineAbsoluteErrorMicros: 10_000_000,
    overlayEvaluable: false,
    overlayExclusionReason: "capture_incomplete",
    overlayContributionCount: null,
    overlayRawDemandPieces: null,
    overlayWeightedDemandPieces: null,
    overlayAdjustedForecastDemandMicros: null,
    overlayAdjustedAbsoluteErrorMicros: null,
    overlayAdjustedBiasMicros: null,
    outcome: "forecast_wins",
    forecastErrorImprovementMicros: 5_000_000,
    forwardDemandOverlayIncluded: false,
    overlayOutcome: null,
    overlayErrorImprovementMicros: null,
    evaluatedAt: "2026-02-01T00:00:00.000Z",
  };
}

function report() {
  return {
    evaluationVersion: 2,
    measurement: {
      scope: "product_all_warehouses",
      predictionScope: "historical_rate_with_optional_start_date_overlay",
      historicalPredictionScope: "historical_rate_only",
      horizons: [7, 30, 90],
      wapeUnit: "basis_points",
      quantityUnit: "base_piece",
      predictionPrecision: "micro_piece",
      overlayAttributionVersion: 1,
      overlayAttributionInterval: "[planningAsOfDate, planningAsOfDate + horizonDays)",
      overlayEligibility: "capture_version_2_and_capture_horizon_covers_evaluation_horizon",
    },
    summaries: [summary()],
    itemCount: 1,
    items: [excludedItem()],
  };
}

describe("forecast backtesting client contract", () => {
  it("accepts a coherent report and formats exact units", () => {
    expect(forecastBacktestReportSchema.parse(report()).itemCount).toBe(1);
    expect(formatWapeBasisPoints(1_234)).toBe("12.34%");
    expect(formatWapeImprovement(125)).toBe("+1.25 pp");
    expect(formatWapeImprovement(-25)).toBe("-0.25 pp");
    expect(formatMicrosAsPieces(1_250_000)).toBe("1.25");
    expect(formatEvaluationDate("2026-06-01T00:00:00.000Z")).toBe("6/1/2026");
    expect(formatOverlayExclusionReason("capture_horizon_insufficient")).toBe("Horizon not covered");
  });

  it("rejects report totals and overlay states that do not reconcile", () => {
    expect(() => forecastBacktestReportSchema.parse({
      ...report(),
      itemCount: 2,
    })).toThrow("item count");
    expect(() => forecastBacktestReportSchema.parse({
      ...report(),
      items: [{
        ...excludedItem(),
        overlayAdjustedForecastDemandMicros: 50_000_000,
      }],
    })).toThrow("contains scoring metrics");
    expect(() => forecastBacktestReportSchema.parse({
      ...report(),
      summaries: [{ ...summary(), overlayEvaluationCount: 2 }],
    })).toThrow("Overlay outcome counts");
  });

  it("rejects evaluation batch results whose counts do not reconcile", () => {
    expect(() => forecastBacktestEvaluationResultSchema.parse({
      evaluationVersion: 2,
      evaluatedAt: "2026-02-01T00:00:00.000Z",
      horizons: [7, 30, 90],
      limit: 5_000,
      candidateCount: 3,
      insertedCount: 1,
      concurrentReplayCount: 1,
      batchLimitReached: false,
      candidateCountsByHorizon: { "7": 1, "30": 1, "90": 1 },
      insertedCountsByHorizon: { "7": 1 },
      serializationRetryCount: 0,
    })).toThrow("do not reconcile");
  });
});
