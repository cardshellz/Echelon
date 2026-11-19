import {
  DropshipEbayOrderIntakePollService,
  makeDropshipEbayOrderIntakeLogger,
  systemDropshipEbayOrderIntakeClock,
} from "../application/dropship-ebay-order-intake-poll-service";
import { PgDropshipEbayMarketplaceOrderEffects } from "./dropship-ebay-marketplace-order-effects.repository";
import { EbayDropshipOrderIntakeProvider } from "./dropship-ebay-order-intake.provider";
import { PgDropshipEbayOrderIntakeRepository } from "./dropship-ebay-order-intake.repository";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { createDropshipOrderIntakeServiceFromEnv } from "./dropship-order-intake.factory";
import { createDropshipOrderIntakeHealthServiceFromEnv } from "./dropship-order-intake-health.factory";

export function createDropshipEbayOrderIntakePollServiceFromEnv(): DropshipEbayOrderIntakePollService {
  const credentials = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new DropshipEbayOrderIntakePollService({
    repository: new PgDropshipEbayOrderIntakeRepository(),
    provider: new EbayDropshipOrderIntakeProvider(credentials),
    healthService: createDropshipOrderIntakeHealthServiceFromEnv(),
    orderIntakeService: createDropshipOrderIntakeServiceFromEnv(),
    marketplaceOrders: new PgDropshipEbayMarketplaceOrderEffects(),
    clock: systemDropshipEbayOrderIntakeClock,
    logger: makeDropshipEbayOrderIntakeLogger(),
  });
}
