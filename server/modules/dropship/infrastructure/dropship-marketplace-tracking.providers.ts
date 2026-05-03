import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceTrackingProvider,
  DropshipMarketplaceTrackingRequest,
  DropshipMarketplaceTrackingResult,
} from "../application/dropship-marketplace-tracking-provider";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import { EbayDropshipMarketplaceTrackingProvider } from "./dropship-ebay-tracking.provider";
import { PgDropshipMarketplaceCredentialRepository } from "./dropship-marketplace-credentials";
import { ShopifyDropshipMarketplaceTrackingProvider } from "./dropship-shopify-tracking.provider";

export class DropshipMarketplaceTrackingProviderRouter implements DropshipMarketplaceTrackingProvider {
  constructor(
    private readonly providers: Partial<Record<DropshipSourcePlatform, DropshipMarketplaceTrackingProvider>>,
  ) {}

  async pushTracking(
    input: DropshipMarketplaceTrackingRequest,
  ): Promise<DropshipMarketplaceTrackingResult> {
    const provider = this.providers[input.platform];
    if (!provider) {
      throw new DropshipError(
        "DROPSHIP_TRACKING_PROVIDER_NOT_CONFIGURED",
        "Dropship marketplace tracking provider is not configured.",
        { platform: input.platform, retryable: false },
      );
    }
    return provider.pushTracking(input);
  }
}

export function createDropshipMarketplaceTrackingProviderFromEnv(): DropshipMarketplaceTrackingProvider {
  const credentials = new PgDropshipMarketplaceCredentialRepository();
  return new DropshipMarketplaceTrackingProviderRouter({
    ebay: new EbayDropshipMarketplaceTrackingProvider(credentials),
    shopify: new ShopifyDropshipMarketplaceTrackingProvider(credentials),
  });
}
