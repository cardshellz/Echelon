import type { PoolClient } from "pg";

/**
 * Order lines eBay sent on an item number no listing has, whose custom label
 * is exactly one of the store's listing SKUs (plan v4 §7.3, SB19): parked,
 * never dropped, until the sweep proves a relink, eBay cancels or fulfils
 * the order, or 30 days pass. Runs on the caller's client and transaction.
 */
type Client = Pick<PoolClient, "query">;

/** How long an open parked line waits before it expires (§7.3 step 6; HYPOTHESIS: past any eBay ship-by date). */
export const UNMATCHED_ORDER_EXPIRY_MS = 30 * 24 * 60 * 60_000;

export type UnmatchedOrderResolution = "relinked" | "cancelled" | "fulfilled_elsewhere" | "expired";

/**
 * Parks one line. The owner comes from the store connection's row; the
 * candidate must be one of that store's listings, or nothing is written. A
 * line already parked is a no-op (UNIQUE per store, order and line), so a
 * replayed poll parks nothing new. Answers whether it was newly parked.
 */
export async function parkUnmatchedOrderLineWithClient(client: Client, input: {
  storeConnectionId: number; externalOrderId: string; externalLineItemId: string; externalListingId: string; sku: string;
  candidateListingId: number; reason: string; orderedAt: Date | null; seenAt: Date;
}): Promise<boolean> {
  const result = await client.query(`INSERT INTO dropship.dropship_unmatched_marketplace_orders
      (vendor_id, store_connection_id, external_order_id, external_line_item_id, external_listing_id, sku, candidate_listing_id,
       status, reason, ordered_at, first_seen_at, last_checked_at)
    SELECT sc.vendor_id, sc.id, $2, $3, $4, $5, l.id, 'open', $7, $8, $9, $9
    FROM dropship.dropship_store_connections sc
    JOIN dropship.dropship_vendor_listings l ON l.id = $6 AND l.store_connection_id = sc.id
    WHERE sc.id = $1
    ON CONFLICT (store_connection_id, external_order_id, external_line_item_id) DO NOTHING`,
  [input.storeConnectionId, input.externalOrderId, input.externalLineItemId, input.externalListingId, input.sku,
    input.candidateListingId, input.reason, input.orderedAt, input.seenAt]);
  return result.rowCount === 1;
}

/** Resolves an open line, only while it is open. Answers whether this call resolved it. */
export async function resolveUnmatchedOrderLineWithClient(client: Client, input: {
  id: number; resolution: Exclude<UnmatchedOrderResolution, "expired">; at: Date;
}): Promise<boolean> {
  const result = await client.query(`UPDATE dropship.dropship_unmatched_marketplace_orders
    SET status = $2, resolved_at = $3, last_checked_at = $3 WHERE id = $1 AND status = 'open'`, [input.id, input.resolution, input.at]);
  return result.rowCount === 1;
}

/** Expires every open line first seen 30 days or more before `now` (§7.3 step 6). Answers how many. */
export async function expireUnmatchedOrderLinesWithClient(client: Client, now: Date): Promise<number> {
  const result = await client.query(`UPDATE dropship.dropship_unmatched_marketplace_orders
    SET status = 'expired', resolved_at = $1, last_checked_at = $1
    WHERE status = 'open' AND first_seen_at <= $2`, [now, new Date(now.getTime() - UNMATCHED_ORDER_EXPIRY_MS)]);
  return result.rowCount ?? 0;
}
