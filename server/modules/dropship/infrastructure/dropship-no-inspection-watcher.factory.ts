import {
  DropshipNoInspectionWatcherService,
  makeDropshipNoInspectionWatcherLogger,
  systemDropshipNoInspectionWatcherClock,
} from "../application/dropship-no-inspection-watcher-service";
import { PgDropshipNoInspectionWatcherRepository } from "./dropship-no-inspection-watcher.repository";
import { PgDropshipReturnIntakeRepository } from "./dropship-return-intake.repository";
import { DropshipChannelReturnTrackingProvider } from "./dropship-return-tracking.provider";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { RefreshingDropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

export function createDropshipNoInspectionWatcherServiceFromEnv(): DropshipNoInspectionWatcherService {
  // PR 4 wires the channel return-tracking provider into the port: eBay
  // return-leg carrier status is now live (Post-Order API return detail);
  // Shopify returns null best-effort and rides the delivery-timeout path.
  const returnIntakeRepository = new PgDropshipReturnIntakeRepository();
  const credentials = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new DropshipNoInspectionWatcherService({
    repository: new PgDropshipNoInspectionWatcherRepository(),
    trackingProvider: new DropshipChannelReturnTrackingProvider({
      credentials,
      ebayCredentials: RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(credentials),
      repository: returnIntakeRepository,
    }),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipNoInspectionWatcherClock,
    logger: makeDropshipNoInspectionWatcherLogger(),
  });
}
