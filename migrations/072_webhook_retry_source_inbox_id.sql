ALTER TABLE oms.webhook_retry_queue
  ADD COLUMN IF NOT EXISTS source_inbox_id integer REFERENCES oms.webhook_inbox(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_retry_queue_source_inbox_id
  ON oms.webhook_retry_queue(source_inbox_id)
  WHERE source_inbox_id IS NOT NULL;
