-- Dropship return channel intake (stack 4/4; design spec D2a; build spec
-- "Channel return intake adapters").
--
-- Per-channel return-intake adapters (eBay Post-Order API return cases,
-- Shopify Admin API returns/refunds) poll connected stores and feed one
-- normalized RMA draft pipeline. This migration adds:
--
-- 1. Per-store return-poll watermark (last_return_sync_at), separate from the
--    order-intake watermark so the two polls never starve each other.
-- 2. Channel return identity + evidence on the RMA row: channel_return_id
--    dedupes re-polled channel returns (unique per store connection),
--    channel_evidence carries the raw channel payload + extracted label cost
--    (the fee engine reads the actual return label cost from here, D2a),
--    return_carrier pairs with return_tracking_number for the PR 3
--    no-inspection watcher.
-- 3. dropship_return_intake_exceptions: quarantine queue for channel returns
--    that could not be turned into an RMA (unknown order, unmapped items,
--    provider payload problems). One row per (store connection, channel
--    return id) — re-polls upsert the attempt count, never duplicate.
--    A row here NEVER blocks the poll watermark (deep review 3.5 poison-pill
--    lesson: per-return errors are caught, recorded, and the watermark still
--    advances).

-- 1. Return-poll watermark on store connections.

ALTER TABLE dropship.dropship_store_connections
  ADD COLUMN IF NOT EXISTS last_return_sync_at timestamptz;

COMMENT ON COLUMN dropship.dropship_store_connections.last_return_sync_at IS
  'Return-intake poll watermark (migration 189). Independent of last_order_sync_at so return and order polls never starve each other.';

-- 2. Channel return identity + evidence on RMAs.

ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS channel_return_id varchar(120);

ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS channel_evidence jsonb;

ALTER TABLE dropship.dropship_rmas
  ADD COLUMN IF NOT EXISTS return_carrier varchar(80);

COMMENT ON COLUMN dropship.dropship_rmas.channel_return_id IS
  'Channel-side return/case/refund identifier (eBay returnId, Shopify return gid). Unique per store connection; dedupes re-polled channel returns (D2a).';

COMMENT ON COLUMN dropship.dropship_rmas.channel_evidence IS
  'Normalized channel return evidence jsonb: raw channel payload, extracted label cost cents, fault hint, return tracking. The fee engine reads the actual return label cost from here (D2a: piped, never manual).';

COMMENT ON COLUMN dropship.dropship_rmas.return_carrier IS
  'Return-leg carrier (pairs with return_tracking_number) for the no-inspection watcher tracking provider (D3).';

CREATE UNIQUE INDEX IF NOT EXISTS dropship_rma_channel_return_idx
  ON dropship.dropship_rmas(store_connection_id, channel_return_id)
  WHERE channel_return_id IS NOT NULL;

-- 3. Return-intake exception queue.

CREATE TABLE IF NOT EXISTS dropship.dropship_return_intake_exceptions (
  id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
  store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
  platform varchar(30) NOT NULL,
  channel_return_id varchar(120) NOT NULL,
  failure_code varchar(80) NOT NULL,
  message text NOT NULL,
  channel_payload jsonb,
  attempt_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_return_intake_exc_platform_chk CHECK (platform IN ('ebay','shopify','tiktok','instagram','bigcommerce')),
  CONSTRAINT dropship_return_intake_exc_attempts_chk CHECK (attempt_count > 0)
);

-- One open row per (store connection, channel return id): re-polls of the
-- same failing return upsert attempt_count/last_seen_at instead of inserting
-- duplicates. Partial unique so resolved rows don't block a fresh failure.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_return_intake_exc_open_idx
  ON dropship.dropship_return_intake_exceptions(store_connection_id, channel_return_id)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS dropship_return_intake_exc_vendor_idx
  ON dropship.dropship_return_intake_exceptions(vendor_id, resolved_at, last_seen_at);

COMMENT ON TABLE dropship.dropship_return_intake_exceptions IS
  'Quarantine queue for channel returns that failed RMA draft creation (unknown order, unmapped items, bad payloads). One open row per (store connection, channel return id). Rows here never block the poll watermark (deep review 3.5).';
