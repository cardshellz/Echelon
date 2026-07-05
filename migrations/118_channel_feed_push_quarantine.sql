-- 118: quarantine permanently-failing inventory-push mappings (CLAUDE.md §6).
--
-- A Shopify 404 on inventory_levels/set (or an eBay 25710/25713 after failed
-- offer recovery) means the external resource is GONE — retrying can never
-- succeed. Before this, the sweep re-pushed such mappings every 15 minutes
-- forever (the ARM-ENV-SGL-C700 error-tail class). Now the orchestrator
-- counts consecutive permanent failures per (channel, variant) and, at the
-- threshold, stamps quarantined_at: the push loop skips quarantined rows and
-- the listing is flagged for review. A successful push, or a re-link repair
-- (scripts/relink-shopify-variant-ids.ts), clears the quarantine.

ALTER TABLE channels.channel_feeds
  ADD COLUMN IF NOT EXISTS consecutive_push_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quarantined_at timestamp,
  ADD COLUMN IF NOT EXISTS quarantine_reason text;

COMMENT ON COLUMN channels.channel_feeds.consecutive_push_failures IS
  'Consecutive PERMANENT push failures (404 etc.). Reset to 0 on success; quarantine at threshold.';
COMMENT ON COLUMN channels.channel_feeds.quarantined_at IS
  'When set, the inventory push loop skips this mapping (external resource is gone). Cleared on repair.';
