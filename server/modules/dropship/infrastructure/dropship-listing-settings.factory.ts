import { DropshipListingSettingsService } from "../application/dropship-listing-settings-service";
import { makeDropshipListingPreviewLogger, systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { PgDropshipListingSettingsRepository } from "./dropship-listing-settings.repository";

/**
 * Read-only: no wallet, provisioning, credentials, marketplace provider or
 * listing-job dependency. One service per process holds the views cache.
 */
export function createDropshipListingSettingsService(): DropshipListingSettingsService {
  const logger = makeDropshipListingPreviewLogger();
  return new DropshipListingSettingsService({
    repository: new PgDropshipListingSettingsRepository(undefined, (failure) => logger.warn({
      code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
      message: "The .ops cost read failed while listing settings were built.",
      context: failure,
    })),
    clock: systemDropshipListingPreviewClock,
    logger,
  });
}
