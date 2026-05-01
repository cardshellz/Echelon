import {
  DropshipVendorProvisioningService,
  makeDropshipVendorProvisioningLogger,
  systemDropshipVendorProvisioningClock,
} from "../application/dropship-vendor-provisioning-service";
import { ShellzClubEntitlementAdapter } from "./shellz-club-entitlement.adapter";
import { PgDropshipVendorProvisioningRepository } from "./dropship-vendor-provisioning.repository";

export function createDropshipVendorProvisioningServiceFromEnv(): DropshipVendorProvisioningService {
  const entitlementAdapter = new ShellzClubEntitlementAdapter();
  return new DropshipVendorProvisioningService({
    entitlement: entitlementAdapter,
    repository: new PgDropshipVendorProvisioningRepository(),
    clock: systemDropshipVendorProvisioningClock,
    logger: makeDropshipVendorProvisioningLogger(),
  });
}
