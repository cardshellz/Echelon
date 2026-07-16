CREATE TABLE IF NOT EXISTS oms.ebay_order_poll_checkpoints (
  channel_id INTEGER PRIMARY KEY REFERENCES channels.channels(id) ON DELETE CASCADE,
  last_window_end TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_deep_scan_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_orders_seen INTEGER NOT NULL DEFAULT 0,
  last_orders_ingested INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ebay_order_poll_checkpoint_failures_chk
    CHECK (consecutive_failures >= 0),
  CONSTRAINT ebay_order_poll_checkpoint_counts_chk
    CHECK (last_orders_seen >= 0 AND last_orders_ingested >= 0)
);

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload #>> '{notification,data,orderId}'
      ORDER BY created_at, id
    ) AS row_number
  FROM oms.webhook_retry_queue
  WHERE provider = 'ebay'
    AND status = 'pending'
    AND payload #>> '{notification,data,orderId}' IS NOT NULL
)
UPDATE oms.webhook_retry_queue retry
SET status = 'success',
    last_error = COALESCE(retry.last_error || E'\n', '')
      || 'Duplicate pending eBay order-ingestion retry retired by migration 145.',
    updated_at = NOW()
FROM ranked
WHERE retry.id = ranked.id
  AND ranked.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_ebay_order
  ON oms.webhook_retry_queue ((payload #>> '{notification,data,orderId}'))
  WHERE provider = 'ebay'
    AND status = 'pending'
    AND payload #>> '{notification,data,orderId}' IS NOT NULL;
