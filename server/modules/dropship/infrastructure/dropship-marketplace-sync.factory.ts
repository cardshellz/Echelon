import { pool } from "../../../db";
import { logger } from "../../../platform/observability/logger";
import type { DropshipListingPreviewService } from "../application/dropship-listing-preview-service";
import { systemDropshipListingPreviewClock } from "../application/dropship-listing-preview-service";
import {
  DropshipMarketplaceSyncService,
  type MarketplaceSyncRestorePort,
} from "../application/dropship-marketplace-sync-service";
import { DropshipError } from "../domain/errors";
import { MARKETPLACE_SYNC_ACTOR } from "../domain/marketplace-sync-keys";
import { createDropshipEbayFulfillmentPolicyGuardFromEnv } from "./dropship-ebay-fulfillment-policy-guard.factory";
import { EbayDropshipListingPushProvider } from "./dropship-ebay-listing-push.provider";
import { createDropshipListingPreviewServiceFromEnv } from "./dropship-listing-preview.factory";
import { createDropshipMarketplaceCredentialRepositoryFromEnv } from "./dropship-marketplace-credentials";
import { PgMarketplaceQuantityBaselineReader } from "./dropship-marketplace-quantity-baseline.reader";
import { PgDropshipMarketplaceSyncRepository } from "./dropship-marketplace-sync.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";

/**
 * The restore push (plan v4 §6.4): an ordinary one-step push job of the
 * current preview, queued by the system under the sweep's key, as the cost
 * change reprice queues one (dropship-cost-change-listing-action.factory.ts).
 * A store that cannot take a push now (its access rule names the step that
 * lifts it) is reported as refused; anything else propagates.
 */
export function createMarketplaceSyncRestorePort(
  previews: Pick<DropshipListingPreviewService, "createListingPushJob">,
): MarketplaceSyncRestorePort {
  return {
    async queueRestore(input) {
      try {
        const created = await previews.createListingPushJob({
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
          productVariantIds: [...input.productVariantIds],
          reviewMode: "current_preview",
          idempotencyKey: input.idempotencyKey,
          requestedBy: { actorType: "system", actorId: MARKETPLACE_SYNC_ACTOR.actorId },
        });
        return { queued: true, jobId: created.job.jobId, idempotentReplay: created.idempotentReplay };
      } catch (error) {
        if (error instanceof DropshipError && typeof error.context?.resolution === "string") return { queued: false, code: error.code };
        throw error;
      }
    },
  };
}

/**
 * eBay sync-back's production wiring: the sync repository over the shared
 * pool (W9 as its price writer), the eBay provider for GET reads only (none of
 * the push's write collaborators: it never pushes), the listing preview as E
 * and ATP, the restore port, inventory planning's published quantity reader,
 * the fulfillment policy guard, the vendor notification service, the preview
 * clock and the platform logger.
 */
export function createDropshipMarketplaceSyncServiceFromEnv(): DropshipMarketplaceSyncService {
  const previews = createDropshipListingPreviewServiceFromEnv();
  return new DropshipMarketplaceSyncService({
    repository: new PgDropshipMarketplaceSyncRepository(pool),
    reader: new EbayDropshipListingPushProvider(createDropshipMarketplaceCredentialRepositoryFromEnv(), fetch, systemDropshipListingPreviewClock),
    previews: { generatePreview: (input) => previews.generatePreview(input) },
    restores: createMarketplaceSyncRestorePort(previews),
    baselines: new PgMarketplaceQuantityBaselineReader(pool),
    policyGuard: createDropshipEbayFulfillmentPolicyGuardFromEnv(),
    notifications: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingPreviewClock,
    logger: {
      debug: (action, data) => logger.debug(action, data),
      info: (action, data) => logger.info(action, data),
      warn: (action, data) => logger.warn(action, data),
      error: (action, data) => logger.error(action, data),
    },
  });
}
