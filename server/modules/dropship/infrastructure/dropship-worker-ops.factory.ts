import {
  DropshipWorkerOpsService,
  makeDropshipWorkerOpsLogger,
  systemDropshipWorkerOpsClock,
  type DropshipWorkerSweepName,
  type DropshipWorkerSweepRunner,
} from "../application/dropship-worker-ops-service";
import { runDropshipEbayOrderIntakeSweep } from "./dropship-ebay-order-intake-runner";
import { runAdminListingPushSweep } from "./dropship-listing-push-job-runner";
import { runDropshipOrderProcessingSweep } from "./dropship-order-processing-runner";
import { PgDropshipWorkerOpsRepository } from "./dropship-worker-ops.repository";

export function createDropshipWorkerOpsServiceFromEnv(): DropshipWorkerOpsService {
  return new DropshipWorkerOpsService({
    repository: new PgDropshipWorkerOpsRepository(),
    runners: createDropshipWorkerSweepRunners(),
    clock: systemDropshipWorkerOpsClock,
    logger: makeDropshipWorkerOpsLogger(),
  });
}

export function createDropshipWorkerSweepRunners(): Record<DropshipWorkerSweepName, DropshipWorkerSweepRunner> {
  return {
    listing_push: {
      // The publish run steps take the scheduled sweep's lock (review MC5, CT2); jobs are processed as before.
      run: ({ workerId, batchSize }) => runAdminListingPushSweep({ workerId, batchSize }),
    },
    order_processing: {
      run: ({ workerId, batchSize }) => runDropshipOrderProcessingSweep({ workerId, batchSize }),
    },
    ebay_order_intake: {
      run: async ({ batchSize }) => {
        const result = await runDropshipEbayOrderIntakeSweep({ batchSize });
        return {
          storesScanned: result.storesScanned,
          storesSucceeded: result.storesSucceeded,
          storesFailed: result.storesFailed,
          ordersCreated: result.ordersCreated,
          ordersUpdated: result.ordersUpdated,
          ordersReplayed: result.ordersReplayed,
          ordersRejected: result.ordersRejected,
          ordersIgnored: result.ordersIgnored,
          ordersConflicted: result.ordersConflicted,
        };
      },
    },
  };
}
