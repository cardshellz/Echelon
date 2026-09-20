import { DropshipWalletService, makeDropshipWalletLogger, systemDropshipWalletClock } from "../application/dropship-wallet-service";
import { createDropshipVendorProvisioningServiceFromEnv } from "./dropship-vendor-provisioning.factory";
import { createStripeDropshipFundingProviderFromEnv } from "./dropship-stripe-funding.provider";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipVendorStandingServiceFromEnv } from "./dropship-vendor-standing.factory";
import { createDropshipWalletPolicyServiceFromEnv } from "./dropship-wallet-policy.factory";
import { PgDropshipUsdcDepositRepository } from "./dropship-usdc-deposit.repository";
import { BASE_MAINNET_CHAIN_ID } from "../domain/usdc-deposits";

export function createDropshipWalletServiceFromEnv(): DropshipWalletService {
  const usdcDepositRepository = new PgDropshipUsdcDepositRepository();
  return new DropshipWalletService({
    vendorProvisioning: createDropshipVendorProvisioningServiceFromEnv(),
    repository: new PgDropshipWalletRepository(),
    fundingProvider: createStripeDropshipFundingProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    vendorStanding: createDropshipVendorStandingServiceFromEnv(),
    // Staff-managed limits (migration 0681). The service falls back to the
    // documented environment values when no policy row exists.
    walletPolicy: createDropshipWalletPolicyServiceFromEnv(),
    // A manual USDC credit must name the vendor's own deposit address
    // (funding design phase 6) or the shared one; the lookup is the address
    // book's, read-only.
    usdcDepositAddressLookup: async (vendorId) =>
      (await usdcDepositRepository.findDepositAddress({ vendorId, chainId: BASE_MAINNET_CHAIN_ID }))?.address ?? null,
    clock: systemDropshipWalletClock,
    logger: makeDropshipWalletLogger(),
  });
}
