import {
  DropshipOrderRejectionService,
  makeDropshipOrderRejectionLogger,
  systemDropshipOrderRejectionClock,
} from "../application/dropship-order-rejection-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipOrderRejectionRepository } from "./dropship-order-rejection.repository";

export function createDropshipOrderRejectionServiceFromEnv(): DropshipOrderRejectionService {
  return new DropshipOrderRejectionService({
    repository: new PgDropshipOrderRejectionRepository(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipOrderRejectionClock,
    logger: makeDropshipOrderRejectionLogger(),
  });
}
