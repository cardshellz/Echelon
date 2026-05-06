-- Enforce pending retry idempotency at the database boundary.
-- Application enqueue helpers also check for existing pending rows, but these
-- partial unique indexes close the remaining concurrent insert race.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'resource_url'
      ORDER BY id
    ) AS rn
  FROM oms.webhook_retry_queue
  WHERE provider = 'shipstation'
    AND topic = 'SHIP_NOTIFY'
    AND status = 'pending'
    AND payload->>'resource_url' IS NOT NULL
)
UPDATE oms.webhook_retry_queue q
SET
  status = 'success',
  last_error = COALESCE(q.last_error || E'\n', '') || 'Duplicate pending retry retired by 073_webhook_retry_pending_scope_uniques.sql.',
  updated_at = NOW()
FROM ranked
WHERE q.id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'shipmentId'
      ORDER BY id
    ) AS rn
  FROM oms.webhook_retry_queue
  WHERE provider = 'internal'
    AND topic = 'shopify_fulfillment_push'
    AND status = 'pending'
    AND payload->>'shipmentId' IS NOT NULL
)
UPDATE oms.webhook_retry_queue q
SET
  status = 'success',
  last_error = COALESCE(q.last_error || E'\n', '') || 'Duplicate pending retry retired by 073_webhook_retry_pending_scope_uniques.sql.',
  updated_at = NOW()
FROM ranked
WHERE q.id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'shipmentId'
      ORDER BY id
    ) AS rn
  FROM oms.webhook_retry_queue
  WHERE provider = 'internal'
    AND topic = 'delayed_tracking_push'
    AND status = 'pending'
    AND payload->>'shipmentId' IS NOT NULL
)
UPDATE oms.webhook_retry_queue q
SET
  status = 'success',
  last_error = COALESCE(q.last_error || E'\n', '') || 'Duplicate pending retry retired by 073_webhook_retry_pending_scope_uniques.sql.',
  updated_at = NOW()
FROM ranked
WHERE q.id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'orderId'
      ORDER BY id
    ) AS rn
  FROM oms.webhook_retry_queue
  WHERE provider = 'internal'
    AND topic = 'delayed_tracking_push'
    AND status = 'pending'
    AND payload->>'orderId' IS NOT NULL
    AND payload->>'shipmentId' IS NULL
)
UPDATE oms.webhook_retry_queue q
SET
  status = 'success',
  last_error = COALESCE(q.last_error || E'\n', '') || 'Duplicate pending retry retired by 073_webhook_retry_pending_scope_uniques.sql.',
  updated_at = NOW()
FROM ranked
WHERE q.id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'omsOrderId'
      ORDER BY id
    ) AS rn
  FROM oms.webhook_retry_queue
  WHERE provider = 'internal'
    AND topic = 'oms_wms_sync'
    AND status = 'pending'
    AND payload->>'omsOrderId' IS NOT NULL
)
UPDATE oms.webhook_retry_queue q
SET
  status = 'success',
  last_error = COALESCE(q.last_error || E'\n', '') || 'Duplicate pending retry retired by 073_webhook_retry_pending_scope_uniques.sql.',
  updated_at = NOW()
FROM ranked
WHERE q.id = ranked.id
  AND ranked.rn > 1;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY payload->>'wmsOrderId'
      ORDER BY id
    ) AS rn
  FROM oms.webhook_retry_queue
  WHERE provider = 'internal'
    AND topic = 'wms_shipment_create'
    AND status = 'pending'
    AND payload->>'wmsOrderId' IS NOT NULL
)
UPDATE oms.webhook_retry_queue q
SET
  status = 'success',
  last_error = COALESCE(q.last_error || E'\n', '') || 'Duplicate pending retry retired by 073_webhook_retry_pending_scope_uniques.sql.',
  updated_at = NOW()
FROM ranked
WHERE q.id = ranked.id
  AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_shipstation_resource_url
  ON oms.webhook_retry_queue ((payload->>'resource_url'))
  WHERE provider = 'shipstation'
    AND topic = 'SHIP_NOTIFY'
    AND status = 'pending'
    AND payload->>'resource_url' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_shopify_fulfillment_shipment
  ON oms.webhook_retry_queue ((payload->>'shipmentId'))
  WHERE provider = 'internal'
    AND topic = 'shopify_fulfillment_push'
    AND status = 'pending'
    AND payload->>'shipmentId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_delayed_tracking_shipment
  ON oms.webhook_retry_queue ((payload->>'shipmentId'))
  WHERE provider = 'internal'
    AND topic = 'delayed_tracking_push'
    AND status = 'pending'
    AND payload->>'shipmentId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_delayed_tracking_order
  ON oms.webhook_retry_queue ((payload->>'orderId'))
  WHERE provider = 'internal'
    AND topic = 'delayed_tracking_push'
    AND status = 'pending'
    AND payload->>'orderId' IS NOT NULL
    AND payload->>'shipmentId' IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_oms_wms_sync_order
  ON oms.webhook_retry_queue ((payload->>'omsOrderId'))
  WHERE provider = 'internal'
    AND topic = 'oms_wms_sync'
    AND status = 'pending'
    AND payload->>'omsOrderId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_webhook_retry_pending_wms_shipment_create_order
  ON oms.webhook_retry_queue ((payload->>'wmsOrderId'))
  WHERE provider = 'internal'
    AND topic = 'wms_shipment_create'
    AND status = 'pending'
    AND payload->>'wmsOrderId' IS NOT NULL;
