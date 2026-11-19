import { z } from "zod";
import { stockLinkDestinationSchema, type StockLinkDestination } from "@shared/types/stock-link";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type {
  StockLinkCandidatePage, StockLinkCarriedSkuRow, StockLinkConfirmation, StockLinkRecentChange, StockLinkRecentCursor,
  StockLinkSizeSkuRow, StockLinkSource,
} from "../../inventory-planning/application/stock-link.ports";
import { STOCK_LINK_ERROR_CODES, StockLinkError } from "../../inventory-planning/domain/stock-link-errors";
import { shopifyStockLinkFingerprint } from "../adapters/shopify-stock-link.adapter";
import { CHANNEL_VARIANT_OVERRIDES_LOCK_SQL } from "./channel-variant-override-lock";

/**
 * Channels' read-only SQL for the stock-link engine's Shopify destinations (channels PR2, PLAN-CH2 v4.1 §6.2;
 * IP/application/stock-link.ports.ts StockLinkSource). Every statement is a SELECT on the engine's client (its
 * transaction where one is open); nothing here writes (writer ratchet, P-19), calls a provider or decides a link.
 *
 * "Carried" (the sizes the engine looks after on a destination, OQ2 default: only what the Channels selection carries)
 * is pre-filtered here from what the Channels selection itself needs (CH/channel-stock-selection.domain.ts):
 * - `publish` needs an active feed; `zero` needs a saved identity (a feed or listing row with an inventory item,
 *   variant or SKU; an active feed always has a variant id, `channel_feeds_active_identity_chk`);
 * - an archived catalog member is `none` (isArchivedCatalogMember: product or variant inactive, or product status
 *   `archived`).
 * So this set holds every `publish` and `zero` size. It can also hold a size the selection calls `read_only` (selected,
 * with a listing identity but no feed row) or `none` (an active feed without identity on a size no longer selected):
 * the engine reads the exact selection (readPublicationStockSelection) of every size it decides, so such a size is
 * never linked, and for N6 a wider set can only flag a shared SKU, never miss one.
 */

const id = z.number().int().positive().max(2_147_483_647);
/** The claim bound of one tick (§7.2 step 4): the sizes one source call is asked about. */
const SIZES_PER_CALL_MAX = 500;
const variantIdsSchema = z.array(id).max(SIZES_PER_CALL_MAX)
  .refine(ids => new Set(ids).size === ids.length, "Each size is asked for once.");
const pageLimitSchema = z.number().int().positive().max(SIZES_PER_CALL_MAX);
/** channel_feeds.updated_at (timestamp without time zone) as this source returns it: ISO, all six fractional digits. */
const RAW_FEED_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/;
/** A cursor as it comes back: this source's form, or Postgres' own text of the stored `recent_cursor_raw` (M1, D-P1-4),
 * which drops trailing zero fractions. Either is read back exactly by `::timestamp`. */
const RAW_CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const recentCursorSchema = z.object({
  raw: z.string().regex(RAW_CURSOR_TIME_PATTERN).nullable(),
  id: id.nullable(),
}).strict().refine(cursor => (cursor.raw === null) === (cursor.id === null), "A cursor has both its time and its id, or neither.");
/**
 * The overlap behind the raw cursor (§6.2, TST-8): a feed written a little out of order (its writer's clock or
 * transaction ran behind another's) is still found. Each overlap row comes back with `fresh: false`; what the engine
 * does with it is the engine's rule (it adds a missing row, never wakes one).
 */
export const SHOPIFY_STOCK_LINK_RECENT_OVERLAP = "10 minutes";

/**
 * The carried-size predicate on `v` (catalog.product_variants) joined to `p` (catalog.products), for channel $1.
 * It is the Channels selection's own preconditions for `publish` and `zero` (file comment), nothing more.
 */
