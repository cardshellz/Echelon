import {
  DropshipListingPushWorkerService,
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { refreshQueuedListingIntent } from "../application/dropship-listing-intent-refresh";
import { createDropshipMarketplaceListingPushProviderFromEnv } from "./dropship-marketplace-listing-push.providers";
import { PgDropshipListingPushWorkerRepository } from "./dropship-listing-push-worker.repository";
import { readAutomaticRequeuePendingItemIds } from "./dropship-listing-push-ops.repository";
import { pool } from "../../../db";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipListingPreviewServiceFromEnv } from "./dropship-listing-preview.factory";
import { createDropshipCostChangePolicyServiceFromEnv } from "./dropship-cost-change-policy.factory";

export function createDropshipListingPushWorkerServiceFromEnv(): DropshipListingPushWorkerService {
  const logger = makeDropshipListingPushWorkerLogger();
  return new DropshipListingPushWorkerService({
    refreshListingIntent: (input) => refreshQueuedListingIntent({
      generatePreview: (previewInput) => createDropshipListingPreviewServiceFromEnv().generatePreview(previewInput),
      resolveCostChangePolicy: () => createDropshipCostChangePolicyServiceFromEnv().resolvePolicy(),
      logger,
    }, input),
    repository: new PgDropshipListingPushWorkerRepository(),
    marketplacePush: createDropshipMarketplaceListingPushProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    // The failure email says "tried again automatically" only for items the sweep will re-queue (review V2-2).
    automaticRequeueOutlook: { pendingItemIds: (jobId) => readAutomaticRequeuePendingItemIds(pool, jobId) },
    clock: systemDropshipListingPushWorkerClock,
    logger,
  });
}
