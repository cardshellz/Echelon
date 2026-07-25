/** Standalone snapshot-only command for Heroku Scheduler. */

import { runPurchaseRecommendationSnapshotJob } from "./purchase-recommendation-snapshot.job";
import { sanitizePurchasePipelineJobError } from "../modules/procurement/purchase-pipeline-job-run-lifecycle.service";

runPurchaseRecommendationSnapshotJob()
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      "[PurchaseRecommendationSnapshot] Scheduled run failed",
      sanitizePurchasePipelineJobError(error),
    );
    process.exit(1);
  });
