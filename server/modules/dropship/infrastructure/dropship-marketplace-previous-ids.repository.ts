import type { PoolClient } from "pg";

/**
 * The eBay item numbers a listing had before a relist or a republish (plan v4
 * §7.3, SB6), so an order placed on the old number still finds its listing.
 * Runs on the caller's client and transaction; takes no lock.
 */
type Client = Pick<PoolClient, "query">;

export type PreviousMarketplaceIdReason = "relisted" | "republished";

/**
 * Keeps an item number the listing no longer has. The owner (vendor, store)
 * comes from the listing's own row, so it can never disagree with it. A
 * number already kept for the store is a no-op (UNIQUE per store and
 * number). Answers whether a row was written.
 */
export async function recordPreviousMarketplaceIdWithClient(client: Client, input: {
  listingId: number; externalListingId: string; reason: PreviousMarketplaceIdReason; replacedAt: Date;
}): Promise<boolean> {
  const result = await client.query(`INSERT INTO dropship.dropship_listing_previous_marketplace_ids
      (listing_id, vendor_id, store_connection_id, external_listing_id, reason, replaced_at)
    SELECT l.id, l.vendor_id, l.store_connection_id, $2, $3, $4 FROM dropship.dropship_vendor_listings l WHERE l.id = $1
    ON CONFLICT (store_connection_id, external_listing_id) DO NOTHING`,
  [input.listingId, input.externalListingId, input.reason, input.replacedAt]);
  return result.rowCount === 1;
}
