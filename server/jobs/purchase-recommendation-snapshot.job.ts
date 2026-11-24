import { db } from "../db";
import { inventoryStorage } from "../modules/inventory";
import { procurementMethods } from "../modules/procurement/runtime-services.api";
import {
  buildPurchaseRecommendationRunInput,
  createPurchasePipelineJobRunLifecycleService,
  createPurchaseRecommendationSnapshotService,
  loadPurchaseRecommendationSnapshotAnalysis,
  purchasePipelineJobRunLifecycleRepository,
  sanitizePurchasePipelineJobError,
  type PurchasePipelineJobRunLifecycleService,
} from "../modules/procurement/planning-and-pipeline-jobs.api";
import { logger } from "../platform/observability/logger";

const SCHEDULED_RECOMMENDATION_ACTOR = "system:scheduled-purchase-recommendations";
const defaultJobLifecycle = createPurchasePipelineJobRunLifecycleService(
  purchasePipelineJobRunLifecycleRepository,
);

export function buildScheduledPurchaseRecommendationSourceRunKey(asOf: Date): string {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new RangeError("asOf must be a valid date");
  }
  return `scheduled-recommendation:v1:${asOf.toISOString().slice(0, 10)}`;
}

export async function runPurchaseRecommendationSnapshotJob(options: {
  asOf?: Date;
  actor?: string;
  jobLifecycle?: PurchasePipelineJobRunLifecycleService;
} = {}) {
  const asOf = options.asOf ? new Date(options.asOf.getTime()) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new RangeError("asOf must be a valid date");
  }
  const actor = options.actor?.trim() || SCHEDULED_RECOMMENDATION_ACTOR;
  const sourceRunKey = buildScheduledPurchaseRecommendationSourceRunKey(asOf);
  const jobLifecycle = options.jobLifecycle ?? defaultJobLifecycle;
  const jobRun = await jobLifecycle.startRun({
    jobType: "recommendation_snapshot",
    triggerType: "scheduled",
    asOf,
  });

  try {
    const analysis = await loadPurchaseRecommendationSnapshotAnalysis({
      storage: { ...procurementMethods, ...inventoryStorage },
    });
    await jobLifecycle.heartbeatRun({ runId: jobRun.run.id });
    const snapshot = await createPurchaseRecommendationSnapshotService(db).createRun(
      buildPurchaseRecommendationRunInput({
        recommendationResult: analysis.recommendationResult,
        settings: analysis.settings,
        lookbackDays: analysis.lookbackDays,
        asOf,
        source: "scheduled",
        sourceRunKey,
        evaluatedCount: analysis.evaluatedCount,
      }),
      actor,
    );
    const result = {
      jobRunId: jobRun.run.id,
      runId: Number(snapshot.run.id),
      sourceRunKey,
      asOf: asOf.toISOString(),
      evaluatedCount: analysis.evaluatedCount,
      lineCount: snapshot.lines.length,
      observationCount: snapshot.observations.length,
      reused: snapshot.reused,
    };
    await jobLifecycle.completeRun({
      runId: jobRun.run.id,
      completion: {
        jobType: "recommendation_snapshot",
        recommendationRunId: result.runId,
        recommendationLineCount: result.lineCount,
        forecastObservationCount: result.observationCount,
        resultJson: {
          sourceRunKey: result.sourceRunKey,
          asOf: result.asOf,
          evaluatedCount: result.evaluatedCount,
          reused: result.reused,
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
      });
    } catch (lifecycleError) {
      logger.error("jobs.purchase_recommendation_snapshot_job", { message: "[PurchaseRecommendationSnapshot] Failed to persist job failure", context: {
        jobRunId: jobRun.run.id,
        ...sanitizePurchasePipelineJobError(lifecycleError),
      } });
    }
    throw error;
  }
}
