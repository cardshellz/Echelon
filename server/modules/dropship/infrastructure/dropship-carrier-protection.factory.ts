import { DropshipCarrierProtectionService, systemCarrierProtectionClock } from "../application/dropship-carrier-protection-service";
import { makeDropshipShippingConfigLogger } from "../application/dropship-shipping-config-service";
import { PgDropshipCarrierProtectionRepository } from "./dropship-carrier-protection.repository";

export function createDropshipCarrierProtectionServiceFromEnv(): DropshipCarrierProtectionService {
  return new DropshipCarrierProtectionService({
    repository: new PgDropshipCarrierProtectionRepository(),
    clock: systemCarrierProtectionClock,
    logger: makeDropshipShippingConfigLogger(),
  });
}
