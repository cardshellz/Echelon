import {
  DropshipPaymentHoldExpirationService,
  makeDropshipPaymentHoldExpirationLogger,
  systemDropshipPaymentHoldExpirationClock,
} from "../application/dropship-payment-hold-expiration-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipPaymentHoldExpirationRepository } from "./dropship-payment-hold-expiration.repository";

export function createDropshipPaymentHoldExpirationServiceFromEnv(): DropshipPaymentHoldExpirationService {
  return new DropshipPaymentHoldExpirationService({
    repository: new PgDropshipPaymentHoldExpirationRepository(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipPaymentHoldExpirationClock,
    logger: makeDropshipPaymentHoldExpirationLogger(),
  });
}
