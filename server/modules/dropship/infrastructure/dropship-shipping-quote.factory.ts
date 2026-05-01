import {
  DropshipShippingQuoteService,
  makeDropshipShippingQuoteLogger,
  systemDropshipShippingQuoteClock,
} from "../application/dropship-shipping-quote-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipShippingQuoteRepository } from "./dropship-shipping-quote.repository";
import { BasicDropshipCartonizationProvider } from "./dropship-basic-cartonization.provider";
import { CachedRateTableDropshipShippingRateProvider } from "./dropship-cached-rate-table.provider";

export function createDropshipShippingQuoteServiceFromEnv(): DropshipShippingQuoteService {
  return new DropshipShippingQuoteService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipShippingQuoteRepository(),
    cartonization: new BasicDropshipCartonizationProvider(),
    rateProvider: new CachedRateTableDropshipShippingRateProvider(),
    clock: systemDropshipShippingQuoteClock,
    logger: makeDropshipShippingQuoteLogger(),
  });
}
