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
import {
  CutoverDropshipShippingPricingProvider,
  type DropshipShippingPricingProvider,
} from "../application/dropship-shipping-pricing-service";
import { DropshipError } from "../domain/errors";
import {
  readDropshipShippingCutoverConfig,
} from "../application/dropship-shipping-cutover-policy";
import type { DropshipLogger } from "../application/dropship-ports";
import type { DropshipSharedShippingQuoteProvider } from "../application/dropship-shared-shipping-quote";

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
  const sharedQuoteProvider =
    createSharedEngineDropshipShippingQuoteProviderFromEnv();
  const shadowComparison = shadowConfig.policy.mode === "off"
    ? undefined
    : new DropshipShippingShadowComparisonService({
        rolloutPolicy: shadowConfig.policy,
        sharedQuoteProvider,
        evidenceWriter: new PostgresShippingQuoteEvidenceWriter(),
        logger,
        clock: systemDropshipShippingQuoteClock,
      });

  return new DropshipShippingQuoteService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipShippingQuoteRepository(),
    cartonization: new BasicDropshipCartonizationProvider(),
    pricingProvider: createDropshipShippingPricingProviderFromEnv(logger, sharedQuoteProvider),
    shadowComparison,
    clock: systemDropshipShippingQuoteClock,
    logger,
  });
}

/** Both order quotes and estimates use this exact runtime rate-source decision. */
export function createDropshipShippingPricingProviderFromEnv(
  logger: DropshipLogger,
  sharedQuoteProvider: DropshipSharedShippingQuoteProvider = createSharedEngineDropshipShippingQuoteProviderFromEnv(),
): DropshipShippingPricingProvider {
  const cutoverConfig = readDropshipShippingCutoverConfig();
  if (cutoverConfig.configurationError !== null) {
    logger.error({
      code: "DROPSHIP_SHIPPING_CUTOVER_CONFIG_INVALID",
      message: "Dropship shipping quotes are blocked because pricing configuration is invalid.",
      context: { error: cutoverConfig.configurationError },
    });
    // Invalid settings must not silently switch the authority that determines
    // customer charges. Block quotes, without taking the rest of the app down.
    return {
      async quote() {
        throw new DropshipError(
          "DROPSHIP_SHIPPING_CUTOVER_CONFIG_INVALID",
          "Shipping pricing configuration needs attention.",
        );
      },
    };
  }
  return new CutoverDropshipShippingPricingProvider({
    cutoverPolicy: cutoverConfig.policy,
    legacyRateProvider: new CachedRateTableDropshipShippingRateProvider(),
    sharedQuoteProvider,
    logger,
  });
}