const CARRIED_SIZE_SQL = `p.is_active IS NOT FALSE AND v.is_active IS NOT FALSE AND p.status IS DISTINCT FROM 'archived'
  AND v.id IN (
    SELECT f.product_variant_id FROM channels.channel_feeds f
    WHERE f.channel_id = $1 AND (f.is_active = 1 OR NULLIF(btrim(f.channel_inventory_item_id), '') IS NOT NULL
      OR NULLIF(btrim(f.channel_variant_id), '') IS NOT NULL OR NULLIF(btrim(f.channel_sku), '') IS NOT NULL)
    UNION
    SELECT l.product_variant_id FROM channels.channel_listings l
    WHERE l.channel_id = $1 AND (NULLIF(btrim(l.external_product_id), '') IS NOT NULL
      OR NULLIF(btrim(l.external_variant_id), '') IS NOT NULL OR NULLIF(btrim(l.external_sku), '') IS NOT NULL))`;

/** The Card Shellz SKU of `v` for channel $1 as stored (§4.2: COALESCE(sku_override, v.sku); the engine trims). */
const CARD_SHELLZ_SKU_SQL = "COALESCE(o.sku_override, v.sku)";

const candidateRowSchema = z.object({ product_variant_id: id, product_id: id }).strict();
const recentRowSchema = z.object({
  feed_id: id, product_variant_id: id, product_id: id, changed_at_raw: z.string().regex(RAW_FEED_TIME_PATTERN), carried: z.boolean(),
  fresh: z.boolean(),
}).strict();
const carriedSkuRowSchema = z.object({ product_variant_id: id, sku: z.string().nullable() }).strict();
const sizeSkuRowSchema = z.object({ product_variant_id: id, product_id: id, sku: z.string().nullable(), hint: z.string().nullable() }).strict();
const connectionRowSchema = z.object({
  id, shop_domain: z.string().nullable(), access_token: z.string().nullable(), shopify_location_id: z.string().nullable(),
}).strict();

interface ShopifySourceScope {
  readonly channelId: number;
  readonly channelConnectionId: number;
}

/** A call or a row this source's contract forbids: the engine's wiring bug or a broken row, fatal for the destination
 * (STOCK_LINK_ADAPTER_CONTRACT in domain/stock-link-errors.ts), never retried. */
function contractBroken(message: string): StockLinkError {
  return new StockLinkError(STOCK_LINK_ERROR_CODES.adapterContract, message);
}

/** A destination this source cannot read for is the engine's wiring bug (the registry resolves by kind + provider). */
function scopeOf(destination: StockLinkDestination): ShopifySourceScope {
  const parsed = stockLinkDestinationSchema.safeParse(destination);
  if (!parsed.success || parsed.data.destinationKind !== "channel_connection" || parsed.data.providerKey !== "shopify"
    || parsed.data.channelConnectionId === null) {
    throw contractBroken("The Shopify stock-link source was given another kind of destination.");
  }
  return { channelId: parsed.data.channelId, channelConnectionId: parsed.data.channelConnectionId };
}

function parsedRows<S extends z.ZodTypeAny>(schema: S, rows: readonly unknown[]): z.infer<S>[] {
  const parsed = z.array(schema).safeParse(rows);
  if (!parsed.success) {
    throw contractBroken("The Shopify stock-link source read rows its contract does not allow.");
  }
  return parsed.data;
}

function variantIds(values: readonly number[]): number[] {
  const parsed = variantIdsSchema.safeParse(values);
  if (!parsed.success) {
    throw contractBroken("The Shopify stock-link source was asked about sizes its contract does not allow.");
  }
  return parsed.data;
}

