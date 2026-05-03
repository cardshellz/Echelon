import {
  DropshipOrderProcessingService,
  makeDropshipOrderProcessingLogger,
  systemDropshipOrderProcessingClock,
} from "../application/dropship-order-processing-service";
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
    clock: systemDropshipOrderProcessingClock,
    logger: makeDropshipOrderProcessingLogger(),
  });
}
