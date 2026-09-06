import { DropshipListingShippingEstimateService } from "../application/dropship-listing-shipping-estimate-service";
import { makeDropshipShippingQuoteLogger, systemDropshipShippingQuoteClock } from "../application/dropship-shipping-quote-service";
import { BasicDropshipCartonizationProvider } from "./dropship-basic-cartonization.provider";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { PgListingShippingEstimateContextReader } from "./dropship-listing-shipping-estimate.repository";
import { createDropshipShippingPricingProviderFromEnv } from "./dropship-shipping-quote.factory";
import { PgDropshipShippingQuoteRepository } from "./dropship-shipping-quote.repository";

export function createDropshipListingShippingEstimateServiceFromEnv(): DropshipListingShippingEstimateService {
  const logger = makeDropshipShippingQuoteLogger();
  const policies = new PgDropshipShippingQuoteRepository();
  return new DropshipListingShippingEstimateService({
    contexts: new PgListingShippingEstimateContextReader(),
    catalog: new PgDropshipListingPreviewRepository(),
    calculation: {
      cartonization: new BasicDropshipCartonizationProvider(),
      pricingProvider: createDropshipShippingPricingProviderFromEnv(logger),
      // Supply only read methods; the estimator cannot reach snapshot creation.
      repository: {
        getActiveShippingMarkupPolicy: (at) => policies.getActiveShippingMarkupPolicy(at),
        getActiveInsurancePoolPolicy: (at) => policies.getActiveInsurancePoolPolicy(at),
      },
    },
    clock: systemDropshipShippingQuoteClock,
    logger,
  });
}
