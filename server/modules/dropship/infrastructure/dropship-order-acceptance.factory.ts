import {
  DropshipOrderAcceptanceService,
  makeDropshipOrderAcceptanceLogger,
  systemDropshipOrderAcceptanceClock,
} from "../application/dropship-order-acceptance-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipOrderAcceptanceRepository } from "./dropship-order-acceptance.repository";

export function createDropshipOrderAcceptanceServiceFromEnv(): DropshipOrderAcceptanceService {
  return new DropshipOrderAcceptanceService({
    repository: new PgDropshipOrderAcceptanceRepository(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipOrderAcceptanceClock,
    logger: makeDropshipOrderAcceptanceLogger(),
  });
}
