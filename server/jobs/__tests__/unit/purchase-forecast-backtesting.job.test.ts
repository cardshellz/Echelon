import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPurchaseForecastBacktestingJob } from "../../purchase-forecast-backtesting.job";

const AS_OF = new Date("2026-07-26T05:30:00.000Z");

function evaluationBatch(input: {
  insertedCount: number;
  batchLimitReached: boolean;
}) {
  return {
    evaluationVersion: 2,
    evaluatedAt: AS_OF,
    horizons: [7, 30, 90],
    limit: 500,
    candidateCount: input.insertedCount,
    insertedCount: input.insertedCount,
    concurrentReplayCount: 0,
    batchLimitReached: input.batchLimitReached,
    candidateCountsByHorizon: { 7: input.insertedCount, 30: 0, 90: 0 },
    insertedCountsByHorizon: { 7: input.insertedCount, 30: 0, 90: 0 },
    serializationRetryCount: 0,
  };
}

describe("scheduled purchase forecast backtesting job", () => {
  const service = { evaluateMatured: vi.fn() };
  const jobLifecycle = {
    startRun: vi.fn(),
    heartbeatRun: vi.fn(),
    completeRun: vi.fn(),
    failRun: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    jobLifecycle.startRun.mockResolvedValue({
      run: { id: 801 },
      interruptedRunIds: [],
    });
    jobLifecycle.heartbeatRun.mockResolvedValue({ id: 801, status: "running" });
    jobLifecycle.completeRun.mockResolvedValue({ id: 801, status: "succeeded" });
    jobLifecycle.failRun.mockResolvedValue({ run: { id: 801 }, transitioned: true });
  });

  it("records a successful no-op evaluation as durable execution evidence", async () => {
    service.evaluateMatured.mockResolvedValue(evaluationBatch({
      insertedCount: 0,
      batchLimitReached: false,
    }));

    const result = await runPurchaseForecastBacktestingJob({
      asOf: AS_OF,
      maxBatches: 10,
      service: service as any,
      jobLifecycle: jobLifecycle as any,
    });

    expect(jobLifecycle.startRun).toHaveBeenCalledWith({
      jobType: "forecast_evaluation",
      triggerType: "scheduled",
      asOf: AS_OF,
    });
    expect(result).toMatchObject({
      jobRunId: 801,
      asOf: "2026-07-26T05:30:00.000Z",
      batchCount: 1,
      insertedCount: 0,
      backlogMayRemain: false,
    });
    expect(jobLifecycle.heartbeatRun).toHaveBeenCalledWith({ runId: 801 });
    expect(jobLifecycle.completeRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 801,
      completion: expect.objectContaining({
        jobType: "forecast_evaluation",
        evaluationInsertedCount: 0,
        evaluationBatchCount: 1,
        evaluationBacklogMayRemain: false,
      }),
    }));
  });

  it("drains multiple batches and records their exact aggregate", async () => {
    service.evaluateMatured
      .mockResolvedValueOnce(evaluationBatch({ insertedCount: 5, batchLimitReached: true }))
      .mockResolvedValueOnce(evaluationBatch({ insertedCount: 2, batchLimitReached: false }));

    const result = await runPurchaseForecastBacktestingJob({
      asOf: AS_OF,
      limit: 5,
      maxBatches: 10,
      service: service as any,
      jobLifecycle: jobLifecycle as any,
    });

    expect(result).toMatchObject({
      batchCount: 2,
      insertedCount: 7,
      backlogMayRemain: false,
    });
    expect(jobLifecycle.heartbeatRun).toHaveBeenCalledTimes(2);
    expect(jobLifecycle.completeRun).toHaveBeenCalledWith(expect.objectContaining({
      completion: expect.objectContaining({
        evaluationInsertedCount: 7,
        evaluationBatchCount: 2,
      }),
    }));
  });

  it("marks possible backlog when every allowed batch reaches the limit", async () => {
    service.evaluateMatured.mockResolvedValue(
      evaluationBatch({ insertedCount: 5, batchLimitReached: true }),
    );

    const result = await runPurchaseForecastBacktestingJob({
      asOf: AS_OF,
      limit: 5,
      maxBatches: 2,
      service: service as any,
      jobLifecycle: jobLifecycle as any,
    });

    expect(result).toMatchObject({
      batchCount: 2,
      insertedCount: 10,
      backlogMayRemain: true,
    });
  });

  it("records partial batch progress before preserving the evaluator error", async () => {
    const error = Object.assign(new Error("database token=secret-value unavailable"), {
      code: "DATABASE_DOWN",
    });
    service.evaluateMatured
      .mockResolvedValueOnce(evaluationBatch({ insertedCount: 5, batchLimitReached: true }))
      .mockRejectedValueOnce(error);

    await expect(runPurchaseForecastBacktestingJob({
      asOf: AS_OF,
      limit: 5,
      maxBatches: 10,
      service: service as any,
      jobLifecycle: jobLifecycle as any,
    })).rejects.toBe(error);

    expect(jobLifecycle.failRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 801,
      errorCode: "DATABASE_DOWN",
      errorMessage: "database token=[REDACTED] unavailable",
      evaluationInsertedCount: 5,
      evaluationBatchCount: 1,
      evaluationBacklogMayRemain: true,
    }));
    expect(jobLifecycle.completeRun).not.toHaveBeenCalled();
  });

  it("validates bounds before claiming a job run", async () => {
    await expect(runPurchaseForecastBacktestingJob({
      asOf: AS_OF,
      maxBatches: 0,
      service: service as any,
      jobLifecycle: jobLifecycle as any,
    })).rejects.toThrow("maxBatches must be an integer between 1 and 100");

    expect(jobLifecycle.startRun).not.toHaveBeenCalled();
    expect(service.evaluateMatured).not.toHaveBeenCalled();
  });
});
