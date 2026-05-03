import {
  DropshipNotificationOpsService,
  makeDropshipNotificationOpsLogger,
} from "../application/dropship-notification-ops-service";
import { PgDropshipNotificationOpsRepository } from "./dropship-notification-ops.repository";

export function createDropshipNotificationOpsServiceFromEnv(): DropshipNotificationOpsService {
  return new DropshipNotificationOpsService({
    repository: new PgDropshipNotificationOpsRepository(),
    logger: makeDropshipNotificationOpsLogger(),
  });
}
