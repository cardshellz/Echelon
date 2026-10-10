import { decideQueuedRulePricePublication } from "../domain/cost-change-listing-action";
import { DropshipError } from "../domain/errors";
import type { DropshipCostChangePolicyInForce } from "./dropship-cost-change-policy-service";
import type { DropshipListingPreviewResult } from "./dropship-listing-preview-service";
import type { DropshipListingIntentRefreshInput } from "./dropship-listing-push-worker-service";
import type { DropshipMarketplaceListingIntent } from "./dropship-marketplace-listing-provider";
import type { DropshipLogger } from "./dropship-ports";
import type { GenerateVendorListingPreviewInput } from "./dropship-use-case-dtos";

/** The actor the push-time preview is built as. */
const PUSH_TIME_REFRESH_ACTOR = { actorType: "system", actorId: "inventory_publication_catchup" } as const;

export interface QueuedListingIntentRefreshDependencies {
  generatePreview: (input: GenerateVendorListingPreviewInput) => Promise<DropshipListingPreviewResult>;
  resolveCostChangePolicy: () => Promise<DropshipCostChangePolicyInForce>;
  logger: DropshipLogger;
}

/**
 * Rebuilds a queued listing's intent at push time from the rules in force now.
 * - Quantity, content, price and eBay category come from a fresh preview.
 * - The eBay category is the one the rules name now. When they name none, the
 *   one the listing was queued with is kept, so a changed category never fails
 *   a push (owner decision).
 * - Under "wait for review", a rule price that moved since queueing is the
 *   vendor's to review, so the push fails for good instead (C5). A size that
 *   follows the store's pricing counts as rule priced even while the rules
 *   cannot price it and it falls back to retail: a move from the rule price
 *   to retail (or back) is also the vendor's to review.
 */
export async function refreshQueuedListingIntent(
  deps: QueuedListingIntentRefreshDependencies,
  input: DropshipListingIntentRefreshInput,
): Promise<DropshipMarketplaceListingIntent> {
  const preview = await deps.generatePreview({
    vendorId: input.vendorId,
    storeConnectionId: input.storeConnectionId,
    productVariantIds: [input.productVariantId],
    actor: PUSH_TIME_REFRESH_ACTOR,
    ...(input.queuedMarketplaceCategory
      ? { queuedEbayCategoriesByVariantId: { [String(input.productVariantId)]: input.queuedMarketplaceCategory } }
      : {}),
  });
  const row = preview.rows.find((candidate) => candidate.productVariantId === input.productVariantId);
  if (!row?.listingIntent || row.previewStatus === "blocked") {
    throw new DropshipError(
      "DROPSHIP_CURRENT_LISTING_INTENT_BLOCKED",
      "Current listing rules do not authorize this queued publication.",
      { productVariantId: input.productVariantId, blockers: row?.blockers ?? [], retryable: true },
    );
  }
  if (row.marketplaceCategoryFallback === "queued") {
    deps.logger.info({
      code: "DROPSHIP_LISTING_PUSH_QUEUED_CATEGORY_KEPT",
      message: "The eBay category rules give this listing no category now; the category it was queued with is published.",
      context: {
        jobId: input.jobId,
        jobItemId: input.jobItemId,
        vendorId: input.vendorId,
        storeConnectionId: input.storeConnectionId,
        productVariantId: input.productVariantId,
        categoryId: row.listingIntent.marketplaceCategoryId,
      },
    });
  }
  const policy = await deps.resolveCostChangePolicy();
  const rulePriced = typeof row.rulePriceEvidenceHash === "string" || row.followsStorePricing === true;
  const verdict = decideQueuedRulePricePublication({
    rulePriced,
    queuedPriceCents: input.queuedPriceCents,
    currentPriceCents: row.listingIntent.priceCents,
    rulePricedListings: policy.settings.rulePricedListings,
  });
  if (!verdict.publish) {
    throw new DropshipError(
      "DROPSHIP_LISTING_PRICE_AWAITING_REVIEW",
      "The listing's rule price changed since it was queued and the cost change policy waits for the vendor's review. Queue it again from the Catalog page.",
      {
        productVariantId: input.productVariantId,
        queuedPriceCents: input.queuedPriceCents,
        currentPriceCents: row.listingIntent.priceCents,
        followsStorePricing: row.followsStorePricing === true,
        retryable: false,
        classification: "permanent",
      },
    );
  }
  return row.listingIntent;
}
