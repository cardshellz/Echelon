CREATE TABLE IF NOT EXISTS oms.shopify_order_bridge_checkpoints (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  monitor_started_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_candidates INTEGER NOT NULL DEFAULT 0,
  last_bridged INTEGER NOT NULL DEFAULT 0,
  last_failed INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT shopify_order_bridge_checkpoint_singleton_chk CHECK (id = 1),
  CONSTRAINT shopify_order_bridge_checkpoint_failures_chk
    CHECK (consecutive_failures >= 0),
  CONSTRAINT shopify_order_bridge_checkpoint_counts_chk
    CHECK (last_candidates >= 0 AND last_bridged >= 0 AND last_failed >= 0)
);

INSERT INTO oms.shopify_order_bridge_checkpoints (id, monitor_started_at)
VALUES (1, TIMESTAMPTZ '2026-07-01 00:00:00+00')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_shopify_orders_bridge_scan
  ON public.shopify_orders (created_at, id);
