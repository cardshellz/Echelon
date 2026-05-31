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
--
-- CLEANUP: Remove existing duplicate pending rows (keep earliest per group).
-- These are race-condition duplicates from concurrent SHIP_NOTIFY processing.
-- Only one retry per scope needs to fire; extras would just no-op on execution.

-- Step 1: Remove duplicate pending rows, keeping the earliest (lowest id) per group.
DELETE FROM oms.webhook_retry_queue
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY topic, (payload->>'shipmentId')
             ORDER BY id
           ) AS rn
    FROM oms.webhook_retry_queue
    WHERE status = 'pending'
      AND payload->>'shipmentId' IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Step 2: Create the dedup index now that duplicates are cleaned.
DROP INDEX IF EXISTS oms.uq_webhook_retry_queue_pending_dedup;

CREATE UNIQUE INDEX uq_webhook_retry_queue_pending_dedup
  ON oms.webhook_retry_queue (topic, (payload->>'shipmentId'))
  WHERE status = 'pending'
    AND payload->>'shipmentId' IS NOT NULL;
