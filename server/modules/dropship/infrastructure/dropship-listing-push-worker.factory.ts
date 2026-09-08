import {
  DropshipListingPushWorkerService,
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { createDropshipMarketplaceListingPushProviderFromEnv } from "./dropship-marketplace-listing-push.providers";
import { PgDropshipListingPushWorkerRepository } from "./dropship-listing-push-worker.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipListingPreviewServiceFromEnv } from "./dropship-listing-preview.factory";
import { DropshipError } from "../domain/errors";

export function createDropshipListingPushWorkerServiceFromEnv(): DropshipListingPushWorkerService {
  return new DropshipListingPushWorkerService({
    refreshListingIntent: async (input) => {
      const preview = await createDropshipListingPreviewServiceFromEnv().generatePreview({
        vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, productVariantIds: [input.productVariantId],
        actor: { actorType: "system", actorId: "inventory_publication_catchup" },
      });
      const row = preview.rows.find(candidate => candidate.productVariantId === input.productVariantId);
      if (!row?.listingIntent || row.previewStatus === "blocked") throw new DropshipError(
        "DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED", "Current listing rules do not authorize this queued publication.",
        { productVariantId: input.productVariantId, retryable: true });
      return row.listingIntent;
    },
    repository: new PgDropshipListingPushWorkerRepository(),
    marketplacePush: createDropshipMarketplaceListingPushProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingPushWorkerClock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
