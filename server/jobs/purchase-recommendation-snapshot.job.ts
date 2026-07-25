import { db } from "../db";
import { inventoryStorage } from "../modules/inventory";
import { procurementMethods } from "../modules/procurement/procurement.storage";
import { loadPurchaseRecommendationSnapshotAnalysis } from "../modules/procurement/purchase-recommendation-analysis.service";
import {
  buildPurchaseRecommendationRunInput,
  createPurchaseRecommendationSnapshotService,
} from "../modules/procurement/purchase-recommendation-snapshot.service";

const SCHEDULED_RECOMMENDATION_ACTOR = "system:scheduled-purchase-recommendations";

export function buildScheduledPurchaseRecommendationSourceRunKey(asOf: Date): string {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
    throw new RangeError("asOf must be a valid date");
  }
  return `scheduled-recommendation:v1:${asOf.toISOString().slice(0, 10)}`;
}

export async function runPurchaseRecommendationSnapshotJob(options: {
  asOf?: Date;
  actor?: string;
} = {}) {
  const asOf = options.asOf ? new Date(options.asOf.getTime()) : new Date();
  const actor = options.actor?.trim() || SCHEDULED_RECOMMENDATION_ACTOR;
  const sourceRunKey = buildScheduledPurchaseRecommendationSourceRunKey(asOf);
  const analysis = await loadPurchaseRecommendationSnapshotAnalysis({
    storage: { ...procurementMethods, ...inventoryStorage },
  });
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

  return {
    runId: Number(snapshot.run.id),
    sourceRunKey,
    asOf: asOf.toISOString(),
    evaluatedCount: analysis.evaluatedCount,
    lineCount: snapshot.lines.length,
    observationCount: snapshot.observations.length,
    reused: snapshot.reused,
  };
}
