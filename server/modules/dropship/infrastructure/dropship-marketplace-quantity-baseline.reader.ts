import type { Pool } from "pg";
import {
  readDropshipEbayPublishedQuantities,
  readDropshipEbayStockAuthority,
  type DropshipEbayPublishedQuantity,
} from "../../inventory-planning/quantity-publication";
import type {
  MarketplaceQuantityBaselinePort,
  MarketplaceSyncListing,
} from "../application/dropship-marketplace-sync-service";
import type { QuantityBaseline } from "../domain/marketplace-quantity-decision";
import { marketplacePublishBaseline, MARKETPLACE_SYNC_PREVIEW_CHUNK } from "../domain/marketplace-sync-sweep";

/**
 * eBay sync-back's B from Card Shellz's own last quantity write (plan v4
 * §6.4), read through inventory planning's published interface
 * (quantity-publication.ts): the runtime authority and, under canonical
 * authority, the newest published quantity of each size on the store's live
 * destination. Read-only. The rule that turns them into a baseline is the
 * domain's (marketplacePublishBaseline).
 */
export class PgMarketplaceQuantityBaselineReader implements MarketplaceQuantityBaselinePort {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly readAuthority: (pool: Pick<Pool, "query">) => Promise<"legacy" | "canonical"> = readDropshipEbayStockAuthority,
    private readonly readPublished: typeof readDropshipEbayPublishedQuantities = readDropshipEbayPublishedQuantities,
  ) {}

  async readPublishBaselines(input: {
    storeConnectionId: number; listings: readonly MarketplaceSyncListing[];
  }): Promise<Map<number, QuantityBaseline | null>> {
    const baselines = new Map<number, QuantityBaseline | null>();
    if (input.listings.length === 0) return baselines;
    const authority = await this.readAuthority(this.pool);
    const published = new Map<number, DropshipEbayPublishedQuantity>();
    if (authority === "canonical") {
      const variantIds = [...new Set(input.listings.map((listing) => listing.productVariantId))];
      for (let index = 0; index < variantIds.length; index += MARKETPLACE_SYNC_PREVIEW_CHUNK) {
        for (const row of await this.readPublished(this.pool, { storeConnectionId: input.storeConnectionId,
          productVariantIds: variantIds.slice(index, index + MARKETPLACE_SYNC_PREVIEW_CHUNK) })) {
          published.set(row.productVariantId, row);
        }
      }
    }
    for (const listing of input.listings) {
      const fact = published.get(listing.productVariantId) ?? null;
      baselines.set(listing.listingId, marketplacePublishBaseline({
        authority,
        push: { pushedQuantity: listing.pushedQuantity, lastPushedAt: listing.lastPushedAt, hasOpenPushItem: listing.hasOpenPushItem,
          hasUnsettledAttempt: listing.pushAttemptUnsettled },
        published: fact ? { desiredQuantity: fact.desiredQuantity, settledAt: fact.settledAt } : null,
      }));
    }
    return baselines;
  }
}
