import {
  DropshipTrackingPushOpsService,
  makeDropshipTrackingPushOpsLogger,
} from "../application/dropship-tracking-push-ops-service";
import { PgDropshipTrackingPushOpsRepository } from "./dropship-tracking-push-ops.repository";

export function createDropshipTrackingPushOpsServiceFromEnv(): DropshipTrackingPushOpsService {
  return new DropshipTrackingPushOpsService({
    repository: new PgDropshipTrackingPushOpsRepository(),
    logger: makeDropshipTrackingPushOpsLogger(),
  });
}
