import {
  makeDropshipCostChangePolicyLogger,
  systemDropshipCostChangePolicyClock,
} from "../application/dropship-cost-change-policy-service";
import { DropshipCostDetectionService } from "../application/dropship-cost-detection-service";
import { isDropshipCostDetectionWorkerEnabled } from "./dropship-cost-detection-config";
import { createDropshipCostChangePolicyServiceFromEnv } from "./dropship-cost-change-policy.factory";
import { PgDropshipCostScheduleRepository } from "./dropship-cost-schedule.repository";

export function createDropshipCostDetectionServiceFromEnv(): DropshipCostDetectionService {
  return new DropshipCostDetectionService({
    repository: new PgDropshipCostScheduleRepository(),
    policy: createDropshipCostChangePolicyServiceFromEnv(),
    clock: systemDropshipCostChangePolicyClock,
    logger: makeDropshipCostChangePolicyLogger(),
    workerEnabled: isDropshipCostDetectionWorkerEnabled(),
  });
}
