import { describe, expect, it, vi } from "vitest";
import { createPurchaseForecastBacktestingRepository } from "../../purchase-forecast-backtesting.repository";

function reportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "1",
    observation_id: "2",
    run_id: "3",
    product_id: "4",
    product_sku: "SKU-4",
    product_name: "Product 4",
    horizon_days: "7",
    forecast_method: "weighted_blend_v1",
    forecast_version: "2",
    evaluation_version: "2",
    observed_from: "2026-01-01T00:00:00.000Z",
    observed_through_exclusive: "2026-01-08T00:00:00.000Z",
    actual_demand_pieces: "10",
    actual_order_count: "2",
    actual_active_days: "2",
    latest_actual_demand_at: "2026-01-07T00:00:00.000Z",
    forecast_demand_micros: "12000000",
    baseline_demand_micros: "15000000",
    forecast_absolute_error_micros: "2000000",
    baseline_absolute_error_micros: "5000000",
    forecast_bias_micros: "2000000",
    baseline_bias_micros: "5000000",
    forward_demand_pieces: "4",
    forward_demand_raw_pieces: "5",
    overlay_capture_version: "0",
    overlay_capture_complete: false,
    overlay_planning_as_of_date: null,
    overlay_horizon_days: null,
    overlay_attribution_version: "0",
    overlay_evaluable: false,
    overlay_exclusion_reason: "capture_incomplete",
    overlay_contribution_count: null,
    overlay_raw_demand_pieces: null,
    overlay_weighted_demand_pieces: null,
    overlay_adjusted_forecast_demand_micros: null,
    overlay_adjusted_absolute_error_micros: null,
    overlay_adjusted_bias_micros: null,
    demand_query_version: "wms_order_items_product_v1",
    evaluated_by: "system",
    evaluated_at: "2026-01-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("purchase forecast backtesting repository", () => {
  it("maps exact database values for mature actual-demand candidates", async () => {
    const database = {
      execute: vi.fn().mockResolvedValue({ rows: [{
        observation_id: "1",
        run_id: "2",
        product_id: "3",
        product_sku: "SKU-3",
        product_name: "Product 3",
        scope: "product_all_warehouses",
        forecast_method: "weighted_blend_v1",
        forecast_version: "2",
        horizon_days: "7",
        observed_from: "2026-01-01T00:00:00.000Z",
        observed_through_exclusive: "2026-01-08T00:00:00.000Z",
        forecast_daily_pieces_micros: "1500000",
        baseline_daily_pieces_micros: "1000000",
        forward_demand_pieces: "4",
        forward_demand_raw_pieces: "5",
        overlay_capture_version: "2",
        overlay_capture_complete: true,
        overlay_planning_as_of_date: "2026-01-01",
        overlay_horizon_days: "90",
        overlay_contributions: [{
          demandEventId: 8,
          demandEventLineId: 9,
          eventStartDate: "2026-01-05",
          planningAsOfDate: "2026-01-01",
          expectedPieces: 5,
          weightedPieces: 4,
        }],
        actual_demand_pieces: "12",
        actual_order_count: "3",
        actual_active_days: "2",
        latest_actual_demand_at: "2026-01-07T00:00:00.000Z",
      }] }),
    };
    const repository = createPurchaseForecastBacktestingRepository(database);

    const rows = await repository.loadMaturedCandidates({
      asOf: new Date("2026-01-09T00:00:00.000Z"),
      horizons: [7],
      evaluationVersion: 2,
      limit: 10,
    });

    expect(rows).toEqual([expect.objectContaining({
      observationId: 1,
      runId: 2,
      productId: 3,
      horizonDays: 7,
      forecastDailyPiecesMicros: 1_500_000,
      actualDemandPieces: 12,
      actualOrderCount: 3,
      actualActiveDays: 2,
      latestActualDemandAt: new Date("2026-01-07T00:00:00.000Z"),
      overlayCaptureVersion: 2,
      overlayCaptureComplete: true,
      overlayPlanningAsOfDate: "2026-01-01",
      overlayHorizonDays: 90,
      overlayContributions: [expect.objectContaining({ demandEventLineId: 9, weightedPieces: 4 })],
    })]);
  });

  it("uses the composite idempotency target when inserting evaluations", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 1, observationId: 2, horizonDays: 7 }]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });
    const repository = createPurchaseForecastBacktestingRepository({ insert });
    const input: any = {
      observationId: 2,
      horizonDays: 7,
      evaluationVersion: 2,
      demandQueryVersion: "wms_order_items_product_v1",
      observedFrom: new Date("2026-01-01T00:00:00.000Z"),
      observedThroughExclusive: new Date("2026-01-08T00:00:00.000Z"),
      actualDemandPieces: 1,
      actualOrderCount: 1,
      actualActiveDays: 1,
      latestActualDemandAt: new Date("2026-01-02T00:00:00.000Z"),
      forecastDemandMicros: 1_000_000,
      baselineDemandMicros: 1_000_000,
      forecastAbsoluteErrorMicros: 0,
      baselineAbsoluteErrorMicros: 0,
      forecastBiasMicros: 0,
      baselineBiasMicros: 0,
      overlayAttributionVersion: 1,
      overlayEvaluable: true,
      overlayExclusionReason: null,
      overlayContributionCount: 0,
      overlayRawDemandPieces: 0,
      overlayWeightedDemandPieces: 0,
      overlayAdjustedForecastDemandMicros: 1_000_000,
      overlayAdjustedAbsoluteErrorMicros: 0,
      overlayAdjustedBiasMicros: 0,
      evidenceSnapshot: {},
      evaluatedBy: "system",
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    };

    const rows = await repository.insertEvaluations([input]);

    expect(values).toHaveBeenCalledWith([input]);
    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: expect.any(Array) });
    expect(rows).toEqual([{ id: 1, observationId: 2, horizonDays: 7 }]);
  });

  it("maps the persisted overlay exclusion reason in recent reports", async () => {
    const repository = createPurchaseForecastBacktestingRepository({
      execute: vi.fn().mockResolvedValue({ rows: [reportRow()] }),
    });

    const rows = await repository.loadRecent({
      evaluationVersion: 2,
      horizonDays: 7,
      limit: 10,
    });

    expect(rows).toEqual([expect.objectContaining({
      overlayEvaluable: false,
      overlayExclusionReason: "capture_incomplete",
      overlayContributionCount: null,
      overlayAdjustedForecastDemandMicros: null,
    })]);
  });

  it("rejects incoherent overlay report rows at the repository boundary", async () => {
    const repository = createPurchaseForecastBacktestingRepository({
      execute: vi.fn().mockResolvedValue({
        rows: [reportRow({ overlay_exclusion_reason: null })],
      }),
    });

    await expect(repository.loadRecent({
      evaluationVersion: 2,
      horizonDays: 7,
      limit: 10,
    })).rejects.toThrow("Non-evaluable forecast report row");
  });

  it("opens a repeatable-read transaction and binds repository operations to it", async () => {
    const transactionExecutor = { execute: vi.fn() };
    const database = {
      transaction: vi.fn(async (operation: (executor: any) => unknown, config: unknown) => ({
        value: await operation(transactionExecutor),
        config,
      })),
    };
    const repository = createPurchaseForecastBacktestingRepository(database);

    const result = await repository.inRepeatableReadTransaction(async (transactionRepository) => {
      expect(transactionRepository).not.toBe(repository);
      return "ok";
    });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ value: "ok", config: { isolationLevel: "repeatable read" } });
  });
});
