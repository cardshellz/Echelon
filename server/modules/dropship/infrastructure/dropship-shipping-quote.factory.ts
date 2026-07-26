import {
  DropshipShippingQuoteService,
  makeDropshipShippingQuoteLogger,
  systemDropshipShippingQuoteClock,
} from "../application/dropship-shipping-quote-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipShippingQuoteRepository } from "./dropship-shipping-quote.repository";
import { BasicDropshipCartonizationProvider } from "./dropship-basic-cartonization.provider";
import { CachedRateTableDropshipShippingRateProvider } from "./dropship-cached-rate-table.provider";
import {
  DropshipShippingShadowComparisonService,
} from "../application/dropship-shipping-shadow-comparison";
import {
  readDropshipShippingShadowRolloutConfig,
} from "../application/dropship-shipping-shadow-rollout";
import {
  PostgresShippingQuoteEvidenceWriter,
} from "../../shipping-engine/infrastructure/postgres-shipping-quote-evidence.writer";
import {
  createSharedEngineDropshipShippingQuoteProviderFromEnv,
} from "./shared-engine-dropship-shipping.provider";

export function createDropshipShippingQuoteServiceFromEnv(): DropshipShippingQuoteService {
  const logger = makeDropshipShippingQuoteLogger();
  const shadowConfig = readDropshipShippingShadowRolloutConfig();
  if (shadowConfig.configurationError !== null) {
    logger.error({
      code: "DROPSHIP_SHIPPING_SHADOW_CONFIG_INVALID",
      message:
        "Dropship shared shipping shadow comparison was disabled by invalid configuration.",
      context: {
        error: shadowConfig.configurationError,
      },
    });
  }
  const shadowComparison = shadowConfig.policy.mode === "off"
    ? undefined
    : new DropshipShippingShadowComparisonService({
        rolloutPolicy: shadowConfig.policy,
        sharedQuoteProvider:
          createSharedEngineDropshipShippingQuoteProviderFromEnv(),
        evidenceWriter: new PostgresShippingQuoteEvidenceWriter(),
        logger,
        clock: systemDropshipShippingQuoteClock,
      });

  return new DropshipShippingQuoteService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipShippingQuoteRepository(),
    cartonization: new BasicDropshipCartonizationProvider(),
    rateProvider: new CachedRateTableDropshipShippingRateProvider(),
    shadowComparison,
    clock: systemDropshipShippingQuoteClock,
    logger,
  });
}
