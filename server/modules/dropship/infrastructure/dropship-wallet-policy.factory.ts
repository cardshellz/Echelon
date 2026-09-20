import {
  DropshipWalletPolicyService,
  makeDropshipWalletPolicyLogger,
  systemDropshipWalletPolicyClock,
} from "../application/dropship-wallet-policy-service";
import { PgDropshipVendorCreditProfileRepository } from "./dropship-vendor-credit-profile.repository";
import { PgDropshipWalletPolicyRepository } from "./dropship-wallet-policy.repository";

export function createDropshipWalletPolicyServiceFromEnv(): DropshipWalletPolicyService {
  return new DropshipWalletPolicyService({
    repository: new PgDropshipWalletPolicyRepository(),
    creditProfiles: new PgDropshipVendorCreditProfileRepository(),
    clock: systemDropshipWalletPolicyClock,
    logger: makeDropshipWalletPolicyLogger(),
  });
}
