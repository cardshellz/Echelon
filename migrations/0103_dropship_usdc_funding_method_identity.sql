-- Make USDC Base funding method registration idempotent by vendor wallet address.
CREATE UNIQUE INDEX IF NOT EXISTS dropship_funding_usdc_wallet_idx
  ON dropship.dropship_funding_methods(vendor_id, rail, usdc_wallet_address)
  WHERE usdc_wallet_address IS NOT NULL;
