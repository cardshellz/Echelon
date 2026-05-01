import {
  DropshipListingConfigService,
  makeDropshipListingConfigLogger,
  systemDropshipListingConfigClock,
} from "../application/dropship-listing-config-service";
import { PgDropshipListingConfigRepository } from "./dropship-listing-config.repository";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";

export function createDropshipListingConfigServiceFromEnv(): DropshipListingConfigService {
  return new DropshipListingConfigService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipListingConfigRepository(),
    clock: systemDropshipListingConfigClock,
    logger: makeDropshipListingConfigLogger(),
  });
}
