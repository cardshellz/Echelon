-- Bound the recurring scan for dead internal Shopify fulfillment writeback debt.
-- The expression matches the immutable shipment identity persisted in retry payloads.
CREATE INDEX IF NOT EXISTS idx_webhook_retry_internal_shopify_writeback_debt
  ON oms.webhook_retry_queue (
    COALESCE(next_retry_at, updated_at, created_at),
    ((payload->>'shipmentId')::int),
    id
  )
  WHERE provider = 'internal'
    AND topic = 'shopify_fulfillment_push'
    AND status = 'dead'
    AND payload->>'shipmentId' ~ '^[0-9]+$';
