import { performance } from "node:perf_hooks";
import { pool } from "../../../db";
import { logger } from "../../../platform/observability/logger";
import {
  createDropshipEbayQuantityRequestAdmission,
  quantityProviderResponseRecovery,
} from "../../inventory-planning/quantity-publication";
import { DropshipListingEndService, type ListingEndJobLog } from "../application/dropship-listing-end-service";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import { DropshipEbayListingEndAdapter } from "./dropship-ebay-listing-end.adapter";
import { RefreshingDropshipEbayRegistrationCredentialProvider } from "./dropship-ebay-registration-credentials";
import { PgDropshipListingEndRepository } from "./dropship-listing-end.repository";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv } from "./dropship-marketplace-registration.factory";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

/** The worker's lines through the platform logger (CLAUDE.md §10: one structured logger), which merges any correlation context. */
const platformJobLog: ListingEndJobLog = {
  debug: (action, fields) => logger.debug(action, fields),
  info: (action, fields) => logger.info(action, fields),
  warn: (action, fields) => logger.warn(action, fields),
  error: (action, fields) => logger.error(action, fields),
};

/**
 * The listing end worker's production wiring (PR C, PLAN-C v4.1 §5.1, §5.8): the repository on the shared pool, the
 * Dropship token owner over the credential repository, the Dropship registration factory's `inspector` (the shared
 * observer over Dropship's credential adapter), inventory planning's published recovery and Dropship admission, the
 * notification service, the preview clock and a monotonic timer. `DRY_RUN` is read once, here (§5.2 gate 1).
 */
export function createDropshipListingEndServiceFromEnv(environment: NodeJS.ProcessEnv = process.env): DropshipListingEndService {
  const credentialRepository = createDropshipMarketplaceCredentialRepositoryFromEnv();
  return new DropshipListingEndService({
    repository: new PgDropshipListingEndRepository(pool),
    provider: new DropshipEbayListingEndAdapter({
      credentials: RefreshingDropshipEbayRegistrationCredentialProvider.fromEnv(credentialRepository),
      credentialRepository,
      inspector: createDropshipMarketplaceRegistrationOwnerAdaptersFromEnv().inspector,
      recovery: quantityProviderResponseRecovery,
      createAdmission: createDropshipEbayQuantityRequestAdmission,
    }),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingPreviewClock,
    timer: () => performance.now(),
    log: platformJobLog,
    dryRun: environment.DRY_RUN === "true",
  });
}
