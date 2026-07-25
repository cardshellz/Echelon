import { describe, expect, it, vi } from "vitest";
import { createPurchaseForecastBacktestingService } from "../../purchase-forecast-backtesting.service";
import { buildPurchasingForecastPolicyCohort } from "../../purchasing-forecast-policy";

const policyCohort = buildPurchasingForecastPolicyCohort();

function repository() {
  const repo: any = {
    loadPolicyCohorts: vi.fn(),
    loadMaturedCandidates: vi.fn(),
    insertEvaluations: vi.fn(),
    loadAggregates: vi.fn(),
    loadRecent: vi.fn(),
  };
  repo.inRepeatableReadTransaction = vi.fn(async (operation: (value: any) => unknown) => operation(repo));
  return repo;
}

describe("purchase forecast backtesting service", () => {
  it("evaluates mature observations atomically and reports concurrent idempotent replays", async () => {
    const repo = repository();
    repo.loadMaturedCandidates.mockResolvedValue([
      {
        observationId: 1,
        runId: 10,
        productId: 100,
        productSku: "SKU-100",
        productName: "Product 100",
        scope: "product_all_warehouses",
        forecastMethod: "weighted_blend_v1",
        forecastVersion: 2,
        horizonDays: 7,
        observedFrom: new Date("2026-01-01T00:00:00.000Z"),
        observedThroughExclusive: new Date("2026-01-08T00:00:00.000Z"),
        forecastDailyPiecesMicros: 2_000_000,
        baselineDailyPiecesMicros: 1_000_000,
        forwardDemandPieces: 0,
        forwardDemandRawPieces: 0,
        overlayCaptureVersion: 2,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: "2026-01-01",
        overlayHorizonDays: 90,
        overlayContributions: [],
        actualDemandPieces: 12,
        actualOrderCount: 3,
        actualActiveDays: 2,
        latestActualDemandAt: new Date("2026-01-07T00:00:00.000Z"),
      },
      {
        observationId: 2,
        runId: 10,
        productId: 101,
        productSku: "SKU-101",
        productName: "Product 101",
        scope: "product_all_warehouses",
        forecastMethod: "weighted_blend_v1",
        forecastVersion: 2,
        horizonDays: 30,
        observedFrom: new Date("2025-12-01T00:00:00.000Z"),
        observedThroughExclusive: new Date("2025-12-31T00:00:00.000Z"),
        forecastDailyPiecesMicros: 1_000_000,
        baselineDailyPiecesMicros: 1_000_000,
        forwardDemandPieces: 5,
        forwardDemandRawPieces: 5,
        overlayCaptureVersion: 1,
        overlayCaptureComplete: true,
        overlayPlanningAsOfDate: null,
        overlayHorizonDays: null,
        overlayContributions: [],
        actualDemandPieces: 30,
        actualOrderCount: 8,
        actualActiveDays: 7,
        latestActualDemandAt: new Date("2025-12-30T00:00:00.000Z"),
      },
    ]);
    repo.insertEvaluations.mockResolvedValue([{ id: 9, observationId: 1, horizonDays: 7 }]);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const service = createPurchaseForecastBacktestingService({ repository: repo, clock: () => now });

    const result = await service.evaluateMatured({ horizons: [30, 7, 7], limit: 25, actor: "buyer-1" });

    expect(repo.inRepeatableReadTransaction).toHaveBeenCalledTimes(1);
    expect(repo.loadMaturedCandidates).toHaveBeenCalledWith({
      asOf: now,
      horizons: [7, 30],
      evaluationVersion: 2,
      limit: 25,
    });
    expect(repo.insertEvaluations).toHaveBeenCalledWith([
      expect.objectContaining({ observationId: 1, horizonDays: 7, evaluatedBy: "buyer-1" }),
      expect.objectContaining({ observationId: 2, horizonDays: 30, evaluatedBy: "buyer-1" }),
    ]);
    expect(result).toMatchObject({
      candidateCount: 2,
      insertedCount: 1,
      concurrentReplayCount: 1,
      batchLimitReached: false,
      serializationRetryCount: 0,
      candidateCountsByHorizon: { "7": 1, "30": 1 },
      insertedCountsByHorizon: { "7": 1 },
    });
  });

  it("returns accuracy isolated to one canonical policy cohort and excludes legacy evidence", async () => {
    const repo = repository();
    repo.loadPolicyCohorts.mockResolvedValue([
      {
        captureVersion: 1,
        fingerprint: policyCohort.fingerprint,
        snapshot: policyCohort.snapshot,
        forecastMethod: "weighted_blend_v1",
        forecastVersion: 2,
        observationCount: 3,
        evaluationCount: 1,
        firstObservedFrom: new Date("2026-01-01T00:00:00.000Z"),
        latestObservedFrom: new Date("2026-01-03T00:00:00.000Z"),
        latestEvaluationAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        captureVersion: 0,
        fingerprint: null,
        snapshot: null,
        forecastMethod: null,
        forecastVersion: null,
        observationCount: 9,
        evaluationCount: 8,
        firstObservedFrom: new Date("2025-12-01T00:00:00.000Z"),
        latestObservedFrom: new Date("2025-12-31T00:00:00.000Z"),
        latestEvaluationAt: new Date("2026-01-08T00:00:00.000Z"),
      },
    ]);
    repo.loadAggregates.mockResolvedValue([{
      horizonDays: 7,
      evaluationCount: 1,
      actualDemandPieces: 10,
      forecastDemandMicros: 12_000_000,
      baselineDemandMicros: 15_000_000,
      forecastAbsoluteErrorMicros: 2_000_000,
      baselineAbsoluteErrorMicros: 5_000_000,
      forecastBiasMicros: 2_000_000,
      baselineBiasMicros: 5_000_000,
      forecastWinCount: 1,
      baselineWinCount: 0,
      tieCount: 0,
      zeroActualCount: 0,
      observationsWithForwardDemand: 1,
      overlayEvaluationCount: 1,
      overlayActualDemandPieces: 10,
      overlayRawDemandPieces: 5,
      overlayWeightedDemandPieces: 2,
      overlayCohortForecastAbsoluteErrorMicros: 2_000_000,
      overlayAdjustedForecastDemandMicros: 10_000_000,
      overlayAdjustedAbsoluteErrorMicros: 0,
      overlayAdjustedBiasMicros: 0,
      overlayWinCount: 1,
      historicalForecastWinCount: 0,
      overlayTieCount: 0,
      observationsWithAttributedOverlay: 1,
    }]);
    repo.loadRecent.mockResolvedValue([{
      id: 1,
      observationId: 2,
      runId: 3,
      productId: 4,
      productSku: "SKU-4",
      productName: "Product 4",
      horizonDays: 7,
      forecastMethod: "weighted_blend_v1",
      forecastVersion: 2,
      forecastPolicyCaptureVersion: 1,
      forecastPolicyFingerprint: policyCohort.fingerprint,
      evaluationVersion: 2,
      observedFrom: new Date("2026-01-01T00:00:00.000Z"),
      observedThroughExclusive: new Date("2026-01-08T00:00:00.000Z"),
      actualDemandPieces: 10,
      actualOrderCount: 2,
      actualActiveDays: 2,
      latestActualDemandAt: new Date("2026-01-07T00:00:00.000Z"),
      forecastDemandMicros: 12_000_000,
      baselineDemandMicros: 15_000_000,
      forecastAbsoluteErrorMicros: 2_000_000,
      baselineAbsoluteErrorMicros: 5_000_000,
      forecastBiasMicros: 2_000_000,
      baselineBiasMicros: 5_000_000,
      forwardDemandPieces: 4,
      forwardDemandRawPieces: 5,
      overlayCaptureVersion: 2,
      overlayCaptureComplete: true,
      overlayPlanningAsOfDate: "2026-01-01",
      overlayHorizonDays: 90,
      overlayAttributionVersion: 1,
      overlayEvaluable: true,
      overlayExclusionReason: null,
      overlayContributionCount: 1,
      overlayRawDemandPieces: 5,
      overlayWeightedDemandPieces: 2,
      overlayAdjustedForecastDemandMicros: 14_000_000,
      overlayAdjustedAbsoluteErrorMicros: 4_000_000,
      overlayAdjustedBiasMicros: 4_000_000,
      demandQueryVersion: "wms_order_items_product_v1",
      evaluatedBy: "system",
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    }]);
    const service = createPurchaseForecastBacktestingService({ repository: repo });

    const report = await service.getReport({ horizonDays: "7", limit: 10 });

    expect(repo.loadPolicyCohorts).toHaveBeenCalledWith({ evaluationVersion: 2, horizonDays: 7 });
    expect(repo.loadAggregates).toHaveBeenCalledWith({
      evaluationVersion: 2,
      horizonDays: 7,
      policyFingerprint: policyCohort.fingerprint,
      forecastMethod: "weighted_blend_v1",
      forecastVersion: 2,
    });
    expect(repo.loadRecent).toHaveBeenCalledWith({
      evaluationVersion: 2,
      horizonDays: 7,
      limit: 10,
      policyFingerprint: policyCohort.fingerprint,
      forecastMethod: "weighted_blend_v1",
      forecastVersion: 2,
    });
    expect(report.measurement).toMatchObject({
      scope: "product_all_warehouses",
      predictionScope: "historical_rate_with_optional_start_date_overlay",
      overlayAttributionVersion: 1,
    });
    expect(report.summaries[0]).toMatchObject({
      forecastPolicyCaptureVersion: 1,
      forecastPolicyFingerprint: policyCohort.fingerprint,
      forecastMethod: "weighted_blend_v1",
      forecastVersion: 2,
      forecastWapeBasisPoints: 2_000,
      baselineWapeBasisPoints: 5_000,
      forecastWapeImprovementBasisPoints: 3_000,
      overlayCohortForecastWapeBasisPoints: 2_000,
      overlayAdjustedWapeBasisPoints: 0,
      overlayWapeImprovementBasisPoints: 2_000,
    });
    expect(report.items[0]).toMatchObject({
      outcome: "forecast_wins",
      forecastErrorImprovementMicros: 3_000_000,
      forwardDemandOverlayIncluded: true,
      overlayOutcome: "historical_forecast_wins",
      overlayErrorImprovementMicros: -2_000_000,
      overlayExclusionReason: null,
    });
    expect(report.accuracyTrustAssessment).toEqual({
      status: "not_assessed",
      reason: "accuracy_thresholds_not_configured",
      selectedPolicyFingerprint: policyCohort.fingerprint,
      selectedForecastVersion: 2,
      cohortIsolated: true,
      selectedCohortEvaluationCount: 1,
      excludedLegacyEvaluationCount: 8,
      excludedOtherPolicyCohortEvaluationCount: 0,
    });
  });

  it("returns no accuracy metrics when only legacy observations exist", async () => {
    const repo = repository();
    repo.loadPolicyCohorts.mockResolvedValue([{
      captureVersion: 0,
      fingerprint: null,
      snapshot: null,
      forecastMethod: null,
      forecastVersion: null,
      observationCount: 5,
      evaluationCount: 4,
      firstObservedFrom: new Date("2025-12-01T00:00:00.000Z"),
      latestObservedFrom: new Date("2025-12-31T00:00:00.000Z"),
      latestEvaluationAt: new Date("2026-01-08T00:00:00.000Z"),
    }]);
    const service = createPurchaseForecastBacktestingService({ repository: repo });

    const report = await service.getReport({ horizonDays: 30 });

    expect(report.selectedPolicyCohort).toBeNull();
    expect(report.summaries).toEqual([]);
    expect(report.items).toEqual([]);
    expect(report.accuracyTrustAssessment).toMatchObject({
      status: "not_assessed",
      reason: "no_captured_policy_cohort",
      cohortIsolated: false,
      excludedLegacyEvaluationCount: 4,
    });
    expect(repo.loadAggregates).not.toHaveBeenCalled();
    expect(repo.loadRecent).not.toHaveBeenCalled();
  });

  it("selects one exact forecast version when policy settings share a fingerprint", async () => {
    const repo = repository();
    const cohortEvidence = (forecastVersion: number, evaluationCount: number) => ({
      captureVersion: 1 as const,
      fingerprint: policyCohort.fingerprint,
      snapshot: policyCohort.snapshot,
      forecastMethod: "weighted_blend_v1",
      forecastVersion,
      observationCount: 2,
      evaluationCount,
      firstObservedFrom: new Date("2026-01-01T00:00:00.000Z"),
      latestObservedFrom: new Date("2026-01-10T00:00:00.000Z"),
      latestEvaluationAt: new Date("2026-01-18T00:00:00.000Z"),
    });
    repo.loadPolicyCohorts.mockResolvedValue([
      cohortEvidence(3, 2),
      cohortEvidence(2, 1),
    ]);
    repo.loadAggregates.mockResolvedValue([]);
    repo.loadRecent.mockResolvedValue([]);
    const service = createPurchaseForecastBacktestingService({ repository: repo });

    const report = await service.getReport({
      forecastPolicyFingerprint: policyCohort.fingerprint,
      forecastVersion: 2,
    });

    expect(report.selectedPolicyCohort?.forecastVersion).toBe(2);
    expect(repo.loadAggregates).toHaveBeenCalledWith(expect.objectContaining({
      policyFingerprint: policyCohort.fingerprint,
      forecastVersion: 2,
    }));
    expect(report.accuracyTrustAssessment).toMatchObject({
      selectedForecastVersion: 2,
      selectedCohortEvaluationCount: 1,
      excludedOtherPolicyCohortEvaluationCount: 2,
    });
  });

  it("rejects unsupported horizons and limits before repository access", async () => {
    const repo = repository();
    const service = createPurchaseForecastBacktestingService({ repository: repo });

    await expect(service.evaluateMatured({ horizons: [14] })).rejects.toThrow("only 7, 30, or 90");
    await expect(service.getReport({ limit: 501 })).rejects.toThrow("between 1 and 500");
    await expect(service.getReport({ forecastPolicyFingerprint: "not-a-fingerprint" }))
      .rejects.toThrow("lowercase SHA-256");
    await expect(service.getReport({ forecastPolicyFingerprint: "a".repeat(64) }))
      .rejects.toThrow("must be provided together");
    expect(repo.inRepeatableReadTransaction).not.toHaveBeenCalled();
  });

  it("retries a repeatable-read serialization race with the same frozen as-of", async () => {
    const repo = repository();
    const serializationError = Object.assign(new Error("serialization failure"), { code: "40001" });
    repo.inRepeatableReadTransaction
      .mockRejectedValueOnce(serializationError)
      .mockImplementationOnce(async (operation: (value: any) => unknown) => operation(repo));
    repo.loadMaturedCandidates.mockResolvedValue([]);
    repo.insertEvaluations.mockResolvedValue([]);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const service = createPurchaseForecastBacktestingService({ repository: repo, clock: () => now });

    const result = await service.evaluateMatured();

    expect(repo.inRepeatableReadTransaction).toHaveBeenCalledTimes(2);
    expect(repo.loadMaturedCandidates).toHaveBeenCalledWith(expect.objectContaining({ asOf: now }));
    expect(result.serializationRetryCount).toBe(1);
  });
});
