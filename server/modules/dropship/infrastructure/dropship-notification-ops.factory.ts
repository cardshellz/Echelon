import {
  DropshipNotificationOpsService,
  makeDropshipNotificationOpsLogger,
  systemDropshipNotificationOpsClock,
} from "../application/dropship-notification-ops-service";
import { SmtpDropshipNotificationEmailSender } from "./dropship-notification-email.sender";
import { PgDropshipNotificationOpsRepository } from "./dropship-notification-ops.repository";

export function createDropshipNotificationOpsServiceFromEnv(): DropshipNotificationOpsService {
  return new DropshipNotificationOpsService({
    repository: new PgDropshipNotificationOpsRepository(),
    emailSender: new SmtpDropshipNotificationEmailSender(),
    logger: makeDropshipNotificationOpsLogger(),
    clock: systemDropshipNotificationOpsClock,
  });
}
