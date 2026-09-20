import { DropshipWalletService, makeDropshipWalletLogger, systemDropshipWalletClock } from "../application/dropship-wallet-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createStripeDropshipFundingProviderFromEnv } from "./dropship-stripe-funding.provider";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipVendorStandingServiceFromEnv } from "./dropship-vendor-standing.factory";
import { createDropshipWalletPolicyServiceFromEnv } from "./dropship-wallet-policy.factory";

export function createDropshipWalletServiceFromEnv(): DropshipWalletService {
  return new DropshipWalletService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipWalletRepository(),
    fundingProvider: createStripeDropshipFundingProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    vendorStanding: createDropshipVendorStandingServiceFromEnv(),
    // Staff-managed limits (migration 0681). The service falls back to the
    // documented environment values when no policy row exists.
    walletPolicy: createDropshipWalletPolicyServiceFromEnv(),
    clock: systemDropshipWalletClock,
    logger: makeDropshipWalletLogger(),
  });
}
