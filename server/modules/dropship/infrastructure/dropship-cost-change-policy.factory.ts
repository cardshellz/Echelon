import {
  DropshipCostChangePolicyService,
  makeDropshipCostChangePolicyLogger,
  resolveDropshipCostChangeEnforcement,
  systemDropshipCostChangePolicyClock,
} from "../application/dropship-cost-change-policy-service";
import { isDropshipCostDetectionWorkerEnabled } from "./dropship-cost-detection-config";
import { PgDropshipCostChangePolicyRepository } from "./dropship-cost-change-policy.repository";

export function createDropshipCostChangePolicyServiceFromEnv(): DropshipCostChangePolicyService {
  return new DropshipCostChangePolicyService({
    repository: new PgDropshipCostChangePolicyRepository(),
    clock: systemDropshipCostChangePolicyClock,
    logger: makeDropshipCostChangePolicyLogger(),
    enforcement: resolveDropshipCostChangeEnforcement({ detectionWorkerEnabled: isDropshipCostDetectionWorkerEnabled() }),
  });
}
