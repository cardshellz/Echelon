import { z } from "zod";
import { stockLinkDestinationSchema, type StockLinkDestination } from "@shared/types/stock-link";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type {
  StockLinkCandidatePage, StockLinkCarriedSkuRow, StockLinkEnrollmentListing, StockLinkEnrollmentSource, StockLinkRecentChange,
} from "../../inventory-planning/application/stock-link.ports";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../inventory-planning/domain/stock-link-errors";

/**
 * Dropship's read-only SQL for the stock-link engine's listing enrollment (channels PR3, PLAN-CH-v3 §9 PR3;
 * IP/application/stock-link.ports.ts StockLinkEnrollmentSource): which of a vendor eBay store's listings were live
 * before stock links existed, the SKU Dropship writes to eBay for each, and whether one is under change right now.
 * Every statement is a SELECT on the engine's client; nothing here writes (writer ratchet), calls eBay or decides a link.
 *
 * Candidates ("already live"): the store's eBay listings whose push recorded an eBay offer
 * (external_offer_id), that neither the vendor nor eBay ended (status `ended`, or sync-back's marketplace_ended_at),
 * on a store that is connected, verified as the destination's account, and in managed live mode (listing config
 * live + managed_quantity_sync, active). PUBLISHED is eBay's to say: the engine looks the SKU up.
 *
 * Skip reasons (PLAN-CH-v3 §4 "listing under change", §5 "Already live"; a wait, never linked meanwhile):
 * - push_open: a queued or processing item of a queued or processing push job for the size on this store;
 * - publish_run_open: the size is a `pending` (its chunk not yet expanded into a job) or `queued` target of a
 *   processing publish run on this store (PR A, shared/dropship/listing-push-runs.ts);
 * - end_open: an end request in pending, ending or failed (PR C, OPEN_LISTING_END_STATES);
 * - ended: the listing ended (vendor or sync-back) after it was found.
 */

const id = z.number().int().positive().max(2_147_483_647);
/** The claim bound of one tick (the engine asks about at most this many sizes per call). */
const SIZES_PER_CALL_MAX = 500;
const variantIdsSchema = z.array(id).max(SIZES_PER_CALL_MAX)
  .refine(ids => new Set(ids).size === ids.length, "Each size is asked for once.");
const pageLimitSchema = z.number().int().positive().max(SIZES_PER_CALL_MAX);

/** The candidate predicate on `vl` (dropship_vendor_listings) joined to `sc` and `lc`, for store $1 and account $2. */
const CANDIDATE_SQL = `vl.store_connection_id = $1 AND vl.platform = 'ebay'
  AND NULLIF(btrim(vl.external_offer_id), '') IS NOT NULL
  AND vl.status <> 'ended' AND vl.marketplace_ended_at IS NULL
  AND sc.status = 'connected' AND lower(sc.platform) = 'ebay' AND sc.external_account_id = $2
  AND lc.is_active AND lc.listing_mode = 'live' AND lc.inventory_mode = 'managed_quantity_sync'`;
const CANDIDATE_FROM_SQL = `FROM dropship.dropship_vendor_listings vl
  JOIN dropship.dropship_store_connections sc ON sc.id = vl.store_connection_id
  JOIN dropship.dropship_store_listing_configs lc ON lc.store_connection_id = sc.id AND lc.platform = sc.platform
  JOIN catalog.product_variants v ON v.id = vl.product_variant_id
  JOIN catalog.products p ON p.id = v.product_id`;

/** The SKU Dropship writes to eBay for a size (the Dropship eBay draft's own SKU, dropship-ebay-stock-readiness.read.ts). */
const DROPSHIP_SKU_SQL = "COALESCE(v.sku, p.sku)";

const candidateRowSchema = z.object({ product_variant_id: id, product_id: id }).strict();
const carriedSkuRowSchema = z.object({ product_variant_id: id, sku: z.string().nullable() }).strict();
const listingRowSchema = z.object({
  listing_id: id, product_variant_id: id, product_id: id, vendor_id: id, sku: z.string().nullable(),
  recorded_offer_id: z.string().nullable(), environment: z.string().nullable(),
  managed: z.boolean(), ended: z.boolean(), end_open: z.boolean(), push_open: z.boolean(), run_open: z.boolean(),
}).strict();

function contractBroken(message: string): StockLinkError {
  return new StockLinkError(STOCK_LINK_ERROR_CODES.adapterContract, message);
}

/** A destination this source cannot read for is the engine's wiring bug (the registry resolves by kind + provider). */
function scopeOf(destination: StockLinkDestination): { storeConnectionId: number; accountId: string } {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "dropship_store_connection" || parsed.data.providerKey !== "ebay"
    || parsed.data.dropshipStoreConnectionId === null || parsed.data.providerScopeType !== "account") {
    throw contractBroken("The Dropship eBay stock-link source was given another kind of destination.");
  }
  return { storeConnectionId: parsed.data.dropshipStoreConnectionId, accountId: parsed.data.externalScopeId };
}

function parsedRows<S extends z.ZodTypeAny>(schema: S, rows: readonly unknown[]): z.infer<S>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw contractBroken("The Dropship eBay stock-link source read rows its contract does not allow.");
  return parsed.data;
}

function environmentOf(value: string | null): StockLinkEnrollmentListing["environment"] {
  return value === "production" || value === "sandbox" ? value : null;
}

export class DropshipEbayStockLinkSource implements StockLinkEnrollmentSource {
  readonly destinationKind = "dropship_store_connection" as const;
  readonly providerKey = "ebay";

