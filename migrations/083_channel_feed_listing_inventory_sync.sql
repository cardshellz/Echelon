-- Ensure the channel feed ledger has one row per channel/variant.
-- The inventory sync code uses this as the durable "last quantity accepted by
-- the channel" record; duplicates make skip decisions non-deterministic.

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY channel_id, product_variant_id
      ORDER BY last_synced_at DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM channels.channel_feeds
)
DELETE FROM channels.channel_feeds cf
USING ranked r
WHERE cf.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS channel_feeds_channel_pv_idx
  ON channels.channel_feeds (channel_id, product_variant_id);
