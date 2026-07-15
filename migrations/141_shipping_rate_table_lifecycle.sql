-- Shipping rate tables are prepared and reviewed before they can affect quotes.
ALTER TABLE shipping.rate_tables
  ALTER COLUMN status SET DEFAULT 'draft';

ALTER TABLE shipping.rate_tables
  DROP CONSTRAINT IF EXISTS shipping_rate_table_status_chk;

ALTER TABLE shipping.rate_tables
  ADD CONSTRAINT shipping_rate_table_status_chk
  CHECK (status IN ('draft', 'active', 'superseded', 'retired'));
