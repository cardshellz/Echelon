import { logger } from "../../../platform/observability/logger";
import { DropshipFinanceService, systemDropshipFinanceClock } from "../application/dropship-finance-service";
import { PgDropshipFinanceRepository } from "./dropship-finance.repository";

/**
 * The Program finance service on the shared pool, the system clock and the
 * platform JSON logger. The repository's request-budget clock is the system
 * clock too; the process-wide semaphore bounds concurrent snapshots.
 */
export function createDropshipFinanceServiceFromEnv(): DropshipFinanceService {
  return new DropshipFinanceService({
    repository: new PgDropshipFinanceRepository(),
    clock: systemDropshipFinanceClock,
    logger,
  });
}
