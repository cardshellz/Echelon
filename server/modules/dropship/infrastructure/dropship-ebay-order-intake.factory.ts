import {
  DropshipEbayOrderIntakePollService,
  makeDropshipEbayOrderIntakeLogger,
  systemDropshipEbayOrderIntakeClock,
} from "../application/dropship-ebay-order-intake-poll-service";
import { EbayDropshipOrderIntakeProvider } from "./dropship-ebay-order-intake.provider";
import { PgDropshipEbayOrderIntakeRepository } from "./dropship-ebay-order-intake.repository";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { createDropshipOrderIntakeServiceFromEnv } from "./dropship-order-intake.factory";

export function createDropshipEbayOrderIntakePollServiceFromEnv(): DropshipEbayOrderIntakePollService {
  const credentials = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new DropshipEbayOrderIntakePollService({
    repository: new PgDropshipEbayOrderIntakeRepository(),
    provider: new EbayDropshipOrderIntakeProvider(credentials),
    orderIntakeService: createDropshipOrderIntakeServiceFromEnv(),
    clock: systemDropshipEbayOrderIntakeClock,
    logger: makeDropshipEbayOrderIntakeLogger(),
  });
}
