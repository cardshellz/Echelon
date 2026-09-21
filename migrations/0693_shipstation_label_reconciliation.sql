-- Durable, fenced progress for the application's configured ShipStation V1 account.
-- Evidence and channel correction receipts remain in their existing owner tables.
CREATE TABLE IF NOT EXISTS oms.shipstation_label_reconciliation_checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  completed_through TIMESTAMPTZ NOT NULL,
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  next_page INTEGER NOT NULL DEFAULT 1 CHECK (next_page > 0),
  lease_until TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((window_start IS NULL AND window_end IS NULL AND next_page = 1)
    OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_start < window_end))
);
