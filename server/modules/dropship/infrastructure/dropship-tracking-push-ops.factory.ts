import {
  DropshipTrackingPushOpsService,
  makeDropshipTrackingPushOpsLogger,
} from "../application/dropship-tracking-push-ops-service";
import { systemDropshipMarketplaceTrackingClock } from "../application/dropship-marketplace-tracking-service";
import { PgDropshipTrackingPushOpsRepository } from "./dropship-tracking-push-ops.repository";
import { createDropshipMarketplaceTrackingServiceFromEnv } from "./dropship-marketplace-tracking.factory";

export function createDropshipTrackingPushOpsServiceFromEnv(): DropshipTrackingPushOpsService {
  return new DropshipTrackingPushOpsService({
    repository: new PgDropshipTrackingPushOpsRepository(),
    marketplaceTracking: createDropshipMarketplaceTrackingServiceFromEnv(),
    clock: systemDropshipMarketplaceTrackingClock,
    logger: makeDropshipTrackingPushOpsLogger(),
  });
}
