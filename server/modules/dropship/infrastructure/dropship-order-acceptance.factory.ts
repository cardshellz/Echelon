import {
  DropshipOrderAcceptanceService,
  makeDropshipOrderAcceptanceLogger,
  systemDropshipOrderAcceptanceClock,
} from "../application/dropship-order-acceptance-service";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import {
  getDropshipCanonicalAcceptanceFulfillment,
  getDropshipInventoryRuntimeAuthorityGate,
} from "./dropship-fulfillment-sync.registry";
import { PgDropshipOrderAcceptanceRepository } from "./dropship-order-acceptance.repository";
import { PgDropshipBelowCostSaleNotices } from "./dropship-marketplace-sync-notices.repository";

export function createDropshipOrderAcceptanceServiceFromEnv(): DropshipOrderAcceptanceService {
  const inventoryAuthority = getDropshipInventoryRuntimeAuthorityGate();
  const canonicalFulfillment = getDropshipCanonicalAcceptanceFulfillment();
  if (!inventoryAuthority || !canonicalFulfillment) {
    throw new Error(
      "Dropship order acceptance requires inventory authority and canonical fulfillment wiring.",
    );
  }
  return new DropshipOrderAcceptanceService({
    repository: new PgDropshipOrderAcceptanceRepository(),
    inventoryAuthority,
    canonicalFulfillment,
    notificationSender: createDropshipNotificationServiceFromEnv(),
    belowCostSaleNotices: new PgDropshipBelowCostSaleNotices(),
    clock: systemDropshipOrderAcceptanceClock,
    logger: makeDropshipOrderAcceptanceLogger(),
  });
}
