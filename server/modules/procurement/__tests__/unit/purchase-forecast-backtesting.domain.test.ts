import { describe, expect, it } from "vitest";
import {
  buildPurchaseForecastEvaluation,
  buildPurchaseForecastEvaluationSummaries,
  buildPurchaseForecastEvaluationSummariesFromAggregates,
  PIECE_MICRO_SCALE,
  type PurchaseForecastEvaluationCandidate,
} from "../../purchase-forecast-backtesting.domain";

function candidate(overrides: Partial<PurchaseForecastEvaluationCandidate> = {}): PurchaseForecastEvaluationCandidate {
  return {
    observationId: 11,
    runId: 7,
    productId: 3,
    productSku: "SKU-3",
    productName: "Product 3",
    scope: "product_all_warehouses",
    forecastMethod: "weighted_blend_v1",
    forecastVersion: 2,
    horizonDays: 7,
    observedFrom: new Date("2026-01-01T00:00:00.000Z"),
    observedThroughExclusive: new Date("2026-01-08T00:00:00.000Z"),
    forecastDailyPiecesMicros: 2_000_000,
    baselineDailyPiecesMicros: 1_000_000,
    forwardDemandPieces: 20,
    forwardDemandRawPieces: 25,
    overlayCaptureVersion: 0,
    overlayCaptureComplete: false,
    overlayPlanningAsOfDate: null,
    overlayHorizonDays: null,
    overlayContributions: [],
    actualDemandPieces: 10,
    actualOrderCount: 4,
    actualActiveDays: 3,
    latestActualDemandAt: new Date("2026-01-07T12:00:00.000Z"),
    ...overrides,
  };
}

