import { DropshipWalletService, makeDropshipWalletLogger, systemDropshipWalletClock } from "../application/dropship-wallet-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createStripeDropshipFundingProviderFromEnv } from "./dropship-stripe-funding.provider";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";

export function createDropshipWalletServiceFromEnv(): DropshipWalletService {
  return new DropshipWalletService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipWalletRepository(),
    fundingProvider: createStripeDropshipFundingProviderFromEnv(),
    clock: systemDropshipWalletClock,
    logger: makeDropshipWalletLogger(),
  });
}
