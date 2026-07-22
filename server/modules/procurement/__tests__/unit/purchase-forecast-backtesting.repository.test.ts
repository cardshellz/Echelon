import { describe, expect, it, vi } from "vitest";
import { createPurchaseForecastBacktestingRepository } from "../../purchase-forecast-backtesting.repository";

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
      evaluationVersion: 1,
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
      evaluationVersion: 1,
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
      evidenceSnapshot: {},
      evaluatedBy: "system",
      evaluatedAt: new Date("2026-01-09T00:00:00.000Z"),
    };

    const rows = await repository.insertEvaluations([input]);

    expect(values).toHaveBeenCalledWith([input]);
    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: expect.any(Array) });
    expect(rows).toEqual([{ id: 1, observationId: 2, horizonDays: 7 }]);
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
