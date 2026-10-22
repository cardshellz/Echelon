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
import { createDropshipEbayFulfillmentPolicyGuardFromEnv } from "./dropship-ebay-fulfillment-policy-guard.factory";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";
import { PgDropshipEbayManagedLocationProvider } from "./dropship-ebay-managed-location.provider";
import { createDropshipEbayQuantityRequestAdmission } from "../../inventory-planning/infrastructure/quantity-publication-runtime";
import { pool } from "../../../db";
import { PostgresDropshipEbayPushPublicationReader } from "./dropship-ebay-push-publication.reader";
import { createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv } from "./dropship-marketplace-registration.factory";
import { createDropshipEbayStockReadinessGate } from "./dropship-ebay-stock-readiness.gate";

/** Real wait for the bounded in-process retries (stock link, busy SKU scope). */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
  // One injected clock for the push: the provider's and the stock link's (plan F2 2.6).
  const clock = { now: () => new Date() };
  return new DropshipMarketplaceListingPushProviderRouter({
    ebay: new EbayDropshipListingPushProvider(
      credentials,
      fetch,
      clock,
      createDropshipEbayFulfillmentPolicyGuardFromEnv(),
      new PgDropshipEbayManagedLocationProvider({
        credentials: createDropshipEbayRegistrationCredentialProviderFromEnv(),
      }),
      createDropshipEbayQuantityRequestAdmission,
      new PostgresDropshipEbayPushPublicationReader(pool, createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv().observer),
      // The only root that calls pushListing, so the only one that must link stock.
      { stockReadiness: createDropshipEbayStockReadinessGate({ pool, clock, sleep }), sleep },
    ),
    shopify: new ShopifyDropshipListingPushProvider(credentials),
  });
}
