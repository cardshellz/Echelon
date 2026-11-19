import type { DropshipMarketplaceListingPushRequest } from "./dropship-marketplace-listing-push-provider";

/**
 * The automatic stock link of a Dropship eBay push (plan F2 2.1, 2.8). Under
 * canonical inventory authority, a live listing whose stock Card Shellz manages
 * needs an exact eBay SKU mapping on the store's one live Card Shellz stock
 * destination before its first quantity-bearing eBay write. Inventory-planning
 * owns that mapping; this port is how the eBay provider asks for it.
 */

/** The store credential facts the link needs; the provider's loaded credential is a superset. */
export interface DropshipStockLinkCredential {
  readonly vendorId: number;
  readonly storeConnectionId: number;
  readonly platform: string;
  readonly externalAccountId: string | null;
  readonly externalAccountIdentityScheme: string | null;
  readonly externalAccountVerifiedAt: Date | null;
}

/** The offers the shared connector accepted for this push (ebay-listing.connector.ts beforeFirstMutation). */
export interface DropshipStockLinkResolvedOffers {
  readonly offers: ReadonlyArray<{ readonly variantId: number; readonly sku: string; readonly existingOfferId: string | null }>;
  readonly verifiedPublishedListingId: string | null;
}

export interface DropshipStockLinkBegin {
  readonly authority: "legacy" | "canonical";
  /** True only under canonical authority for a live, Card Shellz-managed listing. */
  readonly mustLink: boolean;
}

export interface DropshipEbayStockReadinessPort {
  /**
   * Called once per eBay push, after the token is loaded and before any eBay
   * call. Legacy authority returns at once with no other check. Under canonical
   * authority a positive-quantity push of a store that is not live + managed is
   * refused (DROPSHIP_STOCK_MODE_NOT_MANAGED); every refusal is a classified DropshipError.
   */
  begin(input: { request: DropshipMarketplaceListingPushRequest; credential: DropshipStockLinkCredential }): Promise<DropshipStockLinkBegin>;
  /**
   * Called from the connector's beforeFirstMutation hook when `mustLink`: makes
   * (or confirms) the stock link for exactly the accepted offer, or throws a
   * classified DropshipError so the push stops before any offer, inventory-item
   * or quantity write. Transient conditions are retried in process, boundedly.
   * An automatic re-queue's run (request.automaticRetry) is refused here when the
   * connector found a published eBay listing the vendor listing never recorded
   * (review TW-1); with `linkStock: false` (an automatic re-queue of a push that
   * needs no link) only that check runs and inventory is not called.
   */
  ensureLinked(input: {
    request: DropshipMarketplaceListingPushRequest;
    credential: DropshipStockLinkCredential;
    environment: "production" | "sandbox";
    sku: string;
    resolved: DropshipStockLinkResolvedOffers;
    linkStock?: boolean;
  }): Promise<void>;
}
