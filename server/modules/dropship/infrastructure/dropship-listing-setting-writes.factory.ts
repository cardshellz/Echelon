import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logger } from "../../../platform/observability/logger";
import { DropshipListingCategoryMovesService } from "../application/dropship-listing-category-moves-service";
import { DropshipListingCategorySettingsService } from "../application/dropship-listing-category-settings-service";
import { DropshipListingPriceChangesService } from "../application/dropship-listing-price-changes-service";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { DropshipListingProductSettingsService } from "../application/dropship-listing-product-settings-service";
import { DropshipListingProductsBulkService } from "../application/dropship-listing-products-bulk-service";
import type { ListingSettingEbayPort } from "../application/dropship-listing-setting-ebay-values";
import { ListingSettingHeavyWriteGate, type ListingSettingWriteLog } from "../application/dropship-listing-setting-write-support";
import type { ListingSettingWriteRepository } from "../application/dropship-listing-setting-writes";
import { DropshipListingSizePricesService } from "../application/dropship-listing-size-prices-service";
import { createDropshipListingSettingEbayAdapterFromEnv } from "./dropship-listing-setting-ebay.adapter";
import { PgDropshipListingSettingWritesRepository } from "./dropship-listing-setting-writes.repository";

/** One member per listing-settings writer; each later sub-PR adds its own (plan PR 9, section 3.1). */
export interface ListingSettingWriteServices {
  sizePrices: Pick<DropshipListingSizePricesService, "saveForMember">;
  /** W5 (one product) and W6 (many products), two classes behind one member (plan 6.13 #9). */
  products: Pick<DropshipListingProductSettingsService, "saveForMember"> & Pick<DropshipListingProductsBulkService, "saveBulkForMember">;
  /** W12 (one Card Shellz category, with "Also clear theirs"). */
  categories: Pick<DropshipListingCategorySettingsService, "saveForMember">;
  /** W7 (the price check, its pages and its apply). */
  priceChanges: Pick<DropshipListingPriceChangesService, "reviewForMember" | "reviewPageForMember" | "applyForMember">;
  /** W13 ("Got it" for products Card Shellz moved). */
  categoryMoves: Pick<DropshipListingCategoryMovesService, "acknowledgeForMember">;
}

/** What a test may put in place of the production wiring; everything else is built as in production. */
export interface ListingSettingWriteServiceOverrides {
  repository?: ListingSettingWriteRepository;
  ebay?: ListingSettingEbayPort;
}

/** The services' success lines, through the platform logger (it merges the request's correlation context). */
const platformWriteLog: ListingSettingWriteLog = {
  info: (action, fields) => logger.info(action, fields),
};

/**
 * Called once per process, at route registration (the only production call
 * passes no overrides): every writer shares one write repository (the 8a
 * wrapper over the shared pool), the preview clock, a monotonic timer for
 * `elapsed_ms` and the log port. W5, W6, W12 and W7 also get the eBay adapter
 * over today's providers; W8 and W13 ask eBay nothing. The one heavy-write gate
 * (plan 3.10 (a)) is built here and injected into every heavy writer (W6, W12
 * when it clears, and W7's check and apply), so one process runs one heavy
 * write at a time. W7's review ids are randomUUID (W1's pattern,
 * dropship-pricing-rules.factory.ts). `overrides` is the factory test's seam:
 * an injected repository or eBay port, never a module mock.
 */
export function createDropshipListingSettingWriteServices(overrides: ListingSettingWriteServiceOverrides = {}): ListingSettingWriteServices {
  const repository = overrides.repository ?? new PgDropshipListingSettingWritesRepository();
  const ebay = overrides.ebay ?? createDropshipListingSettingEbayAdapterFromEnv();
  const heavyWrites = new ListingSettingHeavyWriteGate();
  const deps = {
    repository,
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    log: platformWriteLog,
  };
  const product = new DropshipListingProductSettingsService({ ...deps, ebay });
  const productsBulk = new DropshipListingProductsBulkService({ ...deps, ebay, heavyWrites });
  const category = new DropshipListingCategorySettingsService({ ...deps, ebay, heavyWrites });
  const priceChanges = new DropshipListingPriceChangesService({ ...deps, ebay, heavyWrites, newId: () => randomUUID() });
  // A single write (plan 3.10): never heavy, so never behind the gate.
  const categoryMoves = new DropshipListingCategoryMovesService(deps);
  return {
    sizePrices: new DropshipListingSizePricesService(deps),
    products: {
      saveForMember: (memberId, storeId, productId, body) => product.saveForMember(memberId, storeId, productId, body),
      saveBulkForMember: (memberId, storeId, body) => productsBulk.saveBulkForMember(memberId, storeId, body),
    },
    categories: {
      saveForMember: (memberId, storeId, categoryId, body) => category.saveForMember(memberId, storeId, categoryId, body),
    },
    priceChanges: {
      reviewForMember: (memberId, storeId, body) => priceChanges.reviewForMember(memberId, storeId, body),
      reviewPageForMember: (memberId, storeId, reviewId, page) => priceChanges.reviewPageForMember(memberId, storeId, reviewId, page),
      applyForMember: (memberId, storeId, body) => priceChanges.applyForMember(memberId, storeId, body),
    },
    categoryMoves: {
      acknowledgeForMember: (memberId, storeId, body) => categoryMoves.acknowledgeForMember(memberId, storeId, body),
    },
  };
}
