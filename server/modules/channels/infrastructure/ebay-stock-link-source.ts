import type { Pool } from "pg";
import { z } from "zod";
import { stockLinkDestinationSchema, type StockLinkDestination } from "@shared/types/stock-link";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type {
  StockLinkCandidatePage, StockLinkCarriedSkuRow, StockLinkEnrollmentListing, StockLinkEnrollmentSource, StockLinkEnrollmentWrite,
  StockLinkEnrollmentWriteResult, StockLinkEnrollmentWriter, StockLinkRecentChange,
} from "../../inventory-planning/application/stock-link.ports";
import { STOCK_LINK_ACTOR } from "../../inventory-planning/domain/stock-link";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../inventory-planning/domain/stock-link-errors";
import { linkChannelEbayStock } from "../../inventory-planning/quantity-publication";
import { readOutstandingEbayListingWork } from "./channel-stock-selection.repository";

/**
 * Card Shellz eBay's read-only SQL and link writer for the stock-link engine (channels PR4, PLAN-CH-v3 §5 "Already
 * live": a live Card Shellz eBay listing links in the background, no manual Sync needed).
 *
 * Source. A carried size is a channel listing of the eBay channel with a published eBay listing id, on a connection
 * whose eBay account is the destination's verified account. Its SKU is COALESCE(external_sku, v.sku), what the
 * readiness owner checks (IP ebay-publication-readiness.read.ts). "Listing under change" (PLAN-CH-v3 §4 waits) is the
 * Sync owner's outstanding listing work for the product (readOutstandingEbayListingWork: an unsettled job that still
 * owes work): the size waits, nothing is linked meanwhile. Every statement is a SELECT on the engine's client.
 *
 * Writer. linkChannelEbayStock (IP): the existing eBay readiness owner, origin `background`, purpose `sync`.
 */

const C = STOCK_LINK_ERROR_CODES;
const id = z.number().int().positive().max(2_147_483_647);
const SIZES_PER_CALL_MAX = 500;
const variantIdsSchema = z.array(id).max(SIZES_PER_CALL_MAX).refine(ids => new Set(ids).size === ids.length, "Each size is asked for once.");
const pageLimitSchema = z.number().int().positive().max(SIZES_PER_CALL_MAX);

/** The carried predicate on `cl` (channel_listings) and `v`, for channel $1, connection $2, verified account $3. */
const CANDIDATE_FROM_SQL = `FROM channels.channel_listings cl
  JOIN catalog.product_variants v ON v.id = cl.product_variant_id
  JOIN channels.channel_connections c ON c.channel_id = cl.channel_id AND c.id = $2
  JOIN ebay.ebay_oauth_tokens t ON t.channel_id = cl.channel_id AND t.external_account_id = $3
    AND t.external_account_identity_scheme = 'provider_user_id' AND t.external_account_verified_at IS NOT NULL`;
const CANDIDATE_SQL = "cl.channel_id = $1 AND NULLIF(btrim(cl.external_product_id), '') IS NOT NULL";
const SKU_SQL = "COALESCE(cl.external_sku, v.sku)";

const candidateRowSchema = z.object({ product_variant_id: id, product_id: id }).strict();
const carriedSkuRowSchema = z.object({ product_variant_id: id, sku: z.string().nullable() }).strict();
const listingRowSchema = z.object({ listing_id: id, product_variant_id: id, product_id: id, sku: z.string().nullable(),
  environment: z.string().nullable() }).strict();

function contractBroken(message: string): StockLinkError {
  return new StockLinkError(C.adapterContract, message);
}

function scopeOf(destination: StockLinkDestination): { channelId: number; connectionId: number; accountId: string } {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "channel_connection" || parsed.data.providerKey !== "ebay"
    || parsed.data.channelConnectionId === null || parsed.data.providerScopeType !== "account") {
    throw contractBroken("The Card Shellz eBay stock-link source was given another kind of destination.");
  }
  return { channelId: parsed.data.channelId, connectionId: parsed.data.channelConnectionId, accountId: parsed.data.externalScopeId };
}

function parsedRows<S extends z.ZodTypeAny>(schema: S, rows: readonly unknown[]): z.infer<S>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw contractBroken("The Card Shellz eBay stock-link source read rows its contract does not allow.");
  return parsed.data;
}

export class ChannelEbayStockLinkSource implements StockLinkEnrollmentSource {
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey = "ebay";

