CREATE INDEX IF NOT EXISTS channel_feeds_product_variant_active_idx
  ON channels.channel_feeds (product_variant_id, is_active);
