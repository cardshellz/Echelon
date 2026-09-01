import { db } from "../../../db";
import { createInventoryAtpService } from "../../inventory";
import {
  DropshipListingPreviewService,
  makeDropshipListingPreviewLogger,
  systemDropshipListingPreviewClock,
} from "../application/dropship-listing-preview-service";
import { InventoryServiceDropshipAtpProvider } from "./dropship-atp.provider";
import { ConfigDrivenDropshipMarketplaceListingProvider } from "./dropship-config-driven-marketplace-listing.provider";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createDropshipEbayFulfillmentPolicyGuardFromEnv } from "./dropship-ebay-fulfillment-policy-guard.factory";

export function createDropshipListingPreviewServiceFromEnv(): DropshipListingPreviewService {
  return new DropshipListingPreviewService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipListingPreviewRepository(),
    atp: new InventoryServiceDropshipAtpProvider(createInventoryAtpService(db)),
    marketplaceListing: new ConfigDrivenDropshipMarketplaceListingProvider(),
    ebayFulfillmentPolicyGuard: createDropshipEbayFulfillmentPolicyGuardFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger: makeDropshipListingPreviewLogger(),
  });
}
