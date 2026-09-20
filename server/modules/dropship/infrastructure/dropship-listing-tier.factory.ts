import {
  DropshipListingTierService,
  makeDropshipListingTierLogger,
  systemDropshipListingTierClock,
  type DropshipListingTierFundingReader,
  type DropshipVendorListingTierFundingSnapshot,
} from "../application/dropship-listing-tier-service";
import type { DropshipClock } from "../application/dropship-ports";
import type { DropshipWalletRepository } from "../application/dropship-wallet-service";
import { createDropshipListingVariantHoldGateFromEnv } from "./dropship-listing-variant-hold.gate";
import { PgDropshipListingTierRepository } from "./dropship-listing-tier.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipWalletPolicyServiceFromEnv } from "./dropship-wallet-policy.factory";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";

/**
 * The wallet facts the listing tiers are decided from, read from the wallet
 * repository rather than the wallet service so the tier service can also be
 * consulted by surfaces the wallet service serves.
 */
export class WalletRepositoryListingTierFundingReader implements DropshipListingTierFundingReader {
  constructor(
    private readonly deps: {
      walletRepository: Pick<DropshipWalletRepository, "getOverview">;
      clock: DropshipClock;
    },
  ) {}

  async readTierFunding(vendorId: number): Promise<DropshipVendorListingTierFundingSnapshot> {
    const overview = await this.deps.walletRepository.getOverview({
      vendorId,
      ledgerLimit: 1,
      now: this.deps.clock.now(),
    });
    return {
      minimumBalanceCents: overview.autoReload?.enabled ? overview.autoReload.minimumBalanceCents : null,
      availableBalanceCents: overview.account.availableBalanceCents,
      pendingBalanceCents: overview.account.pendingBalanceCents,
      currency: overview.account.currency,
    };
  }
}

export function createDropshipListingTierServiceFromEnv(): DropshipListingTierService {
  return new DropshipListingTierService({
    repository: new PgDropshipListingTierRepository(),
    funding: new WalletRepositoryListingTierFundingReader({
      walletRepository: new PgDropshipWalletRepository(),
      clock: systemDropshipListingTierClock,
    }),
    policy: createDropshipWalletPolicyServiceFromEnv(),
    variantHolds: createDropshipListingVariantHoldGateFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingTierClock,
    logger: makeDropshipListingTierLogger(),
  });
}
