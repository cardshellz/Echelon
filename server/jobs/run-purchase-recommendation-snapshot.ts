/** Standalone snapshot-only command for Heroku Scheduler. */

import { runPurchaseRecommendationSnapshotJob } from "./purchase-recommendation-snapshot.job";
import { sanitizePurchasePipelineJobError } from "../modules/procurement/planning-and-pipeline-jobs.api";
import { logger } from "../platform/observability/logger";

runPurchaseRecommendationSnapshotJob()
  .then((result) => {
    logger.info("jobs.run_purchase_recommendation_snapshot", { detail: JSON.stringify(result) });
    process.exit(0);
  })
  .catch((error) => {
    logger.error("jobs.run_purchase_recommendation_snapshot", { message: "[PurchaseRecommendationSnapshot] Scheduled run failed", error: sanitizePurchasePipelineJobError(error) });
    process.exit(1);
  });
