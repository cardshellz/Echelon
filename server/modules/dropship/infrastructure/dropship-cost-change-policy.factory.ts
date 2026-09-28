import {
  DropshipCostChangePolicyService,
  makeDropshipCostChangePolicyLogger,
  systemDropshipCostChangePolicyClock,
} from "../application/dropship-cost-change-policy-service";
import { PgDropshipCostChangePolicyRepository } from "./dropship-cost-change-policy.repository";

export function createDropshipCostChangePolicyServiceFromEnv(): DropshipCostChangePolicyService {
  return new DropshipCostChangePolicyService({
    repository: new PgDropshipCostChangePolicyRepository(),
    clock: systemDropshipCostChangePolicyClock,
    logger: makeDropshipCostChangePolicyLogger(),
  });
}
