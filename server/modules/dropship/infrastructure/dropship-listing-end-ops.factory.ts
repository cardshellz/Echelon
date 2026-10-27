import { pool } from "../../../db";
import { logger } from "../../../platform/observability/logger";
import { quantityProviderResponseRecovery } from "../../inventory-planning/quantity-publication";
import { DropshipListingEndOpsService, type ListingEndOpsLog } from "../application/dropship-listing-end-ops-service";
import { PgDropshipListingEndOpsRepository } from "./dropship-listing-end-ops.repository";

/** The staff surface's lines through the platform logger (CLAUDE.md §10: one structured logger). */
const platformLog: ListingEndOpsLog = {
  debug: (action, fields) => logger.debug(action, fields),
  info: (action, fields) => logger.info(action, fields),
};

/**
 * The staff surface's production wiring (PR C, PLAN-C v4.1 §10): the repository on the shared pool, inventory
 * planning's published response recovery (Retry's recovery check, SAF-3 b), the wall clock (injected here, the
 * composition root) and the platform logger.
 */
export function createDropshipListingEndOpsServiceFromEnv(): DropshipListingEndOpsService {
  return new DropshipListingEndOpsService({
    repository: new PgDropshipListingEndOpsRepository(pool),
    recovery: quantityProviderResponseRecovery,
    clock: { now: () => new Date() },
    log: platformLog,
  });
}
