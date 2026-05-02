import {
  DropshipOrderOpsService,
  makeDropshipOrderOpsLogger,
  systemDropshipOrderOpsClock,
} from "../application/dropship-order-ops-service";
import { PgDropshipOrderOpsRepository } from "./dropship-order-ops.repository";

export function createDropshipOrderOpsServiceFromEnv(): DropshipOrderOpsService {
  return new DropshipOrderOpsService({
    repository: new PgDropshipOrderOpsRepository(),
    clock: systemDropshipOrderOpsClock,
    logger: makeDropshipOrderOpsLogger(),
  });
}
