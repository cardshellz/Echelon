import {
  DropshipOrderOpsService,
  makeDropshipOrderOpsLogger,
  systemDropshipOrderOpsClock,
} from "../application/dropship-order-ops-service";
import { PgDropshipOrderOpsRepository } from "./dropship-order-ops.repository";
import { runDropshipOrderProcessingIntake } from "./dropship-order-processing-runner";

export function createDropshipOrderOpsServiceFromEnv(): DropshipOrderOpsService {
  return new DropshipOrderOpsService({
    repository: new PgDropshipOrderOpsRepository(),
    processor: {
      processIntake: runDropshipOrderProcessingIntake,
    },
    clock: systemDropshipOrderOpsClock,
    logger: makeDropshipOrderOpsLogger(),
  });
}
