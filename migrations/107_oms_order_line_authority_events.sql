-- Append-only audit ledger for OMS line authority changes.
-- Latest authority fields on oms.oms_order_lines remain the hot-path
-- enforcement cache; this table records the idempotent audit stream.

CREATE TABLE IF NOT EXISTS oms.oms_order_line_authority_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key VARCHAR(500) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
  order_line_id BIGINT NOT NULL REFERENCES oms.oms_order_lines(id) ON DELETE CASCADE,
  source_topic VARCHAR(50) NOT NULL,
  source_event_id VARCHAR(100),
  source_inbox_id INTEGER,
  previous_channel_observed_quantity INTEGER,
  previous_paid_quantity INTEGER,
  previous_authority_fulfillable_quantity INTEGER,
  previous_authorization_status VARCHAR(30),
  channel_observed_quantity INTEGER NOT NULL,
  paid_quantity INTEGER NOT NULL,
  authority_fulfillable_quantity INTEGER NOT NULL,
  cancelled_quantity INTEGER NOT NULL DEFAULT 0,
  refunded_quantity INTEGER NOT NULL DEFAULT 0,
  authorization_status VARCHAR(30) NOT NULL,
  authorized_at TIMESTAMP,
  authorized_by_event_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW() NOT NULL,
  CONSTRAINT oms_line_authority_events_event_key_uidx UNIQUE (event_key),
  CONSTRAINT oms_line_authority_events_quantities_chk CHECK (
    channel_observed_quantity >= 0
    AND paid_quantity >= 0
    AND authority_fulfillable_quantity >= 0
    AND cancelled_quantity >= 0
    AND refunded_quantity >= 0
    AND (previous_channel_observed_quantity IS NULL OR previous_channel_observed_quantity >= 0)
    AND (previous_paid_quantity IS NULL OR previous_paid_quantity >= 0)
    AND (previous_authority_fulfillable_quantity IS NULL OR previous_authority_fulfillable_quantity >= 0)
  ),
  CONSTRAINT oms_line_authority_events_status_chk CHECK (
    authorization_status IN (
      'seen',
      'authorized',
      'partially_cancelled',
      'cancelled',
      'partially_refunded',
      'refunded',
      'review'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_oms_line_authority_events_order
  ON oms.oms_order_line_authority_events(order_id);

CREATE INDEX IF NOT EXISTS idx_oms_line_authority_events_line
  ON oms.oms_order_line_authority_events(order_line_id);

CREATE INDEX IF NOT EXISTS idx_oms_line_authority_events_source
  ON oms.oms_order_line_authority_events(source_topic, source_event_id);
