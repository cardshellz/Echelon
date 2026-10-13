-- Preserve unsupported historical rows for explicit review. NOT VALID still
-- enforces this constraint for every new or updated payment; no balance rewrite.
ALTER TABLE procurement.ap_payments
  ADD CONSTRAINT ap_payments_recorded_status_check
  CHECK (status IN ('completed', 'voided')) NOT VALID;
