import { db } from "../db";
import { createPurchaseForecastBacktestingService } from "../modules/procurement/purchase-forecast-backtesting.service";
import { purchasePipelineJobRunLifecycleRepository } from "../modules/procurement/purchase-pipeline-job-run-lifecycle.repository";
import {
  createPurchasePipelineJobRunLifecycleService,
  sanitizePurchasePipelineJobError,
  type PurchasePipelineJobRunLifecycleService,
} from "../modules/procurement/purchase-pipeline-job-run-lifecycle.service";

type ForecastBacktestingService = Pick<
  ReturnType<typeof createPurchaseForecastBacktestingService>,
  "evaluateMatured"
>;

const defaultJobLifecycle = createPurchasePipelineJobRunLifecycleService(
  purchasePipelineJobRunLifecycleRepository,
);

function validDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
  return new Date(value.getTime());
}

function boundedPositiveInteger(
  value: number,
  field: string,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${field} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export async function runPurchaseForecastBacktestingJob(options: {
  asOf?: Date;
  limit?: number;
  maxBatches?: number;
  actor?: string;
  service?: ForecastBacktestingService;
  jobLifecycle?: PurchasePipelineJobRunLifecycleService;
} = {}) {
  const asOf = validDate(options.asOf ?? new Date(), "asOf");
  const limit = options.limit === undefined
    ? undefined
    : boundedPositiveInteger(options.limit, "limit", 5_000);
  const maxBatches = boundedPositiveInteger(options.maxBatches ?? 10, "maxBatches", 100);
  const actor = options.actor?.trim() || "system:purchase-forecast-backtesting";
  const service = options.service ?? createPurchaseForecastBacktestingService({ database: db });
  const jobLifecycle = options.jobLifecycle ?? defaultJobLifecycle;
  const jobRun = await jobLifecycle.startRun({
    jobType: "forecast_evaluation",
    triggerType: "scheduled",
    asOf,
  });
  const batches: Array<Awaited<ReturnType<ForecastBacktestingService["evaluateMatured"]>> & {
    batchNumber: number;
  }> = [];

  try {
    for (let batchNumber = 1; batchNumber <= maxBatches; batchNumber += 1) {
      const result = await service.evaluateMatured({ asOf, limit, actor });
      batches.push({ batchNumber, ...result });
      await jobLifecycle.heartbeatRun({ runId: jobRun.run.id });
      if (!result.batchLimitReached) break;
    }
    const insertedCount = batches.reduce((sum, batch) => sum + batch.insertedCount, 0);
    const backlogMayRemain = batches.length === maxBatches
      && Boolean(batches[batches.length - 1]?.batchLimitReached);
    const result = {
      jobRunId: jobRun.run.id,
      asOf: asOf.toISOString(),
      maxBatches,
      batchCount: batches.length,
      insertedCount,
      backlogMayRemain,
      batches,
    };
    await jobLifecycle.completeRun({
      runId: jobRun.run.id,
      completion: {
        jobType: "forecast_evaluation",
        evaluationInsertedCount: insertedCount,
        evaluationBatchCount: batches.length,
        evaluationBacklogMayRemain: backlogMayRemain,
        resultJson: {
          asOf: result.asOf,
          maxBatches,
          batches,
        },
      },
    });
    return result;
  } catch (error) {
    const failure = sanitizePurchasePipelineJobError(error);
    try {
      await jobLifecycle.failRun({
        runId: jobRun.run.id,
        ...failure,
        evaluationInsertedCount: batches.reduce(
          (sum, batch) => sum + batch.insertedCount,
          0,
        ),
        evaluationBatchCount: batches.length,
        evaluationBacklogMayRemain: true,
        resultJson: { asOf: asOf.toISOString(), maxBatches, batches },
      });
    } catch (lifecycleError) {
      console.error("[PurchaseForecastBacktesting] Failed to persist job failure", {
        jobRunId: jobRun.run.id,
        ...sanitizePurchasePipelineJobError(lifecycleError),
      });
    }
    throw error;
  }
}
