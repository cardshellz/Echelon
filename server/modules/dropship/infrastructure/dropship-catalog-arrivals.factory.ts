import { randomInt } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logger } from "../../../platform/observability/logger";
import { DropshipCatalogArrivalsService, type CatalogJobLog } from "../application/dropship-catalog-arrivals-service";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { seededJitterSource } from "../application/dropship-selection-change-service";
import { DropshipSelectionConversionFollowUp } from "../application/dropship-selection-conversion-followup";
import { catalogChooseUrl } from "../domain/catalog-arrivals";
import { PgDropshipCatalogArrivalsRepository } from "./dropship-catalog-arrivals.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipSelectionConversionFollowUpRepository } from "./dropship-selection-conversion-followup.repository";

/** The job's lines through the platform logger (CLAUDE.md §10: one structured logger), which merges any correlation context. */
const platformJobLog: CatalogJobLog = {
  debug: (action, fields) => logger.debug(action, fields),
  info: (action, fields) => logger.info(action, fields),
  warn: (action, fields) => logger.warn(action, fields),
  error: (action, fields) => logger.error(action, fields),
};

/**
 * The arrivals job's production wiring (PLAN-B v4.1 §11): both repositories
 * on the shared pool, one notification service for the email and the
 * conversion notice, the preview clock, a monotonic timer for `elapsed_ms`,
 * the platform logger, real waits between the follow-up's attempts with a
 * seeded jitter (as the picks save's composition root), and step 1's address from the portal URL
 * (`DROPSHIP_PORTAL_URL || VENDOR_PORTAL_URL`, as dropship-wallet.routes.ts).
 */
export function createDropshipCatalogArrivalsServiceFromEnv(environment: NodeJS.ProcessEnv = process.env): DropshipCatalogArrivalsService {
  const notifications = createDropshipNotificationServiceFromEnv();
  const followUp = new DropshipSelectionConversionFollowUp({
    repository: new PgDropshipSelectionConversionFollowUpRepository(),
    notifications,
    log: platformJobLog,
    sleep: (delayMs) => new Promise<void>((resolve) => { setTimeout(resolve, delayMs); }),
    // The jitter's seed is drawn once per process here, at the composition root; the follow-up never reads randomness.
    random: seededJitterSource(randomInt(0, 2 ** 31 - 1)),
  });
  return new DropshipCatalogArrivalsService({
    repository: new PgDropshipCatalogArrivalsRepository(),
    notifications,
    followUp,
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    log: platformJobLog,
    catalogUrl: catalogChooseUrl(environment.DROPSHIP_PORTAL_URL || environment.VENDOR_PORTAL_URL),
  });
}
