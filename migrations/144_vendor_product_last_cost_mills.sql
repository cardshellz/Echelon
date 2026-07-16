ALTER TABLE procurement.vendor_products
  ADD COLUMN IF NOT EXISTS last_cost_mills bigint;

UPDATE procurement.vendor_products
SET last_cost_mills = last_cost_cents * 100
WHERE last_cost_mills IS NULL
  AND last_cost_cents IS NOT NULL;

ALTER TABLE procurement.vendor_products
  DROP CONSTRAINT IF EXISTS vendor_products_last_cost_precision_chk;

ALTER TABLE procurement.vendor_products
  ADD CONSTRAINT vendor_products_last_cost_precision_chk
  CHECK (
    (last_cost_mills IS NULL AND last_cost_cents IS NULL)
    OR (
      last_cost_mills IS NOT NULL
      AND last_cost_mills >= 0
      AND last_cost_cents IS NOT NULL
      AND last_cost_cents >= 0
      AND last_cost_cents::numeric = floor((last_cost_mills::numeric + 50) / 100)
    )
  ) NOT VALID;

ALTER TABLE procurement.vendor_products
  VALIDATE CONSTRAINT vendor_products_last_cost_precision_chk;
