import {
  DropshipListingPushWorkerService,
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { createDropshipMarketplaceListingPushProviderFromEnv } from "./dropship-marketplace-listing-push.providers";
import { PgDropshipListingPushWorkerRepository } from "./dropship-listing-push-worker.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

export function createDropshipListingPushWorkerServiceFromEnv(): DropshipListingPushWorkerService {
  return new DropshipListingPushWorkerService({
    repository: new PgDropshipListingPushWorkerRepository(),
    marketplacePush: createDropshipMarketplaceListingPushProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingPushWorkerClock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
