import { logger } from "../../../platform/observability/logger";
import { DropshipMarketplaceOrderCancelService } from "../application/dropship-marketplace-order-cancel-service";
import { getDropshipMarketplaceCancelStop } from "./dropship-fulfillment-sync.registry";
import { PgDropshipMarketplaceOrderCancelRepository } from "./dropship-marketplace-order-cancel.repository";

/** The stop of accepted orders eBay cancelled (plan v4 §7.2), with OMS's stop as registered at boot. */
export function createDropshipMarketplaceOrderCancelServiceFromEnv(): DropshipMarketplaceOrderCancelService {
  return new DropshipMarketplaceOrderCancelService({
    repository: new PgDropshipMarketplaceOrderCancelRepository(),
    stopper: getDropshipMarketplaceCancelStop() ?? null,
    clock: { now: () => new Date() },
    logger: {
      debug: (action, fields) => logger.debug(action, fields),
      info: (action, fields) => logger.info(action, fields),
      warn: (action, fields) => logger.warn(action, fields),
      error: (action, fields) => logger.error(action, fields),
    },
  });
}
