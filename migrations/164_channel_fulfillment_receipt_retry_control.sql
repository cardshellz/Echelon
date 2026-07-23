-- Bound and audit inbound fulfillment retries without using the lifetime
-- attempt counter as a failure counter. The lifetime counter is immutable
-- evidence and may be high after a process crash or historical replay storm.
ALTER TABLE oms.channel_fulfillment_receipts
  ADD COLUMN IF NOT EXISTS retry_failure_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

ALTER TABLE oms.channel_fulfillment_receipts
  DROP CONSTRAINT IF EXISTS channel_fulfillment_receipts_retry_failure_chk;
ALTER TABLE oms.channel_fulfillment_receipts
  ADD CONSTRAINT channel_fulfillment_receipts_retry_failure_chk
  CHECK (retry_failure_count >= 0);

ALTER TABLE oms.channel_fulfillment_receipt_attempts
  DROP CONSTRAINT IF EXISTS channel_fulfillment_receipt_attempts_outcome_chk;
ALTER TABLE oms.channel_fulfillment_receipt_attempts
  ADD CONSTRAINT channel_fulfillment_receipt_attempts_outcome_chk CHECK (
    outcome IN ('processed', 'ignored', 'review', 'retryable', 'lease_expired')
  );

CREATE INDEX IF NOT EXISTS idx_channel_fulfillment_receipts_retry_due
  ON oms.channel_fulfillment_receipts(processing_status, next_retry_at, created_at)
  WHERE processing_status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION oms.channel_fulfillment_receipt_retry_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.retry_failure_count < OLD.retry_failure_count
     OR NEW.retry_failure_count > OLD.retry_failure_count + 1 THEN
    RAISE EXCEPTION 'Channel fulfillment receipt retry_failure_count must be monotonic'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.retry_failure_count = OLD.retry_failure_count + 1
     AND NOT (
       OLD.processing_status = 'processing'
       AND NEW.processing_status IN ('pending', 'review')
     ) THEN
    RAISE EXCEPTION 'A receipt retry failure can only finish an active processing attempt'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.processing_status <> 'pending'
     AND NEW.next_retry_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only pending channel fulfillment receipts may have next_retry_at'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_fulfillment_receipts_retry_update_guard
  ON oms.channel_fulfillment_receipts;
CREATE TRIGGER channel_fulfillment_receipts_retry_update_guard
  BEFORE UPDATE ON oms.channel_fulfillment_receipts
  FOR EACH ROW EXECUTE FUNCTION oms.channel_fulfillment_receipt_retry_update_guard();

-- A retry row needs an explicit event identity. This prevents a failed
-- internal loopback from creating a new retry row for the same event while
-- allowing a later Shopify update event for the same fulfillment to coexist.
ALTER TABLE oms.webhook_retry_queue
  ADD COLUMN IF NOT EXISTS retry_key VARCHAR(1000);

UPDATE oms.webhook_retry_queue
SET retry_key = CONCAT(
      'legacy:',
      provider,
      ':',
      topic,
      ':',
      COALESCE(NULLIF(payload->>'shop_domain', ''), 'unknown-shop'),
      ':',
      COALESCE(NULLIF(payload->>'order_id', ''), 'unknown-order'),
      ':',
      COALESCE(
        NULLIF(payload->>'__echelon_source_event_id', ''),
        md5(payload::text)
      )
    )
WHERE provider = 'shopify'
  AND topic IN ('fulfillments/create', 'fulfillments/update')
  AND retry_key IS NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_retry_queue_shopify_fulfillment_payload
  ON oms.webhook_retry_queue(
    (payload->>'order_id'),
    (payload->>'id'),
    status
  )
  WHERE provider = 'shopify'
    AND topic IN ('fulfillments/create', 'fulfillments/update');

-- A pre-cutover retry that already has a canonical receipt is transport debt,
-- not a second processing authority. The receipt recovery worker owns pending
-- and expired receipts after this migration. This prevents one final legacy
-- loopback from staging a duplicate receipt without its original event id.
UPDATE oms.webhook_retry_queue retry
SET status = 'success',
    last_error = 'Canonical channel fulfillment receipt owns recovery after retry-control cutover',
    updated_at = NOW()
FROM oms.channel_fulfillment_receipts receipt
WHERE retry.provider = receipt.source_provider
  AND retry.topic IN ('fulfillments/create', 'fulfillments/update')
  AND retry.payload->>'order_id' = receipt.source_order_id
  AND retry.payload->>'id' = receipt.source_fulfillment_id
  AND (
    retry.payload - 'shop_domain'
  ) = (
    receipt.raw_payload - 'shop_domain'
  )
  AND retry.status <> 'success'
  AND retry.retry_key LIKE 'legacy:%';

-- Keep the oldest pending retry as the runnable representative and retain all
-- redundant rows as successful superseded transport evidence.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY provider, topic, retry_key
      ORDER BY created_at ASC, id ASC
    ) AS row_number
  FROM oms.webhook_retry_queue
  WHERE status = 'pending'
    AND retry_key IS NOT NULL
)
UPDATE oms.webhook_retry_queue retry
SET status = 'success',
    last_error = 'Superseded duplicate retry for the same provider event',
    updated_at = NOW()
FROM ranked
WHERE retry.id = ranked.id
  AND ranked.row_number > 1;

DROP INDEX IF EXISTS oms.uq_webhook_retry_queue_pending_retry_key;
CREATE UNIQUE INDEX uq_webhook_retry_queue_pending_retry_key
  ON oms.webhook_retry_queue(provider, topic, retry_key)
  WHERE status = 'pending'
    AND retry_key IS NOT NULL;

-- Derive a compatibility identity for any legacy writer that omits retry_key
-- during a rolling deploy, and prevent identity mutation after insertion.
CREATE OR REPLACE FUNCTION oms.webhook_retry_queue_retry_key_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW.provider = 'shopify'
     AND NEW.topic IN ('fulfillments/create', 'fulfillments/update')
     AND NEW.retry_key IS NULL THEN
    NEW.retry_key := CONCAT(
      'legacy:',
      NEW.provider,
      ':',
      NEW.topic,
      ':',
      COALESCE(NULLIF(NEW.payload->>'shop_domain', ''), 'unknown-shop'),
      ':',
      COALESCE(NULLIF(NEW.payload->>'order_id', ''), 'unknown-order'),
      ':',
      COALESCE(
        NULLIF(NEW.payload->>'__echelon_source_event_id', ''),
        md5(NEW.payload::text)
      )
    );
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.retry_key IS DISTINCT FROM OLD.retry_key THEN
    RAISE EXCEPTION 'Webhook retry identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS webhook_retry_queue_retry_key_guard
  ON oms.webhook_retry_queue;
CREATE TRIGGER webhook_retry_queue_retry_key_guard
  BEFORE INSERT OR UPDATE ON oms.webhook_retry_queue
  FOR EACH ROW EXECUTE FUNCTION oms.webhook_retry_queue_retry_key_guard();
