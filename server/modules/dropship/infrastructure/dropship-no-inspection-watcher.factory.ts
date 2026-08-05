import {
  DropshipNoInspectionWatcherService,
  makeDropshipNoInspectionWatcherLogger,
  systemDropshipNoInspectionWatcherClock,
} from "../application/dropship-no-inspection-watcher-service";
import { PgDropshipNoInspectionWatcherRepository } from "./dropship-no-inspection-watcher.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

export function createDropshipNoInspectionWatcherServiceFromEnv(): DropshipNoInspectionWatcherService {
  return new DropshipNoInspectionWatcherService({
    repository: new PgDropshipNoInspectionWatcherRepository(),
    // No tracking provider is wired yet — PR 4's channel return-intake
    // adapters (or a future carrier-tracking integration) implement the
    // DropshipReturnTrackingProvider port. Without it the watcher runs the
    // delivery-timeout path only.
    trackingProvider: undefined,
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipNoInspectionWatcherClock,
    logger: makeDropshipNoInspectionWatcherLogger(),
  });
}
