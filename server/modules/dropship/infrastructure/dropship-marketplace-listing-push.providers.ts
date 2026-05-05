import { DropshipError } from "../domain/errors";
import type {
  DropshipMarketplaceListingPushProvider,
  DropshipMarketplaceListingPushRequest,
  DropshipMarketplaceListingPushResult,
} from "../application/dropship-marketplace-listing-push-provider";
import type { DropshipSourcePlatform } from "../../../../shared/schema/dropship.schema";
import { EbayDropshipListingPushProvider } from "./dropship-ebay-listing-push.provider";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { ShopifyDropshipListingPushProvider } from "./dropship-shopify-listing-push.provider";

export class DropshipMarketplaceListingPushProviderRouter implements DropshipMarketplaceListingPushProvider {
  constructor(
    private readonly providers: Partial<Record<DropshipSourcePlatform, DropshipMarketplaceListingPushProvider>>,
  ) {}

  async pushListing(input: DropshipMarketplaceListingPushRequest): Promise<DropshipMarketplaceListingPushResult> {
    const provider = this.providers[input.platform];
    if (!provider) {
      throw new DropshipError(
        "DROPSHIP_LISTING_PUSH_PROVIDER_NOT_CONFIGURED",
        "Dropship marketplace listing push provider is not configured.",
        { platform: input.platform, retryable: false },
      );
    }
    return provider.pushListing(input);
  }
}

export function createDropshipMarketplaceListingPushProviderFromEnv(): DropshipMarketplaceListingPushProvider {
  const credentials = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new DropshipMarketplaceListingPushProviderRouter({
    ebay: new EbayDropshipListingPushProvider(credentials),
    shopify: new ShopifyDropshipListingPushProvider(credentials),
  });
}
