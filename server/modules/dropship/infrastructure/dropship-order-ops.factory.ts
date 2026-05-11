import {
  DropshipOrderOpsService,
  makeDropshipOrderOpsLogger,
  systemDropshipOrderOpsClock,
} from "../application/dropship-order-ops-service";
import { getDropshipFulfillmentSync } from "./dropship-fulfillment-sync.registry";
import { createDropshipFulfillmentSyncRetryQueueFromEnv } from "./dropship-fulfillment-sync-retry-queue";
import { PgDropshipOrderOpsRepository } from "./dropship-order-ops.repository";
import { runDropshipOrderProcessingIntake } from "./dropship-order-processing-runner";

export function createDropshipOrderOpsServiceFromEnv(): DropshipOrderOpsService {
  return new DropshipOrderOpsService({
    repository: new PgDropshipOrderOpsRepository(),
    processor: {
      processIntake: runDropshipOrderProcessingIntake,
    },
    fulfillmentSync: getDropshipFulfillmentSync(),
    fulfillmentSyncRetryQueue: createDropshipFulfillmentSyncRetryQueueFromEnv(),
    clock: systemDropshipOrderOpsClock,
    logger: makeDropshipOrderOpsLogger(),
  });
}
