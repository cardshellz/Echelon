import { DropshipLiveListingZeroQuantityService } from "../application/dropship-live-listing-zero-quantity-service";
import { makeDropshipListingPushWorkerLogger, systemDropshipListingPushWorkerClock } from "../application/dropship-listing-push-worker-service";
import { createDropshipEbayQuantityRequestAdmission } from "../../inventory-planning/infrastructure/quantity-publication-runtime";
import { EbayDropshipListingPushProvider } from "./dropship-ebay-listing-push.provider";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { PgDropshipLiveListingZeroQuantityRepository } from "./dropship-live-listing-zero-quantity.repository";

/**
 * Production wiring of the zero-quantity update for a live eBay listing with
 * no stock to sell (legacy ATP authority; the dropship quantity catch-up is
 * its only caller). The eBay push provider is used only for its quantity-only
 * write, through the same inventory quantity admission as a push's quantity
 * (createDropshipEbayQuantityRequestAdmission); none of the push's listing
 * collaborators (policy guard, managed location, stock readiness) are needed.
 */
export function createDropshipLiveListingZeroQuantityServiceFromEnv(): DropshipLiveListingZeroQuantityService {
  const clock = systemDropshipListingPushWorkerClock;
  return new DropshipLiveListingZeroQuantityService({
    sender: new EbayDropshipListingPushProvider(createDropshipMarketplaceCredentialRepositoryFromEnv(), fetch, clock,
      undefined, undefined, createDropshipEbayQuantityRequestAdmission),
    repository: new PgDropshipLiveListingZeroQuantityRepository(),
    clock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
