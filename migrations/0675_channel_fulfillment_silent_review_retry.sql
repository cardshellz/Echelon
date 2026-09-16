-- Suppression belongs to the immutable, operator-attributed retry audit, not
-- the original command metadata or request hash. No commands are requeued here.
ALTER TABLE oms.channel_fulfillment_push_requeues
  ADD COLUMN IF NOT EXISTS notify_customer_override BOOLEAN
  CHECK (notify_customer_override IS NULL OR notify_customer_override = FALSE);

COMMENT ON COLUMN oms.channel_fulfillment_push_requeues.notify_customer_override IS
  'NULL preserves original notification intent; FALSE authorizes silent retries of the exact previous_request_hash. Never enables notifications.';

-- A pre-deployment/rolled-back worker must not claim a silent retry while
-- ignoring its audit policy. The new claimant acknowledges each attempt; an
-- old claimant leaves the previous number unchanged and fails before API I/O.
ALTER TABLE oms.channel_fulfillment_pushes
  ADD COLUMN IF NOT EXISTS notification_policy_attempt INTEGER
  CHECK (notification_policy_attempt IS NULL OR notification_policy_attempt >= 0);

CREATE OR REPLACE FUNCTION oms.guard_silent_fulfillment_retry_claim()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.push_status = 'processing'
     AND NEW.notification_policy_attempt IS DISTINCT FROM NEW.attempt_count
     AND EXISTS (
       SELECT 1 FROM oms.channel_fulfillment_push_requeues audit
       WHERE audit.channel_fulfillment_push_id = NEW.id
         AND audit.previous_request_hash = NEW.request_hash
         AND audit.notify_customer_override = FALSE
     ) THEN
    RAISE EXCEPTION 'Silent fulfillment retry requires a notification-policy-aware worker'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_silent_fulfillment_retry_claim ON oms.channel_fulfillment_pushes;
CREATE TRIGGER guard_silent_fulfillment_retry_claim
  BEFORE UPDATE ON oms.channel_fulfillment_pushes
  FOR EACH ROW EXECUTE FUNCTION oms.guard_silent_fulfillment_retry_claim();
