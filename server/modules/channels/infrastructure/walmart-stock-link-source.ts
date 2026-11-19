import { z } from "zod";
import { stockLinkDestinationSchema, type StockLinkDestination } from "@shared/types/stock-link";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type {
  StockLinkCandidatePage, StockLinkCarriedSkuRow, StockLinkEnrollmentListing, StockLinkEnrollmentSource, StockLinkEnrollmentWrite,
  StockLinkEnrollmentWriteResult, StockLinkEnrollmentWriter, StockLinkRecentChange,
} from "../../inventory-planning/application/stock-link.ports";
import type { VerifiedListingStockService } from "../../inventory-planning/application/verified-listing-stock.service";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../inventory-planning/domain/stock-link-errors";
import { walmartListingAccount, type WalmartChannelService } from "../adapters/walmart/walmart-channel.service";

/**
 * Walmart's read-only SQL and link writer for the stock-link engine (channels PR4, PLAN-CH-v3 §2, §5, §9 PR4).
 *
 * Source. A carried size is a Walmart channel feed: active, not quarantined, on the destination's Walmart connection.
 * Its SKU is the feed's channel_sku (what Echelon writes to Walmart, PLAN-CH-v3 §1). Every statement is a SELECT on
 * the engine's client; nothing here writes, calls Walmart or decides a link. "Listing under change" is not read here:
 * the Walmart listing guard refuses at write time (busy, stopped, missing), so a guard that clears links on the next
 * check.
 *
 * Writer. The one link per size goes through VerifiedListingStockService.connect (the inventory owner's verified Walmart
 * link, origin background), inside the Walmart listing-write guard (withListingWrites: shared TRY session locks on the
 * SKU, before the inventory fence, as the old scan did). The guard refuses a stopped, archived or missing listing and a
 * SKU another request holds (an exclusive retirement among them); the inventory owner refuses a recreated item without
 * its stock receipt. Each refusal comes back `blocked` with its code; the engine maps it to busy, wait or flagged.
 */

const C = STOCK_LINK_ERROR_CODES;
const id = z.number().int().positive().max(2_147_483_647);
const SIZES_PER_CALL_MAX = 500;
const variantIdsSchema = z.array(id).max(SIZES_PER_CALL_MAX).refine(ids => new Set(ids).size === ids.length, "Each size is asked for once.");
const pageLimitSchema = z.number().int().positive().max(SIZES_PER_CALL_MAX);

/** The carried-size predicate on `f` (channel_feeds) joined to `w` (walmart_connections), for channel $1 and connection $2. */
const CANDIDATE_FROM_SQL = `FROM channels.channel_feeds f
  JOIN channels.walmart_connections w ON w.channel_id = f.channel_id AND w.connection_id = $2
  JOIN catalog.product_variants v ON v.id = f.product_variant_id`;
const CANDIDATE_SQL = "f.channel_id = $1 AND f.is_active = 1 AND f.quarantined_at IS NULL";

const candidateRowSchema = z.object({ product_variant_id: id, product_id: id }).strict();
const carriedSkuRowSchema = z.object({ product_variant_id: id, sku: z.string().nullable() }).strict();
const listingRowSchema = z.object({ feed_id: id, product_variant_id: id, product_id: id, sku: z.string().nullable(),
  environment: z.string().nullable() }).strict();

function contractBroken(message: string): StockLinkError {
  return new StockLinkError(C.adapterContract, message);
}

function scopeOf(destination: StockLinkDestination): { channelId: number; connectionId: number; shipNodeId: string } {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "channel_connection" || parsed.data.providerKey !== "walmart"
    || parsed.data.channelConnectionId === null || parsed.data.providerScopeType !== "location") {
    throw contractBroken("The Walmart stock-link source was given another kind of destination.");
  }
  return { channelId: parsed.data.channelId, connectionId: parsed.data.channelConnectionId, shipNodeId: parsed.data.externalScopeId };
}

function parsedRows<S extends z.ZodTypeAny>(schema: S, rows: readonly unknown[]): z.infer<S>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) throw contractBroken("The Walmart stock-link source read rows its contract does not allow.");
  return parsed.data;
}

export class WalmartStockLinkSource implements StockLinkEnrollmentSource {
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey = "walmart";

