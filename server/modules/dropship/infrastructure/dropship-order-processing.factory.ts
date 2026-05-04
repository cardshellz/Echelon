import {
  DropshipOrderProcessingService,
  makeDropshipOrderProcessingLogger,
  systemDropshipOrderProcessingClock,
} from "../application/dropship-order-processing-service";
import { getDropshipFulfillmentSync } from "./dropship-fulfillment-sync.registry";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipOrderAcceptanceServiceFromEnv } from "./dropship-order-acceptance.factory";
import { PgDropshipOrderProcessingRepository } from "./dropship-order-processing.repository";
import { createDropshipShippingQuoteServiceFromEnv } from "./dropship-shipping-quote.factory";
import { createDropshipWalletServiceFromEnv } from "./dropship-wallet.factory";

export function createDropshipOrderProcessingServiceFromEnv(): DropshipOrderProcessingService {
  return new DropshipOrderProcessingService({
    repository: new PgDropshipOrderProcessingRepository(),
    shippingQuote: createDropshipShippingQuoteServiceFromEnv(),
    orderAcceptance: createDropshipOrderAcceptanceServiceFromEnv(),
    walletAutoReload: createDropshipWalletServiceFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    fulfillmentSync: getDropshipFulfillmentSync(),
    clock: systemDropshipOrderProcessingClock,
    logger: makeDropshipOrderProcessingLogger(),
  });
}
