/** Standalone snapshot-only command for Heroku Scheduler. */

import { runPurchaseRecommendationSnapshotJob } from "./purchase-recommendation-snapshot.job";

runPurchaseRecommendationSnapshotJob()
  .then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch((error) => {
    console.error("[PurchaseRecommendationSnapshot] Scheduled run failed", { error });
    process.exit(1);
  });
