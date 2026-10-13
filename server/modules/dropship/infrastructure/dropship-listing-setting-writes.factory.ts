import { performance } from "node:perf_hooks";
import { logger } from "../../../platform/observability/logger";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { DropshipListingProductSettingsService } from "../application/dropship-listing-product-settings-service";
import type { ListingSettingWriteLog } from "../application/dropship-listing-setting-write-support";
import { DropshipListingSizePricesService } from "../application/dropship-listing-size-prices-service";
import { createDropshipListingSettingEbayAdapterFromEnv } from "./dropship-listing-setting-ebay.adapter";
import { PgDropshipListingSettingWritesRepository } from "./dropship-listing-setting-writes.repository";

/** One member per listing-settings writer; each later sub-PR adds its own (plan PR 9, section 3.1). */
export interface ListingSettingWriteServices {
  sizePrices: Pick<DropshipListingSizePricesService, "saveForMember">;
  /** W5 (one product); W6 joins it in 9d (plan 6.13 #9). */
  products: Pick<DropshipListingProductSettingsService, "saveForMember">;
}

/** The services' success lines, through the platform logger (it merges the request's correlation context). */
const platformWriteLog: ListingSettingWriteLog = {
  info: (action, fields) => logger.info(action, fields),
};

/**
 * Called once per process, at route registration: every writer shares one
 * write repository (the 8a wrapper over the shared pool), the preview clock,
 * a monotonic timer for `elapsed_ms` and the log port. W5 also gets the eBay
 * adapter over today's providers; W8 asks eBay nothing.
 */
export function createDropshipListingSettingWriteServices(): ListingSettingWriteServices {
  const repository = new PgDropshipListingSettingWritesRepository();
  const deps = {
    repository,
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    log: platformWriteLog,
  };
  return {
    sizePrices: new DropshipListingSizePricesService(deps),
    products: new DropshipListingProductSettingsService({ ...deps, ebay: createDropshipListingSettingEbayAdapterFromEnv() }),
  };
}
