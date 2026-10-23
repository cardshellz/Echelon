import type { PoolClient } from "pg";
import type { SalesWindow } from "../domain/marketplace-quantity-decision";
import { marketplaceSyncError, MARKETPLACE_SYNC_CODES } from "../domain/marketplace-sync-errors";

/**
 * The sales ledger (plan v4 §6.4, SB30): every order line eBay showed on a
 * known listing, paid or not, so a sale is never read as the vendor lowering
 * quantity. Written by the order poll; summed by the quantity decision.
 * These are eBay facts, not operator actions: no audit row (§1.2). Runs on
 * the caller's client and transaction.
 */
type Client = Pick<PoolClient, "query">;

export interface MarketplaceSaleLine {
  listingId: number;
  externalOrderId: string;
  externalLineItemId: string;
  quantity: number;
  /** eBay's order creationDate. */
  orderedAt: Date;
}

/**
 * Records the lines of one poll for one store; a line already recorded is a
 * no-op, so a replayed poll adds nothing. Every line must be on one of the
 * store's own listings, or nothing is written (a caller defect, permanent).
 * Answers how many lines are new.
 */
export async function recordMarketplaceSaleLinesWithClient(client: Client, input: {
  storeConnectionId: number; lines: readonly MarketplaceSaleLine[]; firstSeenAt: Date;
}): Promise<number> {
  if (input.lines.length === 0) return 0;
  for (const line of input.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || !line.externalOrderId.trim() || !line.externalLineItemId.trim()) {
      throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A sale line is not valid.", "permanent",
        { listingId: line.listingId, externalOrderId: line.externalOrderId, quantity: line.quantity });
    }
  }
  const listingIds = [...new Set(input.lines.map((line) => line.listingId))];
  const owned = await client.query<{ id: number }>(`SELECT id FROM dropship.dropship_vendor_listings
    WHERE id = ANY($1::int[]) AND store_connection_id = $2`, [listingIds, input.storeConnectionId]);
  if (owned.rows.length !== listingIds.length) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A sale line names a listing of another store.", "permanent",
      { storeConnectionId: input.storeConnectionId, listingIds });
  }
  const result = await client.query(`INSERT INTO dropship.dropship_listing_marketplace_sales
      (store_connection_id, listing_id, external_order_id, external_line_item_id, quantity, ordered_at, first_seen_at)
    SELECT $1, line.listing_id, line.external_order_id, line.external_line_item_id, line.quantity, line.ordered_at, $3
    FROM jsonb_to_recordset($2::jsonb) AS line(listing_id integer, external_order_id text, external_line_item_id text,
      quantity integer, ordered_at timestamptz)
    ON CONFLICT (store_connection_id, external_order_id, external_line_item_id) DO NOTHING`,
  [input.storeConnectionId, JSON.stringify(input.lines.map((line) => ({ listing_id: line.listingId, external_order_id: line.externalOrderId,
    external_line_item_id: line.externalLineItemId, quantity: line.quantity, ordered_at: line.orderedAt.toISOString() }))), input.firstSeenAt]);
  return result.rowCount ?? 0;
}

/** eBay cancelled an order: its lines stop counting as live sales. The first cancel time is kept. Answers the lines marked. */
export async function markMarketplaceSaleOrderCancelledWithClient(client: Client, input: {
  storeConnectionId: number; externalOrderId: string; cancelledAt: Date;
}): Promise<number> {
  const result = await client.query(`UPDATE dropship.dropship_listing_marketplace_sales SET cancelled_at = $3
    WHERE store_connection_id = $1 AND external_order_id = $2 AND cancelled_at IS NULL`,
  [input.storeConnectionId, input.externalOrderId, input.cancelledAt]);
  return result.rowCount ?? 0;
}

/**
 * S_all and S_live for one listing (§6.4): units of every line in the wide
 * window, cancelled or not, and of the lines not cancelled in the narrow one
 * (quantitySalesWindows). Both are half-open: (from, to].
 */
export async function sumMarketplaceSalesWithClient(client: Client, input: {
  listingId: number; all: SalesWindow; live: SalesWindow;
}): Promise<{ all: number; live: number }> {
  const result = await client.query<{ all_units: string; live_units: string }>(`SELECT
      COALESCE(sum(quantity) FILTER (WHERE ordered_at > $2 AND ordered_at <= $3), 0)::text AS all_units,
      COALESCE(sum(quantity) FILTER (WHERE cancelled_at IS NULL AND ordered_at > $4 AND ordered_at <= $5), 0)::text AS live_units
    FROM dropship.dropship_listing_marketplace_sales
    WHERE listing_id = $1 AND ordered_at > LEAST($2::timestamptz, $4::timestamptz) AND ordered_at <= GREATEST($3::timestamptz, $5::timestamptz)`,
  [input.listingId, input.all.fromExclusive, input.all.toInclusive, input.live.fromExclusive, input.live.toInclusive]);
  const row = result.rows[0]!;
  return { all: units(row.all_units), live: units(row.live_units) };
}

/**
 * Starts the store's sales ledger once (§8 notes, §9): the first poll success
 * of this release sets it; every later call is a no-op. Answers whether
 * this call set it.
 */
export async function startMarketplaceSalesLedgerWithClient(client: Client, input: { storeConnectionId: number; since: Date }): Promise<boolean> {
  const result = await client.query(`UPDATE dropship.dropship_store_connections SET marketplace_sales_ledger_since = $2
    WHERE id = $1 AND marketplace_sales_ledger_since IS NULL`, [input.storeConnectionId, input.since]);
  return result.rowCount === 1;
}

function units(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw marketplaceSyncError(MARKETPLACE_SYNC_CODES.invariantFailed, "A sales sum is not a safe whole number.", "fatal", { value });
  }
  return parsed;
}
