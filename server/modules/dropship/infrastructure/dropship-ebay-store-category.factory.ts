import {
  DropshipEbayStoreCategoryService,
} from "../application/dropship-ebay-store-category-service";
import {
  makeDropshipListingPreviewLogger,
  systemDropshipListingPreviewClock,
} from "../application/dropship-listing-preview-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createDropshipEbayRegistrationCredentialProviderFromEnv } from "./dropship-ebay-registration-credentials";
import { EbayDropshipStoreCategoryDirectory } from "./dropship-ebay-store-category.directory";
import { PgDropshipEbayStoreCategoryRepository } from "./dropship-ebay-store-category.repository";

export function createDropshipEbayStoreCategoryServiceFromEnv(): DropshipEbayStoreCategoryService {
  return new DropshipEbayStoreCategoryService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipEbayStoreCategoryRepository(),
    directory: new EbayDropshipStoreCategoryDirectory(
      createDropshipEbayRegistrationCredentialProviderFromEnv(),
    ),
    clock: systemDropshipListingPreviewClock,
    logger: makeDropshipListingPreviewLogger(),
  });
}
