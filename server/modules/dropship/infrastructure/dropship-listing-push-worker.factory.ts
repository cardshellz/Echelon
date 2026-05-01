import {
  DropshipListingPushWorkerService,
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { createDropshipMarketplaceListingPushProviderFromEnv } from "./dropship-marketplace-listing-push.providers";
import { PgDropshipListingPushWorkerRepository } from "./dropship-listing-push-worker.repository";

export function createDropshipListingPushWorkerServiceFromEnv(): DropshipListingPushWorkerService {
  return new DropshipListingPushWorkerService({
    repository: new PgDropshipListingPushWorkerRepository(),
    marketplacePush: createDropshipMarketplaceListingPushProviderFromEnv(),
    clock: systemDropshipListingPushWorkerClock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