describe("purchase forecast backtesting domain", () => {
  it("builds deterministic micro-piece errors without including aggregate overlays", () => {
    const result = buildPurchaseForecastEvaluation({
      candidate: candidate(),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
      evaluatedBy: "buyer-1",
    });

    expect(result).toMatchObject({
      observationId: 11,
      horizonDays: 7,
      evaluationVersion: 2,
      actualDemandPieces: 10,
      forecastDemandMicros: 14_000_000,
      baselineDemandMicros: 7_000_000,
      forecastAbsoluteErrorMicros: 4_000_000,
      baselineAbsoluteErrorMicros: 3_000_000,
      forecastBiasMicros: 4_000_000,
      baselineBiasMicros: -3_000_000,
      evaluatedBy: "buyer-1",
    });
    expect(result.evidenceSnapshot).toMatchObject({
      predictionScope: "historical_rate_only",
      forwardDemandOverlayIncluded: false,
      forwardDemandPieces: 20,
      forwardDemandRawPieces: 25,
      overlayEvaluation: {
        evaluable: false,
        exclusionReason: "capture_incomplete",
      },
    });
  });

  it("attributes weighted demand by event start date using an exclusive horizon end", () => {
    const result = buildPurchaseForecastEvaluation({
      candidate: candidate({
        forwardDemandPieces: 11,
        forwardDemandRawPieces: 14,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-01-01",
        overlayHorizonDays: 90,
        overlayContributions: [
          {
            demandEventId: 1,
            demandEventLineId: 11,
            eventStartDate: "2026-01-03",
            planningAsOfDate: "2026-01-01",
            expectedPieces: 5,
            weightedPieces: 4,
          },
          {
            demandEventId: 2,
            demandEventLineId: 12,
            eventStartDate: "2026-01-08",
            planningAsOfDate: "2026-01-01",
            expectedPieces: 6,
            weightedPieces: 5,
          },
          {
            demandEventId: 3,
            demandEventLineId: 13,
            eventStartDate: "2025-12-31",
            planningAsOfDate: "2026-01-01",
            expectedPieces: 3,
            weightedPieces: 2,
          },
        ],
      }),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      overlayAttributionVersion: 1,
      overlayEvaluable: true,
      overlayExclusionReason: null,
      overlayContributionCount: 1,
      overlayRawDemandPieces: 5,
      overlayWeightedDemandPieces: 4,
      overlayAdjustedForecastDemandMicros: 18_000_000,
      overlayAdjustedAbsoluteErrorMicros: 8_000_000,
      overlayAdjustedBiasMicros: 8_000_000,
    });
  });

  it("excludes overlay scoring when the captured planning date differs from the forecast window", () => {
    const result = buildPurchaseForecastEvaluation({
      candidate: candidate({
        forwardDemandPieces: 0,
        forwardDemandRawPieces: 0,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2025-12-31",
        overlayHorizonDays: 90,
        overlayContributions: [],
      }),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      overlayEvaluable: false,
      overlayExclusionReason: "capture_planning_date_mismatch",
      overlayAdjustedForecastDemandMicros: null,
    });
    expect(result.evidenceSnapshot).toMatchObject({
      overlayEvaluation: { exclusionReason: "capture_planning_date_mismatch" },
    });
  });

  it("rejects contribution evidence that does not reconcile to the immutable observation", () => {
    expect(() => buildPurchaseForecastEvaluation({
      candidate: candidate({
        forwardDemandPieces: 5,
        forwardDemandRawPieces: 7,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-01-01",
        overlayHorizonDays: 90,
        overlayContributions: [{
          demandEventId: 1,
          demandEventLineId: 11,
          eventStartDate: "2026-01-03",
          planningAsOfDate: "2026-01-01",
          expectedPieces: 6,
          weightedPieces: 5,
        }],
      }),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    })).toThrow("totals do not match");
  });

  it("rejects contribution evidence outside the captured planning horizon", () => {
    expect(() => buildPurchaseForecastEvaluation({
      candidate: candidate({
        forwardDemandPieces: 5,
        forwardDemandRawPieces: 6,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-01-01",
        overlayHorizonDays: 30,
        overlayContributions: [{
          demandEventId: 1,
          demandEventLineId: 11,
          eventStartDate: "2026-02-01",
          planningAsOfDate: "2026-01-01",
          expectedPieces: 6,
          weightedPieces: 5,
        }],
      }),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    })).toThrow("falls outside capture coverage");
  });

  it("does not score overlays when immutable capture coverage is shorter than the evaluation horizon", () => {
    const result = buildPurchaseForecastEvaluation({
      candidate: candidate({
        horizonDays: 90,
        observedThroughExclusive: new Date("2026-04-01T00:00:00.000Z"),
        forwardDemandPieces: 0,
        forwardDemandRawPieces: 0,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-01-01",
        overlayHorizonDays: 30,
        overlayContributions: [],
      }),
      evaluatedAt: new Date("2026-04-02T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      overlayAttributionVersion: 0,
      overlayEvaluable: false,
      overlayAdjustedForecastDemandMicros: null,
    });
    expect(result.evidenceSnapshot).toMatchObject({
      overlayEvaluation: { exclusionReason: "capture_horizon_insufficient" },
    });
  });

  it("rejects immature horizons and unsafe arithmetic", () => {
    expect(() => buildPurchaseForecastEvaluation({
      candidate: candidate(),
      evaluatedAt: new Date("2026-01-07T23:59:59.999Z"),
    })).toThrow("has not matured");

    expect(() => buildPurchaseForecastEvaluation({
      candidate: candidate({ forecastDailyPiecesMicros: Number.MAX_SAFE_INTEGER }),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    })).toThrow("forecastDemandMicros exceeds");
  });

  it("keeps zero-actual WAPE undefined while retaining absolute error", () => {
    const evaluation = buildPurchaseForecastEvaluation({
      candidate: candidate({ actualDemandPieces: 0, actualOrderCount: 0, actualActiveDays: 0, latestActualDemandAt: null }),
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    });
    const summaries = buildPurchaseForecastEvaluationSummaries([{
      horizonDays: evaluation.horizonDays,
      actualDemandPieces: evaluation.actualDemandPieces,
      forecastDemandMicros: evaluation.forecastDemandMicros,
      baselineDemandMicros: evaluation.baselineDemandMicros,
      forecastAbsoluteErrorMicros: evaluation.forecastAbsoluteErrorMicros,
      baselineAbsoluteErrorMicros: evaluation.baselineAbsoluteErrorMicros,
      forecastBiasMicros: evaluation.forecastBiasMicros,
      baselineBiasMicros: evaluation.baselineBiasMicros,
      forwardDemandPieces: 20,
      overlayEvaluable: false,
      overlayRawDemandPieces: null,
      overlayWeightedDemandPieces: null,
      overlayAdjustedForecastDemandMicros: null,
      overlayAdjustedAbsoluteErrorMicros: null,
      overlayAdjustedBiasMicros: null,
    }]);

    expect(summaries[0]).toMatchObject({
      actualDemandPieces: 0,
      forecastWapeBasisPoints: null,
      baselineWapeBasisPoints: null,
      forecastWapeImprovementBasisPoints: null,
      zeroActualCount: 1,
      observationsWithForwardDemand: 1,
    });
  });

  it("calculates aggregate WAPE, signed bias, and model wins in basis points", () => {
    const summaries = buildPurchaseForecastEvaluationSummaries([
      {
        horizonDays: 30,
        actualDemandPieces: 100,
        forecastDemandMicros: 90 * PIECE_MICRO_SCALE,
        baselineDemandMicros: 80 * PIECE_MICRO_SCALE,
        forecastAbsoluteErrorMicros: 10 * PIECE_MICRO_SCALE,
        baselineAbsoluteErrorMicros: 20 * PIECE_MICRO_SCALE,
        forecastBiasMicros: -10 * PIECE_MICRO_SCALE,
        baselineBiasMicros: -20 * PIECE_MICRO_SCALE,
        forwardDemandPieces: 0,
        overlayEvaluable: true,
        overlayRawDemandPieces: 12,
        overlayWeightedDemandPieces: 10,
        overlayAdjustedForecastDemandMicros: 100 * PIECE_MICRO_SCALE,
        overlayAdjustedAbsoluteErrorMicros: 0,
        overlayAdjustedBiasMicros: 0,
      },
      {
        horizonDays: 30,
        actualDemandPieces: 50,
        forecastDemandMicros: 60 * PIECE_MICRO_SCALE,
        baselineDemandMicros: 55 * PIECE_MICRO_SCALE,
        forecastAbsoluteErrorMicros: 10 * PIECE_MICRO_SCALE,
        baselineAbsoluteErrorMicros: 5 * PIECE_MICRO_SCALE,
        forecastBiasMicros: 10 * PIECE_MICRO_SCALE,
        baselineBiasMicros: 5 * PIECE_MICRO_SCALE,
        forwardDemandPieces: 5,
        overlayEvaluable: false,
        overlayRawDemandPieces: null,
        overlayWeightedDemandPieces: null,
        overlayAdjustedForecastDemandMicros: null,
        overlayAdjustedAbsoluteErrorMicros: null,
        overlayAdjustedBiasMicros: null,
      },
    ]);

    expect(summaries).toEqual([expect.objectContaining({
      horizonDays: 30,
      evaluationCount: 2,
      actualDemandPieces: 150,
      forecastWapeBasisPoints: 1_333,
      baselineWapeBasisPoints: 1_667,
      forecastWapeImprovementBasisPoints: 334,
      forecastBiasMicros: 0,
      baselineBiasMicros: -15 * PIECE_MICRO_SCALE,
      forecastWinCount: 1,
      baselineWinCount: 1,
      tieCount: 0,
      observationsWithForwardDemand: 1,
      overlayEvaluationCount: 1,
      overlayCohortForecastWapeBasisPoints: 1_000,
      overlayAdjustedWapeBasisPoints: 0,
      overlayWapeImprovementBasisPoints: 1_000,
      overlayWinCount: 1,
      historicalForecastWinCount: 0,
      overlayTieCount: 0,
      observationsWithAttributedOverlay: 1,
    })]);
  });

  it("validates aggregate outcome counts before reporting", () => {
    expect(() => buildPurchaseForecastEvaluationSummariesFromAggregates([{
      horizonDays: 7,
      evaluationCount: 2,
      actualDemandPieces: 10,
      forecastDemandMicros: 10_000_000,
      baselineDemandMicros: 10_000_000,
      forecastAbsoluteErrorMicros: 0,
      baselineAbsoluteErrorMicros: 0,
      forecastBiasMicros: 0,
      baselineBiasMicros: 0,
      forecastWinCount: 0,
      baselineWinCount: 0,
      tieCount: 1,
      zeroActualCount: 0,
      observationsWithForwardDemand: 0,
      overlayEvaluationCount: 0,
      overlayActualDemandPieces: 0,
      overlayRawDemandPieces: 0,
      overlayWeightedDemandPieces: 0,
      overlayCohortForecastAbsoluteErrorMicros: 0,
      overlayAdjustedForecastDemandMicros: 0,
      overlayAdjustedAbsoluteErrorMicros: 0,
      overlayAdjustedBiasMicros: 0,
      overlayWinCount: 0,
      historicalForecastWinCount: 0,
      overlayTieCount: 0,
      observationsWithAttributedOverlay: 0,
    }])).toThrow("outcome counts do not match");
  });

  it("rejects aggregate subset counts larger than the evaluation cohort", () => {
    expect(() => buildPurchaseForecastEvaluationSummariesFromAggregates([{
      horizonDays: 7,
      evaluationCount: 1,
      actualDemandPieces: 10,
      forecastDemandMicros: 10_000_000,
      baselineDemandMicros: 10_000_000,
      forecastAbsoluteErrorMicros: 0,
      baselineAbsoluteErrorMicros: 0,
      forecastBiasMicros: 0,
      baselineBiasMicros: 0,
      forecastWinCount: 0,
      baselineWinCount: 0,
      tieCount: 1,
      zeroActualCount: 0,
      observationsWithForwardDemand: 2,
      overlayEvaluationCount: 0,
      overlayActualDemandPieces: 0,
      overlayRawDemandPieces: 0,
      overlayWeightedDemandPieces: 0,
      overlayCohortForecastAbsoluteErrorMicros: 0,
      overlayAdjustedForecastDemandMicros: 0,
      overlayAdjustedAbsoluteErrorMicros: 0,
      overlayAdjustedBiasMicros: 0,
      overlayWinCount: 0,
      historicalForecastWinCount: 0,
      overlayTieCount: 0,
      observationsWithAttributedOverlay: 0,
    }])).toThrow("subset counts cannot exceed");
  });
});
