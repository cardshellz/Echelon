import {
  DropshipCollectionSweepService,
  makeDropshipCollectionSweepLogger,
  systemDropshipCollectionSweepClock,
  type DropshipCollectionFundingProvider,
} from "../application/dropship-collection-sweep-service";
import { PgDropshipCollectionSweepRepository } from "./dropship-collection-sweep.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createStripeDropshipFundingProviderFromEnv } from "./dropship-stripe-funding.provider";

export function createDropshipCollectionSweepServiceFromEnv(): DropshipCollectionSweepService {
  const stripeProvider = createStripeDropshipFundingProviderFromEnv();
  // Adapter: the sweep's port is a narrow slice of the Stripe funding
  // provider. The provider is always constructed here; when STRIPE_SECRET_KEY
  // is absent the charge call throws DROPSHIP_STRIPE_SECRET_NOT_CONFIGURED,
  // which the sweep records as a normal charge failure (retry path), not a
  // crash.
  const fundingProvider: DropshipCollectionFundingProvider = {
    createStripeCollectionCharge: (input) => stripeProvider.createStripeCollectionCharge(input),
  };
  return new DropshipCollectionSweepService({
    repository: new PgDropshipCollectionSweepRepository(),
    fundingProvider,
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipCollectionSweepClock,
    logger: makeDropshipCollectionSweepLogger(),
  });
}
