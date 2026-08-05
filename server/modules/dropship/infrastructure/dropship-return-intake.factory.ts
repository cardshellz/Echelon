import {
  DropshipReturnIntakePollService,
  makeDropshipReturnIntakePollLogger,
  systemDropshipReturnIntakePollClock,
} from "../application/dropship-return-intake-poll-service";
import {
  DropshipReturnIntakeService,
  makeDropshipReturnIntakeLogger,
  systemDropshipReturnIntakeClock,
} from "../application/dropship-return-intake-service";
import { EbayDropshipReturnIntakeProvider } from "./dropship-ebay-return-intake.provider";
import { ShopifyDropshipReturnIntakeProvider } from "./dropship-shopify-return-intake.provider";
import { PgDropshipReturnIntakeRepository } from "./dropship-return-intake.repository";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";

export function createDropshipEbayReturnIntakePollServiceFromEnv(): DropshipReturnIntakePollService {
  const credentials = createDropshipMarketplaceCredentialRepositoryFromEnv();
  const repository = new PgDropshipReturnIntakeRepository();
  return new DropshipReturnIntakePollService({
    platform: "ebay",
    repository,
    provider: new EbayDropshipReturnIntakeProvider(credentials),
    intakeService: new DropshipReturnIntakeService({
      repository,
      clock: systemDropshipReturnIntakeClock,
      logger: makeDropshipReturnIntakeLogger(),
    }),
    clock: systemDropshipReturnIntakePollClock,
    logger: makeDropshipReturnIntakePollLogger(),
  });
}

export function createDropshipShopifyReturnIntakePollServiceFromEnv(): DropshipReturnIntakePollService {
  const credentials = createDropshipMarketplaceCredentialRepositoryFromEnv();
  const repository = new PgDropshipReturnIntakeRepository();
  return new DropshipReturnIntakePollService({
    platform: "shopify",
    repository,
    provider: new ShopifyDropshipReturnIntakeProvider(credentials),
    intakeService: new DropshipReturnIntakeService({
      repository,
      clock: systemDropshipReturnIntakeClock,
      logger: makeDropshipReturnIntakeLogger(),
    }),
    clock: systemDropshipReturnIntakePollClock,
    logger: makeDropshipReturnIntakePollLogger(),
  });
}