  async listCandidates(client: StockSelectionQueryClient, destination: StockLinkDestination, afterVariantId: number,
    limit: number): Promise<StockLinkCandidatePage> {
    const scope = scopeOf(destination);
    const after = z.number().int().nonnegative().max(2_147_483_647).safeParse(afterVariantId);
    const bound = pageLimitSchema.safeParse(limit);
    if (!after.success || !bound.success) throw contractBroken("The Dropship eBay stock-link source was asked for a page its contract does not allow.");
    const rows = parsedRows(candidateRowSchema, (await client.query(`SELECT vl.product_variant_id, v.product_id
      ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} AND vl.product_variant_id > $3
      ORDER BY vl.product_variant_id LIMIT $4`, [scope.storeConnectionId, scope.accountId, after.data, bound.data])).rows);
    return {
      candidates: rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id })),
      // A short page is the end of the sweep (it wraps); a full one may have more after its last size.
      nextAfterVariantId: rows.length === bound.data ? rows[rows.length - 1]!.product_variant_id : null,
    };
  }

  /** No change feed: the sweep finds every candidate (500 sizes a tick per store) and waits re-check on their backoff. */
  async listRecentlyChanged(): Promise<readonly StockLinkRecentChange[]> {
    return [];
  }

  async listCarriedSkus(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<readonly StockLinkCarriedSkuRow[]> {
    const scope = scopeOf(destination);
    const rows = parsedRows(carriedSkuRowSchema, (await client.query(`SELECT vl.product_variant_id, ${DROPSHIP_SKU_SQL} AS sku
      ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL}
      ORDER BY vl.product_variant_id`, [scope.storeConnectionId, scope.accountId])).rows);
    return rows.map(row => ({ productVariantId: row.product_variant_id, sku: row.sku }));
  }

  async readListings(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<readonly StockLinkEnrollmentListing[]> {
    const scope = scopeOf(destination);
    const ids = variantIdsSchema.safeParse([...productVariantIds]);
    if (!ids.success) throw contractBroken("The Dropship eBay stock-link source was asked about sizes its contract does not allow.");
    if (ids.data.length === 0) return [];
    // Only the store's own listing rows (unique per store and size, dropship_listing_store_variant_idx).
    const rows = parsedRows(listingRowSchema, (await client.query(`SELECT vl.id AS listing_id, vl.product_variant_id, v.product_id,
        vl.vendor_id, ${DROPSHIP_SKU_SQL} AS sku, NULLIF(btrim(vl.external_offer_id), '') AS recorded_offer_id,
        sc.provider_environment AS environment,
        -- The candidate predicate of the store and listing (managed live, verified account, recorded offer), so a
        -- listing on a store that left managed live mode is never newly linked (its zero would overwrite the
        -- vendor's own quantity). An ended listing is reported by \`ended\` below.
        (sc.status = 'connected' AND lower(sc.platform) = 'ebay' AND sc.external_account_id = $3
          AND COALESCE(lc.is_active AND lc.listing_mode = 'live' AND lc.inventory_mode = 'managed_quantity_sync', false)
          AND NULLIF(btrim(vl.external_offer_id), '') IS NOT NULL) AS managed,
        (vl.status = 'ended' OR vl.marketplace_ended_at IS NOT NULL) AS ended,
        EXISTS (SELECT 1 FROM dropship.dropship_listing_end_requests e
          WHERE e.listing_id = vl.id AND e.state IN ('pending', 'ending', 'failed')) AS end_open,
        EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items ji
          JOIN dropship.dropship_listing_push_jobs j ON j.id = ji.job_id
          WHERE j.store_connection_id = vl.store_connection_id AND ji.product_variant_id = vl.product_variant_id
            AND j.status IN ('queued', 'processing') AND ji.status IN ('queued', 'processing')) AS push_open,
        EXISTS (SELECT 1 FROM dropship.dropship_listing_push_runs r
          JOIN dropship.dropship_listing_push_run_targets rt ON rt.run_id = r.id
          WHERE r.store_connection_id = vl.store_connection_id AND r.status = 'processing'
            AND rt.product_variant_id = vl.product_variant_id AND rt.outcome IN ('pending', 'queued')) AS run_open
      FROM dropship.dropship_vendor_listings vl
      JOIN dropship.dropship_store_connections sc ON sc.id = vl.store_connection_id
      LEFT JOIN dropship.dropship_store_listing_configs lc ON lc.store_connection_id = sc.id AND lc.platform = sc.platform
      JOIN catalog.product_variants v ON v.id = vl.product_variant_id
      JOIN catalog.products p ON p.id = v.product_id
      WHERE vl.store_connection_id = $1 AND vl.platform = 'ebay' AND vl.product_variant_id = ANY($2::integer[])
      ORDER BY vl.product_variant_id`, [scope.storeConnectionId, ids.data, scope.accountId])).rows);
    if (new Set(rows.map(row => row.product_variant_id)).size !== rows.length) {
      throw contractBroken("A Dropship store has two eBay listings of one size.");
    }
    return rows.map(row => ({
      productVariantId: row.product_variant_id, productId: row.product_id, listingId: row.listing_id, vendorId: row.vendor_id,
      cardShellzSku: row.sku, recordedOfferId: row.recorded_offer_id, environment: environmentOf(row.environment),
      managed: row.managed,
      // Most decisive first: an ended listing is never linked; an end in progress before a push or run.
      skipReason: row.ended ? "ended" : row.end_open ? "end_open" : row.push_open ? "push_open" : row.run_open ? "publish_run_open" : null,
    }));
  }
}

export function createDropshipEbayStockLinkSource(): DropshipEbayStockLinkSource {
  return new DropshipEbayStockLinkSource();
}
