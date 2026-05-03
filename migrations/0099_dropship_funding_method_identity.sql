-- Make external funding method registration idempotent across retried provider webhooks.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_funding_provider_method_idx
  ON dropship.dropship_funding_methods(vendor_id, rail, provider_payment_method_id)
  WHERE provider_payment_method_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS dropship_funding_provider_customer_idx
  ON dropship.dropship_funding_methods(vendor_id, provider_customer_id)
  WHERE provider_customer_id IS NOT NULL;
