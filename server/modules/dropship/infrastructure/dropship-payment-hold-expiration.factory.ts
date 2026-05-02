import {
  DropshipPaymentHoldExpirationService,
  makeDropshipPaymentHoldExpirationLogger,
  systemDropshipPaymentHoldExpirationClock,
} from "../application/dropship-payment-hold-expiration-service";
import { PgDropshipPaymentHoldExpirationRepository } from "./dropship-payment-hold-expiration.repository";

export function createDropshipPaymentHoldExpirationServiceFromEnv(): DropshipPaymentHoldExpirationService {
  return new DropshipPaymentHoldExpirationService({
    repository: new PgDropshipPaymentHoldExpirationRepository(),
    clock: systemDropshipPaymentHoldExpirationClock,
    logger: makeDropshipPaymentHoldExpirationLogger(),
  });
}
