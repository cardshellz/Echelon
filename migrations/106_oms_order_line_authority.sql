-- Phase 2 OMS/WMS authority boundary.
-- OMS lines now carry explicit paid/fulfillable authority instead of letting
-- WMS infer warehouse work from raw channel line presence.

ALTER TABLE oms.oms_order_lines
  ADD COLUMN IF NOT EXISTS channel_observed_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS authority_fulfillable_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancelled_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wms_materialized_quantity INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS authorization_status VARCHAR(30) NOT NULL DEFAULT 'authorized',
  ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS authorized_by_event_id VARCHAR(100),
  ADD COLUMN IF NOT EXISTS authority_source_topic VARCHAR(50),
  ADD COLUMN IF NOT EXISTS authority_source_inbox_id INTEGER;

UPDATE oms.oms_order_lines
SET
  channel_observed_quantity = GREATEST(COALESCE(quantity, 0), 0),
  paid_quantity = GREATEST(COALESCE(quantity, 0), 0),
  authority_fulfillable_quantity = CASE
    WHEN fulfillable_quantity IS NULL THEN GREATEST(COALESCE(quantity, 0), 0)
    ELSE LEAST(GREATEST(COALESCE(quantity, 0), 0), GREATEST(fulfillable_quantity, 0))
  END,
  authorization_status = CASE
    WHEN COALESCE(quantity, 0) <= 0 THEN 'seen'
    ELSE 'authorized'
  END,
  authorized_at = COALESCE(authorized_at, updated_at, created_at, NOW()),
  authorized_by_event_id = COALESCE(authorized_by_event_id, 'legacy_backfill_106'),
  authority_source_topic = COALESCE(authority_source_topic, 'legacy_backfill')
WHERE authorized_by_event_id IS NULL
   OR authority_source_topic IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oms_order_lines_authority_nonnegative_chk'
  ) THEN
    ALTER TABLE oms.oms_order_lines
      ADD CONSTRAINT oms_order_lines_authority_nonnegative_chk
      CHECK (
        channel_observed_quantity >= 0
        AND paid_quantity >= 0
        AND authority_fulfillable_quantity >= 0
        AND cancelled_quantity >= 0
        AND refunded_quantity >= 0
        AND wms_materialized_quantity >= 0
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'oms_order_lines_authorization_status_chk'
  ) THEN
    ALTER TABLE oms.oms_order_lines
      ADD CONSTRAINT oms_order_lines_authorization_status_chk
      CHECK (
        authorization_status IN (
          'seen',
          'authorized',
          'partially_cancelled',
          'cancelled',
          'partially_refunded',
          'refunded',
          'review'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_oms_lines_authority_order
  ON oms.oms_order_lines(order_id, authorization_status);

CREATE INDEX IF NOT EXISTS idx_oms_lines_authority_source_inbox
  ON oms.oms_order_lines(authority_source_inbox_id)
  WHERE authority_source_inbox_id IS NOT NULL;
