import { DropshipListingPriceService } from "../application/dropship-listing-price-service";
import { makeDropshipListingPreviewLogger, systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { PgDropshipListingPriceRepository } from "./dropship-listing-price.repository";

export function createDropshipListingPriceService(): DropshipListingPriceService {
  // Local configuration only: deliberately no wallet, provisioning, credentials,
  // marketplace provider, or listing-job dependency.
  return new DropshipListingPriceService({ repository: new PgDropshipListingPriceRepository(),
    clock: systemDropshipListingPreviewClock, logger: makeDropshipListingPreviewLogger() });
}
