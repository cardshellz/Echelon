import {
  DropshipOrderRejectionService,
  makeDropshipOrderRejectionLogger,
  systemDropshipOrderRejectionClock,
} from "../application/dropship-order-rejection-service";
import { PgDropshipOrderRejectionRepository } from "./dropship-order-rejection.repository";

export function createDropshipOrderRejectionServiceFromEnv(): DropshipOrderRejectionService {
  return new DropshipOrderRejectionService({
    repository: new PgDropshipOrderRejectionRepository(),
    clock: systemDropshipOrderRejectionClock,
    logger: makeDropshipOrderRejectionLogger(),
  });
}
