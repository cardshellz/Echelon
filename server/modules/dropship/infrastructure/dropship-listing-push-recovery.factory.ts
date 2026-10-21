import {
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { DropshipListingPushRecoveryService } from "../application/dropship-listing-push-recovery-service";
import { PgDropshipListingLiveStatusRepairRepository } from "./dropship-listing-live-status-repair.repository";
import { PgDropshipListingPushOpsRepository } from "./dropship-listing-push-ops.repository";

/** The recovery the scheduled listing push sweep runs under its advisory lock before it claims jobs. */
export function createDropshipListingPushRecoveryFromEnv(): DropshipListingPushRecoveryService {
  return new DropshipListingPushRecoveryService({
    liveStatusRepair: new PgDropshipListingLiveStatusRepairRepository(),
    accountVerificationRequeue: new PgDropshipListingPushOpsRepository(),
    clock: systemDropshipListingPushWorkerClock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
