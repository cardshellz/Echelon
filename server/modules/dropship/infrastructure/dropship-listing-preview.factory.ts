import { pool } from "../../../db";
import { PgCatalogVariantMediaReader } from "../../catalog/catalog-media.reader";
import { resolveDropshipPublicationPreview } from "./dropship-listing-publication-preview.provider";
import { createAuthorityAwareInventoryAtpService } from "../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import {
  DropshipListingPreviewService,
  makeDropshipListingPreviewLogger,
  systemDropshipListingPreviewClock,
} from "../application/dropship-listing-preview-service";
import { InventoryServiceDropshipAtpProvider } from "./dropship-atp.provider";
import { ConfigDrivenDropshipMarketplaceListingProvider } from "./dropship-config-driven-marketplace-listing.provider";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createDropshipEbayFulfillmentPolicyGuardFromEnv } from "./dropship-ebay-fulfillment-policy-guard.factory";

export function createDropshipListingPreviewServiceFromEnv(): DropshipListingPreviewService {
  const repository = new PgDropshipListingPreviewRepository();
  const logger = makeDropshipListingPreviewLogger();
  return new DropshipListingPreviewService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository,
    presentation: {
      media: new PgCatalogVariantMediaReader(pool),
      productCosts: new PgShellzClubProductCostAdapter(pool, (context) => logger.warn({
        code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
        message: "Shellz Club product pricing could not be read.", context,
      })),
      resolvePublication: resolveDropshipPublicationPreview,
      logger,
    },
    atp: new InventoryServiceDropshipAtpProvider(createAuthorityAwareInventoryAtpService(pool)),
    marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
    ebayFulfillmentPolicyGuard: createDropshipEbayFulfillmentPolicyGuardFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger,
  });
}
