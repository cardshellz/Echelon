/**
 * One transaction-scoped advisory lock per (channel, size) for a channel's SKU override (channels PR2, PLAN-CH2 v4.1
 * §4.3 step 5; review DB-1). A row lock covers an override that exists, but a first override is an INSERT of a row no
 * one can lock yet; this key serializes that INSERT with the stock-link command that confirms the size's SKU, so the
 * command either reads the new override (STOCK_LINK_SKU_CHANGED_SINCE_READ) or the writer waits for its commit.
 *
 * Taken with pg_advisory_xact_lock inside a transaction only (CLAUDE.md §9): it is released at COMMIT or ROLLBACK.
 * Writers: channel-catalog.storage.ts upsertChannelVariantOverride (the only writer that sets sku_override) and the
 * Shopify stock-link source's lockForConfirmation. The eBay listing-intent insert never sets a SKU override, so it
 * needs none.
 */

const LOCK_NAMESPACE = "channel-variant-override";

/** The lock's key text for one size on one channel; hashed with hashtextextended(key, 0) like every text-keyed lock. */
export function channelVariantOverrideLockKey(channelId: number, productVariantId: number): string {
  for (const value of [channelId, productVariantId]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("A channel variant override lock needs positive integer ids.");
  }
  return `${LOCK_NAMESPACE}:${channelId}:${productVariantId}`;
}

/** One key: `$1` = the key text. */
export const CHANNEL_VARIANT_OVERRIDE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

/**
 * Several sizes of one channel, in variant-id order so two lockers never take them in opposite orders:
 * `$1` = channel id, `$2` = the variant ids. The same key text as channelVariantOverrideLockKey.
 */
export const CHANNEL_VARIANT_OVERRIDES_LOCK_SQL = `SELECT count(pg_advisory_xact_lock(hashtextextended(
    '${LOCK_NAMESPACE}:' || $1::integer::text || ':' || ordered.id::text, 0)))::int AS locked
  FROM (SELECT DISTINCT id FROM unnest($2::integer[]) AS id ORDER BY id) ordered`;
