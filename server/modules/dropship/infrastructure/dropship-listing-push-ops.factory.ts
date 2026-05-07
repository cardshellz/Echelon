import {
  DropshipListingPushOpsService,
  makeDropshipListingPushOpsLogger,
  systemDropshipListingPushOpsClock,
} from "../application/dropship-listing-push-ops-service";
import { PgDropshipListingPushOpsRepository } from "./dropship-listing-push-ops.repository";

export function createDropshipListingPushOpsServiceFromEnv(): DropshipListingPushOpsService {
  return new DropshipListingPushOpsService({
    repository: new PgDropshipListingPushOpsRepository(),
    logger: makeDropshipListingPushOpsLogger(),
    clock: systemDropshipListingPushOpsClock,
  });
}
