import {
  DropshipMarketplaceTrackingService,
  makeDropshipMarketplaceTrackingLogger,
  systemDropshipMarketplaceTrackingClock,
} from "../application/dropship-marketplace-tracking-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipMarketplaceTrackingRepository } from "./dropship-marketplace-tracking.repository";
import { createDropshipMarketplaceTrackingProviderFromEnv } from "./dropship-marketplace-tracking.providers";

export function createDropshipMarketplaceTrackingServiceFromEnv(): DropshipMarketplaceTrackingService {
  return new DropshipMarketplaceTrackingService({
    repository: new PgDropshipMarketplaceTrackingRepository(),
    provider: createDropshipMarketplaceTrackingProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipMarketplaceTrackingClock,
    logger: makeDropshipMarketplaceTrackingLogger(),
  });
}
