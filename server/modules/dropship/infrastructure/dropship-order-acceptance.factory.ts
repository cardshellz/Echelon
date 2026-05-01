import {
  DropshipOrderAcceptanceService,
  makeDropshipOrderAcceptanceLogger,
  systemDropshipOrderAcceptanceClock,
} from "../application/dropship-order-acceptance-service";
import { PgDropshipOrderAcceptanceRepository } from "./dropship-order-acceptance.repository";

export function createDropshipOrderAcceptanceServiceFromEnv(): DropshipOrderAcceptanceService {
  return new DropshipOrderAcceptanceService({
    repository: new PgDropshipOrderAcceptanceRepository(),
    clock: systemDropshipOrderAcceptanceClock,
    logger: makeDropshipOrderAcceptanceLogger(),
  });
}
