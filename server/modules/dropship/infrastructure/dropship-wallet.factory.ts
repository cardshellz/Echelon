import { DropshipWalletService, makeDropshipWalletLogger, systemDropshipWalletClock } from "../application/dropship-wallet-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";

export function createDropshipWalletServiceFromEnv(): DropshipWalletService {
  return new DropshipWalletService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipWalletRepository(),
    clock: systemDropshipWalletClock,
    logger: makeDropshipWalletLogger(),
  });
}
