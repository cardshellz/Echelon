import { DropshipCarrierClaimService } from "../application/dropship-carrier-claim-service";
import { systemCarrierProtectionClock } from "../application/dropship-carrier-protection-service";
import { makeDropshipShippingConfigLogger } from "../application/dropship-shipping-config-service";
import { PgDropshipCarrierClaimRepository } from "./dropship-carrier-claim.repository";

export function createDropshipCarrierClaimServiceFromEnv(): DropshipCarrierClaimService {
  return new DropshipCarrierClaimService({
    repository: new PgDropshipCarrierClaimRepository(),
    clock: systemCarrierProtectionClock,
    logger: makeDropshipShippingConfigLogger(),
  });
}
