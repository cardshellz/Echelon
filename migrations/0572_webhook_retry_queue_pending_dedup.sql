-- D-RETRYDEDUP: Prevent duplicate pending retry rows for the same scope.
-- The application-level SELECT check in enqueueShopifyFulfillmentRetry and
-- enqueueDelayedTrackingPush can race under concurrent SHIP_NOTIFY webhooks.
-- This partial unique index enforces at the DB layer that only one pending
-- retry can exist per (topic, payload scope).
--
-- For shopify_fulfillment_push the scope is payload->>'shipmentId'.
-- For delayed_tracking_push the scope is (payload->>'orderId', payload->>'shipmentId').
-- We index on (topic, payload->>'shipmentId') which covers both — the orderId
-- is implicit for tracking pushes since each shipment belongs to one order.

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_queue_pending_dedup
  ON oms.webhook_retry_queue (topic, (payload->>'shipmentId'))
  WHERE status = 'pending'
    AND payload->>'shipmentId' IS NOT NULL;
