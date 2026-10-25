import {
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { DropshipListingPushRecoveryService } from "../application/dropship-listing-push-recovery-service";
import { PgDropshipListingLiveStatusRepairRepository } from "./dropship-listing-live-status-repair.repository";
import { PgDropshipListingPushOpsRepository } from "./dropship-listing-push-ops.repository";
import { AUTOMATIC_REQUEUE_BATCH_SIZE } from "../domain/listing-push-automatic-requeue";

/** The recovery the scheduled listing push sweep runs under its advisory lock before it claims jobs. */
export function createDropshipListingPushRecoveryFromEnv(): DropshipListingPushRecoveryService {
  const operations = new PgDropshipListingPushOpsRepository();
  return new DropshipListingPushRecoveryService({
    liveStatusRepair: new PgDropshipListingLiveStatusRepairRepository(),
    accountVerificationRequeue: operations,
    // Fix PR 2a-2: transient stock link failures and the one-time Q4 re-send.
    stockLinkRequeue: operations,
    stockLinkBatchSize: AUTOMATIC_REQUEUE_BATCH_SIZE,
    clock: systemDropshipListingPushWorkerClock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
