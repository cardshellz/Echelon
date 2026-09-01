import { DropshipEbayListingPolicyOverrideService } from "../application/dropship-ebay-listing-policy-override-service";
import {
  makeDropshipListingPreviewLogger,
  systemDropshipListingPreviewClock,
} from "../application/dropship-listing-preview-service";
import { createDropshipEbayListingSetupServiceFromEnv } from "./dropship-ebay-listing-setup.factory";
import { PgDropshipEbayListingPolicyOverrideRepository } from "./dropship-ebay-listing-policy-override.repository";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";

export function createDropshipEbayListingPolicyOverrideServiceFromEnv(): DropshipEbayListingPolicyOverrideService {
  return new DropshipEbayListingPolicyOverrideService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipEbayListingPolicyOverrideRepository(),
    listingSetup: createDropshipEbayListingSetupServiceFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger: makeDropshipListingPreviewLogger(),
  });
}
