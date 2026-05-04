import {
  DropshipOrderIntakeService,
  makeDropshipOrderIntakeLogger,
  systemDropshipOrderIntakeClock,
} from "../application/dropship-order-intake-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipOrderIntakeRepository } from "./dropship-order-intake.repository";

export function createDropshipOrderIntakeServiceFromEnv(): DropshipOrderIntakeService {
  return new DropshipOrderIntakeService({
    repository: new PgDropshipOrderIntakeRepository(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipOrderIntakeClock,
    logger: makeDropshipOrderIntakeLogger(),
  });
}