  async listCandidates(client: StockSelectionQueryClient, destination: StockLinkDestination, afterVariantId: number,
    limit: number): Promise<StockLinkCandidatePage> {
    const scope = scopeOf(destination);
    const after = z.number().int().nonnegative().max(2_147_483_647).safeParse(afterVariantId);
    const bound = pageLimitSchema.safeParse(limit);
    if (!after.success || !bound.success) throw contractBroken("The Card Shellz eBay stock-link source was asked for a page its contract does not allow.");
    const rows = parsedRows(candidateRowSchema, (await client.query(`SELECT cl.product_variant_id, v.product_id ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} AND cl.product_variant_id > $4 ORDER BY cl.product_variant_id LIMIT $5`,
    [scope.channelId, scope.connectionId, scope.accountId, after.data, bound.data])).rows);
    return { candidates: rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id })),
      nextAfterVariantId: rows.length === bound.data ? rows[rows.length - 1]!.product_variant_id : null };
  }

  /** No change feed: the sweep finds every listing; a finished read-only Sync nudges its sizes (ebay-listing-sync.service.ts). */
  async listRecentlyChanged(): Promise<readonly StockLinkRecentChange[]> {
    return [];
  }

  async listCarriedSkus(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<readonly StockLinkCarriedSkuRow[]> {
    const scope = scopeOf(destination);
    const rows = parsedRows(carriedSkuRowSchema, (await client.query(`SELECT cl.product_variant_id, ${SKU_SQL} AS sku ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} ORDER BY cl.product_variant_id`, [scope.channelId, scope.connectionId, scope.accountId])).rows);
    return rows.map(row => ({ productVariantId: row.product_variant_id, sku: row.sku }));
  }

  async readListings(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<readonly StockLinkEnrollmentListing[]> {
    const scope = scopeOf(destination);
    const ids = variantIdsSchema.safeParse([...productVariantIds]);
    if (!ids.success) throw contractBroken("The Card Shellz eBay stock-link source was asked about sizes its contract does not allow.");
    if (ids.data.length === 0) return [];
    const rows = parsedRows(listingRowSchema, (await client.query(`SELECT cl.id AS listing_id, cl.product_variant_id, v.product_id,
        ${SKU_SQL} AS sku, t.environment
      ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} AND cl.product_variant_id = ANY($4::integer[])
      ORDER BY cl.product_variant_id`, [scope.channelId, scope.connectionId, scope.accountId, ids.data])).rows);
    if (new Set(rows.map(row => row.product_variant_id)).size !== rows.length) {
      throw contractBroken("A Card Shellz eBay size has two listing rows or two verified logins.");
    }
    // One read per product: the Sync owner's unsettled work for it (a job that still owes eBay or inventory work).
    const busy = new Set<number>();
    for (const productId of [...new Set(rows.map(row => row.product_id))].sort((a, b) => a - b)) {
      const work = await readOutstandingEbayListingWork(client, { channelId: scope.channelId, connectionId: scope.connectionId, productId });
      if (work.length > 0) busy.add(productId);
    }
    return rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id, listingId: row.listing_id,
      vendorId: null, cardShellzSku: row.sku, recordedOfferId: null,
      environment: row.environment === "production" || row.environment === "sandbox" ? row.environment : null,
      managed: true, skipReason: busy.has(row.product_id) ? "push_open" : null, requireRecordedOffer: false }));
  }
}

export function createChannelEbayStockLinkSource(): ChannelEbayStockLinkSource {
  return new ChannelEbayStockLinkSource();
}

export interface ChannelEbayStockLinkWriterDependencies {
  readonly pool: Pick<Pool, "connect">;
  readonly clock: () => Date;
  readonly monotonicNow: () => number;
}

/** The Card Shellz eBay link writer the engine's enrollment pass calls (origin background, purpose sync). */
export function createChannelEbayStockLinkWriter(deps: ChannelEbayStockLinkWriterDependencies): StockLinkEnrollmentWriter {
  return async (write: StockLinkEnrollmentWrite): Promise<StockLinkEnrollmentWriteResult> => {
    const scope = scopeOf(write.destination);
    if (write.listing.environment === null) {
      return { status: "blocked", commandKey: `channel-ebay-stock-link:${write.link.evidenceHash}`,
        blockers: [{ code: "STOCK_LISTING_ACCOUNT_CHANGED" }] };
    }
    const result = await linkChannelEbayStock(deps.pool, { publicationTargetId: write.destination.publicationTargetId,
      channelId: scope.channelId, connectionId: scope.connectionId, accountId: scope.accountId,
      environment: write.listing.environment, productId: write.listing.productId, purpose: "sync",
      variants: [{ productVariantId: write.productVariantId, sku: write.link.sku }],
      origin: { kind: "background", key: `${write.productVariantId}:${write.link.evidenceHash}` }, actor: STOCK_LINK_ACTOR },
    { now: deps.clock(), monotonicNow: deps.monotonicNow });
    if (result.status === "blocked") return { status: "blocked", commandKey: result.commandKey, blockers: result.blockers };
    return { status: "ready", commandKey: result.commandKey, publicationTargetId: write.destination.publicationTargetId,
      alreadyLinked: result.alreadyLinked, fenceHoldMs: result.fenceHoldMs };
  };
}
