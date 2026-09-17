import { DropshipWalletService, makeDropshipWalletLogger, systemDropshipWalletClock } from "../application/dropship-wallet-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createStripeDropshipFundingProviderFromEnv } from "./dropship-stripe-funding.provider";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipVendorStandingServiceFromEnv } from "./dropship-vendor-standing.factory";

export function createDropshipWalletServiceFromEnv(): DropshipWalletService {
  return new DropshipWalletService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipWalletRepository(),
    fundingProvider: createStripeDropshipFundingProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    vendorStanding: createDropshipVendorStandingServiceFromEnv(),
    clock: systemDropshipWalletClock,
    logger: makeDropshipWalletLogger(),
  });
}
