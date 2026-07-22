import { describe, expect, it, vi } from "vitest";
import { createPurchaseForecastBacktestingService } from "../../purchase-forecast-backtesting.service";

function repository() {
  const repo: any = {
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
      evaluationVersion: 1,
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

  it("returns aggregate accuracy and recent evidence without including overlays", async () => {
    const repo = repository();
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
      evaluationVersion: 1,
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
      demandQueryVersion: "wms_order_items_product_v1",
      evaluatedBy: "system",
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    }]);
    const service = createPurchaseForecastBacktestingService({ repository: repo });

    const report = await service.getReport({ horizonDays: "7", limit: 10 });

    expect(repo.loadAggregates).toHaveBeenCalledWith({ evaluationVersion: 1, horizonDays: 7 });
    expect(report.measurement).toMatchObject({
      scope: "product_all_warehouses",
      predictionScope: "historical_rate_only",
      forwardDemandOverlayIncluded: false,
    });
    expect(report.summaries[0]).toMatchObject({
      forecastWapeBasisPoints: 2_000,
      baselineWapeBasisPoints: 5_000,
      forecastWapeImprovementBasisPoints: 3_000,
    });
    expect(report.items[0]).toMatchObject({
      outcome: "forecast_wins",
      forecastErrorImprovementMicros: 3_000_000,
      forwardDemandOverlayIncluded: false,
    });
  });

  it("rejects unsupported horizons and limits before repository access", async () => {
    const repo = repository();
    const service = createPurchaseForecastBacktestingService({ repository: repo });

    await expect(service.evaluateMatured({ horizons: [14] })).rejects.toThrow("only 7, 30, or 90");
    await expect(service.getReport({ limit: 501 })).rejects.toThrow("between 1 and 500");
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
