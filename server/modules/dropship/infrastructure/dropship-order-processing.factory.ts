import {
  DropshipOrderProcessingService,
  makeDropshipOrderProcessingLogger,
  systemDropshipOrderProcessingClock,
} from "../application/dropship-order-processing-service";
import { createDropshipOrderAcceptanceServiceFromEnv } from "./dropship-order-acceptance.factory";
import { PgDropshipOrderProcessingRepository } from "./dropship-order-processing.repository";
import { createDropshipShippingQuoteServiceFromEnv } from "./dropship-shipping-quote.factory";

export function createDropshipOrderProcessingServiceFromEnv(): DropshipOrderProcessingService {
  return new DropshipOrderProcessingService({
    repository: new PgDropshipOrderProcessingRepository(),
    shippingQuote: createDropshipShippingQuoteServiceFromEnv(),
    orderAcceptance: createDropshipOrderAcceptanceServiceFromEnv(),
    clock: systemDropshipOrderProcessingClock,
    logger: makeDropshipOrderProcessingLogger(),
  });
}
