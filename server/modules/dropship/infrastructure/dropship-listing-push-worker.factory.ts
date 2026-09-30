import {
  DropshipListingPushWorkerService,
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { refreshQueuedListingIntent } from "../application/dropship-listing-intent-refresh";
import { createDropshipMarketplaceListingPushProviderFromEnv } from "./dropship-marketplace-listing-push.providers";
import { PgDropshipListingPushWorkerRepository } from "./dropship-listing-push-worker.repository";
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
    clock: systemDropshipListingPushWorkerClock,
    logger,
  });
}
