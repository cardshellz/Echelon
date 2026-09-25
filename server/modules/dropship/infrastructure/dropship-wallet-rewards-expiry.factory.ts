import {
  DropshipRewardsExpiryService,
  makeDropshipRewardsExpiryLogger,
  systemDropshipRewardsExpiryClock,
} from "../application/dropship-wallet-rewards-expiry-service";
import { PgDropshipWalletRepository } from "./dropship-wallet.repository";

export function createDropshipRewardsExpiryServiceFromEnv(): DropshipRewardsExpiryService {
  // The wallet repository is the one rewards writer: expiry moves the rewards
  // balance and its lots under the same wallet account lock as every other
  // rewards movement.
  return new DropshipRewardsExpiryService({
    repository: new PgDropshipWalletRepository(),
    clock: systemDropshipRewardsExpiryClock,
    logger: makeDropshipRewardsExpiryLogger(),
  });
}
