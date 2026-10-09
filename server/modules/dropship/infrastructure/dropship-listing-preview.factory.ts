import { db, pool } from "../../../db";
import { PgCatalogVariantMediaReader } from "../../catalog/catalog-media.reader";
import { createCatalogPublicImageUrl } from "../../catalog/catalog-public-image";
import { PgCatalogVariantPublicationPhotoReader } from "../../catalog/catalog-publication-images.reader";
import { createAllocationEngine } from "../../channels/allocation-engine.service";
import { resolveDropshipPublicationPreview } from "./dropship-listing-publication-preview.provider";
import { createAuthorityAwareInventoryAtpService } from "../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { createInventoryChannelQuantityRuntimeService } from "../../inventory-planning/infrastructure/inventory-availability-runtime-publication.repository";
import {
  DropshipListingPreviewService,
  makeDropshipListingPreviewLogger,
  systemDropshipListingPreviewClock,
} from "../application/dropship-listing-preview-service";
import { ChannelAllocationDropshipAtpProvider } from "./dropship-atp.provider";
import { resolveDropshipOmsChannelIdWithClient } from "./dropship-order-intake.repository";
import { ConfigDrivenDropshipMarketplaceListingProvider } from "./dropship-config-driven-marketplace-listing.provider";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { PgShellzClubProductCostAdapter } from "./shellz-club-product-cost.adapter";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createDropshipEbayFulfillmentPolicyGuardFromEnv } from "./dropship-ebay-fulfillment-policy-guard.factory";
import { getDropshipEbayReturnPaymentPolicyCheckerFromEnv } from "./dropship-ebay-return-payment-policy-check.factory";
import { createDropshipListingTierServiceFromEnv } from "./dropship-listing-tier.factory";

export function createDropshipListingPreviewServiceFromEnv(): DropshipListingPreviewService {
  const repository = new PgDropshipListingPreviewRepository();
  const logger = makeDropshipListingPreviewLogger();
  const productCosts = new PgShellzClubProductCostAdapter(pool, (context) => logger.warn({
    code: "DROPSHIP_PRODUCT_COST_SOURCE_UNAVAILABLE",
    message: "Shellz Club product pricing could not be read.", context,
  }));
  return new DropshipListingPreviewService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository,
    productCosts,
    // Uploaded photos publish at the catalog's public photo address
    // (CATALOG_PUBLIC_BASE_URL, see docs/WALMART_LISTING_PUBLICATION.md).
    listingPhotos: new PgCatalogVariantPublicationPhotoReader(pool, createCatalogPublicImageUrl(process.env)),
    presentation: {
      media: new PgCatalogVariantMediaReader(pool),
      productCosts,
      resolvePublication: resolveDropshipPublicationPreview,
      logger,
    },
    // Dropship quantity is the Dropship OMS channel's Channel Allocation result
    // (handoff Option B), computed over the authority-aware ATP reader.
    atp: new ChannelAllocationDropshipAtpProvider({
      allocationEngine: createAllocationEngine(db, createAuthorityAwareInventoryAtpService(pool)),
      runtimeQuantity: createInventoryChannelQuantityRuntimeService(pool),
      resolveDropshipOmsChannelId: () => resolveDropshipOmsChannelIdWithClient(pool),
    }),
    marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
    ebayFulfillmentPolicyGuard: createDropshipEbayFulfillmentPolicyGuardFromEnv(),
    ebayReturnPaymentPolicies: getDropshipEbayReturnPaymentPolicyCheckerFromEnv(),
    listingTiers: createDropshipListingTierServiceFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger,
  });
}
