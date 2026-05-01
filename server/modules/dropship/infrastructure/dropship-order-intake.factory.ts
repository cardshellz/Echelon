import {
  DropshipOrderIntakeService,
  makeDropshipOrderIntakeLogger,
  systemDropshipOrderIntakeClock,
} from "../application/dropship-order-intake-service";
import { PgDropshipOrderIntakeRepository } from "./dropship-order-intake.repository";

export function createDropshipOrderIntakeServiceFromEnv(): DropshipOrderIntakeService {
  return new DropshipOrderIntakeService({
    repository: new PgDropshipOrderIntakeRepository(),
    clock: systemDropshipOrderIntakeClock,
    logger: makeDropshipOrderIntakeLogger(),
  });
}