/** The stored login of the destination's own connection (null fields when the row is gone or incomplete). */
async function readConnectionFingerprint(client: StockSelectionQueryClient, scope: ShopifySourceScope, lock: boolean): Promise<string> {
  const rows = parsedRows(connectionRowSchema, (await client.query(`SELECT id, shop_domain, access_token, shopify_location_id
    FROM channels.channel_connections WHERE id = $1 AND channel_id = $2${lock ? " FOR SHARE" : ""}`,
  [scope.channelConnectionId, scope.channelId])).rows);
  const row = rows[0];
  // A missing row fingerprints as a login with nothing in it: no read is ever made with one (the adapter refuses an
  // incomplete login), so it can never equal a read's fingerprint.
  return shopifyStockLinkFingerprint({ id: scope.channelConnectionId, shopDomain: row?.shop_domain ?? null,
    accessToken: row?.access_token ?? null, shopifyLocationId: row?.shopify_location_id ?? null });
}

export class ShopifyStockLinkSource implements StockLinkSource {
  readonly destinationKind = "channel_connection" as const;
  readonly providerKey = "shopify";

  async listCandidates(client: StockSelectionQueryClient, destination: StockLinkDestination, afterVariantId: number,
    limit: number): Promise<StockLinkCandidatePage> {
    const scope = scopeOf(destination);
    const after = z.number().int().nonnegative().max(2_147_483_647).safeParse(afterVariantId);
    const bound = pageLimitSchema.safeParse(limit);
    if (!after.success || !bound.success) {
      throw contractBroken("The Shopify stock-link source was asked for a page its contract does not allow.");
    }
    const rows = parsedRows(candidateRowSchema, (await client.query(`SELECT v.id AS product_variant_id, v.product_id
      FROM catalog.product_variants v JOIN catalog.products p ON p.id = v.product_id
      WHERE ${CARRIED_SIZE_SQL} AND v.id > $2
      ORDER BY v.id LIMIT $3`, [scope.channelId, after.data, bound.data])).rows);
    return {
      candidates: rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id })),
      // A short page is the end of the sweep; a full one may have more after its last size.
      nextAfterVariantId: rows.length === bound.data ? rows[rows.length - 1]!.product_variant_id : null,
    };
  }

  async listRecentlyChanged(client: StockSelectionQueryClient, destination: StockLinkDestination, cursor: StockLinkRecentCursor,
    limit: number): Promise<readonly StockLinkRecentChange[]> {
    const scope = scopeOf(destination);
    const position = recentCursorSchema.safeParse(cursor);
    const bound = pageLimitSchema.safeParse(limit);
    if (!position.success || !bound.success) {
      throw contractBroken("The Shopify stock-link source was given a cursor its contract does not allow.");
    }
    // The cursor is the raw value last read, compared only with other raw values of the same column: never with now()
    // or the injected clock, so the app's and the database's time zones cannot skip a feed (TST-8). to_char keeps the
    // text independent of the session's DateStyle; the parameter is ISO, which every DateStyle reads the same way.
    // The changes after the cursor itself come first (`fresh`), then the overlap's: the overlap is re-read every tick
    // and may alone hold more than a page, so ordered by time alone it could hold the cursor back for good (P7).
    const rows = parsedRows(recentRowSchema, (await client.query(`SELECT f.id AS feed_id, f.product_variant_id, v.product_id,
        to_char(f.updated_at, 'YYYY-MM-DD HH24:MI:SS.US') AS changed_at_raw,
        EXISTS (SELECT 1 FROM catalog.products p WHERE p.id = v.product_id AND ${CARRIED_SIZE_SQL}) AS carried,
        ($2::timestamp IS NULL OR (f.updated_at, f.id) > ($2::timestamp, $3::integer)) AS fresh
      FROM channels.channel_feeds f JOIN catalog.product_variants v ON v.id = f.product_variant_id
      WHERE f.channel_id = $1
        AND ($2::timestamp IS NULL OR (f.updated_at, f.id) > ($2::timestamp - interval '${SHOPIFY_STOCK_LINK_RECENT_OVERLAP}', $3::integer))
      ORDER BY fresh DESC, f.updated_at, f.id LIMIT $4`, [scope.channelId, position.data.raw, position.data.id, bound.data])).rows);
    return rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id, changedAtRaw: row.changed_at_raw,
      feedId: row.feed_id, carried: row.carried, fresh: row.fresh }));
  }

  async listCarriedSkus(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<readonly StockLinkCarriedSkuRow[]> {
    const scope = scopeOf(destination);
    const rows = parsedRows(carriedSkuRowSchema, (await client.query(`SELECT v.id AS product_variant_id, ${CARD_SHELLZ_SKU_SQL} AS sku
      FROM catalog.product_variants v JOIN catalog.products p ON p.id = v.product_id
      LEFT JOIN channels.channel_variant_overrides o ON o.channel_id = $1 AND o.product_variant_id = v.id
      WHERE ${CARRIED_SIZE_SQL}
      ORDER BY v.id`, [scope.channelId])).rows);
    return rows.map(row => ({ productVariantId: row.product_variant_id, sku: row.sku }));
  }

  async readSkus(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<readonly StockLinkSizeSkuRow[]> {
    const scope = scopeOf(destination);
    const ids = variantIds(productVariantIds);
    if (ids.length === 0) return [];
    const rows = parsedRows(sizeSkuRowSchema, (await client.query(`SELECT v.id AS product_variant_id, v.product_id,
        ${CARD_SHELLZ_SKU_SQL} AS sku, NULLIF(btrim(f.channel_inventory_item_id), '') AS hint
      FROM catalog.product_variants v
      LEFT JOIN channels.channel_variant_overrides o ON o.channel_id = $1 AND o.product_variant_id = v.id
      LEFT JOIN channels.channel_feeds f ON f.channel_id = $1 AND f.product_variant_id = v.id
      WHERE v.id = ANY($2::integer[])
      ORDER BY v.id`, [scope.channelId, ids])).rows);
    return rows.map(row => ({ productVariantId: row.product_variant_id, productId: row.product_id, cardShellzSku: row.sku,
      feedHintItemId: row.hint }));
  }

  async readFingerprint(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<string> {
    return readConnectionFingerprint(client, scopeOf(destination), false);
  }

  /**
   * §4.3 step 5, inside the engine's transaction: the connection row, then each size's override lock (a first override
   * is an INSERT no row lock covers; review DB-1, channel-variant-override-lock.ts), then the sizes' override rows and
   * variant rows, each FOR SHARE in id order (the same rows and order as the fixture command's PG cases), then what
   * they hold now.
   * A concurrent change of the login or a SKU waits for the command's commit (or the command's lock_timeout gives 55P03,
   * busy). The engine compares; this only reads (BUILD-NOTES D-P4-1).
   */
  async lockForConfirmation(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<StockLinkConfirmation> {
    const scope = scopeOf(destination);
    const ids = variantIds(productVariantIds);
    const fingerprint = await readConnectionFingerprint(client, scope, true);
    if (ids.length === 0) return { fingerprint, skus: [] };
    await client.query(CHANNEL_VARIANT_OVERRIDES_LOCK_SQL, [scope.channelId, ids]);
    await client.query(`SELECT o.product_variant_id FROM channels.channel_variant_overrides o
      WHERE o.channel_id = $1 AND o.product_variant_id = ANY($2::integer[]) ORDER BY o.product_variant_id FOR SHARE`, [scope.channelId, ids]);
    const rows = parsedRows(carriedSkuRowSchema, (await client.query(`SELECT v.id AS product_variant_id, ${CARD_SHELLZ_SKU_SQL} AS sku
      FROM catalog.product_variants v
      LEFT JOIN channels.channel_variant_overrides o ON o.channel_id = $1 AND o.product_variant_id = v.id
      WHERE v.id = ANY($2::integer[])
      ORDER BY v.id FOR SHARE OF v`, [scope.channelId, ids])).rows);
    return { fingerprint, skus: rows.map(row => ({ productVariantId: row.product_variant_id, cardShellzSku: row.sku })) };
  }
}

export function createShopifyStockLinkSource(): ShopifyStockLinkSource {
  return new ShopifyStockLinkSource();
}
