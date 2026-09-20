import {
  DropshipWalletPolicyService,
  makeDropshipWalletPolicyLogger,
  systemDropshipWalletPolicyClock,
} from "../application/dropship-wallet-policy-service";
import { PgDropshipWalletPolicyRepository } from "./dropship-wallet-policy.repository";

export function createDropshipWalletPolicyServiceFromEnv(): DropshipWalletPolicyService {
  return new DropshipWalletPolicyService({
    repository: new PgDropshipWalletPolicyRepository(),
    clock: systemDropshipWalletPolicyClock,
    logger: makeDropshipWalletPolicyLogger(),
  });
}
