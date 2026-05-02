import {
  DropshipNotificationService,
  makeDropshipNotificationLogger,
  systemDropshipNotificationClock,
} from "../application/dropship-notification-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { SmtpDropshipNotificationEmailSender } from "./dropship-notification-email.sender";
import { PgDropshipNotificationRepository } from "./dropship-notification.repository";

export function createDropshipNotificationServiceFromEnv(): DropshipNotificationService {
  return new DropshipNotificationService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipNotificationRepository(),
    emailSender: new SmtpDropshipNotificationEmailSender(),
    clock: systemDropshipNotificationClock,
    logger: makeDropshipNotificationLogger(),
  });
}
