import { db, pool } from "../../../db";
import { createAllocationEngine } from "../../channels/allocation-engine.service";
import { createAuthorityAwareInventoryAtpService } from "../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { createInventoryChannelQuantityRuntimeService } from "../../inventory-planning/infrastructure/inventory-availability-runtime-publication.repository";
import { DropshipListingSettingsService } from "../application/dropship-listing-settings-service";
import { makeDropshipListingPreviewLogger, systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { ChannelAllocationDropshipAtpProvider } from "./dropship-atp.provider";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { PgDropshipListingSettingsRepository } from "./dropship-listing-settings.repository";
import { resolveDropshipOmsChannelIdWithClient } from "./dropship-order-intake.repository";

/**
 * Read-only: no wallet, provisioning, credentials, marketplace provider or
 * listing-job dependency. One service per process holds the views cache.
 * Stock comes from the same read-only quantity source the preview uses.
 */
export function createDropshipListingSettingsService(): DropshipListingSettingsService {
  const logger = makeDropshipListingPreviewLogger();
  return new DropshipListingSettingsService({
    repository: new PgDropshipListingSettingsRepository(undefined, (failure) => logger.warn({
      code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
      message: "The .ops cost read failed while listing settings were built.",
      context: failure,
    })),
    stock: {
      // Dropship quantity is the Dropship OMS channel's Channel Allocation result
      // (handoff Option B), computed over the authority-aware ATP reader.
      atp: new ChannelAllocationDropshipAtpProvider({
        allocationEngine: createAllocationEngine(db, createAuthorityAwareInventoryAtpService(pool)),
        runtimeQuantity: createInventoryChannelQuantityRuntimeService(pool),
        resolveDropshipOmsChannelId: () => resolveDropshipOmsChannelIdWithClient(pool),
      }),
      overrides: new PgDropshipListingPreviewRepository(),
    },
    clock: systemDropshipListingPreviewClock,
    logger,
  });
}