  async listCandidates(client: StockSelectionQueryClient, destination: StockLinkDestination, afterVariantId: number,
    limit: number): Promise<StockLinkCandidatePage> {
    const scope = scopeOf(destination);
    const after = z.number().int().nonnegative().max(2_147_483_647).safeParse(afterVariantId);
    const bound = pageLimitSchema.safeParse(limit);
    if (!after.success || !bound.success) throw contractBroken("The Walmart stock-link source was asked for a page its contract does not allow.");
    const rows = parsedRows(candidateRowSchema, (await client.query(`SELECT f.product_variant_id, v.product_id ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} AND f.product_variant_id > $3 ORDER BY f.product_variant_id LIMIT $4`,
    [scope.channelId, scope.connectionId, after.data, bound.data])).rows);
    return { candidates: rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id })),
      nextAfterVariantId: rows.length === bound.data ? rows[rows.length - 1]!.product_variant_id : null };
  }

  /** No change feed: the 60 s Walmart scan nudges the sizes it sees PUBLISHED, and the sweep finds every feed. */
  async listRecentlyChanged(): Promise<readonly StockLinkRecentChange[]> {
    return [];
  }

  async listCarriedSkus(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<readonly StockLinkCarriedSkuRow[]> {
    const scope = scopeOf(destination);
    const rows = parsedRows(carriedSkuRowSchema, (await client.query(`SELECT f.product_variant_id, f.channel_sku AS sku ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} ORDER BY f.product_variant_id`, [scope.channelId, scope.connectionId])).rows);
    return rows.map(row => ({ productVariantId: row.product_variant_id, sku: row.sku }));
  }

  async readListings(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<readonly StockLinkEnrollmentListing[]> {
    const scope = scopeOf(destination);
    const ids = variantIdsSchema.safeParse([...productVariantIds]);
    if (!ids.success) throw contractBroken("The Walmart stock-link source was asked about sizes its contract does not allow.");
    if (ids.data.length === 0) return [];
    const rows = parsedRows(listingRowSchema, (await client.query(`SELECT f.id AS feed_id, f.product_variant_id, v.product_id,
        f.channel_sku AS sku, w.environment
      ${CANDIDATE_FROM_SQL}
      WHERE ${CANDIDATE_SQL} AND f.product_variant_id = ANY($3::integer[]) AND w.ship_node_id = $4
      ORDER BY f.product_variant_id`, [scope.channelId, scope.connectionId, ids.data, scope.shipNodeId])).rows);
    if (new Set(rows.map(row => row.product_variant_id)).size !== rows.length) {
      throw contractBroken("A Walmart channel has two active feeds of one size.");
    }
    return rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id, listingId: row.feed_id,
      vendorId: null, cardShellzSku: row.sku, recordedOfferId: null,
      environment: row.environment === "production" || row.environment === "sandbox" ? row.environment : null,
      managed: true, skipReason: null, requireRecordedOffer: false }));
  }
}

export function createWalmartStockLinkSource(): WalmartStockLinkSource {
  return new WalmartStockLinkSource();
}

/**
 * A refusal the writer understands carries a namespaced code (Walmart guard, Walmart client, inventory owner:
 * `LISTING_…`, `WALMART_…`, `STOCK_…`, `PUBLICATION_…`). A PostgreSQL SQLSTATE (five characters, no underscore) or an
 * uncoded error is thrown for the engine's own table to classify.
 */
function knownRefusalCode(error: unknown): string | null {
  if (error === null || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return null;
  return /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(error.code) && error.code.length <= 120 ? error.code : null;
}

export interface WalmartStockLinkWriterDependencies {
  readonly channels: Pick<WalmartChannelService, "connection" | "withListingWrites">;
  readonly verifiedStock: Pick<VerifiedListingStockService, "connect">;
  /** Monotonic milliseconds: the link's whole duration bounds its fence hold (the engine's fence budget). */
  readonly monotonicNow: () => number;
}

/** The Walmart link writer the engine's enrollment pass calls (origin background). */
export function createWalmartStockLinkWriter(deps: WalmartStockLinkWriterDependencies): StockLinkEnrollmentWriter {
  return async (write: StockLinkEnrollmentWrite): Promise<StockLinkEnrollmentWriteResult> => {
    const scope = scopeOf(write.destination);
    const commandKey = `walmart-stock-link:${write.link.evidenceHash}`;
    const blocked = (code: string): StockLinkEnrollmentWriteResult => ({ status: "blocked", commandKey, blockers: [{ code }] });
    if (write.link.sku !== write.link.offerId || write.link.listingId === null || write.listing.environment === null) {
      // The adapter's offer is the SKU with its WPID; anything else is not a Walmart item the link can prove.
      throw contractBroken("A Walmart link was asked for without the item's SKU and WPID.");
    }
    const startedAt = deps.monotonicNow();
    try {
      const connection = await deps.channels.connection(scope.channelId, scope.connectionId);
      if (connection.ship_node_id !== scope.shipNodeId || connection.environment !== write.listing.environment)
        return blocked("STOCK_LISTING_TARGET_MISMATCH");
      // Only the new SKU is guarded: on a relink the old SKU's item may already be gone from Walmart, and its writes
      // are stopped under the inventory owner's pair and scope locks.
      const result = await deps.channels.withListingWrites(walmartListingAccount(connection), [write.link.sku],
        () => deps.verifiedStock.connect({ channelId: scope.channelId, connectionId: scope.connectionId,
          accountId: connection.partner_id, environment: connection.environment, externalScopeId: connection.ship_node_id,
          productVariantId: write.productVariantId, sku: write.link.sku, externalProductId: write.link.listingId,
          lifecycleStatus: "ACTIVE", publishedStatus: "PUBLISHED", observedAt: write.observedAt,
          ...(write.replacesSku !== null ? { replacesSku: write.replacesSku } : {}) }));
      if (result.state === "excluded") return blocked("STOCK_LISTING_EXCLUDED");
      return { status: "ready", commandKey, publicationTargetId: write.destination.publicationTargetId,
        alreadyLinked: result.state === "already_connected",
        fenceHoldMs: Math.max(0, Math.round(deps.monotonicNow() - startedAt)) };
    } catch (error) {
      const code = knownRefusalCode(error);
      // A database failure (SQLSTATE code, digits) or an uncoded error is the engine's to classify.
      if (code === null || error instanceof StockLinkError) throw error;
      return blocked(code);
    }
  };
}
