-- ShipStation application V2 webhooks support operator-defined authentication
-- headers. Echelon verifies that shared secret and records a deterministic
-- HMAC over the exact request bytes; the secret itself is never persisted.
ALTER TABLE wms.carrier_tracking_webhook_receipts
  DROP CONSTRAINT IF EXISTS carrier_tracking_webhook_receipts_algorithm_chk;

ALTER TABLE wms.carrier_tracking_webhook_receipts
  ADD CONSTRAINT carrier_tracking_webhook_receipts_algorithm_chk CHECK (
    signature_algorithm IN ('RSA-SHA256', 'HMAC-SHA256')
  );
