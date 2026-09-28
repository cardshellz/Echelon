import {
  DropshipListingPushWorkerService,
  makeDropshipListingPushWorkerLogger,
  systemDropshipListingPushWorkerClock,
} from "../application/dropship-listing-push-worker-service";
import { createDropshipMarketplaceListingPushProviderFromEnv } from "./dropship-marketplace-listing-push.providers";
import { PgDropshipListingPushWorkerRepository } from "./dropship-listing-push-worker.repository";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { createDropshipListingPreviewServiceFromEnv } from "./dropship-listing-preview.factory";
import { createDropshipCostChangePolicyServiceFromEnv } from "./dropship-cost-change-policy.factory";
import { DropshipError } from "../domain/errors";
import { decideQueuedRulePricePublication } from "../domain/cost-change-listing-action";

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
      // A queued push publishes the price computed now, not the one the vendor
      // saw. Under "wait for review" a rule price that moved since queueing is
      // the vendor's to review, so the push fails for good instead (C5).
      const policy = await createDropshipCostChangePolicyServiceFromEnv().resolvePolicy();
      const verdict = decideQueuedRulePricePublication({
        rulePriced: typeof row.rulePriceEvidenceHash === "string",
        queuedPriceCents: input.queuedPriceCents,
        currentPriceCents: row.listingIntent.priceCents,
        rulePricedListings: policy.settings.rulePricedListings,
      });
      if (!verdict.publish) throw new DropshipError(
        "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW",
        "The listing's rule price changed since it was queued and the cost change policy waits for the vendor's review. Queue it again from the Catalog page.",
        { productVariantId: input.productVariantId, queuedPriceCents: input.queuedPriceCents, currentPriceCents: row.listingIntent.priceCents,
          retryable: false, classification: "permanent" });
      return row.listingIntent;
    },
    repository: new PgDropshipListingPushWorkerRepository(),
    marketplacePush: createDropshipMarketplaceListingPushProviderFromEnv(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipListingPushWorkerClock,
    logger: makeDropshipListingPushWorkerLogger(),
  });
}
