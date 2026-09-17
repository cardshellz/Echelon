import {
  DropshipVendorStandingService,
  makeDropshipVendorStandingLogger,
  systemDropshipVendorStandingClock,
  type DropshipVendorFundingStandingReader,
} from "../application/dropship-vendor-standing-service";
import type { DropshipVendorFundingStanding } from "../domain/vendor-standing";
import type { DropshipWalletRepository } from "../application/dropship-wallet-service";
import type { DropshipClock } from "../application/dropship-ports";
import { createDropshipListingHoldGateFromEnv } from "./dropship-listing-hold.gate";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipVendorStandingRepository } from "./dropship-vendor-standing.repository";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";

/**
 * The funding figures standing needs, read from the wallet repository rather
 * than the wallet service: the wallet service calls standing after every
 * settled credit, so standing must not depend on it.
 */
export class WalletRepositoryFundingStandingReader implements DropshipVendorFundingStandingReader {
  constructor(
    private readonly deps: {
      walletRepository: Pick<DropshipWalletRepository, "getOverview">;
      clock: DropshipClock;
    },
  ) {}

  async readFundingStanding(vendorId: number): Promise<DropshipVendorFundingStanding> {
    const overview = await this.deps.walletRepository.getOverview({
      vendorId,
      ledgerLimit: 1,
      now: this.deps.clock.now(),
    });
    return {
      availableBalanceCents: overview.account.availableBalanceCents,
      minimumBalanceCents: overview.autoReload?.enabled ? overview.autoReload.minimumBalanceCents : null,
      currency: overview.account.currency,
    };
  }
}

export function createDropshipVendorStandingServiceFromEnv(): DropshipVendorStandingService {
  return new DropshipVendorStandingService({
    repository: new PgDropshipVendorStandingRepository(),
    funding: new WalletRepositoryFundingStandingReader({
      walletRepository: new PgDropshipWalletRepository(),
      clock: systemDropshipVendorStandingClock,
    }),
    listingHolds: createDropshipListingHoldGateFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipVendorStandingClock,
    logger: makeDropshipVendorStandingLogger(),
  });
}
